import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CUSTOM_FORM_PACKAGE_FORMAT, CUSTOM_FORM_PACKAGE_MAX_BYTES, createCustomFormPackage, readCustomFormPackage, customFormPackageDraft } from '../public/data/custom-form-package.js';
import { confirmCustomFormSave } from '../public/data/custom-form-editor.js';
const field = (key, type, extra = {}) => ({ key, label: '合成題項 ' + key, type, groupId: 'followup', required: false, options: [], visibleIf: null, ...extra });
const template = () => ({ code: 'SYN-PACKAGE-SOURCE', name: '合成模板😀', description: '  合成說明\r\n末段  ', note: '  合成備註\r\n末段  ', groups: [{ id: 'followup', label: '合成群組' }],
  fields: [field('agreed', 'boolean'), field('detail', 'textarea', { required: true, visibleIf: { field: 'agreed', equals: true } }), field('reading', 'number'), field('day', 'date'),
    field('choice', 'select', { options: [{ value: 'yes', label: '合成是' }, { value: 'no', label: '合成否' }] }), field('actions', 'multiselect', { options: [{ value: 'one', label: '合成甲' }] }), field('short', 'text')],
  revision: 3, previousTemplateId: 'synthetic-previous-private-id', status: 'published', id: 'synthetic-template-private-id', orgId: 'synthetic-source-org', version: 8, createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:01:00Z' });
const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
test('Portable export has a closed six-field definition and independent canonical SHA; exact seven types and CRLF preserved', async () => {
  const source = template(), before = structuredClone(source), result = await createCustomFormPackage(source, source.orgId);
  assert.deepEqual(Object.keys(result), ['format', 'version', 'definition', 'sha256']);
  assert.deepEqual(Object.keys(result.definition), ['code', 'name', 'description', 'groups', 'fields', 'note']);
  assert.equal(result.format, CUSTOM_FORM_PACKAGE_FORMAT); assert.equal(result.version, 1);
  const { sha256, ...body } = result; assert.equal(sha256, createHash('sha256').update(JSON.stringify(body)).digest('hex'));
  assert.deepEqual(result.definition.fields, source.fields); assert.equal(result.definition.description, source.description); assert.equal(result.definition.note, source.note);
  for (const text of [source.orgId, source.id, source.previousTemplateId, 'answers', 'attachmentIds', 'createdAt', 'updatedAt']) assert.ok(!JSON.stringify(result).includes(text));
  assert.deepEqual(source, before); assert.ok(Object.isFrozen(result.definition.fields[1].visibleIf));
  assert.deepEqual(await readCustomFormPackage(bytes(result)), result);
});
test('Export does not coerce foreign org, unknown metadata or source answers/IDs into a portable package', async () => {
  const source = template(); await assert.rejects(createCustomFormPackage(source, 'other-org'));
  for (const extra of [{ answers: { detail: '合成私密答案' } }, { attachmentIds: ['synthetic-attachment'] }, { userId: 'synthetic-private-user' }, { fileId: 'synthetic-file' }]) await assert.rejects(createCustomFormPackage({ ...source, ...extra }, source.orgId));
});
test('Definition and nested key ordering canonicalizes, while original field, group and option order stays exact', async () => {
  const source = template(), result = await createCustomFormPackage(source, source.orgId), reordered = { ...result, definition: Object.fromEntries(Object.entries(result.definition).reverse()) };
  reordered.definition.fields = reordered.definition.fields.map(value => Object.fromEntries(Object.entries(value).reverse()));
  assert.deepEqual(await readCustomFormPackage(bytes(reordered)), result);
  assert.deepEqual((await readCustomFormPackage(bytes(reordered))).definition.fields.map(value => value.key), source.fields.map(value => value.key));
});
test('Corruption, unsupported format/version, unclosed envelopes/definitions and missing checksum reject before draft creation', async () => {
  const original = await createCustomFormPackage(template(), 'synthetic-source-org');
  for (const mutate of [p => { p.definition.name = '合成變更'; }, p => { p.format = 'other'; }, p => { p.version = 2; }, p => { p.version = '1'; },
    p => { p.sha256 = p.sha256.toUpperCase(); }, p => { delete p.sha256; }, p => { p.orgId = 'synthetic-other'; }, p => { p.definition.answers = {}; },
    p => { p.definition.fields[0].extra = true; }, p => { p.definition.fields[1].visibleIf.eval = 'throw'; }, p => { p.definition.groups[0].id = '__proto__'; }]) {
    const copy = structuredClone(original); mutate(copy); await assert.rejects(readCustomFormPackage(bytes(copy)), error => error.code === 'CUSTOM_FORM_PACKAGE_INVALID');
  }
});
test('Malformed UTF8, BOM, NUL, empty and oversize bytes reject; no replacement-character fallback', async () => {
  for (const input of [new Uint8Array(), new Uint8Array([0xff]), new Uint8Array([0xc0, 0xaf]), new Uint8Array(CUSTOM_FORM_PACKAGE_MAX_BYTES + 1), bytes('\uFEFF{}'), bytes('{"x":"\0"}')]) await assert.rejects(readCustomFormPackage(input));
  await assert.rejects(readCustomFormPackage('{}')); await assert.rejects(readCustomFormPackage(null));
});
test('Duplicate and escaped duplicate JSON keys are rejected at every nested depth instead of last-value overwrite', async () => {
  const result = await createCustomFormPackage(template(), 'synthetic-source-org'), text = JSON.stringify(result);
  for (const input of [text.replace('"version":1', '"version":9,"version":1'), text.replace('"version":1', '"version":9,"\\u0076ersion":1'),
    text.replace('"required":false', '"required":true,"required":false'), text.replace('"field":"agreed"', '"field":"other","\\u0066ield":"agreed"')]) await assert.rejects(readCustomFormPackage(bytes(input)), /重複/);
});
test('JSON syntax never accepts trailing data, comments, invalid tokens, deep nesting, sparse arrays or leading-zero numbers', async () => {
  for (const text of ['{} {}', '{/*comment*/}', '{"a":01}', '{"a":truefalse}', '{"a":}', '{"a":1,}', '[1,,2]', '"unterminated', '['.repeat(18) + '0' + ']'.repeat(18), '[0,' + '0,'.repeat(40001) + '0]']) await assert.rejects(readCustomFormPackage(bytes(text)));
});
test('Getter/sparse/unknown schema rejects without invoking attacker properties or changing the source', async () => {
  let calls = 0; const source = template(); Object.defineProperty(source.fields[0], 'label', { enumerable: true, get() { calls++; return 'bad'; } });
  await assert.rejects(createCustomFormPackage(source, source.orgId)); assert.equal(calls, 0);
  const sparse = template(); delete sparse.fields[2]; await assert.rejects(createCustomFormPackage(sparse, sparse.orgId));
  const getter = template(); Object.defineProperty(getter, 'code', { enumerable: true, get() { calls++; return 'bad'; } }); await assert.rejects(createCustomFormPackage(getter, getter.orgId)); assert.equal(calls, 0);
});
test('Lone surrogates and escaped NUL reject, but astral characters remain byte-exact', async () => {
  for (const value of ['\uD800', '\uDC00', '\0']) { const source = template(); source.note = value; await assert.rejects(createCustomFormPackage(source, source.orgId)); }
  const result = await createCustomFormPackage(template(), 'synthetic-source-org');
  await assert.rejects(readCustomFormPackage(bytes(JSON.stringify(result).replace('合成模板😀', '合成模板\\ud800'))));
  await assert.rejects(readCustomFormPackage(bytes(JSON.stringify(result).replace('合成模板😀', '合成模板\\u0000'))));
  assert.equal((await readCustomFormPackage(bytes(result))).definition.name, '合成模板😀');
});
test('Import always requires an explicit new code/name and creates revision one draft with no foreign lineage', async () => {
  const source = template(), result = await createCustomFormPackage(source, source.orgId), before = JSON.stringify(result);
  const draft = customFormPackageDraft(result, { code: '  SYN-NEW-PACKAGE  ', name: '  合成新草稿  ' });
  assert.equal(draft.code, 'SYN-NEW-PACKAGE'); assert.equal(draft.name, '合成新草稿'); assert.equal(draft.revision, 1); assert.equal(draft.previousTemplateId, ''); assert.equal(draft.status, 'draft');
  assert.deepEqual(draft.fields, source.fields); assert.equal(draft.note, source.note); assert.equal(JSON.stringify(result), before); assert.ok(Object.isFrozen(draft.fields));
  for (const choice of [{ code: source.code, name: '新名' }, { code: '', name: '新名' }, { code: 'NEW\r\n', name: '新名' }, { code: 'NEW', name: '' }, { code: 'NEW', name: 'n'.repeat(201) }, { code: 'NEW', name: '新名', status: 'published' }]) assert.throws(() => customFormPackageDraft(result, choice));
});
test('Maximum supported option/field definition transfers completely; no truncation or private data slots', async () => {
  const source = template(); source.fields = Array.from({ length: 50 }, (_, i) => field('choice' + i, 'select', { options: Array.from({ length: 50 }, (_, j) => ({ value: 'value' + j, label: '合成'.repeat(99) })) }));
  const result = await readCustomFormPackage(bytes(await createCustomFormPackage(source, source.orgId))); assert.equal(result.definition.fields.length, 50); assert.equal(result.definition.fields[49].options[49].label.length, 198);
});
test('Existing exact save ACK rejects missing/wrong draft data and identity/version mismatch; original immutable definition unchanged', async () => {
  const result = await createCustomFormPackage(template(), 'synthetic-source-org'), payload = customFormPackageDraft(result, { code: 'ACK-DRAFT', name: '合成回執草稿' });
  const item = { ...structuredClone(payload), id: 'synthetic-new-draft', orgId: 'synthetic-target-org', version: 1, createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z' };
  assert.equal(confirmCustomFormSave({ item }, { entity: 'form-templates', orgId: item.orgId, payload }), item);
  for (const patch of [{ orgId: 'foreign' }, { version: 2 }, { code: 'wrong' }, { status: 'published' }, { note: 'trimmed' }]) assert.throws(() => confirmCustomFormSave({ item: { ...item, ...patch } }, { entity: 'form-templates', orgId: item.orgId, payload }));
});
test('Unavailable WebCrypto explicitly stops transfer rather than claiming a checksum or substituting an unauthenticated fallback', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try { Object.defineProperty(globalThis, 'crypto', { value: { subtle: undefined }, configurable: true }); await assert.rejects(createCustomFormPackage(template(), 'synthetic-source-org'), /不能核對模板檔案/); }
  finally { if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); else delete globalThis.crypto; }
});
