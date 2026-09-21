/**
 * Claim store, audit trail, and the commit gate.
 *
 * The commit rule (structural, not advisory):
 *   commit ⇔ proof_confidence ≥ 0.7 ∧ fidelity ≥ 0.6 ∧ reviewed translation ∧ status = KERNEL1
 *
 * The gate combines proof, fidelity of the parsed rendering, translation review,
 * and the monitor state. Reviews attest symbol grounding and premise scope;
 * they do not establish real-world truth by themselves. The reasoner's stated
 * confidence is recorded in the audit trail for calibration, and is deliberately NOT a leg — a number the
 * author supplies about its own output cannot verify that output, and counting
 * it as a check inflated the gate's apparent independence.
 * Refusals are normal results (committed:false + reason + recovery
 * recommendation), and every attempt is audited either way.
 */

import type Database from "better-sqlite3";
import type { Claim, ClosureStatus, Formalization, RecoveryRecommendation, FidelityDecision, FidelityProvenance, FormulaTranslation } from "./types.js";
import { config } from "./config.js";
import { GLOSS_TRUST_NOTE, FIDELITY_POLICY_REVISION } from "./fidelity.js";

import { translationReviewStatus } from "./translation-review.js";

const MIN_CONFIDENCE = config.commitMinConfidence;
const FIDELITY_MIN = config.fidelityMin;
/** The fidelity leg can be disabled, but never quietly: the gate says so in every outcome. */
const FIDELITY_GATE = config.fidelityGate;

export function audit(
  db: Database.Database,
  actor: string,
  action: string,
  claimId: number | null,
  detail: unknown,
): void {
  db.prepare("INSERT INTO audit (actor, action, claim_id, detail) VALUES (?, ?, ?, ?)").run(
    actor,
    action,
    claimId,
    typeof detail === "string" ? detail : JSON.stringify(detail),
  );
}

export function assertClaim(
  db: Database.Database,
  text: string,
  belief: number,
  source?: string,
  tags?: string[],
): Claim {
  const info = db
    .prepare("INSERT INTO claims (text, belief, source, tags) VALUES (?, ?, ?, ?)")
    .run(text, belief, source ?? null, tags?.join(",") ?? null);
  const id = Number(info.lastInsertRowid);
  audit(db, "world-model", "assert", id, { text, belief, source });
  return getClaim(db, id)!;
}

export function getClaim(db: Database.Database, id: number): Claim | undefined {
  return db.prepare("SELECT * FROM claims WHERE id = ?").get(id) as Claim | undefined;
}

