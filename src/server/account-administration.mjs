import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { audit, decode, fail, now, saveVersion } from './model.mjs';

// Lifecycle state shares the existing records and immutable version store. It is
// deliberately absent from generic entity routes and never contains passwords,
// provider subjects, Auth UUIDs, signing keys or session tokens.
const ENTITY = 'account-lifecycle';
const ROLES = new Set(['admin', 'supervisor', 'caregiver', 'finance']);
const STATUS = new Set(['active', 'suspended']);
const STATE_KEYS = ['userId', 'role', 'employeeId', 'status', 'reason', 'changedBy', 'changedAt'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value, max = 1000) => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const canonicalTime = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const stateInvalid = () => fail(409, 'ACCOUNT_STATE_INVALID', '帳號保存狀態或版本無法確認，請由管理者核對');
const stateId = (orgId, userId) => createHash('sha256').update(JSON.stringify(['account-lifecycle-v1', orgId, userId])).digest('hex');
const stateData = item => Object.fromEntries(STATE_KEYS.map(key => [key, item[key]]));

function validateState(data, userId) {
  if (!exact(data, STATE_KEYS) || data.userId !== userId || !ROLES.has(data.role) || !STATUS.has(data.status)
      || (data.employeeId !== null && (typeof data.employeeId !== 'string' || !UUID.test(data.employeeId)))
      || !text(data.reason) || (data.changedBy !== null && (typeof data.changedBy !== 'string' || !UUID.test(data.changedBy)))
      || !canonicalTime(data.changedAt)) stateInvalid();
  return data;
}

function lifecycle(db, orgId, userId) {
  const row = db.prepare('SELECT * FROM records WHERE id=?').get(stateId(orgId, userId));
  if (!row) return null;
  if (row.org_id !== orgId || row.entity !== ENTITY || !Number.isSafeInteger(row.version) || row.version < 1
      || !canonicalTime(row.created_at) || !canonicalTime(row.updated_at)) stateInvalid();
  let item;
  try { item = decode(row); validateState(JSON.parse(row.data), userId); } catch (error) { if (error?.code === 'ACCOUNT_STATE_INVALID') throw error; stateInvalid(); }
  const head = db.prepare('SELECT * FROM record_versions WHERE record_id=? AND version=?').get(row.id, row.version);
  let snapshot;
  try { snapshot = JSON.parse(head?.snapshot); } catch { stateInvalid(); }
  if (!head || head.org_id !== orgId || head.entity !== ENTITY || head.created_at !== row.updated_at
      || !['account.baseline', 'account.change'].includes(head.source) || !isDeepStrictEqual(snapshot, item)) stateInvalid();
  const chain = db.prepare('SELECT version,source FROM record_versions WHERE record_id=? ORDER BY version').all(row.id);
  if (chain.length !== row.version || chain.some((version, index) => version.version !== index + 1 || version.source !== (index === 0 ? 'account.baseline' : 'account.change'))) stateInvalid();
  const member = db.prepare('SELECT role,employee_id FROM memberships WHERE org_id=? AND user_id=?').get(orgId, userId);
  if (!member || member.role !== item.role || member.employee_id !== item.employeeId) stateInvalid();
  return item;
}

/** A missing lifecycle record is the backwards-compatible active baseline. */
export function accountMembershipActive(db, orgId, userId) {
  return lifecycle(db, orgId, userId)?.status !== 'suspended';
}

export function guardAccountAdministration(db, ctx) {
  const current = db.prepare('SELECT role FROM memberships WHERE org_id=? AND user_id=?').get(ctx.orgId, ctx.user.id);
  if (ctx.role !== 'admin' || current?.role !== 'admin' || !accountMembershipActive(db, ctx.orgId, ctx.user.id)) fail(403, 'ROLE_FORBIDDEN', '僅本機構有效管理者可管理帳號');
}

function membership(db, ctx, userId) {
  if (typeof userId !== 'string' || !UUID.test(userId)) fail(404, 'NOT_FOUND', '找不到本機構帳號');
  const row = db.prepare('SELECT u.id,u.name,u.email,m.role,m.employee_id AS employeeId FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.org_id=? AND u.id=?').get(ctx.orgId, userId);
  if (!row) fail(404, 'NOT_FOUND', '找不到本機構帳號');
  if (!ROLES.has(row.role) || (row.employeeId !== null && (typeof row.employeeId !== 'string' || !UUID.test(row.employeeId)))) stateInvalid();
  return row;
}

function employee(db, orgId, employeeId) {
  if (!employeeId) return null;
  const raw = db.prepare("SELECT data FROM records WHERE org_id=? AND id=? AND entity='employees'").get(orgId, employeeId);
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw.data); } catch { return null; }
  return plain(data) ? { id: employeeId, name: typeof data.name === 'string' ? data.name : '', status: typeof data.status === 'string' ? data.status : 'unknown' } : null;
}

