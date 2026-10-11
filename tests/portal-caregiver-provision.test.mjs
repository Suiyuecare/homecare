import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, insert, now } from '../src/server/model.mjs';
import { PORTAL_ORIGIN, provisionPortalAccount } from '../src/server/portal-handoff.mjs';
import { parseProvisionArguments, runProvision } from '../scripts/provision-portal-account.mjs';

const account = (role = 'admin', change = {}) => ({ organizationName: '合成開通測試機構', name: '合成管理者', email: 'synthetic-' + role + '@example.invalid', issuer: PORTAL_ORIGIN, googleSubject: 'synthetic_provision_' + role, authUserId: randomUUID(), role, ...change });
const argumentsFor = (dbPath, input) => ['--db-path', dbPath, '--organization-name', input.organizationName, '--name', input.name, '--email', input.email, '--issuer', input.issuer, '--google-subject', input.googleSubject, '--portal-auth-user-id', input.authUserId, '--role', input.role, ...(input.employeeId ? ['--employee-id', input.employeeId] : [])];
const raw = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
const state = db => ({ tables: raw(db), changes: db.prepare('SELECT total_changes() AS n').get().n });
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); initDb(db);
  const initial = provisionPortalAccount(db, account()), employee = insert(db, initial.organizationId, 'employees', { name: '合成有效員工', employeeNo: 'PROVISION-E', status: 'active' });
  return { db, initial, employee };
}

test('Legacy explicit CLI flags stay exact and caregiver requires only its additional explicit employee flag', () => {
  const admin = account(); assert.deepEqual(parseProvisionArguments(argumentsFor('/tmp/synthetic-no-open.sqlite', admin)), { dbPath: '/tmp/synthetic-no-open.sqlite', ...admin });
  const caregiver = account('caregiver', { employeeId: randomUUID() }); assert.deepEqual(parseProvisionArguments(argumentsFor('/tmp/synthetic-no-open.sqlite', caregiver)), { dbPath: '/tmp/synthetic-no-open.sqlite', ...caregiver });
  // Preserve the historical semantic-error classification when the eight
  // original flags contain caregiver without its required employee argument.
  assert.equal(parseProvisionArguments(argumentsFor('/tmp/synthetic-no-open.sqlite', account('caregiver'))).role, 'caregiver');
  for (const invalid of [[...argumentsFor('/tmp/synthetic-no-open.sqlite', admin), '--employee-id', randomUUID()], [...argumentsFor('/tmp/synthetic-no-open.sqlite', admin), '--role', 'admin'], argumentsFor(':memory:', caregiver)]) assert.throws(() => parseProvisionArguments(invalid), /PORTAL_PROVISION_ARGUMENTS_INVALID/);
});

test('Caregiver explicit provisioning persists same-org active linkage and idempotent replay performs zero writes', t => {
  const { db, employee, initial } = fixture(t), input = account('caregiver', { employeeId: employee.id }), created = provisionPortalAccount(db, input);
  assert.equal(created.status, 'created'); assert.equal(created.role, 'caregiver'); assert.equal(created.organizationId, initial.organizationId);
  assert.equal(db.prepare('SELECT employee_id FROM memberships WHERE user_id=?').get(created.userId).employee_id, employee.id);
  const before = state(db), again = provisionPortalAccount(db, input); assert.deepEqual(again, { ...created, status: 'already-provisioned' }); assert.deepEqual(state(db), before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n, 13);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger'").get().n, 6);
});

test('Missing, inactive, wrong entity and foreign employee identities never provision a caregiver account', t => {
  const { db, initial } = fixture(t), inactive = insert(db, initial.organizationId, 'employees', { name: '合成停用員工', employeeNo: 'PROVISION-INACTIVE', status: 'inactive' });
  const wrongEntity = insert(db, initial.organizationId, 'cases', { name: '合成個案', caseNo: 'NOT-EMPLOYEE', status: 'active' });
  for (const change of [{}, { employeeId: '' }, { employeeId: randomUUID() }, { employeeId: inactive.id }, { employeeId: wrongEntity.id }]) {
    const before = state(db); assert.throws(() => provisionPortalAccount(db, account('caregiver', change)), error => error.code === 'PORTAL_PROVISION_INVALID'); assert.deepEqual(state(db), before);
  }
  const foreign = randomUUID(); db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(foreign, '合成其他機構', now()); const otherEmployee = insert(db, foreign, 'employees', { name: '合成他機構員工', employeeNo: 'FOREIGN-E', status: 'active' });
  const before = state(db); assert.throws(() => provisionPortalAccount(db, account('caregiver', { employeeId: otherEmployee.id })), error => error.code === 'PORTAL_PROVISION_CONFLICT'); assert.deepEqual(state(db), before);
});

test('Existing caregiver identity cannot silently be rebound to another employee, role or email', t => {
  const { db, employee, initial } = fixture(t), second = insert(db, initial.organizationId, 'employees', { name: '合成另一員工', employeeNo: 'OTHER-E', status: 'active' }), input = account('caregiver', { employeeId: employee.id }); provisionPortalAccount(db, input);
  for (const change of [{ employeeId: second.id }, { role: 'admin', employeeId: undefined }, { email: 'other@example.invalid' }, { authUserId: randomUUID() }]) {
    const next = { ...input, ...change }; if (next.employeeId === undefined) delete next.employeeId;
    const before = state(db); assert.throws(() => provisionPortalAccount(db, next), error => error.code === 'PORTAL_PROVISION_CONFLICT'); assert.deepEqual(state(db), before);
  }
});

test('Caregiver CLI opens only supplied synthetic disk database and returns no private provider identity', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'homecare-account-cli-synthetic-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.sqlite'), db = new DatabaseSync(file); initDb(db); const initial = provisionPortalAccount(db, account()), employee = insert(db, initial.organizationId, 'employees', { name: '合成磁碟員工', employeeNo: 'DISK-E', status: 'active' }); db.close();
  const input = account('caregiver', { employeeId: employee.id }), result = runProvision(argumentsFor(file, input)); assert.equal(result.status, 'created');
  for (const privateValue of [input.email, input.googleSubject, input.authUserId]) assert(!JSON.stringify(result).includes(privateValue));
  assert.equal(runProvision(argumentsFor(file, input)).status, 'already-provisioned');
});
