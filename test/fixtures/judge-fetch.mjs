/** Deterministic provider for isolated subprocess tests. Never opens a network connection. */
let calls = 0;
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/api/tags')) return new Response('{"models":[]}');
  if (!['https://api.typesafe.ai/v1/systemone', 'https://openrouter.ai/api/alpha/decisions'].includes(String(url))) {
    throw new Error('Unexpected network request in regression test');
  }
  if (process.env.TEST_JUDGE_MODE === 'unavailable') return new Response('unavailable', {status: 503});
  const request = JSON.parse(init.body);
  const sequence = JSON.parse(process.env.TEST_JUDGE_DRAWS ?? '[{"noul":0.95}]');
  const sample = process.env.TEST_JUDGE_MODE === 'e2e'
    ? request.state.item.b.includes('then (the claim is committed).') ? {noul: 0.13, relation: 'scope_differs'} : {noul: 0.95}
    : sequence[Math.min(calls++, sequence.length - 1)];
  const relation = sample.relation ?? 'equivalent';
  return new Response(JSON.stringify({
    model: Object.hasOwn(sample, 'model') ? sample.model : 'jev-test-build-a',
    answers: {
      relation: {type: 'choice', choice: relation, confidence: 0.99,
        probabilities: Object.fromEntries(Object.keys(request.questions.relation.criteria).map(key => [key, key === relation ? 0.99 : 0.002]))},
      same_truth_conditions: {type: 'noul', noul: sample.noul},
    },
    usage: {input_tokens: 1, output_tokens: 1},
  }), {status: 200, headers: {'Content-Type': 'application/json'}});
};
