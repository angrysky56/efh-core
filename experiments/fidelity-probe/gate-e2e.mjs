/**
 * End-to-end check of the fidelity leg through the real MCP surface.
 *
 * Uses one English claim and one caller gloss with two different formal problems.
 * Both proofs succeed; the server rendering must expose the changed implication.
 * Local reviews here are explicitly synthetic attestations of fixture meanings,
 * not independent validation. Also verifies that a changed caller note is inert.
 *
 * Needs a judgment key in this shell (EFH_JUDGE=jev plus TYPESAFE_API_KEY or
 * OPENROUTER_API_KEY). Writes to a scratch database, never the real ledger.
 *
 * Run from the repo root:
 *   npm run build && EFH_JUDGE=jev \
 *     node experiments/fidelity-probe/gate-e2e.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {reviewPacket, recordTranslationReview} from "../../dist/translation-review.js";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
// Always override inherited/.env database settings. This experiment owns only
// this unique directory, and cleans it on both successful and failed runs.
const scratch = await mkdtemp(join(tmpdir(), "efh-gate-e2e-"));
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
  EFH_DB_PATH: join(scratch, "gate.sqlite"),
};
const client = new Client({ name: "gate-e2e", version: "1" });
let failures = 0;
try {
  console.log("scratch database:", env.EFH_DB_PATH);
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [join(root, "dist/index.js")], env, stderr: "inherit" }),
  );
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(r.content?.[0]?.text ?? "tool error");
    return JSON.parse(r.content[0].text);
  };

  const status = await call("session_status", {});
  console.log("gate legs:", status.gate_legs.join(" ∧ "));
  console.log("judge:", JSON.stringify(status.backends.judge));

  console.log("Reviews are synthetic scratch-fixture attestations, not independent validation.");
  const claimText = "If a claim is committed and commitment requires a successful proof, then that claim has a successful proof.";
  const glossary = {committed: "the claim is committed", proved: "the claim has a successful proof"};
  const declarations = ["(declare-const proved Bool)", "(declare-const committed Bool)"];
  const cases = [
    ["faithful", ["(assert committed)", "(assert (=> committed proved))"], "proved", claimText, true],
    ["copied-gloss-wrong-formulas", ["(assert proved)", "(assert (=> proved committed))"], "committed", claimText, false],
    ["changed-note-same-formulas", ["(assert committed)", "(assert (=> committed proved))"], "proved", "Unrelated caller note about pottery.", true],
  ];

  for (const [label, premises, conjecture, gloss, expected] of cases) {
    const { claim } = await call("assert_claim", { text: claimText, belief: 0.9, source: `gate-e2e:${label}` });
    const axioms = [...declarations, ...premises];
    const v = await call("verify_implication", { axioms, conjecture, claim_id: claim.id, gloss, symbol_glossary: glossary });
    const [formalization] = await call("get_formalizations", {claim_id: claim.id});
    const beforeReview = await call("commit_claim", {claim_id: claim.id, reported_confidence: 0.95});
    if (beforeReview.committed || beforeReview.gate.translation_ok) failures += 1;
    const db = new Database(env.EFH_DB_PATH, {fileMustExist:true});
    try {
      const packet = reviewPacket(db, formalization.id);
      recordTranslationReview(db, {...packet.review_template,
        decision: "approved", reviewer: "synthetic-e2e-fixture",
        claim_scope: "Test fixture: assess fidelity separately; this is not independent validation of the claim.",
        symbols: packet.review_template.symbols.map(s => ({...s, grounding: "Meaning defined in this test fixture."})),
        premises: packet.review_template.premises.map(p => ({...p, justification: "Explicit assumption of the test conditional."})),
      });
    } finally { db.close(); }
    await call("run_admm_cycle", {});
    const commit = await call("commit_claim", {
      claim_id: claim.id,
      reported_confidence: 0.95,
      confidence_source: "verbalized",
    });
    if (commit.committed !== expected) failures += 1;
    console.log(
      `${commit.committed === expected ? "PASS" : "FAIL"} ${label}: proof=${v.result} ` +
        `fidelity=${v.fidelity} (${v.fidelity_method}, ${v.fidelity_relation ?? "n/a"}, decision=${v.fidelity_decision}, ` +
        `${v.fidelity_samples ?? 1} sample${v.fidelity_samples > 1 ? "s" : ""}` +
        `${v.fidelity_spread ? ` spread ${v.fidelity_spread[0]}–${v.fidelity_spread[1]}` : ""}` +
        `${v.fidelity_unsettled ? ", UNSETTLED" : ""}) committed=${commit.committed}`,
    );
    if (!commit.committed) console.log(`     ${commit.reason}`);
  }
  console.log(failures === 0 ? "\nformula changes affect fidelity; caller notes do not; review is required" : `\n${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  try { await client.close(); }
  finally { await rm(scratch, { recursive: true, force: true }); }
}
