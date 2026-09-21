# Formula-bound fidelity and translation review

Fidelity now uses controlled English generated from the formulas Z3 actually
parses. A caller cannot substitute a more convenient gloss. `gloss` remains an
optional audit note; neither the renderer nor the judgment prompt consumes it.

Commitment requires four checks: a successful proof of the latest formalization,
settled fidelity at the configured floor, a current translation review, and
KERNEL1. The translation check is mandatory even when `EFH_GATE_FIDELITY=off`.
The existing off switch skips only the numerical fidelity requirement.

## How the binding works

`parseProblem` accepts declarations and definitions followed by assertions, plus
one conjecture expression. A small lexical framer respects SMT comments, strings
and quoted symbols; it rejects solver-control commands and prevents a conjecture
from injecting additional assertions. It does not interpret formula semantics.

The framer packages the premises and goal into one `and` expression. Z3's
`ast_from_string` parses and type-checks it. The server verifies the packaging
shape, then uses those same child AST objects for both rendering and proving.
No second parser, textual rewrite, or naming fallback lies between them.
Definitions and `let` bindings are expanded by Z3. Rendering uses operator kinds
and bound-variable indices, preserving implication direction and quantifier
scope even when variable names are shadowed.

A separate premise-consistency check must return `sat`. Contradictory premises
can still produce a technically valid `proved` result, but cannot commit;
`unknown` consistency is also insufficient. Proof remains conditional on the
premises, and the generated text includes all of them, not just the unsat core.

