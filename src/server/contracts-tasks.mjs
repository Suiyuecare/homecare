/** Manual company contract records and internal work. No legal effect or dispatch. */
export const contractEntity = 'case-contracts', internalTaskEntity = 'internal-tasks';
export const contractFields = ['caseId', 'number', 'title', 'startDate', 'endDate', 'signedDate', 'documentReference', 'sourceReference', 'renewedFromId', 'status', 'statusDate', 'statusReason', 'note'];
export const internalTaskFields = ['title', 'content', 'assigneeEmployeeId', 'dueDate', 'priority', 'status', 'statusDate', 'result', 'statusReason', 'note'];
export const contractStatuses = ['draft', 'active', 'terminated', 'expired', 'cancelled'];
export const internalTaskStatuses = ['pending', 'in_progress', 'completed', 'cancelled'];
export const contractsTasksEntities = {
  [contractEntity]: { fields: contractFields.join(' '), required: ['caseId', 'number', 'title', 'startDate', 'endDate'], statuses: contractStatuses,
    defaults: { signedDate: '', documentReference: '', sourceReference: '', renewedFromId: '', status: 'draft', statusDate: '', statusReason: '', note: '' },
    maxLengths: { caseId: 100, number: 100, title: 200, startDate: 10, endDate: 10, signedDate: 10, documentReference: 2000,
      sourceReference: 2000, renewedFromId: 100, status: 30, statusDate: 10, statusReason: 10000, note: 10000 } },
  [internalTaskEntity]: { fields: internalTaskFields.join(' '), required: ['title', 'content', 'assigneeEmployeeId', 'dueDate'], statuses: internalTaskStatuses,
    defaults: { priority: 'normal', status: 'pending', statusDate: '', result: '', statusReason: '', note: '' },
    maxLengths: { title: 200, content: 10000, assigneeEmployeeId: 100, dueDate: 10, priority: 30, status: 30,
      statusDate: 10, result: 10000, statusReason: 10000, note: 10000 } },
};
export const isContractsTasksEntity = entity => Object.hasOwn(contractsTasksEntities, entity);
const managers = ['admin', 'supervisor'], allRoles = [...managers, 'finance', 'caregiver'];
const keysFor = entity => entity === contractEntity ? contractFields : internalTaskFields;
const identifier = value => typeof value === 'string' && !!value.trim() && value.length <= 100 && !/[\r\n]/.test(value);
const validDate = value => typeof value === 'string' && value.length === 10 && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const limits = { caseId: 100, number: 100, title: 200, startDate: 10, endDate: 10, signedDate: 10, documentReference: 2000,
  sourceReference: 2000, renewedFromId: 100, status: 30, statusDate: 10, statusReason: 10000, note: 10000,
  content: 10000, assigneeEmployeeId: 100, dueDate: 10, priority: 30, result: 10000 };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const parentGet = (db, orgId, entity, id, get) => { try { return get(db, orgId, entity, id); } catch { return null; } };
