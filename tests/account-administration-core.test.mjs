import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { confirmAccount, confirmAccountList, buildAccountChange, confirmAccountChange, confirmAccountHistory } from '../public/data/account-administration-core.js';
const orgId = randomUUID(), userId = randomUUID(), id = randomUUID(), scope = { orgId, userId, id }, time = '2026-10-11T04:05:06.007Z';
const row = () => ({ id, orgId, name: '合成帳號', email: 'synthetic-account@example.test', role: 'finance', employeeId: null, employeeName: null, employeeStatus: null,
  status: 'active', version: 0, updatedAt: null, portalBound: false, bindingActive: null, isSelf: false, canManage: true });
test('account acknowledgement confirms institution, identity, role, state and binding semantics', () => {
  assert.equal(confirmAccount(row(), scope).id, id);
  for (const change of [{ id: randomUUID() }, { orgId: randomUUID() }, { role: 'owner' }, { version: 1 }, { version: 0, updatedAt: time }, { version: 2 }, { portalBound: false, bindingActive: true }, { isSelf: true }, { canManage: false }, { employeeName: '錯誤連結' }, { status: 'deleted' }])
    assert.throws(() => confirmAccount({ ...row(), ...change }, scope));
});
test('account list rejects partial, duplicate, filtered wrong-role and cross-institution rows', () => {
  const request = { page: 1, pageSize: 25, role: 'finance', status: 'active' };
  const result = { orgId, items: [row()], total: 1, page: 1, pageSize: 25 };
  assert.equal(confirmAccountList(result, scope, request), result);
  for (const changed of [{ orgId: randomUUID() }, { total: 2 }, { page: 2 }, { items: [{ ...row(), role: 'admin' }] }, { total: 2, items: [row(), row()] }])
    assert.throws(() => confirmAccountList({ ...result, ...changed }, scope, request));
});
test('change builder never supplies an implicit caregiver link or reason', () => {
  assert.deepEqual(buildAccountChange({ role: 'finance', employeeId: '', status: 'suspended', reason: '  合成停用原因  ' }, 0), { version: 0, role: 'finance', employeeId: null, status: 'suspended', reason: '合成停用原因' });
  assert.throws(() => buildAccountChange({ role: 'caregiver', employeeId: '', status: 'active', reason: '合成原因' }, 0), error => Boolean(error.fields?.employeeId));
  for (const reason of ['', '\n', '合成\n原因', 'x'.repeat(1001)]) assert.throws(() => buildAccountChange({ role: 'finance', employeeId: '', status: 'active', reason }, 0));
});
test('saved change requires exact next version and submitted authority, with verified session revoke count', () => {
  const payload = { version: 0, role: 'supervisor', employeeId: null, status: 'suspended', reason: '合成改權限' };
  const ack = { item: { ...row(), ...payload, version: 2, updatedAt: time }, sessionsRevoked: 2 };
  assert.equal(confirmAccountChange(ack, scope, payload), ack);
  for (const change of [{ role: 'admin' }, { status: 'active' }, { version: 3 }, { employeeId: randomUUID() }]) assert.throws(() => confirmAccountChange({ ...ack, item: { ...ack.item, ...change } }, scope, payload));
  for (const value of [-1, '2', 0.5, undefined]) assert.throws(() => confirmAccountChange({ ...ack, sessionsRevoked: value }, scope, payload));
});
test('history validates complete contiguous versions, saved time, and baseline versus actual operator', () => {
  const snapshot = { userId: id, role: 'finance', employeeId: null, status: 'active', reason: '合成授權歷程', changedBy: userId, changedAt: time };
  const history = { orgId, id, total: 2, items: [{ version: 2, source: 'account.change', createdAt: time, snapshot }, { version: 1, source: 'account.baseline', createdAt: time, snapshot: { ...snapshot, changedBy: null } }] };
  assert.equal(confirmAccountHistory(history, scope), history);
  for (const mutate of [h => { h.items[0].version = 3; }, h => { h.items[0].snapshot.userId = randomUUID(); }, h => { h.items[0].snapshot.changedBy = null; }, h => { h.items[1].source = 'account.change'; }, h => { h.items[0].snapshot.changedAt = '2026-10-11T04:05:06.008Z'; }, h => { h.total = 3; }]) {
    const changed = structuredClone(history); mutate(changed); assert.throws(() => confirmAccountHistory(changed, scope));
  }
});
