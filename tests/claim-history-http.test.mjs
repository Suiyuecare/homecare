import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';

test('claim history ignores unsafe SQL versions and malformed snapshots without changing storage', async t => {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close());
  const setup = await fetch(base + '/api/setup', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '合成核銷驗收', organizationName: '合成歷程機構', email: 'claim-history@example.test', password: 'synthetic-claim-history-password' }) });
  assert.equal(setup.status, 201); const session = await setup.json(), orgId = session.organizations[0].id;
  const headers = { Origin: base, 'Content-Type': 'application/json', Cookie: setup.headers.get('set-cookie').split(';')[0], 'X-Org-Id': orgId, 'X-CSRF-Token': session.csrfToken };
  const create = async (entity, data) => { const response = await fetch(base + '/api/' + entity, { method: 'POST', headers, body: JSON.stringify(data) }); assert.equal(response.status, 201, await response.clone().text()); return (await response.json()).item; };
  const c = await create('cases', { name: '合成個案', caseNo: 'HIST-C' });
  let bill = await create('billing-documents', { caseId: c.id, month: '2026-10', number: 'HIST-B', lineItems: [{ label: '合成來源', quantity: 1, unitPriceCents: 101 }] });
  const issued = await fetch(base + '/api/billing-documents/' + bill.id, { method: 'PATCH', headers, body: JSON.stringify({ version: bill.version, status: 'issued', sourceReference: '合成人工核定' }) });
  assert.equal(issued.status, 200); bill = (await issued.json()).item;
  const item = await create('claim-batches', { month: '2026-10', number: 'HIST-CB', billingDocumentIds: [bill.id] });
  const insert = app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)');
  for (const [version, snapshot] of [[9007199254740993n, JSON.stringify(item)], [9007199254740992n, 'null'], [50, '{invalid'], [51, JSON.stringify({ ...item, version: 52 })], [0, JSON.stringify({ ...item, version: 0 })]]) insert.run(orgId, 'claim-batches', item.id, version, snapshot, item.updatedAt, 'synthetic-malformed-import');
  const all = app.db.prepare('SELECT * FROM record_versions ORDER BY entity,record_id,version'); all.setReadBigInts(true);
  const before = all.all(), changes = app.db.prepare('SELECT total_changes() changes').get();
  const response = await fetch(base + '/api/claim-batches/' + item.id + '/history?compare=previous', { headers });
  assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.total, 1); assert.equal(body.items[0].version, 1); assert.equal(body.items[0].snapshot.number, item.number);
  assert.deepEqual(all.all(), before); assert.deepEqual(app.db.prepare('SELECT total_changes() changes').get(), changes);
});
