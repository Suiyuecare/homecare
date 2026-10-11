import { referenceSnapshotKind, explicitReferenceSpan } from './shift-span.js';
export const SUBSTITUTION_ENTITY = 'shift-substitution-requests';
export const SUBSTITUTION_FIELDS = ['shiftId', 'shiftVersion', 'shiftSnapshot', 'employeeId', 'requesterUserId', 'reason', 'note', 'status', 'reviewedOn', 'reviewReason', 'reviewerUserId', 'replacementEmployeeId', 'replacementShiftVersion', 'replacementShiftSnapshot'];
export const SUBSTITUTION_METADATA = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
export const SUBSTITUTION_SNAPSHOT_FIELDS = ['id', 'orgId', 'version', 'employeeId', 'date', 'startTime', 'endTime'];
export const SUBSTITUTION_STATUSES = { submitted: '待人工審核', approved: '人工核准並已改派', rejected: '人工拒絕' };
export const SUBSTITUTION_LIMITS = Object.fromEntries(SUBSTITUTION_FIELDS.filter(key => !['shiftVersion', 'shiftSnapshot', 'replacementShiftVersion', 'replacementShiftSnapshot'].includes(key)).map(key => [key, ['reason', 'note', 'reviewReason'].includes(key) ? 10000 : key === 'reviewedOn' ? 10 : key === 'status' ? 30 : 100]));
export function substitutionFail(status, code, message, fields) { const error = new Error(message); Object.assign(error, { status, code, ...(fields ? { fields } : {}) }); throw error; }
export function substitutionPlain(value) { return !!value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')); }
export const substitutionClosed = (value, keys) => substitutionPlain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const substitutionId = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && value === value.trim() && !/[\r\n]/.test(value);
export const substitutionVersion = value => Number.isSafeInteger(value) && value > 0;
export const substitutionYear = value => typeof value === 'string' && value.length === 4 && /^\d{4}$/.test(value) && value !== '0000';
export function substitutionDate(value) { if (typeof value !== 'string' || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !substitutionYear(value.slice(0, 4))) return false; const [year, month, day] = value.split('-').map(Number); return month >= 1 && month <= 12 && day >= 1 && day <= [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]; }
export const substitutionTime = value => typeof value === 'string' && value.length === 5 && /^\d{2}:\d{2}$/.test(value) && Number(value.slice(0, 2)) <= 23 && Number(value.slice(3)) <= 59;
export function assertSubstitutionSnapshot(snapshot, fail = substitutionFail) { const explicit = substitutionPlain(snapshot) && Object.hasOwn(snapshot, 'endDate'); if (explicit) { try { if (referenceSnapshotKind(snapshot) !== 'explicit-eight') throw new Error(); explicitReferenceSpan(snapshot); } catch { fail(422, 'SUBSTITUTION_SNAPSHOT_INVALID', '明確結束日班次快照無法確認。'); } } if (!substitutionClosed(snapshot, [...SUBSTITUTION_SNAPSHOT_FIELDS, ...(explicit ? ['endDate'] : [])]) || !['id', 'orgId', 'employeeId'].every(key => substitutionId(snapshot[key])) || !substitutionVersion(snapshot.version) || !substitutionDate(snapshot.date) || !substitutionTime(snapshot.startTime) || !substitutionTime(snapshot.endTime) || !explicit && snapshot.endTime <= snapshot.startTime) fail(422, 'SUBSTITUTION_SNAPSHOT_INVALID', '只接受同日有效班次的七欄保存快照。'); return snapshot; }
export function assertSubstitutionBusiness(value, fail = substitutionFail) {
  const bad = (key, message) => fail(422, 'SUBSTITUTION_DATA_INVALID', message, { [key]: message });
  if (!substitutionClosed(value, SUBSTITUTION_FIELDS)) bad('status', '代班申請須為完整封閉保存欄位。');
  for (const key of Object.keys(SUBSTITUTION_LIMITS)) if (typeof value[key] !== 'string' || value[key].length > SUBSTITUTION_LIMITS[key]) bad(key, '請保存上限內的文字。');
  for (const key of ['shiftId', 'employeeId', 'requesterUserId']) if (!substitutionId(value[key])) bad(key, '保存識別碼無法確認。');
  if (!value.reason.trim()) bad('reason', '本次代班申請原因必填。');
  const source = assertSubstitutionSnapshot(value.shiftSnapshot, fail);
  if (!substitutionVersion(value.shiftVersion) || source.id !== value.shiftId || source.version !== value.shiftVersion || source.employeeId !== value.employeeId) bad('shiftId', '原班次版次與原員工快照不一致。');
  if (!Object.hasOwn(SUBSTITUTION_STATUSES, value.status)) bad('status', '請保存已知人工審核狀態。');
  if (value.status === 'submitted') { if (['reviewedOn', 'reviewReason', 'reviewerUserId', 'replacementEmployeeId'].some(key => value[key] !== '') || value.replacementShiftVersion !== 0 || value.replacementShiftSnapshot !== null) bad('status', '待審核申請不能預填審核或改派結果。'); }
  else {
    if (!substitutionDate(value.reviewedOn) || !value.reviewReason.trim() || !substitutionId(value.reviewerUserId)) bad('reviewReason', '本次人工審核日期、原因及操作者須完整保存。');
    if (value.status === 'rejected') { if (value.replacementEmployeeId !== '' || value.replacementShiftVersion !== 0 || value.replacementShiftSnapshot !== null) bad('status', '拒絕不得保存已改派結果。'); }
    else {
      const after = assertSubstitutionSnapshot(value.replacementShiftSnapshot, fail);
      if (!substitutionId(value.replacementEmployeeId) || value.replacementEmployeeId === value.employeeId || value.shiftVersion >= Number.MAX_SAFE_INTEGER || value.replacementShiftVersion !== value.shiftVersion + 1 || after.version !== value.replacementShiftVersion || after.employeeId !== value.replacementEmployeeId || ['id', 'orgId', 'date', 'startTime', 'endTime', 'endDate'].some(key => Object.hasOwn(after, key) !== Object.hasOwn(source, key) || after[key] !== source[key])) bad('replacementEmployeeId', '核准快照须为原班次同日同時段的一次改派。');
    }
  }
  return value;
}
export function assertSubstitutionItem(value, orgId, fail = substitutionFail) { if (!substitutionClosed(value, [...SUBSTITUTION_FIELDS, ...SUBSTITUTION_METADATA]) || !substitutionId(value.id) || !substitutionId(value.orgId) || orgId && value.orgId !== orgId || !substitutionVersion(value.version) || ['createdAt', 'updatedAt'].some(key => typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 100)) fail(422, 'SUBSTITUTION_DATA_INVALID', '保存識別碼、機構或版次無法確認。'); assertSubstitutionBusiness(Object.fromEntries(SUBSTITUTION_FIELDS.map(key => [key, value[key]])), fail); if (value.shiftSnapshot.orgId !== value.orgId || value.replacementShiftSnapshot && value.replacementShiftSnapshot.orgId !== value.orgId) fail(422, 'SUBSTITUTION_DATA_INVALID', '保存快照必須屬於同機構。'); return value; }
export function substitutionReadModel(item, orgId) { assertSubstitutionItem(item, orgId); return { item: structuredClone(item), year: item.shiftSnapshot.date.slice(0, 4), statusLabel: SUBSTITUTION_STATUSES[item.status], official: false, warning: '人工申請與審核；核准時重新檢查班次、請假與重疊，再一次改派。不推算出勤或薪資。' }; }
