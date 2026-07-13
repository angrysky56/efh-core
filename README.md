# efh-core

One TypeScript MCP server + four skills, consolidating the EFHF multi-server stack.

**Design rule:** a server holds only what needs computation and persistence — state,
deterministic verification, local model inference. Reasoning patterns are skills executed
by the host agent. Most of the retired stack was prompt-level reasoning wearing a server
costume; this is why the old architecture was brittle (N processes, N schemas,
restriction maps hard-coupled to server identities that drift).

## What it absorbs

| Retired / absorbed | Into |
|---|---|
| sheaf-consistency-enforcer (Python) | `src/enforcer/` — faithful ADMM port + semantic channel |
| mcp-logic (Prover9/Mace4 wrapper) | Z3 WASM in-process; optional Prover9/Mace4 shell-out |
| hipai-montague (storage role) | SQLite claim store with belief scores + provenance links |
| verifier-graph (provenance) | audit trail + claim links |
| wisdom-engine | `skills/via-negativa` (host agent executes; no second LLM) |
| graph-of-thoughts-mcp | `skills/got-patterns` |
| conscience-servitor (triage rubric) | `skills/ethical-triage` (GPU/FSM research stays Python, separate) |
| EFHF agent-instructions | `skills/efh-loop` |

## Honest labeling

The enforcer measures **cross-verifier coherence**: agreement between registered agent
states projected onto shared edge spaces. It does not measure lumpability of any
underlying model's dynamics — that identification is a research hypothesis, and the
status names (KERNEL1, WEAK, …) are retained as shorthand for coherence regimes.
Prover results are valid relative to supplied axioms. This framing is deliberate;
see the EFHF critique session, 2026-07-12.

## Architecture

```
skills (host agent)                    efh-core server (one process)
  efh-loop ─ operating loop      ┌── claim store ── SQLite: claims, links, audit
  via-negativa ─ subtraction ────┤── verifier ──── Z3 (WASM, lazy) | Prover9/Mace4 (optional)
  got-patterns ─ branch/merge    │── enforcer ──── ADMM cycles, H¹ detection, recovery
  ethical-triage ─ Paraclete ────┘── gate ──────── commit ⇔ pc≥0.7 ∧ conf≥0.7 ∧ KERNEL1
```

Internal facets `world-model` and `verifier` are auto-registered by the tools themselves;
the host agent registers as `reasoner`. Default restriction maps target these internal
channels, so they cannot drift out of sync with tool outputs. External agents remain
first-class via `register_agent_state` + `set_restriction_map`.

The semantic channel upgrades string comparison from SHA-256 identical-or-nothing to
graded embedding cosine distance (paraphrases no longer register as full disagreement).
Hash mode remains default per mapping; `compare: "semantic"` opts in (used by the
default `edge_claim` channels).

## Tools (16)

`assert_claim` `get_claims` `link_claims` `get_audit_trail` `get_formalizations` ·
`verify_implication` `check_consistency` `find_counterexample` ·
`register_agent_state` `run_admm_cycle` `get_closure_status` `trigger_recovery`
`set_restriction_map` `reset_session` · `commit_claim` · `session_status`

### Formalization fidelity (v0.2)

The weakest link in the loop is the translation from claim text to SMT-LIB — a bad
encoding gets "proved" and the gate would stamp verified nonsense. Every claim-bound
verification is therefore persisted as a reviewable formalization (axioms, conjecture,
result), and the verify tools accept a `gloss`: an independent English rendering of what
the encoding literally says. The server measures `fidelity` = 1 − embedding distance
(claim text vs gloss) and warns below `EFH_FIDELITY_MIN`. Reported, not gated — thresholds
come from calibration data, not intuition.

### Unsat cores (v0.2)

Z3 assertions are auto-named; `proved`/`unsat` results return `unsat_core` — the asserted
lines that carried the proof. A core that omits an "essential" axiom signals a possibly
vacuous proof; `check_consistency` cores pinpoint which statements contradict.

