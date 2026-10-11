// Confirm scope and saved authority before the interface acknowledges a change.
export const accountRoles = Object.freeze({ admin: '管理者', supervisor: '督導', finance: '薪資／財務', caregiver: '居服員' });
export const accountStatuses = Object.freeze({ active: '啟用', suspended: '已停用' });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const invalid = () => { throw new Error('無法確認本機構帳號的保存狀態，請重新讀取。'); };
export function confirmAccount(item, { orgId, userId, id } = {}) {
  if (!plain(item) || !uuid(item.id) || (id && item.id !== id) || item.orgId !== orgId
      || typeof item.name !== 'string' || typeof item.email !== 'string'
      || !Object.hasOwn(accountRoles, item.role) || !Object.hasOwn(accountStatuses, item.status)
      || !Number.isSafeInteger(item.version) || item.version < 0 || item.version === 1
      || (item.version === 0 ? item.updatedAt !== null : !instant(item.updatedAt))
      || (item.employeeId !== null && !uuid(item.employeeId))
      || (item.employeeName !== null && typeof item.employeeName !== 'string')
      || (item.employeeStatus !== null && typeof item.employeeStatus !== 'string')
      || (!item.employeeId && (item.employeeName !== null || item.employeeStatus !== null))
      || typeof item.portalBound !== 'boolean' || (item.portalBound ? typeof item.bindingActive !== 'boolean' : item.bindingActive !== null)
      || item.isSelf !== (item.id === userId) || item.canManage !== (item.id !== userId)) invalid();
  return item;
}
export function confirmAccountList(result, scope, { page, pageSize, role = '', status = '' }) {
  if (!plain(result) || result.orgId !== scope.orgId || result.page !== page || result.pageSize !== pageSize
      || !Number.isSafeInteger(result.total) || result.total < 0 || !Array.isArray(result.items)
      || result.items.length !== Math.min(pageSize, Math.max(0, result.total - (page - 1) * pageSize))) invalid();
  const seen = new Set();
  for (const item of result.items) {
    confirmAccount(item, scope);
    if (seen.has(item.id) || (role && item.role !== role) || (status && item.status !== status)) invalid();
    seen.add(item.id);
  }
  return result;
}
export function buildAccountChange(values, version) {
  const reason = typeof values.reason === 'string' ? values.reason.trim() : '';
  const employeeId = values.employeeId || null;
  if (!Number.isSafeInteger(version) || version < 0 || !Object.hasOwn(accountRoles, values.role) || !Object.hasOwn(accountStatuses, values.status)
      || (employeeId !== null && !uuid(employeeId)) || !reason || reason.length > 1000 || /[\u0000-\u001f\u007f]/.test(reason))
    throw new Error('請填寫有效角色、帳號狀態、員工連結及變更原因。');
  if (values.role === 'caregiver' && !employeeId) {
    const error = new Error('居服員帳號必須指定本機構有效員工。'); error.fields = { employeeId: error.message }; throw error;
  }
  return { version, role: values.role, employeeId, status: values.status, reason };
}
export function confirmAccountChange(result, scope, payload) {
  if (!plain(result) || !Number.isSafeInteger(result.sessionsRevoked) || result.sessionsRevoked < 0) invalid();
  const item = confirmAccount(result.item, scope);
  if (item.version !== (payload.version === 0 ? 2 : payload.version + 1)
      || item.role !== payload.role || item.status !== payload.status || item.employeeId !== payload.employeeId) invalid();
  return result;
}
export function confirmAccountHistory(result, scope) {
  if (!plain(result) || result.orgId !== scope.orgId || result.id !== scope.id || !Array.isArray(result.items)
      || !Number.isSafeInteger(result.total) || result.total < 0 || result.total !== result.items.length || result.total === 1) invalid();
  for (const [index, row] of result.items.entries()) {
    const snapshot = row?.snapshot;
    if (!plain(row) || row.version !== result.total - index || !instant(row.createdAt)
        || row.source !== (row.version === 1 ? 'account.baseline' : 'account.change')
        || !plain(snapshot) || snapshot.userId !== scope.id || !Object.hasOwn(accountRoles, snapshot.role)
        || !Object.hasOwn(accountStatuses, snapshot.status) || (snapshot.employeeId !== null && !uuid(snapshot.employeeId))
        || (snapshot.changedBy !== null && !uuid(snapshot.changedBy))
        || (row.version === 1 ? snapshot.changedBy !== null : snapshot.changedBy === null)
        || typeof snapshot.reason !== 'string' || !snapshot.reason.trim() || !instant(snapshot.changedAt) || snapshot.changedAt !== row.createdAt) invalid();
  }
  return result;
}
