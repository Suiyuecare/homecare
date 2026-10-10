import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnnouncementEditor } from '../public/data/announcement-editor.js';
const fields = ['title', 'body', 'audience', 'status'];
const row = changes => ({ id: 'synthetic-id', orgId: 'synthetic-org', version: 4, title: '  合成標題  ', body: '合成\n原文', audience: 'all', status: 'published', ...changes });
const create = existing => createAnnouncementEditor({ existing });
const values = (editor, changes = {}) => ({ ...editor.initial, ...changes });
const next = (existing, patch = {}) => ({ ...existing, ...patch, version: existing.version + 1 });
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function fieldError(fn, field) { assert.throws(fn, error => !!error.fields && Object.hasOwn(error.fields, field)); }
function unconfirmed(fn) { assert.throws(fn, error => error.code === 'SAVE_UNCONFIRMED' && error.message.includes('未確認')); }

test('create defaults use four native controls and send exact untrimmed Unicode and newline text', () => {
  const editor = create();
  assert.deepEqual(editor.initial, { title: '', body: '', audience: 'all', status: 'draft' });
  assert.deepEqual(editor.fields.map(f => [f.name, f.type]), [['title', 'text'], ['body', 'textarea'], ['audience', 'select'], ['status', 'select']]);
  assert.ok(editor.fields.every(f => f.required && !f.disabled));
  assert.ok(fields.every(name => editor.enabled(name, editor.initial) && !editor.needsIntent(name)));
  assert.deepEqual(editor.fields.find(f => f.name === 'audience').options.map(o => o.value), ['all', 'caregiver', 'supervisor', 'finance', 'admin']);
  const payload = editor.buildPayload(values(editor, { title: '  歲悅🙂\t ', body: '\n 合成\n<&>\n', status: 'published' }));
  assert.deepEqual(payload, { title: '  歲悅🙂\t ', body: '\n 合成\n<&>\n', audience: 'all', status: 'published' });
});

test('normal edit omits unchanged or reverted fields and never spreads record metadata', () => {
  const saved = freeze(row({ extra: { secret: true }, fileId: 'PRIVATE', billingSnapshot: { amount: 999 } })), editor = create(saved);
  assert.deepEqual(editor.buildPayload(values(editor)), {});
  assert.deepEqual(editor.buildPayload({ body: '  只改內文  ' }), { body: '  只改內文  ' });
  const reverted = values(editor); reverted.title = 'different'; reverted.title = saved.title;
  assert.deepEqual(editor.buildPayload(reverted), {});
  assert.ok(!JSON.stringify(editor.fields).includes('PRIVATE')); assert.deepEqual(Object.keys(editor.initial), fields);
  fieldError(() => editor.buildPayload({ ...editor.initial, version: 4 }), 'version');
});

test('unsafe own, missing and nontext values stay out of all control descriptors and default to keep', () => {
  const examples = [row({ title: 'PRIVATE\nTITLE', body: 'PRIVATE\r\nBODY', audience: 'PRIVATE-UNKNOWN', status: 'PRIVATE-STATE' }), row({ title: 0, body: false, audience: null, status: ['published'] }), row({ title: ['PRIVATE'], body: { nested: 'PRIVATE' }, audience: { nested: 'PRIVATE' }, status: null }), { id: 'synthetic-id', orgId: 'synthetic-org', version: 1 }];
  for (const saved of examples) {
    const editor = create(freeze(saved));
    for (const name of fields) {
      assert.equal(editor.needsIntent(name), true); assert.equal(editor.initial[name], ''); assert.equal(editor.initial[name + 'Intent'], 'keep');
      assert.equal(editor.enabled(name, editor.initial), false); assert.equal(editor.enabled(name, values(editor, { [name + 'Intent']: 'replace' })), true);
      const descriptor = editor.fields.find(f => f.name === name); assert.equal(descriptor.required, false); assert.equal(descriptor.disabled, true);
    }
    assert.equal(editor.fields.length, 8); assert.ok(!JSON.stringify({ initial: editor.initial, fields: editor.fields }).includes('PRIVATE'));
    assert.deepEqual(editor.buildPayload(editor.initial), {});
  }
});

