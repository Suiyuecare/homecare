import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, linkSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { initDb } from '../src/server/model.mjs';
import { initPortalStorage, PORTAL_ORIGIN } from '../src/server/portal-handoff.mjs';
import { createReadinessProbe, readinessOptionsFromEnv } from '../src/server/readiness.mjs';
import { checkRuntimeReadiness, readinessTarget } from '../scripts/check-runtime-readiness.mjs';
import { containerConfiguration } from '../ops/container-start.mjs';

const portal = { mode: 'portal', portalOrigin: PORTAL_ORIGIN, publicOrigin: 'https://homecare.example.test', signingSecret: 'synthetic-private-signing-marker-123456789' };
const stamp = '2026-10-11T00:00:00.000Z';
const sha = value => createHash('sha256').update(value).digest('hex');
const quote = value => '"' + value.replaceAll('"', '""') + '"';
function state(db) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  return sha(JSON.stringify({ schema: db.prepare('SELECT * FROM sqlite_schema ORDER BY type,name').all(), rows: tables.map(name => ({ name, rows: db.prepare(`SELECT * FROM ${quote(name)}`).all() })), changes: db.prepare('SELECT total_changes() AS changes').get() }));
}
function database({ file = ':memory:', portalMode = false } = {}) {
  const db = new DatabaseSync(file); initDb(db); if (portalMode) initPortalStorage(db);
  db.prepare('INSERT INTO organizations VALUES(?,?,?)').run('synthetic-org', '合成營運測試', stamp);
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run('synthetic-user', '合成人員', 'readiness@example.test', 'synthetic-not-a-password', stamp);
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('synthetic-org', 'synthetic-user', 'admin', null);
  if (portalMode) {
    db.prepare('INSERT INTO portal_identity_bindings VALUES(?,?,?,?,?,?,?,?)').run(PORTAL_ORIGIN, 'synthetic-subject', 'synthetic-auth-id', 'readiness@example.test', 'synthetic-user', 'synthetic-org', 0, stamp);
    db.prepare('INSERT INTO portal_handoff_nonces VALUES(?,?,?,?,?,?)').run('synthetic-consumed-nonce', PORTAL_ORIGIN, 'synthetic-user', 'synthetic-org', 1, 2);
  }
  return db;
}
function probe(db, options = {}) { return createReadinessProbe({ db, dbPath: ':memory:', databaseWritable: true, ...options }); }
function rejected(report, code) { assert.equal(report.status, 503); assert.equal(report.body.ok, false); assert(report.body.issues.includes(code)); }

test('local eleven-table probe is read-only across repeated calls', () => {
  const db = database();
  try {
    const before = state(db), ready = probe(db);
    for (let i = 0; i < 10; i++) assert.deepEqual(ready(), { status: 200, body: { ok: true, service: 'suiyue-home-care', checks: { database: 'passed', schema: 'passed', storage: 'not_required', portal: 'passed' }, issues: [] } });
    assert.equal(state(db), before);
  } finally { db.close(); }
});

test('Portal thirteen-table probe preserves disabled bindings, consumed nonces and every table', () => {
  const db = database({ portalMode: true });
  try {
    const before = state(db), result = probe(db, { portalConfig: portal })();
    assert.equal(result.status, 200); assert.equal(state(db), before);
    const publicResult = JSON.stringify(result);
    for (const secret of [portal.signingSecret, portal.portalOrigin, portal.publicOrigin, 'readiness@example.test', 'synthetic-org', 'synthetic-user', 'synthetic-consumed-nonce', 'synthetic-subject']) assert(!publicResult.includes(secret));
  } finally { db.close(); }
});

test('unknown/read-only connection and query_only database cannot become ready', () => {
  const db = database();
  try {
    const before = state(db);
    rejected(createReadinessProbe({ db, dbPath: ':memory:' })(), 'DATABASE_READ_ONLY');
    db.exec('PRAGMA query_only=ON'); rejected(probe(db)(), 'DATABASE_READ_ONLY');
    assert.equal(state(db), before);
  } finally { db.close(); }
});

test('closed, absent or throwing database remains unavailable without error details', () => {
  const db = database(); db.close();
  rejected(probe(db)(), 'DATABASE_UNAVAILABLE');
  rejected(probe(undefined)(), 'DATABASE_UNAVAILABLE');
  const hostile = { prepare() { throw new Error('/private/secret-path secret account@example.test'); } };
  const report = probe(hostile)(); rejected(report, 'DATABASE_UNAVAILABLE'); assert(!JSON.stringify(report).includes('secret'));
  rejected(probe(hostile, { closed: () => true })(), 'APPLICATION_CLOSED');
  rejected(probe(hostile, { closed: () => { throw new Error('secret'); } })(), 'APPLICATION_CLOSED');
});

