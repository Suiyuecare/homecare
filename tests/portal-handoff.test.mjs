import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync, symlinkSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/index.mjs';
import { initDb, insert, now } from '../src/server/model.mjs';
import { PORTAL_ORIGIN, PORTAL_ONLY_PASSWORD, HANDOFF_DESTINATION, normalizePortalConfig, portalConfigFromEnv, verifyPortalHandoffEnvelope, provisionPortalAccount, consumePortalHandoff, hasPortalStorage } from '../src/server/portal-handoff.mjs';
import { parseProvisionArguments, runProvision } from '../scripts/provision-portal-account.mjs';

// All identities, organizations, secrets and databases in this suite are synthetic.
// createApp receives explicit config; no test reads the deployment environment.
const SECRET = 'synthetic-unit-test-signing-key-only-2026';
const config = { mode: 'portal', publicOrigin: 'http://127.0.0.1:0', portalOrigin: PORTAL_ORIGIN, signingSecret: SECRET };
const identity = () => ({ organizationName: '合成測試機構', name: '合成管理者', email: 'owner.synthetic@example.invalid', issuer: PORTAL_ORIGIN, googleSubject: 'synthetic_google_001', authUserId: randomUUID(), role: 'admin' });
const claimsFor = (account, change = {}, seconds = Math.floor(Date.now() / 1000)) => ({ aud: 'home-care', moduleId: 'home-care', iss: account.issuer, googleSubject: account.googleSubject, authUserId: account.authUserId, email: account.email, iat: seconds, exp: seconds + 60, jti: randomUUID(), ...change });
const signBytes = (bytes, key = SECRET) => {
  const payload = Buffer.from(bytes).toString('base64url');
  return { payload, signature: createHmac('sha256', key).update(payload, 'ascii').digest('base64url') };
};
const sign = (claims, key = SECRET) => signBytes(JSON.stringify(claims), key);
const code = expected => error => error?.code === expected;
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const schemaCounts = db => ({ tables: countSchema(db, 'table'), triggers: countSchema(db, 'trigger') });
const countSchema = (db, type) => db.prepare('SELECT count(*) AS n FROM sqlite_schema WHERE type=? AND name NOT LIKE ?').get(type, 'sqlite_%').n;
const stateCounts = db => Object.fromEntries(['organizations', 'users', 'memberships', 'portal_identity_bindings', 'portal_handoff_nonces', 'sessions', 'audit'].map(table => [table, count(db, table)]));
const temporary = t => { const dir = mkdtempSync(path.join(os.tmpdir(), 'care-portal-synthetic-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const provisionArgs = (dbPath, account) => [ '--db-path', dbPath, '--organization-name', account.organizationName, '--name', account.name, '--email', account.email,
  '--issuer', account.issuer, '--google-subject', account.googleSubject, '--portal-auth-user-id', account.authUserId, '--role', account.role ];

function legacyDatabase(file, account, { passwordHash = 'legacy-password-hash', role = 'admin', omitUser = false, failingTrigger = false } = {}) {
  const db = new DatabaseSync(file), orgId = randomUUID(), userId = randomUUID(), recordId = randomUUID();
  // Historical four-table store: an existing record has no version baseline and
  // persistent DELETE journal mode. Never call initDb while building this fixture.
  db.exec(`PRAGMA journal_mode=DELETE;
    CREATE TABLE organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE memberships(org_id TEXT NOT NULL REFERENCES organizations(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,employee_id TEXT,PRIMARY KEY(org_id,user_id));
    CREATE TABLE records(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),entity TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`);
  db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(orgId, account.organizationName, now());
  if (!omitUser) {
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(userId, account.name, account.email, passwordHash, now());
    db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(orgId, userId, role, null);
  }
  db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(recordId, orgId, 'cases', JSON.stringify({ name: '合成舊個案', caseNo: 'LEGACY-01', status: 'active' }), 1, now(), now());
  if (failingTrigger) db.exec("CREATE TRIGGER synthetic_legacy_failure BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT,'synthetic legacy failure'); END;");
  db.close();
}

function diskSnapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  let database;
  try {
    const schema = db.prepare('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema ORDER BY type,name').all();
    const contents = Object.fromEntries(schema.filter(entry => entry.type === 'table').map(entry => [entry.name, db.prepare(`SELECT * FROM "${entry.name}" ORDER BY rowid`).all()]));
    database = { schema, contents, journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode, pages: db.prepare('PRAGMA page_count').get().page_count, schemaVersion: db.prepare('PRAGMA schema_version').get().schema_version };
  } finally { db.close(); }
  return { ...database, bytes: readFileSync(file), mode: statSync(file).mode & 0o777, files: readdirSync(path.dirname(file)).sort() };
}

function invokeProvision(file, account) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/provision-portal-account.mjs', import.meta.url)), ...provisionArgs(file, account)], {
    encoding: 'utf8', env: { NODE_NO_WARNINGS: '1' }, timeout: 10000,
  });
}