This reuses the installed official `z3-solver` API. No package was added. The
[Z3 JavaScript guide](https://microsoft.github.io/z3guide/programming/Z3%20JavaScript%20Examples/)
describes assertion-based solving; the
[SMT-LIB standard](https://smt-lib.org/language.shtml) defines the language and
command semantics. Solver-control commands are excluded because they can change
which assertions are active; see [Z3 basic commands](https://microsoft.github.io/z3guide/docs/logic/basiccommands/).

## Supported subset

- Bool and uninterpreted sorts, constants, functions and predicates.
- `true`, `false`, `not`, `and`, inclusive `or`, implication, Boolean equivalence,
  binary exclusive-or, equality, and pairwise distinctness.
- Universal and existential quantification, including nested quantifiers and
  multi-variable binders. Rendered variable names are generated from binding
  positions, rather than copied from caller text.
- `declare-const`, `declare-fun`, `declare-sort`, `define-fun`, `define-sort`, and
  `assert`. Definitions may use `let`; only their expanded AST counts toward the
  supported subset. Comments and assertion annotations may be present.

Version 1 does not render arithmetic, arrays, bitvectors, strings, datatypes,
lambdas, conditional terms (`ite`), recursive definitions, or overloaded names.
Valid formulas with unsupported operators/sorts can still be explored with Z3;
`translation.status` is `unsupported`, and commitment is refused. Unsupported
commands are input errors. There is no manual-approval bypass for unsupported
translations in this version: extend and test the renderer first.

Names in rendered formulas must be simple ASCII identifiers, up to 64 characters.
The framer limits source length to 200,000 characters and nesting to 128 levels;
the renderer limits work to 2,000 visited nodes and depth 64. Exceeding a rendering
limit produces an unsupported result, never partial fidelity evidence.

## Symbol meanings

Supply `symbol_glossary` with a proposed meaning for every *used* symbol:

```json
{
  "committed": "the claim is committed",
  "proved": "the claim has a successful proof"
}
```

For functions and predicates, every argument must appear as a placeholder. For
example, `"respects": "{0} respects {1}"`. Uninterpreted sorts use keys such as
`"sort:Person": "people"`. Missing meanings block review/commitment; unused
entries and templates that omit arguments make the rendering unsupported.
Expanded-away definition names do not need glossary entries.

These are proposed meanings, not verified semantics. The renderer preserves
formula structure; an independent reviewer must check that symbol interpretations
are appropriate and that the claim does not conceal an assumption.

## Worked flow

For the claim “If a claim is committed and commitment requires a successful
proof, then that claim has a successful proof”, submit:

```json
{
  "claim_id": 1,
  "axioms": [
    "(declare-const proved Bool)",
    "(declare-const committed Bool)",
    "(assert committed)",
    "(assert (=> committed proved))"
  ],
  "conjecture": "proved",
  "symbol_glossary": {
    "committed": "the claim is committed",
    "proved": "the claim has a successful proof"
  }
}
```

The generated text states the two assumptions and the conclusion. Both
`verify_implication` and `find_counterexample` store the same kind of translation
artifact. `get_formalizations` returns its ID and current review status.

An independent operator inspects that exact artifact, using the actual ledger
path and formalization ID:

```sh
npm run build
node dist/review-cli.js inspect --db /path/to/ledger.sqlite --id 1 > packet.json
```

Inspect the claim, raw inputs, canonical formulas, generated statement, symbol
signatures/meanings, premise-consistency result, and fidelity evidence. Copy the
`review_template` object into `review.json` and complete:

- `reviewer`: attribution for the person or independent reviewing process.
- `symbols[].grounding`: why each symbol/sort has the stated interpretation.
- `premises[].justification`: evidence for each premise, or where the claim
  explicitly makes that premise a condition. Assuming the desired conclusion
  cannot justify presenting it as an unconditional established fact.
- `claim_scope`: explain why the English claim has the appropriate conditional
  scope and does not assert more than the proof establishes.
- `decision`: `approved` or `rejected`, after reviewing the artifact.

Keep `formalization_id` and `digest` unchanged. Then record the review:

```sh
node dist/review-cli.js record --db /path/to/ledger.sqlite --file review.json
```

The CLI requires an explicit existing database path. It never creates or migrates
a ledger, and inspection opens it read-only. No model-facing MCP tool records
reviews. The authoring agent must not fill in an “independent” approval itself;
the review request needs an actual separate assessment. A reviewer may use the
same process to reject a previously approved artifact. Rejection removes its
current commitment while retaining the proof and prior audit entries.

Once reviewed, `commit_claim` still checks fidelity, proof and KERNEL1. Review
alone cannot overcome a failed judgment or proof.

## Persistence and invalidation

The `formalizations.translation` JSON includes the renderer revision, raw-input
digest, canonical premises/goal, generated text, symbol meanings, missing meanings
and premise-consistency result. `translation_reviews` holds the reviewer,
decision, complete review evidence, artifact digest and timestamp. Review actions
are also written to the existing audit trail; commit outcomes identify the
formalization and review used.

The review digest binds the claim text and exact stored formalization, including
formulas, strengthening declarations, translation, proof result and fidelity
provenance. Changed evidence, a changed claim, a changed renderer revision, or a
new verification requires a new review. A stale review file cannot approve a
new artifact. Disabling fidelity scoring does not bypass translation checks.

Migration is additive. Old evidence and historical commitments are preserved;
old rows have no invented translation or review. New commit attempts require
current evidence. Reload/restart the MCP server after rebuilding to use this
policy. Do not infer that historical committed rows satisfy the new checks.

## Trust boundary and verification

Review is an attributed local attestation. It does not prove real-world premises,
authenticate reviewer independence, or defend against an actor who can directly
modify the ledger or program. Local filesystem access remains trusted. Jev also
remains fallible; the default 0.6 floor is not newly calibrated by this repair.
Embeddings retain their documented inability to discriminate some logical changes.

Verification commands:

```sh
npm run build
npm run smoke
npm test
EFH_JUDGE=jev node experiments/fidelity-probe/gate-e2e.mjs
```

The automated suite exercises the actual Z3 renderer, stdio MCP, local review
CLI, migrations, stale/rejected reviews, copied-gloss bypass, formula injection,
quantifier binding, unsupported theories, and inconsistent premises. All tests
use scratch ledgers. Test reviews are explicitly synthetic attestations, not
independent validation of real claims.

A live TypeSafe run on 2026-09-21 returned:

| Case | Z3 | Fidelity | Post-review commit |
| --- | --- | --- | --- |
| Matching formulas | proved | 0.71, five samples 0.65–0.74 | accepted |
| Reversed formulas with the copied gloss | proved | 0.18, one sample | refused |
| Matching formulas with an unrelated caller note | proved | 0.71, cached same comparison | accepted |

Every case refused before its synthetic fixture review. The scratch directory
was removed afterward. This is a functional integration check, not threshold
calibration or independent validation of the model.
