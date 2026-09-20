/**
 * Incumbent baseline: efh-core's production fidelity measure, unchanged.
 *
 * Prefers the repo's own Embedder (dist/embeddings.js). That pulls in
 * better-sqlite3, a native module built for one Node ABI, so when the script
 * runs under a different Node than the one that installed it, this falls back
 * to an inline mirror of Embedder.distance: same model, same /api/embed call,
 * same clamped 1 - cosine. The database there is only a cache, so the measured
 * number is identical; the fallback is recorded in the output, never silent.
 *
 * Run from the repo root:  node experiments/fidelity-probe/embed-baseline.mjs
 * Set OLLAMA_HOST if Ollama is not on this machine's localhost.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { pairs, threshold } = JSON.parse(readFileSync(join(here, "pairs.json"), "utf8"));
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const EMBED_MODEL = process.env.EFH_EMBED_MODEL ?? "nomic-embed-text";

/** Mirrors src/embeddings.ts: Embedder.embed + Embedder.distance, minus the cache. */
function inlineEmbedder() {
  const mem = new Map();
  const embed = async (text) => {
    if (mem.has(text)) return mem.get(text);
    const res = await fetch(`${OLLAMA_HOST}/api/embed`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: [text] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
    const data = await res.json();
    if (!data.embeddings?.[0]?.length) throw new Error("Ollama returned an empty embedding");
    const vec = Float32Array.from(data.embeddings[0]);
    mem.set(text, vec);
    return vec;
  };
  return {
    probe: async () => {
      try {
        const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(1500) });
        return { reachable: res.ok, host: OLLAMA_HOST, model: EMBED_MODEL };
      } catch { return { reachable: false, host: OLLAMA_HOST, model: EMBED_MODEL }; }
    },
    distance: async (a, b) => {
      if (a === b) return 0;
      const [va, vb] = await Promise.all([embed(a), embed(b)]);
      let dot = 0, na = 0, nb = 0;
      const n = Math.min(va.length, vb.length);
      for (let i = 0; i < n; i++) { dot += va[i] * vb[i]; na += va[i] * va[i]; nb += vb[i] * vb[i]; }
      if (na === 0 || nb === 0) return 1;
      return Math.min(1, Math.max(0, 1 - dot / (Math.sqrt(na) * Math.sqrt(nb))));
    },
  };
}

let embedder, path$ = "dist/embeddings.js (production Embedder)";
try {
  const [{ openDb }, { Embedder }] = await Promise.all([
    import("../../dist/db.js"), import("../../dist/embeddings.js"),
  ]);
  embedder = new Embedder(openDb(join(tmpdir(), "efh-fidelity-probe.sqlite")));
} catch (err) {
  embedder = inlineEmbedder();
  path$ = `inline mirror of Embedder.distance (production module unavailable here: ${err.code ?? err.message})`;
  console.warn(`NOTE: ${path$}`);
}

const probe = await embedder.probe();
if (!probe.reachable) {
  console.error(`Ollama unreachable at ${probe.host}; start it or set OLLAMA_HOST.`);
  process.exit(1);
}

const results = [];
for (const p of pairs) {
  const d = await embedder.distance(p.claim, p.gloss);
  const fidelity = Math.round((1 - d) * 10000) / 10000;
  results.push({ id: p.id, category: p.category, faithful: p.faithful, fidelity, accepted: fidelity >= threshold });
}
writeFileSync(join(here, "embedding-results.json"), JSON.stringify({ model: probe.model, host: probe.host, measuredVia: path$, threshold, results }, null, 2) + "\n");

const falseAccept = results.filter(r => !r.faithful && r.accepted);
const falseReject = results.filter(r => r.faithful && !r.accepted);
console.table(results);
console.log(`model ${probe.model}, threshold ${threshold}`);
console.log(`unfaithful glosses accepted: ${falseAccept.length}/${results.filter(r => !r.faithful).length} (${falseAccept.map(r => r.id).join(", ") || "none"})`);
console.log(`faithful glosses rejected:  ${falseReject.length}/${results.filter(r => r.faithful).length} (${falseReject.map(r => r.id).join(", ") || "none"})`);
console.log("wrote experiments/fidelity-probe/embedding-results.json");

// Head-to-head against the Jev run, at the same operating point.
const jev = JSON.parse(readFileSync(join(here, "jev-results.json"), "utf8"));
const byId = Object.fromEntries(jev.results.map(r => [r.id, r]));
const head = results.map(r => {
  const j = byId[r.id];
  const jevAccepted = j.same_truth_conditions >= threshold;
  return {
    id: r.id, category: r.category, faithful: r.faithful,
    embedding: r.fidelity, embedding_ok: r.accepted === r.faithful,
    jev: j.same_truth_conditions, jev_ok: jevAccepted === r.faithful,
    jev_relation: j.relation,
  };
});
console.table(head);
const rate = k => `${head.filter(h => h[k]).length}/${head.length}`;
console.log(`correct at threshold ${threshold} — embedding: ${rate("embedding_ok")}, jev: ${rate("jev_ok")}`);
const dangerous = head.filter(h => !h.faithful && h.embedding >= threshold);
console.log(`unfaithful glosses the embedding gate would accept: ${dangerous.map(h => `${h.id}(${h.category}, ${h.embedding})`).join(", ") || "none"}`);
writeFileSync(join(here, "comparison.json"), JSON.stringify({ threshold, embedder: probe.model, jevModel: jev.resolvedModel, measuredVia: path$, head }, null, 2) + "\n");
