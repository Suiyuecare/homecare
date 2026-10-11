import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/rehearse-synthetic-encrypted-backup.mjs', import.meta.url));
function execute(input, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = []; let count = 0;
    child.on('error', reject);
    for (const [stream, pieces] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', bytes => {
      count += bytes.length;
      if (count > 65536) { child.kill(); reject(new Error('Synthetic CLI output exceeded its bounded proof summary')); }
      else pieces.push(Buffer.from(bytes));
    });
    child.on('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input);
  });
}
const failure = result => JSON.parse(result.stderr.split('\n').filter(line => line.startsWith('{')).at(-1));

test('true CLI accepts a Unicode stdin secret with CRLF terminator, retains eleven tables and rolls both actual rename points back', async () => {
  const password = Buffer.from('  合成CLI密碼-' + randomBytes(20).toString('hex') + '  '), input = Buffer.concat([password, Buffer.from('\r\n')]);
  try {
    const result = await execute(input);
    assert.equal(result.code, 0, 'Actual encrypted rehearsal process must exit successfully'); assert.equal(result.signal, null);
    assert(!result.stdout.includes(password.toString('utf8'))); assert(!result.stderr.includes(password.toString('utf8'))); assert(!result.stdout.includes('/Users/') && !result.stdout.includes('source.sqlite'));
    const proof = JSON.parse(result.stdout);
    assert.equal(proof.status, 'passed'); assert.equal(proof.syntheticOnly, true); assert.equal(proof.tableCount, 11); assert.equal(proof.triggerCount, 6);
    assert.equal(proof.plaintextBackupDeletedBeforeRestore, true); assert.equal(proof.cipherOnlyRestoreVerified, true); assert.equal(proof.committedWalSourcePreserved, true);
    assert.equal(proof.fullTypedValuesAndTextNulExact, true); assert.equal(proof.immutableBlobFamiliesExact, true); assert.equal(proof.versionsAndSavedPricingExact, true);
    assert.equal(proof.restoredStartupChanges, 0); assert.equal(proof.sourceTotalChangesUnchanged, true); assert(proof.liveBusinessChanges > 0);
    assert.deepEqual(proof.rollbacks.map(row => row.failurePoint), ['after-live-retired', 'after-candidate-promoted']); assert(proof.rollbacks.every(row => row.status === 'rolled_back' && row.originalInodeRestored && row.originalBytesRestored));
    assert.equal(proof.promotionStatus, 'promoted'); assert.equal(proof.previousOriginalInodeAndBytesRetained, true); assert.equal(proof.disposed, true);
    assert.equal(proof.actual4310Accessed, false); assert.equal(proof.portalProfileChanged, false); assert.equal(proof.formalDeployment, false); assert.equal(proof.formalKmsOrRecoveryPolicyApproved, false);
  } finally { password.fill(0); input.fill(0); }
});

test('CLI rejects argv instead of reading an argument secret and emits only a sanitized fixed error', async () => {
  const sentinel = 'SENTINEL-ARGUMENT-NEVER-PRINT';
  const result = await execute(Buffer.alloc(0), [sentinel]); assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.deepEqual(failure(result), { status: 'failed', syntheticOnly: true, code: 'CLI_ARGUMENTS_REJECTED' }); assert(!result.stderr.includes(sentinel));
});

test('CLI does not fall back to an environment secret for empty or invalid stdin', async () => {
  const sentinel = 'SENTINEL-ENVIRONMENT-NEVER-READ';
  const result = await execute(Buffer.alloc(0), [], { SYNTHETIC_BACKUP_PASSPHRASE: sentinel, PASSPHRASE: sentinel });
  assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.equal(failure(result).code, 'PASSPHRASE_INVALID'); assert(!result.stderr.includes(sentinel));
});

test('CLI rejects multi-line, internal NUL, invalid UTF8, short and oversize input without disclosure or partial proof', async () => {
  const inputs = [Buffer.from('short\n'), Buffer.from('long-enough-line-one\nlong-line-two\n'), Buffer.from('long-enough-line\0not-valid\n'), Buffer.alloc(16, 255), Buffer.alloc(1027, 97)];
  for (const input of inputs) {
    const result = await execute(input); assert.equal(result.code, 1); assert.equal(result.stdout, '');
    assert(['PASSPHRASE_INVALID', 'STDIN_CAPACITY_EXCEEDED'].includes(failure(result).code)); assert(!result.stderr.includes(input.toString('utf8')));
    input.fill(0);
  }
});
