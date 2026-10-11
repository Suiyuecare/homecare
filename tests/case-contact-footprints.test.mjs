import test from 'node:test';
import assert from 'node:assert/strict';
import { CASE_CONTACT_FOOTPRINT_ENTITY as entity, caseContactFootprintEntities, guardCaseContactFootprintAccess, normalizeCaseContactFootprintPayload, validateCaseContactFootprint, caseContactFootprintQuery, caseContactFootprintHistoryVisible } from '../src/server/case-contact-footprints.mjs';

const ctx = { orgId: 'synthetic-org', role: 'admin' }, spec = caseContactFootprintEntities[entity], fail = (status, code, message, fields) => { const error = new Error(message); Object.assign(error, { status, code, fields }); throw error; };
const data = () => ({ caseId: 'synthetic-case-a', date: '2026-10-10', time: '', location: ' 人工場所 ', contactDescription: ' 接觸原文\r\n末行 ', relatedCaseId: 'synthetic-case-b', source: ' 人工來源 ', status: 'active', note: ' 長備註\r\n保留 ' });
const dateValid = value => /^\d{4}-\d{2}-\d{2}$/.test(value), db = { parents: new Map([['synthetic-org:synthetic-case-a', { id: 'synthetic-case-a', status: 'inactive' }], ['synthetic-org:synthetic-case-b', { id: 'synthetic-case-b', status: 'active' }], ['foreign-org:foreign-case', { id: 'foreign-case', status: 'active' }]]) }, get = (store, org, type, id) => type === 'cases' ? store.parents.get(org + ':' + id) : undefined;
const validate = (value, old = null, actor = ctx, reader = get) => validateCaseContactFootprint(entity, value, old, fail, dateValid, db, actor, reader);
const snapshot = () => ({ ...data(), id: 'synthetic-footprint', orgId: ctx.orgId, version: 1, createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z' });

test('candidate schema contains manual location/contact text and optional unknown time without GPS or diagnosis fields', () => {
  assert.deepEqual(spec.required, ['caseId', 'date', 'location', 'contactDescription']); assert.equal(spec.defaults.time, ''); assert.equal(spec.defaults.relatedCaseId, ''); assert.ok(!/gps|latitude|longitude|diagnosis|risk|score|notification/i.test(spec.fields)); validate(data());
});
test('roles reject before payload getter or parent read; descriptors never execute accessor fields', () => {
  let reads = 0; const payload = Object.defineProperty({}, 'caseId', { enumerable: true, get() { reads++; return 'synthetic-case-a'; } });
  for (const role of ['finance', 'caregiver']) { assert.throws(() => guardCaseContactFootprintAccess(entity, { role }, true, fail), error => error.status === 403); assert.throws(() => validate(payload, null, { ...ctx, role }, () => { reads++; throw new Error('should not read'); }), error => error.status === 403); }
  assert.throws(() => validate(payload), error => error.status === 422); assert.equal(reads, 0); validate(data(), null, { ...ctx, role: 'supervisor' });
});
test('closed text/date/time profiles reject invalid values, year0000, CRLF times, unknown keys and unavailable related cases', () => {
  for (const patch of [{ caseId: ' synthetic-case-a' }, { date: '0000-01-01' }, { date: '2026-02-29' }, { date: '2026-10-10\n' }, { time: '09:00\n' }, { time: '09:00\r\n' }, { time: '24:00' }, { time: 9 }, { location: '字'.repeat(201) }, { contactDescription: '字'.repeat(2001) }, { source: '字'.repeat(501) }, { note: '字'.repeat(10001) }, { contactDescription: ' ' }, { note: [] }, { relatedCaseId: 'foreign-case' }, { relatedCaseId: 'missing' }, { latitude: 25 }]) assert.throws(() => validate({ ...data(), ...patch }), error => error.status === 422);
  validate({ ...data(), time: '00:00', relatedCaseId: '', note: '字'.repeat(10000) }); validate({ ...data(), date: '0001-01-01', time: '23:59' });
});
test('immutable original case and current same-org parent/related references are re-read on each write, without changing source maps', () => {
  const before = structuredClone(db.parents); let reads = 0; const reader = (...args) => { reads++; return get(...args); }; validate(data(), data(), ctx, reader); assert.equal(reads, 2);
  assert.throws(() => validate({ ...data(), caseId: 'synthetic-case-b' }, data(), ctx, reader), error => error.code === 'CASE_IMMUTABLE'); assert.equal(reads, 2);
  const parent = db.parents.get('synthetic-org:synthetic-case-a'); db.parents.delete('synthetic-org:synthetic-case-a'); assert.throws(() => validate(data(), data()), error => error.code === 'INVALID_REFERENCE'); db.parents.set('synthetic-org:synthetic-case-a', parent); assert.deepEqual(db.parents, before);
});
test('normalization preserves source/padding/CRLF and rejects hidden descriptors at validation without mutating data', () => {
  const original = data(), before = structuredClone(original), result = normalizeCaseContactFootprintPayload(entity, { ...original, status: ' active ' }); assert.equal(result.note, original.note); assert.equal(result.location, original.location); assert.equal(result.contactDescription, original.contactDescription); assert.equal(result.source, original.source); assert.equal(result.status, 'active'); assert.deepEqual(original, before);
  assert.throws(() => validate(Object.defineProperty(data(), 'hidden', { value: true })), error => error.status === 422); assert.throws(() => validate({ ...data(), [Symbol('hidden')]: true }), error => error.status === 422);
});
test('typed historical snapshots require exact original identity/case/current scoped references and reject hidden data without executing getters', () => {
  const current = snapshot(); assert.equal(caseContactFootprintHistoryVisible(db, ctx, current, current, get), true);
  for (const patch of [{ orgId: 'foreign-org' }, { id: 'another' }, { caseId: 'synthetic-case-b' }, { relatedCaseId: 'foreign-case' }, { version: '1' }, { version: 0 }, { createdAt: '' }, { note: [] }, { clinicalScore: 1 }]) assert.equal(caseContactFootprintHistoryVisible(db, ctx, { ...current, ...patch }, current, get), false);
  const missing = { ...current }; delete missing.createdAt; assert.equal(caseContactFootprintHistoryVisible(db, ctx, missing, current, get), false);
  let reads = 0; const unsafe = Object.defineProperty({ ...current }, 'relatedCaseId', { enumerable: true, get() { reads++; return 'synthetic-case-b'; } }); assert.equal(caseContactFootprintHistoryVisible(db, ctx, unsafe, current, get), false); assert.equal(reads, 0);
  for (const role of ['finance', 'caregiver']) assert.equal(caseContactFootprintHistoryVisible(db, { ...ctx, role }, current, current, () => { throw new Error('no read'); }), false);
});
test('strict queries reject unknown/duplicates/scientific pagination/trailing CRLF/year0000 and return exact scoped filters', () => {
  for (const query of ['unknown=x', 'caseId=a&caseId=b', 'q=x&q=y', 'page=1e0', 'page=1%0A', 'pageSize=25%0D%0A', 'page=01', 'pageSize=101', 'pageSize=2.5', 'date=0000-01-01', 'date=2026-02-30', 'relatedCaseId=%20x', 'status=deleted']) assert.throws(() => caseContactFootprintQuery(entity, new URLSearchParams(query), fail, dateValid), error => error.status === 422);
  assert.deepEqual(caseContactFootprintQuery(entity, new URLSearchParams('page=2&pageSize=25&caseId=synthetic-case-a&relatedCaseId=synthetic-case-b&date=2026-10-10&status=inactive&q=%20manual%20'), fail, dateValid), { page: 2, pageSize: 25, caseId: 'synthetic-case-a', relatedCaseId: 'synthetic-case-b', date: '2026-10-10', status: 'inactive', q: ' manual ' });
});
test('single and history query modes reject list fields and coercion while accepting one strict history comparison', () => {
  assert.deepEqual(caseContactFootprintQuery(entity, new URLSearchParams(), fail, dateValid), { page: 1, pageSize: 25 });
  assert.deepEqual(caseContactFootprintQuery(entity, new URLSearchParams('compare=previous'), fail, dateValid, 'history'), { page: 1, pageSize: 25, compare: 'previous' });
  assert.deepEqual(caseContactFootprintQuery(entity, new URLSearchParams(), fail, dateValid, 'single'), {});
  for (const query of ['page=1', 'q=', 'caseId=synthetic-case-a', 'unknown=1']) assert.throws(() => caseContactFootprintQuery(entity, new URLSearchParams(query), fail, dateValid, 'single'), error => error.status === 422);
  assert.deepEqual(caseContactFootprintQuery(entity, new URLSearchParams('page=2&pageSize=25&compare=previous'), fail, dateValid, 'history'), { page: 2, pageSize: 25, compare: 'previous' });
  for (const query of ['caseId=synthetic-case-a', 'status=active', 'compare=latest', 'compare=previous&compare=previous', 'page=1&page=2', 'page=1%0A', 'page=1e0', 'pageSize=25%0D%0A']) assert.throws(() => caseContactFootprintQuery(entity, new URLSearchParams(query), fail, dateValid, 'history'), error => error.status === 422);
});
