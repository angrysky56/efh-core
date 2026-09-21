/**
 * Local operator review of symbol grounding and premise scope. No MCP tool can
 * create approvals. This is an attributed attestation, not proof of truth or a
 * security boundary against a process that can already write the database.
 */
import type Database from "better-sqlite3";
import type {Formalization, FormulaTranslation} from "./types.js";
import {digest, inputDigest, RENDERER_REVISION} from "./translation.js";

export interface TranslationReview {
  formalization_id: number;
  digest: string;
  decision: "pending" | "approved" | "rejected";
  reviewer: string;
  claim_scope: string;
  symbols: Array<{key: string; grounding: string}>;
  premises: Array<{index: number; justification: string}>;
}

/** Bind review to exact stored evidence, claim, raw input, and renderer version. */
export function reviewPacket(db: Database.Database, formalizationId: number) {
  const formalization = db.prepare("SELECT * FROM formalizations WHERE id = ?").get(formalizationId) as Formalization | undefined;
  if (!formalization) throw new Error("Formalization does not exist");
  const claim = db.prepare("SELECT id, text FROM claims WHERE id = ?").get(formalization.claim_id) as {id: number; text: string};
  const translation = formalization.translation ? JSON.parse(formalization.translation) as FormulaTranslation : null;
  const fingerprint = digest({claim, formalization});
  return {claim, formalization, translation, digest: fingerprint,
    review_template: {
      formalization_id: formalizationId, digest: fingerprint, decision: "pending", reviewer: "", claim_scope: "",
      symbols: (translation?.symbols ?? []).map(s => ({key: s.key, grounding: ""})),
      premises: (translation?.canonical_axioms ?? []).map((_, index) => ({index, justification: ""})),
    } satisfies TranslationReview};
}

export function translationEligibility(formalization: Formalization, translation: FormulaTranslation | null): string | null {
  if (!translation || translation.status !== "supported" || !translation.generated_gloss) return "translation unverified: unsupported or missing parser-backed rendering";
  if (translation.revision !== RENDERER_REVISION || translation.input_digest !== inputDigest(JSON.parse(formalization.axioms), formalization.conjecture)) {
    return "translation evidence is stale or does not match the submitted formulas; reverify";
  }
  if (translation.missing_meanings.length) return `symbol meanings missing: ${translation.missing_meanings.join(', ')}; supply symbol_glossary and reverify`;
  if (translation.premise_consistency !== "sat") return `premises are ${translation.premise_consistency === 'unsat' ? 'inconsistent' : 'not established consistent'}; no commit is permitted`;
  return null;
}

/** Current approval only; any changed evidence or newer formalization invalidates it. */
export function translationReviewStatus(db: Database.Database, formalizationId: number) {
  const packet = reviewPacket(db, formalizationId);
  const problem = translationEligibility(packet.formalization, packet.translation);
  const row = db.prepare("SELECT decision, digest, reviewer, reviewed_at FROM translation_reviews WHERE formalization_id = ?")
    .get(formalizationId) as {decision: string; digest: string; reviewer: string; reviewed_at: string} | undefined;
  const latest = db.prepare("SELECT MAX(id) AS id FROM formalizations WHERE claim_id = ?").get(packet.claim.id) as {id: number};
  const reason = problem ?? (latest.id !== formalizationId ? "a newer formalization needs its own review"
    : !row ? "independent symbol and premise review required; use the local review-formalization CLI"
    : row.digest !== packet.digest ? "review no longer matches the claim and formalization; review again"
    : row.decision !== "approved" ? "translation review was rejected" : null);
  return {ok: reason === null, reason, digest: packet.digest, reviewer: row?.reviewer ?? null, reviewed_at: row?.reviewed_at ?? null};
}

/** Explicit local action, never called from a model-facing tool. */
export function recordTranslationReview(db: Database.Database, review: TranslationReview): void {
  db.transaction(() => {
    if (!review || !Number.isSafeInteger(review.formalization_id)) throw new Error("A formalization_id is required");
    if (!["approved", "rejected"].includes(review.decision)) throw new Error("Set decision to approved or rejected after review");
    if (typeof review.reviewer !== 'string' || !review.reviewer.trim() || typeof review.claim_scope !== 'string' || !review.claim_scope.trim()) {
      throw new Error("Reviewer identity and claim_scope rationale are required");
    }
    const packet = reviewPacket(db, review.formalization_id);
    if (review.digest !== packet.digest) throw new Error("Review digest is stale; inspect the current artifact again");
    const latest = db.prepare("SELECT MAX(id) AS id FROM formalizations WHERE claim_id = ?").get(packet.claim.id) as {id: number};
    if (latest.id !== review.formalization_id) throw new Error("Review the latest formalization");
    if (review.decision === "approved") {
      const problem = translationEligibility(packet.formalization, packet.translation);
      if (problem) throw new Error(problem);
      const symbols = packet.translation!.symbols.map(s => s.key);
      if (!Array.isArray(review.symbols) || review.symbols.length !== symbols.length || new Set(review.symbols.map(s => s.key)).size !== symbols.length ||
        review.symbols.some(s => !symbols.includes(s.key) || typeof s.grounding !== 'string' || !s.grounding.trim())) {
        throw new Error("Provide independent grounding for every symbol and sort");
      }
      const premises = packet.translation!.canonical_axioms;
      if (!Array.isArray(review.premises) || review.premises.length !== premises.length || new Set(review.premises.map(p => p.index)).size !== premises.length ||
        review.premises.some(p => !Number.isInteger(p.index) || p.index < 0 || p.index >= premises.length || typeof p.justification !== 'string' || !p.justification.trim())) {
        throw new Error("Justify every premise, or identify it explicitly as an assumption of the conditional claim");
      }
    }
    db.prepare(`INSERT INTO translation_reviews (formalization_id, digest, decision, reviewer, evidence)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(formalization_id) DO UPDATE SET digest=excluded.digest,
      decision=excluded.decision, reviewer=excluded.reviewer, evidence=excluded.evidence, reviewed_at=datetime('now')`)
      .run(review.formalization_id, review.digest, review.decision, review.reviewer, JSON.stringify(review));
    if (review.decision === "rejected") {
      db.prepare("UPDATE claims SET status = 'verified', updated_at = datetime('now') WHERE id = ? AND status = 'committed'").run(packet.claim.id);
    }
    db.prepare("INSERT INTO audit (actor, action, claim_id, detail) VALUES (?, ?, ?, ?)")
      .run(`reviewer:${review.reviewer}`, "translation_review", packet.claim.id, JSON.stringify(review));
  }).immediate();
}
