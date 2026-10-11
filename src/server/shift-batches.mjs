import { spanIntervalsOverlap } from './shift-span.mjs';
import { HttpError, fail, get, rows, business, validatePayload, validate, writeGuard, interval, overlaps, replace, audit, id, publicRecord } from './model.mjs';

export const MAX_SHIFT_BATCH_ITEMS = 50;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const identity = value => typeof value === 'string' && Boolean(value.trim()) && value === value.trim() && value.length <= 500;
export function guardShiftBatchAccess(ctx) {
  if (!['admin', 'supervisor'].includes(ctx.role)) fail(403, 'ROLE_FORBIDDEN', '只有管理者或督導可批次改派及取消班次');
}
export function shiftBatchQuery(params) {
  if ([...params.keys()].length) fail(422, 'INVALID_QUERY', '批次排班不接受查詢參數');
}
/** Closed syntax; every selected row is an explicit current id/version pair. */
export function shiftBatchDefinition(payload) {
  if (!plain(payload)) fail(400, 'INVALID_BODY', '請提供JSON物件');
  for (const key of Object.keys(payload)) if (!['action', 'items', 'employeeId', 'reason'].includes(key)) fail(422, 'UNKNOWN_FIELD', '不允許的批次欄位', { [key]: '未知欄位' });
  if (!['reassign', 'cancel'].includes(payload.action)) fail(422, 'INVALID_ACTION', '請選擇改派或取消', { action: '不合法的操作' });
  if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length > MAX_SHIFT_BATCH_ITEMS) fail(422, 'INVALID_SELECTION', '請明確選取1至50筆班次', { items: '請選擇1至50筆班次' });
  const seen = new Set();
  for (const item of payload.items) {
    if (!plain(item) || Object.keys(item).length !== 2 || Object.keys(item).some(key => !['id', 'version'].includes(key)) || !identity(item.id)
      || !Number.isSafeInteger(item.version) || item.version < 1 || seen.has(item.id)) fail(422, 'INVALID_SELECTION', '班次選取需為不重複的識別碼與目前版次', { items: '請重新選取班次' });
    seen.add(item.id);
  }
  if (typeof payload.reason !== 'string' || !payload.reason.trim() || payload.reason.length > 2000) fail(422, 'REASON_REQUIRED', '請填寫本次批次操作原因，最多2000字', { reason: '本次原因必填，最多2000字' });
  if (payload.action === 'reassign' ? !identity(payload.employeeId) : Object.hasOwn(payload, 'employeeId')) fail(422, 'INVALID_EMPLOYEE', '改派須指定員工；取消不接受改派員工', { employeeId: '請核對本次操作' });
  return { action: payload.action, items: payload.items.map(item => ({ id: item.id, version: item.version })), ...(payload.action === 'reassign' ? { employeeId: payload.employeeId } : {}), reason: payload.reason };
}
const problem = error => ({ code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) });
function eligible(db, ctx, selection, definition) {
  const old = get(db, ctx.orgId, 'shifts', selection.id);
  if (!old) fail(404, 'NOT_FOUND', '班次不存在或不屬於本機構');
  if (old.version !== selection.version) fail(409, 'VERSION_CONFLICT', '班次版次已更新，請重新讀取');
  if (old.status !== 'scheduled') fail(409, 'SHIFT_NOT_SCHEDULED', '只能操作目前尚未執行的排定班次');
  if (rows(db, ctx.orgId, 'service-records').some(record => record.shiftId === old.id)) fail(409, 'SHIFT_HAS_RECORD', '班次已有服務紀錄，不能批次改派或取消');
  if (definition.action === 'reassign') {
    const employee = get(db, ctx.orgId, 'employees', definition.employeeId);
    if (!employee || employee.status !== 'active') fail(422, 'INVALID_EMPLOYEE', '改派員工須為本機構使用中的員工');
    if (old.employeeId === definition.employeeId) fail(409, 'ASSIGNMENT_UNCHANGED', '此班次已由指定員工負責，請取消選取');
  }
  // Validate the complete preserved business payload, not merely the two edits.
  const data = validatePayload('shifts', { ...business(old), ...(definition.action === 'reassign' ? { employeeId: definition.employeeId } : { status: 'cancelled' }) });
  writeGuard(ctx, 'shifts', data, old); validate(db, ctx, 'shifts', data, old);
  return { old, data };
}
/** Read-only preview. No token, temporary record or writable draft is created. */
export function previewShiftBatch(db, ctx, payload) {
  guardShiftBatchAccess(ctx); const definition = shiftBatchDefinition(payload), candidates = new Map();
  const items = definition.items.map(selection => {
    try {
      const candidate = eligible(db, ctx, selection, definition); candidates.set(selection.id, candidate);
      return { id: selection.id, version: selection.version, status: 'ready', before: publicRecord(ctx, candidate.old), after: candidate.data, conflicts: [] };
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return { id: selection.id, version: selection.version, status: 'conflict', conflicts: [problem(error)] };
    }
  });
  // Existing validation sees stored assignments. Check the final assignments
  // between selected rows as well, without temporarily changing the database.
  if (definition.action === 'reassign') for (let left = 0; left < items.length; left++) for (let right = left + 1; right < items.length; right++) {
    const a = candidates.get(items[left].id)?.data, b = candidates.get(items[right].id)?.data; if (!a || !b) continue;
    if ((a.employeeId === b.employeeId || a.caseId === b.caseId) && spanIntervalsOverlap('shifts', a, 'shifts', b, fail)) for (const item of [items[left], items[right]]) {
      if (!item.conflicts.some(conflict => conflict.code === 'BATCH_SHIFT_CONFLICT')) item.conflicts.push({ code: 'BATCH_SHIFT_CONFLICT', message: '選取的班次在改派後互相重疊，請調整選取' });
      item.status = 'conflict';
    }
  }
  const conflictCount = items.filter(item => item.status === 'conflict').length;
  return { definition, items, total: items.length, readyCount: items.length - conflictCount, conflictCount, canCommit: conflictCount === 0 };
}
/** Caller MUST wrap this in its single idem()/BEGIN IMMEDIATE transaction. */
export function commitShiftBatch(db, ctx, payload) {
  guardShiftBatchAccess(ctx);
  if (!db.isTransaction) fail(500, 'BATCH_TRANSACTION_REQUIRED', '批次保存必須在單一交易內執行');
  const preview = previewShiftBatch(db, ctx, payload);
  if (!preview.canCommit) { const error = new HttpError(409, 'BATCH_CONFLICT', '整批重新檢查有衝突，沒有班次已保存'); error.details = { preview }; throw error; }
  const batchId = id(), items = [];
  for (const selection of preview.definition.items) {
    const { old, data } = eligible(db, ctx, selection, preview.definition), item = replace(db, ctx.orgId, 'shifts', old, data);
    audit(db, ctx, 'record.update', 'shifts', item.id, { operation: 'shift-batches', action: preview.definition.action, batchId, reason: preview.definition.reason,
      fields: [preview.definition.action === 'reassign' ? 'employeeId' : 'status'], fromStatus: old.status, toStatus: item.status, version: item.version });
    items.push(publicRecord(ctx, item));
  }
  return { batchId, action: preview.definition.action, reason: preview.definition.reason, items, total: items.length };
}
