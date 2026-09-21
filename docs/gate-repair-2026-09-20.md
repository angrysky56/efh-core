# Gate repair follow-up — 2026-09-20

This follow-up repairs the implementation defects found in the second review.
It preserves the 0.6 default fidelity floor, the separate opt-in for judgment in
the consistency monitor, and the decision to record self-reported confidence
without making it a commit condition.

## Changes

- The CLI loads its project `.env` before importing local runtime modules.
  A shared, validated configuration snapshot drives the judge, commit gate,
  status report, embeddings, and prover timeouts. Shell values retain precedence.
  Invalid gate/sampling settings fail before the ledger is opened. Node's
  `process.loadEnvFile` is available from 20.12; the package's minimum Node
  requirement now reflects that. [Node documentation](https://nodejs.org/api/process.html#processloadenvfilepath).
- Decisions use unrounded scores and persist an explicit result. Crossing the
  floor, a relation/score conflict in any draw, or mixed resolved model builds
  yields `unsettled`, which refuses a commit. A high median cannot override it.
- Formalizations retain requested/resolved model identities, provider, question
  hash, policy revision, decision boundary, sampling settings, and individual
  draws. Commit audit entries link the exact formalization and include its
  decision and provenance. Missing resolved-model metadata fails measurement.
- Old rows are preserved with NULL for unavailable metadata. A new commit using
  an old undecided row, or evidence evaluated at a different floor/policy, asks
  for a new verification. Existing committed records are not rewritten.
- `gate-e2e.mjs` allocates and cleans its own unique scratch database, overriding
  inherited and `.env` database paths. The caller cannot accidentally direct the
  experiment into the normal ledger.
- In the separate jev-mcp repository, both inquiry and continuity study runners
  share the evaluation-model guard. Continuity accepts `--model`. Dry and live
  evaluation runs reject floating aliases before files or requests are created;
  development runs retain their latest-model default. Concrete versions are
  required for reproducible comparisons. [OpenRouter documentation](https://openrouter.ai/docs/guides/routing/routers/latest-resolution).

## Assurance boundary

The formula-to-gloss link is still not mechanically verified. The server
compares the supplied English gloss with the claim; a correct score does not
establish that the gloss describes the submitted axioms/conjecture. Documentation
and tool outputs now identify this trust assumption explicitly, including on
successful commits. A parser-backed rendering for a supported formula subset or
a separately reviewed translation workflow would be additional work, not a
capability provided by this patch.

Jev's separate questions are not guaranteed to agree. The gate's response to
disagreement is a conservative application policy, not a claim that the provider
violates a probabilistic identity. [TypeSafe documentation](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

Reported-confidence summaries are descriptive counts, not measured calibration.
They now explicitly report `calibration_available: false`. A refuted or replaced
encoding is a review candidate, not automatically a fidelity label; evaluating
ECE requires independent correctness labels. The threshold remains uncalibrated.

## Verification

Run efh-core checks with:

```sh
npm run build
npm run smoke
npm test
```

The regression suite uses real stdio MCP calls and Z3 with controlled provider
responses and isolated databases. It covers `.env` initialization and shell
precedence, rounding across the floor, split answers, minority conflicting draws,
mixed model versions, provider failure/malformed metadata, persistence and audit
linkage, changed-floor rejection, additive migration, and experiment cleanup on
success and failure. The test run makes no live vendor inference requests.

Verified after repair: the build/typecheck, all 49 smoke checks, and all 14 gate
regression tests passed. The separate jev-mcp typecheck and all 35 tests passed.

A separate live TypeSafe check also passed using the experiment's automatically
allocated scratch database: the faithful gloss scored 0.67 across five samples
(spread 0.66–0.69) and committed; the unfaithful gloss scored 0.13 in one sample
and was refused. Both Z3 proofs succeeded. These are two integration examples,
not additional independent calibration data. The temporary database was removed.

In jev-mcp, run `npm run check && npm test`. The continuity regression checks both
providers, dry/live alias rejection before writes or calls, concrete-model request
propagation, and preservation of the development alias.

No live claim ledger was opened or migrated during repair. The built efh-core
entry point is updated; an already running MCP process needs a restart to load
the new code. Startup then applies the additive schema migration normally.
