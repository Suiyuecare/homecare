import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initDb, insert, get } from '../src/server/model.mjs';
import { previewLocalImport, commitLocalImport } from '../src/server/local-imports.mjs';
import { confirmLocalImportCommit } from '../public/modules/local-imports.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); initDb(db); t.after(() => db.close());
  const orgId = randomUUID(), userId = randomUUID(), stamp = '2026-10-13T00:00:00.000Z';
  db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(orgId, '合成時點機構', stamp);
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(userId, '合成操作人', 'synthetic-time@example.invalid', '!no-login!', stamp);
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(orgId, userId, 'admin', null);
  return { db, orgId, ctx: { orgId, role: 'admin', user: { id: userId } } };
}
function advancingClock(t) {
  const OriginalDate = globalThis.Date;
  let time = OriginalDate.parse('2026-10-13T23:59:59.999Z');
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [time++])); }
    static now() { return time++; }
  };
  t.after(() => { globalThis.Date = OriginalDate; });
}

test('new record shares one creation instant across a millisecond and day rollover in returned, stored and version snapshots', t => {
  const f = fixture(t); advancingClock(t);
  const item = insert(f.db, f.orgId, 'cases', { name: '合成跨日個案', caseNo: 'TIME-001', status: 'active' });
  assert.equal(item.createdAt, '2026-10-13T23:59:59.999Z');
  assert.equal(item.updatedAt, item.createdAt);
  assert.deepEqual(get(f.db, f.orgId, 'cases', item.id), item);
  const stored = f.db.prepare('SELECT created_at,updated_at FROM records WHERE id=?').get(item.id);
  assert.equal(stored.created_at, item.createdAt); assert.equal(stored.updated_at, item.createdAt);
  const history = f.db.prepare('SELECT snapshot,created_at,source FROM record_versions WHERE record_id=?').get(item.id);
  assert.deepEqual(JSON.parse(history.snapshot), item); assert.equal(history.created_at, item.createdAt); assert.equal(history.source, 'create');
});

test('employee CSV import remains confirmable across clock ticks with exact history and no added account or grant', t => {
  const f = fixture(t), input = { entity: 'employees', csv: 'name,employeeNo,role\n合成一,0001,人工職務\n合成二,0002,人工職務', mapping: { name: 'name', employeeNo: 'employeeNo', role: 'role' } };
  const users = f.db.prepare('SELECT * FROM users ORDER BY id').all(), memberships = f.db.prepare('SELECT * FROM memberships ORDER BY user_id').all();
  const preview = previewLocalImport(f.db, f.ctx, input); advancingClock(t);
  f.db.exec('BEGIN IMMEDIATE');
  let ack;
  try { ack = commitLocalImport(f.db, f.ctx, { ...input, previewHash: preview.previewHash }); f.db.exec('COMMIT'); }
  catch (error) { f.db.exec('ROLLBACK'); throw error; }
  confirmLocalImportCommit(ack, preview, f.orgId, createHash('sha256').update(input.csv).digest('hex'));
  assert.equal(ack.importedCount, 2); assert.notEqual(ack.items[0].createdAt, ack.items[1].createdAt);
  for (const item of ack.items) {
    assert.equal(item.createdAt, item.updatedAt);
    assert.deepEqual(get(f.db, f.orgId, 'employees', item.id), item);
    assert.deepEqual(JSON.parse(f.db.prepare('SELECT snapshot FROM record_versions WHERE record_id=? AND version=1').get(item.id).snapshot), item);
  }
  assert.deepEqual(f.db.prepare('SELECT * FROM users ORDER BY id').all(), users);
  assert.deepEqual(f.db.prepare('SELECT * FROM memberships ORDER BY user_id').all(), memberships);
  assert.equal(f.db.prepare('SELECT count(*) n FROM audit').get().n, 3);
});