test('keep and clear ignore disabled input without coercion, while intent changes must be explicit and valid', () => {
  const editor = create(row({ title: 'A\nB', body: 'A\rB', audience: '__proto__', status: 'unknown' }));
  assert.deepEqual(editor.buildPayload(values(editor, { title: { ignored: 'hidden' }, body: false, audience: ['all'], status: 'published' })), {});
  assert.deepEqual(editor.buildPayload(values(editor, { audienceIntent: 'clear', audience: { ignored: true } })), { audience: '' });
  assert.equal(editor.enabled('audience', values(editor, { audienceIntent: 'clear' })), false);
  for (const name of fields) for (const bad of ['', null, false, 'delete', 'replaceAll']) fieldError(() => editor.buildPayload(values(editor, { [name + 'Intent']: bad })), name + 'Intent');
  for (const name of ['title', 'body', 'status']) fieldError(() => editor.buildPayload(values(editor, { [name + 'Intent']: 'clear' })), name + 'Intent');
});

test('replacement validates strings, native representability, required fields and exact API length limits', () => {
  const editor = create(row({ title: 0, body: false, audience: null, status: null }));
  for (const name of fields) for (const bad of [undefined, null, false, 0, [], {}]) fieldError(() => editor.buildPayload(values(editor, { [name + 'Intent']: 'replace', [name]: bad })), name);
  for (const [name, bad] of [['title', ''], ['body', ''], ['title', 'A\nB'], ['title', 'A\rB'], ['body', 'A\r\nB'], ['audience', '__proto__'], ['audience', ''], ['status', 'sent'], ['title', 'x'.repeat(501)], ['body', 'x'.repeat(10001)]]) fieldError(() => editor.buildPayload(values(editor, { [name + 'Intent']: 'replace', [name]: bad })), name);
  assert.deepEqual(editor.buildPayload(values(editor, { titleIntent: 'replace', title: ' '.repeat(500), bodyIntent: 'replace', body: 'x'.repeat(10000), audienceIntent: 'replace', audience: 'caregiver', statusIntent: 'replace', status: 'draft' })), { title: ' '.repeat(500), body: 'x'.repeat(10000), audience: 'caregiver', status: 'draft' });
});

test('missing and empty saved fields remain omitted so the original merged API validation owns keep failures', () => {
  const saved = { id: 'synthetic-id', orgId: 'synthetic-org', version: 1, title: '', body: [], status: null }, editor = create(saved);
  assert.equal(editor.needsIntent('title'), false); assert.equal(editor.needsIntent('audience'), true);
  assert.deepEqual(editor.buildPayload(editor.initial), {});
  assert.deepEqual(editor.buildPayload(values(editor, { audienceIntent: 'clear' })), { audience: '' });
  const emptyAudience = create(row({ audience: '' })); assert.deepEqual(emptyAudience.buildPayload(values(emptyAudience, { audienceIntent: 'clear' })), {});
  const original = row({ title: 'x'.repeat(501), body: 'x'.repeat(10001) }), legacy = create(original);
  assert.deepEqual(legacy.buildPayload(legacy.initial), {}, 'preservation must not revalidate unchanged imported lengths');
});

test('unknown values and form keys are rejected without prototype pollution or descriptor mutation influence', () => {
  const editor = create(row());
  for (const input of [null, [], 'x', false]) fieldError(() => editor.buildPayload(input), 'title');
  for (const key of ['id', 'orgId', 'billingSnapshot', 'titleIntent', 'q001']) fieldError(() => editor.buildPayload({ [key]: 'injected' }), key);
  fieldError(() => editor.buildPayload(JSON.parse('{"__proto__":{"polluted":true}}')), '__proto__');
  editor.fields.find(f => f.name === 'status').options.push({ value: 'sent', label: '注入' });
  fieldError(() => editor.buildPayload({ status: 'sent' }), 'status'); assert.equal({}.polluted, undefined);
  assert.equal(editor.enabled('unknown', {}), false);
});

test('JSON snapshots are copied without mutating frozen inputs or losing special own keys', () => {
  const saved = freeze(row({ title: JSON.parse('{"__proto__":{"secret":"PRIVATE"},"constructor":[0,false],"prototype":null}'), body: ['PRIVATE', 0, false] })), before = structuredClone(saved), editor = create(saved);
  const payload = editor.buildPayload(values(editor, { audience: 'finance' })); assert.deepEqual(payload, { audience: 'finance' });
  const response = next(before, payload); assert.equal(editor.confirm(response, saved.orgId, payload), response);
  assert.deepEqual(saved, before); assert.ok(!JSON.stringify(editor.fields).includes('PRIVATE')); assert.equal({}.secret, undefined);
  for (const bad of [NaN, Infinity, undefined, () => {}]) fieldError(() => create(row({ title: bad })), 'title');
  const cycle = {}; cycle.self = cycle; fieldError(() => create(row({ body: cycle })), 'title');
});

