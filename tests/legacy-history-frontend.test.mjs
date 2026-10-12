import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { confirmLegacyHistoryList, confirmLegacyHistoryBatch, confirmLegacyHistoryRow, legacyHistoryIdentity, legacyHistoryScalarText } from '../public/data/legacy-history.js';

const orgId = randomUUID(), otherOrg = randomUUID(), batchId = randomUUID(), rowId = randomUUID(), userId = randomUUID(), caseId = randomUUID(), employeeId = randomUUID();
const date = '2026-10-13T00:00:00.000Z';
const flags = () => ({ sourceSystemComplete: false, operationalConversionCompleted: false, approvalCompleted: false, payrollApproved: false });
const base = id => ({ id, orgId, version: 1, createdAt: date, updatedAt: date });
const batch = (extra = {}) => ({ ...base(batchId), provider: 'synthetic', tenant: 'synthetic-tenant', sourceHash: 'a'.repeat(64), payloadHash: 'b'.repeat(64),
  archiveManifestSha256: 'c'.repeat(64), archiveId: 'archive-' + randomUUID(), importedBy: userId, importedAt: date, rowCount: 1,
  categories: ['service-export'], reportingPeriods: ['2025-10'], status: 'historical-original-records', ...flags(), ...extra });
const summary = (extra = {}) => ({ ...base(rowId), batchId, category: 'service-export', reportingPeriod: '2025-10', sourceNativeId: null, sourceCreatedAt: '  原始非 ISO 時間\r\n ',
  caseId, employeeId, sourceFileId: 'file-00000001', sourceFileSha256: 'd'.repeat(64), locator: { kind: 'json-pointer', pointer: '/rows/0' }, identityKind: 'archive-locator',
  caseReference: { id: caseId, name: '合成關聯個案', caseNo: 'SYN-CASE-001', version: 2, status: 'closed' },
  employeeReference: { id: employeeId, name: '合成關聯員工', employeeNo: 'SYN-EMP-001', version: 3, status: 'inactive' }, ...extra });
const columns = () => [
  { columnIndex: 2, label: '相同欄名', raw: '  =1+1\r\n\0原文尾端  ', formula: '=1+1', cached: 2 },
  { columnIndex: 1, label: '相同欄名', raw: false, formula: null, cached: null },
];
const row = (extra = {}) => ({ orgId, item: { ...summary(), columns: columns() }, batch: batch(), ...flags(), ...extra });
const list = (extra = {}) => ({ orgId, items: [batch()], total: 1, page: 1, pageSize: 25, ...flags(), ...extra });
const detail = (extra = {}) => ({ orgId, item: batch(), records: [summary()], total: 1, page: 1, pageSize: 25, ...flags(), ...extra });
const listRequest = { orgId, page: 1, pageSize: 25 }, batchRequest = { ...listRequest, id: batchId }, rowRequest = { orgId, id: rowId };
const denied = fn => assert.throws(fn, error => error.code === 'LEGACY_HISTORY_UNCONFIRMED' && !error.message.includes('SENTINEL'));

test('historical DTOs retain four explicit unconverted facts and return immutable projections', () => {
  const saved = confirmLegacyHistoryList(list(), listRequest);
  for (const key of Object.keys(flags())) { assert.equal(saved[key], false); assert.equal(saved.items[0][key], false); }
  assert.equal(saved.items[0].status, 'historical-original-records'); assert.equal(saved.items[0].rowCount, 1);
  assert.ok(Object.isFrozen(saved)); assert.ok(Object.isFrozen(saved.items[0])); assert.ok(Object.isFrozen(saved.items[0].categories));
  assert.ok(Object.isFrozen(confirmLegacyHistoryBatch(detail(), batchRequest).records[0].caseReference));
});

test('all four completion flags reject true, absent, null and unknown completion claims in every envelope', () => {
  for (const [factory, confirm, requested] of [[list, confirmLegacyHistoryList, listRequest], [detail, confirmLegacyHistoryBatch, batchRequest], [row, confirmLegacyHistoryRow, rowRequest]]) {
    for (const key of Object.keys(flags())) for (const kind of ['true', 'missing', 'null']) {
      const value = factory(); if (kind === 'missing') delete value[key]; else value[key] = kind === 'true' ? true : null;
      denied(() => confirm(value, requested));
    }
    const value = factory(); value.sensitive = 'SENTINEL'; denied(() => confirm(value, requested));
  }
  for (const key of Object.keys(flags())) { const value = row(); value.batch[key] = true; denied(() => confirmLegacyHistoryRow(value, rowRequest)); }
});

