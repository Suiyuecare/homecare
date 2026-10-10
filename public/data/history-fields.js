import { normalizeEmployeeRegions } from './employee-regions.js';
import { normalizeAssessmentAnswers, compareAssessmentAnswers } from './assessment-answers.js';

// Business fields only. This module has no DOM, network or mutable shared state.
export const CONTACT_CATEGORIES = Object.freeze([
  { value: 'general', label: '一般聯絡人' },
  { value: 'primary_caregiver', label: '主要照顧者' },
  { value: 'secondary_caregiver', label: '次要照顧者' },
  { value: 'case_manager', label: '個管窗口' },
  { value: 'other', label: '其他' },
].map(item => Object.freeze(item)));
export const CONTACT_STATUSES = Object.freeze([
  { value: 'active', label: '使用中' }, { value: 'inactive', label: '已停用' },
].map(item => Object.freeze(item)));
export const ATTACHMENT_CATEGORIES = Object.freeze([
  { value: 'general', label: '一般文件' }, { value: 'care', label: '照顧文件' },
  { value: 'administrative', label: '行政文件' }, { value: 'other', label: '其他' },
].map(item => Object.freeze(item)));
export const ATTACHMENT_STATUSES = Object.freeze([
  { value: 'active', label: '使用中' }, { value: 'inactive', label: '已停用' },
].map(item => Object.freeze(item)));
const definitions = {
  'personal-calendar-events': [
    { key: 'title', label: '事件標題', type: 'personal-calendar-text' },
    { key: 'date', label: '事件日期', type: 'personal-calendar-date' },
    { key: 'startTime', label: '開始時間', type: 'personal-calendar-text' },
    { key: 'endTime', label: '結束時間', type: 'personal-calendar-text' },
    { key: 'note', label: '備註', type: 'personal-calendar-text' },
    { key: 'status', label: '事件狀態', type: 'personal-calendar-status' },
  ],
  announcements: [
    { key: 'title', label: '公告標題', type: 'announcement-text' },
    { key: 'body', label: '公告內容', type: 'announcement-text' },
    { key: 'audience', label: '閱讀對象', type: 'announcement-audience' },
    { key: 'status', label: '公告狀態', type: 'announcement-status' },
  ],
  assessments: [
    { key: 'caseId', label: '個案', type: 'reference', reference: 'cases' },
    { key: 'templateId', label: '模板', type: 'reference', reference: 'assessment-templates' },
    { key: 'date', label: '填寫日期', type: 'date' },
    { key: 'answers', label: '保存填答', type: 'assessment-answers' },
    { key: 'status', label: '儲存狀態', type: 'assessment-status' },
  ],
  employees: [
    { key: 'name', label: '姓名', type: 'text' },
    { key: 'employeeNo', label: '員工編號', type: 'text' },
    { key: 'role', label: '職務', type: 'text' },
    { key: 'phone', label: '聯絡電話', type: 'text' },
    { key: 'email', label: '電子郵件', type: 'text' },
    { key: 'status', label: '員工狀態', type: 'employee-status' },
    { key: 'qualification', label: '資格與證照', type: 'text' },
    { key: 'regions', label: '服務區域', type: 'regions' },
    { key: 'note', label: '備註', type: 'text' },
    { key: 'hourlyRateCents', label: '試算時薪（新臺幣元）', type: 'trial-price-cents' },
  ],
  'interview-applicants': [
    { key: 'name', label: '姓名', type: 'interview-text' },
    { key: 'phone', label: '電話', type: 'interview-text' },
    { key: 'interviewDate', label: '面試日期', type: 'interview-date' },
    { key: 'city', label: '縣市', type: 'interview-text' },
    { key: 'district', label: '鄉鎮區', type: 'interview-text' },
    { key: 'interviewContent', label: '面試內容', type: 'interview-text' },
    { key: 'note', label: '備註', type: 'interview-text' },
    { key: 'status', label: '名單狀態', type: 'interview-status' },
  ],
  'service-items': [
    { key: 'code', label: '服務代碼', type: 'text' },
    { key: 'name', label: '服務名稱', type: 'text' },
    { key: 'minutes', label: '預設服務分鐘', type: 'minutes' },
    { key: 'unitPriceCents', label: '測試單價（新臺幣元）', type: 'trial-price-cents' },
    { key: 'validFrom', label: '有效起日', type: 'date', emptyLabel: '未設起日' },
    { key: 'validTo', label: '有效迄日', type: 'date', emptyLabel: '未設迄日' },
    { key: 'status', label: '服務項目狀態', type: 'service-item-status' },
    { key: 'note', label: '備註', type: 'text' },
  ],
  'certification-attachments': [
    { key: 'certificationId', label: '證照', type: 'reference', reference: 'employee-certifications' },
    { key: 'employeeId', label: '員工', type: 'reference', reference: 'employees' },
    { key: 'title', label: '附件標題', type: 'text' },
    { key: 'status', label: '附件狀態', type: 'attachment-status' },
    { key: 'note', label: '備註', type: 'text' },
    { key: 'fileName', label: '檔案名稱', type: 'text' },
    { key: 'mimeType', label: '檔案格式', type: 'text' },
    { key: 'sizeBytes', label: '檔案大小', type: 'bytes' },
    { key: 'sha256', label: 'SHA-256校驗碼', type: 'text' },
  ],
  'leave-requests': [
    { key: 'employeeId', label: '員工', type: 'reference', reference: 'employees' },
    { key: 'date', label: '請假日期', type: 'date' },
    { key: 'startTime', label: '開始時間', type: 'text' },
    { key: 'endTime', label: '結束時間', type: 'text' },
    { key: 'type', label: '假別', type: 'text' },
    { key: 'reason', label: '請假原因', type: 'text' },
    { key: 'status', label: '請假狀態', type: 'leave-status' },
  ],
  'employee-certifications': [
    { key: 'employeeId', label: '員工', type: 'reference', reference: 'employees' },
    { key: 'name', label: '證照名稱', type: 'text' },
    { key: 'certificateNo', label: '證照編號', type: 'text' },
    { key: 'issuer', label: '發證單位', type: 'text' },
    { key: 'issuedOn', label: '發證日期', type: 'date' },
    { key: 'expiresOn', label: '到期日期', type: 'date', emptyLabel: '未填到期日' },
    { key: 'status', label: '紀錄狀態', type: 'certification-status' },
    { key: 'note', label: '備註', type: 'text' },
  ],
  'employee-training': [
    { key: 'employeeId', label: '員工', type: 'reference', reference: 'employees' },
    { key: 'name', label: '課程名稱', type: 'text' },
    { key: 'category', label: '訓練類別', type: 'training-category' },
    { key: 'provider', label: '辦訓單位', type: 'text' },
    { key: 'date', label: '訓練日期', type: 'date' },
    { key: 'trainingMinutes', label: '實際訓練時間（分鐘）', type: 'minutes' },
    { key: 'status', label: '紀錄狀態', type: 'training-status' },
    { key: 'note', label: '備註', type: 'text' },
  ],
  cases: [
    { key: 'name', label: '姓名', type: 'text' },
    { key: 'caseNo', label: '案號', type: 'text' },
    { key: 'birthDate', label: '出生日期', type: 'date' },
    { key: 'gender', label: '性別', type: 'text' },
    { key: 'phone', label: '聯絡電話', type: 'text' },
    { key: 'address', label: '服務地址', type: 'text' },
    { key: 'status', label: '個案狀態', type: 'case-status' },
    { key: 'cmsLevel', label: 'CMS 等級', type: 'text' },
    { key: 'welfare', label: '福利身分別', type: 'text' },
    { key: 'supervisorId', label: '主責督導', type: 'reference', reference: 'employees' },
    { key: 'primaryCarer', label: '主要照顧者', type: 'text' },
    { key: 'contactName', label: '聯絡人姓名', type: 'text' },
    { key: 'contactPhone', label: '聯絡人電話', type: 'text' },
    { key: 'note', label: '照顧注意事項', type: 'text' },
  ],
  'care-plans': [
    { key: 'caseId', label: '個案', type: 'reference', reference: 'cases' },
    { key: 'validFrom', label: '生效日期', type: 'date' },
    { key: 'validTo', label: '結束日期', type: 'date' },
    { key: 'status', label: '計畫狀態', type: 'plan-status' },
    { key: 'services', label: '服務項目與計畫數量', type: 'services', reference: 'service-items', quantityLabel: '計畫數量' },
    { key: 'goals', label: '照顧目標', type: 'text' },
    { key: 'note', label: '計畫備註', type: 'text' },
  ],
  shifts: [
    { key: 'caseId', label: '個案', type: 'reference', reference: 'cases' },
    { key: 'employeeId', label: '服務人員', type: 'reference', reference: 'employees' },
    { key: 'carePlanId', label: '照顧計畫', type: 'reference', reference: 'care-plans' },
    { key: 'date', label: '服務日期', type: 'date' },
    { key: 'startTime', label: '開始時間', type: 'text' },
    { key: 'endTime', label: '結束時間', type: 'text' },
    { key: 'services', label: '服務項目與排班數量', type: 'services', reference: 'service-items', quantityLabel: '排班數量' },
    { key: 'status', label: '班次狀態', type: 'shift-status' },
    { key: 'note', label: '交班備註', type: 'text' },
  ],
  'service-records': [
    { key: 'shiftId', label: '關聯班次', type: 'reference', reference: 'shifts' },
    { key: 'caseId', label: '個案', type: 'reference', reference: 'cases' },
    { key: 'employeeId', label: '服務人員', type: 'reference', reference: 'employees' },
    { key: 'date', label: '服務日期', type: 'date' },
    { key: 'actualStart', label: '實際開始時間', type: 'text' },
    { key: 'actualEnd', label: '實際結束時間', type: 'text' },
    { key: 'services', label: '服務項目與實際數量', type: 'services', reference: 'service-items', quantityLabel: '實際數量' },
    { key: 'status', label: '服務紀錄狀態', type: 'service-record-status' },
    { key: 'note', label: '服務紀錄與觀察', type: 'text' },
    { key: 'reviewNote', label: '核閱說明', type: 'text' },
  ],
  'case-contacts': [
    { key: 'caseId', label: '個案', type: 'reference', reference: 'cases' },
    { key: 'name', label: '聯絡人姓名', type: 'text' },
    { key: 'category', label: '聯絡人分類', type: 'contact-category' },
    { key: 'relationship', label: '關係', type: 'text' },
    { key: 'phone', label: '主要電話', type: 'text' },
    { key: 'alternatePhone', label: '其他電話', type: 'text' },
    { key: 'email', label: '電子信箱', type: 'text' },
    { key: 'organization', label: '所屬單位', type: 'text' },
    { key: 'status', label: '聯絡人狀態', type: 'contact-status' },
    { key: 'note', label: '備註', type: 'text' },
  ],
  'case-status-followups': [
    { key: 'caseId', label: '個案', type: 'reference', reference: 'cases' },
    { key: 'kind', label: '追蹤類型', type: 'case-followup-kind' },
    { key: 'startDate', label: '開始日期', type: 'date' },
    { key: 'endDate', label: '結束日期', type: 'date' },
    { key: 'reason', label: '原因', type: 'text' },
    { key: 'followUpDate', label: '追蹤日期', type: 'date' },
    { key: 'outcome', label: '追蹤結果', type: 'text' },
    { key: 'note', label: '備註', type: 'text' },
    { key: 'status', label: '追蹤狀態', type: 'case-followup-status' },
  ],
  'case-attachments': [
    { key: 'caseId', label: '個案', type: 'reference', reference: 'cases' },
    { key: 'title', label: '附件標題', type: 'text' },
    { key: 'category', label: '附件分類', type: 'attachment-category' },
    { key: 'status', label: '附件狀態', type: 'attachment-status' },
    { key: 'note', label: '備註', type: 'text' },
    { key: 'fileName', label: '檔案名稱', type: 'text' },
    { key: 'mimeType', label: '檔案格式', type: 'text' },
    { key: 'sizeBytes', label: '檔案大小', type: 'bytes' },
    { key: 'sha256', label: 'SHA-256 校驗碼', type: 'text' },
  ],
};
export const HISTORY_FIELDS = Object.freeze(Object.fromEntries(
  Object.entries(definitions).map(([entity, fields]) => [entity, Object.freeze(fields.map(item => Object.freeze(item)))]),
));

