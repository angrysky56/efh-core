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

## Tools (15)

`assert_claim` `get_claims` `link_claims` `get_audit_trail` ·
`verify_implication` `check_consistency` `find_counterexample` ·
`register_agent_state` `run_admm_cycle` `get_closure_status` `trigger_recovery`
`set_restriction_map` `reset_session` · `commit_claim` · `session_status`

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
      "args": ["/your-path-to/efh-core/dist/index.js"]
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
  reproduce; semantic mode needs new baselines).
- Unsat cores as proof artifacts (named assertions).
- FTS5 claim search.
- Prover9 ↔ Z3 cross-checks on the EFHF axiom set.

## References

- Rosas et al., "Software in the natural world," arXiv:2402.09090
- Besta et al., "Graph of Thoughts," AAAI 2024
- Hall, T.B., EFHF / Paraclete Protocol / Persistence Theory (project docs)