test('every list batch and summary is closed, scoped, versioned and structurally safe before render', () => {
  for (const mutate of [v => v.items[0].orgId = otherOrg, v => v.items[0].version = 0, v => v.items[0].updatedAt = '2026-02-30T00:00:00.000Z',
    v => v.items[0].status = 'approved', v => v.items[0].secret = 'SENTINEL', v => v.items[0].rowCount = 1001,
    v => v.items[0].sourceHash = 'SENTINEL', v => v.items[0].archiveId = '/private/SENTINEL']) {
    const value = list(); mutate(value); denied(() => confirmLegacyHistoryList(value, listRequest));
  }
  for (const mutate of [v => v.records[0].orgId = otherOrg, v => v.records[0].batchId = randomUUID(), v => v.records[0].identityKind = 'original-event-uuid',
    v => v.records[0].sourceFileId = 'file-00000000', v => v.records[0].sourceFileSha256 = 'SENTINEL', v => v.records[0].extra = 'SENTINEL']) {
    const value = detail(); mutate(value); denied(() => confirmLegacyHistoryBatch(value, batchRequest));
  }
});

test('categories are known unique sorted source labels, never an inferred operational state', () => {
  const value = list(); value.items[0].categories = ['attachment-metadata', 'care-plan-history', 'service-export'];
  assert.deepEqual(confirmLegacyHistoryList(value, listRequest).items[0].categories, value.items[0].categories);
  for (const categories of [[], ['service-export', 'service-export'], ['service-export', 'case-profile'], ['SENTINEL'], [{ secret: 'SENTINEL' }]]) {
    denied(() => confirmLegacyHistoryList(list({ items: [batch({ categories })] }), listRequest));
  }
  const mismatch = detail(); mismatch.records[0].category = 'form-record'; denied(() => confirmLegacyHistoryBatch(mismatch, batchRequest));
});

test('batch source months are valid unique sorted original periods with explicit missing-month support', () => {
  const months = ['2025-10', '2025-11', '2026-01'];
  const saved = confirmLegacyHistoryList(list({ items: [batch({ reportingPeriods: months })] }), listRequest);
  assert.deepEqual(saved.items[0].reportingPeriods, months); assert.ok(Object.isFrozen(saved.items[0].reportingPeriods));
  assert.deepEqual(confirmLegacyHistoryList(list({ items: [batch({ reportingPeriods: [] })] }), listRequest).items[0].reportingPeriods, []);
  const absent = row(); absent.item.reportingPeriod = null; absent.batch.reportingPeriods = [];
  assert.equal(confirmLegacyHistoryRow(absent, rowRequest).item.reportingPeriod, null);
  for (const reportingPeriods of [['2025-10', '2025-10'], ['2026-01', '2025-10'], ['0000-01'], ['2026-13'], ['2026-1'], [null], [{ secret: 'SENTINEL' }]]) denied(() => confirmLegacyHistoryList(list({ items: [batch({ reportingPeriods })] }), listRequest));
  const missing = list(); delete missing.items[0].reportingPeriods; denied(() => confirmLegacyHistoryList(missing, listRequest));
  const wrongMonth = row(); wrongMonth.item.reportingPeriod = '2026-01'; denied(() => confirmLegacyHistoryRow(wrongMonth, rowRequest));
});

test('pagination confirms requested range, actual row counts and safe ends without truncation', () => {
  const items = Array.from({ length: 25 }, () => batch({ id: randomUUID() }));
  assert.equal(confirmLegacyHistoryList(list({ items, total: 26 }), listRequest).items.length, 25);
  assert.equal(confirmLegacyHistoryList(list({ page: 2, total: 26 }), { ...listRequest, page: 2 }).items.length, 1);
  assert.deepEqual(confirmLegacyHistoryList(list({ items: [], total: 0 }), listRequest).items, []);
  for (const extra of [{ orgId: otherOrg }, { page: 2 }, { pageSize: 100 }, { total: 26 }, { total: -1 }, { total: 1.5 }]) denied(() => confirmLegacyHistoryList(list(extra), listRequest));
  for (const requested of [{ ...listRequest, page: 0 }, { ...listRequest, pageSize: 101 }, { ...listRequest, page: Number.MAX_SAFE_INTEGER }, { ...listRequest, path: '/private/SENTINEL' }]) denied(() => confirmLegacyHistoryList(list(), requested));
  const duplicate = list({ items: [batch(), batch()], total: 2 }); denied(() => confirmLegacyHistoryList(duplicate, listRequest));
  const mismatched = detail({ item: batch({ rowCount: 2 }) }); denied(() => confirmLegacyHistoryBatch(mismatched, batchRequest));
  const records = Array.from({ length: 25 }, () => summary({ id: randomUUID() }));
  assert.equal(confirmLegacyHistoryBatch(detail({ records, item: batch({ rowCount: 1000 }), total: 1000 }), batchRequest).records.length, 25);
});

