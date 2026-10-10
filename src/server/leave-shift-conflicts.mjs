import { HttpError, dateValid, fail, leaveShiftConflicts, now, scopedRows, timeMinute } from './model.mjs';

export function guardLeaveShiftConflicts(ctx) {
  if (!['admin', 'supervisor'].includes(ctx.role)) fail(403, 'ROLE_FORBIDDEN', '僅管理者或督導可查看請假衝突班次');
}

export function validateLeaveShiftConflictsQuery(searchParams) {
  const seen = new Set();
  for (const key of searchParams.keys()) {
    if (!['page', 'pageSize'].includes(key) || seen.has(key)) fail(422, 'INVALID_QUERY', '只接受單一page及pageSize參數');
    seen.add(key);
  }
}

const nullableName = value => typeof value === 'string' && value.length ? value : null;
const employeeView = item => ({ id: item.id, name: nullableName(item.name), employeeNo: nullableName(item.employeeNo), status: item.status });
const caseView = item => item ? { id: item.id, name: nullableName(item.name), caseNo: nullableName(item.caseNo), status: item.status } : null;

/** Fresh current data only. This reader does not approve, reserve or change any row. */
export function readLeaveShiftConflicts(db, ctx, recordId, { page, pageSize }) {
  guardLeaveShiftConflicts(ctx);
  const leave = scopedRows(db, ctx, 'leave-requests').find(item => item.id === recordId);
  if (!leave) fail(404, 'NOT_FOUND', '找不到請假紀錄');
  const employee = scopedRows(db, ctx, 'employees').find(item => item.id === leave.employeeId);
  if (!employee) fail(404, 'NOT_FOUND', '找不到可讀取的請假員工');
  const invalid = () => fail(409, 'CONFLICT_DATA_INVALID', '保存的請假或班次日期時段不合法，請先核對資料');
  if (!dateValid(leave.date)) invalid();

  let conflicts;
  try {
    // Consume every matching candidate before sorting/pagination. A later malformed
    // interval must not produce a misleading empty or partial conflict response.
    conflicts = [...leaveShiftConflicts(leave, scopedRows(db, ctx, 'shifts'))];
  } catch (error) {
    if (error instanceof HttpError && error.code === 'TIME_RANGE') invalid();
    throw error;
  }
  conflicts.sort((a, b) => timeMinute(a.startTime, a.date) - timeMinute(b.startTime, b.date)
    || timeMinute(a.endTime, a.date) - timeMinute(b.endTime, b.date)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const cases = new Map(scopedRows(db, ctx, 'cases').map(item => [item.id, item]));
  // All same-organization record statuses participate in the existing shift lock.
  const recordedShifts = new Set(scopedRows(db, ctx, 'service-records').map(item => item.shiftId));
  const person = employeeView(employee);
  return {
    leave: {
      id: leave.id, version: leave.version, employee: person, date: leave.date,
      startTime: leave.startTime, endTime: leave.endTime, type: leave.type, status: leave.status,
    },
    generatedAt: now(),
    items: conflicts.slice((page - 1) * pageSize, page * pageSize).map(shift => ({
      shiftId: shift.id, version: shift.version, date: shift.date, startTime: shift.startTime, endTime: shift.endTime,
      status: shift.status, employee: person, case: caseView(cases.get(shift.caseId)), hasServiceRecord: recordedShifts.has(shift.id),
    })),
    total: conflicts.length, page, pageSize,
    note: '目前資料的重疊班次；核准時仍會重新檢查。已有服務紀錄的班次不能改派、改時段或取消；沒有服務紀錄仍須通過既有排班驗證。',
  };
}