function projectAccount(db, ctx, row) {
  const state = lifecycle(db, ctx.orgId, row.id), linked = employee(db, ctx.orgId, row.employeeId);
  const hasPortal = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='portal_identity_bindings'").get();
  const binding = hasPortal ? db.prepare('SELECT active FROM portal_identity_bindings WHERE user_id=? AND org_id=?').get(row.id, ctx.orgId) : null;
  return {
    id: row.id, orgId: ctx.orgId, name: row.name, email: row.email, role: row.role, employeeId: row.employeeId || null,
    employeeName: linked?.name || null, employeeStatus: linked?.status || null,
    status: state?.status || 'active', version: state?.version || 0, updatedAt: state?.updatedAt || null,
    portalBound: Boolean(binding), bindingActive: binding ? binding.active === 1 : null, isSelf: row.id === ctx.user.id, canManage: row.id !== ctx.user.id,
  };
}

export function accountAdministrationQuery(params, { list = false } = {}) {
  const allowed = list ? ['page', 'pageSize', 'q', 'role', 'status'] : [];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) fail(422, 'INVALID_QUERY', '帳號查詢條件不合法');
  const page = Number(params.get('page') || 1), pageSize = Number(params.get('pageSize') || 25);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) fail(422, 'PAGINATION', 'page 須為正整數，pageSize 介於 1 至 100');
  const q = params.get('q') || '', role = params.get('role') || null, status = params.get('status') || null;
  if (q.length > 200 || /[\u0000-\u001f\u007f]/.test(q) || (role && !ROLES.has(role)) || (status && !STATUS.has(status))) fail(422, 'INVALID_QUERY', '帳號查詢條件不合法');
  return { page, pageSize, q: q.trim().toLocaleLowerCase('zh-TW'), role, status };
}

export function readAccounts(db, ctx, query) {
  guardAccountAdministration(db, ctx);
  let items = db.prepare('SELECT u.id,u.name,u.email,m.role,m.employee_id AS employeeId FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.org_id=? ORDER BY u.name,u.id').all(ctx.orgId).map(row => projectAccount(db, ctx, row));
  items = items.filter(item => (!query.q || [item.name, item.email, item.employeeName].some(value => typeof value === 'string' && value.toLocaleLowerCase('zh-TW').includes(query.q))) && (!query.role || item.role === query.role) && (!query.status || item.status === query.status));
  return { orgId: ctx.orgId, items: items.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: items.length, page: query.page, pageSize: query.pageSize };
}

export function readAccount(db, ctx, userId) {
  guardAccountAdministration(db, ctx);
  return { item: projectAccount(db, ctx, membership(db, ctx, userId)) };
}

export function readAccountHistory(db, ctx, userId) {
  guardAccountAdministration(db, ctx); membership(db, ctx, userId);
  const state = lifecycle(db, ctx.orgId, userId);
  if (!state) return { orgId: ctx.orgId, id: userId, items: [], total: 0 };
  const records = db.prepare('SELECT * FROM record_versions WHERE org_id=? AND entity=? AND record_id=? ORDER BY version DESC').all(ctx.orgId, ENTITY, state.id);
  if (records.length !== state.version) stateInvalid();
  const items = records.map((row, index) => {
    let snapshot;
    try { snapshot = JSON.parse(row.snapshot); validateState(stateData(snapshot), userId); } catch (error) { if (error?.code === 'ACCOUNT_STATE_INVALID') throw error; stateInvalid(); }
    if (!exact(snapshot, [...STATE_KEYS, 'id', 'orgId', 'version', 'createdAt', 'updatedAt']) || row.version !== state.version - index || snapshot.id !== state.id || snapshot.orgId !== ctx.orgId || snapshot.version !== row.version || !canonicalTime(snapshot.createdAt) || !canonicalTime(snapshot.updatedAt) || snapshot.updatedAt !== row.created_at || !['account.baseline', 'account.change'].includes(row.source)) stateInvalid();
    return { version: row.version, source: row.source, createdAt: row.created_at, snapshot: stateData(snapshot) };
  });
  return { orgId: ctx.orgId, id: userId, items, total: items.length };
}

export function validateAccountChange(payload) {
  if (!exact(payload, ['version', 'role', 'employeeId', 'status', 'reason']) || !Number.isSafeInteger(payload.version) || payload.version < 0 || !ROLES.has(payload.role) || !STATUS.has(payload.status)
      || (payload.employeeId !== null && (typeof payload.employeeId !== 'string' || !UUID.test(payload.employeeId))) || !text(payload.reason)) fail(422, 'ACCOUNT_CHANGE_INVALID', '請提供保存版本、角色、員工連結、帳號狀態及變更原因');
  if (payload.role === 'caregiver' && !payload.employeeId) fail(422, 'EMPLOYEE_LINK_REQUIRED', '居服員帳號必須指定同機構有效員工');
  return payload;
}

