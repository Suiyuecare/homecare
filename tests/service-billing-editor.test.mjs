import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceBillingEditor, checkServiceBillingSource, checkServiceBillingCollection, checkServiceBillingPreview,
  checkServiceBillingSaved, checkServiceBillingOriginDetail, checkServiceBillingOriginCollection, serviceBillingSnapshotForDisplay,
  serviceBillingManualTotal } from '../public/data/service-billing-editor.js';

const stamp = '2026-10-01T00:00:00.000Z', orgId = 'synthetic-org', caseId = 'synthetic-case', month = '2026-10';
const clone = value => structuredClone(value);
function source(id = 'synthetic-service') {
  return { id, orgId, version: 3, caseId, employeeId: 'synthetic-employee', shiftId: 'synthetic-shift-' + id, date: '2026-10-01',
    actualStart: '08:00', actualEnd: '09:00', billingSnapshot: { capturedAt: stamp, currency: 'TWD', trial: true, source: 'approval', serviceMinutes: 60,
      employee: { id: 'synthetic-employee', name: '合成員工', employeeNo: 'SYN-E', hourlyRateCents: 20001 },
      items: [{ serviceItemId: 'synthetic-item', code: 'SYN-I', name: '合成核閱服務', quantity: 3, unitPriceCents: 35001, amountCents: 105003 }] }, createdAt: stamp, updatedAt: stamp };
}
function prepared() {
  const sources = [source()], editor = createServiceBillingEditor({ sources, orgId, caseId, month, caseName: '合成個案' });
  const values = { ...editor.initial, number: 'SYN-B-1', lineAmount0: '120.01', lineReference0: '  本筆人工依據\r\n尾行  ', sourceReference: '  共同人工依據\r\n尾行  ', note: '  備註\r\n尾行  ' };
  const payload = editor.buildPayload(values);
  const draft = { caseId, month, number: payload.number, lineItems: [{ label: payload.lines[0].label, quantity: 1, unitPriceCents: 12001 }], sourceReference: payload.sourceReference,
    status: 'draft', note: payload.note, summary: { amountCents: 12001 }, caseSnapshot: { id: caseId, name: '合成個案', caseNo: 'SYN-C' } };
  const preview = { mode: 'manual-service-billing-v1', draft, sources: clone(sources), manualLines: clone(payload.lines), sourceCount: 1, previewHash: 'a'.repeat(64) };
  const item = { ...clone(draft), id: 'synthetic-bill', orgId, version: 1, createdAt: stamp, updatedAt: stamp };
  const origin = { id: 'synthetic-origin', orgId, version: 1, createdAt: stamp, updatedAt: stamp, billingDocumentId: item.id, caseId, month, number: item.number,
    sourceReference: payload.sourceReference, note: payload.note, sourceSnapshots: clone(sources), manualLines: clone(payload.lines), initialBillSnapshot: clone(item) };
  return { sources, editor, values, payload, preview, item, origin, saved: { mode: 'manual-service-billing-v1', item: clone(item), origin: clone(origin) } };
}

