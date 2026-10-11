import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';

test('new financial and health history hides unreadable imported versions while preserving valid versions and storage', async t => {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t.after(() => app.close());
  const setup = await fetch(base + '/api/setup', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '合成歷程驗收員', organizationName: '合成歷程機構', email: 'history-invalid@example.test', password: 'synthetic-history-invalid-password' }) }); assert.equal(setup.status, 201);
  const session = await setup.json(), orgId = session.organizations[0].id;
  const headers = { Origin: base, 'Content-Type': 'application/json', Cookie: setup.headers.get('set-cookie').split(';')[0], 'X-Org-Id': orgId, 'X-CSRF-Token': session.csrfToken };
  const create = async (entity, data) => { const r = await fetch(base + '/api/' + entity, { method: 'POST', headers, body: JSON.stringify(data) }); assert.equal(r.status, 201, await r.clone().text()); return (await r.json()).item; };
  const employee = await create('employees', { name: '合成人員', employeeNo: 'HIST-E' }), c = await create('cases', { name: '合成個案', caseNo: 'HIST-C' });
  let bill = await create('billing-documents', { caseId: c.id, month: '2026-10', number: 'HIST-B', lineItems: [{ label: '合成', quantity: 1, unitPriceCents: 100 }] });
  const issue = await fetch(base + '/api/billing-documents/' + bill.id, { method: 'PATCH', headers, body: JSON.stringify({ version: bill.version, status: 'issued', sourceReference: '合成核定' }) }); assert.equal(issue.status, 200); bill = (await issue.json()).item;
  const receipt = await create('payment-receipts', { billingDocumentId: bill.id, date: '2026-10-10', amountCents: 1, method: 'cash' });
  const payroll = await create('payroll-statements', { employeeId: employee.id, month: '2026-10', number: 'HIST-P', lineItems: [{ label: '合成', kind: 'earning', amountCents: 1 }] });
  const vax = await create('case-vaccinations', { caseId: c.id, date: '2026-10-10', vaccine: '合成' });
  for (const [entity, item] of [['billing-documents', bill], ['payment-receipts', receipt], ['payroll-statements', payroll], ['case-vaccinations', vax]]) {
    let version = 50;
    for (const encoded of ['null', '{invalid-json', '[]', '"SYNTHETIC-UNAPPROVED-HISTORY"', '0']) app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, entity, item.id, version++, encoded, item.updatedAt, 'synthetic-malformed-import');
    const count = app.db.prepare('SELECT total_changes() changes').get();
    const before = app.db.prepare('SELECT * FROM record_versions ORDER BY entity,record_id,version').all();
    const response = await fetch(base + '/api/' + entity + '/' + item.id + '/history?compare=previous', { headers }); assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.total, entity === 'billing-documents' ? 2 : 1); assert(body.items.every(row => row.version < 50)); assert(!JSON.stringify(body).includes('SYNTHETIC-UNAPPROVED-HISTORY'));
    assert.deepEqual(app.db.prepare('SELECT * FROM record_versions ORDER BY entity,record_id,version').all(), before); assert.deepEqual(app.db.prepare('SELECT total_changes() changes').get(), count);
  }
});
