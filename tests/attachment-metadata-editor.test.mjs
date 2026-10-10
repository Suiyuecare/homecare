import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAttachmentMetadataEditor, confirmAttachmentMetadataList, attachmentMetadataIdentity,
  formatAttachmentMetadataText, formatAttachmentMetadataCategory, formatAttachmentMetadataStatus, formatAttachmentMetadataMime,
} from '../public/data/attachment-metadata-editor.js';

const orgId = 'synthetic-org', parentId = 'synthetic-case', employeeId = 'synthetic-employee';
const caseItem = () => ({ id: 'synthetic-case-attachment', orgId, version: 7, caseId: parentId,
  title: '原標題', category: 'general', note: '原備註', status: 'active',
  fileName: 'synthetic.pdf', mimeType: 'application/pdf', sizeBytes: 16, sha256: 'synthetic-file-digest' });
const certItem = () => { const item = caseItem(); delete item.caseId; delete item.category;
  return { ...item, id: 'synthetic-cert-attachment', certificationId: 'synthetic-cert', employeeId }; };
const editorFor = item => createAttachmentMetadataEditor({ entity: Object.hasOwn(item, 'caseId') ? 'case-attachments' : 'certification-attachments',
  existing: item, parentId: item.caseId ?? item.certificationId, employeeId });
const saved = (item, payload) => ({ ...structuredClone(item), ...Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value])), version: item.version + 1 });
const unconfirmed = action => assert.throws(action, error => error.code === 'SAVE_UNCONFIRMED' && error.message === '儲存結果未確認；請保留輸入並重新讀取確認。');
const list = (items, extra = {}) => ({ items, total: items.length, page: 1, pageSize: 25, ...extra });
const requested = extra => ({ entity: 'case-attachments', orgId, parentId, page: 1, pageSize: 25, ...extra });

test('case and certificate editors expose only their metadata controls and no parent, employee or file mutation', () => {
  const a = editorFor(caseItem()), b = editorFor(certItem());
  assert.deepEqual(Object.keys(a.initial), ['title', 'category', 'note']);
  assert.deepEqual(Object.keys(b.initial), ['title', 'note']);
  for (const editor of [a, b]) assert.deepEqual(editor.buildPayload(editor.initial), {});
  for (const key of ['caseId', 'certificationId', 'employeeId', 'fileName', 'mimeType', 'sizeBytes', 'sha256', 'fileId', 'version', 'status'])
    assert.throws(() => a.buildPayload({ ...a.initial, [key]: 'hidden' }));
});

test('unmodified leading/trailing whitespace and LF notes are omitted while explicit changes alone are trimmed', () => {
  const item = { ...caseItem(), title: '  保存標題  ', note: '  第一行\n尾句  ' }, editor = editorFor(item);
  assert.equal(editor.initial.title, item.title); assert.equal(editor.initial.note, item.note);
  assert.deepEqual(editor.buildPayload(editor.initial), {});
  const payload = editor.buildPayload({ ...editor.initial, category: 'care' });
  assert.deepEqual(payload, { category: 'care' });
  assert.equal(editor.confirm(saved(item, payload), orgId, payload).note, item.note);
  assert.deepEqual(editor.buildPayload({ ...editor.initial, title: ' 新標題 ' }), { title: '新標題' });
});

