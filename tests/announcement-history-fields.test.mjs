import test from 'node:test';
import assert from 'node:assert/strict';
import { getHistoryFields, normalizeHistorySnapshot, diffHistorySnapshots } from '../public/data/history-fields.js';

test('announcement history projects only four saved strings and excludes delivery, ownership and billing metadata', () => {
  const source = Object.freeze({ title: ' 合成公告 ', body: '\n第一行\n<script>literal</script>\n', audience: '__proto__', status: 'published',
    version: 4, fileId: 'hidden', billingSnapshot: { amount: 999 }, sentAt: 'unknown', readBy: ['private'], password: 'private' });
  assert.deepEqual(getHistoryFields('announcements').map(x => x.key), ['title', 'body', 'audience', 'status']);
  assert.deepEqual(normalizeHistorySnapshot('announcements', source), { title: source.title, body: source.body, audience: '__proto__', status: 'published' });
  assert.deepEqual(diffHistorySnapshots('announcements', source, { ...source, version: 5, sentAt: 'changed', readBy: [], billingSnapshot: {} }), []);
  for (const body of ['未提供', '非文字保存值；內容未展示。', '[欄位格式無法判讀]']) {
    assert.equal(normalizeHistorySnapshot('announcements', { body }).body, body);
    assert.equal(diffHistorySnapshots('announcements', {}, { body })[0].after, body);
  }
});

test('announcement history compares exact saved text including whitespace, line breaks and unknown audience without coercion', () => {
  const before = Object.freeze({ title: '合成公告', body: 'A\nB ', audience: 'all', status: 'draft' });
  const after = Object.freeze({ title: ' 合成公告', body: 'A B ', audience: '全體同仁', status: 'published' });
  const preserved = JSON.stringify([before, after]);
  assert.deepEqual(diffHistorySnapshots('announcements', before, after).map(({ key, before, after }) => ({ key, before, after })), [
    { key: 'title', before: before.title, after: after.title }, { key: 'body', before: before.body, after: after.body },
    { key: 'audience', before: 'all', after: '全體同仁' }, { key: 'status', before: 'draft', after: 'published' },
  ]);
  assert.equal(JSON.stringify([before, after]), preserved);
});

test('announcement unsupported imports use a detached tag distinct from legitimate literal placeholders without nested content', () => {
  const nested = Object.freeze({ private: 'nested-must-not-leak' });
  for (const body of [nested, [nested], false, true, 0, 1, NaN]) {
    const source = Object.freeze({ title: '合成', body, audience: 'constructor', status: 'published' });
    const view = normalizeHistorySnapshot('announcements', source);
    assert.deepEqual(view.body, { invalid: true }); assert.ok(Object.isFrozen(view.body));
    assert.equal(JSON.stringify(view).includes('nested-must-not-leak'), false);
    const changes = diffHistorySnapshots('announcements', source, { ...source, body: '[欄位格式無法判讀]' });
    assert.equal(changes.length, 1); assert.equal(changes[0].key, 'body');
    assert.deepEqual(changes[0].before, { invalid: true }); assert.equal(changes[0].after, '[欄位格式無法判讀]');
  }
});

test('announcement missing null and empty preserve common absence semantics; inherited entity names remain unsupported', () => {
  for (const a of [{}, { title: null, body: null, audience: null, status: null }, { title: '', body: '', audience: '', status: '' }]) {
    assert.deepEqual(normalizeHistorySnapshot('announcements', a), { title: null, body: null, audience: null, status: null });
    assert.deepEqual(diffHistorySnapshots('announcements', a, {}), []);
  }
  for (const value of ['__proto__', 'constructor', 'toString']) {
    assert.equal(normalizeHistorySnapshot('announcements', { audience: value }).audience, value);
    assert.throws(() => getHistoryFields(value), /不支援/);
  }
});