test('native IDs may be absent and source dates stay literal; platform IDs remain archive locators', () => {
  const saved = confirmLegacyHistoryRow(row(), rowRequest);
  assert.equal(saved.item.sourceNativeId, null); assert.equal(saved.item.sourceCreatedAt, '  原始非 ISO 時間\r\n '); assert.equal(saved.item.identityKind, 'archive-locator');
  const value = row(); value.item.sourceNativeId = '原平台原文識別碼'; value.item.reportingPeriod = null; value.item.sourceCreatedAt = null;
  assert.equal(confirmLegacyHistoryRow(value, rowRequest).item.sourceNativeId, '原平台原文識別碼');
  for (const period of ['0000-01', '2026-00', '2026-13', '2026-1', '2026-01-01', 202601]) { const bad = row(); bad.item.reportingPeriod = period; denied(() => confirmLegacyHistoryRow(bad, rowRequest)); }
});

test('archive positions are closed original facts and never interpreted as paths or executable navigation', () => {
  const value = row(); value.item.locator = { kind: 'worksheet-row', sheetIndex: 1, rowNumber: 42 };
  assert.deepEqual(confirmLegacyHistoryRow(value, rowRequest).item.locator, value.item.locator);
  for (const locator of [{ kind: 'worksheet-row', sheetIndex: 0, rowNumber: 1 }, { kind: 'worksheet-row', sheetIndex: 1, rowNumber: -1 },
    { kind: 'worksheet-row', sheetIndex: 100001, rowNumber: 1 }, { kind: 'worksheet-row', sheetIndex: 1, rowNumber: 1048577 },
    { kind: 'json-pointer', pointer: 'rows/0' }, { kind: 'json-pointer', pointer: '/rows/~2' }, { kind: 'json-pointer', pointer: '/rows/0', inputPath: 'SENTINEL' },
    { kind: 'SENTINEL', pointer: '/rows/0' }]) { const bad = row(); bad.item.locator = locator; denied(() => confirmLegacyHistoryRow(bad, rowRequest)); }
  const literal = row(); literal.item.locator = { kind: 'json-pointer', pointer: '/原始~1欄/~0<script>' };
  assert.equal(confirmLegacyHistoryRow(literal, rowRequest).item.locator.pointer, literal.item.locator.pointer);
});

test('currently verified case and employee references are limited and allow closed/inactive history', () => {
  const saved = confirmLegacyHistoryRow(row(), rowRequest); assert.equal(saved.item.caseReference.status, 'closed'); assert.equal(saved.item.employeeReference.status, 'inactive');
  const noLinks = row(); Object.assign(noLinks.item, { caseId: null, caseReference: null, employeeId: null, employeeReference: null });
  assert.equal(confirmLegacyHistoryRow(noLinks, rowRequest).item.caseReference, null);
  for (const mutate of [v => v.item.caseReference.id = randomUUID(), v => v.item.caseReference.version = 0, v => v.item.caseReference.bank = 'SENTINEL',
    v => v.item.employeeReference.role = 'admin', v => v.item.employeeReference.status = 'SENTINEL', v => v.item.caseId = null,
    v => v.item.employeeReference = null]) { const bad = row(); mutate(bad); denied(() => confirmLegacyHistoryRow(bad, rowRequest)); }
});

test('complete raw columns preserve type, duplicates, order, formulas and NUL/CRLF text without evaluation', () => {
  const saved = confirmLegacyHistoryRow(row(), rowRequest);
  assert.deepEqual(saved.item.columns, columns()); assert.equal(saved.item.columns[0].raw, '  =1+1\r\n\0原文尾端  ');
  assert.equal(saved.item.columns[0].formula, '=1+1'); assert.equal(saved.item.columns[1].raw, false);
  const value = row(); value.item.columns = Array.from({ length: 500 }, (_, index) => ({ columnIndex: index + 1, label: '', raw: index === 499 ? '最後原欄位' : 0, formula: null, cached: null }));
  const all = confirmLegacyHistoryRow(value, rowRequest); assert.equal(all.item.columns.length, 500); assert.equal(all.item.columns[499].raw, '最後原欄位');
  value.item.columns.push({ columnIndex: 501, label: '', raw: 1, formula: null, cached: null }); denied(() => confirmLegacyHistoryRow(value, rowRequest));
});

