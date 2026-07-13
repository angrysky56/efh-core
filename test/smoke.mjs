/**
 * Smoke test — exercises store, enforcer, verifier, and gate directly
 * against the built dist/ modules. No MCP transport, no Ollama required
 * (EFH_SEMANTIC=off; the identical-string shortcut is still exercised).
 *
 * Run: npm run build && npm run smoke
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB = join(tmpdir(), "efh-smoke.db");
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    rmSync(DB + suffix);
  } catch {}
}
process.env.EFH_DB_PATH = DB;
process.env.EFH_SEMANTIC = "off";

const { openDb } = await import("../dist/db.js");
const { loadState, saveState } = await import("../dist/enforcer/state.js");
const { runFullCycle, stringToFloat } = await import("../dist/enforcer/admm.js");
const { Embedder } = await import("../dist/embeddings.js");
const store = await import("../dist/store.js");
const { z3VerifyImplication, z3FindCounterexample, z3CheckConsistency } = await import(
  "../dist/verifier.js"
);

let failures = 0;
function check(name, cond, detail = "") {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// --- store -----------------------------------------------------------------
const db = openDb(DB);
const state = loadState(db);
const embedder = new Embedder(db);

const claim = store.assertClaim(db, "Z exhibits strong lumpability", 0.72, "smoke-test");
check("assert_claim returns id", claim.id === 1, `id=${claim.id}`);
check("claim status asserted", claim.status === "asserted");

const c2 = store.assertClaim(db, "Macro epsilon-machine is coherent", 0.8);
store.linkClaims(db, c2.id, claim.id, "derived_from");
check("link_claims", store.getLinks(db, claim.id).length === 1);

// --- enforcer: consistent session -------------------------------------------
const hypothesis = "Z exhibits strong lumpability";
state.agent_states["world-model"] = {
  last_assertion: hypothesis,
  belief_score: 0.9,
  inconsistency_flag: false,
};
state.agent_states["verifier"] = {
  last_proof_result: hypothesis,
  proof_confidence: 0.88,
  contradictions_found: false,
};
state.agent_states["reasoner"] = {
  current_hypothesis: hypothesis,
  confidence_score: 0.9,
  halt_flag: false,
};

let report = await runFullCycle(state, embedder);
report = await runFullCycle(state, embedder);
check(
  "consistent states -> KERNEL1",
  report.closure_status === "KERNEL1",
  `status=${report.closure_status}, mean_cb=${report.mean_coboundary_norm}`,
);
check("edges evaluated", report.edges_evaluated === 6, `n=${report.edges_evaluated}`);
check(
  "identical strings -> low coboundary",
  report.mean_coboundary_norm < 0.05,
  `mean_cb=${report.mean_coboundary_norm}`,
);

// --- enforcer: inject contradiction ------------------------------------------
state.agent_states["reasoner"] = {
  current_hypothesis: "Z is NOT lumpable under any coarse-graining",
  confidence_score: 0.2,
  halt_flag: true,
};
for (let i = 0; i < 3; i++) report = await runFullCycle(state, embedder);
check(
  "contradiction escalates status",
  report.closure_status !== "KERNEL1",
  `status=${report.closure_status}, mean_cb=${report.mean_coboundary_norm}, max_dual=${report.max_dual_variable}`,
);
check(
  "recovery recommended",
  report.recovery_recommendation.strategy !== "none",
  report.recovery_recommendation.strategy,
);

// hash determinism (cross-process stability contract)
check(
  "stringToFloat deterministic",
  stringToFloat("abc") === stringToFloat("abc") && stringToFloat("abc") !== stringToFloat("abd"),
);

// --- verifier: Z3 ------------------------------------------------------------
const mp = await z3VerifyImplication(
  ["(declare-const p Bool)", "(declare-const q Bool)", "(assert p)", "(assert (=> p q))"],
  "q",
);
check("z3 modus ponens proved", mp.result === "proved", `${mp.result}: ${mp.detail}`);

const cex = await z3FindCounterexample(
  ["(declare-const p Bool)", "(declare-const q Bool)", "(assert (=> p q))"],
  "q",
);
check("z3 counterexample found (p unasserted)", cex.result === "sat", cex.result);
check("z3 model present", typeof cex.model === "string" && cex.model.length > 0);

const incons = await z3CheckConsistency([
  "(declare-const p Bool)",
  "(assert p)",
  "(assert (not p))",
]);
check("z3 detects inconsistency", incons.result === "unsat", incons.result);

// --- gate ---------------------------------------------------------------------
store.recordVerification(db, claim.id, 1.0, false, "smoke: proved");
state.resetAdmm(); // sanctioned de-escalation -> KERNEL1
let outcome = store.commitClaim(db, claim.id, 0.9, state.closure_status);
check("gate commits under KERNEL1 + confidence", outcome.committed === true, outcome.reason);

state.updateStatus("WEAK");
outcome = store.commitClaim(db, c2.id, 0.9, state.closure_status);
check("gate refuses under WEAK", outcome.committed === false, outcome.reason);
check(
  "refusal is informative",
  outcome.reason.includes("KERNEL1"),
  outcome.reason.slice(0, 80),
);

const trail = store.getAuditTrail(db, claim.id);
check("audit trail populated", trail.length >= 3, `${trail.length} entries`);

// --- embedder shortcut (no network) -------------------------------------------
process.env.EFH_SEMANTIC = "on";
const d = await embedder.distance("same text", "same text");
check("identical-string semantic distance is 0 without model call", d === 0);

// --- persistence round-trip -----------------------------------------------------
saveState(db, state);
const state2 = loadState(db);
check(
  "state persistence round-trip",
  state2.closure_status === state.closure_status &&
    state2.admm_iterations === state.admm_iterations,
);

db.close();
console.log(failures === 0 ? "\nALL SMOKE TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1); // z3 worker threads would otherwise hold the loop open
