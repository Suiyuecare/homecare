import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/index.mjs';
import { createSyntheticBackupFixture, readSyntheticRawState } from './synthetic-backup-fixtures.mjs';

const TABLES = ['attachment_files', 'audit', 'certification_attachment_files', 'demo_seeds', 'idempotency', 'memberships', 'organizations', 'record_versions', 'records', 'sessions', 'users'];
const PRIVATE = Symbol.for('nodejs.util.inspect.custom');
const redact = value => Object.defineProperties(value, {
  toJSON: { value() { throw new Error('Synthetic announcement fixture secrets are memory-only'); } },
  [PRIVATE]: { value() { return '[Synthetic announcement fixture: secrets redacted]'; } },
});
const countsFor = db => ({
  totalChanges: db.prepare('SELECT total_changes() AS n').get().n,
  tables: Object.fromEntries(TABLES.map(table => [table, db.prepare('SELECT count(*) AS n FROM ' + table).get().n])),
  tableCount: db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n,
  triggerCount: db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger'").get().n,
});

/** New v0.40 fixture; the sealed v0.39 fixture is composed without editing it. */
export async function createAnnouncementReadFixture({ workspace } = {}) {
  const baseFixture = workspace ? await createSyntheticBackupFixture({ workspace }) : null;
  const app = baseFixture?.app || createApp({ dbPath: ':memory:', host: '127.0.0.1', port: 0 });
  let base = baseFixture?.base;
  const password = baseFixture?.secrets.password || 'SyntheticAnnouncementRead-040!';
  const ledger = baseFixture ? baseFixture.writeLedger.map(entry => ({ ...entry, kind: 'base-039-normal-or-accounted-fixture', label: 'base039/' + entry.label })) : [];
  const baseFixtureChanges = baseFixture?.counters.totalChanges || 0;
  const clients = {}, actors = {};
  let serial = 0, orgId, foreignOrgId;
  const counts = () => countsFor(app.db);
  async function request(client, method, route, data, extraHeaders = {}) {
    assert(typeof route === 'string' && route.startsWith('/api/') && !route.includes('://') && !route.includes('..'), 'Only relative synthetic API routes are requested');
    const headers = { Origin: base,
      ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, 'X-Org-Id': client.org } : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders };
    for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key];
    const before = counts();
    const response = await fetch(base + route, { method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const bytes = Buffer.from(await response.arrayBuffer());
    const body = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8');
    const after = counts();
    const attemptedChanges = after.totalChanges - before.totalChanges;
    if (attemptedChanges) ledger.push({ kind: 'normal-api-attempt', label: method + ' ' + route, status: response.status, before, after, changes: attemptedChanges });
    return { status: response.status, body, bytes, headers: response.headers };
  }
  function clientFrom(result, selectedOrg, role) {
    const auth = result.body;
    return redact({ cookie: result.headers.get('set-cookie').split(';')[0], csrf: auth.csrfToken,
      org: selectedOrg, user: auth.user, role, auth });
  }
  async function create(entity, data, client = clients.admin) {
    const result = await request(client, 'POST', '/api/' + entity, data);
    assert.equal(result.status, 201, 'Synthetic normal create must succeed');
    return result.body.item;
  }
  async function patch(entity, item, data, client = clients.admin) {
    const result = await request(client, 'PATCH', `/api/${entity}/${item.id}`, { version: item.version, ...data });
    assert.equal(result.status, 200, 'Synthetic normal patch must succeed');
    return result.body.item;
  }
  async function ack(item, client = clients.admin, { key, version = item.version } = {}) {
    const result = await request(client, 'POST', `/api/announcements/${item.id}/read-state`, { version }, key === undefined ? {} : { 'Idempotency-Key': key });
    assert([200, 201].includes(result.status), 'Synthetic explicit acknowledgement must succeed');
    return result.body.receipt;
  }
  async function addUser(role, name) {
    const number = ++serial;
    const employee = role === 'caregiver' ? await create('employees', { name: name + '員工', employeeNo: 'ACK-E-' + number }) : null;
    const user = await create('users', { name, email: `ack-reader-${number}@example.test`, password, role,
      ...(employee ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email: user.email, password });
    assert.equal(login.status, 200, 'Synthetic normal reader login must succeed');
    const client = clientFrom(login, orgId, role);
    return { client, user, employee, role, auth: client.auth };
  }
  try {
    if (!base) base = await app.listen();
    assert(new URL(base).hostname === '127.0.0.1' && new URL(base).port !== '4310', 'Synthetic fixture uses random localhost');
    if (baseFixture) {
      orgId = baseFixture.orgId; foreignOrgId = baseFixture.foreignOrgId;
      for (const role of ['admin', 'supervisor', 'finance', 'caregiver']) {
        const old = baseFixture.actors[role];
        const client = redact({ cookie: old.client.cookie, csrf: old.auth.csrfToken, org: orgId, user: old.auth.user, role, auth: old.auth });
        clients[role] = client;
        actors[role] = redact({ client, user: client.user, employee: role === 'caregiver' ? baseFixture.items.employee : null, role, auth: client.auth });
      }
    } else {
      const setup = await request(null, 'POST', '/api/setup', { name: '合成公告回執管理員', email: 'ack-admin@example.test', password, organizationName: '合成回執甲機構' });
      assert.equal(setup.status, 201, 'Synthetic setup must succeed');
      orgId = setup.body.organizations[0].id;
      clients.admin = clientFrom(setup, orgId, 'admin');
      actors.admin = redact({ client: clients.admin, user: clients.admin.user, role: 'admin', auth: clients.admin.auth });
      for (const role of ['supervisor', 'finance', 'caregiver']) {
        const actor = await addUser(role, '合成回執' + role);
        actors[role] = redact(actor); clients[role] = actor.client;
      }
      foreignOrgId = (await create('organizations', { name: '合成回執乙機構' })).id;
    }
    const second = await addUser('caregiver', '合成回執第二居服員');
    actors.caregiver2 = redact(second); clients.caregiver2 = second.client;
    const announcementData = changes => ({ title: '  合成公告原標題🙂  ', body: '\n合成公告原文<script>literal</script>\n ', audience: 'all', status: 'published', ...changes });
    const announcements = {
      all: await create('announcements', announcementData()),
      caregiver: await create('announcements', announcementData({ title: '合成居服員公告', audience: 'caregiver' })),
      draft: await create('announcements', announcementData({ title: '合成草稿', status: 'draft' })),
      finance: await create('announcements', announcementData({ title: '合成財務保存對象', audience: 'finance' })),
      foreign: await create('announcements', announcementData({ title: '合成乙機構公告' }), { ...clients.admin, org: foreignOrgId }),
    };
    async function addReaders(count, { announcement = announcements.all, role = 'finance' } = {}) {
      assert(Number.isSafeInteger(count) && count >= 0 && count <= 100, 'Synthetic reader batch is bounded');
      assert(['admin', 'supervisor', 'finance', 'caregiver'].includes(role), 'Synthetic reader role is known');
      const result = { clients: [], receipts: [] };
      for (let n = 0; n < count; n++) {
        const actor = await addUser(role, '合成閱讀名冊' + String(serial + 1).padStart(3, '0'));
        result.clients.push(actor.client);
        result.receipts.push(await ack(announcement, actor.client, { key: 'synthetic-roster-040-' + serial }));
      }
      return redact(result);
    }
    function importAnnouncement(fields = {}) {
      const before = counts(), time = new Date().toISOString();
      const item = { ...announcementData(), ...fields, id: randomUUID(), orgId, version: 1, createdAt: time, updatedAt: time };
      const data = Object.fromEntries(['title', 'body', 'audience', 'status'].filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]));
      app.db.exec('BEGIN IMMEDIATE');
      try {
        app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, orgId, 'announcements', JSON.stringify(data), 1, time, time);
        app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, 'announcements', item.id, 1, JSON.stringify(item), time, 'baseline');
        app.db.exec('COMMIT');
      } catch (error) { app.db.exec('ROLLBACK'); throw error; }
      const after = counts();
      ledger.push({ kind: 'explicit-owned-synthetic-SQL-fixture', label: 'typed-announcement-complete-head', before, after, changes: after.totalChanges - before.totalChanges });
      return item;
    }
    const sourceCookies = redact(Object.fromEntries(Object.entries(clients).map(([role, client]) => [role, client.cookie])));
    return redact({ app, base, actors: redact(actors), clients: redact(clients), sourceCookies,
      auth: clients.admin.auth, password, orgIds: { own: orgId, foreign: foreignOrgId }, announcements,
      ledger, baseFixture, baseFixtureChanges, request, create, patch, ack, addReaders, importAnnouncement,
      counts, rawState() { return readSyntheticRawState(app.db); }, async close() { await app.close(); } });
  } catch (error) { await app.close(); throw error; }
}
