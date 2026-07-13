/**
 * Calibration harness for the semantic channel.
 *
 * Measures embedding cosine distances for three pair classes:
 *   paraphrase     — same proposition, different words (should read as "same claim")
 *   contradiction  — same topic, opposite truth value
 *   unrelated      — different topic entirely
 *
 * Prints distributions, the implied coboundary contribution (d/√3 when the
 * two scalar keys agree), and a data-driven epsilon_primal suggestion.
 *
 * Known limitation this harness EXPECTS to reveal: embeddings measure topical
 * similarity, not truth-functional agreement — contradictions often sit close
 * to paraphrases. That is acceptable by design: in the enforcer, the semantic
 * channel answers "are the facets talking about the same proposition?", while
 * disagreement about truth rides on the scalar channels (confidence, flags).
 * Read the paraphrase-vs-UNRELATED gap for claim identity, and treat any
 * paraphrase-vs-contradiction overlap as confirmation that truth-tracking
 * belongs to the scalar channels, not as a failure of the embedding model.
 *
 * Requires Ollama with the embedding model pulled. Fails loudly otherwise.
 * Run: npm run build && npm run calibrate
 */

import { openDb } from "../dist/db.js";
import { Embedder } from "../dist/embeddings.js";

const PARAPHRASE = [
  ["Strict order on the integers is transitive", "For integers, if a is less than b and b is less than c, then a is less than c"],
  ["Water boils at 100 degrees Celsius at sea level", "At standard atmospheric pressure, water reaches its boiling point at 100 degrees C"],
  ["Every even number greater than two is the sum of two primes", "All even integers above 2 can be written as the sum of two prime numbers"],
  ["The system maintains coherence across all registered agents", "All registered agents remain mutually consistent within the system"],
  ["Hallucination is a failure of consistency between belief and verification", "When belief diverges from what can be verified, the model hallucinates"],
  ["The cat is on the mat", "A cat is sitting on the mat"],
  ["Increasing verification frequency reduces committed errors", "More frequent verification lowers the rate of erroneous commits"],
  ["The proof was completed in under one second", "It took less than a second to finish the proof"],
  ["No positive integers satisfy x^3 + y^3 = z^3", "The equation x cubed plus y cubed equals z cubed has no solution in positive integers"],
  ["Entropy never decreases in an isolated system", "In an isolated system, entropy can only stay constant or increase"],
  ["The gate refuses commits when closure status is not KERNEL1", "Commits are blocked by the gate unless the system is in KERNEL1"],
  ["Dual variables accumulate inconsistency pressure over time", "Inconsistency pressure builds up in the dual variables across cycles"],
];

const CONTRADICTION = [
  ["Strict order on the integers is transitive", "Strict order on the integers is not transitive"],
  ["Water boils at 100 degrees Celsius at sea level", "Water never boils at 100 degrees Celsius at sea level"],
  ["The equation has a solution in positive integers", "The equation has no solution in positive integers"],
  ["The system is in KERNEL1", "The system has collapsed to KERNEL2"],
  ["The claim was proved by the verifier", "The claim was refuted by the verifier"],
  ["The cat is on the mat", "The mat is empty; there is no cat on it"],
  ["Entropy never decreases in an isolated system", "Entropy spontaneously decreases in isolated systems"],
  ["All agents agree on the shared edge space", "The agents fundamentally disagree on the shared edge space"],
  ["Verification increases the reliability of commits", "Verification has no effect on the reliability of commits"],
  ["The proof is valid relative to the axioms", "The proof does not follow from the axioms"],
  ["x is strictly greater than y", "x is strictly less than y"],
  ["The function converges for all inputs", "The function diverges for some inputs"],
];

const UNRELATED = [
  ["Strict order on the integers is transitive", "The Amazon rainforest produces a large share of atmospheric oxygen"],
  ["The cat is on the mat", "Interest rates were raised by the central bank"],
  ["Water boils at 100 degrees Celsius", "The violin section entered two bars late"],
  ["Dual variables accumulate pressure", "The recipe calls for two cups of flour"],
  ["The gate refused the commit", "Migratory birds navigate using the magnetic field"],
  ["Z3 returned unknown", "The bridge was painted green last summer"],
  ["The axioms are consistent", "She parked the car behind the bakery"],
  ["Coherence dropped to WEAK", "Photosynthesis converts light into chemical energy"],
];

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, min: s[0], q25: q(0.25), median: q(0.5), mean, q75: q(0.75), max: s[s.length - 1] };
}

const fmt = (x) => x.toFixed(3);
const row = (name, st) =>
  console.log(
    `${name.padEnd(14)} n=${st.n}  min=${fmt(st.min)}  q25=${fmt(st.q25)}  med=${fmt(st.median)}  mean=${fmt(st.mean)}  q75=${fmt(st.q75)}  max=${fmt(st.max)}`,
  );

const db = openDb();
const embedder = new Embedder(db);

const probe = await embedder.probe();
if (!probe.reachable) {
  console.error(`Ollama unreachable at ${probe.host} — start it and pull ${probe.model}. No calibration without data.`);
  process.exit(1);
}
console.log(`Embedding model: ${probe.model} @ ${probe.host}\n`);

async function measure(pairs) {
  const out = [];
  for (const [a, b] of pairs) out.push(await embedder.distance(a, b));
  return out;
}

const para = await measure(PARAPHRASE);
const contra = await measure(CONTRADICTION);
const unrel = await measure(UNRELATED);

console.log("Raw embedding cosine distances:");
const pStats = stats(para);
const cStats = stats(contra);
const uStats = stats(unrel);
row("paraphrase", pStats);
row("contradiction", cStats);
row("unrelated", uStats);

const toCb = (d) => d / Math.sqrt(3);
console.log("\nImplied coboundary contribution (d/√3, scalar keys agreeing):");
row("paraphrase", stats(para.map(toCb)));
row("contradiction", stats(contra.map(toCb)));
row("unrelated", stats(unrel.map(toCb)));

console.log("\nInterpretation:");
console.log(`- Claim identity: paraphrase max cb = ${fmt(toCb(pStats.max))}, unrelated min cb = ${fmt(toCb(uStats.min))}.`);
if (toCb(pStats.max) < toCb(uStats.min)) {
  const suggested = (toCb(pStats.max) + toCb(uStats.min)) / 2;
  console.log(`  Clean separation. Suggested epsilon_primal for semantic-dominated edges: ~${fmt(suggested)}`);
} else {
  console.log("  Distributions overlap — inspect the offending pairs before choosing a threshold.");
}
console.log(`- Paraphrase vs contradiction gap: ${fmt(toCb(cStats.median) - toCb(pStats.median))} (median cb).`);
console.log("  If small, truth disagreement is NOT reliably visible in the text channel —");
console.log("  by design it rides on the scalar channels (proof_confidence, flags).");
console.log(`\nCurrent default epsilon_primal: 0.15. n is small; treat suggestions as starting points.`);

db.close();
process.exit(0);
