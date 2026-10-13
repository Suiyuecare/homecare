import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import sqlite from 'node:sqlite';
import { syncBuiltinESMExports, registerHooks } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDb, insert } from '../src/server/model.mjs';
import { initPortalStorage } from '../src/server/portal-handoff.mjs';
import { inspectProductionDatabase } from '../src/server/production-backup-inspection.mjs';
import { createProductionPayloadSink } from '../src/server/production-backup-payload.mjs';
import { createProductionBackup, verifyProductionBackup, restoreProductionBackupIsolated } from '../src/server/production-backup.mjs';

const PROOF_LIMIT = 1024 ** 2;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const rejected = code => error => error?.name === 'ProductionBackupError' && error.code === code;
const frame = (proof, database) => { const size = Buffer.alloc(4); size.writeUInt32BE(proof.length); return Buffer.concat([size, proof, database]); };
const lengthPrefix = length => { const b = Buffer.alloc(4); b.writeUInt32BE(length); return b; };
function owner(t) {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'homecare-stream-reader-synthetic-'));
  fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function fixture(t) {
  const root = owner(t), path = join(root, 'source.sqlite'), db = new sqlite.DatabaseSync(path), key = crypto.randomBytes(32);
  initDb(db); initPortalStorage(db);
  const orgId = crypto.randomUUID(), stamp = '2026-10-13T00:00:00.000Z';
  db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(orgId, '合成機構\u0000完整尾字', stamp);
  insert(db, orgId, 'cases', { caseNo: 'SYN-STREAM', name: '合成個案', note: '原值\u0000\r\n完整尾字' });
  db.exec('PRAGMA journal_mode=DELETE'); const inspection = inspectProductionDatabase(db); db.close(); fs.chmodSync(path, 0o600);
  const database = fs.readFileSync(path), proof = { format: 'suiyue-production-backup-proof-v1', createdAt: stamp, inspection, databaseSha256: sha(database), databaseBytes: database.length };
  t.after(() => key.fill(0)); return { root, path, key, database, proof, stamp };
}
// Independent v1 writer: compatibility must not depend on the new reader's
// framing helper or the production writer producing the same mistake.
function archive(f, payload, name, { badTag = false } = {}) {
  const iv = crypto.randomBytes(12), header = Buffer.from(JSON.stringify({ format: 'suiyue-production-encrypted-sqlite-v1', version: 1, cipher: 'aes-256-gcm', iv: iv.toString('base64'), createdAt: f.stamp }));
  const size = lengthPrefix(header.length), aad = Buffer.concat([Buffer.from('SYHCBAK1'), size, header]);
  const cipher = crypto.createCipheriv('aes-256-gcm', f.key, iv); cipher.setAAD(aad);
  const bytes = Buffer.concat([aad, cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  if (badTag) bytes[bytes.length - 1] ^= 1;
  const path = join(f.root, name + '.hcbak'); fs.writeFileSync(path, bytes, { mode: 0o600 }); return path;
}
const leftovers = root => fs.readdirSync(root).filter(name => name.startsWith('.homecare-backup-'));
async function observeReaderDatabaseOpens(t, callback) {
  const id = 'homecare-synthetic-open-observer-' + crypto.randomUUID(), key = Symbol.for(id);
  const readerUrl = new URL('../src/server/production-backup.mjs?' + id, import.meta.url).href, sqliteUrl = 'homecare-test:' + id;
  globalThis[key] = callback;
  // node:sqlite's namespace constructor cannot be replaced with a default-
  // export mock on supported runtimes. Observe a separate reader module using
  // a loader hook, and require a successful positive control in the test.
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return specifier === 'node:sqlite' && context.parentURL === readerUrl ? { url: sqliteUrl, shortCircuit: true } : next(specifier, context);
    },
    load(url, context, next) {
      if (url !== sqliteUrl) return next(url, context);
      return { format: 'module', shortCircuit: true, source: `export * from 'node:sqlite'; import { DatabaseSync as Original } from 'node:sqlite'; export class DatabaseSync extends Original { constructor(...args) { globalThis[Symbol.for(${JSON.stringify(id)})](...args); super(...args); } }` };
    },
  });
  t.after(() => { hooks.deregister(); delete globalThis[key]; });
  return import(readerUrl);
}