test('create confirmation requires a plain item with own identity, org, version1 and all four exact fields', () => {
  const editor = create(), payload = editor.buildPayload(values(editor, { title: '合成', body: '\n' }));
  const good = { id: 'new-id', orgId: 'synthetic-org', version: 1, ...payload };
  assert.equal(editor.confirm(good, good.orgId, payload), good);
  for (const bad of [null, [], 'x', { ...good, id: '' }, { ...good, id: ' ' }, { ...good, orgId: 'other' }, { ...good, version: '1' }, { ...good, version: 2 }, { ...good, body: '' }, { ...good, title: ['合成'] }, Object.create(good)]) unconfirmed(() => editor.confirm(bad, good.orgId, payload));
  for (const name of ['id', 'orgId', 'version', ...fields]) { const bad = { ...good }; delete bad[name]; unconfirmed(() => editor.confirm(bad, good.orgId, payload)); }
  unconfirmed(() => editor.confirm(good, '', payload)); unconfirmed(() => editor.confirm(good, good.orgId, { title: '合成' }));
});

test('edit confirmation checks expected CAS version, id, org and exact presence of every unchanged saved value', () => {
  const saved = row({ title: 0, body: false, audience: null }), editor = create(saved), payload = { status: 'draft' }, good = next(saved, payload);
  assert.equal(editor.confirm(good, saved.orgId, payload), good);
  for (const patch of [{ id: 'other' }, { orgId: 'other' }, { version: saved.version }, { version: saved.version + 2 }, { version: String(saved.version + 1) }, { title: '0' }, { body: 'false' }, { audience: '' }]) unconfirmed(() => editor.confirm({ ...good, ...patch }, saved.orgId, payload));
  const missing = { ...good }; delete missing.audience; unconfirmed(() => editor.confirm(missing, saved.orgId, payload));
  const absentSaved = row(); delete absentSaved.audience; const absentEditor = create(absentSaved), absentGood = next(absentSaved, payload);
  assert.equal(absentEditor.confirm(absentGood, absentSaved.orgId, payload), absentGood); unconfirmed(() => absentEditor.confirm({ ...absentGood, audience: null }, absentSaved.orgId, payload));
  unconfirmed(() => editor.confirm(good, saved.orgId, { ...payload, unexpected: true })); unconfirmed(() => editor.confirm(good, saved.orgId, { ...payload, version: saved.version - 1 }));
  assert.equal(editor.confirm(good, saved.orgId, { ...payload, version: saved.version }), good);
});

test('external mutations cannot silently update a captured source projection or identity', () => {
  const saved = row({ title: { nested: ['original'] } }), editor = create(saved), captured = structuredClone(saved);
  saved.title.nested[0] = 'changed'; saved.id = 'changed-id'; saved.version = 99; saved.orgId = 'changed-org';
  const good = next(captured, { body: 'edited' }); assert.equal(editor.confirm(good, captured.orgId, { body: 'edited' }), good);
  unconfirmed(() => editor.confirm(next(saved, { body: 'edited' }), saved.orgId, { body: 'edited' }));
});

test('no-op and withdrawal confirmations preserve all four saved fields without implying server rollback or publication delivery', () => {
  const saved = row({ audience: '未知但合法的字串' }), editor = create(saved);
  assert.deepEqual(editor.buildPayload(editor.initial), {});
  assert.equal(editor.confirm(next(saved), saved.orgId, {}).version, 5);
  assert.equal(editor.confirm(next(saved, { status: 'draft' }), saved.orgId, { status: 'draft' }).status, 'draft');
  unconfirmed(() => editor.confirm(next(saved, { status: 'published' }), saved.orgId, { status: 'draft' }));
  for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, '4']) { const bad = row({ version }); unconfirmed(() => create(bad).confirm({ ...bad, version: 5 }, bad.orgId, {})); }
});
