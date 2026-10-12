import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { confirmLegacyMigrationList, confirmLegacyMigrationBatch, confirmLegacyMigrationRecord, legacyMigrationsIdentity, legacyScalarText } from '../public/data/legacy-migrations.js';

const orgId = '11111111-1111-4111-8111-111111111111', batchId = '22222222-2222-4222-8222-222222222222', mappingId = '33333333-3333-4333-8333-333333333333', targetId = '44444444-4444-4444-8444-444444444444';
const time = '2026-10-12T01:02:03.000Z', meta = id => ({ id, orgId, version: 1, createdAt: time, updatedAt: time });
const batch = extra => ({ ...meta(batchId), provider: 'synthetic', tenant: 'synthetic-tenant', sourceHash: 'a'.repeat(64), payloadHash: 'b'.repeat(64), archiveManifestSha256: 'c'.repeat(64),
  archiveId: 'archive-55555555-5555-4555-8555-555555555555', importedBy: '66666666-6666-4666-8666-666666666666', importedAt: time,
  importedCount: 1, caseCount: 1, employeeCount: 0, status: 'operational-first-slice', sourceSystemComplete: false, operationalImportCompleted: true, ...extra });
const summary = extra => ({ ...meta(mappingId), batchId, entity: 'cases', sourceId: 'a'.repeat(24), targetId, name: '合成移轉個案', businessNo: 'SYN-CASE-001',
  businessNoOrigin: 'source', sourceCreatedAt: '  民國109年原建立時間\r\n非UTC日期  ', sourceFileId: 'file-00000001', rowNumber: 2, ...extra });
const caseData = extra => ({ name: '合成移轉個案', caseNo: 'SYN-CASE-001', status: 'active', note: '  完整原備註\r\n尾端\0之後  ', ...extra });
const record = extra => ({ orgId, item: { ...summary(), data: caseData(), columns: [
  { columnIndex: 1, label: '同名欄位', raw: '  <img src=x onerror=alert(1)>\r\n完整\0之後  ', formula: '=HYPERLINK("https://invalid.example","合成")', cached: false },
  { columnIndex: 2, label: '同名欄位', raw: null, formula: null, cached: 0 },
  { columnIndex: 4, label: '空白原文', raw: '', formula: '', cached: '' }
] }, batch: batch(), currentTarget: { ...caseData(), ...meta(targetId), version: 2, note: '目前主檔另有備註' }, sourceSystemComplete: false, ...extra });
const requested = { orgId, id: mappingId }, listRequest = { orgId, page: 1, pageSize: 25 }, batchRequest = { orgId, id: batchId, page: 1, pageSize: 25 };
const list = (items = [batch()], total = items.length, extra = {}) => ({ orgId, items, total, page: 1, pageSize: 25, sourceSystemComplete: false, ...extra });
const detail = extra => ({ orgId, item: batch(), records: [summary()], total: 1, page: 1, pageSize: 25, sourceSystemComplete: false, ...extra });
const fail = fn => assert.throws(fn, error => error.code === 'LEGACY_MIGRATIONS_UNCONFIRMED' && !error.message.includes('SENTINEL'));

test('bounded batch and child pages confirm exact own org/query echoes and immutable snapshots', () => {
  const saved = confirmLegacyMigrationList(list(), listRequest); assert.equal(saved.items[0].sourceSystemComplete, false); assert(Object.isFrozen(saved.items[0]));
  const child = confirmLegacyMigrationBatch(detail(), batchRequest); assert.equal(child.records[0].sourceCreatedAt, summary().sourceCreatedAt); assert(Object.isFrozen(child.records));
  assert.deepEqual(confirmLegacyMigrationList(list([], 0), listRequest).items, []);
  const later = confirmLegacyMigrationList(list([batch()], 26, { page: 2 }), { orgId, page: 2, pageSize: 25 }); assert.equal(later.items.length, 1);
});

test('missing/wrong page sizes, impossible counts, more than25 rows, duplicate IDs and wrong organization fail closed', () => {
  for (const value of [list(undefined, 26), list(undefined, -1), list(undefined, 1, { page: 2 }), list(undefined, 1, { pageSize: 100 }),
    list(undefined, 1, { orgId: targetId }), list([batch(), batch()], 2), list(Array(26).fill(batch()), 26), list(undefined, 1, { sourceSystemComplete: true })]) fail(() => confirmLegacyMigrationList(value, listRequest));
  for (const value of [detail({ total: 2 }), detail({ item: batch({ id: targetId }) }), detail({ records: [summary({ batchId: targetId })] }), detail({ records: [summary({ orgId: targetId })] })])
    fail(() => confirmLegacyMigrationBatch(value, batchRequest));
});

