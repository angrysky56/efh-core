/**
 * Ollama embedding client with SQLite cache.
 *
 * Fail-loud policy: if the semantic channel is enabled (EFH_SEMANTIC=on)
 * and Ollama is unreachable, calls throw with a clear remedy. A comparison
 * that did not run never counts as a comparison that passed.
 */

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const EMBED_MODEL = process.env.EFH_EMBED_MODEL ?? "nomic-embed-text";

export class EmbeddingUnavailableError extends Error {
  constructor(cause: string) {
    super(
      `Semantic channel enabled but embeddings unavailable: ${cause}. ` +
        `Remedies: start Ollama at ${OLLAMA_HOST} with model '${EMBED_MODEL}' pulled ` +
        `(ollama pull ${EMBED_MODEL}), set EFH_EMBED_MODEL to an installed model, ` +
        `or set EFH_SEMANTIC=off to fall back to hash comparison (fallback is reported, never silent).`,
    );
    this.name = "EmbeddingUnavailableError";
  }
}

export function semanticEnabled(): boolean {
  return (process.env.EFH_SEMANTIC ?? "on").toLowerCase() !== "off";
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

export class Embedder {
  private mem = new Map<string, Float32Array>();

  constructor(private db: Database.Database) {}

  /** Quick reachability probe for session_status (never throws). */
  async probe(): Promise<{ reachable: boolean; host: string; model: string }> {
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
        signal: AbortSignal.timeout(1500),
      });
      return { reachable: res.ok, host: OLLAMA_HOST, model: EMBED_MODEL };
    } catch {
      return { reachable: false, host: OLLAMA_HOST, model: EMBED_MODEL };
    }
  }

  /** Embed text, using memory cache → SQLite cache → Ollama, in that order. */
  async embed(text: string): Promise<Float32Array> {
    const h = sha256(text);
    const memHit = this.mem.get(h);
    if (memHit) return memHit;

    const row = this.db
      .prepare("SELECT dim, vec FROM embeddings WHERE hash = ? AND model = ?")
      .get(h, EMBED_MODEL) as { dim: number; vec: Buffer } | undefined;
    if (row) {
      const vec = new Float32Array(row.vec.buffer, row.vec.byteOffset, row.dim);
      const copy = new Float32Array(vec); // detach from Buffer pool
      this.mem.set(h, copy);
      return copy;
    }

    let vec: Float32Array;
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, input: [text] }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        throw new EmbeddingUnavailableError(
          `Ollama returned HTTP ${res.status} (${await res.text().catch(() => "")})`,
        );
      }
      const data = (await res.json()) as { embeddings?: number[][] };
      if (!data.embeddings?.[0]?.length) {
        throw new EmbeddingUnavailableError("Ollama returned an empty embedding");
      }
      vec = Float32Array.from(data.embeddings[0]);
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) throw err;
      throw new EmbeddingUnavailableError(String(err));
    }

    this.db
      .prepare("INSERT OR REPLACE INTO embeddings (hash, model, dim, vec) VALUES (?, ?, ?, ?)")
      .run(h, EMBED_MODEL, vec.length, Buffer.from(vec.buffer));
    this.mem.set(h, vec);
    return vec;
  }

  /** Cosine distance in [0, 1]: 0 = identical direction, 1 = orthogonal-or-worse (clamped). */
  async distance(a: string, b: string): Promise<number> {
    if (a === b) return 0; // deterministic shortcut, no model call
    const [va, vb] = await Promise.all([this.embed(a), this.embed(b)]);
    let dot = 0;
    let na = 0;
    let nb = 0;
    const n = Math.min(va.length, vb.length);
    for (let i = 0; i < n; i++) {
      dot += va[i] * vb[i];
      na += va[i] * va[i];
      nb += vb[i] * vb[i];
    }
    if (na === 0 || nb === 0) return 1;
    const cos = dot / (Math.sqrt(na) * Math.sqrt(nb));
    return Math.min(1, Math.max(0, 1 - cos));
  }
}