function closed(value, fields) {
  if (!plain(value) || Reflect.ownKeys(value).length !== fields.length) return false;
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && fields.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function shape(entity, item, metadata = true) {
  const fields = keysFor(entity), meta = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
  if (!closed(item, metadata ? [...fields, ...meta] : fields)) return false;
  if (fields.some(key => typeof item[key] !== 'string' || item[key].length > limits[key])) return false;
  if (metadata && (!identifier(item.id) || !identifier(item.orgId) || !Number.isSafeInteger(item.version) || item.version < 1
    || typeof item.createdAt !== 'string' || !item.createdAt || typeof item.updatedAt !== 'string' || !item.updatedAt)) return false;
  if (contractsTasksEntities[entity].required.some(key => !item[key].trim()) || /[\r\n]/.test(item.title)) return false;
  if (!contractsTasksEntities[entity].statuses.includes(item.status)) return false;
  if (entity === contractEntity) {
    if (!identifier(item.caseId) || /[\r\n]/.test(item.number) || /[\r\n]/.test(item.documentReference)
      || !validDate(item.startDate) || !validDate(item.endDate) || item.startDate > item.endDate || (item.signedDate && !validDate(item.signedDate))
      || (item.renewedFromId && !identifier(item.renewedFromId))) return false;
    if (item.status === 'draft') return !item.statusDate && !item.statusReason;
    if (!validDate(item.statusDate)) return false;
    if (item.status !== 'cancelled' && (!validDate(item.signedDate) || !item.documentReference.trim() || !item.sourceReference.trim() || item.statusDate < item.signedDate)) return false;
    if (item.status === 'active') return !item.statusReason;
    return !!item.statusReason.trim() && (item.status !== 'expired' || item.statusDate > item.endDate);
  }
  if (!identifier(item.assigneeEmployeeId) || !validDate(item.dueDate) || !['low', 'normal', 'high'].includes(item.priority)) return false;
  if (item.status === 'pending') return !item.statusDate && !item.result && !item.statusReason;
  if (!validDate(item.statusDate)) return false;
  if (item.status === 'completed') return !!item.result.trim() && !item.statusReason;
  if (item.status === 'cancelled') return !!item.statusReason.trim() && !item.result;
  return !item.result && !item.statusReason;
}

export function guardContractsTasksAccess(entity, ctx, readOnly, fail) {
  if (!isContractsTasksEntity(entity)) return;
  const allowed = entity === internalTaskEntity && readOnly ? allRoles : managers;
  if (!allowed.includes(ctx.role) || !identifier(ctx.orgId) || !identifier(ctx.user?.id)) fail(403, 'ROLE_FORBIDDEN', '此角色無權使用契約或內部待辦');
}
export function normalizeContractsTasksPayload(entity, payload) {
  if (!isContractsTasksEntity(entity)) return payload;
  const long = ['content', 'sourceReference', 'result', 'statusReason', 'note'];
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === 'string' && !long.includes(key) ? value.trim() : value]));
}
export function assertContractsTasksTransitionPayload(entity, payload, fail) {
  if (!isContractsTasksEntity(entity) || !Object.hasOwn(payload, 'status')) return;
  const status = payload.status, initial = entity === contractEntity ? 'draft' : 'pending';
  if (status === initial) return;
  if (typeof payload.statusDate !== 'string' || !payload.statusDate.trim()) fail(422, 'TRANSITION_REQUIRED', '狀態處理須提交本次處理日期', { statusDate: '請填寫本次處理日期' });
  const reason = ['terminated', 'expired', 'cancelled'].includes(status) ? 'statusReason' : status === 'completed' ? 'result' : null;
  if (reason && (typeof payload[reason] !== 'string' || !payload[reason].trim())) fail(422, 'TRANSITION_REQUIRED', '請提交本次結果或原因', { [reason]: '本次操作必填' });
}

export function contractsTasksVisible(db, ctx, entity, item, get) {
  if (!isContractsTasksEntity(entity)) return true;
  if (!shape(entity, item) || item.orgId !== ctx.orgId) return false;
  try {
    if (entity === internalTaskEntity) {
      const employee = get(db, ctx.orgId, 'employees', item.assigneeEmployeeId);
      return !!employee && employee.id === item.assigneeEmployeeId && employee.orgId === ctx.orgId
        && (managers.includes(ctx.role) || allRoles.includes(ctx.role) && item.assigneeEmployeeId === ctx.employeeId);
    }
    if (!managers.includes(ctx.role)) return false;
    const parentCase = get(db, ctx.orgId, 'cases', item.caseId);
    if (!parentCase || parentCase.id !== item.caseId || parentCase.orgId !== ctx.orgId) return false;
    const visited = new Set([item.id]); let child = item, parentId = item.renewedFromId;
    for (let index = 0; parentId && index < 1000; index++) {
      if (visited.has(parentId)) return false; visited.add(parentId);
      const parent = get(db, ctx.orgId, contractEntity, parentId);
      if (!shape(contractEntity, parent) || parent.orgId !== ctx.orgId || parent.id !== parentId || parent.caseId !== item.caseId
        || child.startDate <= parent.endDate || !['active', 'terminated', 'expired'].includes(parent.status)) return false;
      child = parent; parentId = parent.renewedFromId;
    }
    return !parentId;
  } catch { return false; }
}
export function contractsTasksHistoryVisible(db, ctx, entity, snapshot, current, get) {
  if (!contractsTasksVisible(db, ctx, entity, snapshot, get) || snapshot.id !== current.id || snapshot.createdAt !== current.createdAt) return false;
  if (entity === contractEntity) return snapshot.caseId === current.caseId && snapshot.number === current.number && snapshot.renewedFromId === current.renewedFromId;
  return managers.includes(ctx.role) || snapshot.assigneeEmployeeId === ctx.employeeId && current.assigneeEmployeeId === ctx.employeeId;
}

