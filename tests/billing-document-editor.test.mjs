import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBillingMoney, formatBillingCents, billingLineTotal, createBillingDocumentEditor,
  createPaymentReceiptPayload, checkBillingRecord } from '../public/data/billing-document-editor.js';

const saved = () => ({ id: 'synthetic-bill', orgId: 'synthetic-org', version: 4, caseId: 'synthetic-case', month: '2026-10', number: 'MANUAL-01',
  lineItems: [{ label: ' 合成明細 ', quantity: 3, unitPriceCents: 1299 }], sourceReference: ' 前行\r\n後行 ', note: ' 備註\r\n下一行 ', status: 'draft',
  summary: { amountCents: 3897 }, caseSnapshot: { id: 'synthetic-case', name: '合成個案', caseNo: 'CASE-01' } });
const editor = (existing = saved(), count = existing.lineItems.length) => createBillingDocumentEditor({ existing, lineCount: count });
const values = helper => ({ ...helper.initialDisplay });

test('yuan parser preserves exact cents and accepts valid boundary values without floats', () => {
  for (const [input, expected] of [['0', 0], ['0.01', 1], ['1.2', 120], ['12.99', 1299], [' 12.99 ', 1299], ['10000000.00', 1000000000]]) {
    assert.equal(parseBillingMoney(input), expected); assert.equal(parseBillingMoney(formatBillingCents(expected)), expected);
  }
  assert.equal(formatBillingCents(Number.MAX_SAFE_INTEGER), '90071992547409.91');
});
test('money parser rejects imprecise, negative, exponent, unsafe and out of range inputs', () => {
  for (const input of ['-1', '+1', '1e3', '1,000', '1.001', '1.', '.5', '01.00', '', ' ', 'NaN', 'Infinity', '10000000.01', '9007199254740993']) assert.throws(() => parseBillingMoney(input));
  for (const input of [null, 1, {}, []]) assert.throws(() => parseBillingMoney(input));
  assert.throws(() => parseBillingMoney('0', { minCents: 1 })); assert.throws(() => formatBillingCents(0.1));
});
test('line totals are exact and reject unapproved line keys and bounds', () => {
  assert.equal(billingLineTotal([{ label: 'A', quantity: 10000, unitPriceCents: 1000000000 }]), 10000000000000);
  assert.equal(billingLineTotal([{ label: 'A', quantity: 3, unitPriceCents: 1299 }, { label: 'B', quantity: 2, unitPriceCents: 1 }]), 3899);
  for (const lines of [[], Array.from({ length: 101 }, () => ({ label: 'A', quantity: 1, unitPriceCents: 0 })),
    [{ label: 'A', quantity: 1.2, unitPriceCents: 1 }], [{ label: 'A', quantity: 1, unitPriceCents: 1, amountCents: 1 }],
    [{ label: 'A\nB', quantity: 1, unitPriceCents: 1 }], [{ label: 'A', quantity: 10001, unitPriceCents: 1 }]]) assert.throws(() => billingLineTotal(lines));
});
test('opening and saving unchanged draft does not rewrite CRLF or text padding', () => {
  const item = saved(), helper = editor(item), snapshot = structuredClone(item);
  assert.equal(helper.initialDisplay.sourceReference, ' 前行\n後行 '); assert.equal(helper.initialDisplay.note, ' 備註\n下一行 ');
  assert.deepEqual(helper.buildPayload(values(helper)), {}); assert.deepEqual(item, snapshot);
});
test('changing only source reference preserves omitted note and all line labels', () => {
  const helper = editor(); assert.deepEqual(helper.buildPayload({ ...values(helper), sourceReference: ' 新核定依據 ' }), { sourceReference: '新核定依據' });
});
test('changing note intentionally preserves user padding, while unmodified source remains omitted', () => {
  const helper = editor(); assert.deepEqual(helper.buildPayload({ ...values(helper), note: ' 新內容\n第二行 ' }), { note: ' 新內容\n第二行 ' });
});
test('changing only quantity preserves the original label bytes and exact unchanged cents', () => {
  const helper = editor(); assert.deepEqual(helper.buildPayload({ ...values(helper), lineQuantity0: '4' }), { lineItems: [{ label: ' 合成明細 ', quantity: 4, unitPriceCents: 1299 }] });
});
test('ordinary line fields validate input and allow intentional label and amount changes', () => {
  const helper = editor();
  for (const [key, value] of [['lineQuantity0', '0'], ['lineQuantity0', '1e2'], ['lineQuantity0', '1.5'], ['linePrice0', '12.990'], ['lineLabel0', ' ']])
    assert.throws(() => helper.buildPayload({ ...values(helper), [key]: value }), error => !!error.fields[key]);
  assert.deepEqual(helper.buildPayload({ ...values(helper), lineLabel0: ' 新明細 ', linePrice0: '13.01' }), { lineItems: [{ label: '新明細', quantity: 3, unitPriceCents: 1301 }] });
});
test('changing line count preserves earlier complete lines and does not mutate saved arrays', () => {
  const item = saved(), helper = editor(item, 2), input = { ...values(helper), lineLabel1: '新增明細', lineQuantity1: '2', linePrice1: '0.01' };
  assert.deepEqual(helper.buildPayload(input).lineItems, [...item.lineItems, { label: '新增明細', quantity: 2, unitPriceCents: 1 }]);
  assert.equal(item.lineItems.length, 1);
  const two = { ...item, lineItems: [...item.lineItems, { label: 'B', quantity: 1, unitPriceCents: 1 }], summary: { amountCents: 3898 } };
  assert.deepEqual(editor(two, 1).buildPayload(values(editor(two, 1))).lineItems, item.lineItems);
});
test('draft builder protects immutable identities and rejects client derived fields', () => {
  const helper = editor();
  for (const key of ['caseId', 'month', 'number']) assert.throws(() => helper.buildPayload({ ...values(helper), [key]: 'changed' }));
  for (const key of ['summary', 'caseSnapshot', 'status', 'version']) assert.throws(() => helper.buildPayload({ ...values(helper), [key]: {} }));
  assert.throws(() => editor({ ...saved(), status: 'issued' })); assert.throws(() => createBillingDocumentEditor({ lineCount: 0 }));
});
test('new draft uses verified case choices and serializes safe line data', () => {
  const helper = createBillingDocumentEditor({ cases: [{ id: 'c', name: '合成', caseNo: 'C1' }], month: '2026-10' });
  const input = { ...values(helper), caseId: 'c', number: ' BILL-1 ', lineLabel0: 'A', linePrice0: '1.01' };
  assert.deepEqual(helper.buildPayload(input), { caseId: 'c', month: '2026-10', number: 'BILL-1', sourceReference: '', note: '',
    lineItems: [{ label: 'A', quantity: 1, unitPriceCents: 101 }], status: 'draft' });
  assert.throws(() => helper.buildPayload({ ...input, caseId: 'unverified' }));
});
test('receipt builder rejects invalid money dates methods and unknown fields', () => {
  const data = { date: '2026-10-10', amount: '0.01', method: 'cash', reference: ' 人工參照 ', note: ' 備註\n ' };
  assert.deepEqual(createPaymentReceiptPayload(data, 'bill'), { billingDocumentId: 'bill', date: data.date, amountCents: 1, method: 'cash', reference: '人工參照', note: data.note, status: 'active' });
  for (const patch of [{ amount: '0' }, { amount: '0.001' }, { date: '2026-02-29' }, { date: '0000-01-01' }, { method: 'card' }, { amountCents: 1 }]) assert.throws(() => createPaymentReceiptPayload({ ...data, ...patch }, 'bill'));
});
test('save acknowledgement checks complete business payload, scope, version and preserved values', () => {
  const old = saved(), payload = { sourceReference: '新依據' }, result = { item: { ...old, ...payload, version: 5 } };
  assert.equal(checkBillingRecord(result, { entity: 'billing-documents', id: old.id, orgId: old.orgId, original: old, payload }), result.item);
  for (const patch of [{ orgId: 'foreign' }, { id: 'wrong' }, { version: 4 }, { note: '被改寫' }, { summary: { amountCents: 3896 } }, { caseSnapshot: { ...old.caseSnapshot, id: 'foreign' } }])
    assert.throws(() => checkBillingRecord({ item: { ...result.item, ...patch } }, { entity: 'billing-documents', id: old.id, orgId: old.orgId, original: old, payload }));
});
test('issued bill acknowledgement rejects silently replaced immutable case snapshots', () => {
  const old = { ...saved(), status: 'issued' }, payload = { status: 'voided', note: '取消原因' };
  assert.throws(() => checkBillingRecord({ item: { ...old, ...payload, version: 5, caseSnapshot: { ...old.caseSnapshot, name: '改寫' } } }, { entity: 'billing-documents', orgId: old.orgId, original: old, payload }));
});