test('binary sink preserves exact bytes at every prefix/proof/DB split and accepts an empty final chunk', () => {
  const proof = Buffer.from('合成\u0000proof'), database = Buffer.alloc(137, 0xa5), payload = frame(proof, database);
  for (let split = 0; split <= payload.length; split++) {
    const rows = [], sink = createProductionPayloadSink({ maximum: database.length, proofLimit: PROOF_LIMIT, writeDatabase: b => rows.push(Buffer.from(b)) });
    try {
      sink.push(payload.subarray(0, split)); sink.push(payload.subarray(split)); sink.push(Buffer.alloc(0));
      const result = sink.finishAuthenticated(); assert(result.proofBytes.equals(proof)); assert.equal(result.databaseBytes, database.length); assert(Buffer.concat(rows).equals(database));
    } finally { sink.destroy(); }
  }
});

test('binary sink accepts a full 1MiB proof across tiny prefix chunks and zeroes its owned proof after use', () => {
  const proof = Buffer.alloc(PROOF_LIMIT, 0x61), database = Buffer.alloc(100, 0), payload = frame(proof, database), output = [];
  const sink = createProductionPayloadSink({ maximum: 100, proofLimit: PROOF_LIMIT, writeDatabase: b => output.push(Buffer.from(b)) });
  for (let i = 0; i < 4; i++) sink.push(payload.subarray(i, i + 1));
  for (let i = 4; i < payload.length; i += 8191) sink.push(payload.subarray(i, i + 8191));
  const result = sink.finishAuthenticated(); assert(result.proofBytes.equals(proof)); assert(Buffer.concat(output).equals(database));
  sink.destroy(); assert(result.proofBytes.equals(Buffer.alloc(PROOF_LIMIT))); assert.throws(() => sink.push(Buffer.alloc(0)), rejected('INVALID_ARGUMENT'));
});

test('invalid binary framing is deferred, bounded and never writes incomplete proof bytes as a database', () => {
  const invalid = [Buffer.alloc(0), Buffer.alloc(1), Buffer.alloc(2), Buffer.alloc(3), lengthPrefix(0), lengthPrefix(PROOF_LIMIT + 1), lengthPrefix(0xffffffff), Buffer.concat([lengthPrefix(8), Buffer.from('short')])];
  for (const payload of invalid) {
    let writes = 0;
    const sink = createProductionPayloadSink({ maximum: 100, proofLimit: PROOF_LIMIT, writeDatabase: () => writes++ });
    try { assert.doesNotThrow(() => sink.push(payload)); assert.doesNotThrow(() => sink.push(Buffer.alloc(0))); assert.throws(() => sink.finishAuthenticated(), rejected('ENVELOPE_INVALID')); assert.equal(writes, 0); }
    finally { sink.destroy(); }
  }
  let written = 0;
  const sink = createProductionPayloadSink({ maximum: 100, proofLimit: PROOF_LIMIT, writeDatabase: b => { written += b.length; } });
  try { sink.push(frame(Buffer.from('p'), Buffer.alloc(100))); sink.push(Buffer.alloc(1)); assert.equal(written, 100); assert.throws(() => sink.finishAuthenticated(), rejected('ENVELOPE_INVALID')); }
  finally { sink.destroy(); }
});

test('independent original v1 wire format verifies and restores the exact thirteen-table snapshot', async t => {
  const f = fixture(t), original = Buffer.from(f.database), path = archive(f, frame(Buffer.from(JSON.stringify(f.proof)), f.database), 'independent-v1');
  assert((await verifyProductionBackup({ backupPath: path, key: f.key })).verified);
  const destinationDirectory = join(f.root, 'isolation');
  const result = await restoreProductionBackupIsolated({ backupPath: path, destinationDirectory, key: f.key });
  assert(result.recoveryPending); assert.equal(result.productionReady, false);
  const restored = new sqlite.DatabaseSync(join(destinationDirectory, 'isolated.sqlite'), { readOnly: true });
  try { assert.deepEqual(inspectProductionDatabase(restored), f.proof.inspection); }
  finally { restored.close(); }
  assert(fs.readFileSync(f.path).equals(original)); assert.deepEqual(leftovers(f.root), []);
});