test('CR/LF titles and CR notes remain private with keep defaults and require explicit replacement', () => {
  const item = { ...caseItem(), title: 'title\r\nline', note: 'before\r\nlast\r' }, editor = editorFor(item);
  assert.equal(editor.initial.title, ''); assert.equal(editor.initial.note, '');
  assert.equal(editor.initial.titleIntent, 'keep'); assert.equal(editor.initial.noteIntent, 'keep');
  assert.equal(editor.enabled('title', editor.initial), false); assert.equal(editor.enabled('note', editor.initial), false);
  assert.deepEqual(editor.buildPayload({ ...editor.initial, category: 'care' }), { category: 'care' });
  const payload = { category: 'care' }; assert.equal(editor.confirm(saved(item, payload), orgId, payload).title, item.title);
  assert.equal(editor.enabled('title', { ...editor.initial, titleIntent: 'replace' }), true);
  assert.deepEqual(editor.buildPayload({ ...editor.initial, titleIntent: 'replace', title: '  修復標題  ' }), { title: '修復標題' });
  assert.deepEqual(editor.buildPayload({ ...editor.initial, noteIntent: 'replace', note: ' 新\r\n尾句 ' }), { note: '新\r\n尾句' });
});

test('missing and typed optional notes preserve own-presence until an explicit clear or replacement', () => {
  for (const value of [undefined, null, 0, false, ['private'], { secret: 'private' }]) {
    const item = caseItem(); if (value === undefined) delete item.note; else item.note = value;
    const editor = editorFor(item); assert(editor.needsIntent('note')); assert.equal(editor.initial.noteIntent, 'keep');
    assert.deepEqual(editor.buildPayload(editor.initial), {});
    const payload = { title: '另標題' }, confirmed = editor.confirm(saved(item, payload), orgId, payload);
    assert.equal(Object.hasOwn(confirmed, 'note'), value !== undefined); if (value !== undefined) assert.deepEqual(confirmed.note, value);
    assert.deepEqual(editor.buildPayload({ ...editor.initial, noteIntent: 'clear' }), { note: '' });
    assert.deepEqual(editor.buildPayload({ ...editor.initial, noteIntent: 'replace', note: ' 新文字 ' }), { note: '新文字' });
  }
});

test('invalid required legacy title/category are kept rather than silently repaired; required fields cannot clear', () => {
  const item = caseItem(); delete item.title; item.category = { hidden: true };
  const editor = editorFor(item); assert.equal(editor.initial.titleIntent, 'keep'); assert.equal(editor.initial.categoryIntent, 'keep');
  assert.deepEqual(editor.buildPayload({ ...editor.initial, note: '明確修改' }), { note: '明確修改' });
  assert.throws(() => editor.buildPayload({ ...editor.initial, titleIntent: 'clear' }));
  assert.throws(() => editor.buildPayload({ ...editor.initial, categoryIntent: 'clear' }));
  assert.throws(() => editor.buildPayload({ ...editor.initial, titleIntent: 'replace', title: '  ' }));
  assert.throws(() => editor.buildPayload({ ...editor.initial, categoryIntent: 'replace', category: 'unknown' }));
  assert.deepEqual(editor.buildPayload({ ...editor.initial, titleIntent: 'replace', title: '修復', categoryIntent: 'replace', category: 'other' }), { title: '修復', category: 'other' });
});

test('unknown status has an explicit repair selector and no guessed independent status action', () => {
  for (const value of [undefined, null, 'mystery', false, { secret: 'hidden' }]) {
    const item = caseItem(); if (value === undefined) delete item.status; else item.status = value;
    const editor = editorFor(item); assert.equal(editor.initial.statusRepair, 'keep');
    assert.deepEqual(editor.buildPayload(editor.initial), {}); assert.throws(() => editor.buildStatusChange('inactive'));
    assert.deepEqual(editor.buildPayload({ ...editor.initial, statusRepair: 'active' }), { status: 'active' });
    assert.throws(() => editor.buildPayload({ ...editor.initial, statusRepair: 'guessed' }));
    const payload = { status: 'inactive' }; assert.equal(editor.confirm(saved(item, payload), orgId, payload).status, 'inactive');
  }
});