function httpRequest(base, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = http.request({ hostname: url.hostname, port: url.port, path: route, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value = text;
        try { value = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, value });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function fixture(t, options = {}) {
  const app = createApp({ dbPath: options.dbPath || ':memory:', port: 0, portalConfig: { ...config, ...options.portalConfig } });
  t.after(() => app.close());
  const account = options.account || identity();
  const provisioned = options.skipProvision ? null : provisionPortalAccount(app.db, account);
  const base = await app.listen();
  const fixed = normalizePortalConfig({ ...config, ...options.portalConfig });
  const publicOrigin = fixed.dynamicLoopbackPort ? base : fixed.publicOrigin;
  const host = new URL(publicOrigin).host;
  const request = (route, opts = {}) => httpRequest(base, route, { ...opts, headers: { Host: host, ...opts.headers } });
  const handoff = (envelope = sign(claimsFor(account)), opts = {}) => request('/api/auth/handoff', {
    method: 'POST', body: new URLSearchParams(envelope).toString(), ...opts,
    headers: { Origin: PORTAL_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded', ...opts.headers },
  });
  const authenticate = async (change = {}) => {
    const response = await handoff(sign(claimsFor(account, change)));
    assert.equal(response.status, 303, response.text);
    const cookie = response.headers['set-cookie'][0].split(';')[0];
    const result = await request('/api/session', { headers: { Cookie: cookie } });
    return { response, cookie, payload: result.value, orgId: provisioned.organizationId };
  };
  return { app, account, provisioned, base, host, publicOrigin, request, handoff, authenticate };
}

test('Portal configuration is explicit and imported local defaults preserve the eleven-table schema', async t => {
  const previous = process.env.HOME_CARE_AUTH_MODE;
  process.env.HOME_CARE_AUTH_MODE = 'portal';
  let local;
  try { local = createApp({ dbPath: ':memory:', port: 0 }); } finally {
    if (previous === undefined) delete process.env.HOME_CARE_AUTH_MODE; else process.env.HOME_CARE_AUTH_MODE = previous;
  }
  t.after(() => local.close());
  assert.deepEqual(schemaCounts(local.db), { tables: 11, triggers: 6 });
  const base = await local.listen();
  const status = await httpRequest(base, '/api/setup/status');
  assert.equal(status.value.authMode, 'local');
  assert.equal(status.value.needsSetup, true);
  assert.equal(status.value.portalLoginUrl, null);
  assert.equal(status.value.portalHomeUrl, PORTAL_ORIGIN + '/portal/');
  assert.deepEqual(portalConfigFromEnv({}), { mode: 'local' });
  assert.equal(portalConfigFromEnv({ HOME_CARE_AUTH_MODE: 'portal', HOME_CARE_PUBLIC_ORIGIN: config.publicOrigin, HOME_CARE_PORTAL_ORIGIN: PORTAL_ORIGIN, HOME_CARE_PORTAL_SIGNING_SECRET: SECRET }).mode, 'portal');
  const f = await fixture(t);
  assert.deepEqual(schemaCounts(f.app.db), { tables: 13, triggers: 6 });
  const portalStatus = (await f.request('/api/setup/status')).value;
  const loginUrl = new URL(portalStatus.portalLoginUrl);
  assert.equal(portalStatus.authMode, 'portal');
  assert.equal(portalStatus.needsSetup, false);
  assert.equal(loginUrl.origin, PORTAL_ORIGIN);
  assert.equal(loginUrl.pathname, '/portal/');
  assert.equal(loginUrl.searchParams.get('module'), 'home-care');
  assert.equal(loginUrl.searchParams.get('next'), f.base + HANDOFF_DESTINATION);
  assert.ok(!JSON.stringify(portalStatus).includes(SECRET));
});

test('Portal config rejects unsafe origins, credentials, noncanonical origins and short secrets', () => {
  for (const change of [
    { publicOrigin: 'http://external.example.invalid' }, { publicOrigin: 'https://care.example.invalid/path' },
    { publicOrigin: 'https://care.example.invalid/' }, { publicOrigin: 'https://user:pass@care.example.invalid' },
    { publicOrigin: 'https://care.example.invalid?secret=anything' }, { publicOrigin: 'https://care.example.invalid#/' },
    { publicOrigin: 'https://care.example.invalid:0' }, { publicOrigin: PORTAL_ORIGIN },
    { portalOrigin: PORTAL_ORIGIN + '/' }, { portalOrigin: 'https://evil.example.invalid' },
    { signingSecret: 'short' }, { signingSecret: SECRET + '\n' }, { mode: 'unknown' },
  ]) assert.throws(() => normalizePortalConfig({ ...config, ...change }), /HOME_CARE_PORTAL_CONFIGURATION_INVALID/);
  assert.throws(() => portalConfigFromEnv({ HOME_CARE_AUTH_MODE: 'portal' }), /HOME_CARE_PORTAL_CONFIGURATION_INVALID/);
  assert.equal(normalizePortalConfig(config).dynamicLoopbackPort, true);
  assert.equal(normalizePortalConfig({ ...config, publicOrigin: 'https://care.example.invalid' }).secureCookie, true);
});

test('HMAC envelope accepts only the signed nine-field home-care identity with bounded time', () => {
  const account = identity(), seconds = 1900000000, valid = claimsFor(account, {}, seconds), normalized = normalizePortalConfig(config);
  assert.deepEqual(verifyPortalHandoffEnvelope(sign(valid), normalized, seconds), valid);
  for (const change of [
    { aud: 'apm' }, { moduleId: 'day-care' }, { iss: PORTAL_ORIGIN + '/' }, { googleSubject: '' },
    { authUserId: 'not-uuid' }, { authUserId: valid.authUserId.toUpperCase() }, { email: 'Owner.Synthetic@example.invalid' },
    { email: ' ' + account.email }, { email: 'not-email' }, { iat: seconds + 31 }, { iat: -1 },
    { iat: seconds + 0.5 }, { iat: String(seconds) }, { exp: seconds }, { exp: seconds + 601 },
    { exp: Infinity }, { jti: 'not-uuid' }, { role: 'admin' }, { returnTo: '/#/' }, { unknown: true },
  ]) assert.throws(() => verifyPortalHandoffEnvelope(sign({ ...valid, ...change }), normalized, seconds), error => ['HANDOFF_INVALID', 'HANDOFF_EXPIRED'].includes(error.code));
  const { googleSubject, ...missing } = valid;
  assert.throws(() => verifyPortalHandoffEnvelope(sign(missing), normalized, seconds), code('HANDOFF_INVALID'));
  assert.throws(() => verifyPortalHandoffEnvelope(sign({ ...valid, iat: seconds - 60, exp: seconds }), normalized, seconds), code('HANDOFF_EXPIRED'));
  assert.equal(verifyPortalHandoffEnvelope(sign({ ...valid, exp: seconds + 600 }), normalized, seconds).exp, seconds + 600);
  assert.equal(verifyPortalHandoffEnvelope(sign({ ...valid, iat: seconds + 30, exp: seconds + 90 }), normalized, seconds).iat, seconds + 30);
});

test('Envelope rejects tampering, incorrect key, extra fields, malformed UTF-8 and noncanonical base64url', () => {
  const normalized = normalizePortalConfig(config), valid = claimsFor(identity()), signed = sign(valid);
  assert.throws(() => verifyPortalHandoffEnvelope(sign(valid, SECRET + '-wrong'), normalized), code('HANDOFF_INVALID'));
  assert.throws(() => verifyPortalHandoffEnvelope({ ...signed, payload: sign({ ...valid, email: 'attacker@example.invalid' }).payload }, normalized), code('HANDOFF_INVALID'));
  assert.throws(() => verifyPortalHandoffEnvelope({ ...signed, extra: true }, normalized), code('HANDOFF_INVALID'));
  for (const bytes of [Buffer.from([0xc0, 0xaf]), Buffer.from('{"iat":'), Buffer.from('null'), Buffer.from('[]')]) assert.throws(() => verifyPortalHandoffEnvelope(signBytes(bytes), normalized), code('HANDOFF_INVALID'));
  assert.throws(() => verifyPortalHandoffEnvelope({ ...signed, payload: signed.payload + '=' }, normalized), code('HANDOFF_INVALID'));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alteredLast = alphabet[alphabet.indexOf(signed.signature.at(-1)) + 1];
  const noncanonical = { ...signed, signature: signed.signature.slice(0, -1) + alteredLast };
  assert.deepEqual(Buffer.from(noncanonical.signature, 'base64url'), Buffer.from(signed.signature, 'base64url'));
  assert.throws(() => verifyPortalHandoffEnvelope(noncanonical, normalized), code('HANDOFF_INVALID'));
  // A one-byte encoding has pad bits: Zh decodes as f, but is not canonical Zg.
  const payload = 'Zh';
  assert.throws(() => verifyPortalHandoffEnvelope({ payload, signature: createHmac('sha256', SECRET).update(payload).digest('base64url') }, normalized), code('HANDOFF_INVALID'));
});

test('Successful handoff creates a module session, hashes its cookie token and audits only bounded facts', async t => {
  const f = await fixture(t), session = await f.authenticate();
  assert.equal(session.response.headers.location, '/#/');
  assert.equal(session.response.text, '');
  assert.match(session.response.headers['set-cookie'][0], /^suiyue_session=[a-f0-9]{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=28800$/);
  assert.equal(session.payload.user.email, f.account.email);
  assert.equal(session.payload.user.role, 'admin');
  assert.equal(session.payload.authMode, 'portal');
  assert.equal(session.payload.organizations.length, 1);
  assert.equal(session.payload.organizations[0].id, f.provisioned.organizationId);
  const token = session.cookie.slice('suiyue_session='.length), stored = f.app.db.prepare('SELECT * FROM sessions').get();
  assert.equal(stored.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.notEqual(stored.token_hash, token);
  assert.equal(stored.user_id, f.provisioned.userId);
  assert.ok(stored.expires_at > Date.now() + 7 * 3600e3);
  const audit = f.app.db.prepare("SELECT * FROM audit WHERE action='portal.login'").get();
  assert.deepEqual(JSON.parse(audit.detail), { identityVerified: true, role: 'admin' });
  assert.ok(!audit.detail.includes(f.account.googleSubject));
  assert.ok(!audit.detail.includes(f.account.email));
  assert.equal((await f.request('/api/cases', { headers: { Cookie: session.cookie, 'X-Org-Id': session.orgId } })).status, 200);
  assert.equal((await f.request('/#/', { headers: { Cookie: session.cookie } })).status, 200);
});

test('HTTPS Portal cookie is Secure and Lax; local setup retains Strict cookie', async t => {
  const f = await fixture(t, { portalConfig: { publicOrigin: 'https://home-care.synthetic.invalid' } });
  const session = await f.authenticate();
  assert.match(session.response.headers['set-cookie'][0], /^suiyue_session=[a-f0-9]{64}; HttpOnly; SameSite=Lax; Path=\/; Secure; Max-Age=28800$/);
  const logout = await f.request('/api/logout', { method: 'POST', headers: { Cookie: session.cookie, Origin: f.publicOrigin, 'X-CSRF-Token': session.payload.csrfToken } });
  assert.equal(logout.status, 200);
  assert.equal(logout.headers['set-cookie'][0], 'suiyue_session=; HttpOnly; SameSite=Lax; Path=/; Secure; Max-Age=0');
  const local = createApp({ dbPath: ':memory:', port: 0 }); t.after(() => local.close());
  const base = await local.listen();
  const result = await httpRequest(base, '/api/setup', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationName: '合成本機機構', name: '合成本機者', email: 'local@example.invalid', password: 'synthetic-local-password' }) });
  assert.equal(result.status, 201);
  assert.equal(Object.hasOwn(result.value, 'authMode'), false);
  assert.match(result.headers['set-cookie'][0], /^suiyue_session=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800$/);
});

test('Trusted Portal Origin exception applies only to exact handoff POST; regular writes retain Origin and CSRF', async t => {
  const f = await fixture(t), envelope = sign(claimsFor(f.account));
  for (const origin of [undefined, 'null', 'https://evil.example.invalid', PORTAL_ORIGIN + '/', f.publicOrigin]) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (origin !== undefined) headers.Origin = origin;
    const denied = await f.request('/api/auth/handoff', { method: 'POST', headers, body: new URLSearchParams(envelope).toString() });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers['set-cookie'], undefined);
  }
  assert.equal((await f.handoff(envelope, { headers: { Host: 'evil.example.invalid' } })).status, 403);
  for (const route of ['/api/auth/handoff?next=evil', '/api/auth/%68andoff', '/api/auth/handoff/', '/api/login', '/api/setup']) {
    assert.equal((await f.request(route, { method: 'POST', headers: { Origin: PORTAL_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(envelope).toString() })).status, 403);
  }
  assert.equal((await f.request('/api/auth/handoff')).status, 405);
  assert.equal((await f.request('/api/auth/handoff?x=1', { method: 'POST', headers: { Origin: f.publicOrigin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(envelope).toString() })).status, 405);
  for (const route of ['/api/login', '/api/setup']) {
    const result = await f.request(route, { method: 'POST', headers: { Origin: f.publicOrigin, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(result.status, 403); assert.equal(result.value.error.code, 'PORTAL_LOGIN_REQUIRED');
  }
  assert.equal(count(f.app.db, 'portal_handoff_nonces'), 0);
  const session = await f.authenticate();
  const headers = { Cookie: session.cookie, Origin: f.publicOrigin, 'X-Org-Id': session.orgId, 'Content-Type': 'application/json' };
  assert.equal((await f.request('/api/cases', { method: 'POST', headers, body: JSON.stringify({ name: '合成個案', caseNo: 'SYN-01' }) })).value.error.code, 'CSRF_INVALID');
  assert.equal((await f.request('/api/cases', { method: 'POST', headers: { ...headers, Origin: PORTAL_ORIGIN, 'X-CSRF-Token': session.payload.csrfToken }, body: '{}' })).value.error.code, 'ORIGIN_FORBIDDEN');
  const created = await f.request('/api/cases', { method: 'POST', headers: { ...headers, 'X-CSRF-Token': session.payload.csrfToken }, body: JSON.stringify({ name: '合成個案', caseNo: 'SYN-01' }) });
  assert.equal(created.status, 201);
});

test('Portal administrators can view accounts but cannot create local-password users or additional organizations', async t => {
  const f = await fixture(t), session = await f.authenticate(), baseline = stateCounts(f.app.db);
  const headers = { Cookie: session.cookie, Origin: f.publicOrigin, 'X-Org-Id': session.orgId, 'X-CSRF-Token': session.payload.csrfToken, 'Content-Type': 'application/json' };
  assert.equal((await f.request('/api/users', { headers })).status, 200);
  for (const route of ['/api/users', '/api/organizations']) {
    const denied = await f.request(route, { method: 'POST', headers, body: '{}' });
    assert.equal(denied.status, 403);
    assert.equal(denied.value.error.code, 'PORTAL_ACCOUNT_MANAGED');
    assert.deepEqual(stateCounts(f.app.db), baseline);
  }
});

test('Handoff rejects JSON, duplicated/extra form fields, malformed encoding and bounded-body overflow', async t => {
  const f = await fixture(t), envelope = sign(claimsFor(f.account)), encoded = new URLSearchParams(envelope).toString();
  const bad = [
    { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope), status: 415 },
    { body: encoded + '&role=admin', status: 401 },
    { body: 'payload=' + envelope.payload + '&payload=' + envelope.payload, status: 401 },
    { body: encoded + '&', status: 401 },
    { body: 'payload=%FF&signature=' + envelope.signature, status: 401 },
    { body: Buffer.from([0xff, 0xfe]), status: 401 },
    { body: 'payload=' + 'x'.repeat(8192) + '&signature=' + envelope.signature, status: 413 },
    { headers: { 'Transfer-Encoding': 'chunked' }, body: 'x'.repeat(9000), status: 413 },
  ];
  for (const item of bad) {
    const response = await f.handoff(envelope, { ...(item.headers ? { headers: item.headers } : {}), body: item.body });
    assert.equal(response.status, item.status, response.text);
    assert.equal(response.headers['set-cookie'], undefined);
  }
  assert.equal(count(f.app.db, 'sessions'), 0);
  assert.equal(count(f.app.db, 'portal_handoff_nonces'), 0);
  assert.equal(count(f.app.db, 'audit'), 1);
});

test('Only the exact active issuer/subject/auth UUID/email binding and fresh membership can enter', async t => {
  const f = await fixture(t), baseline = stateCounts(f.app.db);
  for (const change of [ { googleSubject: 'different_google_subject' }, { authUserId: randomUUID() }, { email: 'other@example.invalid' } ]) {
    const denied = await f.handoff(sign(claimsFor(f.account, change)));
    assert.equal(denied.status, 403);
    assert.equal(denied.value.error.code, 'PORTAL_IDENTITY_DENIED');
    assert.deepEqual(stateCounts(f.app.db), baseline);
  }
  f.app.db.prepare('UPDATE portal_identity_bindings SET active=0').run();
  assert.equal((await f.handoff()).status, 403);
  f.app.db.prepare('UPDATE portal_identity_bindings SET active=1').run();
  f.app.db.prepare('DELETE FROM memberships').run();
  assert.equal((await f.handoff()).status, 403);
  assert.equal(count(f.app.db, 'sessions'), 0);
  assert.equal(count(f.app.db, 'portal_handoff_nonces'), 0);
});

test('Active-binding and membership revocation invalidate existing Portal sessions on the next request', async t => {
  const f = await fixture(t), session = await f.authenticate();
  const checkRevoked = async () => {
    assert.equal((await f.request('/api/session', { headers: { Cookie: session.cookie } })).value.user, null);
    assert.equal((await f.request('/api/cases', { headers: { Cookie: session.cookie, 'X-Org-Id': session.orgId } })).status, 401);
  };
  f.app.db.prepare('UPDATE portal_identity_bindings SET active=0').run(); await checkRevoked();
  f.app.db.prepare('UPDATE portal_identity_bindings SET active=1').run();
  assert.equal((await f.request('/api/session', { headers: { Cookie: session.cookie } })).value.user.role, 'admin');
  f.app.db.prepare('UPDATE memberships SET role=?').run('finance');
  assert.equal((await f.request('/api/session', { headers: { Cookie: session.cookie } })).value.user.role, 'finance');
  assert.equal((await f.request('/api/users', { headers: { Cookie: session.cookie, 'X-Org-Id': session.orgId } })).status, 403);
  f.app.db.prepare('DELETE FROM memberships').run(); await checkRevoked();
});

test('Portal session cannot select any other organization even when an extra membership exists', async t => {
  const f = await fixture(t), session = await f.authenticate(), otherOrg = randomUUID();
  f.app.db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(otherOrg, '額外合成機構', now());
  f.app.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(otherOrg, f.provisioned.userId, 'admin', null);
  const result = await f.request('/api/session', { headers: { Cookie: session.cookie, 'X-Org-Id': otherOrg } });
  assert.deepEqual(result.value.organizations.map(org => org.id), [session.orgId]);
  assert.equal((await f.request('/api/cases', { headers: { Cookie: session.cookie, 'X-Org-Id': otherOrg } })).status, 403);
});

test('Unbound local sessions remain unusable in Portal mode', async t => {
  const f = await fixture(t), otherUser = randomUUID(), token = 'a'.repeat(64);
  f.app.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(otherUser, '合成舊帳號', 'legacy@example.invalid', 'local-password-hash', now());
  f.app.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(f.provisioned.organizationId, otherUser, 'admin', null);
  f.app.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), otherUser, 'b'.repeat(64), Date.now() + 3600e3);
  const headers = { Cookie: 'suiyue_session=' + token, 'X-Org-Id': f.provisioned.organizationId };
  assert.equal((await f.request('/api/session', { headers })).value.user, null);
  assert.equal((await f.request('/api/cases', { headers })).status, 401);
});

test('Replay is rejected; only successful fresh handoffs rotate a prior valid session', async t => {
  const f = await fixture(t), firstEnvelope = sign(claimsFor(f.account));
  const first = await f.handoff(firstEnvelope), oldCookie = first.headers['set-cookie'][0].split(';')[0];
  assert.equal(first.status, 303);
  const firstCounts = stateCounts(f.app.db);
  const replay = await f.handoff(firstEnvelope, { headers: { Cookie: oldCookie } });
  assert.equal(replay.status, 409); assert.equal(replay.value.error.code, 'HANDOFF_REPLAYED');
  assert.deepEqual(stateCounts(f.app.db), firstCounts);
  assert.equal((await f.request('/api/session', { headers: { Cookie: oldCookie } })).value.user.id, f.provisioned.userId);
  const denied = await f.handoff(sign(claimsFor(f.account, { authUserId: randomUUID() })), { headers: { Cookie: oldCookie } });
  assert.equal(denied.status, 403); assert.deepEqual(stateCounts(f.app.db), firstCounts);
  const second = await f.handoff(sign(claimsFor(f.account)), { headers: { Cookie: oldCookie } });
  assert.equal(second.status, 303);
  const newCookie = second.headers['set-cookie'][0].split(';')[0];
  assert.notEqual(oldCookie, newCookie);
  assert.equal(count(f.app.db, 'sessions'), 1);
  assert.equal(count(f.app.db, 'portal_handoff_nonces'), 2);
  assert.equal((await f.request('/api/session', { headers: { Cookie: oldCookie } })).value.user, null);
  assert.equal((await f.request('/api/session', { headers: { Cookie: newCookie } })).value.user.id, f.provisioned.userId);
});

test('A session failure atomically rolls nonce/audit/rotation back and the same assertion can be retried', async t => {
  const f = await fixture(t), session = await f.authenticate(), envelope = sign(claimsFor(f.account)), baseline = stateCounts(f.app.db);
  f.app.db.exec("CREATE TRIGGER synthetic_session_failure BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'synthetic-private-detail'); END;");
  const logs = [], previous = console.error;
  let failed;
  try { console.error = (...parts) => logs.push(parts.join(' ')); failed = await f.handoff(envelope, { headers: { Cookie: session.cookie } }); }
  finally { console.error = previous; }
  assert.equal(failed.status, 500);
  assert.equal(failed.headers['set-cookie'], undefined);
  assert.ok(!failed.text.includes('synthetic-private-detail'));
  assert.deepEqual(logs, ['Request failed: PORTAL_REQUEST_FAILED']);
  assert.deepEqual(stateCounts(f.app.db), baseline);
  assert.equal((await f.request('/api/session', { headers: { Cookie: session.cookie } })).value.user.id, f.provisioned.userId);
  f.app.db.exec('DROP TRIGGER synthetic_session_failure');
  const retried = await f.handoff(envelope, { headers: { Cookie: session.cookie } });
  assert.equal(retried.status, 303);
  assert.equal(count(f.app.db, 'sessions'), 1);
  assert.equal(count(f.app.db, 'portal_handoff_nonces'), baseline.portal_handoff_nonces + 1);
});

test('Persisted nonce prevents replay across app instances and restart; Portal DB cannot silently reopen local', async t => {
  const dbPath = path.join(temporary(t), 'care.sqlite'), account = identity();
  const first = await fixture(t, { dbPath, account }), envelope = sign(claimsFor(account));
  assert.equal((await first.handoff(envelope)).status, 303);
  const second = await fixture(t, { dbPath, account });
  assert.equal((await second.handoff(envelope)).status, 409);
  await first.app.close(); await second.app.close();
  assert.throws(() => createApp({ dbPath, port: 0 }), /HOME_CARE_PORTAL_MODE_REQUIRED/);
  const restarted = await fixture(t, { dbPath, account });
  assert.equal((await restarted.handoff(envelope)).value.error.code, 'HANDOFF_REPLAYED');
  assert.equal(count(restarted.app.db, 'portal_handoff_nonces'), 1);
  assert.equal(count(restarted.app.db, 'sessions'), 1);
});

test('Caregiver handoff requires a linked active employee in exactly the bound organization', async t => {
  const f = await fixture(t);
  f.app.db.prepare('UPDATE memberships SET role=?').run('caregiver');
  assert.equal((await f.handoff()).status, 403);
  const employee = insert(f.app.db, f.provisioned.organizationId, 'employees', { name: '合成居服員', employeeNo: 'SYN-E01', status: 'active' });
  f.app.db.prepare('UPDATE memberships SET employee_id=?').run(employee.id);
  const good = await f.handoff(); assert.equal(good.status, 303);
  f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ name: '合成居服員', employeeNo: 'SYN-E01', status: 'inactive' }), employee.id);
  assert.equal((await f.handoff()).status, 403);
});