test('missing required table, column or immutable trigger refuses readiness', () => {
  for (const alteration of ['DROP TABLE audit', 'ALTER TABLE users RENAME COLUMN password_hash TO wrong_column', 'DROP TRIGGER versions_no_update']) {
    const db = database();
    try { db.exec(alteration); const before = state(db); rejected(probe(db)(), 'SCHEMA_UNAVAILABLE'); assert.equal(state(db), before); }
    finally { db.close(); }
  }
});

test('Portal requires both additive tables and local mode refuses Portal storage', () => {
  const db = database();
  try { rejected(probe(db, { portalConfig: portal })(), 'SCHEMA_UNAVAILABLE'); initPortalStorage(db); rejected(probe(db)(), 'PORTAL_STORAGE_MODE_MISMATCH'); db.exec('DROP TABLE portal_handoff_nonces'); rejected(probe(db, { portalConfig: portal })(), 'SCHEMA_UNAVAILABLE'); }
  finally { db.close(); }
});

test('invalid or missing required Portal settings return fixed diagnostics', () => {
  const db = database({ portalMode: true });
  try {
    for (const bad of [{ mode: 'portal' }, { ...portal, signingSecret: 'short' }, { ...portal, publicOrigin: 'https://private.example.test/secret' }, { ...portal, portalOrigin: 'https://wrong.example.test' }]) {
      const result = probe(db, { portalConfig: bad })(); rejected(result, 'PORTAL_CONFIGURATION_INVALID'); assert(!JSON.stringify(result).includes('example.test')); assert(!JSON.stringify(result).includes('secret'));
    }
  } finally { db.close(); }
});

test('persistent policy requires actual file plus explicit durability acknowledgement', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'homecare-readiness-test-')); chmodSync(dir, 0o700);
  const filename = path.join(dir, 'synthetic.sqlite'), db = database({ file: filename }); chmodSync(filename, 0o600);
  try {
    const before = state(db), files = () => Object.fromEntries(readdirSync(dir).map(name => [name, sha(readFileSync(path.join(dir, name)))]));
    const fileState = files();
    rejected(probe(db, { requirePersistent: true })(), 'PERSISTENT_STORAGE_REQUIRED');
    rejected(probe(db, { dbPath: filename, requirePersistent: true })(), 'STORAGE_DURABILITY_UNCONFIRMED');
    assert.equal(probe(db, { dbPath: filename, requirePersistent: true, storageConfirmed: true })().status, 200);
    assert.equal(state(db), before); assert.deepEqual(files(), fileState);
  } finally { db.close(); rmSync(dir, { recursive: true }); }
});

test('disk refusal, missing path, alias and insufficient space close readiness', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'homecare-readiness-disk-')); chmodSync(dir, 0o700);
  const filename = path.join(dir, 'synthetic.sqlite'), db = database({ file: filename }); chmodSync(filename, 0o600);
  try {
    const before = state(db);
    rejected(probe(db, { dbPath: path.join(dir, 'absent.sqlite') })(), 'STORAGE_UNAVAILABLE');
    rejected(probe(db, { dbPath: '' })(), 'STORAGE_UNAVAILABLE');
    symlinkSync(filename, path.join(dir, 'alias.sqlite')); rejected(probe(db, { dbPath: path.join(dir, 'alias.sqlite') })(), 'STORAGE_UNAVAILABLE');
    chmodSync(filename, 0o400); rejected(probe(db, { dbPath: filename })(), 'STORAGE_NOT_WRITABLE'); chmodSync(filename, 0o600);
    chmodSync(dir, 0o500); rejected(probe(db, { dbPath: filename })(), 'STORAGE_NOT_WRITABLE'); chmodSync(dir, 0o700);
    rejected(probe(db, { dbPath: filename, minFreeBytes: Number.MAX_SAFE_INTEGER })(), 'STORAGE_SPACE_INSUFFICIENT');
    assert.equal(state(db), before);
  } finally { db.close(); chmodSync(dir, 0o700); rmSync(dir, { recursive: true }); }
});