test('known status changes are independent status-only payloads and preserve all raw metadata', () => {
  const item = { ...caseItem(), note: { private: ['raw'] } }, editor = editorFor(item);
  assert(!Object.hasOwn(editor.initial, 'statusRepair')); const payload = editor.buildStatusChange('inactive');
  assert.deepEqual(payload, { status: 'inactive' }); assert.deepEqual(editor.confirm(saved(item, payload), orgId, payload).note, item.note);
  assert.throws(() => editor.buildStatusChange('active')); assert.throws(() => editor.buildStatusChange('mystery'));
  assert.throws(() => editor.buildPayload({ ...editor.initial, statusRepair: 'inactive' }));
});

test('title200/note10000 accepted; only sent normalized strings are validated and oversized originals require intent', () => {
  const editor = editorFor(caseItem());
  assert.equal(editor.buildPayload({ ...editor.initial, title: 'x'.repeat(200), note: 'n'.repeat(10000) }).note.length, 10000);
  assert.throws(() => editor.buildPayload({ ...editor.initial, title: 'x'.repeat(201) }));
  assert.throws(() => editor.buildPayload({ ...editor.initial, note: 'n'.repeat(10001) }));
  assert.equal(editor.buildPayload({ ...editor.initial, title: ' ' + 'x'.repeat(200) + ' ' }).title.length, 200);
  const oversized = editorFor({ ...caseItem(), title: 'x'.repeat(201), note: 'n'.repeat(10001) });
  assert(oversized.needsIntent('title')); assert(oversized.needsIntent('note')); assert.deepEqual(oversized.buildPayload(oversized.initial), {});
});

test('ACK requires exact ID/org/parent and a safe next version without same or skipped version success', () => {
  const item = caseItem(), editor = editorFor(item), payload = { note: '新值' }, ack = saved(item, payload);
  for (const patch of [{ id: 'another' }, { orgId: 'other-org' }, { caseId: 'other-case' }, { version: 7 }, { version: 9 }, { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 }])
    unconfirmed(() => editor.confirm({ ...ack, ...patch }, orgId, payload));
  for (const key of ['id', 'orgId', 'caseId', 'version']) { const broken = { ...ack }; delete broken[key]; unconfirmed(() => editor.confirm(broken, orgId, payload)); }
  unconfirmed(() => editor.confirm(ack, 'other-org', payload));
  assert.equal(editor.confirm(ack, orgId, payload).version, 8);
});

test('ACK verifies every business and immutable file metadata value and own-presence', () => {
  const item = caseItem(), editor = editorFor(item), payload = { note: '新值' }, ack = saved(item, payload);
  for (const key of ['title', 'category', 'note', 'status', 'fileName', 'mimeType', 'sizeBytes', 'sha256']) {
    unconfirmed(() => editor.confirm({ ...ack, [key]: 'unexpected' }, orgId, payload));
    const missing = { ...ack }; delete missing[key]; unconfirmed(() => editor.confirm(missing, orgId, payload));
  }
  unconfirmed(() => editor.confirm({ ...ack, fileId: 'must-not-be-public' }, orgId, payload));
  for (const key of ['version', 'caseId', 'fileId', 'fileName']) unconfirmed(() => editor.confirm(ack, orgId, { ...payload, [key]: 'unexpected' }));
});

test('certificate ACK independently binds certificate/derived employee and retains absent note or file metadata', () => {
  const item = certItem(); delete item.note; delete item.sha256;
  const editor = editorFor(item), payload = { title: '證照新標題' }, ack = saved(item, payload);
  assert(!Object.hasOwn(editor.confirm(ack, orgId, payload), 'note')); assert(!Object.hasOwn(editor.confirm(ack, orgId, payload), 'sha256'));
  for (const patch of [{ certificationId: 'other-cert' }, { employeeId: 'other-employee' }, { note: '' }, { sha256: 'new' }]) unconfirmed(() => editor.confirm({ ...ack, ...patch }, orgId, payload));
  const missing = { ...ack }; delete missing.employeeId; unconfirmed(() => editor.confirm(missing, orgId, payload));
  assert.throws(() => createAttachmentMetadataEditor({ entity: 'certification-attachments', existing: item, parentId: item.certificationId, employeeId: 'other' }));
});