test('invalid raw shapes, duplicate indices and missing or extra column keys fail without reflecting data', () => {
  for (const invalid of [{ secret: 'SENTINEL' }, ['SENTINEL'], undefined, NaN, Infinity, -Infinity, -0, Number.MAX_SAFE_INTEGER + 1, '\uD800']) {
    for (const key of ['raw', 'cached', 'formula']) { const value = row(); value.item.columns[0][key] = invalid; denied(() => confirmLegacyHistoryRow(value, rowRequest)); }
  }
  for (const mutate of [v => v.item.columns = [], v => v.item.columns[1].columnIndex = 2, v => v.item.columns[0].columnIndex = 0,
    v => delete v.item.columns[0].cached, v => v.item.columns[0].secret = 'SENTINEL', v => v.item.columns[0].label = 'x'.repeat(1001)]) {
    const value = row(); mutate(value); denied(() => confirmLegacyHistoryRow(value, rowRequest));
  }
});

test('accessors, symbols, sparse arrays and prototype tricks cannot expose partial data', () => {
  let called = false; const accessor = list(); Object.defineProperty(accessor, 'items', { enumerable: true, get() { called = true; return ['SENTINEL']; } });
  denied(() => confirmLegacyHistoryList(accessor, listRequest)); assert.equal(called, false);
  const symbolic = row(); symbolic[Symbol('secret')] = 'SENTINEL'; denied(() => confirmLegacyHistoryRow(symbolic, rowRequest));
  const sparse = list(); sparse.items = Array(1); denied(() => confirmLegacyHistoryList(sparse, listRequest));
  const extended = row(); extended.item.columns.extra = 'SENTINEL'; denied(() => confirmLegacyHistoryRow(extended, rowRequest));
  const inherited = Object.create(list()); denied(() => confirmLegacyHistoryList(inherited, listRequest));
});

test('shared literal formatter keeps missing/empty/null/boolean/number separate and identity covers all primitives', () => {
  assert.equal(legacyHistoryScalarText(undefined), '目前未提供'); assert.equal(legacyHistoryScalarText(''), '空白文字'); assert.equal(legacyHistoryScalarText(null), '空值（null）');
  assert.equal(legacyHistoryScalarText(false), 'false（布林值）'); assert.equal(legacyHistoryScalarText(0), '0（數字）'); assert.equal(legacyHistoryScalarText(' =1+1\r\n'), ' =1+1\r\n');
  const ctx = { user: { id: userId, employeeId }, organizationId: orgId, role: 'admin' }, expected = legacyHistoryIdentity(ctx);
  assert.equal(legacyHistoryIdentity({ ...ctx, user: { ...ctx.user } }), expected);
  for (const changed of [{ ...ctx, user: { ...ctx.user, id: randomUUID() } }, { ...ctx, organizationId: otherOrg }, { ...ctx, role: 'finance' }, { ...ctx, user: { ...ctx.user, employeeId: null } }]) assert.notEqual(legacyHistoryIdentity(changed), expected);
});

test('reader uses shared guarded modal and fixed three read routes without HTML, export, mutation or second focus owner', () => {
  const source = readFileSync(new URL('../public/modules/legacy-history.js', import.meta.url), 'utf8');
  assert.match(source, /guardedRead: true/); assert.match(source, /sourceSystem|已封存不代表原平台全部資料已移轉/);
  assert.match(source, /getContext\(\) === context/); assert.match(source, /parentCurrent\(\)/); assert.match(source, /\[401, 403\]/);
  assert.match(source, /aria-busy/); assert.match(source, /aria-disabled/); assert.match(source, /sourceNativeId === null/); assert.match(source, /封存定位，不是原服務事件 UUID/);
  assert.doesNotMatch(source, /innerHTML|outerHTML|localStorage|sessionStorage|document\.createElement\(['"]dialog|window\.(?:alert|confirm|prompt)|\.showModal\(|method:\s*['"](?:POST|PATCH|DELETE)/);
});
