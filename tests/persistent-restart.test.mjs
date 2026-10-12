import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { filePayload } from './attachment-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const encode = value => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? { sqliteInteger: String(v) } : v);
function snapshot(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const tables = schema.filter(item => item.type === 'table');
    assert.equal(tables.length, 11);
    assert.equal(schema.filter(item => item.type === 'trigger').length, 6);
    const data = tables.map(({ name }) => {
      const statement = db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid');
      statement.setReadBigInts(true);
      return [name, statement.all()];
    });
    return encode({ schema, data });
  } finally { db.close(); }
}
async function start(directory) {
  // Only the directory created by this test is passed to a fresh native process.
  // No inherited Portal/environment file, operator DB path, or real port is used.
  const child = spawn(process.execPath, [path.join(root, 'src/server/index.mjs')], {
    cwd: root, env: { PATH: process.env.PATH, PORT: '0', DATA_DIR: directory,
      HOME_CARE_REQUIRE_PERSISTENT_STORAGE: '1', HOME_CARE_STORAGE_DURABILITY: 'persistent' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Synthetic native startup timed out')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); reject(new Error('Synthetic native startup exited ' + code + ': ' + stderr)); });
    child.stdout.on('data', bytes => {
      output += bytes.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/u);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  return { base, async stop() {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { assert.deepEqual(await closed, { code: 0, signal: null }); }
    finally { clearTimeout(timer); }
  } };
}

test('native process restart retains all eleven synthetic tables, attachment BLOB, history, session and retry receipt', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'homecare-owned-native-restart-'));
  const filename = path.join(directory, 'care.sqlite');
  let running;
  try {
    running = await start(directory);
    const setup = await fetch(running.base + '/api/setup', { method: 'POST', headers: { Origin: running.base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '合成重啟管理者', email: 'native-restart@example.test', password: 'synthetic-native-restart-password', organizationName: '合成持久測試機構', seedDemo: true }) });
    assert.equal(setup.status, 201);
    const session = await setup.json(), orgId = session.organizations[0].id;
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const headers = () => ({ Origin: running.base, Cookie: cookie, 'Content-Type': 'application/json', 'X-Org-Id': orgId, 'X-CSRF-Token': session.csrfToken });
    const cases = await fetch(running.base + '/api/cases', { headers: headers() });
    assert.equal(cases.status, 200);
    const caseId = (await cases.json()).items[0].id;
    const payload = { caseId, title: '合成重啟附件', category: 'general', note: '保留原文與版本\r\n尾端', ...filePayload() };
    const uploadHeaders = () => ({ ...headers(), 'Idempotency-Key': 'synthetic-native-restart-file' });
    const uploaded = await fetch(running.base + '/api/case-attachments/upload', { method: 'POST', headers: uploadHeaders(), body: JSON.stringify(payload) });
    assert.equal(uploaded.status, 201);
    const receipt = await uploaded.json();
    await running.stop(); running = null;
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const before = snapshot(filename);

    running = await start(directory);
    const ready = await fetch(running.base + '/ready');
    assert.equal(ready.status, 200); assert.equal((await ready.json()).ok, true);
    const currentSession = await fetch(running.base + '/api/session', { headers: headers() });
    assert.deepEqual(await currentSession.json(), session);
    const current = await fetch(running.base + '/api/case-attachments/' + receipt.item.id, { headers: headers() });
    assert.equal(current.status, 200); assert.deepEqual(await current.json(), receipt);
    const history = await fetch(running.base + '/api/case-attachments/' + receipt.item.id + '/history?compare=previous', { headers: headers() });
    assert.equal(history.status, 200); assert.equal((await history.json()).items.length, 1);
    const duplicate = await fetch(running.base + '/api/case-attachments/upload', { method: 'POST', headers: uploadHeaders(), body: JSON.stringify(payload) });
    assert.equal(duplicate.status, 201); assert.deepEqual(await duplicate.json(), receipt);
    await running.stop(); running = null;
    assert.equal(snapshot(filename), before, 'Reopen, observational probes and same-key retry must preserve every synthetic row and BLOB');
  } finally {
    if (running) await running.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
