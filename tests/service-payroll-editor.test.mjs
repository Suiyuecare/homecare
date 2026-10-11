import test from 'node:test';
import assert from 'node:assert/strict';
import { createServicePayrollEditor, checkServicePayrollSource, checkServicePayrollCollection, checkServicePayrollPreview,
  checkServicePayrollSaved, checkServicePayrollOriginDetail, checkServicePayrollOriginCollection, servicePayrollSnapshotForDisplay,
  servicePayrollManualTotal } from '../public/data/service-payroll-editor.js';

const stamp = '2026-10-01T00:00:00.000Z', orgId = 'synthetic-org', caseId = 'synthetic-case', employeeId = 'synthetic-employee', month = '2026-10';
const clone = value => structuredClone(value);
function source(id = 'synthetic-service') {
  return { id, orgId, version: 3, caseId, employeeId: 'synthetic-employee', shiftId: 'synthetic-shift-' + id, date: '2026-10-01',
    actualStart: '08:00', actualEnd: '09:00', billingSnapshot: { capturedAt: stamp, currency: 'TWD', trial: true, source: 'approval', serviceMinutes: 60,
      employee: { id: 'synthetic-employee', name: '合成員工', employeeNo: 'SYN-E', hourlyRateCents: 20001 },
      items: [{ serviceItemId: 'synthetic-item', code: 'SYN-I', name: '合成核閱服務', quantity: 3, unitPriceCents: 35001, amountCents: 105003 }] }, createdAt: stamp, updatedAt: stamp };
}
function prepared() {
  const sources = [source()], editor = createServicePayrollEditor({ sources, orgId, employeeId, month, employeeName: '合成員工' });
  const values = { ...editor.initial, number: 'SYN-P-1', lineAmount0: '120.01', lineReference0: '  本筆人工依據\r\n尾行  ', sourceReference: '  共同人工依據\r\n尾行  ', note: '  備註\r\n尾行  ' };
  const payload = editor.buildPayload(values);
  const draft = { employeeId, month, number: payload.number, lineItems: [{ label: payload.lines[0].label, kind: 'earning', amountCents: 12001 }], sourceReference: payload.sourceReference,
    status: 'draft', note: payload.note, summary: { earningCents: 12001, deductionCents: 0, netCents: 12001 }, employeeSnapshot: { id: employeeId, name: '現在員工名稱', employeeNo: 'SYN-E-CURRENT' } };
  const preview = { mode: 'manual-service-payroll-v1', draft, sources: clone(sources), manualLines: clone(payload.lines), sourceCount: 1, previewHash: 'a'.repeat(64) };
  const item = { ...clone(draft), id: 'synthetic-statement', orgId, version: 1, createdAt: stamp, updatedAt: stamp };
  const origin = { id: 'synthetic-origin', orgId, version: 1, createdAt: stamp, updatedAt: stamp, payrollStatementId: item.id, employeeId, month, number: item.number,
    sourceReference: payload.sourceReference, note: payload.note, sourceSnapshots: clone(sources), manualLines: clone(payload.lines), initialStatementSnapshot: clone(item) };
  return { sources, editor, values, payload, preview, item, origin, saved: { mode: 'manual-service-payroll-v1', item: clone(item), origin: clone(origin) } };
}

