/** Synthetic operator attestation for scratch-ledger tests only. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../dist/review-cli.js', import.meta.url));
export async function approveFixture(dbPath, formalizationId) {
  const {stdout} = await exec(process.execPath, [cli, 'inspect', '--db', dbPath, '--id', String(formalizationId)]);
  const packet = JSON.parse(stdout);
  const review = {...packet.review_template, decision: 'approved', reviewer: 'synthetic-test-reviewer',
    claim_scope: 'Synthetic test attestation, not independent real-world validation.',
    symbols: packet.review_template.symbols.map(s => ({...s, grounding: 'Fixture-controlled symbol meaning.'})),
    premises: packet.review_template.premises.map(p => ({...p, justification: 'Explicit assumption of the fixture conditional.'})),
  };
  const file = join(dirname(dbPath), `review-${formalizationId}.json`);
  await writeFile(file, JSON.stringify(review));
  await exec(process.execPath, [cli, 'record', '--db', dbPath, '--file', file]);
  return review;
}
