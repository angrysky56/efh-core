/**
 * Claim store, audit trail, and the commit gate.
 *
 * The commit rule (structural, not advisory — from EFHF agent instructions):
 *   commit ⇔ proof_confidence ≥ 0.7 ∧ confidence_score ≥ 0.7 ∧ status = KERNEL1
 * Refusals are normal results (committed:false + reason + recovery
 * recommendation), and every attempt is audited either way.
 */

import type Database from "better-sqlite3";
import type { Claim, ClosureStatus, Formalization, RecoveryRecommendation } from "./types.js";

const MIN_CONFIDENCE = Number(process.env.EFH_COMMIT_MIN_CONFIDENCE ?? 0.7);

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
    confidence_score_ok: boolean;
    kernel1_ok: boolean;
    min_confidence: number;
  };
  recovery_recommendation?: RecoveryRecommendation;
}

/**
 * THE GATE. All three conditions must hold; anything else is a refusal.
 * A refusal is not an error — it is the consistency check working.
 */
export function commitClaim(
  db: Database.Database,
  claimId: number,
  confidenceScore: number,
  closureStatus: ClosureStatus,
  recovery?: RecoveryRecommendation,
): CommitOutcome {
  const claim = getClaim(db, claimId);
  if (!claim) throw new Error(`Claim ${claimId} does not exist`);

  const pc = claim.proof_confidence ?? 0;
  const gate = {
    proof_confidence_ok: pc >= MIN_CONFIDENCE,
    confidence_score_ok: confidenceScore >= MIN_CONFIDENCE,
    kernel1_ok: closureStatus === "KERNEL1",
    min_confidence: MIN_CONFIDENCE,
  };

  if (claim.status === "refuted") {
    audit(db, "gate", "commit_refused", claimId, { reason: "claim is refuted", gate });
    return {
      committed: false,
      claim_id: claimId,
      reason: "Claim has been refuted by the verifier — cannot commit.",
      closure_status: closureStatus,
      gate,
    };
  }

  if (gate.proof_confidence_ok && gate.confidence_score_ok && gate.kernel1_ok) {
    db.prepare(
      "UPDATE claims SET status = 'committed', updated_at = datetime('now') WHERE id = ?",
    ).run(claimId);
    audit(db, "gate", "commit", claimId, { confidenceScore, closureStatus, gate });
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
    failures.push(`proof_confidence ${pc.toFixed(2)} < ${MIN_CONFIDENCE} (verify the claim first)`);
  }
  if (!gate.confidence_score_ok) {
    failures.push(`confidence_score ${confidenceScore.toFixed(2)} < ${MIN_CONFIDENCE}`);
  }
  if (!gate.kernel1_ok) {
    failures.push(`closure_status is ${closureStatus}, not KERNEL1`);
  }
  audit(db, "gate", "commit_refused", claimId, { failures, gate });
  return {
    committed: false,
    claim_id: claimId,
    reason: `Commit refused: ${failures.join("; ")}. This is the consistency check working, not an error.`,
    closure_status: closureStatus,
    gate,
    recovery_recommendation: recovery,
  };
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
    gloss: string | null;
  },
): void {
  db.prepare(
    "INSERT INTO formalizations (claim_id, axioms, conjecture, backend, result, proof_confidence, fidelity, gloss) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    f.claim_id,
    JSON.stringify(f.axioms),
    f.conjecture,
    f.backend,
    f.result,
    f.proof_confidence,
    f.fidelity,
    f.gloss,
  );
}

export function getFormalizations(
  db: Database.Database,
  claimId: number,
): Array<Omit<Formalization, "axioms"> & { axioms: string[] }> {
  const rows = db
    .prepare("SELECT * FROM formalizations WHERE claim_id = ? ORDER BY id DESC")
    .all(claimId) as Formalization[];
  return rows.map((r) => ({ ...r, axioms: JSON.parse(r.axioms) as string[] }));
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
