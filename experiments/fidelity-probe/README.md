# Fidelity probe: embedding similarity vs typed judgment

## Question

`tools.ts` measures formalization fidelity as `1 − embedding cosine distance`
between a claim and the gloss of its formalization, and warns below
`EFH_FIDELITY_MIN` (0.6). Embedding similarity measures topical overlap. The
two ways a formalization actually goes wrong — negation and quantifier scope —
barely move topical overlap. Does the production measure separate faithful
formalizations from unfaithful ones, and does a typed judgment do better?

## Method

`pairs.json` holds 18 (claim, gloss) pairs: 6 faithful, 12 unfaithful, each
labelled and categorised **before** any measurement. The faithful set includes
a contrapositive and a De Morgan rewrite — equivalent but lexically distant,
which should trip a similarity measure in the *rejecting* direction. The
unfaithful set includes negation, quantifier swap, weakening, strengthening,
converse, inverse, added antecedent, necessary-vs-sufficient, negation scope,
and modality — wrong but lexically near, which should trip it in the
*accepting* direction. One unrelated pair is a sanity control.

Both measures are read at the same operating point, 0.6.

- **Incumbent**: `embed-baseline.mjs` uses this repo's own `Embedder` against
  the live Ollama model, in a scratch database. It touches no claim ledger.
- **Challenger**: the `formalization_fidelity` capability on the jev-mcp
  server — one `choice` naming the relation, one `noul` asking whether the two
  hold in exactly the same situations. Results in `jev-results.json`.

Kill criterion, declared in advance: if the judgment does not beat the
embedding measure on the negation and scope pairs, it is not worth adding.

## Result

At the production threshold of 0.6: **embedding 7/18, Jev 18/18.**

| | faithful accepted | unfaithful rejected |
| --- | --- | --- |
| embedding (`nomic-embed-text`) | 6/6 | 1/12 |
| Jev (`jev-1.13.0`) | 6/6 | 12/12 |

The embedding measure rejected exactly one unfaithful pair: the unrelated
control, at 0.422. Every other wrong formalization scored 0.83–0.98 and would
pass the gate. It never rejected a faithful pair, so it is not noisy — it is
blind to logical form and discriminates on topic alone. Both directions of the
test confirm this: the contrapositive and De Morgan rewrites (lexically
distant, logically identical) passed at 0.95 and 0.76, and the near-miss
rewrites (lexically identical, logically wrong) passed just as easily.

The sharpest single case is `p15`. "A successful proof is **necessary** for a
commit" against "a successful proof is **sufficient** for a commit" scored
**0.9796** — the highest fidelity in the entire set — while inverting the
semantics of this project's own commit gate. Jev scored it 0.06 and named the
relation `scope_differs`.

Jev's faithful pairs scored 0.77–0.98, unfaithful 0.03–0.53. Nothing landed
between 0.53 and 0.77, so the 0.6 operating point sits in an empty band rather
than on a crowded boundary.

One pair split Jev's two questions. On `p13` (inverse: "if not expired, not
rejected") the `choice` answered `equivalent` at 0.86 confidence — wrong, it is
the inverse fallacy — while the `noul` answered 0.53 and the gate refused it.
The numeric question caught what the labelling question missed, and 0.53 is
also the closest any unfaithful pair came to passing.

That suggests a use for the disagreement itself: when the relation says
`equivalent` but the truth-condition score sits near the threshold, the pair is
a hard case and belongs in front of the prover or a person, not through a gate.
Disagreement between two views of one question is information, which is the
principle the enforcer already applies across facets.

## Run the baseline

Ollama must be reachable, so this runs on the machine hosting it:

```sh
node experiments/fidelity-probe/embed-baseline.mjs
```

It writes `embedding-results.json` and `comparison.json`, and prints the
head-to-head table.

## End to end through the gate

`gate-e2e.mjs` drives the real MCP surface: one claim, one set of axioms, one Z3
proof, two glosses. Z3 returns `proved` both times.

```
PASS faithful:   proof=proved fidelity=0.69 (judgment, equivalent)     committed=true
PASS unfaithful: proof=proved fidelity=0.15 (judgment, scope_differs)  committed=false
```

The unfaithful gloss swaps a necessary condition for a sufficient one — the same
inversion the embedding channel rated 0.9796. Before the fidelity leg existed,
both of these committed on the strength of the same sound proof.

Two observations worth keeping rather than smoothing over. The faithful gloss
scored 0.69 and 0.61 on two runs of the same pair: real glosses land far closer
to the 0.6 floor than the 0.77–0.98 of the authored set, so the margin is
thinner than the probe suggests, and the floor deserves calibration against
glosses collected from real sessions. The judgment also varies run to run, so a
number near the floor should be treated as near the floor, not as a verdict.

## Limits

Eighteen authored pairs, written by the same agent that ran the challenger,
in textbook logical forms rather than real formalization glosses from live
sessions. It establishes a separation on this set, not a general accuracy
claim, and it is not a blind comparison. Jev's documented weakness on nested
quantifiers is not stressed here beyond a single scope pair. Any adoption
should be re-measured on glosses drawn from actual runs.