export function getHistoryFields(entity) {
  if (!Object.hasOwn(HISTORY_FIELDS, entity)) throw new Error('不支援此資料類型的版本差異。');
  return HISTORY_FIELDS[entity];
}

function scalar(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  // Unsupported objects are never serialized, so embedded price/metadata cannot leak.
  return '[欄位格式無法判讀]';
}

// Announcement writes accept strings. Imported unsupported values use a tag,
// so a legitimate literal placeholder remains distinct and no nested data leaks.
function announcementText(value) {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' ? value : Object.freeze({ invalid: true });
}

/** Display saved synthetic cents exactly; never infer or coerce a valid price. */
export function formatTrialPriceCents(value) {
  const saved = scalar(value);
  if (saved === null) return '未提供';
  if (!Number.isSafeInteger(saved) || saved < 0) return `${saved}（金額無法判讀）`;
  const cents = BigInt(saved);
  return `新臺幣 ${cents / 100n}.${String(cents % 100n).padStart(2, '0')} 元（保存 ${saved} 分）`;
}

function services(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!Array.isArray(value)) return '[欄位格式無法判讀]';
  return value.map(item => ({
    serviceItemId: scalar(item?.serviceItemId),
    quantity: scalar(item?.quantity),
  })).sort((left, right) => {
    const a = JSON.stringify(left.serviceItemId), b = JSON.stringify(right.serviceItemId);
    if (a !== b) return a < b ? -1 : 1;
    const x = JSON.stringify(left.quantity), y = JSON.stringify(right.quantity);
    return x === y ? 0 : x < y ? -1 : 1;
  });
}