test('manual amount starts blank, source trial total cannot become default payroll earning', () => {
  const f = prepared(); assert.equal(f.editor.initial.lineAmount0, ''); assert.equal(f.payload.lines[0].amountCents, 12001);
  assert.notEqual(f.payload.lines[0].amountCents, f.sources[0].billingSnapshot.items[0].amountCents);
  assert.throws(() => f.editor.buildPayload({ ...f.values, lineAmount0: '' }));
  assert.equal(f.editor.fields.filter(field => field.groupLabel).length, 3);
});
test('exact cents, explicit zero and bounded invalid monetary inputs', () => {
  const f = prepared(); for (const [raw, cents] of [['0', 0], ['0.01', 1], ['140.02', 14002], ['10000000', 1000000000], ['01', 100]]) {
    assert.equal(f.editor.buildPayload({ ...f.values, lineAmount0: raw }).lines[0].amountCents, cents);
  }
  for (const value of ['-1', '1e2', '1.005', '10000000.01', 'NaN', '1,000']) assert.throws(() => f.editor.buildPayload({ ...f.values, lineAmount0: value }));
});
test('unchanged captured source detached from caller and exact CRLF/space references survive', () => {
  const f = prepared(); assert.equal(f.payload.sourceReference, f.values.sourceReference); assert.equal(f.payload.lines[0].sourceReference, f.values.lineReference0); assert.equal(f.payload.note, f.values.note);
  f.sources[0].id = 'mutated'; f.sources[0].billingSnapshot.items[0].name = 'mutated'; f.editor.sources[0].id = 'exposed-mutated';
  const payload = f.editor.buildPayload(f.values); assert.equal(payload.lines[0].serviceRecordId, 'synthetic-service'); assert.equal(payload.lines[0].label, f.payload.lines[0].label);
});
test('employee/month immutable; cross-case source permitted; unknown form fields and missing per-source basis are rejected', () => {
  const f = prepared(); for (const patch of [{ employeeId: 'other-employee' }, { month: '2026-11' }, { sourceReference: ' ' }, { lineReference0: '' }, { trial: false }, { lineLabel0: 'bad\nlabel' }]) assert.throws(() => f.editor.buildPayload({ ...f.values, ...patch }));
});
test('source nested closed schema and precision; malformed values never silently project', () => {
  const original = source(); assert.deepEqual(checkServicePayrollSource(original, { orgId, employeeId, month }), original);
  for (const edit of [row => row.billingSnapshot.extra = 'unexpected', row => row.billingSnapshot.items[0].amountCents++, row => row.billingSnapshot.employee.id = 'foreign', row => row.version = Number.MAX_SAFE_INTEGER + 1,
    row => row.date += '\n', row => row.billingSnapshot.trial = false, row => row.orgId = 'foreign', row => row.billingSnapshot.items[0].unknown = 'unexpected']) { const row = clone(original); edit(row); assert.throws(() => checkServicePayrollSource(row, { orgId, employeeId, month })); }
});
test('malicious own/array getters are rejected without calling them', () => {
  let called = 0; const s = source(); Object.defineProperty(s.billingSnapshot.items, '0', { get() { called++; return {}; }, enumerable: true });
  assert.equal(servicePayrollSnapshotForDisplay(s.billingSnapshot), null);
  const f = prepared(); Object.defineProperty(f.preview.manualLines, '0', { get() { called++; return {}; }, enumerable: true });
  assert.throws(() => checkServicePayrollPreview(f.preview, { orgId, payload: f.payload, sources: f.sources }));
  const bad = { ...f.values }; Object.defineProperty(bad, 'number', { get() { called++; return 'secret'; }, enumerable: true }); assert.throws(() => f.editor.buildPayload(bad));
  const origin = clone(f.origin); Object.defineProperty(origin.sourceSnapshots, '0', { get() { called++; return {}; }, enumerable: true });
  assert.throws(() => checkServicePayrollOriginDetail({ origin, statement: f.item }, { orgId })); assert.equal(called, 0);
});
test('collection exact query/metadata scope and no duplicate source rows', () => {
  const response = { query: { employeeId, month, q: '' }, items: [source()], total: 1, page: 1, pageSize: 25 };
  assert.equal(checkServicePayrollCollection(response, { orgId, employeeId, month }).length, 1);
  for (const edit of [value => value.query.month = '2026-11', value => value.extra = 1, value => value.page = 2, value => { value.items.push(source()); value.total = 2; }, value => value.items[0].orgId = 'foreign']) {
    const bad = clone(response); edit(bad); assert.throws(() => checkServicePayrollCollection(bad, { orgId, employeeId, month }));
  }
});
test('preview exact source version, draft total and original references are confirmed', () => {
  const f = prepared(); assert.deepEqual(checkServicePayrollPreview(f.preview, { orgId, payload: f.payload, sources: f.sources }), f.preview);
  for (const edit of [value => value.draft.summary.netCents++, value => value.sources[0].version++, value => value.manualLines[0].sourceReference = 'trimmed', value => value.previewHash += '\n', value => value.draft.lineItems[0].kind = 'deduction',
    value => value.sources[0].billingSnapshot.items[0].name = 'replaced']) { const bad = clone(f.preview); edit(bad); assert.throws(() => checkServicePayrollPreview(bad, { orgId, payload: f.payload, sources: f.sources })); }
});
test('save ACK exact generation statement/origin/source required; unknown or partial writes never signal success', () => {
  const f = prepared(); assert.deepEqual(checkServicePayrollSaved(f.saved, { orgId, payload: f.payload, sources: f.sources, preview: f.preview }), f.saved);
  for (const edit of [value => delete value.origin, value => value.item.version = 2, value => value.origin.manualLines[0].amountCents++, value => value.origin.sourceSnapshots[0].billingSnapshot.items[0].unknown = 'unexpected',
    value => value.item.note = 'lost original', value => value.origin.initialStatementSnapshot.employeeSnapshot.id = 'other-case', value => value.origin.version = 2]) { const bad = clone(f.saved); edit(bad); assert.throws(() => checkServicePayrollSaved(bad, { orgId, payload: f.payload, sources: f.sources, preview: f.preview })); }
});
test('ACK caller sources close every nested descriptor before comparing; getters remain uncalled', () => {
  const f = prepared(); let getCount = 0; const unsafe = clone(f.sources);
  Object.defineProperty(unsafe[0], 'unexpected', { enumerable: true, get() { getCount++; return 'synthetic'; } });
  assert.throws(() => checkServicePayrollSaved(f.saved, { orgId, payload: f.payload, sources: unsafe, preview: f.preview }));
  assert.equal(getCount, 0);
  const nested = clone(f.sources); Object.defineProperty(nested[0].billingSnapshot.employee, 'name', { enumerable: true, get() { getCount++; return 'synthetic'; } });
  assert.throws(() => checkServicePayrollSaved(f.saved, { orgId, payload: f.payload, sources: nested })); assert.equal(getCount, 0);
});
test('optional preview and caller source arrays close before property reads with zero getter calls', () => {
  const f = prepared(); let getCount = 0; const unsafePreview = clone(f.preview);
  Object.defineProperty(unsafePreview, 'draft', { enumerable: true, get() { getCount++; return f.preview.draft; } });
  assert.throws(() => checkServicePayrollSaved(f.saved, { orgId, payload: f.payload, sources: f.sources, preview: unsafePreview })); assert.equal(getCount, 0);
  for (const target of ['array', 'source', 'nested']) {
    const sources = clone(f.sources);
    if (target === 'array') Object.defineProperty(sources, '0', { enumerable: true, get() { getCount++; return f.sources[0]; } });
    if (target === 'source') Object.defineProperty(sources[0], 'unknown', { enumerable: true, get() { getCount++; return 1; } });
    if (target === 'nested') Object.defineProperty(sources[0].billingSnapshot.items[0], 'name', { enumerable: true, get() { getCount++; return 'synthetic'; } });
    assert.throws(() => checkServicePayrollPreview(f.preview, { orgId, payload: f.payload, sources })); assert.equal(getCount, 0);
  }
  assert.throws(() => checkServicePayrollSaved(f.saved, { orgId, payload: f.payload, sources: f.sources, preview: null }));
});
test('saved generation amount stays fixed when current statement legitimately changes', () => {
  const f = prepared(); const statement = clone(f.item); statement.version = 2; statement.updatedAt = '2026-10-02T00:00:00.000Z'; statement.lineItems.push({ label: '  本次人工減項\n原文  ', kind: 'deduction', amountCents: 101 }); statement.summary.deductionCents = 101; statement.summary.netCents = 11900; statement.sourceReference = '';
  const result = checkServicePayrollOriginDetail({ origin: f.origin, statement }, { orgId, statementId: statement.id });
  assert.equal(result.origin.initialStatementSnapshot.summary.netCents, 12001); assert.equal(result.statement.summary.netCents, 11900);
  assert.equal(result.origin.sourceSnapshots[0].billingSnapshot.items[0].amountCents, 105003);
  const collection = { query: { employeeId, month, q: '' }, items: [{ origin: f.origin, statement }], total: 1, page: 1, pageSize: 25 };
  assert.equal(checkServicePayrollOriginCollection(collection, { orgId, employeeId, month }).length, 1);
  collection.items.push(clone(collection.items[0])); collection.total = 2; assert.throws(() => checkServicePayrollOriginCollection(collection, { orgId, employeeId, month }));
});
test('manual source duplicate, bad array slots and missing lines do not reach precision calculation', () => {
  const f = prepared(); assert.equal(servicePayrollManualTotal(f.payload.lines), 12001);
  assert.throws(() => servicePayrollManualTotal([...f.payload.lines, clone(f.payload.lines[0])]));
  const bad = clone(f.payload.lines); bad.extra = 'unknown'; assert.throws(() => servicePayrollManualTotal(bad));
  const sparse = new Array(1); assert.throws(() => servicePayrollManualTotal(sparse)); assert.throws(() => servicePayrollManualTotal([]));
});
test('current origin read rejects foreign statement identity or altered initial generation but permits reviewed/closed/voided', () => {
  const f = prepared(); for (const status of ['reviewed', 'closed', 'voided']) { const statement = { ...clone(f.item), status, version: 2, updatedAt: '2026-10-02T00:00:00.000Z' }; assert.equal(checkServicePayrollOriginDetail({ origin: f.origin, statement }, { orgId }).statement.status, status); }
  for (const edit of [value => value.statement.employeeId = 'foreign', value => value.statement.id = 'other', value => value.origin.initialStatementSnapshot.lineItems[0].amountCents++, value => value.statement.unknown = 'unexpected']) {
    const bad = { origin: clone(f.origin), statement: clone(f.item) }; edit(bad); assert.throws(() => checkServicePayrollOriginDetail(bad, { orgId }));
  }
});
test('saved ISO seconds/offset remain exact while manual minute comparison verifies approved time', () => {
  const row = source(); row.actualStart = '2026-10-01T08:00:59+08:00'; row.actualEnd = '2026-10-01T09:00:01+08:00';
  assert.equal(checkServicePayrollSource(row, { orgId, employeeId, month }).actualStart, row.actualStart);
  const badMinute = clone(row); badMinute.billingSnapshot.serviceMinutes++; assert.throws(() => checkServicePayrollSource(badMinute, { orgId, employeeId, month }));
  const badMeta = clone(row); badMeta.updatedAt = '2026-09-30T00:00:00.000Z'; assert.throws(() => checkServicePayrollSource(badMeta, { orgId, employeeId, month }));
  row.billingSnapshot.employee.name = ''; row.billingSnapshot.employee.employeeNo = '長'.repeat(500); row.billingSnapshot.items[0].code = '';
  assert.equal(checkServicePayrollSource(row, { orgId, employeeId, month }).billingSnapshot.employee.employeeNo.length, 500);
});
test('100 manual rows retain complete 2000-character references without trial amount defaults', () => {
  const sources = Array.from({ length: 100 }, (_, index) => source('synthetic-service-' + index));
  const editor = createServicePayrollEditor({ sources, orgId, employeeId, month, employeeName: '合成' });
  const values = { ...editor.initial, number: 'SYN-100', sourceReference: '共同依據', note: '  保存備註  ' };
  for (let index = 0; index < 100; index++) { values['lineAmount' + index] = '0.01'; values['lineReference' + index] = '字'.repeat(1996) + '\r\n  '; }
  const payload = editor.buildPayload(values); assert.equal(payload.lines.length, 100); assert.equal(servicePayrollManualTotal(payload.lines), 100);
  assert.equal(payload.lines[99].sourceReference, values.lineReference99); assert(Buffer.byteLength(JSON.stringify(payload), 'utf8') > 131072);
});

