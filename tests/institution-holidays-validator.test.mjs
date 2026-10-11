import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { guardInstitutionHolidayAccess, normalizeInstitutionHolidayPayload, institutionHolidayVisible, institutionHolidayHistoryVisible, validateInstitutionHoliday, institutionHolidayQuery, filterInstitutionHolidays } from '../src/server/institution-holidays.mjs';
const entity = 'institution-holidays', ctx = { orgId: 'synthetic-org', role: 'admin' };
const data = (extra = {}) => ({ date: '2026-10-10', title: '合成設定', kind: 'holiday', sourceReference: '  原依據\r\n末行  ', note: '  原備註  ', status: 'active', ...extra });
const item = (extra = {}) => ({ ...data(), id: 'synthetic-holiday', orgId: ctx.orgId, version: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...extra });
const fail = (status, code, message) => { const error = new Error(message); Object.assign(error, { status, code }); throw error; };
const rejects = (fn, status, code) => assert.throws(fn, error => error.status === status && (!code || error.code === code));
function memory(t, saved = []) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); db.exec('CREATE TABLE records(id TEXT PRIMARY KEY,org_id TEXT,entity TEXT,data TEXT)');
  for (const row of saved) db.prepare('INSERT INTO records VALUES(?,?,?,?)').run(row.id, row.orgId, entity, JSON.stringify(row));
  const rows = (db, orgId, entity) => db.prepare('SELECT data FROM records WHERE org_id=? AND entity=?').all(orgId, entity).map(row => JSON.parse(row.data));
  const validate = (value, old, context = ctx, callback = rows) => validateInstitutionHoliday(db, context, entity, value, old, fail, undefined, callback);
  return { db, rows, validate, raw: () => db.prepare('SELECT * FROM records ORDER BY id').all() };
}
test('only admin/supervisor access; rejected role reaches neither validation nor database', () => {
  for (const role of ['admin', 'supervisor']) for (const read of [true, false]) guardInstitutionHolidayAccess(entity, { ...ctx, role }, read, fail);
  for (const role of ['finance', 'caregiver', 'unknown']) for (const read of [true, false]) rejects(() => guardInstitutionHolidayAccess(entity, { ...ctx, role }, read, fail), 403);
  rejects(() => validateInstitutionHoliday(null, { ...ctx, role: 'finance' }, entity, null, null, fail, null, null), 403);
});
test('payload normalization touches scalar date/kind/status only and preserves exact human text', () => {
  assert.deepEqual(normalizeInstitutionHolidayPayload(entity, data({ date: ' 2026-10-10\n', kind: ' holiday ', title: '  名稱  ' })), data({ date: '2026-10-10', kind: 'holiday', title: '  名稱  ' }));
});
test('same-org date has one active setting; inactive/other-org records do not reserve date', t => {
  const old = item(), f = memory(t, [old, item({ id: 'inactive', status: 'inactive', date: '2026-10-11', version: 2 }), item({ id: 'foreign', orgId: 'other-org', date: '2026-10-12' })]), before = f.raw();
  rejects(() => f.validate(data()), 409, 'HOLIDAY_DATE_CONFLICT');
  f.validate(data({ date: '2026-10-11' })); f.validate(data({ date: '2026-10-12' })); f.validate(data({ title: '明確更正名稱' }), old);
  f.validate(data({ status: 'inactive' }), old); assert.deepEqual(f.raw(), before);
});
test('restore or move active date rejects another active setting, but inactive edit remains possible', t => {
  const old = item({ status: 'inactive', version: 2 }), f = memory(t, [old, item({ id: 'current', date: '2026-10-11' })]), before = f.raw();
  rejects(() => f.validate(data({ date: '2026-10-11' }), old), 409, 'HOLIDAY_DATE_CONFLICT');
  f.validate(data({ date: '2026-10-11', status: 'inactive' }), old); f.validate(data({ date: '2026-10-12' }), old); assert.deepEqual(f.raw(), before);
});
test('unknown/invalid data, maximum version and new inactive status fail without writes', t => {
  const f = memory(t), before = f.raw();
  for (const overrides of [{ date: '0000-01-01' }, { date: '2026-02-30' }, { title: ' ' }, { kind: 'statutory-auto' }, { note: {} }, { sourceReference: 'x'.repeat(2001) }, { unknown: 'x' }]) rejects(() => f.validate(data(overrides)), 422);
  rejects(() => f.validate(data({ status: 'inactive' })), 422, 'INITIAL_STATUS');
  rejects(() => f.validate(data(), item({ version: Number.MAX_SAFE_INTEGER })), 409, 'VERSION_LIMIT'); assert.deepEqual(f.raw(), before);
});
test('malformed occupied data or silently filtered rows block uniqueness guard, not reinterpret imports', t => {
  const f = memory(t, [item()]), before = f.raw();
  rejects(() => f.validate(data({ date: '2026-10-11' }), null, ctx, () => []), 409, 'HOLIDAY_DATA_INVALID');
  rejects(() => f.validate(data({ date: '2026-10-11' }), null, ctx, () => [item({ note: { unexpected: 'hidden' } })]), 409, 'HOLIDAY_DATA_INVALID');
  rejects(() => f.validate(data({ date: '2026-10-11' }), null, ctx, () => { throw new SyntaxError('synthetic malformed JSON'); }), 409, 'HOLIDAY_DATA_INVALID'); assert.deepEqual(f.raw(), before);
});
test('current/history visibility enforces exact metadata and identity without freezing editable date', () => {
  const current = item({ date: '2026-10-11', version: 3 });
  assert.equal(institutionHolidayVisible(null, ctx, entity, current), true); assert.equal(institutionHolidayHistoryVisible(null, ctx, entity, item(), current), true);
  for (const bad of [item({ id: 'wrong' }), item({ orgId: 'foreign' }), item({ extra: {} }), item({ version: 4 }), item({ createdAt: '2026-10-02T00:00:00.000Z' })]) assert.equal(institutionHolidayHistoryVisible(null, ctx, entity, bad, current), false);
  assert.equal(institutionHolidayVisible(null, { ...ctx, role: 'caregiver' }, entity, current), false);
});
test('strict query modes reject raw year/page LF, duplicate/unknown keys and false previous comparison', () => {
  const query = params => institutionHolidayQuery(entity, new URLSearchParams(params), fail);
  assert.deepEqual(query('year=2026&page=2&pageSize=100&status=active&q=合成'), { page: 2, pageSize: 100, year: '2026', status: 'active', q: '合成' });
  for (const value of ['year=2026%0A', 'year=0000', 'year=2026&year=2027', 'page=1%0A', 'pageSize=101', 'page=9007199254740992', 'q=' + 'x'.repeat(201), 'kind=holiday', 'status=constructor']) rejects(() => query(value), 422);
  rejects(() => institutionHolidayQuery(entity, new URLSearchParams('year=2026'), fail, 'single'), 422);
  rejects(() => institutionHolidayQuery(entity, new URLSearchParams('year=2026'), fail, 'history'), 422);
  rejects(() => institutionHolidayQuery(entity, new URLSearchParams('compare=anything'), fail, 'history'), 422);
  assert.equal(institutionHolidayQuery(entity, new URLSearchParams('compare=previous'), fail, 'history').pageSize, 25);
});
test('year/state/literal business search is read-only, excludes metadata IDs and sorts dates', () => {
  const rows = [item({ id: 'metadata-only-needle', date: '2027-01-01' }), item({ id: 'b', date: '2026-12-31', kind: 'working-day' }), item({ id: 'c', date: '2026-01-01', status: 'inactive' })], frozen = structuredClone(rows);
  assert.deepEqual(filterInstitutionHolidays(rows, { year: '2026' }).map(row => row.id), ['c', 'b']);
  assert.deepEqual(filterInstitutionHolidays(rows, { year: '2026', status: 'active' }).map(row => row.id), ['b']);
  assert.deepEqual(filterInstitutionHolidays(rows, { q: 'metadata-only-needle' }), []); assert.equal(filterInstitutionHolidays(rows, { q: '工作日' }).length, 1); assert.deepEqual(rows, frozen);
});
