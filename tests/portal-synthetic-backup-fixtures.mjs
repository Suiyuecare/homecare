import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { constants, chmodSync, copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createApp } from '../src/server/index.mjs';
import * as legacy from '../src/server/synthetic-backup.mjs';
import * as portal from '../src/server/synthetic-portal-backup.mjs';
import { PORTAL_ORIGIN, PORTAL_ONLY_PASSWORD } from '../src/server/portal-handoff.mjs';
import { createSyntheticBackupFixture, syntheticClient } from './synthetic-backup-fixtures.mjs';

// Private synthetic test data only. All paths are factory-owned fixed slots;
// this helper never accepts source paths, accounts, environment or a fixed port.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const INSPECT = Symbol.for('nodejs.util.inspect.custom');
const hide = object => Object.defineProperties(object, {
  toJSON: { value() { throw new Error('Synthetic Portal fixture values are memory-only'); } },
  [INSPECT]: { value() { return '[Synthetic Portal fixture: values redacted]'; } },
});
const TABLES = ['attachment_files', 'audit', 'certification_attachment_files', 'demo_seeds', 'idempotency', 'memberships', 'organizations', 'portal_handoff_nonces', 'portal_identity_bindings', 'record_versions', 'records', 'sessions', 'users'];
const quote = identifier => {
  assert(/^[a-z_][a-z0-9_]*$/.test(identifier), 'Only model-defined identifiers are queried');
  return '"' + identifier + '"';
};

