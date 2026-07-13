---
name: got-patterns
description: Structured reasoning patterns — chain of thought, tree of thoughts, graph of thoughts, iterative refinement — executed by the host agent with scoring, pruning, and merging discipline. Use for elaborate problems that benefit from exploring multiple candidate solutions, decompose-solve-recombine workflows, or when the user mentions graph of thoughts, tree of thoughts, or reasoning patterns.
---

# Graph-of-Thoughts Patterns (host-agent procedure)

You are the reasoner; these are disciplines, not tools. (Based on Besta et al., AAAI
2024.) Persist significant branches through efh-core for provenance.

## Pattern selection

- **Chain** — linear problems with reliable intermediate steps. Cheapest; use first.
- **Tree** — genuine branch points where alternatives must be compared before
  committing. Breadth 2–4, then prune.
- **Graph** — solutions require *merging* partial results (sorting/merging chunks,
  set operations, document fusion, multi-constraint design). Tree + aggregation edges.
- **Iterative refinement** — a full candidate exists; loop critique → revise until the
  score plateaus.

Escalate only when the cheaper pattern demonstrably fails: chain → tree → graph.

## Operations (the GoT vocabulary)

- **generate(k)** — k candidate thoughts from the current node. Diversity beats volume;
  k=2–4.
- **score** — rate each candidate 0–1 against explicit criteria *written before
  generating*. Score before expanding — never expand an unscored node.
- **keep-best(n)** — prune to the top n. Log what was pruned and why (one line each).
- **aggregate** — merge two+ partial solutions into one; check the merge preserves each
  input's constraints (this is where graph beats tree).
- **improve** — one targeted revision addressing the lowest-scoring criterion.
- **validate** — final check against original requirements, not against the path taken
  (path-dependence is how errors hide).

## Discipline

1. State scoring criteria before generating candidates.
2. Cap depth (≤4 without new information) and total nodes (≤12) — beyond this,
   information gain per node collapses.
3. Merges must be validated: aggregation is where contradictions sneak in. For factual
   branches, `check_consistency` on the merged claim set catches silent conflicts.
4. Record decisions in efh-core: branch conclusions worth keeping → `assert_claim`;
   merge provenance → `link_claims(merged, part, "derived_from")`; final answer goes
   through the efh-loop commit gate if it is a substantive claim.
5. When two branches contradict, that is signal, not noise — run the contradiction
   through the via-negativa skill rather than silently picking one.
