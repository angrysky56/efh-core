# efh-core — Developer Documentation

Everything past the lay README: architecture rationale, epistemic status,
tool semantics, the consistency-monitor mathematics, soundness rules, the
Isabelle layer, measured calibration data, and next steps.

## Design rule

A server holds only what needs **computation and persistence** — state,
deterministic verification, local model inference. Reasoning patterns are
**skills** executed by the host agent. Most multi-server AI-reasoning stacks
are prompt-level reasoning wearing server costumes; that fragmentation (N
processes, N schemas, integration maps hard-coupled to server identities)
is what this design eliminates.

```
skills (host agent)                    efh-core server (one process)
  efh-loop ─ operating loop      ┌── claim store ── SQLite: claims, links, audit
  via-negativa ─ subtraction ────┤── verifier ──── Z3 (WASM, lazy) | Prover9/Mace4 (optional)
  got-patterns ─ branch/merge    │── enforcer ──── ADMM cycles, H¹ detection, recovery
  ethical-triage ─ Paraclete ────┘── gate ──────── commit ⇔ pc≥0.7 ∧ conf≥0.7 ∧ KERNEL1
```

## Honest labeling (epistemic status)

The enforcer measures **cross-verifier coherence**: agreement between
registered agent states projected onto shared edge spaces. It does not measure
lumpability of any underlying model's dynamics — that identification is a
research hypothesis. Status names (`KERNEL1`, `WEAK`, `WARNING`, `TIMEOUT`,
`KERNEL2`) are retained as shorthand for coherence regimes. Prover results are
valid relative to supplied axioms; the formalization step is the weakest link
and is instrumented accordingly (fidelity, below). Say "verified within
closure bounds," never "proven true."

## Facet design

Internal facets are auto-registered by the tools themselves, so the default
restriction maps cannot drift out of sync with tool outputs:

- `world-model` — set by `assert_claim`: `{last_assertion, belief_score, inconsistency_flag}`
- `verifier` — set by verify tools: `{last_proof_result, proof_confidence, contradictions_found}`
  (claim-bound verifications register the **claim's text**, not raw SMT, so the
  semantic channel compares like with like)
- `reasoner` — registered by the host agent: `{current_hypothesis, confidence_score, halt_flag, verified_claim?}`

External agents are first-class via `register_agent_state` +
`set_restriction_map`. Rule for maps: both directions of a pair must project
onto the same edge-space key names (`edge_claim`, `edge_confidence`,
`edge_inconsistent` in the defaults).

## Tool reference (16)

| Tool | Semantics |
|---|---|
| `assert_claim` | New claim (text, belief 0-1, source, tags) → ledger; auto-registers world-model facet |
| `get_claims` | Filter by status / tag / substring |
| `link_claims` | Provenance edges: supports, contradicts, refines, derived_from |
| `get_audit_trail` | Every assert/verify/commit/refusal/recovery, timestamped |
| `get_formalizations` | The formal encodings behind a claim's verifications — audit these |
| `verify_implication` | Axioms ⊨ conjecture. Z3 (SMT-LIB) default; `prover9` optional. `unknown` is NOT a pass |
| `check_consistency` | Joint satisfiability; unsat core pinpoints the contradiction |
| `find_counterexample` | Model where axioms hold and conjecture fails (Mace4 role) |
| `register_agent_state` | Agent state for coherence checking |
| `run_admm_cycle` | One full cycle: coboundary norms, dual pressure, H¹ check, status, recovery advice |
| `get_closure_status` | Current regime + per-agent pressure + last recommendation |
| `trigger_recovery` | soft_relax / admm_reset / kernel_retreat / re_partition / fusion |
| `set_restriction_map` | Wire a directed edge's projection (compare: hash \| semantic) |
| `reset_session` | Clean enforcer slate; claims and audit persist |
| `commit_claim` | THE GATE: proof_confidence ≥ 0.7 ∧ confidence_score ≥ 0.7 ∧ KERNEL1 |
| `session_status` | Health: claim counts, enforcer summary, backend availability |