test('Provisioning is explicit, idempotent, single-organization and never upgrades or changes a binding', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); initDb(db);
  const account = identity(), first = provisionPortalAccount(db, account), baseline = stateCounts(db);
  assert.equal(first.status, 'created');
  assert.equal(first.role, 'admin');
  assert.equal(db.prepare('SELECT password_hash FROM users').get().password_hash, PORTAL_ONLY_PASSWORD);
  const second = provisionPortalAccount(db, account);
  assert.deepEqual(second, { ...first, status: 'already-provisioned' });
  assert.deepEqual(stateCounts(db), baseline);
  for (const change of [
    { role: 'finance' }, { organizationName: '其他合成機構' }, { googleSubject: 'different_google_subject' },
    { authUserId: randomUUID() }, { email: 'replacement@example.invalid' }, { name: '其他合成姓名' },
  ]) {
    assert.throws(() => provisionPortalAccount(db, { ...account, ...change }), code('PORTAL_PROVISION_CONFLICT'));
    assert.deepEqual(stateCounts(db), baseline);
  }
  for (const change of [{ role: 'caregiver' }, { issuer: PORTAL_ORIGIN + '/' }, { email: 'OWNER@example.invalid' }, { googleSubject: '' }, { authUserId: 'bad' }, { extra: 'value' }]) {
    assert.throws(() => provisionPortalAccount(db, { ...account, ...change }), code('PORTAL_PROVISION_INVALID'));
    assert.deepEqual(stateCounts(db), baseline);
  }
  db.prepare('UPDATE portal_identity_bindings SET active=0').run();
  assert.throws(() => provisionPortalAccount(db, account), code('PORTAL_PROVISION_CONFLICT'));
});