### Interpretation loop + soundness cap (v0.3)

On `unknown`, the host agent may propose concrete interpretations for
uninterpreted functions or add bounds (AquaForte-style CEGAR, with the agent as
the LLM-in-the-loop and `get_formalizations` as the exclusion memory). Such
encodings are declared via `strengthenings` on the verify tools. The logical
asymmetry is enforced: models and refutations under strengthening remain fully
sound (original axioms still asserted); proofs become interpretation-relative
and are capped at pc 0.6 — below the commit gate. See the efh-loop skill.

### Calibration (v0.2)

`npm run calibrate` measures embedding-distance distributions for paraphrase /
contradiction / unrelated pairs and suggests a data-driven `epsilon_primal` for
semantic-mode edges. Expected finding: embeddings track claim *identity* (paraphrase vs
unrelated separates cleanly), not truth agreement — contradiction detection rides on the
scalar channels by design.

## Install

```bash
npm install && npm run build && npm run smoke
```

Client config:

```json
{
  "mcpServers": {
    "efh-core": {
      "command": "node",
      "args": ["/home/ty/Repositories/ai_workspace/efh-core/dist/index.js"]
    }
  }
}
```

Skills: copy `skills/*` into `~/.claude/skills/` (canonical copies live in this repo).

## Configuration (env)

| Variable | Purpose | Default |
|---|---|---|
| `EFH_DB_PATH` | SQLite location | `~/.local/share/efh-core/efh.db` |
| `EFH_SEMANTIC` | `on` / `off` — semantic channel (off = hash fallback, always reported, never silent) | `on` |
| `OLLAMA_HOST` | embedding endpoint | `http://localhost:11434` |
| `EFH_EMBED_MODEL` | embedding model | `nomic-embed-text` |
| `EFH_COMMIT_MIN_CONFIDENCE` | gate threshold | `0.7` |
| `EFH_FIDELITY_MIN` | formalization-fidelity warning threshold | `0.6` |
| `EFH_EPSILON_PRIMAL` | coboundary escalation threshold (calibrate first) | `0.15` |
| `EFH_DUAL_WARNING` | dual-pressure WARNING threshold | `5.0` |
| `EFH_Z3_TIMEOUT_MS` | Z3 per-check timeout | `15000` |
| `EFH_PROVER9_TIMEOUT_S` | LADR max_seconds | `30` |
| `PROVER9_PATH` / `MACE4_PATH` | LADR binaries | resolved from PATH |

Fail-loud policy throughout: a check that did not run never counts as a check that
passed. Z3 `unknown` is reported as not-a-pass; missing Ollama with semantics on is an
error with remedies, not a silent fallback.

## Enforcer semantics (preserved from the Python original)

Calibrated defaults unchanged: `epsilon_primal 0.15`, `dual_decay_rate 0.15` (leaky
integrator), `dual_warning_threshold 5.0`, H¹ 3-cycle threshold `1.5×`, 50-sample
residual windows, escalate-only status with recovery as the sanctioned de-escalation
path, SHA-256 string hashing for cross-process stability. Empirical baselines from
`sheaf-consistency-enforcer/docs` (2026-03-14) apply to hash-mode edges; semantic-mode
baselines need to be re-established.

## Roadmap

- Re-run the 2026-03-14 enforcer baseline procedure against this port (hash mode should
  reproduce; semantic mode: start from `npm run calibrate`).
- FTS5 claim search.
- Prover9 ↔ Z3 cross-checks on the EFHF axiom set.
- If HOL statements ever appear: Isabelle as an optional external backend via the
  existing backend seam (until then, Vampire/E via TPTP is the lighter FOL upgrade).

## References

- Rosas et al., "Software in the natural world," arXiv:2402.09090
- Besta et al., "Graph of Thoughts," AAAI 2024
- Hall, T.B., EFHF / Paraclete Protocol / Persistence Theory (project docs)
