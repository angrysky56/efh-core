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
const { FIDELITY_POLICY_REVISION } = await import("../dist/fidelity.js");
// Synthetic measurements used only for direct store/gate fixtures.
const fixtureProvenance = {
  provider: "typesafe", requested_model: "jev-smoke-fixture", resolved_models: ["jev-smoke-fixture"],
  question_revision: "smoke-fixture", policy_revision: FIDELITY_POLICY_REVISION,
  boundary: 0.6, resample_band: 0.15, resample_samples: 5, draws: [], mixed_models: false,
};
const { z3VerifyImplication, z3FindCounterexample, z3CheckConsistency, capStrengthened } =
  await import("../dist/verifier.js");

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
check(
  "unsat core lists both premises",
  Array.isArray(mp.unsat_core) && mp.unsat_core.length === 2,
  JSON.stringify(mp.unsat_core),
);

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
check(
  "consistency core pinpoints the contradiction",
  Array.isArray(incons.unsat_core) && incons.unsat_core.length === 2,
  JSON.stringify(incons.unsat_core),
);

// --- formalization persistence -------------------------------------------------
store.saveFormalization(db, {
  claim_id: claim.id,
  axioms: ["(declare-const p Bool)", "(assert p)"],
  conjecture: "p",
  backend: "z3",
  result: "proved",
  proof_confidence: 1,
  fidelity: 1,
  fidelity_decision: "passed",
  fidelity_provenance: fixtureProvenance,
  gloss: "p holds given that p is asserted",
  strengthenings: ["f(x) := 2x (example)"],
});
const forms = store.getFormalizations(db, claim.id);
check(
  "formalization round-trip",
  forms.length === 1 &&
    Array.isArray(forms[0].axioms) &&
    forms[0].axioms.length === 2 &&
    Array.isArray(forms[0].strengthenings),
  `n=${forms.length}`,
);

// How a fidelity number was arrived at is stored with it, or the floor can
// never be calibrated against glosses from real sessions.
store.saveFormalization(db, {
  claim_id: claim.id, axioms: ["(declare-const r Bool)", "(assert r)"], conjecture: "r",
  backend: "z3", result: "proved", proof_confidence: 1, fidelity: 0.65,
  fidelity_method: "judgment", fidelity_samples: 5, fidelity_spread: [0.61, 0.69],
  fidelity_decision: "passed",
  fidelity_provenance: fixtureProvenance,
  fidelity_unsettled: false, gloss: "r holds given that r is asserted", strengthenings: null,
});
{
  const [latest] = store.getFormalizations(db, claim.id);
  check(
    "how a fidelity number was reached is stored, not just the number",
    latest.fidelity === 0.65 && latest.fidelity_samples === 5 &&
      latest.fidelity_spread_low === 0.61 && latest.fidelity_spread_high === 0.69 &&
      latest.fidelity_unsettled === 0,
    JSON.stringify(latest),
  );
}


// --- strengthening soundness cap -------------------------------------------------
check(
  "strengthened proof capped at 0.6",
  capStrengthened(1.0, ["f := 2x"]).pc === 0.6 &&
    capStrengthened(1.0, ["f := 2x"]).strengthened_proof === true,
);
check(
  "refutation unaffected by strengthening",
  capStrengthened(0.0, ["f := 2x"]).pc === 0 &&
    capStrengthened(0.0, ["f := 2x"]).strengthened_proof === undefined,
);
check("faithful proof uncapped", capStrengthened(1.0, undefined).pc === 1.0);

// --- gate ---------------------------------------------------------------------
store.recordVerification(db, claim.id, 1.0, false, "smoke: proved");
state.resetAdmm(); // sanctioned de-escalation -> KERNEL1
let outcome = store.commitClaim(db, claim.id, 0.9, state.closure_status);
check("gate commits under KERNEL1 + proof + fidelity", outcome.committed === true, outcome.reason);
// The stated confidence is recorded, not counted: a commit that would pass the
// three legs passes at any stated confidence, including zero.
{
  const twin = store.assertClaim(db, "same standing, no self-report", 0.9, "smoke");
  store.recordVerification(db, twin.id, 1.0, false, "smoke: proved");
  store.saveFormalization(db, {
    claim_id: twin.id, axioms: ["(declare-const p Bool)", "(assert p)"], conjecture: "p",
    backend: "z3", result: "proved", proof_confidence: 1, fidelity: 1,
    fidelity_decision: "passed",
    fidelity_provenance: fixtureProvenance,
    fidelity_method: "judgment", gloss: "p holds given that p is asserted", strengthenings: null,
  });
  const zero = store.commitClaim(db, twin.id, 0.0, state.closure_status);
  check("a self-reported confidence of zero does not block a verified commit", zero.committed === true, zero.reason);
  check("the gate no longer has a self-report leg", !("confidence_score_ok" in zero.gate));
}

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