test('policy parsing is strict and production/Portal cannot disable durable checks', () => {
  assert.equal(readinessOptionsFromEnv({}).requirePersistent, false);
  for (const environment of [{ NODE_ENV: 'production' }, { HOME_CARE_AUTH_MODE: 'portal' }]) {
    assert.equal(readinessOptionsFromEnv(environment).requirePersistent, true);
    assert.equal(readinessOptionsFromEnv({ ...environment, HOME_CARE_REQUIRE_PERSISTENT_STORAGE: '0' }).policyValid, false);
  }
  const db = database();
  try {
    for (const environment of [{ HOME_CARE_REQUIRE_PERSISTENT_STORAGE: 'true' }, { HOME_CARE_STORAGE_DURABILITY: 'volatile' }, { HOME_CARE_MIN_FREE_BYTES: '-1' }, { HOME_CARE_MIN_FREE_BYTES: '9007199254740992' }]) rejected(probe(db, readinessOptionsFromEnv(environment))(), 'READINESS_POLICY_INVALID');
  } finally { db.close(); }
});

test('probe CLI refuses external URLs, default application port and credential-bearing URLs', async () => {
  for (const url of ['https://homecare.example.test', 'http://localhost:8080', 'http://127.0.0.1:4310', 'http://127.0.0.1', 'http://user:secret@127.0.0.1:8080', 'http://127.0.0.1:8080/ready', 'http://127.0.0.1:8080/?secret=1']) {
    let called = false; const result = await checkRuntimeReadiness({ url, fetcher: () => { called = true; throw new Error(); } });
    assert.equal(result.exitCode, 2); assert.equal(result.report.code, 'READINESS_TARGET_REFUSED'); assert.equal(called, false);
  }
  assert.deepEqual(readinessTarget('http://127.0.0.1:8080', portal.publicOrigin), { url: 'http://127.0.0.1:8080/ready', host: 'homecare.example.test' });
});

test('CLI emits only validated fixed reports; unknown/oversized/redirect responses never leak', async () => {
  for (const response of [new Response('private-secret', { status: 500 }), new Response(JSON.stringify({ ok: false, private: 'private-secret' }), { status: 503 }), new Response('x'.repeat(4097)), new Response('redirect-secret', { status: 302 }), new Response(JSON.stringify({ ok: true, service: 'suiyue-home-care', checks: { database: 'passed', schema: 'passed', storage: 'passed', portal: 'passed' }, issues: ['private-secret'] }))]) {
    const result = await checkRuntimeReadiness({ url: 'http://127.0.0.1:8080', fetcher: async () => response });
    assert.equal(result.exitCode, 2); assert(!JSON.stringify(result.report).includes('secret'));
  }
});

