# Probe-Derived Confidence for the Reasoner Facet

**Status:** specification (architecture-paper-first; implementation follows validation of this design)
**Target:** local models feeding efh-core; conscience-servitor integration
**Basis:** Sarfati et al., "What LLM Forecasters Know but Don't Say" (Goodfire/Eternis, arXiv:2607.08046, 2026); FSM spec (probe-anchored substrate monitoring)

> **Status note.** The gate no longer consumes `confidence_score`. A number the
> author supplies about its own output cannot verify that output, so counting it
> as a gate leg overstated the gate's independence; it is now recorded as
> `reported_confidence` and reported back as calibration by `session_status`.
> That does not retire this spec; it relocates where its output lands.
>
> **Decision (2026-09-20, Ty): measured, not trusted.** A probe-derived
> confidence does not earn a gate leg. However good an estimator is, it is still
> the system reporting on itself, and a self-report cannot verify the output that
> produced it. The probe's number goes where the verbalized number now sits —
> recorded, and compared against what happened to the claim.
>
> `commit_claim` therefore takes `confidence_source` alongside
> `reported_confidence`, and `session_status` groups calibration by it. That
> makes this spec's central claim (ECE 0.044 for probes against 0.093 for
> verbalized) checkable on real claims in this system rather than cited from a
> paper: build the probe, commit with `confidence_source: "probe"`, and read the
> two groups against subsequent refutations.

## Problem

The efh-core commit gate consumes `confidence_score` — currently the agent's
*verbalized* confidence. The Goodfire result: verbalized confidence is the worst
available estimator of correctness (ECE 0.093 vs 0.044 for activation probes on
the same model), and RLHF-shaped models systematically overstate it. The gate's
weakest input is the one we trust the agent to report.

## Design

Replace/augment verbalized confidence with a calibrated probe readout for any
local model acting as the reasoner (or as a local generator inside AGEM):

```
local model generates claim/reasoning
        │  (forward hooks, fp16)
        ▼
pooled intermediate activations  ──►  linear probe  ──►  p(correct) ∈ [0,1]
                                                              │
                                                              ▼
                            register_agent_state("reasoner",
                              {current_hypothesis, confidence_score: p, ...})
```

### Probe recipe (from the paper, adapted)

- **Sites:** residual stream at layers ≈ 0.5·L to 0.85·L (sweep; the FSM work
  already targets 0.85·L for the falsity direction — reuse hooks).
- **Pooling:** mean-pooling over the reasoning-trace tokens as baseline;
  attention-pooling and covariance-pooling as upgrades (paper finds pooled
  context beats single-position readouts).
- **Head:** single linear layer + sigmoid, BCE loss, frozen base model.
  Thousands of examples suffice (their GLM probes: ~12k rollouts).
- **Calibration metric:** ECE against held-out outcomes; compare against
  (a) verbalized confidence, (b) mean token logprob, (c) self-consistency spread.

### Labels: the verifier bootstraps the probe

The paper needed resolved forecasting questions for labels. We have something
better: **efh-core generates ground truth on demand.** Pipeline:

1. Prompt the local model to assert formalizable claims (math, logic,
   constraint problems — the domains Z3 decides).
2. Run each claim through `verify_implication` / `find_counterexample`.
3. `proved` / `refuted` = binary label; `unknown` = discard (or hold out as an
   abstention class).
4. Train the probe on (activations, label) pairs.

This closes a loop with a name: the symbolic layer manufactures the supervision
that calibrates the neural layer's self-report. No human labeling, no dataset
dependency, labels are kernel-adjacent in trustworthiness.

Caveat: this trains a probe for *formalizable-claim* correctness. Transfer to
open-domain claims must be measured, not assumed (the paper's own transfer
caveats apply; their probes are task-distribution-specific). Report per-domain
ECE; do not ship a single number.

### Serving

Smallest viable: a `/confidence` endpoint inside conscience-servitor (it
already holds a GPU model + hook infrastructure) taking {model_id, prompt,
response}, returning {p_correct, probe_id, domain}. The agent (or AGEM
orchestrator) calls it before `register_agent_state` and passes the probe value
as `confidence_score`. efh-core needs **zero changes** — the gate already
consumes the number; only its provenance improves. Optionally tag the facet:
`{confidence_source: "probe:<id>"}` so the audit trail records which estimator
gated each commit.