test('same employee/month source can span cases without mutating saved trial employee identity', () => {
  const first = source('synthetic-service-first'), second = source('synthetic-service-second'); second.caseId = 'synthetic-case-second';
  const sources = [first, second]; const editor = createServicePayrollEditor({ sources, orgId, employeeId, month, employeeName: '現在員工名稱' });
  const values = { ...editor.initial, number: 'SYN-CROSS-CASE', sourceReference: '共同人工依據', lineAmount0: '120.01', lineAmount1: '140.02', lineReference0: '第一案人工核對', lineReference1: '第二案人工核對' };
  const payload = editor.buildPayload(values); assert.equal(servicePayrollManualTotal(payload.lines), 26003); assert.equal(payload.lines.length, 2);
  assert.equal(editor.initial.lineAmount0, ''); assert.equal(editor.initial.lineAmount1, ''); assert.notEqual(sources[0].caseId, sources[1].caseId);
  assert.equal(editor.sources[0].billingSnapshot.employee.name, '合成員工');
  const foreignEmployee = clone(second); foreignEmployee.employeeId = 'other-employee'; foreignEmployee.billingSnapshot.employee.id = 'other-employee';
  assert.throws(() => createServicePayrollEditor({ sources: [first, foreignEmployee], orgId, employeeId, month }));
  const badCase = clone(second); badCase.caseId = 'bad-case\n'; assert.throws(() => checkServicePayrollSource(badCase, { orgId, employeeId, month }));
});
test('current employee captured at generation is separate from original approved employee name and rate', () => {
  const f = prepared(); const saved = checkServicePayrollSaved(f.saved, { orgId, payload: f.payload, sources: f.sources, preview: f.preview });
  assert.equal(saved.item.employeeSnapshot.name, '現在員工名稱'); assert.equal(saved.origin.sourceSnapshots[0].billingSnapshot.employee.name, '合成員工');
  assert.equal(saved.origin.sourceSnapshots[0].billingSnapshot.employee.hourlyRateCents, 20001);
  const wrong = clone(f.saved); wrong.item.employeeSnapshot.name = 'different current name'; wrong.origin.initialStatementSnapshot.employeeSnapshot.name = 'different current name';
  assert.throws(() => checkServicePayrollSaved(wrong, { orgId, payload: f.payload, sources: f.sources, preview: f.preview }));
});
test('origin current subtraction remains precise and rejects negative/inconsistent/unknown summary', () => {
  const f = prepared();
  for (const edit of [row => row.statement.summary.deductionCents = 1, row => row.statement.summary.netCents = -1,
    row => row.statement.lineItems.push({ label: 'too much', kind: 'deduction', amountCents: 12002 }), row => row.statement.summary.unknown = 1,
    row => row.statement.employeeSnapshot.name = { unexpected: 'nested' }, row => row.origin.initialStatementSnapshot.employeeSnapshot.extra = 'unknown',
    row => row.statement.createdAt = '2026-10-02T00:00:00.000Z', row => row.statement.version = Number.MAX_SAFE_INTEGER + 1]) {
    const row = { origin: clone(f.origin), statement: clone(f.item) }; edit(row); assert.throws(() => checkServicePayrollOriginDetail(row, { orgId }));
  }
});
test('array and unknown descriptor guards never call any getter in source, preview, ACK or current statement', () => {
  const f = prepared(); let getCount = 0;
  const define = (target, key) => Object.defineProperty(target, key, { enumerable: true, get() { getCount++; return 'never'; } });
  const sourceCase = source(); define(sourceCase, 'caseId'); assert.throws(() => checkServicePayrollSource(sourceCase, { orgId, employeeId, month }));
  const sources = clone(f.sources); define(sources, '0'); assert.throws(() => createServicePayrollEditor({ sources, orgId, employeeId, month }));
  const preview = clone(f.preview); define(preview.sources, '0'); assert.throws(() => checkServicePayrollPreview(preview, { orgId, payload: f.payload, sources: f.sources }));
  const pair = { origin: clone(f.origin), statement: clone(f.item) }; define(pair.statement.lineItems, '0'); assert.throws(() => checkServicePayrollOriginDetail(pair, { orgId }));
  const ack = clone(f.saved); define(ack.origin.initialStatementSnapshot.summary, 'netCents'); assert.throws(() => checkServicePayrollSaved(ack, { orgId, payload: f.payload, sources: f.sources }));
  const collection = { query: { employeeId, month, q: '' }, items: [source()], total: 1, page: 1, pageSize: 25 }; define(collection.items, '0');
  assert.throws(() => checkServicePayrollCollection(collection, { orgId, employeeId, month })); assert.equal(getCount, 0);
});
test('exact page cardinality distinguishes complete empty page from silently truncated source/origin response', () => {
  const options = { orgId, employeeId, month, page: 2, pageSize: 25 }; const f = prepared();
  const empty = { query: { employeeId, month, q: '' }, items: [], total: 25, page: 2, pageSize: 25 };
  assert.deepEqual(checkServicePayrollCollection(empty, options), []);
  assert.throws(() => checkServicePayrollCollection({ ...empty, total: 26 }, options));
  const origins = { query: { employeeId, month, q: '' }, items: [{ origin: f.origin, statement: f.item }], total: 2, page: 1, pageSize: 25 };
  assert.throws(() => checkServicePayrollOriginCollection(origins, { orgId, employeeId, month }));
});