test('private original clones survive caller mutations and opaque equality accepts key reorder only', () => {
  const item = { ...caseItem(), note: { a: [1, false, null], b: { nested: 'private' } } }, editor = editorFor(item);
  const original = structuredClone(item); item.note.b.nested = 'changed-after-open'; editor.initial.noteIntent = 'replace';
  const payload = { category: 'care' }, ack = saved(original, payload); ack.note = { b: { nested: 'private' }, a: [1, false, null] };
  assert.deepEqual(editor.confirm(ack, orgId, payload).note.a, [1, false, null]);
  unconfirmed(() => editor.confirm({ ...ack, note: { a: [1, false, null], b: { nested: 'changed' } } }, orgId, payload));
  assert.deepEqual(editor.buildPayload({ category: 'care' }), payload);
});

test('maximum saved version cannot trigger unsafe next-version writes; no-op remains safe', () => {
  const editor = editorFor({ ...caseItem(), version: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(editor.buildPayload(editor.initial), {});
  assert.throws(() => editor.buildPayload({ ...editor.initial, note: 'changed' })); assert.throws(() => editor.buildStatusChange('inactive'));
});

test('safe list accepts malformed business JSON for explicit editing and legitimate out-of-range empty pages', () => {
  const item = { ...caseItem(), title: { private: true }, category: null, status: { hidden: true } }; delete item.note;
  const confirmed = confirmAttachmentMetadataList(list([item]), requested()); assert.deepEqual(confirmed.items[0].title, item.title);
  assert.equal(confirmAttachmentMetadataList(list([], { total: 1, page: 3 }), requested({ page: 3 })).total, 1);
  const many = Array.from({ length: 25 }, (_, index) => ({ ...caseItem(), id: 'synthetic-' + index }));
  assert.equal(confirmAttachmentMetadataList(list(many, { total: 28 }), requested()).items.length, 25);
});

test('list rejects wrong envelope/page/count/duplicate identity and wrong parent-org-version before any card', () => {
  const item = caseItem();
  for (const broken of [list([item], { extra: true }), list([item], { total: 2 }), list([item], { page: 2 }), list([item], { pageSize: 100 }), list([item], { total: -1 }), list([item, item]), list([{ ...item, id: '' }]), list([{ ...item, orgId: 'foreign' }]), list([{ ...item, caseId: 'foreign' }]), list([{ ...item, version: 0 }]), list([{ ...item, version: 1.5 }])])
    assert.throws(() => confirmAttachmentMetadataList(broken, requested()), /附件清單回應無法確認/);
  for (const key of ['id', 'orgId', 'caseId', 'version']) { const missing = { ...item }; delete missing[key]; assert.throws(() => confirmAttachmentMetadataList(list([missing]), requested())); }
});

test('known list filters are exact; certificate list binds employee and has no category filter', () => {
  const item = caseItem(); assert.equal(confirmAttachmentMetadataList(list([item]), requested({ category: 'general', status: 'active' })).total, 1);
  for (const extra of [{ category: 'care' }, { status: 'inactive' }, { category: 'mystery' }, { status: 'mystery' }]) assert.throws(() => confirmAttachmentMetadataList(list([item]), requested(extra)));
  const cert = certItem(), query = requested({ entity: 'certification-attachments', parentId: cert.certificationId, employeeId });
  assert.equal(confirmAttachmentMetadataList(list([cert]), query).items[0].employeeId, employeeId);
  assert.throws(() => confirmAttachmentMetadataList(list([{ ...cert, employeeId: 'other' }]), query));
  assert.throws(() => confirmAttachmentMetadataList(list([cert]), { ...query, category: 'general' }));
});

test('getter/nonenumerable/sparse/cyclic/non-JSON inputs are rejected without evaluating accessors', () => {
  let calls = 0; const getter = caseItem(); Object.defineProperty(getter, 'note', { get() { calls++; return 'secret'; }, enumerable: true });
  assert.throws(() => editorFor(getter)); assert.throws(() => confirmAttachmentMetadataList(list([getter]), requested()));
  const good = caseItem(), editor = editorFor(good), payload = { note: 'new' }, ack = saved(good, payload);
  Object.defineProperty(ack, 'title', { get() { calls++; return 'secret'; }, enumerable: true }); unconfirmed(() => editor.confirm(ack, orgId, payload));
  const values = { ...editor.initial }; Object.defineProperty(values, 'note', { get() { calls++; return 'secret'; }, enumerable: true }); assert.throws(() => editor.buildPayload(values)); assert.equal(editor.enabled('note', values), false);
  assert.equal(calls, 0);
  const nonenumerable = caseItem(); Object.defineProperty(nonenumerable, 'note', { value: 'private', enumerable: false }); assert.throws(() => editorFor(nonenumerable));
  const sparse = []; sparse.length = 1; assert.throws(() => confirmAttachmentMetadataList(list(sparse), requested()));
  const cycle = {}; cycle.self = cycle;
  for (const note of [cycle, NaN, Infinity, undefined, () => 'private', new Date()]) assert.throws(() => editorFor({ ...caseItem(), note }));
});

test('typed format never exposes nested values and identity guards primitives without colon collisions', () => {
  const hidden = { nested: 'never-display' };
  assert.equal(formatAttachmentMetadataText(hidden), '保存物件（內容未展示）');
  assert.equal(formatAttachmentMetadataText(false), '保存布林值（內容未展示）');
  assert.equal(formatAttachmentMetadataText(0), '保存數字（內容未展示）');
  assert.equal(formatAttachmentMetadataText(undefined, false), '未保存'); assert.equal(formatAttachmentMetadataText(''), '未提供');
  assert.equal(formatAttachmentMetadataText('原\r\n末句'), '原\r\n末句');
  assert.equal(formatAttachmentMetadataCategory(hidden), '分類未取得'); assert.equal(formatAttachmentMetadataStatus(hidden), '狀態未取得');
  const context = { user: { id: 'u:a', employeeId: 'e' }, organizationId: 'b', role: 'admin', organizations: [] };
  assert.equal(attachmentMetadataIdentity(context), attachmentMetadataIdentity({ ...context, user: { ...context.user }, organizations: [{}] }));
  assert.notEqual(attachmentMetadataIdentity(context), attachmentMetadataIdentity({ ...context, user: { ...context.user, id: 'u' }, organizationId: 'a:b' }));
  for (const changed of [{ ...context, role: 'finance' }, { ...context, organizationId: 'other' }, { ...context, user: { ...context.user, employeeId: 'other' } }, { ...context, user: { ...context.user, id: 'other' } }]) assert.notEqual(attachmentMetadataIdentity(context), attachmentMetadataIdentity(changed));
  assert.notEqual(attachmentMetadataIdentity({ user: { id: '' } }), attachmentMetadataIdentity({ user: { id: null } }));
});

test('MIME labels match only three own keys; inherited-looking saved strings remain literal text', () => {
  assert.equal(formatAttachmentMetadataMime('application/pdf'), 'PDF');
  assert.equal(formatAttachmentMetadataMime('image/png'), 'PNG');
  assert.equal(formatAttachmentMetadataMime('image/jpeg'), 'JPEG');
  for (const value of ['toString', 'constructor', '__proto__', 'hasOwnProperty', ' application/pdf ', 'application/x-synthetic'])
    assert.equal(formatAttachmentMetadataMime(value), value);
  assert.equal(formatAttachmentMetadataMime({ hidden: 'never-expand' }), '保存物件（內容未展示）');
  assert.equal(formatAttachmentMetadataMime(undefined, false), '未保存');
  assert.equal(formatAttachmentMetadataMime(null), '保存空值（內容未展示）');
});
