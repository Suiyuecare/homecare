import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayrollStatementEditor, parsePayrollAmount, payrollAmountText, payrollSummary, assertPayrollStatement, confirmPayrollStatementList, confirmPayrollTransition } from '../public/data/payroll-statement-editor.js';

const orgId = 'synthetic-payroll-org', employee = { id: 'synthetic-employee', name: '合成人工核定員工', employeeNo: 'SYNTH-E' };
const draft = overrides => ({ id: 'synthetic-payroll-record', orgId, version: 1, employeeId: employee.id, month: '2026-10', number: 'PAY-SYNTHETIC', lineItems: [{ label: '人工核定薪資', kind: 'earning', amountCents: 3000001 }, { label: '人工核定扣項', kind: 'deduction', amountCents: 10000 }], sourceReference: '合成人工核定表', status: 'draft', note: '合成備註', summary: { earningCents: 3000001, deductionCents: 10000, netCents: 2990001 }, employeeSnapshot: employee, ...overrides });
const editor = existing => createPayrollStatementEditor({ existing: existing || null, orgId, employees: [employee] });
const values = overrides => ({ ...editor().initial, employeeId: employee.id, month: '2026-10', number: 'PAY-NEW', rowCount: 2, label1: '薪資', kind1: 'earning', amount1: '30000.01', label2: '扣項', kind2: 'deduction', amount2: '100.00', ...overrides });
const saved = (payload, overrides = {}) => ({ ...payload, status: 'draft', id: 'new-synthetic-payroll', orgId, version: 1, employeeSnapshot: employee, summary: payrollSummary(payload.lineItems), ...overrides });

test('manual input uses the existing exact money parser and preserves one cent, maxima and totals without floats', () => {
  for (const [text, cents] of [['0', 0], ['0.01', 1], ['1.1', 110], ['00001.01', 101], ['10000000.00', 1e9]]) { assert.equal(parsePayrollAmount(text), cents); assert.equal(parsePayrollAmount(payrollAmountText(cents)), cents); }
  for (const text of ['1e2', '0.001', '-1', '+1', ' 1', '1 ', '1,000', '$1', '', '10000000.01', '1.00\n']) assert.throws(() => parsePayrollAmount(text));
  assert.throws(() => parsePayrollAmount(0.01));
  assert.deepEqual(payrollSummary([{ label: '同名', kind: 'earning', amountCents: 1 }, { label: '同名', kind: 'earning', amountCents: 1 }, { label: '扣項', kind: 'deduction', amountCents: 1 }]), { earningCents: 2, deductionCents: 1, netCents: 1 });
});

test('normal create controls produce structured lines and exact ACK without exposing raw JSON', () => {
  const form = editor(), payload = form.buildPayload(values());
  assert.deepEqual(payload.lineItems, [{ label: '薪資', kind: 'earning', amountCents: 3000001 }, { label: '扣項', kind: 'deduction', amountCents: 10000 }]);
  assert.ok(form.fields.some(field => field.name === 'label1')); assert.ok(form.fields.some(field => field.name === 'kind100')); assert.ok(form.fields.some(field => field.name === 'amount100'));
  assert.ok(!form.fields.some(field => field.name === 'lineItems')); assert.equal(form.confirm(saved(payload), payload).summary.netCents, 2990001);
});

test('draft no-op and individual edits omit untouched fields including original whitespace and long text', () => {
  const original = draft({ sourceReference: ' 保留原依據 ', note: '字'.repeat(10000), lineItems: [{ label: ' 保留原名稱 ', kind: 'earning', amountCents: 3000001 }, { label: '人工核定扣項', kind: 'deduction', amountCents: 10000 }] });
  const form = editor(original); assert.deepEqual(form.buildPayload(form.initial), {});
  const note = form.buildPayload({ ...form.initial, note: ' 明確新備註 ' }); assert.deepEqual(note, { note: ' 明確新備註 ' });
  const lines = form.buildPayload({ ...form.initial, amount1: '30000.02' }); assert.equal(lines.lineItems[0].label, original.lineItems[0].label); assert.equal(lines.lineItems[0].amountCents, 3000002);
  const response = { ...original, ...lines, version: 2, summary: payrollSummary(lines.lineItems) }; assert.equal(form.confirm(response, lines), response);
  assert.throws(() => form.buildPayload({ ...form.initial, employeeId: 'other' })); assert.throws(() => form.buildPayload({ ...form.initial, month: '2026-11' })); assert.throws(() => form.buildPayload({ ...form.initial, number: 'other' }));
});

test('shrinking filled lines requires explicit removal and expanding the same draft restores hidden inputs', () => {
  const form = editor(draft()); const smaller = { ...form.initial, rowCount: 1 };
  assert.throws(() => form.buildPayload(smaller), /明確勾選/);
  assert.equal(form.buildPayload({ ...smaller, confirmRemove: true }).lineItems.length, 1);
  assert.deepEqual(form.buildPayload({ ...smaller, rowCount: 2 }), {}, 'all entered rows are retained in the form baseline');
  const fresh = editor(), partial = values({ rowCount: 1, label3: '尚未完成的隱藏明細', amount3: '' }); assert.throws(() => fresh.buildPayload(partial), /明確勾選/);
});