test('provenance, importer, timestamps, counts and status cannot pretend the whole source system was migrated', () => {
  for (const change of [{ sourceHash: 'SENTINEL' }, { payloadHash: 'A'.repeat(64) }, { provider: 'SENTINEL@example.invalid' }, { tenant: '合成姓名' },
    { importedBy: 'SENTINEL' }, { archiveId: '../SENTINEL' }, { status: 'complete' }, { operationalImportCompleted: false }, { importedCount: 0 },
    { importedCount: 2001, caseCount: 2001 }, { caseCount: 2 }, { sourceSystemComplete: true }, { importedAt: '2026-02-30T00:00:00.000Z' }, { updatedAt: '' }, { version: 0 }])
    fail(() => confirmLegacyMigrationList(list([batch(change)]), listRequest));
});

test('record projection preserves all original text including CRLF, loneCR and NUL suffix; formulas stay literal', () => {
  const original = record(), projected = confirmLegacyMigrationRecord(original, requested);
  assert.equal(projected.item.columns[0].raw, original.item.columns[0].raw); assert.equal(projected.item.columns[0].formula, original.item.columns[0].formula);
  assert.equal(projected.item.data.note, original.item.data.note); assert.equal(projected.item.sourceCreatedAt, original.item.sourceCreatedAt);
  assert.equal(projected.item.columns.length, 3); assert.equal(projected.item.columns[0].label, projected.item.columns[1].label); assert(Object.isFrozen(projected.item.columns[0]));
  assert.equal(projected.fields.find(field => field.key === 'note').comparison, 'changed'); assert.equal(projected.fields.find(field => field.key === 'name').comparison, 'same');
  assert.equal(projected.sourceSystemComplete, false); assert(!JSON.stringify(projected).includes('synchronized'));
});

test('only compared snapshot fields are compared; missing current values and newer target version never imply source synchronization', () => {
  const value = record(); delete value.currentTarget.note; const saved = confirmLegacyMigrationRecord(value, requested);
  assert.equal(saved.fields.find(field => field.key === 'note').comparison, 'missing'); assert.equal(saved.currentTarget.version, 2);
  value.item.sourceCreatedAt = ''; assert.equal(confirmLegacyMigrationRecord(value, requested).item.sourceCreatedAt, '');
  value.item.sourceCreatedAt = null; assert.equal(confirmLegacyMigrationRecord(value, requested).item.sourceCreatedAt, null);
});

test('employee derived number is explicitly bound to source provider/ID and never turns into a payroll or login rule', () => {
  const employee = record(), sourceId = 'e'.repeat(24), employeeNo = 'SYNTHETIC-' + sourceId;
  employee.item = { ...summary({ entity: 'employees', sourceId, businessNo: employeeNo, businessNoOrigin: 'derived' }), data: { name: '合成移轉個案', employeeNo, status: 'active', regions: ['合成區甲', '合成區乙'] }, columns: employee.item.columns };
  employee.batch = batch({ caseCount: 0, employeeCount: 1 }); employee.currentTarget = { ...employee.item.data, ...meta(targetId), hourlyRateCents: 20001 };
  const saved = confirmLegacyMigrationRecord(employee, requested); assert.equal(saved.item.businessNoOrigin, 'derived'); assert.equal(saved.currentTarget.hourlyRateCents, 20001);
  assert(!Object.hasOwn(saved.item.data, 'hourlyRateCents')); assert(!saved.fields.some(field => field.key === 'hourlyRateCents'));
  employee.item.businessNo = 'ICARE-' + sourceId; fail(() => confirmLegacyMigrationRecord(employee, requested));
});

test('cross org/parent/source identity or target-metadata substitutions disclose no source fields', () => {
  for (const change of [{ orgId: targetId }, { batch: batch({ id: targetId }) }, { currentTarget: { ...caseData(), ...meta(batchId) } },
    { item: { ...record().item, sourceId: 'SENTINEL' } }, { item: { ...record().item, sourceFileId: 'file-00000000' } }, { item: { ...record().item, businessNo: 'SENTINEL-mismatch' } }])
    fail(() => confirmLegacyMigrationRecord(record(change), requested));
});

