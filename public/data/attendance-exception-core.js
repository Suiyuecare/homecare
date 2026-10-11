import { referenceSnapshotKind, explicitReferenceSpan } from './shift-span.js';
export const ATTENDANCE_EXCEPTION_ENTITY = 'attendance-exceptions';
export const ATTENDANCE_EXCEPTION_FIELDS = ['employeeId', 'date', 'shiftId', 'shiftVersion', 'shiftSnapshot', 'kind', 'reason', 'sourceReference', 'note', 'status', 'resolvedOn', 'resolution', 'voidedOn', 'voidReason'];
export const ATTENDANCE_EXCEPTION_METADATA = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
export const ATTENDANCE_EXCEPTION_KINDS = { lateness: '遲到', early_leave: '早退', missed_clock: '漏打卡', absence: '缺勤', other: '其他人工例外' };
export const ATTENDANCE_EXCEPTION_STATUSES = { recorded: '已記錄', resolved: '人工已處理', voided: '已作廢' };
export const ATTENDANCE_EXCEPTION_REQUIRED = ['employeeId', 'date', 'kind', 'reason', 'sourceReference'];
export const ATTENDANCE_EXCEPTION_LIMITS = { employeeId: 100, date: 10, shiftId: 100, kind: 30, reason: 10000, sourceReference: 10000, note: 10000, status: 20, resolvedOn: 10, resolution: 10000, voidedOn: 10, voidReason: 10000 };
export function attendanceExceptionFail(status, code, message, errors) { const error = new Error(message); Object.assign(error, { status, code, ...(errors ? { errors } : {}) }); throw error; }
export function attendancePlain(value) { return !!value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')); }
export const attendanceClosed = (value, keys) => attendancePlain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const attendanceId = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && value === value.trim() && !/[\r\n]/.test(value);
export const isAttendanceYear = value => typeof value === 'string' && value.length === 4 && /^\d{4}$/.test(value) && value !== '0000';
export function isAttendanceDate(value) { if (typeof value !== 'string' || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !isAttendanceYear(value.slice(0, 4))) return false; const [year, month, day] = value.split('-').map(Number), leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); return month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]; }
export const isAttendanceTime = value => typeof value === 'string' && value.length === 5 && /^\d{2}:\d{2}$/.test(value) && Number(value.slice(0, 2)) <= 23 && Number(value.slice(3)) <= 59;
export const ATTENDANCE_SHIFT_SNAPSHOT_FIELDS = ['id', 'orgId', 'version', 'employeeId', 'date', 'startTime', 'endTime'];
export function assertAttendanceShiftSnapshot(snapshot, item, orgId, fail = attendanceExceptionFail) { const explicit = attendancePlain(snapshot) && Object.hasOwn(snapshot, 'endDate'); if (explicit) { try { if (referenceSnapshotKind(snapshot) !== 'explicit-eight') throw new Error(); explicitReferenceSpan(snapshot); } catch { fail(422, 'ATTENDANCE_SHIFT_SNAPSHOT_INVALID', '保存明確結束日快照無法確認。'); } } if (!attendanceClosed(snapshot, [...ATTENDANCE_SHIFT_SNAPSHOT_FIELDS, ...(explicit ? ['endDate'] : [])]) || !attendanceId(snapshot.id) || !attendanceId(snapshot.orgId) || orgId && snapshot.orgId !== orgId || !Number.isSafeInteger(snapshot.version) || snapshot.version < 1 || snapshot.id !== item.shiftId || snapshot.version !== item.shiftVersion || snapshot.employeeId !== item.employeeId || snapshot.date !== item.date || !isAttendanceDate(snapshot.date) || !isAttendanceTime(snapshot.startTime) || !isAttendanceTime(snapshot.endTime)) fail(422, 'ATTENDANCE_SHIFT_SNAPSHOT_INVALID', '保存班次參照快照無法確認。', { shiftId: '請重新核對保存班次' }); return snapshot; }
export function assertAttendanceExceptionBusiness(value, fail = attendanceExceptionFail) {
  const bad = (key, message) => fail(422, 'ATTENDANCE_EXCEPTION_INVALID', message, { [key]: message });
  if (!attendanceClosed(value, ATTENDANCE_EXCEPTION_FIELDS)) bad('status', '只接受完整已知人工出勤欄位。');
  for (const key of ATTENDANCE_EXCEPTION_FIELDS.filter(key => !['shiftVersion', 'shiftSnapshot'].includes(key))) if (typeof value[key] !== 'string' || value[key].length > ATTENDANCE_EXCEPTION_LIMITS[key]) bad(key, '請保存上限內文字。');
  for (const key of ATTENDANCE_EXCEPTION_REQUIRED) if (!value[key].trim()) bad(key, '此欄位必填。');
  if (!attendanceId(value.employeeId) || value.shiftId !== '' && !attendanceId(value.shiftId)) bad('employeeId', '員工或班次識別碼不合法。');
  if (!value.shiftId) { if (value.shiftVersion !== 0 || value.shiftSnapshot !== null) bad('shiftId', '未參照班次應保存0版次與null快照。'); } else assertAttendanceShiftSnapshot(value.shiftSnapshot, value, undefined, fail);
  if (!isAttendanceDate(value.date)) bad('date', '請保存0001至9999年間有效日期。');
  if (!Object.hasOwn(ATTENDANCE_EXCEPTION_KINDS, value.kind)) bad('kind', '請使用已知人工例外種類。');
  if (!Object.hasOwn(ATTENDANCE_EXCEPTION_STATUSES, value.status)) bad('status', '紀錄狀態不合法。');
  if (value.status === 'recorded' && ['resolvedOn', 'resolution', 'voidedOn', 'voidReason'].some(key => value[key] !== '')) bad('status', '未處理紀錄不可預填結果或作廢資料。');
  if (value.status !== 'recorded' && (!isAttendanceDate(value.resolvedOn) || !value.resolution.trim())) bad('resolution', '人工處理日期與結果需完整保存。');
  if (value.status === 'resolved' && (value.voidedOn !== '' || value.voidReason !== '')) bad('voidReason', '已處理紀錄尚未作廢。');
  if (value.status === 'voided' && (!isAttendanceDate(value.voidedOn) || !value.voidReason.trim())) bad('voidReason', '作廢需保存本次日期與原因。'); return value;
}
export function assertAttendanceExceptionItem(value, orgId, fail = attendanceExceptionFail) { if (!attendanceClosed(value, [...ATTENDANCE_EXCEPTION_FIELDS, ...ATTENDANCE_EXCEPTION_METADATA]) || !attendanceId(value.id) || !attendanceId(value.orgId) || orgId && value.orgId !== orgId || !Number.isSafeInteger(value.version) || value.version < 1 || ['createdAt', 'updatedAt'].some(key => typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 100)) fail(422, 'ATTENDANCE_EXCEPTION_INVALID', '識別碼、機構或保存版次無法確認。'); assertAttendanceExceptionBusiness(Object.fromEntries(ATTENDANCE_EXCEPTION_FIELDS.map(key => [key, value[key]])), fail); if (value.shiftId) assertAttendanceShiftSnapshot(value.shiftSnapshot, value, value.orgId, fail); return value; }
export function attendanceExceptionReadModel(item, orgId) { assertAttendanceExceptionItem(item, orgId); return { item: structuredClone(item), year: item.date.slice(0, 4), kindLabel: ATTENDANCE_EXCEPTION_KINDS[item.kind], official: false, warning: '人工記錄原因與處理結果；不推算打卡事實、出勤時數、請假、薪資或法定認定。' }; }