test('manual amount starts blank, source trial total cannot become default bill price', () => {
  const f = prepared(); assert.equal(f.editor.initial.lineAmount0, ''); assert.equal(f.payload.lines[0].amountCents, 12001);
  assert.notEqual(f.payload.lines[0].amountCents, f.sources[0].billingSnapshot.items[0].amountCents);
  assert.throws(() => f.editor.buildPayload({ ...f.values, lineAmount0: '' }));
  assert.equal(f.editor.fields.filter(field => field.groupLabel).length, 3);
});
test('exact cents, explicit zero and bounded invalid monetary inputs', () => {
  const f = prepared(); for (const [raw, cents] of [['0', 0], ['0.01', 1], ['140.02', 14002], ['10000000', 1000000000]]) {
    assert.equal(f.editor.buildPayload({ ...f.values, lineAmount0: raw }).lines[0].amountCents, cents);
  }
  for (const value of ['-1', '1e2', '1.005', '10000000.01', 'NaN', '1,000', '01']) assert.throws(() => f.editor.buildPayload({ ...f.values, lineAmount0: value }));
});
test('unchanged captured source detached from caller and exact CRLF/space references survive', () => {
  const f = prepared(); assert.equal(f.payload.sourceReference, f.values.sourceReference); assert.equal(f.payload.lines[0].sourceReference, f.values.lineReference0); assert.equal(f.payload.note, f.values.note);
  f.sources[0].id = 'mutated'; f.sources[0].billingSnapshot.items[0].name = 'mutated'; f.editor.sources[0].id = 'exposed-mutated';
  const payload = f.editor.buildPayload(f.values); assert.equal(payload.lines[0].serviceRecordId, 'synthetic-service'); assert.equal(payload.lines[0].label, f.payload.lines[0].label);
});
test('case/month immutable; unknown form fields and missing per-source basis are rejected', () => {
  const f = prepared(); for (const patch of [{ caseId: 'other-case' }, { month: '2026-11' }, { sourceReference: ' ' }, { lineReference0: '' }, { trial: false }, { lineLabel0: 'bad\nlabel' }]) assert.throws(() => f.editor.buildPayload({ ...f.values, ...patch }));
});
test('source nested closed schema and precision; malformed values never silently project', () => {
  const original = source(); assert.deepEqual(checkServiceBillingSource(original, { orgId, caseId, month }), original);
  for (const edit of [row => row.billingSnapshot.extra = 'unexpected', row => row.billingSnapshot.items[0].amountCents++, row => row.billingSnapshot.employee.id = 'foreign', row => row.version = Number.MAX_SAFE_INTEGER + 1,
    row => row.date += '\n', row => row.billingSnapshot.trial = false, row => row.orgId = 'foreign', row => row.billingSnapshot.items[0].unknown = 'unexpected']) { const row = clone(original); edit(row); assert.throws(() => checkServiceBillingSource(row, { orgId, caseId, month })); }
});
test('malicious own/array getters are rejected without calling them', () => {
  let called = 0; const s = source(); Object.defineProperty(s.billingSnapshot.items, '0', { get() { called++; return {}; }, enumerable: true });
  assert.equal(serviceBillingSnapshotForDisplay(s.billingSnapshot), null);
  const f = prepared(); Object.defineProperty(f.preview.manualLines, '0', { get() { called++; return {}; }, enumerable: true });
  assert.throws(() => checkServiceBillingPreview(f.preview, { orgId, payload: f.payload, sources: f.sources }));
  const bad = { ...f.values }; Object.defineProperty(bad, 'number', { get() { called++; return 'secret'; }, enumerable: true }); assert.throws(() => f.editor.buildPayload(bad));
  const origin = clone(f.origin); Object.defineProperty(origin.sourceSnapshots, '0', { get() { called++; return {}; }, enumerable: true });
  assert.throws(() => checkServiceBillingOriginDetail({ origin, bill: f.item }, { orgId })); assert.equal(called, 0);
});
test('collection exact query/metadata scope and no duplicate source rows', () => {
  const response = { query: { caseId, month, q: '' }, items: [source()], total: 1, page: 1, pageSize: 25 };
  assert.equal(checkServiceBillingCollection(response, { orgId, caseId, month }).length, 1);
  for (const edit of [value => value.query.month = '2026-11', value => value.extra = 1, value => value.page = 2, value => { value.items.push(source()); value.total = 2; }, value => value.items[0].orgId = 'foreign']) {
    const bad = clone(response); edit(bad); assert.throws(() => checkServiceBillingCollection(bad, { orgId, caseId, month }));
  }
});
test('preview exact source version, draft total and original references are confirmed', () => {
  const f = prepared(); assert.deepEqual(checkServiceBillingPreview(f.preview, { orgId, payload: f.payload, sources: f.sources }), f.preview);
  for (const edit of [value => value.draft.summary.amountCents++, value => value.sources[0].version++, value => value.manualLines[0].sourceReference = 'trimmed', value => value.previewHash += '\n', value => value.draft.lineItems[0].quantity = 3,
    value => value.sources[0].billingSnapshot.items[0].name = 'replaced']) { const bad = clone(f.preview); edit(bad); assert.throws(() => checkServiceBillingPreview(bad, { orgId, payload: f.payload, sources: f.sources })); }
});
test('save ACK exact generation bill/origin/source required; unknown or partial writes never signal success', () => {
  const f = prepared(); assert.deepEqual(checkServiceBillingSaved(f.saved, { orgId, payload: f.payload, sources: f.sources, preview: f.preview }), f.saved);
  for (const edit of [value => delete value.origin, value => value.item.version = 2, value => value.origin.manualLines[0].amountCents++, value => value.origin.sourceSnapshots[0].billingSnapshot.items[0].unknown = 'unexpected',
    value => value.item.note = 'lost original', value => value.origin.initialBillSnapshot.caseSnapshot.id = 'other-case', value => value.origin.version = 2]) { const bad = clone(f.saved); edit(bad); assert.throws(() => checkServiceBillingSaved(bad, { orgId, payload: f.payload, sources: f.sources, preview: f.preview })); }
});
test('ACK caller sources close every nested descriptor before comparing; getters remain uncalled', () => {
  const f = prepared(); let getCount = 0; const unsafe = clone(f.sources);
  Object.defineProperty(unsafe[0], 'unexpected', { enumerable: true, get() { getCount++; return 'synthetic'; } });
  assert.throws(() => checkServiceBillingSaved(f.saved, { orgId, payload: f.payload, sources: unsafe, preview: f.preview }));
  assert.equal(getCount, 0);
  const nested = clone(f.sources); Object.defineProperty(nested[0].billingSnapshot.employee, 'name', { enumerable: true, get() { getCount++; return 'synthetic'; } });
  assert.throws(() => checkServiceBillingSaved(f.saved, { orgId, payload: f.payload, sources: nested })); assert.equal(getCount, 0);
});
test('optional preview and caller source arrays close before property reads with zero getter calls', () => {
  const f = prepared(); let getCount = 0; const unsafePreview = clone(f.preview);
  Object.defineProperty(unsafePreview, 'draft', { enumerable: true, get() { getCount++; return f.preview.draft; } });
  assert.throws(() => checkServiceBillingSaved(f.saved, { orgId, payload: f.payload, sources: f.sources, preview: unsafePreview })); assert.equal(getCount, 0);
  for (const target of ['array', 'source', 'nested']) {
    const sources = clone(f.sources);
    if (target === 'array') Object.defineProperty(sources, '0', { enumerable: true, get() { getCount++; return f.sources[0]; } });
    if (target === 'source') Object.defineProperty(sources[0], 'unknown', { enumerable: true, get() { getCount++; return 1; } });
    if (target === 'nested') Object.defineProperty(sources[0].billingSnapshot.items[0], 'name', { enumerable: true, get() { getCount++; return 'synthetic'; } });
    assert.throws(() => checkServiceBillingPreview(f.preview, { orgId, payload: f.payload, sources })); assert.equal(getCount, 0);
  }
  assert.throws(() => checkServiceBillingSaved(f.saved, { orgId, payload: f.payload, sources: f.sources, preview: null }));
});
test('saved generation amount stays fixed when current bill legitimately changes', () => {
  const f = prepared(); const bill = clone(f.item); bill.version = 2; bill.updatedAt = '2026-10-02T00:00:00.000Z'; bill.lineItems[0].quantity = 2; bill.summary.amountCents = 24002; bill.sourceReference = '';
  const result = checkServiceBillingOriginDetail({ origin: f.origin, bill }, { orgId, billId: bill.id });
  assert.equal(result.origin.initialBillSnapshot.summary.amountCents, 12001); assert.equal(result.bill.summary.amountCents, 24002);
  assert.equal(result.origin.sourceSnapshots[0].billingSnapshot.items[0].amountCents, 105003);
  const collection = { query: { caseId, month, q: '' }, items: [{ origin: f.origin, bill }], total: 1, page: 1, pageSize: 25 };
  assert.equal(checkServiceBillingOriginCollection(collection, { orgId, caseId, month }).length, 1);
  collection.items.push(clone(collection.items[0])); collection.total = 2; assert.throws(() => checkServiceBillingOriginCollection(collection, { orgId, caseId, month }));
});
test('manual source duplicate, bad array slots and missing lines do not reach precision calculation', () => {
  const f = prepared(); assert.equal(serviceBillingManualTotal(f.payload.lines), 12001);
  assert.throws(() => serviceBillingManualTotal([...f.payload.lines, clone(f.payload.lines[0])]));
  const bad = clone(f.payload.lines); bad.extra = 'unknown'; assert.throws(() => serviceBillingManualTotal(bad));
  const sparse = new Array(1); assert.throws(() => serviceBillingManualTotal(sparse)); assert.throws(() => serviceBillingManualTotal([]));
});
test('current origin read rejects foreign bill identity or altered initial generation but permits issued/voided', () => {
  const f = prepared(); for (const status of ['issued', 'voided']) { const bill = { ...clone(f.item), status, version: 2, updatedAt: '2026-10-02T00:00:00.000Z' }; assert.equal(checkServiceBillingOriginDetail({ origin: f.origin, bill }, { orgId }).bill.status, status); }
  for (const edit of [value => value.bill.caseId = 'foreign', value => value.bill.id = 'other', value => value.origin.initialBillSnapshot.lineItems[0].unitPriceCents++, value => value.bill.unknown = 'unexpected']) {
    const bad = { origin: clone(f.origin), bill: clone(f.item) }; edit(bad); assert.throws(() => checkServiceBillingOriginDetail(bad, { orgId }));
  }
});
test('saved ISO seconds/offset remain exact while manual minute comparison verifies approved time', () => {
  const row = source(); row.actualStart = '2026-10-01T08:00:59+08:00'; row.actualEnd = '2026-10-01T09:00:01+08:00';
  assert.equal(checkServiceBillingSource(row, { orgId, caseId, month }).actualStart, row.actualStart);
  const badMinute = clone(row); badMinute.billingSnapshot.serviceMinutes++; assert.throws(() => checkServiceBillingSource(badMinute, { orgId, caseId, month }));
  const badMeta = clone(row); badMeta.updatedAt = '2026-09-30T00:00:00.000Z'; assert.throws(() => checkServiceBillingSource(badMeta, { orgId, caseId, month }));
  row.billingSnapshot.employee.name = ''; row.billingSnapshot.employee.employeeNo = '長'.repeat(500); row.billingSnapshot.items[0].code = '';
  assert.equal(checkServiceBillingSource(row, { orgId, caseId, month }).billingSnapshot.employee.employeeNo.length, 500);
});
test('100 manual rows retain complete 2000-character references without trial amount defaults', () => {
  const sources = Array.from({ length: 100 }, (_, index) => source('synthetic-service-' + index));
  const editor = createServiceBillingEditor({ sources, orgId, caseId, month, caseName: '合成' });
  const values = { ...editor.initial, number: 'SYN-100', sourceReference: '共同依據', note: '  保存備註  ' };
  for (let index = 0; index < 100; index++) { values['lineAmount' + index] = '0.01'; values['lineReference' + index] = '字'.repeat(1996) + '\r\n  '; }
  const payload = editor.buildPayload(values); assert.equal(payload.lines.length, 100); assert.equal(serviceBillingManualTotal(payload.lines), 100);
  assert.equal(payload.lines[99].sourceReference, values.lineReference99); assert(Buffer.byteLength(JSON.stringify(payload), 'utf8') > 131072);
});
