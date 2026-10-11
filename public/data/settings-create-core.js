// Closed, descriptor-first confirmation of the three existing settings actions.
const roles = new Set(['admin', 'supervisor', 'caregiver', 'finance']);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const invalid = () => { throw new Error('無法確認本次保存回應，請保留輸入內容，以相同內容重試或核對目前資料。'); };
function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) invalid();
  for (const key of keys) if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) || {}, 'value')) invalid();
  return value;
}
function scopeValid(scope) { closed(scope, ['orgId', 'userId']); if (!uuid(scope.orgId) || !uuid(scope.userId)) invalid(); }
function text(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    const error = new Error('請填寫有效的姓名、電子郵件、密碼、角色與員工連結。'); error.fields = { [field]: '長度或格式不符。' }; throw error;
  }
  return value.trim();
}
export function buildSettingsUser(values) {
  closed(values, ['name', 'email', 'password', 'role', 'employeeId']);
  const name = text(values.name, 'name'), email = text(values.email, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { const error = new Error('請填寫有效電子郵件。'); error.fields = { email: error.message }; throw error; }
  if (typeof values.password !== 'string' || values.password.length < 12 || values.password.length > 512) { const error = new Error('初始密碼至少12字，最多512字。'); error.fields = { password: error.message }; throw error; }
  const employeeId = values.employeeId === '' || values.employeeId === null ? null : values.employeeId;
  if (!roles.has(values.role) || (employeeId !== null && !uuid(employeeId)) || (values.role === 'caregiver' && !employeeId)) {
    const error = new Error('居服員帳號必須指定本機構有效員工，並選擇有效存取角色。'); error.fields = { employeeId: error.message }; throw error;
  }
  return { name, email, password: values.password, role: values.role, employeeId };
}
export function buildSettingsOrganization(values) { closed(values, ['name']); return { name: text(values.name, 'name') }; }
export function confirmSettingsUser(result, scope, payload) {
  scopeValid(scope); closed(result, ['item']);
  const item = closed(result.item, ['id', 'orgId', 'name', 'email', 'role', 'employeeId', 'status', 'version', 'createdAt', 'createdBy']);
  if (!uuid(item.id) || item.id === scope.userId || item.orgId !== scope.orgId || item.createdBy !== scope.userId || !instant(item.createdAt)
      || item.version !== 0 || item.status !== 'active' || !roles.has(item.role) || (item.employeeId !== null && !uuid(item.employeeId))
      || item.name !== payload.name || item.email !== payload.email || item.role !== payload.role || item.employeeId !== (payload.employeeId || null)) invalid();
  return item;
}
export function confirmSettingsOrganization(result, scope, payload) {
  scopeValid(scope); closed(result, ['item']);
  const item = closed(result.item, ['id', 'name', 'role', 'sourceOrgId', 'createdBy', 'createdAt']);
  if (!uuid(item.id) || item.id === scope.orgId || item.sourceOrgId !== scope.orgId || item.createdBy !== scope.userId || !instant(item.createdAt)
      || item.name !== payload.name || item.role !== 'admin') invalid();
  return item;
}
export function confirmSettingsDemo(result, scope) {
  scopeValid(scope); closed(result, ['seeded', 'message', 'orgId', 'requestedBy']);
  if (result.orgId !== scope.orgId || result.requestedBy !== scope.userId || typeof result.seeded !== 'boolean'
      || result.message !== (result.seeded ? '已建立完全合成示範資料' : '示範資料已建立，不重複新增')) invalid();
  return result;
}
export function confirmSettingsSession(session, scope, organization, originalUser, expectedCsrfToken) {
  scopeValid(scope); closed(session, ['user', 'organizations', 'csrfToken']);
  const user = closed(session.user, ['id', 'name', 'email', 'role', 'employeeId']);
  if (user.id !== scope.userId || user.name !== originalUser.name || user.email !== originalUser.email || !roles.has(user.role)
      || (user.employeeId !== null && !uuid(user.employeeId)) || !/^[a-f0-9]{64}$/.test(expectedCsrfToken) || session.csrfToken !== expectedCsrfToken) invalid();
  const list = session.organizations;
  if (!Array.isArray(list) || list.length < 2 || Reflect.ownKeys(list).length !== list.length + 1) invalid();
  const seen = new Set();
  // Confirm every descriptor before any row value can be read.
  for (let i = 0; i < list.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(list, String(i)); if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    closed(descriptor.value, ['id', 'name', 'role', 'employeeId']);
  }
  for (const row of list) {
    if (!uuid(row.id) || seen.has(row.id) || typeof row.name !== 'string' || !roles.has(row.role) || (row.employeeId !== null && !uuid(row.employeeId))) invalid();
    seen.add(row.id);
  }
  const current = list.find(row => row.id === scope.orgId), created = list.find(row => row.id === organization.id);
  if (!current || current.role !== 'admin' || current.employeeId !== (originalUser.employeeId || null) || !created || created.name !== organization.name || created.role !== 'admin' || created.employeeId !== null
      || user.role !== list[0].role || user.employeeId !== list[0].employeeId) invalid();
  return session;
}
export function settingsPayloadKey(createKey = () => crypto.randomUUID()) {
  let signature, key;
  return payload => { const next = JSON.stringify(payload); if (signature !== next) { signature = next; key = createKey(); } return key; };
}