// --- gate: the fidelity leg ------------------------------------------------------
// A proof establishes that the conjecture follows from the axioms. It says nothing
// about whether those formulas mean what the claim means, so fidelity is a gate
// condition rather than a warning.
const drifted = store.assertClaim(db, "a claim whose encoding drifted", 0.9, "smoke");
store.recordVerification(db, drifted.id, 1.0, false, "smoke: proved");
store.saveFormalization(db, {
  claim_id: drifted.id,
  axioms: ["(declare-const q Bool)", "(assert q)"],
  conjecture: "q",
  backend: "z3",
  result: "proved",
  proof_confidence: 1,
  fidelity: 0.21,
  fidelity_decision: "failed",
  fidelity_provenance: fixtureProvenance,
  fidelity_method: "judgment",
  gloss: "an unrelated statement about kiln temperature",
  strengthenings: null,
});
const drift = store.commitClaim(db, drifted.id, 0.95, state.closure_status);
check(
  "gate refuses a proved claim whose formalization is unfaithful",
  drift.committed === false && drift.gate.fidelity === 0.21 && drift.gate.fidelity_decision === "failed",
  drift.reason,
);

const unglossed = store.assertClaim(db, "a claim verified without a gloss", 0.9, "smoke");
store.recordVerification(db, unglossed.id, 1.0, false, "smoke: proved");
const unmeasured = store.commitClaim(db, unglossed.id, 0.95, state.closure_status);
check(
  "an unmeasured fidelity never counts as a passed check",
  unmeasured.committed === false && unmeasured.reason.includes("unmeasured"),
  unmeasured.reason,
);
check(
  "gate reports the fidelity leg it applied",
  unmeasured.gate.fidelity_gate === "on" && unmeasured.gate.fidelity === null,
);

// The escape hatch exists, but the outcome always says it was used.
{
  const { execFileSync } = await import("node:child_process");
  const script = `
    process.env.EFH_DB_PATH = ${JSON.stringify(DB)};
    const { openDb } = await import("${join(process.cwd(), "dist/db.js")}");
    const store = await import("${join(process.cwd(), "dist/store.js")}");
    const db = openDb(${JSON.stringify(DB)});
    const out = store.commitClaim(db, ${unglossed.id}, 0.95, "KERNEL1");
    console.log(JSON.stringify({ committed: out.committed, gate: out.gate.fidelity_gate }));
  `;
  const raw = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, EFH_GATE_FIDELITY: "off" },
    encoding: "utf8",
  });
  const off = JSON.parse(raw.trim().split("\n").pop());
  check(
    "EFH_GATE_FIDELITY=off commits, and the outcome says the leg was off",
    off.committed === true && off.gate === "off",
    raw,
  );
}

