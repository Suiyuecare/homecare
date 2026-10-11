import { TRAINING_CREDIT_ENTITY, TRAINING_CREDIT_FIELDS, TRAINING_CREDIT_LIMITS, TRAINING_CREDIT_REQUIRED, TRAINING_CREDIT_STATUSES, creditPlain, creditClosed, creditId, isTrainingCreditYear, isTrainingCreditDate, assertTrainingCreditBusiness, assertTrainingCreditItem, trainingCreditFail } from '../../public/data/training-credit-core.js';
export const trainingCreditEntities = { [TRAINING_CREDIT_ENTITY]: { fields: TRAINING_CREDIT_FIELDS.join(' '), required: [...TRAINING_CREDIT_REQUIRED], statuses: Object.keys(TRAINING_CREDIT_STATUSES), defaults: { reference: '', note: '', status: 'draft', verifiedOn: '', verificationBasis: '', voidedOn: '', voidReason: '' }, maxLengths: TRAINING_CREDIT_LIMITS } };
export const isTrainingCreditEntity = entity => entity === TRAINING_CREDIT_ENTITY;
const managers = ['admin', 'supervisor'];
export function guardTrainingCreditAccess(entity, ctx, readOnly, fail = trainingCreditFail) {
  if (!isTrainingCreditEntity(entity)) return;
  if (!creditId(ctx?.orgId) || !creditId(ctx?.user?.id) || !(managers.includes(ctx.role) || readOnly && ctx.role === 'caregiver' && creditId(ctx.employeeId))) fail(403, 'ROLE_FORBIDDEN', '僅管理者、督導可維護；居服員只能讀取本人紀錄。');
}
export function normalizeTrainingCreditPayload(entity, payload) {
  if (!isTrainingCreditEntity(entity)) return payload;
  if (!creditPlain(payload)) trainingCreditFail(422, 'TRAINING_CREDIT_INVALID', '請使用已知文字欄位。');
  const normalized = new Set(['employeeId', 'activityName', 'provider', 'creditUnit', 'status']);
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, normalized.has(key) && typeof value === 'string' && !/[\r\n]/.test(value) ? value.trim() : value]));
}
export function assertTrainingCreditTransitionPayload(entity, payload, fail = trainingCreditFail) {
  if (!isTrainingCreditEntity(entity) || !creditPlain(payload) || !Object.hasOwn(payload, 'status')) return;
  if (payload.status === 'verified' && (!Object.hasOwn(payload, 'verifiedOn') || !isTrainingCreditDate(payload.verifiedOn) || !Object.hasOwn(payload, 'verificationBasis') || typeof payload.verificationBasis !== 'string' || !payload.verificationBasis.trim())) fail(422, 'TRAINING_CREDIT_TRANSITION_REQUIRED', '本次人工核對須提供核對日期與依據。', { verificationBasis: '本次操作必填' });
  if (payload.status === 'voided' && (!Object.hasOwn(payload, 'voidedOn') || !isTrainingCreditDate(payload.voidedOn) || !Object.hasOwn(payload, 'voidReason') || typeof payload.voidReason !== 'string' || !payload.voidReason.trim())) fail(422, 'TRAINING_CREDIT_TRANSITION_REQUIRED', '本次作廢須提供日期與新的作廢原因。', { voidReason: '本次操作必填' });
}
function employeeParent(db, ctx, employeeId, get) {
  try { const item = get(db, ctx.orgId, 'employees', employeeId); return creditPlain(item) && item.id === employeeId && item.orgId === ctx.orgId && Number.isSafeInteger(item.version) && item.version > 0 && typeof item.name === 'string' && !!item.name.trim() && ['active', 'inactive'].includes(item.status) ? item : null; } catch { return null; }
}
export function trainingCreditVisible(db, ctx, entity, item, get) {
  if (!isTrainingCreditEntity(entity)) return true;
  try { guardTrainingCreditAccess(entity, ctx, true); assertTrainingCreditItem(item, ctx.orgId); const employee = employeeParent(db, ctx, item.employeeId, get); return !!employee && (managers.includes(ctx.role) || ctx.role === 'caregiver' && ctx.employeeId === item.employeeId && employee.status === 'active'); } catch { return false; }
}
export function trainingCreditHistoryVisible(db, ctx, entity, snapshot, current, get) {
  return trainingCreditVisible(db, ctx, entity, current, get) && trainingCreditVisible(db, ctx, entity, snapshot, get) && snapshot.id === current.id && snapshot.employeeId === current.employeeId && snapshot.createdAt === current.createdAt;
}
export function validateTrainingCredit(db, ctx, entity, data, old, fail = trainingCreditFail, get) {
  if (!isTrainingCreditEntity(entity)) return;
  guardTrainingCreditAccess(entity, ctx, false, fail); assertTrainingCreditBusiness(data, fail);
  if (old && !trainingCreditVisible(db, ctx, entity, old, get)) fail(404, 'NOT_FOUND', '找不到可維護的人工積分紀錄。');
  if (old && data.employeeId !== old.employeeId) fail(409, 'TRAINING_CREDIT_EMPLOYEE_IMMUTABLE', '紀錄所屬員工建立後不可更换。');
  if (!employeeParent(db, ctx, data.employeeId, get)) fail(404, 'NOT_FOUND', '找不到同機構員工。');
  if (!old) { if (data.status !== 'draft') fail(422, 'TRAINING_CREDIT_STATE', '新增紀錄須先保存草稿。'); return; }
  if (old.status === 'voided') fail(409, 'TRAINING_CREDIT_LOCKED', '作廢紀錄為終態，不能改寫。');
  if (old.status === 'draft') { if (!['draft', 'verified'].includes(data.status)) fail(409, 'TRAINING_CREDIT_STATE', '草稿只能保存或人工核對。'); return; }
  if (data.status !== 'voided' || TRAINING_CREDIT_FIELDS.some(key => !['status', 'voidedOn', 'voidReason'].includes(key) && data[key] !== old[key])) fail(409, 'TRAINING_CREDIT_LOCKED', '已核對內容鎖定，只可附本次日期與原因作廢。');
}
export function trainingCreditQuery(entity, params, fail = trainingCreditFail, mode = 'list') {
  if (!isTrainingCreditEntity(entity)) return {};
  const allowed = mode === 'single' ? [] : mode === 'history' ? ['page', 'pageSize', 'compare'] : ['page', 'pageSize', 'year', 'employeeId', 'status', 'q'];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) fail(422, 'INVALID_QUERY', '人工積分查詢含未知或重複欄位。');
  const integer = (key, fallback, max) => { const raw = params.get(key) ?? String(fallback), number = Number(raw); if (!/^[1-9]\d*$/.test(raw) || /[\r\n]/.test(raw) || !Number.isSafeInteger(number) || number > max) fail(422, 'INVALID_QUERY', '人工積分分頁格式不合法。'); return number; };
  const result = { page: integer('page', 1, Math.floor(Number.MAX_SAFE_INTEGER / 100)), pageSize: integer('pageSize', 25, 100), q: params.get('q') || '' };
  if (result.q.length > 200) fail(422, 'INVALID_QUERY', '搜尋文字最多200字。');
  if (params.has('year')) { if (!isTrainingCreditYear(params.get('year'))) fail(422, 'INVALID_QUERY', '年度需為0001至9999的四位文字。'); result.year = params.get('year'); }
  if (params.has('employeeId')) { if (!creditId(params.get('employeeId'))) fail(422, 'INVALID_QUERY', '員工識別碼不合法。'); result.employeeId = params.get('employeeId'); }
  if (params.has('status')) { if (!Object.hasOwn(TRAINING_CREDIT_STATUSES, params.get('status'))) fail(422, 'INVALID_QUERY', '查詢狀態不合法。'); result.status = params.get('status'); }
  if (params.has('compare') && params.get('compare') !== 'previous') fail(422, 'INVALID_QUERY', '只支援精確前版比較。'); return result;
}
export function assertTrainingCreditQueryTarget(db, ctx, entity, query, fail = trainingCreditFail, get) {
  if (!isTrainingCreditEntity(entity) || !query.employeeId) return;
  const employee = employeeParent(db, ctx, query.employeeId, get);
  if (!employee || ctx.role === 'caregiver' && (ctx.employeeId !== query.employeeId || employee.status !== 'active')) fail(404, 'NOT_FOUND', '找不到可查詢員工。');
}
export function filterTrainingCredits(entity, items, query) {
  if (!isTrainingCreditEntity(entity)) return items;
  const q = (query.q || '').toLocaleLowerCase('zh-TW');
  return items.filter(item => (!query.employeeId || item.employeeId === query.employeeId) && (!query.year || item.date.slice(0, 4) === query.year) && (!query.status || item.status === query.status) && (!q || [item.activityName, item.provider, item.sourceReference, item.reference, item.note, item.creditUnit].some(value => value.toLocaleLowerCase('zh-TW').includes(q))));
}
