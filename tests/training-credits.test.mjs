import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { initDb, insert, replace, business, get, fail } from '../src/server/model.mjs';
import { TRAINING_CREDIT_ENTITY as E, TRAINING_CREDIT_FIELDS, creditPlain, isTrainingCreditValue, isTrainingCreditYear, isTrainingCreditDate, assertTrainingCreditItem, trainingCreditReadModel } from '../public/data/training-credit-core.js';
import { trainingCreditEntities, guardTrainingCreditAccess, normalizeTrainingCreditPayload, assertTrainingCreditTransitionPayload, validateTrainingCredit, trainingCreditVisible, trainingCreditHistoryVisible, trainingCreditQuery, assertTrainingCreditQueryTarget, filterTrainingCredits } from '../src/server/training-credits.mjs';
import { createTrainingCreditEditor, confirmTrainingCreditSave, trainingCreditHistoryFields } from '../public/data/training-credit-editor.js';
function fixture(t) {
  const db = new DatabaseSync(':memory:'); initDb(db); t.after(() => db.close());
  const orgId = randomUUID(), otherOrg = randomUUID(); for (const org of [orgId, otherOrg]) db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(org, '合成人工積分機構', '2026-10-10T00:00:00Z');
  const ctx = { orgId, role: 'supervisor', user: { id: randomUUID() } }, employee = insert(db, orgId, 'employees', { name: '合成人員', status: 'active' }), second = insert(db, orgId, 'employees', { name: '合成第二人', status: 'active' }), outside = insert(db, otherOrg, 'employees', { name: '合成外機構', status: 'active' });
  const payload = extra => ({ employeeId: employee.id, date: '2026-10-10', activityName: '合成活動', provider: '合成單位', creditValue: '001.230000', creditUnit: '來源甲單位', sourceReference: '  合成依據\r\n尾端  ', ...extra });
  const create = extra => { const data = { ...trainingCreditEntities[E].defaults, ...payload(extra) }; validateTrainingCredit(db, ctx, E, data, null, fail, get); return insert(db, orgId, E, data); };
  const patch = (old, patch) => { assertTrainingCreditTransitionPayload(E, patch, fail); const data = { ...business(old), ...patch }; validateTrainingCredit(db, ctx, E, data, old, fail, get); return replace(db, orgId, E, old, data); };
  const state = () => ({ changes: db.prepare('SELECT total_changes() n').get().n, current: db.prepare('SELECT * FROM records ORDER BY id').all(), history: db.prepare('SELECT * FROM record_versions ORDER BY record_id,version').all() });
  return { db, ctx, orgId, employee, second, outside, payload, create, patch, state };
}
test('decimal text and Gregorian year/date boundaries preserve exact original without numeric conversion', () => {
  for (const value of ['0', '000', '001.230000', '999999999999999.999999']) assert.equal(isTrainingCreditValue(value), true);
  for (const value of [1, NaN, Infinity, '-0', '+1', '.1', '1.', '1e2', '1\n', '1\r', '1 ', ' 1', '1.1234567', '1000000000000000']) assert.equal(isTrainingCreditValue(value), false);
  for (const year of ['0001', '2026', '9999']) assert.equal(isTrainingCreditYear(year), true);
  for (const year of ['0000', '26', '2026\n', '2026 ', 2026]) assert.equal(isTrainingCreditYear(year), false);
  for (const date of ['0001-01-01', '2000-02-29', '9999-12-31']) assert.equal(isTrainingCreditDate(date), true);
  for (const date of ['0000-01-01', '1900-02-29', '2026-02-30', '2026-10-10\n']) assert.equal(isTrainingCreditDate(date), false);
});
test('closed current schemas and payloads reject accessors, extras, unsafe versions and invalid terminal metadata', t => {
  const f = fixture(t), item = f.create(); let reads = 0; const getter = { ...item }; Object.defineProperty(getter, 'creditValue', { enumerable: true, get() { reads++; return '1'; } });
  assert.equal(creditPlain(getter), false); assert.throws(() => assertTrainingCreditItem(getter)); assert.equal(reads, 0);
  for (const extra of [{ extra: true }, { creditValue: 1 }, { version: 0 }, { version: Number.MAX_SAFE_INTEGER + 1 }, { orgId: randomUUID() }, { verifiedOn: '2026-10-10' }]) assert.throws(() => assertTrainingCreditItem({ ...item, ...extra }, f.orgId));
  assert.throws(() => normalizeTrainingCreditPayload(E, getter)); assert.equal(reads, 0); assert.deepEqual(TRAINING_CREDIT_FIELDS, trainingCreditHistoryFields.map(field => field.key));
  assert.equal(trainingCreditReadModel(item, f.orgId).creditDisplay, '001.230000 來源甲單位'); assert.equal(trainingCreditReadModel(item, f.orgId).official, false);
});
test('draft verification and void require current action metadata, lock original credit/unit/source and preserve all history', t => {
  const f = fixture(t); let item = f.create(), baseline = f.state();
  for (const patch of [{ status: 'verified' }, { status: 'verified', verifiedOn: '2026-10-10', verificationBasis: ' ' }, { status: 'voided', voidedOn: '2026-10-10', voidReason: '合成' }]) assert.throws(() => f.patch(item, patch));
  assert.deepEqual(f.state(), baseline); item = f.patch(item, { status: 'verified', verifiedOn: '2026-10-10', verificationBasis: '  合成核對依據\r\n尾端  ' }); const verified = structuredClone(item); baseline = f.state();
  for (const patch of [{ note: '改' }, { creditValue: '1' }, { employeeId: f.second.id }, { status: 'draft' }, { status: 'voided', voidReason: '新的原因' }, { status: 'voided', voidedOn: '2026-10-10', voidReason: ' ' }, { status: 'voided', voidedOn: '2026-10-10', voidReason: '新原因', sourceReference: '改' }]) assert.throws(() => f.patch(item, patch));
  assert.deepEqual(f.state(), baseline); item = f.patch(item, { status: 'voided', voidedOn: '2026-10-11', voidReason: '  新的合成作廢原因\r\n尾端  ' });
  for (const key of TRAINING_CREDIT_FIELDS.filter(key => !['status', 'voidedOn', 'voidReason'].includes(key))) assert.equal(item[key], verified[key]);
  baseline = f.state(); assert.throws(() => f.patch(item, { note: '终態改' })); assert.throws(() => f.patch(item, { status: 'voided', voidedOn: '2026-10-12', voidReason: '換原因' })); assert.deepEqual(f.state(), baseline);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM record_versions WHERE record_id=?').get(item.id).n, 3);
});
test('immutable same-organization employee and role/own-employee history are enforced with zero denied writes', t => {
  const f = fixture(t), item = f.create(), baseline = f.state(), own = { ...f.ctx, role: 'caregiver', employeeId: f.employee.id }, other = { ...own, employeeId: f.second.id };
  assert.equal(trainingCreditVisible(f.db, own, E, item, get), true); assert.equal(trainingCreditVisible(f.db, other, E, item, get), false);
  assert.equal(trainingCreditHistoryVisible(f.db, own, E, item, item, get), true); assert.equal(trainingCreditHistoryVisible(f.db, own, E, { ...item, employeeId: f.second.id }, item, get), false);
  for (const role of ['finance', 'caregiver', 'unknown']) assert.throws(() => guardTrainingCreditAccess(E, { ...f.ctx, role, employeeId: f.employee.id }, false, fail));
  assert.throws(() => f.create({ employeeId: f.outside.id })); assert.throws(() => f.patch(item, { employeeId: f.second.id }));
  assert.throws(() => assertTrainingCreditQueryTarget(f.db, other, E, { employeeId: f.employee.id }, fail, get)); assert.deepEqual(f.state(), baseline);
});
test('strict query modes reject duplicates, end LF, unknown fields and invalid scope while preserving boundary years', t => {
  const f = fixture(t), item = f.create();
  for (const query of ['year=2026&year=2026', 'year=0000', 'year=2026%0A', 'page=1%0A', 'page=01', 'page=9007199254740992', 'pageSize=101', 'status=verified%0A', 'employeeId=' + f.employee.id + '%0A', 'unknown=1', 'q=' + 'x'.repeat(201)]) assert.throws(() => trainingCreditQuery(E, new URLSearchParams(query), fail));
  for (const query of ['year=2026', 'page=1', 'q=']) assert.throws(() => trainingCreditQuery(E, new URLSearchParams(query), fail, 'single'));
  for (const query of ['year=2026', 'compare=previous%0A', 'compare=next']) assert.throws(() => trainingCreditQuery(E, new URLSearchParams(query), fail, 'history'));
  for (const year of ['0001', '2026', '9999']) assert.equal(trainingCreditQuery(E, new URLSearchParams({ year }), fail).year, year);
  assert.equal(filterTrainingCredits(E, [item], { year: '2026', q: '合成' }).length, 1); assert.equal(filterTrainingCredits(E, [item], { year: '0001' }).length, 0);
});
test('ordinary editor preserves unchanged CRLF and exact decimals; closed acknowledgements reject divergent writes', t => {
  const f = fixture(t), item = f.create({ note: '  合成備註\r\n尾端  ' }), editor = createTrainingCreditEditor({ existing: item, employees: [f.employee] });
  assert.equal(editor.fields.find(field => field.name === 'creditValue').type, 'text'); assert.equal(editor.initial.sourceReference, '  合成依據\n尾端  '); assert.equal(editor.fields.find(field => field.name === 'employeeId').disabled, true);
  const payload = editor.build({ ...editor.initial, activityName: '  合成新名稱  ' }); assert.deepEqual(payload, { activityName: '合成新名稱' });
  const saved = f.patch(item, payload); confirmTrainingCreditSave({ item: saved }, { orgId: f.orgId, original: item, payload }); assert.equal(saved.sourceReference, item.sourceReference); assert.equal(saved.creditValue, item.creditValue); assert.equal(saved.note, item.note);
  for (const change of [{ version: 1 }, { creditValue: '1.23' }, { id: randomUUID() }, { unknown: 'x' }]) assert.throws(() => confirmTrainingCreditSave({ item: { ...saved, ...change } }, { orgId: f.orgId, original: item, payload }));
  assert.throws(() => editor.build({ ...editor.initial, creditValue: '1e2' })); assert.throws(() => editor.build({ ...editor.initial, arbitraryJSON: '{}' }));
});
