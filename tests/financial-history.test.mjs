import test from 'node:test';
import assert from 'node:assert/strict';
import { financialHistoryLines, financialHistorySummary, financialHistoryParty } from '../public/data/financial-history.js';

test('financial history keeps exact integer cents, ordered lines and explicit saved party names', () => {
  assert.deepEqual(financialHistoryLines([{ label: '一分明細', quantity: 3, unitPriceCents: 10001 }]), [{ label: '一分明細', quantity: 3, unitPriceCents: 10001 }]);
  assert.deepEqual(financialHistoryLines([{ label: '減項', kind: 'deduction', amountCents: 1 }], true), [{ label: '減項', kind: 'deduction', amountCents: 1 }]);
  assert.deepEqual(financialHistorySummary({ earningCents: 10001, deductionCents: 1, netCents: 10000 }, true), [{ label: '加項合計', value: 10001 }, { label: '減項合計', value: 1 }, { label: '淨額', value: 10000 }]);
  assert.deepEqual(financialHistoryParty({ caseId: 'synthetic-case', caseSnapshot: { id: 'synthetic-case', name: '原保存姓名', caseNo: 'SYN-C' } }), [{ label: '保存姓名', value: '原保存姓名' }, { label: '保存個案案號', value: 'SYN-C' }]);
});

test('financial history never exposes unknown nested values, executes accessors or coerces malformed amounts', () => {
  let calls = 0; const row = { label: '保存文字', kind: 'earning', amountCents: '10001' };
  Object.defineProperty(row, 'unknownPrivate', { get() { calls++; throw new Error('must not read'); } });
  assert.equal(financialHistoryLines([row], true)[0].amountCents, '[欄位格式無法判讀]');
  Object.defineProperty(row, 'amountCents', { get() { calls++; throw new Error('must not read'); } });
  assert.equal(financialHistoryLines([row], true)[0].amountCents, '[欄位格式無法判讀]');
  const sparse = new Array(1); assert.equal(financialHistoryLines(sparse), '[欄位格式無法判讀]');
  assert.equal(financialHistorySummary({ amountCents: 1.01 })[0].value, '[欄位格式無法判讀]');
  assert.equal(financialHistoryParty({ employeeId: 'synthetic-person', employeeSnapshot: { id: 'other-person', name: 'not readable', employeeNo: 'private' } }, true), '[欄位格式無法判讀]');
  assert.equal(calls, 0);
});