test('original columns reject nested objects, formulas as objects, duplicate indices and unsafe numerical coercion', () => {
  for (const change of [{ raw: { secret: 'SENTINEL', formula: '=EXEC()' } }, { cached: ['SENTINEL'] }, { formula: { formula: '=EXEC()' } }, { raw: Infinity },
    { raw: -0 }, { raw: Number.MAX_SAFE_INTEGER + 1 }, { columnIndex: 0 }, { columnIndex: 16385 }, { label: 'x'.repeat(1001) }, { raw: 'x'.repeat(100001) }]) {
    const value = record(); Object.assign(value.item.columns[0], change); fail(() => confirmLegacyMigrationRecord(value, requested));
  }
  const duplicate = record(); duplicate.item.columns[1].columnIndex = 1; fail(() => confirmLegacyMigrationRecord(duplicate, requested));
  const empty = record(); empty.item.columns = []; fail(() => confirmLegacyMigrationRecord(empty, requested));
});

test('closed descriptors fail without invoking getters, inherited data, sparse arrays, hidden properties or symbols', () => {
  let calls = 0;
  const getter = record(); Object.defineProperty(getter.item.columns[0], 'raw', { enumerable: true, get() { calls++; return 'SENTINEL'; } });
  fail(() => confirmLegacyMigrationRecord(getter, requested));
  const hidden = record(); Object.defineProperty(hidden.item, 'data', { enumerable: false }); fail(() => confirmLegacyMigrationRecord(hidden, requested));
  const sparse = record(); sparse.item.columns = Array(1); fail(() => confirmLegacyMigrationRecord(sparse, requested));
  const symbol = record(); symbol.item.data[Symbol('private')] = 'SENTINEL'; fail(() => confirmLegacyMigrationRecord(symbol, requested));
  fail(() => confirmLegacyMigrationRecord(Object.create(record()), requested)); fail(() => confirmLegacyMigrationRecord(record({ secret: 'SENTINEL' }), requested));
  assert.equal(calls, 0);
});

test('target snapshots accept only declared business fields, correct status, region values and bounded current trial rates', () => {
  for (const change of [{ unknown: 'SENTINEL' }, { status: 'approved' }, { name: {} }, { cmsLevel: 9 }, { cmsLevel: 1.5 }]) {
    const value = record(); Object.assign(value.item.data, change); fail(() => confirmLegacyMigrationRecord(value, requested));
  }
  const value = record(); value.item.data.hourlyRateCents = 1; fail(() => confirmLegacyMigrationRecord(value, requested));
});

test('literal field formatting distinguishes absent/empty/null/boolean/numeric values and never serializes nested values', () => {
  assert.equal(legacyScalarText(undefined), '目前未提供'); assert.equal(legacyScalarText(''), '空白文字'); assert.equal(legacyScalarText(null), '空值（null）');
  assert.equal(legacyScalarText(false), 'false（布林值）'); assert.equal(legacyScalarText(0), '0（數字）'); assert.equal(legacyScalarText(['合成甲', '合成乙']), '合成甲\n合成乙');
  assert.equal(legacyScalarText(' =1+1\r\n'), ' =1+1\r\n'); fail(() => legacyScalarText({ secret: 'SENTINEL' }));
});

test('context identity covers all authorization primitives but permits nested references with identical primitive values', () => {
  const value = { user: { id: mappingId, employeeId: targetId }, organizationId: orgId, role: 'admin' }, identity = legacyMigrationsIdentity(value);
  assert.equal(legacyMigrationsIdentity({ ...value, user: { ...value.user } }), identity);
  for (const changed of [{ ...value, role: 'finance' }, { ...value, organizationId: targetId }, { ...value, user: { ...value.user, id: targetId } }, { ...value, user: { ...value.user, employeeId: mappingId } }])
    assert.notEqual(legacyMigrationsIdentity(changed), identity);
});

test('screen delegates table/modal/paging/errors to shared owner and exposes only GET reads, no local mutation or file path controls', () => {
  const source = readFileSync(new URL('../public/modules/legacy-migrations.js', import.meta.url), 'utf8');
  assert(source.includes('guardedRead: true')); assert(source.includes('pageSize=25')); assert(source.includes('active.signal'));
  for (const forbidden of ['innerHTML', 'insertAdjacentHTML', 'fetchAll(', 'downloadCsv(', 'window.alert(', 'window.confirm(', "method: 'POST'", "method: 'PATCH'", "method: 'DELETE'"])
    assert(!source.includes(forbidden));
});