// --- judgment channel -------------------------------------------------------------
{
  const { Judge, JudgeUnavailableError } = await import("../dist/judge.js");
  process.env.EFH_JUDGE = "jev";
  process.env.EFH_JUDGE_PROVIDER = "typesafe";
  process.env.TYPESAFE_API_KEY = "test-secret";

  const reply = (relation, confidence, noul) =>
    async () =>
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            relation: { type: "choice", choice: relation, confidence },
            same_truth_conditions: { type: "noul", noul },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

  const contradiction = new Judge(reply("contradicts", 0.98, 0.03));
  check(
    "a contradiction reads as near-total disagreement, not near-agreement",
    (await contradiction.distance("the gate is open", "the gate is closed")) > 0.9,
  );
  const equivalent = new Judge(reply("equivalent", 1.0, 0.97));
  check(
    "a contrapositive reads as agreement",
    (await equivalent.distance("if open then green", "if not green then not open")) < 0.1,
  );

  // Two independent views of one pair: where they disagree, the pair is hard.
  const split = new Judge(reply("equivalent", 0.86, 0.53));
  const judgment = await split.equivalence(
    "if a token is expired the request is rejected",
    "if a token is not expired the request is not rejected",
  );
  check("disagreement between the two questions is reported", judgment.split === true);
  check("agreement between the two questions is not flagged", (await equivalent.equivalence("a", "b")).split === false);

  // Near the decision boundary a single draw is not enough: measured on a real
  // gloss pair, the same comparison scored 0.61 / 0.69 / 0.65 against a 0.6 floor.
  const sequence = (values, relation = "equivalent") => {
    let i = 0;
    return async () => {
      const noul = values[Math.min(i++, values.length - 1)];
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            relation: { type: "choice", choice: relation, confidence: 0.9 },
            same_truth_conditions: { type: "noul", noul },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
  };

  const decisive = new Judge(sequence([0.97]));
  const clear = await decisive.equivalence("decisive a", "decisive b");
  check("a decisive score is not re-sampled", clear.samples === 1 && clear.unsettled === false);

  const noisy = new Judge(sequence([0.65, 0.61, 0.69, 0.66, 0.64]));
  const settled = await noisy.equivalence("noisy a", "noisy b");
  check(
    "a near-boundary score is re-sampled and the median decides",
    settled.samples === 5 && settled.same_truth_conditions === 0.65 && settled.unsettled === false,
    JSON.stringify(settled),
  );
  check("the spread is reported, so a tight result reads differently from a lucky one",
    settled.spread[0] === 0.61 && settled.spread[1] === 0.69);

  const straddling = new Judge(sequence([0.62, 0.58, 0.64, 0.55, 0.61]));
  const undecided = await straddling.equivalence("straddle a", "straddle b");
  check(
    "samples on both sides of the floor are unsettled, and the lowest is used",
    undecided.unsettled === true && undecided.same_truth_conditions === 0.55,
    JSON.stringify(undecided),
  );
  check(
    "an unsettled pair therefore fails the floor rather than passing on a median",
    undecided.same_truth_conditions < 0.6,
  );

  // Fail-loud, and never echo the key back.
  const denied = new Judge(async () => new Response("bad key test-secret", { status: 401 }));
  let threw = null;
  try {
    await denied.equivalence("a", "b");
  } catch (err) {
    threw = err;
  }
  check(
    "an unreachable judge throws instead of scoring",
    threw instanceof JudgeUnavailableError && threw.message.includes("HTTP 401"),
  );
  check("the provider key is never echoed in an error", threw !== null && !threw.message.includes("test-secret"));

  delete process.env.TYPESAFE_API_KEY;
  let keyless = null;
  try {
    await new Judge(reply("equivalent", 1, 1)).equivalence("x", "y");
  } catch (err) {
    keyless = err;
  }
  check("a missing key is refused, not silently skipped", keyless instanceof JudgeUnavailableError);
  delete process.env.EFH_JUDGE;
}

// --- what the monitor can see -----------------------------------------------------
// The alarm is only as sharp as the comparator behind it. Measured against this
// repo's own embedding model, "the claim is verified" and "the claim is not
// verified" sit 0.0962 apart — closer than a paraphrase pair. See
// experiments/fidelity-probe/README.md.
{
  const { coboundaryNorm } = await import("../dist/enforcer/admm.js");
  const a = { belief: { kind: "text", s: "the claim is verified", weight: 1 } };
  const b = { belief: { kind: "text", s: "the claim is not verified", weight: 1 } };
  const topical = await coboundaryNorm(a, b, { distance: async () => 0.0962 });
  const judged = await coboundaryNorm(a, b, { distance: async () => 0.97 });
  check(
    "a contradiction raises the alarm under judgment and not under topicality",
    topical < 0.2 && judged > 0.9,
    `topical ${topical}, judged ${judged}`,
  );
}

// --- the stated confidence is measurable, not ornamental -------------------------
{
  // A second estimator on a comparable claim: calibration is grouped, so a better
  // estimator has to show itself on real claims rather than be asserted.
  const probed = store.assertClaim(db, "a claim committed with a probe estimate", 0.9, "smoke");
  store.recordVerification(db, probed.id, 1.0, false, "smoke: proved");
  store.saveFormalization(db, {
    claim_id: probed.id, axioms: ["(declare-const p Bool)", "(assert p)"], conjecture: "p",
    backend: "z3", result: "proved", proof_confidence: 1, fidelity: 0.95,
    fidelity_decision: "passed",
    fidelity_provenance: fixtureProvenance,
    fidelity_method: "judgment", gloss: "p holds given that p is asserted", strengthenings: null,
  });
  state.resetAdmm(); // sanctioned de-escalation -> KERNEL1
  const probeCommit = store.commitClaim(db, probed.id, 0.62, state.closure_status, undefined, "probe");
  check("a probe-sourced commit passes the same three legs", probeCommit.committed === true, probeCommit.reason);

  const cal = store.reportedConfidenceCalibration(db);
  check(
    "calibration separates estimators instead of pooling them",
    cal.by_source.probe?.commits === 1 && cal.by_source.verbalized?.commits >= 2,
    JSON.stringify(cal.by_source),
  );
  check(
    "stated confidence is recorded against what happened to the claim",
    cal.commits >= 2 && typeof cal.mean_reported === "number" && cal.later_refuted >= 0,
    JSON.stringify(cal),
  );
  check("a small sample says so instead of implying a trend", cal.note.includes("too few"));
}

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
