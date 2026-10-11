import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCaseContactFootprintCaseLookups as project, createCaseContactFootprintEditor } from '../public/data/case-contact-footprint-editor.js';
const orgId = 'synthetic-lookup-org', caseId = 'synthetic-current-case';
const current = { id: caseId, orgId, caseNo: 'CURRENT', name: '合成原個案' };
test('legacy display objects, null and missing labels cannot poison unchanged same-org case identities', () => {
  let nestedReads = 0; const unknown = Object.defineProperty({}, 'toString', { get() { nestedReads++; throw new Error('must not coerce'); } });
  const cases = [current, { id: 'synthetic-legacy-case', orgId, name: unknown, caseNo: null }, { id: 'synthetic-missing-case', orgId }];
  const options = project(cases, { orgId }); assert.deepEqual(options, [current, { id: 'synthetic-legacy-case', orgId, name: '未取得', caseNo: '未取得' }, { id: 'synthetic-missing-case', orgId, name: '未提供', caseNo: '未提供' }]);
  assert.equal(cases[1].name, unknown); assert.equal(cases[1].caseNo, null); assert.equal(Object.hasOwn(cases[2], 'name'), false); assert.equal(nestedReads, 0);
  const editor = createCaseContactFootprintEditor({ caseId, orgId, defaultDate: '2026-10-11', cases: options });
  const payload = editor.buildPayload({ ...editor.initial, location: '合成人工場所', contactDescription: '合成人工回報', relatedCaseId: 'synthetic-legacy-case' }); assert.equal(payload.relatedCaseId, 'synthetic-legacy-case'); assert.equal(payload.caseId, caseId);
});
test('original labels preserve string bytes and empty-label display follows the canonical case owner', () => {
  const cases = [{ ...current, name: ' 合成姓名\n末行 ', caseNo: '  合成案號  ' }, { id: 'synthetic-empty-case', orgId, name: '', caseNo: '' }];
  const snapshot = structuredClone(cases), result = project(cases, { orgId }); assert.equal(result[0].name, cases[0].name); assert.equal(result[0].caseNo, cases[0].caseNo); assert.equal(result[1].name, '未提供'); assert.deepEqual(cases, snapshot);
});
test('identity, organization, duplicate and 10000-option boundaries remain strict', () => {
  for (const cases of [[{ ...current, orgId: 'foreign-org' }], [{ ...current, id: ' padded' }], [{ ...current, id: 1 }], [current, { ...current, name: '同名不混合' }], [null], Array(10001).fill(current)]) assert.throws(() => project(cases, { orgId }));
  assert.throws(() => project([current], { orgId: ' padded' }));
});
test('array shape and property descriptors reject malformed lookup DTOs with zero getter reads', () => {
  let reads = 0;
  for (const mutate of [list => { delete list[0]; }, list => { list.extra = true; }, list => { list[Symbol('hidden')] = true; }, list => Object.defineProperty(list, '0', { enumerable: true, get() { reads++; return current; } })]) { const cases = [current]; mutate(cases); assert.throws(() => project(cases, { orgId })); }
  for (const key of ['id', 'orgId', 'name', 'caseNo']) { const candidate = Object.defineProperty({ ...current }, key, { enumerable: true, get() { reads++; return current[key]; } }); assert.throws(() => project([candidate], { orgId })); }
  assert.throws(() => project([Object.defineProperty({ ...current }, 'hidden', { value: true })], { orgId })); assert.equal(reads, 0);
});
