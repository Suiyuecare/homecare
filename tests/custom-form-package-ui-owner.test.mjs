import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { downloadCustomFormPackageText, setContext } = await import('../public/ui.js');
test('Template text delivery rejects cancelled/inactive context and invalid/empty/oversize content before touching DOM or creating URL', () => {
  let allocations = 0; const original = URL.createObjectURL; URL.createObjectURL = () => { allocations++; return 'blob:synthetic'; };
  try {
    const cancelled = new AbortController(); cancelled.abort(); assert.throws(() => downloadCustomFormPackageText('{}', { signal: cancelled.signal }), error => error.name === 'AbortError');
    assert.throws(() => downloadCustomFormPackageText('{}', { isCurrent: () => false }), error => error.name === 'AbortError');
    for (const value of ['', {}, '合'.repeat(4 * 1024 * 1024)]) assert.throws(() => downloadCustomFormPackageText(value)); assert.equal(allocations, 0);
  } finally { URL.createObjectURL = original; }
});
test('Template file delivery uses native anchor, exact UTF8 JSON MIME, safe filename and always revokes the local URL', () => {
  const originals = { document: globalThis.document, Node: globalThis.Node, create: URL.createObjectURL, revoke: URL.revokeObjectURL, timer: globalThis.setTimeout };
  const events = [], attributes = {}; let received;
  class FakeNode { constructor(tag) { this.tag = tag; } setAttribute(key, value) { attributes[key] = value; } append() {} click() { events.push('click'); } remove() { events.push('remove'); } }
  try {
    globalThis.Node = FakeNode; globalThis.document = { createElement: tag => new FakeNode(tag), body: { append: node => { assert.equal(node.tag, 'a'); events.push('append'); } } };
    URL.createObjectURL = blob => { received = blob; events.push('allocate'); return 'blob:synthetic-package'; }; URL.revokeObjectURL = url => { assert.equal(url, 'blob:synthetic-package'); events.push('revoke'); };
    globalThis.setTimeout = fn => { fn(); return 1; };
    const content = '{"合成":"😀"}'; downloadCustomFormPackageText(content, { filename: '../合成\\模板\n.json' });
    assert.equal(received.type, 'application/json;charset=utf-8'); assert.equal(received.size, new TextEncoder().encode(content).byteLength);
    assert.equal(attributes.href, 'blob:synthetic-package'); assert.equal(attributes.download, '.._合成_模板_.json'); assert.deepEqual(events, ['allocate', 'append', 'click', 'remove', 'revoke']);
  } finally {
    globalThis.document = originals.document; globalThis.Node = originals.Node; URL.createObjectURL = originals.create; URL.revokeObjectURL = originals.revoke; globalThis.setTimeout = originals.timer;
  }
});
test('Canonical download guard rejects a context change that occurs while creating local URL, and revokes without starting download', () => {
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, timer = globalThis.setTimeout; let revocations = 0;
  try {
    setContext({ user: { id: 'synthetic-old' }, organizations: [{ id: 'synthetic-org', role: 'supervisor' }] }, 'synthetic-org');
    URL.createObjectURL = () => { setContext({ user: { id: 'synthetic-new' }, organizations: [{ id: 'synthetic-org', role: 'supervisor' }] }, 'synthetic-org'); return 'blob:synthetic'; };
    URL.revokeObjectURL = () => revocations++; globalThis.setTimeout = fn => { fn(); return 1; };
    assert.throws(() => downloadCustomFormPackageText('{}'), error => error.name === 'AbortError'); assert.equal(revocations, 1);
  } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; globalThis.setTimeout = timer; }
});
