---
name: via-negativa
description: Epistemic filtering by subtraction — generate mechanism/narrative/constraint hypotheses, eliminate the weak ones through constraint checks, Lakatosian cuts, and explain-away analysis, then synthesize actionable truth. Use when diagnosing why something happens, separating real mechanisms from plausible stories, testing "why do we believe this?", or when the user mentions via negativa, wisdom engine, or hypothesis filtering.
---

# Via Negativa (host-agent procedure)

You execute this reasoning yourself — no LLM backend, no second server. Persist results
through efh-core so survivors become auditable claims.

## 1. Fan out hypotheses

For the surface observation, generate exactly three perspectives:

- **Mechanism** (how does it actually work?) — physical, technical, systemic causes.
- **Narrative** (why do we *think* it works?) — social, cognitive, psychological stories
  that make it seem true.
- **Constraint** (what are the hard limits?) — boundary conditions, resource bounds,
  logical limits.

Map each at three depths: **d1** symptom (surface observation) → **d2** mechanism
(underlying cause) → **d3** invariant (the law or boundary condition beneath it).

Record each via `assert_claim` (tag: `hypothesis`), belief = your honest prior.

## 2. Subtract

**Stage A — Constraint checks.** Only if explicit constraints/invariants were provided:
does the hypothesis violate any? If violation is formalizable, confirm with efh-core
`check_consistency` (hypothesis + invariants as SMT-LIB; unsat = eliminated).
**Skip Stage A entirely when no constraints exist** — hunting for violations of nothing
produces hallucinated violations.

**Stage B — Lakatosian cuts.** Eliminate hypotheses that (a) are unfalsifiable — no
observation could refute them, or (b) survive only by accumulating ad-hoc defensive
assumptions. Ask of each: "What evidence would kill this?" No answer → cut.

**Stage C — Explain-away collider.** Where a mechanism and a narrative explain the same
symptom, the stronger mechanistic explanation absorbs the narrative's evidential weight.
This is deliberately asymmetric: mechanisms explain away narratives, never the reverse.
If the social dynamic IS the mechanism, it belongs in a mechanism hypothesis.

Mark eliminated claims: `link_claims(survivor, eliminated, "contradicts")` and note the
stage that cut them. A check you did not run never counts as a check that passed —
report which stages actually executed.

## 3. Synthesize truth

Compress survivors into: the structural mechanism (d2–d3), what remains uncertain, and
the cheapest next test that would discriminate between remaining survivors. Assert the
synthesis as its own claim (`derived_from` links to survivors), verify what is
formalizable, and pass it through the commit gate per the efh-loop skill.
