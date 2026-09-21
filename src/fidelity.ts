/** Shared fidelity decision semantics; raw scores must never be rounded before this check. */
import type { FidelityDecision } from "./types.js";

export const FIDELITY_POLICY_REVISION = "fidelity-v3-parsed-formulas";
export const GLOSS_TRUST_NOTE =
  "Fidelity compares the claim with a server rendering of the parsed formulas. Symbol meanings and premise justifications require a separate recorded review. Proof remains conditional on those premises; review is an attestation, not proof of their real-world truth.";

export function fidelityDecision(score: number | null, boundary: number, unsettled = false): FidelityDecision {
  if (score === null || !Number.isFinite(score) || score < 0 || score > 1) return "unmeasured";
  if (unsettled) return "unsettled";
  return score >= boundary ? "passed" : "failed";
}
