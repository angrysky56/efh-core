/** Shared fidelity decision semantics; raw scores must never be rounded before this check. */
import type { FidelityDecision } from "./types.js";

export const FIDELITY_POLICY_REVISION = "fidelity-v2-explicit-decision";
export const GLOSS_TRUST_NOTE =
  "Fidelity compares the supplied English gloss with the claim. The formula-to-gloss translation is caller-supplied and unverified; proof is conditional on the supplied axioms.";

export function fidelityDecision(score: number | null, boundary: number, unsettled = false): FidelityDecision {
  if (score === null || !Number.isFinite(score) || score < 0 || score > 1) return "unmeasured";
  if (unsettled) return "unsettled";
  return score >= boundary ? "passed" : "failed";
}
