import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/legacy-migration-archive.mjs', import.meta.url));
function execute(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', total = 0;
    child.on('error', reject);
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', bytes => {
      total += bytes.length; if (total > 65536) { child.kill(); reject(new Error('CLI output exceeds bounded summary')); }
      if (name === 'stdout') stdout += bytes.toString('utf8'); else stderr += bytes.toString('utf8');
    });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
function fixture() {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'homecare-legacy-cli-synthetic-')); fs.chmodSync(root, 0o700);
  const input = join(root, 'incoming'), output = join(root, 'archives'), scope = join(root, 'scope.json');
  fs.mkdirSync(input, { mode: 0o700 }); fs.mkdirSync(output, { mode: 0o700 });
  const metadata = { format: 'suiyue-legacy-export-scope-v1', provider: 'synthetic-provider', tenant: 'synthetic-tenant', exportedAt: '2026-10-12T01:00:00.000Z',
    datasets: [{ id: 'cases', sourceFiles: ['private-SENTINEL-person.csv'], reportedCoverage: 'partial', range: { kind: 'filtered' }, sourceRowCount: 1 }], missingDatasets: ['attachments'], unresolved: ['filtered-export'] };
  fs.writeFileSync(scope, JSON.stringify(metadata), { mode: 0o600 }); fs.writeFileSync(join(input, 'private-SENTINEL-person.csv'), 'SENTINEL-private-person,=1+1\n', { mode: 0o600 });
  return { root, input, output, scope, args: ['capture', '--input', input, '--output-parent', output, '--scope', scope], remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('native capture and verify CLI preserve private originals and print only bounded nonpersonal summaries', async () => {
  const f = fixture();
  try {
    const result = await execute(f.args); assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null); assert.equal(result.stderr, '');
    const proof = JSON.parse(result.stdout); assert.equal(proof.status, 'verified'); assert.equal(proof.fileCount, 1); assert.equal(proof.sourceSystemComplete, false); assert.equal(proof.businessImportCompleted, false);
    assert.equal(proof.missingDatasetCount, 1); assert.equal(proof.sourceCompared, true); assert(!result.stdout.includes('SENTINEL')); assert(!result.stdout.includes(f.root));
    const checked = await execute(['verify', '--archive', join(f.output, proof.archiveId), '--expected-manifest-sha256', proof.manifestSha256, '--input', f.input]);
    assert.equal(checked.code, 0, checked.stderr); assert.deepEqual(JSON.parse(checked.stdout), proof); assert.equal(checked.stderr, '');
    assert.equal(fs.readFileSync(join(f.input, 'private-SENTINEL-person.csv'), 'utf8'), 'SENTINEL-private-person,=1+1\n');
  } finally { f.remove(); }
});

test('four native concurrent captures produce distinct exclusive packages and leave all originals unchanged', async () => {
  const f = fixture();
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => execute(f.args)));
    const proofs = results.map(result => { assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null); return JSON.parse(result.stdout); });
    assert.equal(new Set(proofs.map(proof => proof.archiveId)).size, 4); assert.equal(fs.readdirSync(f.output).length, 4);
    for (const proof of proofs) { const checked = await execute(['verify', '--archive', join(f.output, proof.archiveId), '--expected-manifest-sha256', proof.manifestSha256, '--input', f.input]); assert.equal(checked.code, 0, checked.stderr); }
    const files = proofs.map(proof => JSON.parse(fs.readFileSync(join(f.output, proof.archiveId, 'manifest.json'), 'utf8')).files);
    assert(files.every(rows => JSON.stringify(rows) === JSON.stringify(files[0]))); assert.equal(fs.readFileSync(join(f.input, 'private-SENTINEL-person.csv'), 'utf8'), 'SENTINEL-private-person,=1+1\n');
  } finally { f.remove(); }
});

test('CLI rejects unknown/duplicate/missing arguments and refuses environment fallbacks without leaking supplied values', async () => {
  const f = fixture();
  try {
    const attempts = [[], ['capture'], ['capture', '--input', 'SENTINEL'], [...f.args, '--input', f.input], [...f.args, '--password', 'SENTINEL-secret'],
      ['verify', '--archive', f.output], ['verify', '--archive', f.output, '--expected-manifest-sha256', 'SENTINEL-invalid']];
    for (const args of attempts) {
      const result = await execute(args, { HOME_CARE_LEGACY_INPUT: 'SENTINEL-environment', PASSWORD: 'SENTINEL-environment-secret' });
      assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert(!result.stderr.includes('SENTINEL')); assert(!result.stderr.includes(f.root)); assert.equal(JSON.parse(result.stderr).status, 'failed');
    }
    assert.deepEqual(fs.readdirSync(f.output), []);
  } finally { f.remove(); }
});

test('CLI scope must be separate from incoming and output; duplicate metadata cannot silently replace tenant/source provenance', async () => {
  const f = fixture();
  try {
    const incomingScope = join(f.input, 'scope.json'); fs.copyFileSync(f.scope, incomingScope); fs.chmodSync(incomingScope, 0o600);
    const bad = await execute(['capture', '--input', f.input, '--output-parent', f.output, '--scope', incomingScope]); assert.equal(bad.code, 1); assert.equal(JSON.parse(bad.stderr).code, 'INVALID_ARGUMENT');
    const outputScope = join(f.output, 'scope.json'); fs.copyFileSync(f.scope, outputScope); fs.chmodSync(outputScope, 0o600);
    const badOutput = await execute(['capture', '--input', f.input, '--output-parent', f.output, '--scope', outputScope]); assert.equal(badOutput.code, 1); assert.equal(JSON.parse(badOutput.stderr).code, 'INVALID_ARGUMENT');
    const original = fs.readFileSync(f.scope, 'utf8'); fs.writeFileSync(f.scope, original.replace('"tenant":"synthetic-tenant"', '"tenant":"synthetic-tenant","\\u0074enant":"SENTINEL-injected"'));
    const duplicate = await execute(f.args); assert.equal(duplicate.code, 1); assert.equal(JSON.parse(duplicate.stderr).code, 'INVALID_METADATA'); assert(!duplicate.stderr.includes('SENTINEL'));
    assert.deepEqual(fs.readdirSync(f.output), ['scope.json']);
  } finally { f.remove(); }
});

test('native verification refuses archive substitutions and remains read-only', async () => {
  const f = fixture();
  try {
    const captured = await execute(f.args); assert.equal(captured.code, 0, captured.stderr); const proof = JSON.parse(captured.stdout);
    const path = join(f.output, proof.archiveId), marker = join(path, 'manifest.json'), before = fs.readFileSync(marker);
    const wrong = await execute(['verify', '--archive', path, '--expected-manifest-sha256', '0'.repeat(64)]); assert.equal(wrong.code, 1); assert.equal(JSON.parse(wrong.stderr).code, 'MANIFEST_HASH_MISMATCH'); assert.deepEqual(fs.readFileSync(marker), before);
    const row = JSON.parse(before).files[0]; fs.writeFileSync(join(path, row.archivedPath), 'tampered bytes');
    const result = await execute(['verify', '--archive', path, '--expected-manifest-sha256', proof.manifestSha256]); assert.equal(result.code, 1); assert.equal(JSON.parse(result.stderr).code, 'ARCHIVE_CHANGED'); assert.deepEqual(fs.readFileSync(marker), before);
    assert.deepEqual(fs.readdirSync(path).sort(), ['files', 'manifest.json']);
  } finally { f.remove(); }
});
