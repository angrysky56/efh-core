/** Real Z3 tests for formula binding, scope, and the supported rendering boundary. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {z3VerifyImplication, z3FindCounterexample} from '../dist/verifier.js';

test('renders the actual premises and goal, with definition and let expansion', async () => {
  const r = await z3VerifyImplication([
    '(declare-const p Bool) (declare-const q Bool)',
    '(define-fun rule () Bool (=> p q))',
    '(assert (! p :named first)) ; preserved semantics', '(assert rule)',
  ], '(let ((answer q)) answer)', {p: 'a claim is committed', q: 'a proof exists'});
  assert.equal(r.result, 'proved', r.detail);
  assert.equal(r.translation.status, 'supported', r.translation.reason);
  assert.equal(r.translation.premise_consistency, 'sat');
  assert.deepEqual(r.translation.canonical_axioms, ['p', '(=> p q)']);
  assert.equal(r.translation.canonical_conjecture, 'q');
  assert.equal(r.translation.generated_gloss,
    'If all of the following assumptions hold: (a claim is committed); (if (a claim is committed), then (a proof exists)); then (a proof exists).');
  assert.equal(r.unsat_core.length, 2);
});

test('quantifier binding survives nesting, shadowed variable names, and multi-variable binders', async () => {
  const axioms = ['(declare-sort Person 0)', '(declare-fun R (Person Person) Bool)'];
  const glossary = {'sort:Person': 'people', R: '{0} respects {1}'};
  const first = await z3VerifyImplication(axioms, '(forall ((x Person)) (exists ((y Person)) (R x y)))', glossary);
  const reverse = await z3VerifyImplication(axioms, '(exists ((x Person)) (forall ((y Person)) (R x y)))', glossary);
  assert.equal(first.translation.conclusion, '(for every v1 in people: (there exists v2 in people: (v1 respects v2)))');
  assert.equal(reverse.translation.conclusion, '(there exists v1 in people: (for every v2 in people: (v1 respects v2)))');
  const shadow = await z3VerifyImplication(axioms, '(forall ((x Person)) (exists ((x Person)) (R x x)))', glossary);
  assert.equal(shadow.translation.conclusion, '(for every v1 in people: (there exists v2 in people: (v2 respects v2)))');
  const multi = await z3VerifyImplication(axioms, '(forall ((x Person) (y Person)) (R x y))', glossary);
  assert.equal(multi.translation.conclusion, '(for every v1 in people, v2 in people: (v1 respects v2))');
});

test('negation, implication direction, equivalence and distinctness stay explicit', async () => {
  const axioms = ['(declare-const p Bool)', '(declare-const q Bool)'];
  for (const [goal, expected] of [
    ['(not p)', '(not (P))'], ['(=> p q)', '(if (P), then (Q))'],
    ['(=> q p)', '(if (Q), then (P))'], ['(= p q)', '((P) if and only if (Q))'],
    ['(and p (or p (not q)))', '((P) and ((P) or (not (Q))))'],
    ['(distinct p q)', '(all of these are pairwise distinct: (P); (Q))'],
    ['(xor p q)', '((P) or, but not both, (Q))'],
  ]) {
    const r = await z3VerifyImplication(axioms, goal, goal.includes('q') ? {p:'P', q:'Q'} : {p:'P'});
    assert.equal(r.translation.conclusion, expected, r.detail);
  }
});

test('valid unsupported theories still prove but have no generated fidelity text', async () => {
  const r = await z3VerifyImplication(['(declare-const n Int)', '(assert (> n 2))'], '(> n 1)');
  assert.equal(r.result, 'proved');
  assert.equal(r.translation.status, 'unsupported');
  assert.equal(r.translation.generated_gloss, null);
});

test('script injection and unsupported solver commands cannot replace the intended goal', async () => {
  for (const [axioms, goal] of [
    [['(declare-const p Bool)'], 'p) (assert false) (assert (true'],
    [['(declare-const p Bool)', '(assert p q)'], 'p'],
    [['(declare-const p Bool)', '(assert p)', '(reset-assertions)'], 'p'],
    [['(push 1)', '(assert false)', '(pop 1)'], 'true'],
    [['(set-option :timeout 0)'], 'true'],
    [['(assert true)', '(declare-const p Bool)'], 'p'],
    [[], 'true false'],
  ]) {
    const r = await z3VerifyImplication(axioms, goal);
    assert.equal(r.result, 'error', JSON.stringify({axioms, goal, r}));
    assert.equal(r.translation, undefined);
  }
});

test('comments and quoted identifiers cannot alter framing; unsupported names fail closed', async () => {
  const r = await z3VerifyImplication(['; (assert false)\n(declare-const |p;)| Bool)', '(assert |p;)|)'], '|p;)|');
  assert.equal(r.result, 'proved', r.detail);
  assert.equal(r.translation.status, 'unsupported');
  const commented = await z3VerifyImplication(['(declare-const p Bool)', '(assert ; fake )\n p)'], '; fake )\np', {p: 'P'});
  assert.equal(commented.result, 'proved', commented.detail);
  assert.equal(commented.translation.conclusion, '(P)');
});

test('inconsistent premises stay visibly unfit for commitment', async () => {
  const r = await z3FindCounterexample(['(declare-const p Bool)', '(assert p)', '(assert (not p))'], 'false', {p: 'P'});
  assert.equal(r.result, 'unsat');
  assert.equal(r.translation.premise_consistency, 'unsat');
});

test('incomplete, unused, ambiguous or argument-dropping meanings cannot gain assurance', async () => {
  const axioms = ['(declare-sort Person 0)', '(declare-fun R (Person Person) Bool)'];
  const missing = await z3VerifyImplication(axioms, '(forall ((x Person)) (R x x))');
  assert.deepEqual(missing.translation.missing_meanings, ['R','sort:Person']);
  for (const glossary of [
    {'sort:Person': 'people', R:'{0} respects someone'},
    {'sort:Person': 'people', R:'{0} respects {2}'},
    {'sort:Person': 'people', R:'{0} respects {1}', unused:'junk'},
  ]) {
    const r = await z3VerifyImplication(axioms, '(forall ((x Person)) (R x x))', glossary);
    assert.equal(r.translation.status, 'unsupported');
  }
});

test('object equality and function argument order are rendered without collapsing their meanings', async () => {
  const r = await z3VerifyImplication([
    '(declare-sort Person 0)', '(declare-const alice Person)', '(declare-const bob Person)',
    '(declare-fun parent (Person) Person)', '(assert (= (parent alice) bob))',
  ], '(= bob (parent alice))', {'sort:Person':'people', alice:'Alice', bob:'Bob', parent:'the parent of {0}'});
  assert.equal(r.result, 'proved');
  assert.equal(r.translation.status, 'supported');
  assert.equal(r.translation.assumptions[0], '((the parent of (Alice)) equals (Bob))');
  assert.equal(r.translation.conclusion, '((Bob) equals (the parent of (Alice)))');
});

test('empty premise sets and unsupported conditional terms retain honest results', async () => {
  const theorem = await z3VerifyImplication([], 'true');
  assert.equal(theorem.result, 'proved');
  assert.equal(theorem.translation.generated_gloss, 'Without additional assumptions, true.');
  assert.equal(theorem.translation.premise_consistency, 'sat');
  const conditional = await z3VerifyImplication(['(declare-const p Bool)', '(assert p)'], '(ite p true false)', {p:'P'});
  assert.equal(conditional.result, 'proved');
  assert.equal(conditional.translation.status, 'unsupported');
});