export function validateContractsTasks(db, ctx, entity, data, old, fail, dateValid, rows, get) {
  if (!isContractsTasksEntity(entity)) return;
  guardContractsTasksAccess(entity, ctx, false, fail);
  if (old && !contractsTasksVisible(db, ctx, entity, old, get)) fail(404, 'NOT_FOUND', '找不到可處理資料');
  if (!shape(entity, data, false)) fail(422, 'INVALID_CONTRACT_TASK', '請核對必要文字、日期、狀態與本次處理結果');
  if (entity === internalTaskEntity) {
    const employee = parentGet(db, ctx.orgId, 'employees', data.assigneeEmployeeId, get);
    if (!employee || employee.orgId !== ctx.orgId || (!old || old.assigneeEmployeeId !== data.assigneeEmployeeId) && employee.status !== 'active')
      fail(422, 'INVALID_REFERENCE', '請指派同機構有效員工', { assigneeEmployeeId: '請選擇同機構有效員工' });
    if (!old && data.status !== 'pending') fail(422, 'TASK_STATE', '新增待辦須從待處理開始');
    const transitions = { pending: ['pending', 'in_progress', 'cancelled'], in_progress: ['in_progress', 'completed', 'cancelled'], completed: [], cancelled: [] };
    if (old && !transitions[old.status]?.includes(data.status)) fail(409, 'TASK_LOCKED', '完成或取消後鎖定；請核對目前狀態');
    if (old?.statusDate && data.statusDate < old.statusDate) fail(422, 'DATE_RANGE', '本次處理日期不可早於上一處理日期', { statusDate: '請核對處理日期' });
    if (old && old.status === data.status && data.statusDate !== old.statusDate) fail(409, 'TASK_LOCKED', '未變更狀態不能改寫處理日期');
    if (old && ['completed', 'cancelled'].includes(data.status)) {
      const permitted = ['status', 'statusDate', data.status === 'completed' ? 'result' : 'statusReason'];
      if (internalTaskFields.some(key => !permitted.includes(key) && data[key] !== old[key])) fail(409, 'TASK_LOCKED', '完成或取消只保存本次狀態、日期及結果');
    }
    return;
  }
  const parent = parentGet(db, ctx.orgId, 'cases', data.caseId, get);
  if (!parent || parent.orgId !== ctx.orgId) fail(422, 'INVALID_REFERENCE', '請選擇同機構個案', { caseId: '同機構個案必填' });
  let existing;
  try { existing = rows(db, ctx.orgId, contractEntity); } catch { fail(409, 'CONTRACT_DATA_INVALID', '現有契約資料無法確認，請先核對'); }
  if (existing.some(item => !shape(contractEntity, item))) fail(409, 'CONTRACT_DATA_INVALID', '現有契約格式無法確認，不能略過續約或編號檢查');
  if (existing.some(item => item.id !== old?.id && item.number === data.number)) fail(409, 'CONTRACT_NUMBER_EXISTS', '同機構契約編號已使用', { number: '請使用新編號' });
  if (!old && data.status !== 'draft') fail(422, 'CONTRACT_STATE', '新增契約須從草稿開始');
  if (old && ['caseId', 'number', 'renewedFromId'].some(key => data[key] !== old[key])) fail(409, 'CONTRACT_IDENTITY_LOCKED', '契約個案、編號與續約來源建立後固定');
  const transitions = { draft: ['draft', 'active', 'cancelled'], active: ['terminated', 'expired'], terminated: [], expired: [], cancelled: [] };
  if (old && !transitions[old.status]?.includes(data.status)) fail(409, 'CONTRACT_LOCKED', '生效內容及終止、到期或取消紀錄鎖定');
  if (old?.statusDate && data.statusDate < old.statusDate) fail(422, 'DATE_RANGE', '本次處理日期不可早於上一處理日期', { statusDate: '請核對處理日期' });
  if (old && (old.status === 'active' || data.status === 'cancelled')) {
    if (contractFields.some(key => !['status', 'statusDate', 'statusReason'].includes(key) && data[key] !== old[key])) fail(409, 'CONTRACT_LOCKED', '已生效內容不可改写；狀態處理只保存本次日期與原因');
  }
  if (data.renewedFromId) {
    const previous = parentGet(db, ctx.orgId, contractEntity, data.renewedFromId, get);
    if (!previous || !contractsTasksVisible(db, ctx, contractEntity, previous, get) || previous.caseId !== data.caseId || !['active', 'terminated', 'expired'].includes(previous.status))
      fail(422, 'INVALID_RENEWAL', '續約須選擇同個案可讀的已生效、終止或到期契約', { renewedFromId: '續約來源不合法' });
    if (data.startDate <= previous.endDate) fail(409, 'RENEWAL_OVERLAP', '續約開始日須晚於原契約結束日', { startDate: '請核對不重疊續約期間' });
    if (data.status !== 'cancelled' && existing.some(item => item.id !== old?.id && item.renewedFromId === data.renewedFromId && item.status !== 'cancelled'))
      fail(409, 'RENEWAL_EXISTS', '原契約已有未取消的後續契約；請先核對既有續約');
  }
}

