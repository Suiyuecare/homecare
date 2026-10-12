import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EMPLOYEE_PAYROLL_WARNINGS, confirmPayrollList, confirmPayrollCandidates, confirmPayrollHistory, confirmPayrollAck, buildPayrollProfile, confirmEmployeePayrollPreview } from '../public/data/employee-payroll-ui.js';
import { canonicalCalculationJson, exactCentsOperation } from '../public/data/calculation-core.js';

const stamp = '2026-10-12T00:00:00.000Z';
const profile = () => ({ id: 'synthetic-profile', orgId: 'synthetic-org', version: 1, createdAt: stamp, updatedAt: stamp, employeeId: 'synthetic-employee', validFrom: '2026-10-01', validTo: '2026-10-31', payrollMode: 'hourly', hourlyRateCents: 60, shareBasisPoints: null, splitBasis: null, aaTreatment: 'not-applicable', rounding: 'half-up', approvalReference: '合成核定依據', note: '', status: 'approved' });
const employee = () => ({ id: 'synthetic-employee', name: '合成員工', employeeNo: 'SYN-1', version: 1 });
const list = () => ({ orgId: 'synthetic-org', items: [profile()], employeeSnapshots: [employee()], total: 1, page: 1, pageSize: 25 });
const query = { orgId: 'synthetic-org', page: 1 };
const source = () => ({ id: 'synthetic-source', orgId: 'synthetic-org', version: 2, createdAt: stamp, updatedAt: stamp, shiftId: 'synthetic-shift', caseId: 'synthetic-case', employeeId: 'synthetic-employee', date: '2026-10-31', actualStart: '23:59', actualEnd: '00:00', actualEndDate: '2026-11-01', services: [{ serviceItemId: 'synthetic-item', quantity: 1 }], status: 'approved', note: '', reviewNote: '', billingSnapshot: { capturedAt: stamp, currency: 'TWD', trial: true, source: 'approval', serviceMinutes: 1, employee: { id: 'synthetic-employee', name: '合成員工', employeeNo: 'SYN-1', hourlyRateCents: 1 }, items: [{ serviceItemId: 'synthetic-item', code: 'BA17d1', name: '合成服務', quantity: 1, unitPriceCents: 101, amountCents: 101 }] } });
const payload = () => ({ profile: { id: 'synthetic-profile', version: 1 }, month: '2026-10', sources: [{ id: 'synthetic-source', version: 2 }] });
const rehash = value => { const { previewHash, ...body } = value; value.previewHash = createHash('sha256').update(canonicalCalculationJson(body)).digest('hex'); return value; };
function preview() {
  const trace = exactCentsOperation({ operation: 'minutes-hourly', minutes: 1, hourlyRateCents: 60, rounding: 'half-up' });
  return rehash({ mode: 'employee-payroll-preview-v1', previewOnly: true, orgId: 'synthetic-org', month: '2026-10', currency: 'TWD', employeeSnapshot: employee(), profileSnapshot: profile(), sourceSnapshots: [source()], lines: [{ serviceRecordId: 'synthetic-source', version: 2, date: '2026-10-31', serviceMinutes: 1, basisCents: null, amountCents: 1, trace }], totalAmountCents: 1, warnings: [...EMPLOYEE_PAYROLL_WARNINGS], previewHash: '' });
}
test('list verifies page employee projections exactly once and rejects wrong organization or hidden extra employee', () => {
  assert.equal(confirmPayrollList(list(), query).items.length, 1);
  for (const result of [{ ...list(), orgId: 'other-org' }, { ...list(), employeeSnapshots: [] }, { ...list(), employeeSnapshots: [employee(), employee()] }, { ...list(), employeeSnapshots: [{ ...employee(), id: 'other-employee' }] }]) assert.throws(() => confirmPayrollList(result, query));
});
test('array validation rejects sparse plus extra-property arrays and accessors before invoking getters', async () => {
  for (const key of ['items', 'employeeSnapshots']) {
    const result = list(), array = []; array.length = 1; array.extra = key === 'items' ? profile() : employee(); result[key] = array; assert.throws(() => confirmPayrollList(result, query));
    let called = false; const getters = []; Object.defineProperty(getters, '0', { enumerable: true, get() { called = true; return profile(); } }); result[key] = getters; assert.throws(() => confirmPayrollList(result, query)); assert.equal(called, false);
  }
  for (const key of ['sourceSnapshots', 'lines', 'warnings']) {
    const result = preview(); let called = false; const array = []; Object.defineProperty(array, '0', { enumerable: true, get() { called = true; return null; } }); result[key] = array;
    await assert.rejects(confirmEmployeePayrollPreview(result, payload(), 'synthetic-org', profile())); assert.equal(called, false);
  }
});
test('unknown ACK fields, altered saved value, wrong identity and getters never establish save success', () => {
  assert.equal(confirmPayrollAck({ item: profile() }, { orgId: 'synthetic-org', id: 'synthetic-profile', version: 1, expected: { hourlyRateCents: 60 } }).hourlyRateCents, 60);
  for (const result of [{ item: profile(), extra: true }, { item: { ...profile(), orgId: 'other-org' } }, { item: { ...profile(), hourlyRateCents: 61 } }, { item: { ...profile(), version: 2 } }]) assert.throws(() => confirmPayrollAck(result, { orgId: 'synthetic-org', id: 'synthetic-profile', version: 1, expected: { hourlyRateCents: 60 } }));
  let called = false; const getter = { item: profile() }; Object.defineProperty(getter, 'item', { get() { called = true; return profile(); }, enumerable: true }); assert.throws(() => confirmPayrollAck(getter, { orgId: 'synthetic-org' })); assert.equal(called, false);
});
test('human money and percent input preserve exact cents with no foreign制度 values or implicit rates', () => {
  const value = { ...profile(), hourlyRateCents: '0.60' }; assert.equal(buildPayrollProfile(value).hourlyRateCents, 60); assert.equal(buildPayrollProfile(value).shareBasisPoints, null);
  assert.equal(buildPayrollProfile({ ...value, hourlyRateCents: '2.01' }).hourlyRateCents, 201);
  assert.equal(buildPayrollProfile({ ...value, hourlyRateCents: '0.01' }).hourlyRateCents, 1);
  const split = { ...value, payrollMode: 'split', shareBasisPoints: '50.01', splitBasis: 'approved-service-snapshot', aaTreatment: 'exclude' }; assert.equal(buildPayrollProfile(split).shareBasisPoints, 5001); assert.equal(buildPayrollProfile(split).hourlyRateCents, null);
  assert.equal(buildPayrollProfile({ ...split, shareBasisPoints: '0.01' }).shareBasisPoints, 1); assert.equal(buildPayrollProfile({ ...split, shareBasisPoints: '100.00' }).shareBasisPoints, 10000);
  for (const hourlyRateCents of ['', '0', '-0', '01', '1.001', '1e3', '10000000.01']) assert.throws(() => buildPayrollProfile({ ...value, hourlyRateCents }));
  for (const shareBasisPoints of ['', '0', '0.001', '100.01', '1e2']) assert.throws(() => buildPayrollProfile({ ...split, shareBasisPoints }), error => error.fields.shareBasisPoints.includes('百分') || error.fields.shareBasisPoints.includes('比例'));
});
test('editing other fields and copying drafts preserve untouched raw CRLF, lone CR and surrounding whitespace', () => {
  for (const raw of [' 合成第一行\r\n第二行 ', '\t合成第一行\r第二行\t', ' 合成未改空白依據 ', '\r\n']) {
    const original = { ...profile(), status: 'draft', note: raw, approvalReference: raw }, values = { ...original, hourlyRateCents: '2.01', note: raw.replace(/\r\n?/g, '\n'), approvalReference: raw.replace(/\r\n?/g, '\n') };
    const edit = buildPayrollProfile(values, 'draft', original), copy = buildPayrollProfile({ ...values, validFrom: '2026-11-01', validTo: '2026-11-30' }, 'draft', original);
    assert.equal(edit.hourlyRateCents, 201); assert.equal(edit.note, raw); assert.equal(edit.approvalReference, raw); assert.equal(copy.note, raw); assert.equal(copy.approvalReference, raw);
  }
});
test('explicit text replacement and clear take effect without changing the other untouched text field', () => {
  const original = { ...profile(), status: 'draft', note: ' 合成備註\r\n末行\r尾 ', approvalReference: ' 合成依據\r\n版次 ' }, baseline = { ...original, hourlyRateCents: '0.60', note: original.note.replace(/\r\n?/g, '\n'), approvalReference: original.approvalReference.replace(/\r\n?/g, '\n') };
  const changed = buildPayrollProfile({ ...baseline, note: '明確新備註\n末行' }, 'draft', original); assert.equal(changed.note, '明確新備註\n末行'); assert.equal(changed.approvalReference, original.approvalReference);
  const cleared = buildPayrollProfile({ ...baseline, note: '', approvalReference: '' }, 'draft', original); assert.equal(cleared.note, ''); assert.equal(cleared.approvalReference, '');
  const reference = buildPayrollProfile({ ...baseline, approvalReference: ' 明確新依據 ' }, 'draft', original); assert.equal(reference.approvalReference, '明確新依據'); assert.equal(reference.note, original.note);
  let invoked = false; const accessor = { ...original }; Object.defineProperty(accessor, 'note', { enumerable: true, get() { invoked = true; return original.note; } }); assert.throws(() => buildPayrollProfile(baseline, 'draft', accessor)); assert.equal(invoked, false);
});
test('candidate envelope verifies exact employee month paging and prevents sparse/getter data', () => {
  const request = { orgId: 'synthetic-org', employeeId: 'synthetic-employee', month: '2026-10', page: 1 }, result = { ...request, pageSize: 25, total: 1, items: [{ id: 'synthetic-source', orgId: 'synthetic-org', employeeId: 'synthetic-employee', version: 2, date: '2026-10-31', serviceMinutes: 1, label: '合成服務' }] };
  assert.equal(confirmPayrollCandidates(result, request).total, 1);
  assert.throws(() => confirmPayrollCandidates({ ...result, month: '2026-11' }, request)); assert.throws(() => confirmPayrollCandidates({ ...result, items: [{ ...result.items[0], employeeId: 'other-employee' }] }, request));
});
test('history validates complete descending versions, exact snapshot and actual saved time', () => {
  const value = { orgId: 'synthetic-org', id: 'synthetic-profile', total: 1, items: [{ version: 1, source: 'employee-payroll.create', createdAt: stamp, snapshot: { ...profile(), status: 'draft' } }] };
  assert.equal(confirmPayrollHistory(value, { orgId: value.orgId, id: value.id }).total, 1); assert.throws(() => confirmPayrollHistory({ ...value, total: 2 }, { orgId: value.orgId, id: value.id })); assert.throws(() => confirmPayrollHistory({ ...value, items: [{ ...value.items[0], version: 2 }] }, { orgId: value.orgId, id: value.id }));
});
test('occupied service ending exactly midnight remains valid through last covered calendar day', async () => {
  assert.equal((await confirmEmployeePayrollPreview(preview(), payload(), 'synthetic-org', profile())).totalAmountCents, 1);
  const extraMinute = preview(); extraMinute.sourceSnapshots[0].actualEnd = '00:01'; extraMinute.sourceSnapshots[0].billingSnapshot.serviceMinutes = 2; extraMinute.lines[0].serviceMinutes = 2; extraMinute.lines[0].trace = exactCentsOperation({ operation: 'minutes-hourly', minutes: 2, hourlyRateCents: 60, rounding: 'half-up' }); extraMinute.lines[0].amountCents = 2; extraMinute.totalAmountCents = 2; rehash(extraMinute); await assert.rejects(confirmEmployeePayrollPreview(extraMinute, payload(), 'synthetic-org', profile()));
});
test('preview checks exact trace, source version, totals, SHA and selected profile even with rehashed tampering', async () => {
  for (const mutate of [value => value.totalAmountCents++, value => value.lines[0].trace = { ...value.lines[0].trace, numerator: '61' }, value => value.sourceSnapshots[0].version++, value => value.previewHash = '0'.repeat(64)]) {
    const value = preview(); mutate(value); await assert.rejects(confirmEmployeePayrollPreview(value, payload(), 'synthetic-org', profile()));
  }
  const altered = preview(); altered.profileSnapshot.hourlyRateCents = 120; altered.lines[0].trace = exactCentsOperation({ operation: 'minutes-hourly', minutes: 1, hourlyRateCents: 120, rounding: 'half-up' }); altered.lines[0].amountCents = 2; altered.totalAmountCents = 2; rehash(altered); await assert.rejects(confirmEmployeePayrollPreview(altered, payload(), 'synthetic-org', profile()));
  const misleading = preview(); misleading.warnings[0] = '正式薪資已發放'; rehash(misleading); await assert.rejects(confirmEmployeePayrollPreview(misleading, payload(), 'synthetic-org', profile()));
});
