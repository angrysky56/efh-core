/**
 * Shared types for efh-core.
 *
 * Terminology note (honest labeling): the enforcer measures cross-verifier
 * coherence between registered agent states. "KERNEL1" etc. are retained as
 * status names for continuity with the EFHF research framing; they denote
 * coherence regimes, not verified lumpability of any underlying model.
 */

/** Closure status regimes, escalate-only within a session until reset/recovery. */
export type ClosureStatus = "KERNEL1" | "WEAK" | "WARNING" | "TIMEOUT" | "KERNEL2";

export const STATUS_PRIORITY: Record<ClosureStatus, number> = {
  KERNEL1: 0,
  WEAK: 1,
  WARNING: 2,
  TIMEOUT: 3,
  KERNEL2: 4,
};

/** How a projected string value is compared on an edge. */
export type CompareMode = "hash" | "semantic";

/** One entry of a restriction map: projects an agent-state key onto a shared edge-space key. */
export interface RestrictionMapping {
  from_key: string;
  to_key: string;
  weight?: number;
  /**
   * hash     — SHA-256 → float; identical strings ⇒ distance 0, else quasi-random distance.
   * semantic — Ollama embedding cosine distance; graded similarity for paraphrases.
   * Numbers and booleans always project as scalars regardless of mode.
   */
  compare?: CompareMode;
}

/** A value projected onto the edge space: numeric scalar or raw text awaiting semantic comparison. */
export type ProjectedValue =
  | { kind: "scalar"; v: number }
  | { kind: "text"; s: string; weight: number };

export type AgentState = Record<string, unknown>;

export interface EdgeReport {
  edge_id: string;
  coboundary_norm: number;
  dual_variable: number;
  primal_residual: number;
  dual_residual: number;
  converging: boolean;
  stalled: boolean;
  pressure: number;
}

export interface RecoveryRecommendation {
  strategy: "none" | "soft_relax" | "admm_reset" | "kernel_retreat" | "re_partition" | "fusion";
  reason: string;
  action?: string;
}

export interface CycleReport {
  iteration: number;
  closure_status: ClosureStatus;
  previous_status: ClosureStatus;
  status_changed: boolean;
  agents_active: string[];
  edges_evaluated: number;
  mean_coboundary_norm: number;
  max_dual_variable: number;
  dual_pressure_per_agent: Record<string, number>;
  h1_obstruction: boolean;
  h1_detail: string;
  semantic_channel: "on" | "off (hash fallback)";
  warnings: string[];
  recovery_recommendation: RecoveryRecommendation;
  edge_reports: EdgeReport[];
  cycle_duration_ms: number;
}

/** Result of a formal verification call. */
export interface VerifyResult {
  backend: "z3" | "prover9" | "mace4";
  result: "proved" | "refuted" | "sat" | "unsat" | "unknown" | "error";
  detail: string;
  /** Model / counterexample s-expression when one exists. */
  model?: string;
  /** Z3 unsat/proved results: the asserted lines that carried the proof. */
  unsat_core?: string[];
  /** Set when a proof was obtained under declared strengthenings (interpretation-relative). */
  strengthened_proof?: true;
  translation?: FormulaTranslation;
  elapsed_ms: number;
}

export type FidelityDecision = "passed" | "failed" | "unsettled" | "unmeasured";

/** Unrounded provider output for one judgment draw. */
export interface FidelityDraw {
  noul: number;
  relation: string;
  confidence: number;
  model: string;
}

/** Evidence needed to interpret a score across model and policy changes. */
export interface FidelityProvenance {
  provider: "typesafe" | "openrouter" | "ollama";
  requested_model: string;
  /** Empty for embeddings: Ollama model names do not establish a concrete build. */
  resolved_models: string[];
  question_revision: string | null;
  policy_revision: string;
  boundary: number;
  resample_band: number | null;
  resample_samples: number | null;
  draws: FidelityDraw[];
  mixed_models: boolean;
}

/** A persisted formal encoding of a claim — reviewable and replayable. */
export interface Formalization {
  id: number;
  claim_id: number;
  /** JSON array of SMT-LIB / Prover9 lines as supplied. */
  axioms: string;
  conjecture: string;
  backend: string;
  result: string;
  proof_confidence: number | null;
  /** Agreement between claim and server-rendered conditional formal statement. */
  fidelity: number | null;
  fidelity_method: string | null;
  fidelity_samples: number | null;
  fidelity_spread_low: number | null;
  fidelity_spread_high: number | null;
  /** SQLite has no boolean: 1 when repeated judgments straddled the floor. */
  fidelity_unsettled: number | null;
  fidelity_split: number | null;
  /** NULL for historical rows: an old score is not a decision under the current policy. */
  fidelity_decision: FidelityDecision | null;
  /** JSON provenance; decoded by getFormalizations. */
  fidelity_provenance: string | null;
  /** Original caller note; never used as fidelity evidence. */
  gloss: string | null;
  /** JSON of the AST-derived rendering and its binding evidence. */
  translation: string | null;
  /** JSON array of declared strengthenings (UF interpretations, bounds); null if faithful. */
  strengthenings: string | null;
  created_at: string;
}

export interface Claim {
  id: number;
  text: string;
  belief: number;
  status: "asserted" | "verified" | "refuted" | "committed" | "retracted";
  proof_confidence: number | null;
  source: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

/** Server-produced rendering of the exact ASTs passed to the prover. */
export interface FormulaTranslation {
  status: "supported" | "unsupported";
  revision: string;
  input_digest: string;
  reason?: string;
  generated_gloss: string | null;
  assumptions: string[];
  conclusion: string | null;
  canonical_axioms: string[];
  canonical_conjecture: string;
  symbols: Array<{ key: string; signature: string; meaning: string | null }>;
  missing_meanings: string[];
  premise_consistency: "sat" | "unsat" | "unknown";
}