export function contractExpiry(item, asOf) {
  if (!validDate(asOf)) return null;
  if (item.status !== 'active') return 'not_active';
  return asOf < item.startDate ? 'not_started' : asOf > item.endDate ? 'past_end' : 'within_term';
}
export function contractsTasksQuery(entity, params, fail, mode = 'list') {
  if (!isContractsTasksEntity(entity)) return {};
  const contract = entity === contractEntity;
  const allowed = mode === 'history' ? ['page', 'pageSize', 'compare'] : mode === 'single' ? []
    : ['page', 'pageSize', 'q', 'status', ...(contract ? ['caseId', 'asOf', 'expiry', 'expiryFrom', 'expiryTo'] : ['assigneeEmployeeId', 'priority', 'dueFrom', 'dueTo'])];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) fail(422, 'INVALID_QUERY', '查詢參數未知或重複', { [key]: '請使用單一合法查詢參數' });
  const integer = (key, fallback, maximum) => {
    const raw = params.has(key) ? params.get(key) : String(fallback), value = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || /[\r\n]/.test(raw) || !Number.isSafeInteger(value) || value > maximum) fail(422, 'PAGINATION', '請提供合理正整數分頁', { [key]: '分頁參數不合法' });
    return value;
  };
  const query = { page: integer('page', 1, Math.floor(Number.MAX_SAFE_INTEGER / 100)), pageSize: integer('pageSize', 25, 100), q: params.get('q') || '', status: params.get('status') || '' };
  if (query.q.length > 200) fail(422, 'INVALID_QUERY', '搜尋最多200字元', { q: '搜尋文字過長' });
  if (params.has('status') && !contractsTasksEntities[entity].statuses.includes(query.status)) fail(422, 'INVALID_STATUS', '查詢狀態不合法');
  if (params.has('compare')) { if (params.get('compare') !== 'previous') fail(422, 'INVALID_COMPARE', '只支援compare=previous'); query.compare = 'previous'; }
  const ref = contract ? 'caseId' : 'assigneeEmployeeId';
  if (params.has(ref)) { if (!identifier(params.get(ref))) fail(422, 'INVALID_REFERENCE', '查詢對象識別不合法'); query[ref] = params.get(ref); }
  for (const key of contract ? ['asOf', 'expiryFrom', 'expiryTo'] : ['dueFrom', 'dueTo']) if (params.has(key)) {
    if (!validDate(params.get(key))) fail(422, 'INVALID_DATE', '請提供有效完整日期', { [key]: '請提供0001至9999的YYYY-MM-DD' }); query[key] = params.get(key);
  }
  const from = contract ? 'expiryFrom' : 'dueFrom', to = contract ? 'expiryTo' : 'dueTo';
  if (!!query[from] !== !!query[to]) fail(422, 'DATE_RANGE', '日期期間須同時提供起訖');
  if (query[from] && (query[to] < query[from] || Date.parse(query[to] + 'T00:00:00Z') - Date.parse(query[from] + 'T00:00:00Z') > 365 * 86400000)) fail(422, 'DATE_RANGE', '日期區間須依序且最多366日含端');
  if (params.has('expiry')) {
    if (!query.asOf || !['not_started', 'within_term', 'past_end'].includes(params.get('expiry'))) fail(422, 'INVALID_EXPIRY', '效期比對須明確截至日期及合法分類');
    query.expiry = params.get('expiry');
  }
  if (params.has('priority')) { if (!['low', 'normal', 'high'].includes(params.get('priority'))) fail(422, 'INVALID_PRIORITY', '待辦優先程度不合法'); query.priority = params.get('priority'); }
  return query;
}
export function filterContractsTasks(entity, items, query) {
  const contract = entity === contractEntity, q = (query.q || '').toLowerCase();
  const search = contract ? ['number', 'title', 'documentReference', 'sourceReference', 'statusReason', 'note'] : ['title', 'content', 'result', 'statusReason', 'note'];
  return items.filter(item => (!query.status || item.status === query.status)
    && (!query.caseId || item.caseId === query.caseId) && (!query.assigneeEmployeeId || item.assigneeEmployeeId === query.assigneeEmployeeId)
    && (!query.priority || item.priority === query.priority) && (!query.expiry || contractExpiry(item, query.asOf) === query.expiry)
    && (!query.expiryFrom || item.endDate >= query.expiryFrom && item.endDate <= query.expiryTo)
    && (!query.dueFrom || item.dueDate >= query.dueFrom && item.dueDate <= query.dueTo)
    && (!q || search.some(key => item[key].toLowerCase().includes(q))));
}
export function assertContractsTasksQueryTarget(db, ctx, entity, query, fail, get) {
  const key = entity === contractEntity ? 'caseId' : 'assigneeEmployeeId', parentEntity = entity === contractEntity ? 'cases' : 'employees';
  if (!query[key]) return;
  const parent = parentGet(db, ctx.orgId, parentEntity, query[key], get);
  if (!parent || parent.orgId !== ctx.orgId || entity === internalTaskEntity && !managers.includes(ctx.role) && query[key] !== ctx.employeeId)
    fail(404, 'NOT_FOUND', '找不到可查詢的同機構對象');
}