export function getClaims(
  db: Database.Database,
  opts: { status?: string; tag?: string; search?: string; limit?: number } = {},
): Claim[] {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.status) {
    conds.push("status = ?");
    params.push(opts.status);
  }
  if (opts.tag) {
    conds.push("(',' || COALESCE(tags,'') || ',') LIKE ?");
    params.push(`%,${opts.tag},%`);
  }
  if (opts.search) {
    conds.push("text LIKE ?");
    params.push(`%${opts.search}%`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const limit = Math.min(opts.limit ?? 50, 500);
  return db
    .prepare(`SELECT * FROM claims ${where} ORDER BY updated_at DESC LIMIT ${limit}`)
    .all(...params) as Claim[];
}

export function linkClaims(
  db: Database.Database,
  fromId: number,
  toId: number,
  relation: "supports" | "contradicts" | "refines" | "derived_from",
): void {
  if (!getClaim(db, fromId)) throw new Error(`Claim ${fromId} does not exist`);
  if (!getClaim(db, toId)) throw new Error(`Claim ${toId} does not exist`);
  db.prepare("INSERT INTO claim_links (from_id, to_id, relation) VALUES (?, ?, ?)").run(
    fromId,
    toId,
    relation,
  );
  audit(db, "world-model", "link", fromId, { to_id: toId, relation });
}

export function getLinks(
  db: Database.Database,
  claimId: number,
): Array<{ from_id: number; to_id: number; relation: string }> {
  return db
    .prepare("SELECT from_id, to_id, relation FROM claim_links WHERE from_id = ? OR to_id = ?")
    .all(claimId, claimId) as Array<{ from_id: number; to_id: number; relation: string }>;
}

/** Record a verification outcome against a claim (updates status + confidence). */
export function recordVerification(
  db: Database.Database,
  claimId: number,
  proofConfidence: number,
  contradiction: boolean,
  detail: string,
): Claim {
  const claim = getClaim(db, claimId);
  if (!claim) throw new Error(`Claim ${claimId} does not exist`);
  const status = contradiction ? "refuted" : proofConfidence >= MIN_CONFIDENCE ? "verified" : claim.status;
  db.prepare(
    "UPDATE claims SET proof_confidence = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(proofConfidence, status, claimId);
  audit(db, "verifier", "verify", claimId, { proofConfidence, contradiction, detail });
  return getClaim(db, claimId)!;
}

export interface CommitOutcome {
  committed: boolean;
  claim_id: number;
  reason: string;
  closure_status: ClosureStatus;
  gate: {
    proof_confidence_ok: boolean;
    kernel1_ok: boolean;
    /** False when the formalization was not measured, or measured below the floor. */
    fidelity_ok: boolean;
    min_confidence: number;
    fidelity: number | null;
    fidelity_method: string | null;
    formalization_id: number | null;
    fidelity_decision: FidelityDecision | null;
    fidelity_split: boolean | null;
    fidelity_provenance: FidelityProvenance | null;
    fidelity_policy_ok: boolean;
    translation_assurance: "parser-backed-reviewed" | "unverified";
    translation_ok: boolean;
    translation_review: ReturnType<typeof translationReviewStatus> | null;
    trust_note: string;
    fidelity_samples?: number | null;
    fidelity_spread?: [number, number] | null;
    fidelity_unsettled?: boolean | null;
    fidelity_min: number;
    /** "off" means the fidelity leg was disabled for this commit, and says so. */
    fidelity_gate: "on" | "off";
    fidelity_caveat?: string;
  };
  recovery_recommendation?: RecoveryRecommendation;
}

/**
 * THE GATE. All four conditions must hold; anything else is a refusal.
 * A refusal is not an error — it is the consistency check working.
 * The reasoner's stated confidence is recorded, not counted.
 */
export function commitClaim(
  db: Database.Database,
  claimId: number,
  /** Recorded for calibration; never a gate condition. */
  reportedConfidence: number,
  closureStatus: ClosureStatus,
  recovery?: RecoveryRecommendation,
  /** Which estimator produced reportedConfidence, so estimators can be compared. */
  confidenceSource: string = "verbalized",
): CommitOutcome {
  // Hold one write transaction across evidence/review checks and the audit +
  // status update, so a concurrent local review cannot invalidate an approval
  // between checking it and committing the claim.
  return db.transaction((): CommitOutcome => {
    const claim = getClaim(db, claimId);
    if (!claim) throw new Error(`Claim ${claimId} does not exist`);

    const pc = claim.proof_confidence ?? 0;
    // The formalization that carried the proof. A proof establishes that the
    // conjecture follows from the axioms; it says nothing about whether those
    // formulas mean what the claim means. Fidelity compares the parsed rendering;
    // review separately grounds the symbol meanings and premise scope.
    const formalization = db
      .prepare("SELECT * FROM formalizations WHERE claim_id = ? ORDER BY id DESC LIMIT 1")
      .get(claimId) as Formalization | undefined;
    const fidelity = formalization?.fidelity ?? null;
    const fidelityMethod = formalization?.fidelity_method ?? null;
    const provenance = formalization?.fidelity_provenance
      ? JSON.parse(formalization.fidelity_provenance) as FidelityProvenance : null;
    // A decision at a different floor may have samples on both sides of today's
    // floor. Do not reinterpret a stored median as a fresh settled measurement.
    const policyOk = provenance?.policy_revision === FIDELITY_POLICY_REVISION && provenance.boundary === FIDELITY_MIN;
    const review = formalization ? translationReviewStatus(db, formalization.id) : null;
    const gate = {
      proof_confidence_ok: pc >= MIN_CONFIDENCE && (formalization?.proof_confidence ?? 0) >= MIN_CONFIDENCE &&
        ["proved", "unsat"].includes(formalization?.result ?? ""),
      translation_ok: review?.ok === true,
      translation_review: review,
      kernel1_ok: closureStatus === "KERNEL1",
      // An unmeasured comparison never counts as a passed comparison.
      fidelity_ok: !FIDELITY_GATE || (
        fidelity !== null && Number.isFinite(fidelity) && fidelity >= FIDELITY_MIN && fidelity <= 1 &&
        policyOk && formalization?.fidelity_decision === "passed" &&
        formalization.fidelity_unsettled !== 1 && formalization.fidelity_split !== 1
      ),
      min_confidence: MIN_CONFIDENCE,
      fidelity,
      fidelity_method: fidelityMethod,
      formalization_id: formalization?.id ?? null,
      fidelity_decision: formalization?.fidelity_decision ?? null,
      fidelity_samples: formalization?.fidelity_samples ?? null,
      fidelity_spread: formalization?.fidelity_spread_low != null && formalization.fidelity_spread_high != null
        ? [formalization.fidelity_spread_low, formalization.fidelity_spread_high] as [number, number] : null,
      fidelity_unsettled: formalization?.fidelity_unsettled == null ? null : formalization.fidelity_unsettled === 1,
      fidelity_split: formalization?.fidelity_split == null ? null : formalization.fidelity_split === 1,
      fidelity_provenance: provenance,
      fidelity_policy_ok: policyOk,
      translation_assurance: review?.ok ? "parser-backed-reviewed" as const : "unverified" as const,
      trust_note: GLOSS_TRUST_NOTE,
      fidelity_min: FIDELITY_MIN,
      fidelity_gate: FIDELITY_GATE ? ("on" as const) : ("off" as const),
      ...(fidelityMethod === "embedding"
        ? {
            fidelity_caveat:
              "measured by embedding similarity, which reads topical overlap and cannot see negation or quantifier scope — set EFH_JUDGE=jev for a typed judgment",
          }
        : {}),
    };

    if (claim.status === "refuted") {
      audit(db, "gate", "commit_refused", claimId, { reason: "claim is refuted", reportedConfidence, confidenceSource, gate });
      return {
        committed: false,
        claim_id: claimId,
        reason: "Claim has been refuted by the verifier — cannot commit.",
        closure_status: closureStatus,
        gate,
      };
    }

    if (gate.proof_confidence_ok && gate.kernel1_ok && gate.fidelity_ok && gate.translation_ok) {
      db.prepare(
        "UPDATE claims SET status = 'committed', updated_at = datetime('now') WHERE id = ?",
      ).run(claimId);
      audit(db, "gate", "commit", claimId, { reportedConfidence, confidenceSource, closureStatus, gate });
      return {
        committed: true,
        claim_id: claimId,
        reason: "All gate conditions satisfied.",
        closure_status: closureStatus,
        gate,
      };
    }

    const failures: string[] = [];
    if (!gate.proof_confidence_ok) {
      failures.push(`the claim and its latest formalization need a successful proof at confidence >= ${MIN_CONFIDENCE} (claim: ${pc}, formalization: ${formalization?.proof_confidence ?? "missing"})`);
    }
    if (!gate.kernel1_ok) {
      failures.push(`closure_status is ${closureStatus}, not KERNEL1`);
    }
    if (!gate.translation_ok) failures.push(review?.reason ?? "translation unverified: reverify with supported formulas and obtain an independent review");
    if (!gate.fidelity_ok) {
      failures.push(
        fidelity === null
          ? "formalization fidelity unmeasured (verify with a supported formula rendering); an unmeasured check never counts as a passed check"
          : formalization?.fidelity_decision === "unsettled" || formalization?.fidelity_unsettled === 1 || formalization?.fidelity_split === 1
            ? "fidelity judgment is unsettled (conflicting samples, answers, or model builds); reverify or reformalize"
            : !formalization?.fidelity_decision
              ? "historical fidelity has no recorded decision; reverify with a supported formula rendering under the current policy"
              : !policyOk
                ? "fidelity evidence uses a different or missing policy/floor; reverify with a supported formula rendering under the current configuration"
                : `fidelity ${fidelity} does not pass the ${FIDELITY_MIN} floor and recorded decision (${formalization.fidelity_decision}); reformalize`,
      );
    }
    audit(db, "gate", "commit_refused", claimId, { failures, reportedConfidence, confidenceSource, gate });
    return {
      committed: false,
      claim_id: claimId,
      reason: `Commit refused: ${failures.join("; ")}. This is the consistency check working, not an error.`,
      closure_status: closureStatus,
      gate,
      recovery_recommendation: recovery,
    };
  }).immediate();
}

/** Persist the formal encoding behind a verification — the reviewable artifact. */
export function saveFormalization(
  db: Database.Database,
  f: {
    claim_id: number;
    axioms: string[];
    conjecture: string;
    backend: string;
    result: string;
    proof_confidence: number | null;
    fidelity: number | null;
    fidelity_method: string | null;
    fidelity_samples?: number | null;
    fidelity_spread?: [number, number] | null;
    fidelity_unsettled?: boolean | null;
    fidelity_split?: boolean | null;
    fidelity_decision?: FidelityDecision | null;
    fidelity_provenance?: FidelityProvenance | null;
    translation?: FormulaTranslation | null;
    gloss: string | null;
    strengthenings: string[] | null;
  },
): void {
  db.prepare(
    "INSERT INTO formalizations (claim_id, axioms, conjecture, backend, result, proof_confidence, fidelity, fidelity_method, fidelity_samples, fidelity_spread_low, fidelity_spread_high, fidelity_unsettled, fidelity_split, fidelity_decision, fidelity_provenance, gloss, strengthenings, translation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    f.claim_id,
    JSON.stringify(f.axioms),
    f.conjecture,
    f.backend,
    f.result,
    f.proof_confidence,
    f.fidelity,
    f.fidelity_method,
    f.fidelity_samples ?? null,
    f.fidelity_spread?.[0] ?? null,
    f.fidelity_spread?.[1] ?? null,
    f.fidelity_unsettled === undefined || f.fidelity_unsettled === null ? null : f.fidelity_unsettled ? 1 : 0,
    f.fidelity_split == null ? null : f.fidelity_split ? 1 : 0,
    f.fidelity_decision ?? null,
    f.fidelity_provenance ? JSON.stringify(f.fidelity_provenance) : null,
    f.gloss,
    f.strengthenings ? JSON.stringify(f.strengthenings) : null,
    f.translation ? JSON.stringify(f.translation) : null,
  );
}

export function getFormalizations(
  db: Database.Database,
  claimId: number,
): Array<
  Omit<Formalization, "axioms" | "strengthenings" | "fidelity_provenance" | "translation"> & {
    axioms: string[];
    translation: FormulaTranslation | null;
    translation_review: ReturnType<typeof translationReviewStatus>;
    strengthenings: string[] | null;
    fidelity_provenance: FidelityProvenance | null;
  }
> {
  const rows = db
    .prepare("SELECT * FROM formalizations WHERE claim_id = ? ORDER BY id DESC")
    .all(claimId) as Formalization[];
  return rows.map((r) => ({
    ...r,
    translation: r.translation ? JSON.parse(r.translation) as FormulaTranslation : null,
    translation_review: translationReviewStatus(db, r.id),
    axioms: JSON.parse(r.axioms) as string[],
    strengthenings: r.strengthenings ? (JSON.parse(r.strengthenings) as string[]) : null,
    fidelity_provenance: r.fidelity_provenance ? JSON.parse(r.fidelity_provenance) as FidelityProvenance : null,
  }));
}

export function getAuditTrail(
  db: Database.Database,
  claimId?: number,
  limit = 100,
): Array<Record<string, unknown>> {
  const capped = Math.min(limit, 1000);
  if (claimId !== undefined) {
    return db
      .prepare("SELECT * FROM audit WHERE claim_id = ? ORDER BY id DESC LIMIT ?")
      .all(claimId, capped) as Array<Record<string, unknown>>;
  }
  return db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(capped) as Array<
    Record<string, unknown>
  >;
}

/**
 * Calibration of the reasoner's stated confidence against what happened next.
 *
 * The stated number is not a gate condition, so this is its only job: it makes
 * self-reports checkable instead of decorative. A claim that was committed at
 * high stated confidence and later refuted is exactly the case worth counting.
 * With few commits the numbers mean nothing, and this says so rather than
 * implying a trend.
 */
export function reportedConfidenceCalibration(
  db: Database.Database,
  minSample = 30,
): {
  commits: number;
  mean_reported: number | null;
  later_refuted: number;
  by_source: Record<string, { commits: number; mean_reported: number; later_refuted: number }>;
  calibration_available: false;
  note: string;
} {
  const rows = db
    .prepare("SELECT claim_id, detail FROM audit WHERE actor = 'gate' AND action = 'commit'")
    .all() as Array<{ claim_id: number | null; detail: string | null }>;
  const stated: Array<{ claimId: number; value: number; source: string }> = [];
  for (const r of rows) {
    if (r.claim_id === null || !r.detail) continue;
    try {
      const parsed = JSON.parse(r.detail) as {
        reportedConfidence?: number;
        confidenceScore?: number;
        confidenceSource?: string;
      };
      const value = parsed.reportedConfidence ?? parsed.confidenceScore;
      if (typeof value === "number") {
        stated.push({ claimId: r.claim_id, value, source: parsed.confidenceSource ?? "verbalized" });
      }
    } catch {
      // A malformed audit row is skipped, never guessed at.
    }
  }
  if (stated.length === 0) {
    return { commits: 0, mean_reported: null, later_refuted: 0, by_source: {}, calibration_available: false, note: "no commits recorded yet; independent correctness labels are required for calibration" };
  }
  const refuted = new Set(
    (db.prepare("SELECT id FROM claims WHERE status = 'refuted'").all() as Array<{ id: number }>).map((c) => c.id),
  );
  const round = (n: number) => Math.round(n * 10000) / 10000;
  const summarize = (xs: typeof stated) => ({
    commits: xs.length,
    mean_reported: round(xs.reduce((sum, x) => sum + x.value, 0) / xs.length),
    later_refuted: xs.filter((x) => refuted.has(x.claimId)).length,
  });
  const by_source: Record<string, { commits: number; mean_reported: number; later_refuted: number }> = {};
  for (const source of new Set(stated.map((x) => x.source))) {
    by_source[source] = summarize(stated.filter((x) => x.source === source));
  }
  const all = summarize(stated);
  return {
    ...all,
    by_source,
    calibration_available: false,
    note:
      stated.length < minSample
        ? `${stated.length} commits is too few to read as calibration (needs about ${minSample}); these are descriptive counts, without independent correctness labels or ECE`
        : "descriptive commit/refutation counts grouped by estimator, not ECE; unrefuted claims are unlabelled, repeat commits are not independent outcomes, and refutation alone does not establish miscalibration",
  };
}