test('Provision cannot hijack a local-password account and a failed transaction leaves no partial schema/account', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); initDb(db);
  const account = identity(), orgId = randomUUID(), userId = randomUUID();
  db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(orgId, account.organizationName, now());
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(userId, account.name, account.email, 'local-existing-hash', now());
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(orgId, userId, 'admin', null);
  assert.throws(() => provisionPortalAccount(db, account), code('PORTAL_PROVISION_CONFLICT'));
  assert.deepEqual(schemaCounts(db), { tables: 11, triggers: 6 });
  assert.equal(hasPortalStorage(db), false);
  assert.equal(db.prepare('SELECT password_hash FROM users').get().password_hash, 'local-existing-hash');
  const empty = new DatabaseSync(':memory:'); t.after(() => empty.close()); initDb(empty);
  empty.exec("CREATE TRIGGER synthetic_user_failure BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
  assert.throws(() => provisionPortalAccount(empty, identity()), /synthetic failure/);
  assert.equal(count(empty, 'organizations'), 0);
  assert.equal(count(empty, 'users'), 0);
  assert.equal(count(empty, 'memberships'), 0);
  assert.equal(count(empty, 'audit'), 0);
  assert.equal(hasPortalStorage(empty), false);
});

test('Provision CLI requires all exact flags, existing owned database and produces no identity/secret output', t => {
  const dir = temporary(t), dbPath = path.join(dir, 'care.sqlite'), account = identity();
  const args = [ '--db-path', dbPath, '--organization-name', account.organizationName, '--name', account.name, '--email', account.email,
    '--issuer', account.issuer, '--google-subject', account.googleSubject, '--portal-auth-user-id', account.authUserId, '--role', account.role ];
  assert.deepEqual(parseProvisionArguments(args), { dbPath, ...account });
  for (const invalid of [[], args.slice(2), [...args, '--role', 'admin'], ['--unknown', dbPath, ...args.slice(2)], ['--db-path', 'relative.sqlite', ...args.slice(2)], ['--db-path', dbPath, '--db-path', dbPath, ...args.slice(4)]]) {
    assert.throws(() => parseProvisionArguments(invalid), /PORTAL_PROVISION_ARGUMENTS_INVALID/);
  }
  assert.throws(() => runProvision(args), /ENOENT/);
  const db = new DatabaseSync(dbPath); initDb(db); db.close();
  const result = runProvision(args);
  assert.equal(result.status, 'created');
  assert.equal(runProvision(args).status, 'already-provisioned');
  assert.equal(statSync(dbPath).mode & 0o777, 0o600);
  for (const secret of [account.email, account.authUserId, account.googleSubject, SECRET]) assert.ok(!JSON.stringify(result).includes(secret));
  const linked = path.join(dir, 'linked.sqlite'); symlinkSync(dbPath, linked);
  assert.throws(() => runProvision(['--db-path', linked, ...args.slice(2)]), /PORTAL_PROVISION_DATABASE_INVALID/);
});