### Leakage controls (from the paper's appendix, non-negotiable)

- Truncate activations *before* the final answer tokens (else the probe reads
  the answer, not the epistemic state).
- Deduplicate probe-training claims against evaluation claims.
- Shuffle-label control: probe trained on permuted labels must fall to chance;
  if not, there is leakage in the pipeline.

## Falsification criteria for this design

- Probe ECE fails to beat verbalized-confidence ECE on held-out verifier-labeled
  claims → the recipe does not transfer to this regime; stop.
- Shuffle control above chance → pipeline leak; results void until fixed.
- Transfer ECE to a second domain degrades to worse-than-logprob baseline →
  probes are memorizing task surface, not reading epistemic state; scope claims
  accordingly.

## Hardware fit

RTX 3060 12GB: 8B-class model in 4-bit + fp16 hook capture is comfortable for
activation extraction; probe training is trivial (linear head). Qwen3-0.6B
(already resident for LLM2Vec-Gen) is the fast-iteration target; Qwen3-8B the
production target.

## Transfer evaluation protocol (before trusting the probe at the gate)

The closed Z3-labeling loop introduces a specific danger: the probe may learn
surface features of the SMT-decidable regime (quantifiers, integers, logical
form) rather than the model's epistemic state, so in-distribution calibration
looks great and collapses out-of-domain. The eval is built to catch exactly that.

### Reframe: discrimination transfers hard, calibration is cheaply recoverable

ECE and AUROC fail-transfer differently and must be measured separately.
- If the probe still DISCRIMINATES out-of-domain (AUROC > 0.5) but is
  miscalibrated, that is fixable with one scalar: a per-domain temperature fit on
  a small labeled slice.
- If the probe stops discriminating (AUROC -> 0.5), no recalibration saves it.

So the primary transfer metric is **AUROC degradation** (the hard-to-fix part);
ECE is treated as recoverable via per-domain temperature. "Measure ECE
degradation" alone is the wrong target.

### The ladder (each rung has its own ground truth)

- **L0 in-distribution** - same generator/domain (integer arithmetic + logic),
  Z3-labeled, clean split. Ceiling AUROC/ECE + shuffle-control floor.
- **L1 content transfer, same regime** - different SMT-decidable theories never
  trained on (reals, bit-vectors, arrays, propositional). Z3-labeled -> gold on
  both sides, free. Catches "learned SMT-surface features of integers."
- **L2 regime transfer, oracle-verifiable** - decidable by a DIFFERENT oracle
  than Z3: answer-checkable word problems, KB-verifiable facts (Wikidata),
  closed-form physics. Ground truth from that oracle. Catches "learned
  formal-regime features" - the sharpest test, since all training labels are
  formal.
- **L3 open-domain** - genuinely non-formal reasoning claims; ground truth from a
  small human/strong-oracle-labeled gold set (~hundreds; enough for AUROC + one
  temperature). The real commit-gate target regime; pay for the gold set here.

### Metrics at every rung

AUROC (primary), ECE with **adaptive/equal-mass binning** (equal-width manufactures
artifacts on skewed confidence), Brier, reliability diagram. Compare against three
baselines at each rung: verbalized confidence, mean token logprob, self-consistency
spread. The probe must beat these to justify itself.

### Pre-registered accept/reject rule

1. Shuffle-label control falls to chance at EVERY rung, else pipeline leak -> void.
2. AUROC meaningfully > 0.5 at L2 AND L3 (discrimination reaches the target regime).
3. After a per-domain temperature fit on a small L2/L3 slice, ECE beats verbalized
   confidence in that regime.
4. If AUROC survives but ECE does not recover: usable only with per-domain
   recalibration -> the gate must be domain-aware.

### Deployment consequence - domain-aware gating

The probe augments the commit gate ONLY in domains the ladder validated, with a
fitted per-domain temperature. Outside validated domains the gate falls back to
the symbolic verifier and its "unknown = not a pass" rule. The probe never
replaces the verifier; it adds a calibrated confidence channel where it has been
shown to transfer, and stays silent where it has not.
