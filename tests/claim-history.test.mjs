import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHistorySnapshot, diffHistorySnapshots } from '../public/data/history-fields.js';

const source = { billingDocumentId: 'synthetic-bill', version: 2, number: 'SYN-BILL', caseId: 'synthetic-case', caseName: '合成保存姓名', amountCents: 10001 };
const response = { billingDocumentId: source.billingDocumentId, reference: '  合成回應\r\n依據  ', status: 'rejected', amountCents: 0, reason: '  合成退件\r\n末行  ' };
const summary = { amountCents: 10001, acceptedAmountCents: 0, rejectedAmountCents: 10001, pendingAmountCents: 0, unansweredAmountCents: 0, sourceCount: 1, responseCount: 1 };

test('claim history projects frozen source, exact money, counts and unchanged multiline reply without raw nested JSON', () => {
  const snapshot = { month: '2026-10', number: 'SYN-CLAIM', billingDocumentIds: [source.billingDocumentId], sourceSnapshots: [source], responses: [response], summary, status: 'closed' };
  const projection = normalizeHistorySnapshot('claim-batches', snapshot);
  assert.deepEqual(projection.sourceSnapshots, [source]); assert.deepEqual(projection.responses, [response]);
  assert.deepEqual(projection.billingDocumentIds, [{ id: source.billingDocumentId }]);
  assert.equal(projection.summary.find(row => row.label === '保存來源總額').value, 10001);
  assert.equal(projection.summary.find(row => row.label === '來源筆數').isMoney, false);
  const changes = diffHistorySnapshots('claim-batches', { ...snapshot, status: 'reconciling' }, snapshot);
  assert.equal(changes.length, 1); assert.equal(changes[0].key, 'status');
});

test('claim history does not disclose nested imported unknown fields or call top-level getters', () => {
  let calls = 0;
  const snapshot = { billingDocumentIds: [source.billingDocumentId], sourceSnapshots: [{ ...source, unapproved: { secret: 'SYNTHETIC-HIDDEN' } }], responses: [response], summary };
  Object.defineProperty(snapshot, 'sourceReference', { enumerable: true, get() { calls++; return 'SYNTHETIC-HIDDEN'; } });
  const projection = normalizeHistorySnapshot('claim-batches', snapshot);
  assert.equal(calls, 0); assert.equal(projection.sourceSnapshots, '[欄位格式無法判讀]'); assert(!JSON.stringify(projection).includes('SYNTHETIC-HIDDEN'));
});

test('claim history rejects indexed accessor sources and replies before reading them', () => {
  let calls = 0;
  const accessor = []; accessor.length = 1; Object.defineProperty(accessor, '0', { enumerable: true, get() { calls++; return source; } });
  const projection = normalizeHistorySnapshot('claim-batches', { billingDocumentIds: accessor, sourceSnapshots: accessor, responses: accessor, summary });
  assert.equal(calls, 0); assert.equal(projection.billingDocumentIds, '[欄位格式無法判讀]'); assert.equal(projection.sourceSnapshots, '[欄位格式無法判讀]'); assert.equal(projection.responses, '[欄位格式無法判讀]');
});