## Enforcer mathematics

Faithful port of the sheaf-Laplacian ADMM enforcer (Python original), semantics
preserved:

- **Projection**: restriction maps send agent-state keys onto shared edge keys.
  Numbers/bools → scalars. Strings → SHA-256→float (`hash` mode, exact-match)
  or held as text for embedding cosine distance (`semantic` mode, graded — so
  paraphrases don't register as full disagreement).
- **Coboundary norm** per edge: RMS distance over shared projected keys.
  No shared keys → 0 (soft constraint, not an alarm).
- **Dual update**: leaky integrator, `dual ← dual·(1−0.15) + coboundary` —
  accumulated inconsistency memory with dissipative decay.
- **Escalation** (escalate-only; recovery is the sanctioned de-escalation):
  mean coboundary > `epsilon_primal` (0.15) → WEAK; plus dual > 5.0 → WARNING;
  ADMM stall + high dual, or H¹ obstruction → TIMEOUT.
- **H¹ obstruction**: a directed 3-cycle of agents whose dual variables sum
  above 1.5× the warning threshold — a cyclic contradiction that no pairwise
  adjustment resolves. Fires only after ≥3 iterations (warmup guard).
- **Recovery ladder** (cheapest first): `admm_reset` (clear duals) →
  `soft_relax` (advice only) → `kernel_retreat` (remove highest-pressure agent)
  → `re_partition` (clear target agent) → `fusion` (reset + reintegration cycle).

Thresholds are env-tunable (`EFH_EPSILON_PRIMAL`, `EFH_DUAL_WARNING`) because
calibration is a deployment decision — see Calibration below.

## Verification soundness rules

- **Unsat cores.** Assertions are auto-named; `proved`/`unsat` results return
  the asserted lines that carried the proof. A core omitting an axiom you
  consider essential signals a possibly vacuous proof (e.g., inconsistent
  premises) — inspect before trusting.
- **Formalization fidelity.** Claim-bound verifications persist their full
  encoding (axioms, conjecture, result) in the `formalizations` table. The
  verify tools accept a `gloss` — an independent English rendering of what the
  encoding literally says, written from the formalization alone. The server
  scores `fidelity = 1 − embedding_distance(claim_text, gloss)` and warns below
  `EFH_FIDELITY_MIN`. Reported, never gated: thresholds come from data.
- **Strengthenings cap.** Declaring `strengthenings` (concrete `define-fun`
  interpretations for uninterpreted functions, bounds, finitizations) enforces
  the logical asymmetry: models and refutations under strengthening remain
  fully sound (original axioms still asserted); proofs become
  interpretation-relative and cap at pc 0.6 — deliberately below the gate.
  Omitting a real strengthening is a soundness violation the server cannot
  detect; the efh-loop skill makes declaration mandatory.
- **Interpretation loop.** On `unknown`, the host agent proposes
  interpretations/bounds CEGAR-style, using `get_formalizations` as exclusion
  memory. See the efh-loop skill.

## Calibration

`npm run calibrate` measures embedding-distance distributions over paraphrase /
contradiction / unrelated pairs and suggests a semantic-mode `epsilon_primal`.

Measured on `nomic-embed-text` (n small; re-run on your setup):

- Claim identity separates cleanly: paraphrase coboundary ≤ 0.247, unrelated
  ≥ 0.351 → suggested semantic-edge epsilon ≈ 0.30.
- **Embeddings are negation-blind**: contradictions embed marginally *closer*
  than paraphrases (median gap −0.015). By design, truth disagreement rides on
  the scalar channels (proof_confidence, flags); the semantic channel answers
  only "same proposition?".
- Default epsilon 0.15 sits inside the paraphrase band — benign rephrasing can
  nudge WEAK. Raising it globally blunts scalar sensitivity; per-edge
  thresholds are the principled fix (see Next steps).

## Isabelle layer (slow tier)

`isabelle/` holds kernel-checked proofs; build with
`isabelle build -D isabelle/` (HOL heap ships with Isabelle2025).

- **`EFHF.thy`** — the Triadic Kernel axiom network as a **locale**: theorems
  (`full_closure_stack`, `si_ct_incompatible`) cannot leave the context without
  carrying the stipulations as premises — axiom-relativity made syntactic.
  Two interpretation witnesses establish consistency.
- **`EFHF_Grounding.thy`** — definitional grounding: closure concepts *defined*
  over dynamics, relationships *proved*. Deterministic setting:
  `info_closed ⟷ comp_closed`. Finite stochastic setting: Kemeny–Snell strong
  lumpability ⟹ a well-defined, stochastic, commuting macro kernel
  (`lumped_commutes`, `lumped_stochastic`). The IC→CompC edge the locale
  assumes is, for these system classes, a theorem.
- Division of labor: Z3 in-loop (milliseconds, claim gating); Isabelle for the
  canon (LCF-kernel assurance, readable Isar). Three independent proof systems
  agree on the axiom set: Prover9, Z3, Isabelle.

## Related specs and experiments

- **`docs/probe-confidence-spec.md`** — replace verbalized `confidence_score`
  with calibrated activation-probe readouts on local models; the verifier
  bootstraps the probe's training labels (proved/refuted = ground truth).
- **`ai_workspace/sparc-falsification`** — tests whether measured per-step
  amplification of the error-propagation operator predicts self-correction
  failure (SPARC, arXiv:2607.09803). Estimator validated; behavioral battery
  ready to run. If it survives, amplification becomes a per-trace
  self-correctability certificate feeding the triage layer.

## Project layout

```
src/
  index.ts            entry, stdio transport, shutdown persistence
  tools.ts            all 16 tool registrations, facet auto-registration, fidelity
  store.ts            claims, links, audit, formalizations, THE GATE
  verifier.ts         Z3 (lazy WASM), naming/cores, strengthenings cap, LADR shell-out
  embeddings.ts       Ollama client, SQLite cache, fail-loud policy
  db.ts               schema + additive migrations
  enforcer/state.ts   session state, edges, default restriction maps, env overrides
  enforcer/admm.ts    projection, coboundary, dual update, H¹, recovery advice
test/
  smoke.mjs           25+ checks against built modules; no network needed
  calibrate.mjs       semantic-channel threshold measurement (needs Ollama)
skills/               canonical skill copies (install to ~/.claude/skills)
isabelle/             ROOT + EFHF.thy + EFHF_Grounding.thy
```

Fail-loud policy throughout: a check that did not run never counts as a check
that passed. Z3 `unknown` is not-a-pass; missing Ollama with semantics on is an
error with remedies, never a silent fallback.

## Next steps

1. **Per-edge epsilon thresholds** — semantic edges calibrated (~0.30) without
   blunting scalar sensitivity (0.15).
2. **Probe-derived confidence** — implement `docs/probe-confidence-spec.md`;
   wire probe output into the reasoner facet; tag commits with
   `confidence_source` in the audit trail.
3. **Run the SPARC behavioral battery** — extend the problem set past n=10;
   if P1 holds, surface the amplification certificate to the triage skill.
4. **Measure-theoretic grounding** — generalize `EFHF_Grounding.thy` to
   arbitrary state spaces via HOL-Probability; the genuinely two-way stochastic
   closure theorem needs the spatial coarse-graining structure.
5. **TPTP backend** — Vampire/E as drop-in FOL provers alongside Z3;
   Prover9 ↔ Z3 cross-checks on the full EFHF axiom set.
6. **FTS5 claim search** — replace LIKE.
7. **Enforcer baselines** — re-run the original enforcer's baseline procedure
   against this port (hash mode should reproduce; semantic mode uses the
   calibration harness).