test('native HTTP operator probe sends correct Host and observes ready/unready without writes', async () => {
  const db = database({ portalMode: true }), before = state(db); let closed = false;
  const ready = probe(db, { portalConfig: portal, closed: () => closed });
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.host, 'homecare.example.test'); assert.equal(req.url, '/ready'); assert.equal(req.method, 'GET');
    const result = ready(); res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`; assert.notEqual(server.address().port, 4310);
    assert.equal((await checkRuntimeReadiness({ url, publicOrigin: portal.publicOrigin })).exitCode, 0);
    closed = true; const result = await checkRuntimeReadiness({ url, publicOrigin: portal.publicOrigin }); assert.equal(result.exitCode, 1); assert(result.report.issues.includes('APPLICATION_CLOSED'));
    assert.equal(state(db), before);
  } finally { await new Promise(resolve => server.close(resolve)); db.close(); }
});

test('container configuration requires nonroot/private owned store and explicit production Portal policy', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'homecare-container-config-')); chmodSync(dir, 0o700);
  const environment = { NODE_ENV: 'production', HOME_CARE_AUTH_MODE: 'portal', HOME_CARE_PORTAL_ORIGIN: PORTAL_ORIGIN, HOME_CARE_PUBLIC_ORIGIN: portal.publicOrigin, HOME_CARE_PORTAL_SIGNING_SECRET: portal.signingSecret, HOME_CARE_STORAGE_DURABILITY: 'persistent', DATA_DIR: dir, PORT: '8080' };
  const uid = process.getuid();
  try {
    if (uid !== 0) { const config = containerConfiguration(environment); assert.equal(config.host, '0.0.0.0'); assert.equal(config.readinessOptions.requirePersistent, true); assert.equal(config.dbPath, path.join(dir, 'care.sqlite')); }
    for (const change of [{ HOME_CARE_AUTH_MODE: 'local' }, { HOME_CARE_STORAGE_DURABILITY: undefined }, { HOME_CARE_REQUIRE_PERSISTENT_STORAGE: '0' }, { NODE_ENV: 'test' }, { HOME_CARE_PUBLIC_ORIGIN: 'http://127.0.0.1:8080' }, { DATA_DIR: 'relative' }, { PORT: '4310' }, { PORT: '80' }]) assert.throws(() => containerConfiguration({ ...environment, ...change }, { uid }), /HOME_CARE_CONTAINER_CONFIGURATION_INVALID/);
    assert.throws(() => containerConfiguration(environment, { uid: 0 }), /HOME_CARE_CONTAINER_CONFIGURATION_INVALID/);
    chmodSync(dir, 0o755); assert.throws(() => containerConfiguration(environment, { uid }), /HOME_CARE_CONTAINER_/); assert.deepEqual(readdirSync(dir), []);
  } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true }); }
});

test('container candidate uses named copies, locked dependencies, private context exclusions and nonroot volume', () => {
  const docker = readFileSync(new URL('../ops/Dockerfile', import.meta.url), 'utf8');
  assert.match(docker, /FROM node:24-bookworm-slim/); assert.match(docker, /pnpm install --prod --frozen-lockfile --ignore-scripts/);
  assert.match(docker, /^USER node$/m); assert.match(docker, /^VOLUME \["\/var\/lib\/homecare"\]$/m);
  assert.match(docker, /HEALTHCHECK .*container-healthcheck\.mjs/);
  assert(!/^COPY\s+(?:--\S+\s+)*\.\s/m.test(docker)); assert(!docker.includes('SIGNING_SECRET='));
  const ignore = readFileSync(new URL('../ops/Dockerfile.dockerignore', import.meta.url), 'utf8').split('\n');
  for (const name of ['.env*', 'data', 'outputs', 'backups', 'node_modules', '**/*.sqlite', '**/.env*']) assert(ignore.includes(name));
});

test('container refuses pre-existing symlink, hardlink, insecure DB and sidecar before initialization', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'homecare-container-files-')); chmodSync(dir, 0o700);
  const env = { NODE_ENV: 'production', HOME_CARE_AUTH_MODE: 'portal', HOME_CARE_PORTAL_ORIGIN: PORTAL_ORIGIN, HOME_CARE_PUBLIC_ORIGIN: portal.publicOrigin, HOME_CARE_PORTAL_SIGNING_SECRET: portal.signingSecret, HOME_CARE_STORAGE_DURABILITY: 'persistent', DATA_DIR: dir };
  const uid = process.getuid(), filename = path.join(dir, 'care.sqlite'), reference = path.join(dir, 'untouched-synthetic.sqlite');
  try {
    writeFileSync(reference, 'synthetic-file-remains-unchanged', { mode: 0o600 });
    const before = sha(readFileSync(reference));
    symlinkSync(reference, filename); assert.throws(() => containerConfiguration(env, { uid }), /HOME_CARE_CONTAINER_/); unlinkSync(filename);
    linkSync(reference, filename); assert.throws(() => containerConfiguration(env, { uid }), /HOME_CARE_CONTAINER_/); unlinkSync(filename);
    writeFileSync(filename, 'synthetic-not-initialized', { mode: 0o644 }); assert.throws(() => containerConfiguration(env, { uid }), /HOME_CARE_CONTAINER_/); chmodSync(filename, 0o600);
    symlinkSync(reference, filename + '-wal'); assert.throws(() => containerConfiguration(env, { uid }), /HOME_CARE_CONTAINER_/);
    assert.equal(sha(readFileSync(reference)), before); assert.equal(readFileSync(filename, 'utf8'), 'synthetic-not-initialized');
  } finally { rmSync(dir, { recursive: true }); }
});

test('journal startup guard accepts owned 0600 and rejects alias, mode and owner before any database constructor', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'homecare-container-journal-')); chmodSync(dir, 0o700);
  const filename = path.join(dir, 'care.sqlite'), journal = filename + '-journal', reference = path.join(dir, 'untouched-synthetic.txt');
  const script = new URL('../ops/container-start.mjs', import.meta.url);
  const env = { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'production', HOME_CARE_AUTH_MODE: 'portal', HOME_CARE_PORTAL_ORIGIN: PORTAL_ORIGIN,
    HOME_CARE_PUBLIC_ORIGIN: portal.publicOrigin, HOME_CARE_PORTAL_SIGNING_SECRET: portal.signingSecret,
    HOME_CARE_REQUIRE_PERSISTENT_STORAGE: '1', HOME_CARE_STORAGE_DURABILITY: 'persistent', HOME_CARE_MIN_FREE_BYTES: '0', DATA_DIR: dir, PORT: '8080' };
  const child = String.raw`
    import fs from 'node:fs';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    import { fileURLToPath } from 'node:url';
    const script = new URL(process.env.SYNTHETIC_CONTAINER_MODULE);
    // The native SQLite binding is not loaded in this child. Any attempt to
    // construct it is intercepted before a real database could be opened.
    registerHooks({
      resolve(specifier, context, nextResolve) {
        return specifier === 'node:sqlite' ? { url: 'synthetic:sqlite-preopen-guard', shortCircuit: true } : nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        if (url !== 'synthetic:sqlite-preopen-guard') return nextLoad(url, context);
        return { format: 'module', shortCircuit: true, source: 'export class DatabaseSync { constructor() { console.error("SYNTHETIC_DATABASE_CONSTRUCTOR_CALLED"); throw new Error("Owned preopen guard must not open a database"); } }' };
      },
    });
    if (process.env.SYNTHETIC_JOURNAL_FOREIGN_OWNER === '1') {
      const original = fs.lstatSync;
      fs.lstatSync = filename => {
        const stat = original(filename);
        if (filename !== process.env.SYNTHETIC_JOURNAL_PATH) return stat;
        const metadata = Object.create(stat);
        Object.defineProperty(metadata, 'uid', { value: stat.uid + 1 });
        return metadata;
      };
    }
    syncBuiltinESMExports();
    if (process.env.SYNTHETIC_GUARD_MODE === 'configuration') {
      const { containerConfiguration } = await import(script.href);
      try { containerConfiguration(process.env); console.log('SYNTHETIC_PREOPEN_GUARD_PASSED'); }
      catch { console.error('SYNTHETIC_PREOPEN_GUARD_REFUSED'); process.exitCode = 1; }
    } else {
      process.argv[1] = fileURLToPath(script);
      await import(script.href);
    }
  `;
  const run = (extra = {}) => spawnSync(process.execPath, ['--input-type=module', '--eval', child], {
    env: { ...env, SYNTHETIC_CONTAINER_MODULE: script.href, SYNTHETIC_JOURNAL_PATH: journal, ...extra }, encoding: 'utf8', timeout: 10000,
  });
  const exactStore = () => Object.fromEntries(readdirSync(dir).sort().map(name => [name, sha(readFileSync(path.join(dir, name)))]));
  const outcomes = [];
  try {
    writeFileSync(filename, 'synthetic-main-not-a-database', { mode: 0o600 });
    writeFileSync(reference, 'synthetic-reference-must-remain-untouched', { mode: 0o600 });
    writeFileSync(journal, 'synthetic-journal-not-a-database', { mode: 0o600 });
    let before = exactStore(), result = run({ SYNTHETIC_GUARD_MODE: 'configuration' });
    assert.equal(result.status, 0, 'Owned ordinary 0600 journal passes the actual guard'); assert.equal(result.signal, null);
    assert.equal(result.stdout.trim(), 'SYNTHETIC_PREOPEN_GUARD_PASSED');
    assert(!result.stderr.includes('SYNTHETIC_DATABASE_CONSTRUCTOR_CALLED')); assert.deepEqual(exactStore(), before);
    outcomes.push({ journal: 'owned-0600', nativeExit: result.status, databaseConstructorCalled: false }); unlinkSync(journal);
    for (const kind of ['symlink', 'hardlink', 'wrong-mode', 'foreign-owner-metadata']) {
      if (kind === 'symlink') symlinkSync(reference, journal);
      else if (kind === 'hardlink') linkSync(reference, journal);
      else writeFileSync(journal, 'synthetic-journal-not-a-database', { mode: kind === 'wrong-mode' ? 0o644 : 0o600 });
      before = exactStore(); result = run(kind === 'foreign-owner-metadata' ? { SYNTHETIC_JOURNAL_FOREIGN_OWNER: '1' } : {});
      assert.equal(result.status, 1, kind + ': unsafe actual startup exits 1'); assert.equal(result.signal, null);
      assert(result.stderr.includes('HOME_CARE_CONTAINER_STARTUP_REFUSED'), kind + ': only fixed startup diagnostic');
      assert(!result.stderr.includes('SYNTHETIC_DATABASE_CONSTRUCTOR_CALLED'), kind + ': rejected before any SQLite constructor');
      assert(!result.stdout.includes('HOME_CARE_CONTAINER_LISTENING'));
      assert(!result.stderr.includes(portal.signingSecret)); assert(!result.stderr.includes(dir));
      assert.deepEqual(exactStore(), before, kind + ': owned store and alias target unchanged');
      outcomes.push({ journal: kind, nativeExit: result.status, databaseConstructorCalled: false }); unlinkSync(journal);
    }
    console.log(JSON.stringify({ syntheticOnly: true, scope: 'owned-temp-journal-preopen-guard', outcomes, ownerMetadataInjected: true, physicalOwnershipChanged: false, filesUnchanged: true }));
  } finally { rmSync(dir, { recursive: true }); }
});
