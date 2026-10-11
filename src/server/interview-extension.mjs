import { INTERVIEW_BASE_FIELDS, INTERVIEW_EXTENSION_FIELDS, INTERVIEW_LOCAL_FIELDS, INTERVIEW_EXTENSION_DEFAULTS,
  INTERVIEW_EXTENSION_LIMITS, INTERVIEW_DECISIONS, interviewOwnField, interviewExtensionFieldsValid, interviewExtensionValueValid } from '../../public/data/interview-extension-editor.js';

// Company-defined extension of the existing eight-field interview record; not original-platform parity.
export const interviewExtensionSpec = Object.freeze({
  fields: INTERVIEW_LOCAL_FIELDS.join(' '), required: Object.freeze(['name', 'phone', 'interviewDate', 'interviewContent']),
  statuses: Object.freeze(['active', 'inactive']),
  defaults: Object.freeze({ status: 'active', city: '', district: '', note: '', ...INTERVIEW_EXTENSION_DEFAULTS }),
  maxLengths: Object.freeze({ name: 200, phone: 64, interviewDate: 500, city: 100, district: 100, interviewContent: 10000, note: 10000, status: 500, ...INTERVIEW_EXTENSION_LIMITS }),
});
export const isInterviewExtensionEntity = entity => entity === 'interview-applicants';
const known = new Set([...INTERVIEW_LOCAL_FIELDS, 'id', 'orgId', 'version', 'createdAt', 'updatedAt']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const identity = value => typeof value === 'string' && !!value && value === value.trim() && !/[\r\n]/.test(value);
const timestamp = value => typeof value === 'string' && value.length === 24 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const hasExtension = item => INTERVIEW_EXTENSION_FIELDS.some(key => Object.hasOwn(item, key));
/** Old eight-field records keep literal metadata when read. Unknown stored keys
 * are excluded from the read DTO without inspecting their values or rewriting
 * the source. Any presence of a new field keeps the strict eighteen-field guard. */
export function projectInterviewReadRecord(item) {
  if (!plain(item) || hasExtension(item)) return item;
  const projected = {};
  for (const key of [...INTERVIEW_BASE_FIELDS, 'id', 'orgId', 'version', 'createdAt', 'updatedAt']) {
    const field = interviewOwnField(item, key);
    if (!field.valid) return null;
    if (field.present) projected[key] = field.value;
  }
  return projected;
}
function jsonValue(value, ancestors = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return true;
  if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) return false;
  ancestors.add(value);
  const array = Array.isArray(value), keys = Reflect.ownKeys(value), length = array ? Object.getOwnPropertyDescriptor(value, 'length')?.value : 0;
  if (array && (Object.getPrototypeOf(value) !== Array.prototype || !Number.isSafeInteger(length) || length > 100000 || keys.length !== length + 1)) return false;
  for (const key of keys) {
    if (array && key === 'length') continue;
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !field?.enumerable || !Object.hasOwn(field, 'value') || array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)
      || !jsonValue(field.value, ancestors)) return false;
  }
  ancestors.delete(value); return true;
}
export function interviewExtensionRecordValid(item, orgId) {
  if (!plain(item) || Reflect.ownKeys(item).some(key => typeof key !== 'string' || !known.has(key))) return false;
  for (const key of Reflect.ownKeys(item)) { const field = interviewOwnField(item, key); if (!field.valid || !jsonValue(field.value)) return false; }
  const fields = Object.fromEntries(['id', 'orgId', 'version', 'createdAt', 'updatedAt'].map(key => [key, interviewOwnField(item, key)]));
  return Object.values(fields).every(field => field.valid && field.present) && identity(fields.id.value) && identity(fields.orgId.value)
    && fields.orgId.value === orgId && Number.isSafeInteger(fields.version.value) && fields.version.value >= 1
    && (hasExtension(item)
      ? timestamp(fields.createdAt.value) && timestamp(fields.updatedAt.value) && fields.updatedAt.value >= fields.createdAt.value
      : [fields.createdAt.value, fields.updatedAt.value].every(value => typeof value === 'string' && value.length <= 1000))
    && interviewExtensionFieldsValid(item);
}
function interviewer(db, ctx, item, get) {
  const field = interviewOwnField(item, 'interviewerEmployeeId');
  if (!field.valid) return null;
  if (!field.present || field.value === '') return undefined;
  if (!interviewExtensionValueValid('interviewerEmployeeId', field.value)) return null;
  try { const employee = get(db, ctx.orgId, 'employees', field.value);
    const employeeId = interviewOwnField(employee, 'id'), organization = interviewOwnField(employee, 'orgId'), status = interviewOwnField(employee, 'status');
    return [employeeId, organization, status].every(value => value.valid && value.present) && employeeId.value === field.value && organization.value === ctx.orgId && ['active', 'inactive'].includes(status.value) ? employee : null;
  } catch { return null; }
}
export function interviewExtensionVisible(db, ctx, entity, item, get) {
  if (!isInterviewExtensionEntity(entity)) return true;
  return ['admin', 'supervisor'].includes(ctx.role) && interviewExtensionRecordValid(item, ctx.orgId) && interviewer(db, ctx, item, get) !== null;
}
export function interviewExtensionHistoryVisible(db, ctx, entity, snapshot, current, get) {
  if (!isInterviewExtensionEntity(entity)) return true;
  return interviewExtensionVisible(db, ctx, entity, current, get) && interviewExtensionVisible(db, ctx, entity, snapshot, get)
    && snapshot.id === current.id && snapshot.createdAt === current.createdAt && snapshot.version <= current.version;
}
/** REPLACES the old all-string trimming hook for this entity, rather than being called afterwards. */
export function normalizeExtendedInterviewPayload(entity, payload) {
  if (!isInterviewExtensionEntity(entity)) return payload;
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key,
    typeof value === 'string' && (INTERVIEW_BASE_FIELDS.includes(key) || ['availableFrom', 'interviewerEmployeeId', 'decision'].includes(key)) ? value.trim() : value]));
}
/** Before merging PATCH with an old record: explicit decision operations require a current explicit reason. */
export function assertInterviewExtensionPayload(entity, payload, fail, patch = false) {
  if (!isInterviewExtensionEntity(entity)) return;
  const decision = interviewOwnField(payload, 'decision'), reason = interviewOwnField(payload, 'decisionReason');
  if (!decision.valid || !reason.valid) fail(422, 'INVALID_FIELD', '人工評估欄位無法確認。');
  if (decision.present && (patch || decision.value !== 'pending') && (!reason.present || typeof reason.value !== 'string' || !reason.value.trim()))
    fail(422, 'DECISION_REASON_REQUIRED', '本次人工評估操作須明確提供本次原因，不能沿用舊保存值。', { decisionReason: '請填本次人工判斷原因' });
}
/** Add after the existing eight-field validator, inside the generic transaction. No model import or hiring side effects. */
export function validateInterviewExtension(db, ctx, entity, data, old, fail, get) {
  if (!isInterviewExtensionEntity(entity)) return;
  if (!['admin', 'supervisor'].includes(ctx.role)) fail(403, 'ROLE_FORBIDDEN', '只有管理者與督導可維護面試紀錄。');
  if (old && !interviewExtensionVisible(db, ctx, entity, old, get)) fail(404, 'NOT_FOUND', '找不到可維護的面試紀錄。');
  if (old) {
    const stored = get(db, ctx.orgId, entity, old.id);
    if (!plain(stored) || Reflect.ownKeys(stored).some(key => typeof key !== 'string' || !known.has(key))
      || !timestamp(stored.createdAt) || !timestamp(stored.updatedAt))
      fail(409, 'INTERVIEW_LEGACY_READ_ONLY', '此舊面試紀錄僅可閱讀；未知保存欄位或原日期文字須另行核定修復，不能以編輯覆蓋。');
  }
  if (!plain(data) || Reflect.ownKeys(data).some(key => typeof key !== 'string' || !INTERVIEW_LOCAL_FIELDS.includes(key))) fail(422, 'INVALID_FIELD', '面試紀錄含未知欄位。');
  for (const key of INTERVIEW_EXTENSION_FIELDS) {
    const field = interviewOwnField(data, key);
    if (!field.valid || field.present && !interviewExtensionValueValid(key, field.value))
      fail(422, 'INVALID_FIELD', '新增面試欄位格式或長度不符。', { [key]: '請核對本機欄位的型別、格式與字數' });
  }
  if (!interviewExtensionFieldsValid(data)) fail(422, 'DECISION_REASON_REQUIRED', '非待評估意向須保存明確的人工原因。', { decisionReason: '請填人工判斷原因' });
  const employee = interviewer(db, ctx, data, get);
  if (employee === null) fail(422, 'INVALID_REFERENCE', '面試員工不存在或不屬於本機構。', { interviewerEmployeeId: '請選擇同機構員工' });
  const assigned = interviewOwnField(data, 'interviewerEmployeeId'), previous = old ? interviewOwnField(old, 'interviewerEmployeeId') : { present: false };
  if (employee && (!old || !previous.present || assigned.value !== previous.value) && employee.status !== 'active')
    fail(422, 'INACTIVE_INTERVIEWER', '新指派或改派須選擇使用中的同機構員工。', { interviewerEmployeeId: '員工目前已停用' });
}
export const interviewExtensionDecisionLabels = INTERVIEW_DECISIONS;