export function normalizeHistorySnapshot(entity, snapshot, templatesMap) {
  const source = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
  return Object.fromEntries(getHistoryFields(entity).map(field => [
    field.key, ['announcements', 'interview-applicants', 'personal-calendar-events'].includes(entity) ? announcementText(source[field.key])
      : field.type === 'assessment-answers' ? normalizeAssessmentAnswers(source, templatesMap)
      : field.type === 'services' ? services(source[field.key])
      : field.type === 'regions' ? normalizeEmployeeRegions(source[field.key]) : scalar(source[field.key]),
  ]));
}

/** Compare an explicitly authorized pair. The caller must not infer adjacency. */
export function diffHistorySnapshots(entity, previous, current, templatesMap) {
  const before = normalizeHistorySnapshot(entity, previous, templatesMap);
  const after = normalizeHistorySnapshot(entity, current, templatesMap);
  return getHistoryFields(entity)
    .filter(field => {
      if (field.type !== 'assessment-answers') return JSON.stringify(before[field.key]) !== JSON.stringify(after[field.key]);
      const comparison = compareAssessmentAnswers(previous, current, templatesMap);
      return comparison.mode === 'template-changed' || comparison.containerChanged || comparison.changes.length;
    })
    .map(field => ({ ...field, before: before[field.key], after: after[field.key] }));
}
