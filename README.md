# efh-core

A verification workbench for AI reasoning. One MCP server plus four skills that
separate what an AI model *says* from what the system *accepts as known*.

## The idea

AI language models are fluent, fast, and confident — and none of those
qualities has anything to do with being right. A model cannot reliably tell,
from the inside, when it is wrong: its confidence is part of the same process
that produced the error. Asking a model to double-check itself is asking the
suspect to run the investigation.

EFH (Emergent Functional Hierarchies) approaches this structurally instead of
hopefully. The model keeps its role as an idea generator, but nothing it says
becomes *knowledge* until it passes through machinery the model does not
control:

1. **A claim ledger.** Every substantive statement is written down as an
   explicit claim with a confidence score — outside the model, in a database,
   where it can be examined, linked to other claims, and audited later.
2. **A prover.** Claims that can be stated formally are handed to a theorem
   prover (Z3), which returns *proved*, *refuted with a counterexample*, or an
   honest *can't tell* — never a vibe.
3. **A consistency monitor.** Three perspectives are tracked continuously —
   what the model believes, what the prover established, and what the model is
   currently arguing. When they drift apart, an alarm escalates through
   graded levels (think green → yellow → orange → red) before the
   inconsistency can contaminate anything.
4. **A gate.** A claim is committed to the knowledge base only when three
   conditions hold at once: the proof succeeded, confidence is high, and the
   monitor shows green. A refusal is not an error — it is the system working.

Everything is recorded. Every assertion, proof, refusal, and recovery lands in
an audit trail, so "how do we know this?" always has a checkable answer.

The four bundled skills are reasoning playbooks the AI follows while using the
server: the core operating loop, a hypothesis-elimination method (via
negativa), structured branching patterns (graph of thoughts), and a pre-response
ethical triage.

## Use cases

- **Research assistant that can't quietly make things up.** Findings accumulate
  as verified, audited claims instead of chat scrollback.
- **Auditing AI reasoning.** The trail shows which axioms carried each proof,
  which commits were refused and why, and where the model's confidence outran
  its verification.
- **Formal checking of arguments.** Encode an argument's premises, ask whether
  the conclusion follows, get a proof or a concrete counterexample.
- **Multi-agent consistency.** Any number of agents can register their states;
  the monitor detects when they contradict each other — including circular,
  three-way contradictions no pair reveals.
- **A base layer for AI-epistemics experiments.** Calibration, probing, and
  self-correction research plug into the same claim/verify/commit spine.

## Requirements

- **Node.js ≥ 20** and npm (the server is TypeScript; Z3 runs in-process via
  WebAssembly — no solver install needed).
- **Optional — Ollama** with an embedding model (default `nomic-embed-text`)
  for the semantic channel, which lets the monitor recognize that two
  differently-worded statements are the same claim. Without it, set
  `EFH_SEMANTIC=off`; the system falls back to exact-match comparison and says
  so in every report.
- **Optional — Prover9/Mace4** (LADR) as an alternative proof backend.
- **Optional — Isabelle** for the kernel-checked proof layer in `isabelle/`.
- Any MCP client: Claude Desktop, Cowork, Claude Code, or anything speaking
  the Model Context Protocol.

## Quick start

```bash
git clone <this repo> && cd efh-core
npm install --include=dev
npm run build
npm run smoke        # 25+ checks, all should PASS
```

Add to your MCP client config:

```json
{
  "mcpServers": {
    "efh-core": {
      "command": "node",
      "args": ["/path/to/efh-core/dist/index.js"]
    }
  }
}
```

Install the skills (Claude Code / Cowork):

```bash
cp -r skills/* ~/.claude/skills/
```

First session, in plain terms:

```
reset_session(confirm: true)                        # clean slate
assert_claim("if a<b and b<c then a<c", 0.95)       # claim #1 enters the ledger
verify_implication(axioms..., "(< a c)", claim_id:1) # Z3: proved, in milliseconds
register_agent_state("reasoner", {...})              # tell the monitor your view
run_admm_cycle()                                     # monitor: green (KERNEL1)
commit_claim(1, 0.95)                                # gate: committed
get_audit_trail()                                    # the whole story, timestamped
```

Try to commit something the prover refuted, or commit while the monitor shows
yellow, and the gate refuses with the reason spelled out.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `EFH_DB_PATH` | SQLite location | `~/.local/share/efh-core/efh.db` |
| `EFH_SEMANTIC` | `on` / `off` — semantic comparison channel | `on` |
| `OLLAMA_HOST` | embedding endpoint | `http://localhost:11434` |
| `EFH_EMBED_MODEL` | embedding model | `nomic-embed-text` |
| `EFH_COMMIT_MIN_CONFIDENCE` | gate threshold | `0.7` |
| `EFH_FIDELITY_MIN` | formalization-fidelity warning threshold | `0.6` |
| `EFH_EPSILON_PRIMAL` | monitor escalation threshold | `0.15` |
| `EFH_DUAL_WARNING` | monitor pressure threshold | `5.0` |
| `EFH_Z3_TIMEOUT_MS` | prover timeout per check | `15000` |
| `PROVER9_PATH` / `MACE4_PATH` | optional LADR binaries | from PATH |

## Going deeper

Architecture, tool reference, the mathematics of the consistency monitor,
soundness rules, the kernel-checked Isabelle layer, measured calibration data,
and next steps all live in **[docs/DEVELOPERS.md](docs/DEVELOPERS.md)**.

## References

- Rosas et al., "Software in the natural world," arXiv:2402.09090
- Besta et al., "Graph of Thoughts," AAAI 2024
- Hall, T.B., EFHF / Paraclete Protocol / Persistence Theory (project docs)

## License

Research software. Theoretical frameworks referenced are attributed to their
respective authors.