test('Consumed nonces and login audits roll back even when a session callback throws after writing', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); initDb(db);
  const account = identity(), provisioned = provisionPortalAccount(db, account), baseline = stateCounts(db), envelope = sign(claimsFor(account));
  assert.throws(() => consumePortalHandoff(db, normalizePortalConfig(config), envelope, () => {
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('a'.repeat(64), provisioned.userId, 'b'.repeat(64), Date.now() + 60e3);
    throw new Error('synthetic callback failure');
  }), /synthetic callback failure/);
  assert.deepEqual(stateCounts(db), baseline);
});

test('Real CLI conflict rejects a legacy store without changing schema, baselines, journal mode or file bytes', t => {
  const cases = [
    { label: 'organization-conflict', change: { organizationName: '不相符的合成機構' }, options: {} },
    { label: 'local-password-conflict', change: {}, options: {} },
    { label: 'membership-role-conflict', change: { role: 'finance' }, options: { passwordHash: PORTAL_ONLY_PASSWORD } },
  ];
  for (const example of cases) {
    const file = path.join(temporary(t), 'legacy.sqlite'), account = identity();
    legacyDatabase(file, account, example.options);
    const before = diskSnapshot(file);
    assert.equal(before.schema.filter(entry => entry.type === 'table').length, 4);
    assert.equal(before.contents.record_versions, undefined);
    assert.equal(before.journalMode, 'delete');
    const response = invokeProvision(file, { ...account, ...example.change });
    assert.equal(response.status, 2, example.label);
    assert.equal(response.stdout, '');
    assert.deepEqual(JSON.parse(response.stderr), { status: 'failed', code: 'PORTAL_PROVISION_CONFLICT' });
    assert.deepEqual(diskSnapshot(file), before, example.label);
  }
});