test('GCM authentication precedes proof JSON/SQLite, including malformed lengths, incomplete framing and bad JSON', async t => {
  const f = fixture(t), valid = frame(Buffer.from(JSON.stringify(f.proof)), f.database);
  const malformed = [Buffer.alloc(0), Buffer.alloc(1), Buffer.alloc(2), Buffer.alloc(3), lengthPrefix(0), lengthPrefix(PROOF_LIMIT + 1), lengthPrefix(0xffffffff), Buffer.concat([lengthPrefix(1000), Buffer.from('short')]), frame(Buffer.from('invalid-json'), Buffer.alloc(100)), frame(Buffer.from([0xff]), Buffer.alloc(100)), valid];
  const paths = malformed.map((p, i) => ({ bad: archive(f, p, 'bad-tag-' + i, { badTag: true }), good: archive(f, p, 'correct-tag-' + i) }));
  let authenticated = false, proofParses = 0, sqliteOpens = 0;
  const observed = await observeReaderDatabaseOpens(t, () => { assert(authenticated, 'SQLite must wait for GCM'); sqliteOpens++; });
  const originalParse = JSON.parse, originalDecipher = crypto.createDecipheriv;
  t.mock.method(crypto, 'createDecipheriv', function(...args) {
    const decipher = originalDecipher.apply(this, args), final = decipher.final;
    decipher.final = function(...args) { const result = final.apply(this, args); authenticated = true; return result; }; return decipher;
  });
  t.mock.method(JSON, 'parse', function(text, ...args) {
    if (!String(text).startsWith('{"format":"suiyue-production-encrypted-sqlite-v1"')) { assert(authenticated, 'payload JSON must wait for GCM'); proofParses++; }
    return originalParse.call(this, text, ...args);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const { bad, good } of paths) {
    authenticated = false; proofParses = 0; sqliteOpens = 0;
    await assert.rejects(observed.verifyProductionBackup({ backupPath: bad, key: f.key }), rejected('AUTHENTICATION_FAILED'));
    assert.equal(proofParses, 0); assert.equal(sqliteOpens, 0);
    const wrongKey = crypto.randomBytes(32);
    try { await assert.rejects(observed.verifyProductionBackup({ backupPath: good, key: wrongKey }), rejected('AUTHENTICATION_FAILED')); }
    finally { wrongKey.fill(0); }
    assert.equal(proofParses, 0); assert.equal(sqliteOpens, 0);
  }
  authenticated = false; proofParses = 0; sqliteOpens = 0;
  assert((await observed.verifyProductionBackup({ backupPath: paths.at(-1).good, key: f.key })).verified);
  assert(proofParses > 0 && sqliteOpens > 0, 'positive control proves both parser/open observers are active');
  assert.deepEqual(leftovers(f.root), []);
});

test('authenticated malformed framing, canonical proof mismatch and excess database bytes still fail', async t => {
  const f = fixture(t);
  const payloads = [Buffer.alloc(0), Buffer.alloc(3), lengthPrefix(0), lengthPrefix(PROOF_LIMIT + 1), Buffer.concat([lengthPrefix(8), Buffer.from('short')]), frame(Buffer.from('{}'), Buffer.alloc(99)), frame(Buffer.from('invalid'), Buffer.alloc(100)), frame(Buffer.from('null'), Buffer.alloc(100)), frame(Buffer.from(JSON.stringify({ ...f.proof, databaseBytes: f.database.length + 1 })), f.database), frame(Buffer.from(JSON.stringify(f.proof)), Buffer.concat([f.database, Buffer.alloc(1)]))];
  for (const [i, payload] of payloads.entries()) {
    const path = archive(f, payload, 'authenticated-malformed-' + i);
    await assert.rejects(verifyProductionBackup({ backupPath: path, key: f.key, maxBytes: f.database.length }), rejected('ENVELOPE_INVALID'));
  }
  const wrongHash = archive(f, frame(Buffer.from(JSON.stringify({ ...f.proof, databaseSha256: '0'.repeat(64) })), f.database), 'wrong-sha');
  await assert.rejects(verifyProductionBackup({ backupPath: wrongHash, key: f.key }), rejected('SNAPSHOT_CHANGED'));
  assert.deepEqual(leftovers(f.root), []);
});

test('an encrypted source mutation after accepted tag is rejected before proof parsing or SQLite', async t => {
  const f = fixture(t), path = archive(f, frame(Buffer.from(JSON.stringify(f.proof)), f.database), 'mutated-after-auth');
  const originalDecipher = crypto.createDecipheriv, originalParse = JSON.parse;
  let proofParses = 0, sqliteOpens = 0;
  const observed = await observeReaderDatabaseOpens(t, () => sqliteOpens++);
  t.mock.method(crypto, 'createDecipheriv', function(...args) {
    const decipher = originalDecipher.apply(this, args), final = decipher.final;
    decipher.final = function(...args) { const result = final.apply(this, args); fs.appendFileSync(path, Buffer.from([0])); return result; }; return decipher;
  });
  t.mock.method(JSON, 'parse', function(text, ...args) { if (!String(text).startsWith('{"format":"suiyue-production-encrypted-sqlite-v1"')) proofParses++; return originalParse.call(this, text, ...args); });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(observed.verifyProductionBackup({ backupPath: path, key: f.key }), rejected('BACKUP_CHANGED'));
  assert.equal(proofParses, 0); assert.equal(sqliteOpens, 0); assert.deepEqual(leftovers(f.root), []);
});

test('actual owned-file byte peaks are E+D during backup and D during verify, with no payload file', async t => {
  const f = fixture(t), originalOpen = fs.openSync, originalWrite = fs.writeSync;
  let phase = 'backup'; const peak = { backup: 0, verify: 0 }, seen = new Set();
  const observe = () => {
    let bytes = 0; const inodes = new Set();
    for (const directory of leftovers(f.root)) for (const name of fs.readdirSync(join(f.root, directory))) {
      const st = fs.lstatSync(join(f.root, directory, name)); if (!st.isFile()) continue;
      const id = st.dev + ':' + st.ino; if (inodes.has(id)) continue; inodes.add(id); bytes += st.size;
    }
    peak[phase] = Math.max(peak[phase], bytes);
  };
  t.mock.method(fs, 'openSync', function(path, ...args) { if (typeof path === 'string' && path.includes('/.homecare-backup-') && (args[0] & fs.constants.O_CREAT)) seen.add(path.slice(path.lastIndexOf('/') + 1)); return originalOpen.call(this, path, ...args); });
  t.mock.method(fs, 'writeSync', function(...args) { const n = originalWrite.apply(this, args); observe(); return n; });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const outputPath = join(f.root, 'new-v1.hcbak');
  const result = await createProductionBackup({ databasePath: f.path, outputPath, key: f.key });
  const encryptedBytes = fs.statSync(outputPath).size;
  assert.equal(result.format, 'suiyue-production-encrypted-sqlite-v1');
  assert.equal(peak.backup, encryptedBytes + f.database.length);
  phase = 'verify'; assert((await verifyProductionBackup({ backupPath: outputPath, key: f.key })).verified);
  assert.equal(peak.verify, f.database.length); assert(!seen.has('authenticated.payload'));
  assert.deepEqual([...seen].sort(), ['archive.pending', 'restored.sqlite', 'snapshot.sqlite']);
  process.stdout.write('# measured owned bytes ' + JSON.stringify({ D: f.database.length, E: encryptedBytes, peak }) + '\n');
  assert.deepEqual(leftovers(f.root), []);
});
