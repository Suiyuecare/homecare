import assert from 'node:assert/strict';
import { createApp } from '../../src/server/index.mjs';
import { id } from '../../src/server/model.mjs';

// Memory DB, loopback ephemeral port and explicitly synthetic identities only.
export async function seriesMoveFixture(t, options = {}) {
  const app = createApp({ dbPath: ':memory:', port: 0 }), base = await app.listen(); t?.after(() => app.close());
  const request = async (client, method, route, payload, headers = {}) => {
    const response = await fetch(base + route, { method, headers: { Origin: base, ...(client ? { Cookie: client.cookie, 'X-Org-Id': client.org, 'X-CSRF-Token': client.csrf } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const password = 'synthetic-series-move-password', setup = await request(null, 'POST', '/api/setup', { name: '合成移日管理員', email: 'series-move-admin@example.test', password, organizationName: '合成移日甲機構' }); assert.equal(setup.status, 201);
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], org: setup.body.organizations[0].id, csrf: setup.body.csrfToken, user: setup.body.user }, clients = { admin }, ctx = { orgId: admin.org, role: 'admin', user: admin.user };
  const create = async (entity, data, actor = admin) => { const result = await request(actor, 'POST', '/api/' + entity, data); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.item; };
  const patch = async (entity, item, data, actor = admin) => { const result = await request(actor, 'PATCH', '/api/' + entity + '/' + item.id, { ...data, version: item.version }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.item; };
  const employee = await create('employees', { name: '合成原移日人員', employeeNo: 'MOVE-A' }), secondEmployee = await create('employees', { name: '合成第二移日人員', employeeNo: 'MOVE-B' }), caseItem = await create('cases', { name: '合成移日個案', caseNo: 'MOVE-C' }), service = await create('service-items', { code: 'MOVE-S', name: '合成移日服務', minutes: 60, unitPriceCents: 12345 }), services = [{ serviceItemId: service.id, quantity: 2 }];
  const plan = await create('care-plans', { caseId: caseItem.id, validFrom: '0001-01-01', validTo: '9999-12-31', status: 'active', services }), fromDate = options.fromDate || '2026-10-05', toDate = options.toDate || '2026-10-07';
  const series = await create('shift-series', { name: '合成完整整組移日', caseId: caseItem.id, employeeId: employee.id, carePlanId: plan.id, startDate: fromDate, endDate: '', intervalWeeks: 1, weekdays: [1, 2, 3, 4, 5, 6, 7], startTime: '09:00', endTime: '10:00', services, status: 'active', note: ' 原移日備註\r\n最後一句 ' });
  for (const role of options.roles === false ? [] : ['supervisor', 'caregiver', 'finance']) {
    const email = 'series-move-' + role + '@example.test'; await create('users', { name: '合成移日' + role, email, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const login = await request(null, 'POST', '/api/login', { email, password }); assert.equal(login.status, 200); clients[role] = { cookie: login.headers.get('set-cookie').split(';')[0], org: admin.org, csrf: login.body.csrfToken, user: login.body.user };
  }
  const range = { version: series.version, fromDate, toDate }, prefix = '/api/shift-series/' + series.id;
  const generate = async () => { const result = await request(admin, 'POST', prefix + '/generation/commit', range, { 'Idempotency-Key': id() }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.items.map(entry => entry.occurrence.shift); };
  const occurrences = async () => { const result = await request(admin, 'GET', prefix + '/occurrences?' + new URLSearchParams(range)); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  const payload = entries => ({ ...range, action: 'move', items: entries.filter(entry => entry.editable).map(entry => ({ id: entry.shiftId, version: entry.shift.version })), daysOffset: 1, reason: ' 原整組移日原因\n末行 ' });
  const move = (body, stage = 'preview', actor = admin, key = id(), query = '') => request(actor, 'POST', prefix + '/adjustments/' + stage + query, body, stage === 'commit' ? { 'Idempotency-Key': key } : {});
  const state = () => Object.fromEntries(['records', 'record_versions', 'audit', 'idempotency'].map(table => [table, (() => { const statement = app.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid'); statement.setReadBigInts(true); return statement.all(); })()]));
  const tx = callback => { app.db.exec('BEGIN IMMEDIATE'); try { const result = callback(); app.db.exec('COMMIT'); return result; } catch (error) { app.db.exec('ROLLBACK'); throw error; } };
  return { app, base, request, create, patch, admin, clients, ctx, password, employee, secondEmployee, caseItem, service, services, plan, series, range, prefix, generate, occurrences, payload, move, state, tx };
}