test('saved newline labels and CR text require explicit preservation or replacement while retaining private original data', () => {
  const original = draft({ lineItems: [{ label: '原第一行\n原第二行', kind: 'earning', amountCents: 100 }], sourceReference: '原\r\n依據', note: '原\r\n備註', summary: { earningCents: 100, deductionCents: 0, netCents: 100 } });
  const form = editor(original); assert.equal(form.initial.lineItemsIntent, 'keep'); assert.equal(form.initial.sourceReferenceIntent, 'keep'); assert.equal(form.initial.noteIntent, 'keep');
  assert.equal(form.initial.label1, ''); assert.deepEqual(form.buildPayload(form.initial), {});
  const replacement = form.buildPayload({ ...form.initial, lineItemsIntent: 'replace', label1: '明確取代名稱', amount1: '1.01' }); assert.equal(replacement.lineItems[0].amountCents, 101);
  const updated = { ...original, ...replacement, version: 2, summary: payrollSummary(replacement.lineItems) }; assert.equal(form.confirm(updated, replacement).note, original.note);
});

test('ack guards reject wrong amounts, scope, identities, version and snapshot rather than announcing successful saves', () => {
  const original = draft(), form = editor(original), payload = { note: '明確保存' }, correct = { ...original, ...payload, version: 2 };
  for (const patch of [{ id: ' ' }, { orgId: 'other' }, { employeeId: 'other' }, { version: 1 }, { version: 3 }, { note: '未保存' }, { summary: { ...correct.summary, netCents: 1 } }, { employeeSnapshot: { ...employee, name: '被改名' } }]) assert.throws(() => form.confirm({ ...correct, ...patch }, payload));
  const missing = { ...correct }; delete missing.sourceReference; assert.throws(() => form.confirm(missing, payload));
  assert.equal(form.confirm(correct, payload), correct);
});

test('source review, close and explicit-void acknowledgements preserve every non-action field and employee/amount snapshots', () => {
  const original = draft({ status: 'reviewed' });
  const closed = { ...original, status: 'closed', version: 2 }; assert.equal(confirmPayrollTransition(closed, original, { status: 'closed' }, orgId), closed);
  const voided = { ...original, status: 'voided', note: '本次明確取消原因', version: 2 }; assert.equal(confirmPayrollTransition(voided, original, { status: 'voided', note: voided.note }, orgId), voided);
  for (const patch of [{ sourceReference: '更換依據' }, { number: '另一編號' }, { month: '2026-11' }, { note: '改寫關帳備註' }, { summary: { ...closed.summary, netCents: 2 } }]) assert.throws(() => confirmPayrollTransition({ ...closed, ...patch }, original, { status: 'closed' }, orgId));
  assert.throws(() => editor(closed), /只有草稿/);
});

test('bounded list confirmation validates filtered month/employee/status and totals and rejects duplicate or missing rows', () => {
  const row = draft(), request = { orgId, page: 1, month: '2026-10', employeeId: employee.id, status: 'draft' }, response = { items: [row], total: 1, page: 1, pageSize: 25 };
  assert.equal(confirmPayrollStatementList(response, request), response);
  for (const patch of [{ page: 2 }, { pageSize: 100 }, { total: '1' }, { total: -1 }, { items: [] }, { items: [row, row], total: 2 }, { items: [{ ...row, month: '2026-11' }] }, { items: [{ ...row, status: 'closed' }] }]) assert.throws(() => confirmPayrollStatementList({ ...response, ...patch }, request));
});

test('normal controls reject unknown inputs, partial lines, excessive sizes, invalid month and negative net', () => {
  const form = editor();
  for (const patch of [{ unknown: true }, { rowCount: 0 }, { rowCount: 101 }, { rowCount: 1.5 }, { month: '0000-01' }, { number: ' ' }, { label1: '' }, { label1: '字'.repeat(101) }, { kind1: 'tax' }, { amount1: '1e3' }, { amount2: '50000.00' }, { note: '字'.repeat(10001) }]) assert.throws(() => form.buildPayload(values(patch)));
  for (const lineItems of [[], [{ label: 'bad', kind: 'earning', amountCents: -1 }], [{ label: 'bad', kind: 'earning', amountCents: 1.1 }], [{ label: 'bad', kind: 'earning', amountCents: 1, extra: true }]]) assert.throws(() => assertPayrollStatement(draft({ lineItems }), { orgId }));
});

test('explicit note replacement and acknowledgements retain padding, LF and CRLF text exactly', () => {
  const original = draft({ note: '原\r\n備註' }), form = editor(original), note = ' 明確多行\r\n第二行\n末行 ';
  const payload = form.buildPayload({ ...form.initial, noteIntent: 'replace', note }); assert.deepEqual(payload, { note });
  assert.equal(form.confirm({ ...original, ...payload, version: 2 }, payload).note, note);
  assert.throws(() => form.confirm({ ...original, note: note.trim(), version: 2 }, payload));
  const create = editor(), fresh = create.buildPayload(values({ note })); assert.equal(fresh.note, note); assert.equal(create.confirm(saved(fresh), fresh).note, note);
});
