import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { regressionShard } from '../scripts/run-regression.mjs';

test('CI shards cover every configured runtime test exactly once and leave unit/source to their own jobs', async () => {
  const { commands } = JSON.parse(await readFile(new URL('../premium-ui.json', import.meta.url), 'utf8'));
  const shards = Array.from({ length: 6 }, (_, i) => regressionShard(commands, `${i + 1}/6`));
  const names = shards.flat().map(x => x.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.sort(), Object.keys(commands).filter(x => !['unit', 'check'].includes(x)).sort());
  assert(names.includes('syntheticEncryptedBackup'));
  assert(names.includes('feedback'));
  assert(shards.every(x => x.length > 0));
});
test('invalid shards and provisioning/shell commands cannot become test invocations', () => {
  for (const shard of ['0/6', '7/6', '1/33', '1', '1/6;echo', '1/01', '1/0']) assert.throws(() => regressionShard({}, shard));
  for (const command of ['node --env-file=.env.portal src/server/index.mjs', 'node scripts/provision-portal-account.mjs', 'node tests/e2e.mjs; echo secret', 'node ../tests/e2e.mjs']) {
    assert.throws(() => regressionShard({ unsafe: command }));
  }
});
