# Probe-Derived Confidence for the Reasoner Facet

**Status:** specification (architecture-paper-first; implementation follows validation of this design)
**Target:** local models feeding efh-core; conscience-servitor integration
**Basis:** Sarfati et al., "What LLM Forecasters Know but Don't Say" (Goodfire/Eternis, arXiv:2607.08046, 2026); FSM spec (probe-anchored substrate monitoring)

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
