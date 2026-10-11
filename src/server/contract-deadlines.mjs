import { contractDeadlineEntity, contractDeadlineFields, contractDeadlineSnapshotFields, contractDeadlineStatuses, contractDeadlinePriorities,
  contractDeadlineLimits, contractDeadlineDefaults, deadlineOwn, deadlineClosed, contractDeadlineDate, contractDeadlineRecordValid, contractDeadlineSnapshotValid, contractDeadlineWorkState } from '../../public/data/contract-deadline-editor.js';
export const contractDeadlineEntities = Object.freeze({ [contractDeadlineEntity]: Object.freeze({ fields: contractDeadlineFields.join(' '), required: ['contractId', 'contractVersion', 'title', 'content', 'assigneeEmployeeId', 'dueDate'],
  jsonFields: ['contractVersion', 'contractSnapshot'], statuses: Object.keys(contractDeadlineStatuses), defaults: contractDeadlineDefaults, maxLengths: contractDeadlineLimits }) });
export const isContractDeadlineEntity = entity => entity === contractDeadlineEntity;
const manager = ctx => ['admin', 'supervisor'].includes(ctx.role);
const identity = value => typeof value === 'string' && !!value && value.length <= 100 && value.trim() === value && !/[\r\n]/.test(value);
const getParent = (db, ctx, entity, id, get) => { try { const item = get(db, ctx.orgId, entity, id); return item && item.id === id && item.orgId === ctx.orgId ? item : null; } catch { return null; } };
export function guardContractDeadlineAccess(entity, ctx, _readOnly, fail) {
  if (isContractDeadlineEntity(entity) && (!manager(ctx) || !identity(ctx.orgId) || !identity(ctx.user?.id))) fail(403, 'ROLE_FORBIDDEN', '只有管理者及督導可使用契約期限提醒。');
}
export function normalizeContractDeadlinePayload(entity, payload) {
  if (!isContractDeadlineEntity(entity)) return payload;
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === 'string' && !['content', 'result', 'statusReason', 'note'].includes(key) ? value.trim() : value]));
}
export function assertContractDeadlinePayload(entity, payload, fail, patch = false) {
  if (!isContractDeadlineEntity(entity)) return;
  if (Object.hasOwn(payload, 'contractSnapshot')) fail(422, 'DERIVED_FIELD', '來源契約快照只能由伺服器建立。');
  if ((!patch || Object.hasOwn(payload, 'contractVersion')) && (!Number.isSafeInteger(payload.contractVersion) || payload.contractVersion < 1)) fail(422, 'INVALID_VERSION', '來源版次須安全正整數。');
  if (!patch || !Object.hasOwn(payload, 'status') || payload.status === 'pending') return;
  if (!contractDeadlineDate(payload.statusDate)) fail(422, 'TRANSITION_REQUIRED', '請明確提交本次人工處理日期。', { statusDate: '本次日期必填' });
  const reason = payload.status === 'completed' ? 'result' : payload.status === 'cancelled' ? 'statusReason' : null;
  if (reason && (typeof payload[reason] !== 'string' || !payload[reason].trim())) fail(422, 'TRANSITION_REQUIRED', '請明確提交本次結果或取消原因。', { [reason]: '不能沿用舊紀錄' });
}
function source(db, ctx, id, get, contractVisible) {
  const item = getParent(db, ctx, 'case-contracts', id, get);
  try { return item && typeof contractVisible === 'function' && contractVisible(db, ctx, 'case-contracts', item, get) ? item : null; } catch { return null; }
}
export function contractDeadlineVisible(db, ctx, entity, item, get, contractVisible) {
  if (!isContractDeadlineEntity(entity)) return true;
  if (!manager(ctx) || !contractDeadlineRecordValid(item) || item.orgId !== ctx.orgId) return false;
  const parent = source(db, ctx, item.contractId, get, contractVisible), employee = getParent(db, ctx, 'employees', item.assigneeEmployeeId, get);
  return !!parent && !!employee && parent.version >= item.contractVersion && ['active', 'terminated', 'expired'].includes(parent.status)
    && contractDeadlineSnapshotFields.every(key => key === 'version' || parent[key] === item.contractSnapshot[key]);
}
export function contractDeadlineHistoryVisible(db, ctx, entity, snapshot, current, get, contractVisible) {
  return !isContractDeadlineEntity(entity) || contractDeadlineVisible(db, ctx, entity, current, get, contractVisible)
    && contractDeadlineVisible(db, ctx, entity, snapshot, get, contractVisible) && snapshot.id === current.id && snapshot.createdAt === current.createdAt
    && snapshot.version <= current.version && snapshot.contractId === current.contractId && snapshot.contractVersion === current.contractVersion
    && contractDeadlineSnapshotFields.every(key => snapshot.contractSnapshot[key] === current.contractSnapshot[key]);
}
/** Called inside generic transaction; inject same-org row/get and existing contractsTasksVisible. */
export function validateContractDeadline(db, ctx, entity, data, old, fail, rows, get, contractVisible) {
  if (!isContractDeadlineEntity(entity)) return;
  guardContractDeadlineAccess(entity, ctx, false, fail);
  if (old && !contractDeadlineVisible(db, ctx, entity, old, get, contractVisible)) fail(404, 'NOT_FOUND', '找不到可處理的契約提醒。');
  const parent = source(db, ctx, data.contractId, get, contractVisible);
  if (!parent) fail(422, 'INVALID_REFERENCE', '請選擇目前可讀的同機構契約。', { contractId: '來源契約不可讀' });
  if (!old) {
    if (parent.status !== 'active') fail(422, 'SOURCE_NOT_ACTIVE', '只能由目前已記錄生效的契約建立提醒。');
    if (parent.version !== data.contractVersion) fail(409, 'SOURCE_VERSION_CONFLICT', '契約版次已變動，請重新核對来源。');
    data.contractSnapshot = Object.fromEntries(contractDeadlineSnapshotFields.map(key => [key, parent[key]]));
  }
  if (!contractDeadlineRecordValid(data, false)) fail(422, 'INVALID_DEADLINE_REMINDER', '請核對必要欄位、日期、來源快照及人工處理內容。');
  if (!old && data.status !== 'pending') fail(422, 'REMINDER_STATE', '新增提醒須從待處理開始。');
  const employee = getParent(db, ctx, 'employees', data.assigneeEmployeeId, get);
  if (!employee || (!old || data.assigneeEmployeeId !== old.assigneeEmployeeId) && employee.status !== 'active') fail(422, 'INVALID_REFERENCE', '新指派或改派須同機構使用中員工。', { assigneeEmployeeId: '請核對員工' });
  if (old) {
    if (data.contractId !== old.contractId || data.contractVersion !== old.contractVersion || !contractDeadlineSnapshotValid(data.contractSnapshot)
      || contractDeadlineSnapshotFields.some(key => data.contractSnapshot[key] !== old.contractSnapshot[key])) fail(409, 'REMINDER_SOURCE_LOCKED', '來源契約、來源版次與建立快照固定。');
    const transitions = { pending: ['pending', 'in_progress', 'cancelled'], in_progress: ['in_progress', 'completed', 'cancelled'], completed: [], cancelled: [] };
    if (!transitions[old.status]?.includes(data.status)) fail(409, 'REMINDER_LOCKED', '已完成或取消提醒鎖定，不能跳過處理階段。');
    if (old.status === data.status && data.statusDate !== old.statusDate) fail(409, 'REMINDER_LOCKED', '未改狀態不能改寫處理日期。');
    if (old.statusDate && data.statusDate < old.statusDate) fail(422, 'DATE_RANGE', '本次處理日期不能早於上次處理。');
    if (['completed', 'cancelled'].includes(data.status)) {
      const allowed = ['status', 'statusDate', data.status === 'completed' ? 'result' : 'statusReason'];
      if (contractDeadlineFields.some(key => !allowed.includes(key) && key !== 'contractSnapshot' && data[key] !== old[key])) fail(409, 'REMINDER_LOCKED', '完成或取消只保存本次狀態、日期及結果。');
    }
  }
  let existing, rawCount;
  try {
    existing = rows(db, ctx.orgId, entity);
    const count = db.prepare('SELECT count(*) n FROM records WHERE org_id=? AND entity=?'); count.setReadBigInts(true); rawCount = count.get(ctx.orgId, entity).n;
  } catch { fail(409, 'REMINDER_DATA_INVALID', '現有提醒無法確認，不能略過重複檢查。'); }
  if (!Array.isArray(existing) || typeof rawCount !== 'bigint' || BigInt(existing.length) !== rawCount || existing.some(item => !contractDeadlineRecordValid(item) || item.orgId !== ctx.orgId)) fail(409, 'REMINDER_DATA_INVALID', '現有提醒格式無法確認，請先人工核對。');
  if (['pending', 'in_progress'].includes(data.status) && existing.some(item => item.id !== old?.id && item.contractId === data.contractId && ['pending', 'in_progress'].includes(item.status)))
    fail(409, 'OPEN_REMINDER_EXISTS', '來源契約已有未完成或未取消的提醒，請核對既有工作。');
}
export function contractDeadlineQuery(entity, params, fail, mode = 'list') {
  if (!isContractDeadlineEntity(entity)) return {};
  const allowed = mode === 'single' ? [] : mode === 'history' ? ['page', 'pageSize', 'compare'] : ['page', 'pageSize', 'q', 'status', 'priority', 'contractId', 'assigneeEmployeeId', 'asOf', 'workState', 'dueFrom', 'dueTo'];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) fail(422, 'INVALID_QUERY', '查詢參數未知或重複。');
  const integer = (key, fallback, maximum) => { const raw = params.has(key) ? params.get(key) : String(fallback), value = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || /[\r\n]/.test(raw) || !Number.isSafeInteger(value) || value > maximum) fail(422, 'PAGINATION', '請使用合理正整數分頁。'); return value; };
  const query = { page: integer('page', 1, Math.floor(Number.MAX_SAFE_INTEGER / 100)), pageSize: integer('pageSize', 25, 100), q: params.get('q') || '' };
  if (mode === 'history' && params.has('compare')) { if (params.get('compare') !== 'previous') fail(422, 'INVALID_COMPARE', '只支援compare=previous。'); query.compare = 'previous'; }
  if (mode !== 'list') return query;
  if (query.q.length > 200) fail(422, 'INVALID_QUERY', '搜尋最多200字元。');
  if (!params.has('asOf') || !contractDeadlineDate(params.get('asOf'))) fail(422, 'AS_OF_REQUIRED', '工作清單須明確指定比對日期。'); query.asOf = params.get('asOf');
  for (const [key, values] of [['status', Object.keys(contractDeadlineStatuses)], ['priority', Object.keys(contractDeadlinePriorities)], ['workState', ['before_due', 'on_due', 'past_due', 'closed']]]) if (params.has(key)) {
    if (!values.includes(params.get(key))) fail(422, 'INVALID_QUERY', '查詢分類不合法。'); query[key] = params.get(key);
  }
  for (const key of ['contractId', 'assigneeEmployeeId']) if (params.has(key)) { if (!identity(params.get(key))) fail(422, 'INVALID_REFERENCE', '查詢來源識別不合法。'); query[key] = params.get(key); }
  for (const key of ['dueFrom', 'dueTo']) if (params.has(key)) { if (!contractDeadlineDate(params.get(key))) fail(422, 'INVALID_DATE', '查詢期限須有效完整日期。'); query[key] = params.get(key); }
  if (!!query.dueFrom !== !!query.dueTo || query.dueFrom && (query.dueTo < query.dueFrom || Date.parse(query.dueTo) - Date.parse(query.dueFrom) > 365 * 86400000)) fail(422, 'DATE_RANGE', '期限期間須成對依序、最多366日含端。');
  return query;
}
export function assertContractDeadlineQueryTarget(db, ctx, entity, query, fail, get, contractVisible) {
  if (!isContractDeadlineEntity(entity)) return;
  if (query.contractId && !source(db, ctx, query.contractId, get, contractVisible) || query.assigneeEmployeeId && !getParent(db, ctx, 'employees', query.assigneeEmployeeId, get)) fail(404, 'NOT_FOUND', '找不到可查詢的同機構來源或員工。');
}
export function filterContractDeadlines(entity, items, query) {
  if (!isContractDeadlineEntity(entity)) return items;
  const search = query.q.toLowerCase();
  return items.filter(item => (!query.status || item.status === query.status) && (!query.priority || item.priority === query.priority)
    && (!query.contractId || item.contractId === query.contractId) && (!query.assigneeEmployeeId || item.assigneeEmployeeId === query.assigneeEmployeeId)
    && (!query.workState || contractDeadlineWorkState(item, query.asOf) === query.workState) && (!query.dueFrom || item.dueDate >= query.dueFrom && item.dueDate <= query.dueTo)
    && (!search || [item.title, item.content, item.note, item.result, item.statusReason, item.contractSnapshot.number, item.contractSnapshot.title].some(value => value.toLowerCase().includes(search))))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
}