/** Independent fixture reader: full stored TEXT bytes survive embedded NUL. */
export function readPortalSyntheticRawState(db) {
  const schemaColumns = ['type', 'name', 'tbl_name', 'sql'];
  const projection = schemaColumns.flatMap((column, i) => [`typeof(${quote(column)}) AS k${i}`, `hex(CAST(${quote(column)} AS BLOB)) AS h${i}`]).join(',');
  const rows = db.prepare(`SELECT ${projection} FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
  const schema = rows.map(row => Object.fromEntries(schemaColumns.map((column, i) => [column, row['k' + i] === 'null' ? null : Buffer.from(row['h' + i], 'hex').toString('utf8')])));
  const typedSchema = { columns: schemaColumns, rows: rows.map(row => schemaColumns.map((_, i) => row['k' + i] === 'null' ? ['null'] : ['text-bytes', row['h' + i].toLowerCase()])) };
  const tables = {}, typedTables = {};
  for (const { name } of schema.filter(row => row.type === 'table')) {
    const columns = db.prepare('SELECT hex(CAST(name AS BLOB)) AS h FROM pragma_table_info(?) ORDER BY cid').all(name).map(row => Buffer.from(row.h, 'hex').toString('utf8'));
    const selected = columns.flatMap((column, i) => [`typeof(${quote(column)}) AS k${i}`, `CASE WHEN typeof(${quote(column)})='text' THEN hex(CAST(${quote(column)} AS BLOB)) ELSE NULL END AS h${i}`, `CASE WHEN typeof(${quote(column)})='text' THEN NULL ELSE ${quote(column)} END AS v${i}`]).join(',');
    const statement = db.prepare(`SELECT ${selected} FROM ${quote(name)}`); statement.setReadBigInts(true);
    const paired = statement.all().map(row => {
      const typed = columns.map((_, i) => {
        const kind = row['k' + i], value = row['v' + i];
        if (kind === 'null') return ['null'];
        if (kind === 'text') return ['text-bytes', row['h' + i].toLowerCase()];
        if (kind === 'integer') { assert.equal(typeof value, 'bigint'); return ['integer', value.toString()]; }
        if (kind === 'real') { assert.equal(typeof value, 'number'); const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); return ['real', bytes.toString('hex')]; }
        if (kind === 'blob') { assert(ArrayBuffer.isView(value)); return ['blob', Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex')]; }
        throw new Error('Unsupported synthetic stored SQLite value');
      });
      const plain = Object.fromEntries(columns.map((column, i) => {
        const kind = row['k' + i], value = row['v' + i];
        return [column, kind === 'text' ? Buffer.from(row['h' + i], 'hex').toString('utf8') : kind === 'blob' ? Buffer.from(value) : typeof value === 'bigint' && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value];
      }));
      return { typed, plain, key: JSON.stringify(typed) };
    }).sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
    tables[name] = paired.map(row => row.plain);
    typedTables[name] = { columns, rows: paired.map(row => row.typed) };
  }
  assert.deepEqual(Object.keys(tables).sort(), TABLES);
  assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
  return hide({ schema, typedSchema, tables, typedTables, userVersion: db.prepare('PRAGMA user_version').get().user_version, applicationId: db.prepare('PRAGMA application_id').get().application_id });
}

const countersFor = db => ({ totalChanges: db.prepare('SELECT total_changes() AS n').get().n,
  ...Object.fromEntries(['records', 'record_versions', 'audit', 'idempotency', 'sessions', 'portal_identity_bindings', 'portal_handoff_nonces'].map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get().n])) });

/**
 * The legacy seed is created in a separate legacy capability, then closed before
 * an exclusive copy into this Portal capability. Neither facade is weakened.
 * closeSource() closes only the initial HTTP source app. createAppForSlot() can
 * reopen a fixed slot with the same memory signing key and a caller's loopback
 * HTTPS origin; no open connection is itself claimed to be read-only.
 */
export async function createSyntheticPortalBackupFixture({ workspace }) {
  const sourcePath = portal.syntheticDatabasePath(workspace, 'source');
  const seedWorkspace = legacy.createSyntheticWorkspace();
  let seed, app, base;
  const opened = new Set();
  try {
    seed = await createSyntheticBackupFixture({ workspace: seedWorkspace });
    await seed.close();
    const seedPath = legacy.syntheticDatabasePath(seedWorkspace, 'source');
    for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(existsSync(seedPath + suffix), false, 'Legacy seed is closed before the exclusive copy');
    copyFileSync(seedPath, sourcePath, constants.COPYFILE_EXCL); chmodSync(sourcePath, 0o600);
    legacy.disposeSyntheticWorkspace(seedWorkspace);

    const portalConfig = hide({ mode: 'portal', publicOrigin: 'http://127.0.0.1:0', portalOrigin: PORTAL_ORIGIN, signingSecret: randomBytes(48).toString('hex') });
    app = createApp({ dbPath: sourcePath, host: '127.0.0.1', port: 0, portalConfig }); opened.add(app);
    assert.equal(app.db.prepare('SELECT total_changes() AS n').get().n, 0, 'Healthy legacy data plus Portal schema startup has zero logical row writes');
    base = await app.listen();
    const writeLedger = [], actors = {}, identities = hide({});
    const written = async (label, work) => {
      const before = countersFor(app.db), result = await work(), after = countersFor(app.db);
      assert(after.totalChanges > before.totalChanges, `${label} accounts actual logical writes`);
      writeLedger.push({ label, before, after, changes: after.totalChanges - before.totalChanges });
      return result;
    };
    await written('synthetic-INSERT-only-five-independent-Portal-identities', async () => {
      const timestamp = new Date().toISOString();
      for (const role of ['admin', 'supervisor', 'finance', 'caregiver', 'inactive']) {
        const identity = hide({ userId: randomUUID(), orgId: seed.orgId, role: role === 'inactive' ? 'admin' : role,
          name: '合成 Portal ' + role, email: `portal-backup-${role}@example.test`, issuer: PORTAL_ORIGIN,
          googleSubject: 'synthetic_backup_portal_' + role, authUserId: randomUUID(), active: role !== 'inactive' });
        identities[role] = identity;
        app.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(identity.userId, identity.name, identity.email, PORTAL_ONLY_PASSWORD, timestamp);
        app.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(seed.orgId, identity.userId, identity.role, role === 'caregiver' ? seed.items.employee.id : null);
        app.db.prepare('INSERT INTO portal_identity_bindings VALUES(?,?,?,?,?,?,?,?)').run(identity.issuer, identity.googleSubject, identity.authUserId, identity.email, identity.userId, seed.orgId, identity.active ? 1 : 0, timestamp);
      }
    });
    const mintHandoff = (role = 'admin', overrides = {}) => {
      assert(Object.hasOwn(identities, role), 'Only independent synthetic identities may be minted');
      const identity = identities[role], now = Math.floor(Date.now() / 1000);
      const claims = { aud: 'home-care', moduleId: 'home-care', iss: identity.issuer, googleSubject: identity.googleSubject,
        authUserId: identity.authUserId, email: identity.email, iat: now, exp: now + 300, jti: randomUUID(), ...overrides };
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return hide({ payload, signature: createHmac('sha256', portalConfig.signingSecret).update(payload, 'ascii').digest('base64url') });
    };
    const normalHandoff = async (role = 'admin', { base: targetBase = base, overrides = {}, cookie = '', status = 303 } = {}) => {
      const target = new URL(targetBase);
      assert.equal(target.protocol, 'http:', 'Unit fixture HTTP transport is loopback-only; browser owns native HTTPS transport');
      assert.equal(target.hostname, '127.0.0.1'); assert(target.port && target.port !== '4310');
      const envelope = mintHandoff(role, overrides);
      const post = async () => {
        const response = await fetch(targetBase + '/api/auth/handoff', { method: 'POST', redirect: 'manual', headers: {
          Origin: PORTAL_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(envelope).toString() });
        assert.equal(response.status, status, 'Synthetic handoff retains receiver status rules');
        const nextCookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
        let auth = null, client = null;
        if (status === 303) {
          assert.equal(response.headers.get('location'), '/#/');
          client = syntheticClient(targetBase, 'Portal-' + role, { cookie: nextCookie });
          auth = await client.json('GET', 'session'); client.bindAuth(auth);
          assert.equal(auth.user.id, identities[role].userId);
          assert.equal(auth.organizations.find(org => org.id === seed.orgId)?.role, identities[role].role);
        }
        return hide({ response, envelope, cookie: nextCookie, auth, client });
      };
      return targetBase === base && status === 303 ? written('normal-api-Portal-handoff-' + role, post) : post();
    };
    for (const role of ['admin', 'supervisor', 'finance', 'caregiver']) {
      const login = await normalHandoff(role);
      actors[role] = hide({ ...login, user: identities[role], role, cookieJar: login.client });
    }

    app.db.exec('PRAGMA wal_autocheckpoint=0');
    const checkpoint = app.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    assert.equal(checkpoint.busy, 0); assert.equal(checkpoint.log, 0); assert.equal(checkpoint.checkpointed, 0);
    const beforeRaw = readPortalSyntheticRawState(app.db), beforeCounters = countersFor(app.db), mainHashAtCheckpoint = sha(readFileSync(sourcePath));
    const finalLogin = await normalHandoff('admin', { cookie: actors.admin.cookie });
    actors.admin = hide({ ...finalLogin, user: identities.admin, role: 'admin', cookieJar: finalLogin.client });
    const expiredToken = randomBytes(32).toString('hex'), expiredCsrf = randomBytes(32).toString('hex');
    const inactiveToken = randomBytes(32).toString('hex'), inactiveCsrf = randomBytes(32).toString('hex');
    const expiredNonceJti = randomUUID();
    await written('synthetic-INSERT-only-expired-session-inactive-session-and-expired-nonce-oracles', async () => {
      app.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(sha(expiredToken), identities.admin.userId, expiredCsrf, Date.now() - 60000);
      app.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(sha(inactiveToken), identities.inactive.userId, inactiveCsrf, Date.now() + 3600000);
      app.db.prepare('INSERT INTO portal_handoff_nonces VALUES(?,?,?,?,?,?)').run(expiredNonceJti, PORTAL_ORIGIN, identities.admin.userId, seed.orgId, Date.now() - 120000, Date.now() - 60000);
    });
    const walBytes = statSync(sourcePath + '-wal').size, mainHashAfterWalWrite = sha(readFileSync(sourcePath));
    assert(walBytes > 32); assert.equal(mainHashAfterWalWrite, mainHashAtCheckpoint, 'Portal committed state remains in WAL past a stale main-file copy');
    const rawState = readPortalSyntheticRawState(app.db), counters = countersFor(app.db);
    assert.equal(counters.totalChanges, writeLedger.reduce((sum, item) => sum + item.changes, 0), 'Portal fixture accounts startup separately from every row mutation');
    assert.equal(rawState.tables.portal_identity_bindings.length, 5);
    assert(rawState.tables.portal_handoff_nonces.length > beforeRaw.tables.portal_handoff_nonces.length);
    assert(rawState.tables.portal_identity_bindings.some(row => row.active === 0));
    assert(rawState.tables.portal_handoff_nonces.some(row => row.expires_at < Date.now()));
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM records r WHERE NOT EXISTS (SELECT 1 FROM record_versions v WHERE v.record_id=r.id AND v.version=r.version)').get().n, 0);
    // The report UI now explicitly requests complete dates. Freeze that exact
    // source DTO/CSV before restore, while the legacy fixture independently
    // retains its original saved-price and integer-cent assertions.
    const reportSpanMode = 'calendar-two-day-v1', frozenReports = {}, csvBytes = {};
    const reportCaptureBefore = readPortalSyntheticRawState(app.db), reportCaptureCounters = countersFor(app.db);
    for (const kind of ['fees', 'payroll']) {
      const legacyReport = seed.expected.frozenReports[kind];
      const expectedFullReport = { ...legacyReport, spanMode: reportSpanMode };
      if (kind === 'fees') {
        expectedFullReport.columns = [...legacyReport.columns];
        expectedFullReport.columns.splice(1, 0, { key: 'actualEndDate', label: '來源實際結束日期' });
        expectedFullReport.rows = legacyReport.rows.map(row => ({ ...row, actualEndDate: row.date }));
      }
      frozenReports[kind] = await actors.admin.client.json('GET', `reports/${kind}?month=${seed.month}&spanMode=${reportSpanMode}`, undefined, { orgId: seed.orgId });
      assert.deepEqual(frozenReports[kind], expectedFullReport, 'Exact complete-date source DTO retains the independent legacy saved prices, quantities, minutes, totals and note');
      const response = await actors.admin.client.response('GET', `reports/${kind}.csv?month=${seed.month}&spanMode=${reportSpanMode}`, undefined, { orgId: seed.orgId });
      assert.equal(response.status, 200);
      csvBytes[kind] = Buffer.from(await response.arrayBuffer());
    }
    assert.deepEqual(countersFor(app.db), reportCaptureCounters, 'Freezing full-mode source reports and CSV has zero logical writes');
    assert.deepEqual(readPortalSyntheticRawState(app.db), reportCaptureBefore, 'Freezing source reports preserves all thirteen typed tables and schema');
    const expected = hide({ rawState, frozenReports, histories: seed.expected.histories,
      csvBytes, caseBytes: seed.expected.caseBytes, certBytes: seed.expected.certBytes });
    const sourceCookies = hide(Object.fromEntries(Object.entries(actors).map(([role, actor]) => [role, actor.cookie])));
    const fixture = hide({ workspace, app, base, orgId: seed.orgId, foreignOrgId: seed.foreignOrgId, month: seed.month,
      items: seed.items, users: seed.users, identities, actors: hide(actors), sourceCookies, portalConfig, expected,
      snapshotReplayEnvelope: finalLogin.envelope,
      secrets: hide({ expiredCookie: `suiyue_session=${expiredToken}`, expiredCsrf, inactiveCookie: `suiyue_session=${inactiveToken}`, inactiveCsrf, expiredNonceJti }),
      writeLedger, counters, legacyWriteLedger: seed.writeLedger, legacyWalProof: seed.walProof,
      walProof: { checkpoint, mainHashAtCheckpoint, mainHashAfterWalWrite, walBytes, beforeCounters, afterCounters: counters },
      mintHandoff, normalHandoff,
      createAppForSlot(slot = 'live', { publicOrigin = 'http://127.0.0.1:0' } = {}) {
        const origin = new URL(publicOrigin);
        assert.equal(origin.hostname, '127.0.0.1'); assert(origin.port && origin.port !== '4310');
        assert(['http:', 'https:'].includes(origin.protocol));
        const result = createApp({ dbPath: portal.syntheticDatabasePath(workspace, slot), host: '127.0.0.1', port: 0,
          portalConfig: { ...portalConfig, publicOrigin } }); opened.add(result); return result;
      },
      readRawState() { return readPortalSyntheticRawState(app.db); },
      async closeSource() { await app.close(); opened.delete(app); },
      async close() { for (const running of opened) await running.close(); opened.clear(); },
    });
    return fixture;
  } catch (error) {
    for (const running of opened) await running.close();
    if (seed) await seed.close();
    try { legacy.disposeSyntheticWorkspace(seedWorkspace); } catch (cleanup) { if (cleanup.code !== 'WORKSPACE_INVALID') throw cleanup; }
    throw error;
  }
}