test('Real CLI invalid identity and SQL failure also leave legacy migration and baseline entirely uncommitted', t => {
  for (const failure of ['invalid-input', 'sql-after-migration']) {
    const file = path.join(temporary(t), 'legacy.sqlite'), account = identity();
    legacyDatabase(file, account, failure === 'sql-after-migration' ? { omitUser: true, failingTrigger: true } : {});
    const before = diskSnapshot(file);
    const response = invokeProvision(file, failure === 'invalid-input' ? { ...account, role: 'caregiver' } : account);
    assert.equal(response.status, 2, failure);
    assert.equal(response.stdout, '');
    assert.deepEqual(JSON.parse(response.stderr), { status: 'failed', code: failure === 'invalid-input' ? 'PORTAL_PROVISION_INVALID' : 'PORTAL_PROVISION_FAILED' });
    assert.deepEqual(diskSnapshot(file), before, failure);
  }
});

test('Real CLI success commits legacy migration, history baseline and binding together while preserving DELETE journal', t => {
  const file = path.join(temporary(t), 'legacy.sqlite'), account = identity();
  legacyDatabase(file, account, { omitUser: true });
  const response = invokeProvision(file, account);
  assert.equal(response.status, 0, response.stderr);
  assert.equal(response.stderr, '');
  const result = JSON.parse(response.stdout);
  assert.equal(result.status, 'created');
  const db = new DatabaseSync(file, { readOnly: true }); t.after(() => db.close());
  assert.deepEqual(schemaCounts(db), { tables: 13, triggers: 6 });
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  const baseline = db.prepare('SELECT * FROM record_versions').get();
  assert.equal(baseline.source, 'baseline');
  assert.equal(baseline.version, 1);
  assert.equal(count(db, 'users'), 1);
  assert.equal(count(db, 'memberships'), 1);
  assert.equal(count(db, 'portal_identity_bindings'), 1);
  assert.equal(count(db, 'audit'), 1);
  assert.equal(db.prepare('SELECT org_id FROM memberships').get().org_id, result.organizationId);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
