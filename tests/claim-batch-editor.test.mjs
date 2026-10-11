import test from 'node:test';
import assert from 'node:assert/strict';
import { claimSummary, claimSourcesForDisplay, claimResponsesForDisplay, claimSummaryForDisplay,
  checkClaimBatchRecord, createClaimBatchDraftEditor, createClaimResponseEditor } from '../public/data/claim-batch-editor.js';

const source = (values = {}) => ({ billingDocumentId: 'synthetic-bill-1', version: 2, number: 'SYNTHETIC-BILL-1', caseId: 'synthetic-case-1', caseName: '合成保存個案', amountCents: 24003, ...values });
const response = (values = {}) => ({ billingDocumentId: 'synthetic-bill-1', reference: '合成外部回應依據', status: 'accepted', amountCents: 24003, reason: '', ...values });
const record = (values = {}) => {
  const sourceSnapshots = values.sourceSnapshots || [source()], responses = values.responses || [];
  return { month: '2026-10', number: 'SYNTHETIC-BATCH-1', billingDocumentIds: sourceSnapshots.map(row => row.billingDocumentId), sourceReference: '  人工\r\n依據  ', responseSourceReference: '', responses,
    status: 'draft', note: '  長文\r\n末行  ', sourceSnapshots, summary: claimSummary(sourceSnapshots, responses), id: 'synthetic-batch-1', orgId: 'synthetic-org-1', version: 1,
    createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', ...values };
};
const bills = sources => sources.map(row => ({ id: row.billingDocumentId, status: 'issued', month: '2026-10', number: row.number, caseSnapshot: { name: row.caseName }, summary: { amountCents: row.amountCents } }));

test('summary exactly separates no response, pending, rejection and acceptance and does not round cents', () => {
  const sources = [source(), source({ billingDocumentId: 'b2', amountCents: 10001 }), source({ billingDocumentId: 'b3', amountCents: 11002 }), source({ billingDocumentId: 'b4', amountCents: 12003 })];
  const replies = [response(), response({ billingDocumentId: 'b2', status: 'pending', amountCents: 0 }), response({ billingDocumentId: 'b3', status: 'rejected', amountCents: 0, reason: '合成退件' })];
  assert.deepEqual(claimSummary(sources, replies), { amountCents: 57009, acceptedAmountCents: 24003, rejectedAmountCents: 11002, pendingAmountCents: 10001, unansweredAmountCents: 12003, sourceCount: 4, responseCount: 3 });
  assert.equal(claimSummary([source({ amountCents: Number.MAX_SAFE_INTEGER - 1 }), source({ billingDocumentId: 'b2', amountCents: 1 })], []).amountCents, Number.MAX_SAFE_INTEGER);
  assert.throws(() => claimSummary([source({ amountCents: Number.MAX_SAFE_INTEGER }), source({ billingDocumentId: 'b2', amountCents: 1 })], []), /超出/);
});

test('known projections reject unknown nested values, wrong status and amounts instead of expanding them', () => {
  assert.deepEqual(claimSourcesForDisplay([source()]), [source()]); assert.deepEqual(claimResponsesForDisplay([response()]), [response()]);
  assert.deepEqual(claimSummaryForDisplay(claimSummary([source()], [response()])), claimSummary([source()], [response()]));
  assert.equal(claimSourcesForDisplay([{ ...source(), privateHealth: { content: 'SYNTHETIC-UNKNOWN' } }]), null);
  assert.equal(claimResponsesForDisplay([{ ...response(), unknown: 'SYNTHETIC-UNKNOWN' }]), null);
  assert.equal(claimResponsesForDisplay([response({ status: 'sent' })]), null); assert.equal(claimResponsesForDisplay([response({ status: 'rejected', amountCents: 1, reason: '合成' })]), null);
  assert.equal(claimSummaryForDisplay({ ...claimSummary([source()], []), unknown: {} }), null);
  assert.equal(claimSummaryForDisplay({ ...claimSummary([source()], []), acceptedAmountCents: 1 }), null);
});

test('array slots with getters, holes, symbols or extra keys are rejected before any getter executes', () => {
  let calls = 0;
  const accessor = () => { const value = [null]; Object.defineProperty(value, '0', { enumerable: true, configurable: true, get() { calls++; return source(); } }); return value; };
  assert.equal(claimSourcesForDisplay(accessor()), null); assert.equal(claimResponsesForDisplay(accessor()), null);
  assert.throws(() => claimSummary(accessor(), [])); assert.throws(() => claimSummary([source()], accessor()));
  assert.throws(() => checkClaimBatchRecord({ item: { ...record(), sourceSnapshots: accessor() } }, { orgId: 'synthetic-org-1' }));
  assert.throws(() => checkClaimBatchRecord({ item: { ...record(), billingDocumentIds: accessor() } }, { orgId: 'synthetic-org-1' }));
  assert.throws(() => checkClaimBatchRecord({ item: { ...record(), responses: accessor() } }, { orgId: 'synthetic-org-1' }));
  const existing = record(), editor = createClaimBatchDraftEditor({ existing, bills: bills(existing.sourceSnapshots) });
  assert.throws(() => editor.buildPayload({ ...editor.initialDisplay, billingDocumentIds: accessor() }));
  assert.equal(calls, 0);
  const extra = [source()]; extra.extra = 'unknown'; const symbolic = [source()]; symbolic[Symbol('unknown')] = true;
  for (const array of [extra, symbolic, Array(1)]) { assert.equal(claimSourcesForDisplay(array), null); assert.equal(claimResponsesForDisplay(array), null); assert.throws(() => claimSummary(array, [])); }
});

test('object accessors and response-envelope getters are rejected without evaluation', () => {
  let calls = 0;
  const badSource = { ...source() }; Object.defineProperty(badSource, 'amountCents', { enumerable: true, get() { calls++; return 24003; } });
  const badResponse = { ...response() }; Object.defineProperty(badResponse, 'reference', { enumerable: true, get() { calls++; return '合成'; } });
  const badSummary = { ...claimSummary([source()], []) }; Object.defineProperty(badSummary, 'amountCents', { enumerable: true, get() { calls++; return 24003; } });
  assert.equal(claimSourcesForDisplay([badSource]), null); assert.equal(claimResponsesForDisplay([badResponse]), null); assert.equal(claimSummaryForDisplay(badSummary), null);
  assert.throws(() => checkClaimBatchRecord({ get item() { calls++; return record(); } }, { orgId: 'synthetic-org-1' })); assert.equal(calls, 0);
});

test('draft untouched native textarea LF values do not PATCH original CRLF or surrounding spaces', () => {
  const existing = record(), editor = createClaimBatchDraftEditor({ existing, bills: bills(existing.sourceSnapshots) });
  assert.deepEqual(editor.initialDisplay.sourceReference, '  人工\n依據  '); assert.deepEqual(editor.initialDisplay.note, '  長文\n末行  ');
  assert.deepEqual(editor.buildPayload({ ...editor.initialDisplay }), {});
  assert.deepEqual(editor.buildPayload({ ...editor.initialDisplay, sourceReference: '  人工改寫\n依據  ' }), { sourceReference: '  人工改寫\n依據  ' });
  assert.deepEqual(editor.buildPayload({ ...editor.initialDisplay, note: ' 故意改內容\n新末行 ' }), { note: ' 故意改內容\n新末行 ' });
  assert.deepEqual(editor.buildPayload({ ...editor.initialDisplay, note: '' }), { note: '' });
});

test('same selected set in a different checkbox option order does not change source order', () => {
  const existing = record({ sourceSnapshots: [source(), source({ billingDocumentId: 'b2', number: 'B2' })] });
  const editor = createClaimBatchDraftEditor({ existing, bills: bills([...existing.sourceSnapshots].reverse()) });
  assert.deepEqual(editor.buildPayload({ ...editor.initialDisplay, billingDocumentIds: ['b2', 'synthetic-bill-1'] }), {});
  assert.deepEqual(editor.buildPayload({ ...editor.initialDisplay, billingDocumentIds: ['b2'] }), { billingDocumentIds: ['b2'] });
});

test('new draft uses ordinary checkbox values, validates month/identity and rejects duplicate, foreign or oversized choices', () => {
  const editor = createClaimBatchDraftEditor({ bills: bills([source()]), month: '2026-10' });
  assert.equal(editor.fields.find(field => field.name === 'billingDocumentIds').type, 'checkbox-group');
  assert.deepEqual(editor.buildPayload({ ...editor.initialDisplay, number: '  NEW-1  ', billingDocumentIds: ['synthetic-bill-1'], sourceReference: ' 合成\n依據 ', note: '' }),
    { month: '2026-10', number: 'NEW-1', billingDocumentIds: ['synthetic-bill-1'], status: 'draft', sourceReference: ' 合成\n依據 ', note: '' });
  for (const selection of [[], ['foreign'], ['synthetic-bill-1', 'synthetic-bill-1'], Array(101).fill('synthetic-bill-1')]) assert.throws(() => editor.buildPayload({ ...editor.initialDisplay, number: 'NEW-1', billingDocumentIds: selection }));
  assert.throws(() => editor.buildPayload({ ...editor.initialDisplay, number: 'NEW-1', billingDocumentIds: ['synthetic-bill-1'], unknown: {} }));
  assert.throws(() => createClaimBatchDraftEditor({ bills: [], month: '2026-10\n' }).buildPayload({ month: '2026-10\n', number: 'N', billingDocumentIds: [], sourceReference: '', note: '' }));
});

test('response editor records exact cents, preserves unmodified other responses and original long-text bytes', () => {
  const sources = [source(), source({ billingDocumentId: 'b2', number: 'B2', amountCents: 10001 })];
  const oldResponse = response({ reference: '  本筆\r\n依據  ', reason: '  本筆\r\n原因  ' });
  const existing = record({ sourceSnapshots: sources, responses: [oldResponse], status: 'reconciling', responseSourceReference: '  共同\r\n依據  ', summary: claimSummary(sources, [oldResponse]) });
  const editor = createClaimResponseEditor(existing, 'synthetic-bill-1');
  assert.deepEqual(editor.buildPayload({ ...editor.initialDisplay }), {});
  const payload = editor.buildPayload({ ...editor.initialDisplay, reason: '新原因\n新末行' });
  assert.equal(payload.responses[0].reference, oldResponse.reference); assert.equal(payload.responses[0].reason, '新原因\n新末行'); assert.ok(!Object.hasOwn(payload, 'responseSourceReference'));
  const secondEditor = createClaimResponseEditor(existing, 'b2');
  const secondPayload = secondEditor.buildPayload({ ...secondEditor.initialDisplay, reference: '第二筆人工依據' });
  assert.deepEqual(secondPayload.responses[0], oldResponse); assert.equal(secondPayload.responses[1].amountCents, 10001); assert.ok(!Object.hasOwn(secondPayload, 'responseSourceReference'));
});

test('response editor requires received evidence, exact accepted amount, zero for pending/rejection and explicit rejection reason', () => {
  const existing = record({ status: 'verified' }), editor = createClaimResponseEditor(existing, 'synthetic-bill-1');
  const values = { ...editor.initialDisplay, reference: '合成回應', responseSourceReference: '合成共同依據' };
  assert.equal(editor.buildPayload(values).responses[0].amountCents, 24003); assert.equal(editor.buildPayload(values).status, 'reconciling');
  for (const amount of ['240.02', '240.030', '2.4e2', '-240.03', '240,03', 'NaN']) assert.throws(() => editor.buildPayload({ ...values, amount }));
  assert.throws(() => editor.buildPayload({ ...values, status: 'rejected', amount: '0', reason: '' }));
  assert.equal(editor.buildPayload({ ...values, status: 'rejected', amount: '0', reason: '合成退件原因' }).responses[0].amountCents, 0);
  assert.equal(editor.buildPayload({ ...values, status: 'pending', amount: '0' }).responses[0].status, 'pending');
  assert.throws(() => editor.buildPayload({ ...values, responseSourceReference: ' ' })); assert.throws(() => editor.buildPayload({ ...values, reference: '' }));
  assert.throws(() => createClaimResponseEditor(record({ status: 'cancelled', note: '合成取消原因' }), 'synthetic-bill-1'));
});

test('ACK validates org/id/version, all fields and derived source snapshot instead of accepting success status alone', () => {
  const original = record(), payload = { note: '合成新備註' }, saved = record({ note: payload.note, version: 2 });
  assert.equal(checkClaimBatchRecord({ item: saved }, { orgId: original.orgId, id: original.id, original, payload }), saved);
  for (const change of [{ orgId: 'foreign' }, { id: 'different' }, { version: 1 }, { note: 'not saved' }, { sourceReference: 'changed' }, { summary: { ...saved.summary, amountCents: 1 } },
    { sourceSnapshots: [source({ caseName: 'UNEXPECTED-CASE-NAME' })] }, { sourceSnapshots: [{ ...source(), unknown: {} }] }, { unknownTop: {} }])
    assert.throws(() => checkClaimBatchRecord({ item: { ...saved, ...change } }, { orgId: original.orgId, id: original.id, original, payload }));
});

test('closed ACK cannot contain pending or missing results, and all accepted/rejected sources stay visible', () => {
  const goodReplies = [response()], closed = record({ status: 'closed', responses: goodReplies, responseSourceReference: '合成回應依據', summary: claimSummary([source()], goodReplies) });
  assert.equal(checkClaimBatchRecord({ item: closed }, { orgId: closed.orgId }), closed);
  assert.throws(() => checkClaimBatchRecord({ item: record({ status: 'closed', responseSourceReference: '合成依據' }) }, { orgId: closed.orgId }));
  const pending = [response({ status: 'pending', amountCents: 0 })];
  assert.throws(() => checkClaimBatchRecord({ item: record({ status: 'closed', responses: pending, responseSourceReference: '合成依據', summary: claimSummary([source()], pending) }) }, { orgId: closed.orgId }));
});
