import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createApp } from '../src/server/index.mjs';
import { syntheticDatabasePath } from '../src/server/synthetic-backup.mjs';
import { filePayload, PDF_BYTES, PNG_BYTES } from './attachment-fixtures.mjs';

// Synthetic-only fixture for the frozen v0.39 owned backup rehearsal contract.
// No caller-supplied paths, source credentials, default DB or fixed server port.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const PRIVATE = Symbol.for('nodejs.util.inspect.custom');
const hide = object => Object.defineProperties(object, {
  toJSON: { value() { throw new Error('Synthetic fixture secrets are memory-only'); } },
  [PRIVATE]: { value() { return '[Synthetic fixture: secrets redacted]'; } },
});
const readCounters = db => ({
  totalChanges: db.prepare('SELECT total_changes() AS n').get().n,
  records: db.prepare('SELECT count(*) AS n FROM records').get().n,
  versions: db.prepare('SELECT count(*) AS n FROM record_versions').get().n,
  audit: db.prepare('SELECT count(*) AS n FROM audit').get().n,
  idempotency: db.prepare('SELECT count(*) AS n FROM idempotency').get().n,
  sessions: db.prepare('SELECT count(*) AS n FROM sessions').get().n,
});
const textBytes = hex => {
  assert(typeof hex === 'string' && /^(?:[0-9a-fA-F]{2})*$/.test(hex), 'SQLite TEXT hex projection must contain complete bytes');
  return Buffer.from(hex, 'hex');
};
const typedValue = (kind, value, textHex) => {
  if (kind === 'null') return ['null'];
  if (kind === 'integer' && typeof value === 'bigint') return ['integer', value.toString()];
  if (kind === 'real' && typeof value === 'number') { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); return ['real', bytes.toString('hex')]; }
  if (kind === 'text') return ['text-bytes', textBytes(textHex).toString('hex')];
  if (kind === 'blob' && ArrayBuffer.isView(value)) return ['blob', Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex')];
  throw new Error('Unsupported persisted SQLite value');
};
const plainValue = (kind, value, textHex) => {
  // Application-generated synthetic TEXT is UTF-8. Decode full bytes, retaining NUL.
  if (kind === 'text') return textBytes(textHex).toString('utf8');
  return typeof value === 'bigint' && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : ArrayBuffer.isView(value) ? Buffer.from(value) : value;
};
export function readSyntheticRawState(db) {
  // Oldest supported node:sqlite SELECT TEXT can truncate at NUL; never trust it
  // for persisted TEXT. SQLite hex(CAST AS BLOB) exposes every saved byte instead.
  const schemaColumns = ['type', 'name', 'tbl_name', 'sql'];
  const schemaProjection = schemaColumns.flatMap((column, index) => [`typeof("${column}") AS "k${index}"`, `hex(CAST("${column}" AS BLOB)) AS "h${index}"`]).join(',');
  const schemaRows = db.prepare(`SELECT ${schemaProjection} FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
  const schema = schemaRows.map(row => Object.fromEntries(schemaColumns.map((column, index) => [column, row['k' + index] === 'null' ? null : plainValue(row['k' + index], null, row['h' + index])])));
  const typedSchema = { columns: schemaColumns, rows: schemaRows.map(row => schemaColumns.map((column, index) => typedValue(row['k' + index], null, row['h' + index]))) };
  const tables = {}, typedTables = {};
  for (const { name } of schema.filter(row => row.type === 'table')) {
    assert(/^[a-z_]+$/.test(name), 'Only the fixed application schema is queried');
    const columns = db.prepare('SELECT hex(CAST(name AS BLOB)) AS h FROM pragma_table_info(?) ORDER BY cid').all(name).map(column => textBytes(column.h).toString('utf8'));
    assert(columns.every(column => /^[a-z_][a-z0-9_]*$/.test(column)), 'Only fixed application columns are queried');
    const projection = columns.flatMap((column, index) => [
      `typeof("${column}") AS "k${index}"`,
      `CASE WHEN typeof("${column}")='text' THEN hex(CAST("${column}" AS BLOB)) ELSE NULL END AS "h${index}"`,
      `CASE WHEN typeof("${column}")='text' THEN NULL ELSE "${column}" END AS "v${index}"`,
    ]).join(',');
    const statement = db.prepare(`SELECT ${projection} FROM "${name}"`);
    statement.setReadBigInts(true);
    const paired = statement.all().map(row => {
      const typed = columns.map((column, index) => typedValue(row['k' + index], row['v' + index], row['h' + index]));
      const plain = Object.fromEntries(columns.map((column, index) => [column, plainValue(row['k' + index], row['v' + index], row['h' + index])]));
      return { typed, plain, key: JSON.stringify(typed) };
    }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    // No hidden rowid; duplicates remain separate entries. DTO numeric versions stay unchanged.
    tables[name] = paired.map(row => row.plain);
    typedTables[name] = { columns, rows: paired.map(row => row.typed) };
  }
  assert.equal(Object.keys(tables).length, 11);
  assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
  return { schema, typedSchema, tables, typedTables,
    userVersion: db.prepare('PRAGMA user_version').get().user_version,
    applicationId: db.prepare('PRAGMA application_id').get().application_id };
}

export function syntheticClient(base, label, { cookie = '', auth = null } = {}) {
  const location = new URL(base);
  assert.equal(location.hostname, '127.0.0.1');
  assert(location.port && location.port !== '4310');
  const client = {
    label,
    get cookie() { return cookie; },
    get auth() { return auth; },
    async response(method, route, data, { orgId, idempotencyKey } = {}) {
      assert(typeof route === 'string' && !route.startsWith('/') && !route.includes('://') && !route.includes('..'));
      const headers = { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(orgId ? { 'X-Org-Id': orgId } : {}),
        ...(auth?.csrfToken ? { 'X-CSRF-Token': auth.csrfToken } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) };
      const response = await fetch(`${base}/api/${route}`, { method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return response;
    },
    async json(method, route, data, { status = 200, ...options } = {}) {
      const response = await client.response(method, route, data, options);
      const value = await response.json();
      assert.equal(response.status, status, `${label}: ${method} ${route} returned ${response.status} (${value.error?.code || 'no error code'})`);
      return value;
    },
    async login(email, password) {
      auth = await client.json('POST', 'login', { email, password });
      return auth;
    },
    bindAuth(value) { auth = value; },
  };
  return hide(client);
}

/**
 * syntheticDatabasePath(workspace, slot) accepts only the frozen factory capability,
 * before installation. That accessor accepts only the internal branded capability
 * and resolves the fixed source slot; it must never accept a path from the caller.
 */
export async function createSyntheticBackupFixture({ workspace }) {
  const sourcePath = syntheticDatabasePath(workspace, 'source');
  const app = createApp({ dbPath: sourcePath, host: '127.0.0.1', port: 0 });
  let base;
  const writes = [];
  const written = async (label, work) => {
    const before = readCounters(app.db);
    const result = await work();
    const after = readCounters(app.db);
    writes.push({ label, before, after, changes: after.totalChanges - before.totalChanges });
    assert(after.totalChanges > before.totalChanges, `${label} must account its actual writes`);
    return result;
  };
  try {
    base = await app.listen();
    const password = 'SyntheticBackupFixture-039!';
    const admin = syntheticClient(base, 'source-admin');
    const setup = await written('normal-api-initial-setup', () => admin.json('POST', 'setup', {
      name: '合成備份管理員', email: 'backup-admin@example.test', password, organizationName: '合成備份甲機構',
    }, { status: 201 }));
    admin.bindAuth(setup);
    const orgId = setup.organizations[0].id;
    const post = async (route, data, options = {}) => (await admin.json('POST', route, data, { status: 201, orgId, ...options })).item;
    const patch = async (route, item, data, options = {}) => (await admin.json('PATCH', `${route}/${item.id}`, { version: item.version, ...data }, { orgId, ...options })).item;
    const month = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date()).slice(0, 7);
    assert(/^\d{4}-\d{2}$/.test(month));
    const year = Number(month.slice(0, 4));
    const users = { admin: { id: setup.user.id, email: setup.user.email, name: setup.user.name } };
    const items = {};
    let frozenReports;
    await written('normal-api-business-records-approval-snapshots-and-two-BLOBs', async () => {
      items.employee = await post('employees', { name: '合成備份本人員工', employeeNo: 'BK-E-OWN', role: 'caregiver', hourlyRateCents: 21000 });
      items.otherEmployee = await post('employees', { name: '合成備份其他員工', employeeNo: 'BK-E-OTHER', role: 'caregiver', hourlyRateCents: 30000 });
      for (const role of ['supervisor', 'finance', 'caregiver']) users[role] = await post('users', {
        name: '合成備份' + role, email: `backup-${role}@example.test`, password, role,
        ...(role === 'caregiver' ? { employeeId: items.employee.id } : {}),
      });
      const firstCasePayload = { name: '合成備份本人個案', caseNo: 'BK-C-OWN', note: '合成初版個案備註' };
      items.case = await post('cases', firstCasePayload, { idempotencyKey: 'synthetic-backup-case-create-039' });
      const replayBefore = readCounters(app.db);
      const replay = await post('cases', firstCasePayload, { idempotencyKey: 'synthetic-backup-case-create-039' });
      assert(isDeepStrictEqual(replay, items.case), 'Normal idempotency replay returns the same saved record');
      assert.deepEqual(readCounters(app.db), replayBefore, 'Normal idempotency replay creates no second record or audit');
      items.case = await patch('cases', items.case, { note: '合成checkpoint前第二版個案備註' });
      items.otherCase = await post('cases', { name: '合成備份其他個案', caseNo: 'BK-C-OTHER' });
      items.service = await post('service-items', { code: 'BK-S-101', name: '合成保存101分服務', minutes: 60, unitPriceCents: 101 });
      for (const [name, person, caseItem, day, quantity, actualEnd] of [
        ['own', items.employee, items.case, '01', 2, '09:45'],
        ['other', items.otherEmployee, items.otherCase, '02', 3, '09:30'],
      ]) {
        const services = [{ serviceItemId: items.service.id, quantity }];
        const plan = await post('care-plans', { caseId: caseItem.id, validFrom: `${year}-01-01`, validTo: `${year}-12-31`, status: 'active', services: [{ serviceItemId: items.service.id, quantity: 100 }] });
        const shift = await post('shifts', { caseId: caseItem.id, employeeId: person.id, carePlanId: plan.id, date: `${month}-${day}`, startTime: '09:00', endTime: '10:00', services });
        const submitted = await post('service-records', { shiftId: shift.id, caseId: caseItem.id, employeeId: person.id, date: shift.date, actualStart: '09:00', actualEnd, services, status: 'submitted', note: '合成備份正常服務核閱' });
        const approved = (await admin.json('POST', `service-records/${submitted.id}/review`, { version: submitted.version, decision: 'approved', reviewNote: '合成保存價格與時薪快照' }, { orgId })).item;
        assert.equal(approved.version, 2);
        assert.equal(approved.billingSnapshot.items[0].unitPriceCents, 101);
        assert.equal(approved.billingSnapshot.employee.hourlyRateCents, person.hourlyRateCents);
        const completedShift = (await admin.json('GET', `shifts/${shift.id}`, undefined, { orgId })).item;
        assert.equal(completedShift.version, 2); assert.equal(completedShift.status, 'completed');
        items[`${name}Plan`] = plan; items[`${name}Shift`] = completedShift; items[`${name}Record`] = approved;
      }
      frozenReports = {
        fees: await admin.json('GET', `reports/fees?month=${month}`, undefined, { orgId }),
        payroll: await admin.json('GET', `reports/payroll?month=${month}`, undefined, { orgId }),
      };
      assert.deepEqual(frozenReports.fees.totals, { count: 2, amountCents: 505 });
      assert.deepEqual(frozenReports.payroll.totals, { count: 2, amountCents: 30750, minutes: 75 });
      items.service = await patch('service-items', items.service, { unitPriceCents: 99999 });
      items.employee = await patch('employees', items.employee, { hourlyRateCents: 88888 });
      for (const kind of ['fees', 'payroll']) assert(isDeepStrictEqual(await admin.json('GET', `reports/${kind}?month=${month}`, undefined, { orgId }), frozenReports[kind]), 'Saved report remains unchanged after current price/rate edit');
      items.caseAttachment = await post('case-attachments/upload', { caseId: items.case.id, title: '合成備份個案附件', category: 'other', note: '合成附件初版', ...filePayload(PDF_BYTES, '合成備份.pdf', 'application/pdf') }, { idempotencyKey: 'synthetic-backup-case-file-039' });
      items.caseAttachment = await patch('case-attachments', items.caseAttachment, { note: '合成附件第二版；檔案不變' });
      items.certification = await post('employee-certifications', { employeeId: items.employee.id, name: '合成備份本人證照', issuedOn: `${year}-01-01`, note: '合成證照初版' });
      items.certification = await patch('employee-certifications', items.certification, { note: '合成證照第二版' });
      items.certAttachment = await post('certification-attachments/upload', { certificationId: items.certification.id, title: '合成備份證照附件', note: '合成證照附件初版', ...filePayload(PNG_BYTES, '合成備份.png', 'image/png') }, { idempotencyKey: 'synthetic-backup-cert-file-039' });
      items.certAttachment = await patch('certification-attachments', items.certAttachment, { note: '合成證照附件第二版；檔案不變' });
      items.foreignOrg = await post('organizations', { name: '合成備份乙機構' });
      items.foreignEmployee = await post('employees', { name: '合成備份乙機構員工', employeeNo: 'BK-E-FOREIGN', role: 'caregiver', hourlyRateCents: 19000 }, { orgId: items.foreignOrg.id });
      items.foreignCase = await post('cases', { name: '合成備份乙機構個案', caseNo: 'BK-C-FOREIGN' }, { orgId: items.foreignOrg.id });
    });
    const actors = { admin: { client: admin, user: users.admin, role: 'admin' } };
    await written('normal-api-four-live-role-logins', async () => {
      for (const role of ['admin', 'supervisor', 'finance', 'caregiver']) {
        const client = role === 'admin' ? admin : syntheticClient(base, 'source-' + role);
        const auth = await client.login(users[role].email, password);
        const selected = auth.organizations.find(item => item.id === orgId);
        assert.equal(selected.role, role);
        actors[role] = hide({ client, cookieJar: client, auth, user: users[role], role });
      }
    });
    // Explicit synthetic INSERT-only expiry oracle; this is not a normal API write.
    const expiredToken = randomBytes(32).toString('hex');
    const expiredCsrf = randomBytes(32).toString('hex');
    await written('synthetic-INSERT-only-known-expired-session-oracle', async () => {
      app.db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)').run(sha(expiredToken), users.admin.id, expiredCsrf, Date.now() - 60000);
    });
    const versionsMissing = app.db.prepare('SELECT count(*) AS n FROM records r WHERE NOT EXISTS (SELECT 1 FROM record_versions v WHERE v.record_id=r.id AND v.version=r.version)').get().n;
    assert.equal(versionsMissing, 0, 'Every record has a current saved version before backup/startup');
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 5);
    assert(app.db.prepare('SELECT count(*) AS n FROM audit').get().n > 0);
    assert(app.db.prepare('SELECT count(*) AS n FROM idempotency').get().n > 0);
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM attachment_files WHERE length(content)>0').get().n, 1);
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM certification_attachment_files WHERE length(content)>0').get().n, 1);
    const fullBeforeCheckpoint = readSyntheticRawState(app.db);
    assert.equal(app.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    app.db.exec('PRAGMA wal_autocheckpoint=0');
    const checkpoint = app.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    assert.equal(checkpoint.busy, 0); assert.equal(checkpoint.log, 0); assert.equal(checkpoint.checkpointed, 0);
    const mainHashAtCheckpoint = sha(await readFile(sourcePath));
    const beforeWalWrite = readCounters(app.db);
    await written('normal-api-committed-case-version-after-checkpoint', async () => {
      items.case = await patch('cases', items.case, { note: '合成039 committed WAL sentinel；完整備份必須包含第三版' });
      assert.equal(items.case.version, 3);
    });
    const walBytes = (await stat(sourcePath + '-wal')).size;
    assert(walBytes > 32, 'Committed frames remain in the live WAL');
    const mainHashAfterWalWrite = sha(await readFile(sourcePath));
    assert.equal(mainHashAfterWalWrite, mainHashAtCheckpoint, 'A stale main-file-only copy cannot contain the new commit');
    const rawState = readSyntheticRawState(app.db), counters = readCounters(app.db);
    assert.equal(counters.totalChanges, writes.reduce((sum, item) => sum + item.changes, 0), 'All fixture and login writes are separately accounted');
    assert.equal(rawState.tables.records.find(row => row.id === items.case.id).version, 3);
    assert.equal(fullBeforeCheckpoint.tables.records.find(row => row.id === items.case.id).version, 2);
    const expectedCsv = {}, histories = {};
    for (const [entity, item] of [['cases', items.case], ['service-records', items.ownRecord], ['employee-certifications', items.certification], ['case-attachments', items.caseAttachment], ['certification-attachments', items.certAttachment]]) {
      histories[entity] = await admin.json('GET', `${entity}/${item.id}/history?compare=previous`, undefined, { orgId });
      assert.equal(histories[entity].items[0].version, item.version);
      assert.equal(histories[entity].items[0].comparison.status, 'available');
      assert.equal(histories[entity].items[0].comparison.previousVersion, item.version - 1);
    }
    for (const kind of ['fees', 'payroll']) {
      const response = await admin.response('GET', `reports/${kind}.csv?month=${month}`, undefined, { orgId });
      assert.equal(response.status, 200);
      expectedCsv[kind] = Buffer.from(await response.arrayBuffer());
    }
    assert.deepEqual(readCounters(app.db), counters, 'Capturing raw CSV causes no source writes');
    const sourceCookies = hide(Object.fromEntries(Object.entries(actors).map(([role, actor]) => [role, actor.client.cookie])));
    return hide({ workspace, app, base, sourceCookies, orgId, foreignOrgId: items.foreignOrg.id, month, actors, items, users,
      secrets: hide({ password, expiredCookie: `suiyue_session=${expiredToken}`, expiredCsrf }),
      expected: hide({ rawState, frozenReports, histories, csvBytes: expectedCsv, caseBytes: PDF_BYTES, certBytes: PNG_BYTES }),
      writeLedger: writes, counters,
      walProof: { checkpoint, mainHashAtCheckpoint, mainHashAfterWalWrite, walBytes, sentinelRecordId: items.case.id, beforeVersion: 2, afterVersion: 3, beforeCounters: beforeWalWrite, afterCounters: counters },
      readRawState() { return readSyntheticRawState(app.db); },
      async close() { await app.close(); },
    });
  } catch (error) {
    await app.close();
    throw error;
  }
}