export function preflightAccountChange(db, ctx, userId, payload, { checkVersion = true } = {}) {
  guardAccountAdministration(db, ctx); validateAccountChange(payload);
  const current = membership(db, ctx, userId), state = lifecycle(db, ctx.orgId, userId);
  if (checkVersion && (state?.version || 0) !== payload.version) fail(409, 'VERSION_CONFLICT', '帳號已更新，請重新讀取後再操作');
  const preservingSuspendedLink = payload.status === 'suspended' && payload.employeeId === current.employeeId;
  if (payload.employeeId && !preservingSuspendedLink && employee(db, ctx.orgId, payload.employeeId)?.status !== 'active') fail(422, 'INVALID_REFERENCE', '啟用或重新連結時，員工必須屬於本機構且有效');
  if (current.role === 'admin' && (payload.role !== 'admin' || payload.status !== 'active')) {
    const others = db.prepare("SELECT user_id FROM memberships WHERE org_id=? AND role='admin' AND user_id<>?").all(ctx.orgId, userId);
    if (!others.some(row => accountMembershipActive(db, ctx.orgId, row.user_id))) fail(409, 'LAST_ADMIN_REQUIRED', '機構至少須保留一位有效管理者');
  }
  if (userId === ctx.user.id && (payload.role !== current.role || payload.status !== 'active' || payload.employeeId !== current.employeeId)) fail(409, 'SELF_ACCOUNT_CHANGE_FORBIDDEN', '請由另一位管理者變更您的權限、員工連結或停用狀態');
  if (current.role === payload.role && (current.employeeId || null) === payload.employeeId && (state?.status || 'active') === payload.status) fail(409, 'ACCOUNT_CHANGE_EMPTY', '帳號權限、連結及狀態沒有變更');
  return { current, state };
}

/** Caller holds BEGIN IMMEDIATE, covering lifecycle, membership, sessions and audit. */
export function commitAccountChange(db, ctx, userId, payload) {
  if (!db.isTransaction) fail(500, 'ACCOUNT_TRANSACTION_REQUIRED', '帳號變更須在完整交易中執行');
  const { current, state } = preflightAccountChange(db, ctx, userId, payload);
  let previous = state;
  if (!previous) {
    const time = now(), data = { userId, role: current.role, employeeId: current.employeeId || null, status: 'active', reason: '首次管理時保存既有帳號授權基準', changedBy: null, changedAt: time };
    // Deterministic locator avoids duplicate lifecycle records across independent requests.
    previous = { ...data, id: stateId(ctx.orgId, userId), orgId: ctx.orgId, version: 1, createdAt: time, updatedAt: time };
    db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(previous.id, ctx.orgId, ENTITY, JSON.stringify(data), 1, time, time);
    db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(ctx.orgId, ENTITY, previous.id, 1, JSON.stringify(previous), time, 'account.baseline');
  }
  const time = now(), data = { userId, role: payload.role, employeeId: payload.employeeId, status: payload.status, reason: payload.reason, changedBy: ctx.user.id, changedAt: time };
  const update = db.prepare('UPDATE records SET data=?,version=version+1,updated_at=? WHERE id=? AND org_id=? AND entity=? AND version=?').run(JSON.stringify(data), time, previous.id, ctx.orgId, ENTITY, previous.version);
  if (!update.changes) fail(409, 'VERSION_CONFLICT', '帳號已更新，請重新讀取後再操作');
  const updated = { ...data, id: previous.id, orgId: ctx.orgId, version: previous.version + 1, createdAt: previous.createdAt, updatedAt: time };
  saveVersion(db, updated, 'account.change');
  db.prepare('UPDATE memberships SET role=?,employee_id=? WHERE org_id=? AND user_id=?').run(payload.role, payload.employeeId, ctx.orgId, userId);
  const revoked = db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId).changes;
  audit(db, ctx, 'account.change', ENTITY, updated.id, { userId, fromRole: current.role, toRole: payload.role, fromEmployeeId: current.employeeId || null, toEmployeeId: payload.employeeId, fromStatus: state?.status || 'active', toStatus: payload.status, reason: payload.reason, version: updated.version, sessionsRevoked: revoked });
  return { item: projectAccount(db, ctx, membership(db, ctx, userId)), sessionsRevoked: revoked };
}

/** Cached receipts remain readable only while their exact authorized head exists. */
export function confirmAccountChangeResponse(db, ctx, userId, result) {
  const current = readAccount(db, ctx, userId).item;
  if (!plain(result) || !plain(result.item) || result.item.id !== userId || result.item.orgId !== ctx.orgId || current.version !== result.item.version
      || !['role', 'employeeId', 'status'].every(key => current[key] === result.item[key])) fail(409, 'ACCOUNT_RECEIPT_STALE', '此操作回執已非目前帳號版本，請重新讀取');
  return result;
}
