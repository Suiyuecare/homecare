import { CASE_HEALTH_PROFILES } from './case-health-editor.js';
import { CASE_SUPPORT_PROFILES } from './case-support-editor.js';
import { financialHistoryLines, financialHistorySummary, financialHistoryParty } from './financial-history.js';
import { claimSourcesForDisplay, claimResponsesForDisplay, claimSummaryForDisplay, claimUnconfirmedAmountCents } from './claim-batch-editor.js';
import { normalizeEmployeeRegions } from './employee-regions.js';
import { RULE_PARAMETERS } from './business-rule-fields.js';
import { normalizeAssessmentAnswers, compareAssessmentAnswers } from './assessment-answers.js';
import { customFormHistoryProjection } from './custom-form-history.js';
import { SHIFT_SERIES_FIELDS, SHIFT_SERIES_OPTIONAL_FIELDS, SHIFT_SERIES_LABELS } from './shift-series-editor.js';
import { CASE_FAMILY_PROFILES } from './case-family-editor.js';
import { substitutionHistoryFields } from './shift-substitution-editor.js';
import { assertSubstitutionSnapshot, SUBSTITUTION_SNAPSHOT_FIELDS } from './shift-substitution-core.js';
import { contractDeadlineFields, contractDeadlineLabels, contractDeadlineSnapshotRows } from './contract-deadline-editor.js';
import { attendanceExceptionHistoryFields } from './attendance-exception-editor.js';
import { assertInternalNotificationItem, INTERNAL_NOTIFICATION_LABELS } from './internal-notification-editor.js';
import { assertAttendanceShiftSnapshot } from './attendance-exception-core.js';
import { INTERVIEW_EXTENSION_FIELDS, INTERVIEW_EXTENSION_LABELS } from './interview-extension-editor.js';

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
  'institution-holidays': [['date','指定日期','date'],['title','名稱'],['kind','人工類型','holiday-kind'],['sourceReference','人工指定依據'],['note','備註'],['status','狀態','contact-status']].map(([key,label,type='text'])=>({key,label,type})),
  'case-contact-footprints': [['caseId','所屬個案','reference','cases'],['date','接觸日期','date'],['time','接觸時間'],['location','地點'],['contactDescription','人工接觸描述'],['relatedCaseId','相關個案','reference','cases'],['source','人工來源'],['status','狀態','contact-status'],['note','備註']].map(([key,label,type='text',reference])=>({key,label,type,...(reference?{reference}:{})})),
  'employee-training-credits': [['employeeId','員工','reference','employees'],['date','活動日期','date'],['activityName','活動名稱'],['provider','辦理單位'],['creditValue','人工積分原值'],['creditUnit','原值單位'],['sourceReference','原值依據'],['reference','參考資料'],['note','備註'],['status','狀態','training-credit-status'],['verifiedOn','本次核對日期','date'],['verificationBasis','核對依據'],['voidedOn','本次作廢日期','date'],['voidReason','作廢原因']].map(([key,label,type='text',reference])=>({key,label,type,...(reference?{reference}:{})})),
  'shift-series': [...SHIFT_SERIES_FIELDS, ...SHIFT_SERIES_OPTIONAL_FIELDS].map(key=>({key,label:SHIFT_SERIES_LABELS[key],type:({caseId:'reference',employeeId:'reference',carePlanId:'reference',startDate:'date',endDate:'date',weekdays:'series-weekdays',services:'services',status:'series-status',endDay:'series-end-day'})[key]||'text',...({caseId:'cases',employeeId:'employees',carePlanId:'care-plans'}[key]?{reference:({caseId:'cases',employeeId:'employees',carePlanId:'care-plans'})[key]}:{})})),
  'case-contracts': [['caseId','個案','reference','cases'],['number','契約編號'],['title','契約名稱'],['startDate','開始日期','date'],['endDate','結束日期','date'],['signedDate','人工記錄簽署日期','date'],['documentReference','契約文件參考'],['sourceReference','人工依據'],['renewedFromId','原契約識別碼'],['status','狀態','contract-status'],['statusDate','本次處理日期','date'],['statusReason','本次處理原因'],['note','備註']].map(([key,label,type='text',reference])=>({key,label,type,...(reference?{reference}:{})})),
  'internal-tasks': [['title','待辦標題'],['content','工作內容'],['assigneeEmployeeId','負責員工','reference','employees'],['dueDate','預定完成日','date'],['priority','優先程度','task-priority'],['status','狀態','task-status'],['statusDate','本次處理日期','date'],['result','完成結果'],['statusReason','取消原因'],['note','備註']].map(([key,label,type='text',reference])=>({key,label,type,...(reference?{reference}:{})})),
  'form-templates': [['code','模板代碼'],['name','模板名稱'],['description','說明'],['revision','修訂序號'],['previousTemplateId','原模板識別碼'],['groups','題項群組','form-groups'],['fields','保存題項與条件','form-fields'],['status','狀態','form-template-status'],['note','備註']].map(([key,label,type='text'])=>({key,label,type})),
  'form-records': [['caseId','個案','reference','cases'],['templateId','保存模板識別碼'],['templateVersion','保存模板SQL版次'],['date','填寫日期','date'],['templateSnapshot','保存模板定義','form-snapshot'],['answers','保存填答','form-answers'],['attachmentIds','引用附件識別碼','form-attachment-ids'],['status','狀態','form-record-status'],['note','備註']].map(([key,label,type='text',reference])=>({key,label,type,...(reference?{reference}:{})})),
  'claim-batches': [
    { key: 'month', label: '批次月份', type: 'text' }, { key: 'number', label: '批次編號', type: 'text' },
    { key: 'billingDocumentIds', label: '保存來源帳單識別碼', type: 'claim-ids' }, { key: 'sourceSnapshots', label: '核對來源快照', type: 'claim-sources' },
    { key: 'sourceReference', label: '批次人工依據', type: 'text' }, { key: 'responseSourceReference', label: '收到回應的共同依據', type: 'text' },
    { key: 'responses', label: '人工記錄回應', type: 'claim-responses' }, { key: 'summary', label: '保存對帳合計', type: 'claim-summary' },
    { key: 'status', label: '狀態', type: 'claim-status' }, { key: 'note', label: '備註／取消原因', type: 'text' },
  ],
  ...Object.fromEntries(Object.entries(CASE_HEALTH_PROFILES).map(([entity, profile]) => [entity, [{ key: 'caseId', label: '個案', type: 'reference', reference: 'cases' }, ...profile.fields.map(key => ({ key, label: profile.labels[key], type: key === 'status' ? 'contact-status' : ['date', 'followUpDate'].includes(key) ? 'date' : 'text' }))]])),
  'billing-documents': [
    { key: 'caseId', label: '個案', type: 'reference', reference: 'cases' }, { key: 'caseSnapshot', label: '帳單保存個案資料', type: 'financial-party' },
    { key: 'month', label: '月份', type: 'text' }, { key: 'number', label: '帳單編號', type: 'text' }, { key: 'lineItems', label: '帳單明細', type: 'billing-line-items' },
    { key: 'summary', label: '保存金額', type: 'financial-summary' }, { key: 'sourceReference', label: '人工計價依據', type: 'text' }, { key: 'status', label: '狀態', type: 'billing-status' }, { key: 'note', label: '備註／作廢原因', type: 'text' },
  ],
  'payment-receipts': [
    { key: 'billingDocumentId', label: '父帳單識別碼', type: 'text' }, { key: 'date', label: '收款日期', type: 'date' }, { key: 'amountCents', label: '保存收款金額', type: 'trial-price-cents' },
    { key: 'method', label: '人工記錄收款方式', type: 'receipt-method' }, { key: 'reference', label: '人工收款參考', type: 'text' }, { key: 'status', label: '狀態', type: 'receipt-status' }, { key: 'note', label: '備註／取消原因', type: 'text' },
  ],
  'payroll-statements': [
    { key: 'employeeId', label: '員工', type: 'reference', reference: 'employees' }, { key: 'employeeSnapshot', label: '結算保存員工資料', type: 'financial-party' },
    { key: 'month', label: '月份', type: 'text' }, { key: 'number', label: '結算編號', type: 'text' }, { key: 'lineItems', label: '人工加減項', type: 'payroll-line-items' },
    { key: 'summary', label: '保存合計', type: 'financial-summary' }, { key: 'sourceReference', label: '人工核定依據', type: 'text' }, { key: 'status', label: '狀態', type: 'payroll-status' }, { key: 'note', label: '備註／取消原因', type: 'text' },
  ],
  'institution-events': [['title','標題','text'], ['date','日期','date'], ['startTime','開始時間','text'], ['endTime','結束時間','text'], ['category','分類','institution-event-category'], ['location','地點','text'], ['note','備註','text'], ['status','狀態','institution-event-status']].map(([key,label,type])=>({key,label,type})),
  complaints: [['title','標題'], ['receivedDate','受理日期','date'], ['category','分類','complaint-category'], ['content','申訴內容'], ['receiverEmployeeId','受理員工','reference','employees'], ['responsibleEmployeeId','負責員工','reference','employees'], ['caseId','相關個案','reference','cases'], ['employeeId','相關員工','reference','employees'], ['handlingLog','處理紀錄'], ['resolution','處理結果／取消原因'], ['closedDate','結案日期','date'], ['status','狀態','complaint-status']].map(([key,label,type='text',reference])=>({key,label,type,...(reference?{reference}:{})})),
  ...Object.fromEntries(Object.entries(CASE_SUPPORT_PROFILES).map(([entity, profile]) => [entity, [{ key: 'caseId', label: '個案', type: 'reference', reference: 'cases' }, ...profile.fields.map(key => ({ key, label: profile.labels[key], type: key === 'status' ? 'contact-status' : ['date', 'followUpDate'].includes(key) ? 'date' : 'text' }))]])),
  'business-rules': [
    { key: 'kind', label: '規則類型', type: 'text' }, { key: 'code', label: '規則代碼', type: 'text' }, { key: 'name', label: '規則名稱', type: 'text' },
    { key: 'validFrom', label: '生效日期', type: 'date' }, { key: 'validTo', label: '截止日期', type: 'date' }, { key: 'sourceReference', label: '核定依據', type: 'text' },
    { key: 'parameters', label: '核定參數', type: 'business-rule-parameters' }, { key: 'status', label: '狀態', type: 'text' }, { key: 'note', label: '適用方式與備註', type: 'text' },
  ],
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
  'shift-substitution-requests': substitutionHistoryFields,
  'internal-notifications': ['title','body','recipientUserIds','status','note','cancellationReason','publication','publicationVersion','publishedAt','publisher','recipientSnapshot'].map(key=>({key,label:INTERNAL_NOTIFICATION_LABELS[key]||({publicationVersion:'精確發布版次',publishedAt:'保存發布時間',publisher:'保存發布者',recipientSnapshot:'本人保存收件快照'})[key],type:key==='status'?'internal-notification-status':key==='recipientUserIds'?'notification-recipient-ids':key==='publication'?'notification-publication':['publisher','recipientSnapshot'].includes(key)?'notification-person':'text'})),
  'contract-deadline-reminders': contractDeadlineFields.map(key=>({key,label:contractDeadlineLabels[key],type:key==='contractSnapshot'?'deadline-source-snapshot':key==='assigneeEmployeeId'?'reference':key==='status'?'deadline-status':key==='priority'?'deadline-priority':['dueDate','statusDate'].includes(key)?'date':'text',...(key==='assigneeEmployeeId'?{reference:'employees'}:{})})),
  'attendance-exceptions': attendanceExceptionHistoryFields,
  ...Object.fromEntries(Object.entries(CASE_FAMILY_PROFILES).map(([entity,p])=>[entity,p.fields.map(key=>({key,label:p.labels[key],type:key==='caseId'?'reference':key==='kind'?'family-kind':key==='status'?'contact-status':'text',...(key==='caseId'?{reference:'cases'}:['fromMemberId','toMemberId'].includes(key)?{type:'reference',reference:'case-family-members'}:{})}))])),
  'interview-applicants': [
    { key: 'name', label: '姓名', type: 'interview-text' },
    { key: 'phone', label: '電話', type: 'interview-text' },
    { key: 'interviewDate', label: '面試日期', type: 'interview-date' },
    { key: 'city', label: '縣市', type: 'interview-text' },
    { key: 'district', label: '鄉鎮區', type: 'interview-text' },
    { key: 'interviewContent', label: '面試內容', type: 'interview-text' },
    { key: 'note', label: '備註', type: 'interview-text' },
    { key: 'status', label: '名單狀態', type: 'interview-status' },
    ...INTERVIEW_EXTENSION_FIELDS.map(key => ({key,label:INTERVIEW_EXTENSION_LABELS[key],type:key==='interviewerEmployeeId'?'reference':key==='decision'?'interview-decision':key==='availableFrom'?'date':'text',...(key==='interviewerEmployeeId'?{reference:'employees'}:{})}))
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
    { key: 'endDate', label: '明確請假結束日期（舊格式未另存）', type: 'date' },
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
    { key: 'endDate', label: '明確班次結束日期（舊格式未另存）', type: 'date' },
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
    { key: 'actualEndDate', label: '明確實際結束日期（舊格式未另存）', type: 'date' },
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

function claimHistoryIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) return '[欄位格式無法判讀]';
  const output = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || !descriptor.value.trim()) return '[欄位格式無法判讀]';
    output.push({ id: descriptor.value });
  }
  return output;
}
function claimHistorySummary(value) {
  const summary = claimSummaryForDisplay(value);
  if (!summary) return '[欄位格式無法判讀]';
  return [['amountCents', '保存來源總額'], ['acceptedAmountCents', '人工已記接受金額'], ['rejectedAmountCents', '人工記錄退件來源額'],
    ['pendingAmountCents', '尚待確認差額（含待定）'], ['unansweredAmountCents', '尚無回應來源額'], ['sourceCount', '來源筆數'], ['responseCount', '人工回應筆數']]
    .map(([key, label]) => ({ label, value: summary[key], isMoney: key.endsWith('Cents') }));
}
function claimHistoryResponses(value, sources) {
  const responses = claimResponsesForDisplay(value, sources);
  if (!responses) return '[欄位格式無法判讀]';
  if (!responses.some(row => row.status === 'partial')) return responses;
  const frozen = new Map(claimSourcesForDisplay(sources).map(row => [row.billingDocumentId, row]));
  return responses.map(row => ({ ...row, sourceAmountCents: frozen.get(row.billingDocumentId).amountCents,
    unconfirmedAmountCents: claimUnconfirmedAmountCents(frozen.get(row.billingDocumentId), row) }));
}
function substitutionSnapshotDisplay(value) {
  if(value===null)return [];
  try{const snapshot=assertSubstitutionSnapshot(value);const labels={id:'保存班次識別碼',orgId:'保存機構識別碼',version:'保存班次版次',employeeId:'保存員工識別碼',date:'保存班次日期',startTime:'保存開始時間',endTime:'保存結束時間',endDate:'保存明確結束日期'};return [...SUBSTITUTION_SNAPSHOT_FIELDS,...(Object.hasOwn(snapshot,'endDate')?['endDate']:[])].map(key=>({label:labels[key],value:String(snapshot[key])}));}catch{return '[欄位格式無法判讀]';}
}
function notificationPersonRows(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return '[欄位格式無法判讀]';
  const keys=['userId','userName','role'];if(Reflect.ownKeys(value).length!==3||keys.some(key=>{const d=Object.getOwnPropertyDescriptor(value,key);return !d?.enumerable||!Object.hasOwn(d,'value')||typeof d.value!=='string';}))return '[欄位格式無法判讀]';
  return keys.map(key=>({label:({userId:'保存成員識別碼',userName:'保存姓名',role:'保存角色'})[key],value:value[key]}));
}
function notificationProjection(raw){
  try{const descriptor=Object.getOwnPropertyDescriptor(raw,'orgId');if(!descriptor||!Object.hasOwn(descriptor,'value'))return null;
    const item=assertInternalNotificationItem(raw,{orgId:descriptor.value,role:'admin'});
    return {ids:item.recipientUserIds.map(value=>({label:'明確指定收件人識別碼',value})),publication:item.publication===null?[]:[{label:'精確發布版次',value:String(item.publication.publicationVersion)},{label:'發布標題原文',value:item.publication.title},{label:'發布全文原文',value:item.publication.body},{label:'保存發布時間',value:item.publication.publishedAt},...notificationPersonRows(item.publication.publisher).map(row=>({label:'發布者 · '+row.label,value:row.value})),...item.publication.recipientSnapshots.flatMap((person,index)=>notificationPersonRows(person).map(row=>({label:'指定收件人'+(index+1)+' · '+row.label,value:row.value})))]};
  }catch{return null;}
}
function attendanceSnapshotDisplay(source) {
  if (source.shiftSnapshot === null && source.shiftId === '' && source.shiftVersion === 0) return [];
  try {
    const snapshot = assertAttendanceShiftSnapshot(source.shiftSnapshot, source);
    const labels = {id:'保存班次識別碼',orgId:'保存機構識別碼',version:'保存班次版次',employeeId:'保存員工識別碼',date:'保存班次日期',startTime:'保存開始時間',endTime:'保存結束時間'};
    return [...Object.entries(labels), ...(Object.hasOwn(snapshot, 'endDate') ? [['endDate', '保存明確結束日期']] : [])].map(([key,label]) => ({label,value:String(snapshot[key])}));
  } catch { return '[欄位格式無法判讀]'; }
}
export function normalizeHistorySnapshot(entity, snapshot, templatesMap) {
  const raw = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
  const source = ['contract-deadline-reminders','shift-substitution-requests','internal-notifications','case-family-members','case-family-links','attendance-exceptions','interview-applicants','case-contact-footprints','institution-holidays','employee-training-credits','claim-batches','shift-series','case-contracts','internal-tasks','form-templates','form-records'].includes(entity) ? Object.fromEntries(getHistoryFields(entity).map(field => {
    const descriptor = Object.getOwnPropertyDescriptor(raw, field.key);
    return [field.key, descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined];
  })) : raw;
  const formProjection=['form-templates','form-records'].includes(entity)?customFormHistoryProjection(entity,raw):null;
  const notification=entity==='internal-notifications'?notificationProjection(raw):null;
  return Object.fromEntries(getHistoryFields(entity).map(field => [
    field.key, field.type === 'notification-recipient-ids' ? notification?.ids ?? []
      : field.type === 'notification-publication' ? notification?.publication ?? []
      : field.type === 'notification-person' ? source[field.key]===undefined?[]:notificationPersonRows(source[field.key])
      : field.type === 'deadline-source-snapshot' ? contractDeadlineSnapshotRows(source[field.key]) ?? '[欄位格式無法判讀]'
      : field.type === 'substitution-shift-snapshot' ? substitutionSnapshotDisplay(source[field.key])
      : field.type === 'attendance-shift-snapshot' ? attendanceSnapshotDisplay(source)
      : ['announcements', 'interview-applicants', 'personal-calendar-events'].includes(entity) ? announcementText(source[field.key])
      : field.type === 'claim-ids' ? claimHistoryIds(source[field.key])
      : field.type === 'claim-sources' ? claimSourcesForDisplay(source[field.key]) ?? '[欄位格式無法判讀]'
      : field.type === 'claim-responses' ? claimHistoryResponses(source[field.key], source.sourceSnapshots)
      : field.type === 'claim-summary' ? claimHistorySummary(source[field.key])
      : field.type === 'form-groups' ? formProjection?.groups ?? '[欄位格式無法判讀]'
      : field.type === 'form-fields' ? formProjection?.fields ?? '[欄位格式無法判讀]'
      : field.type === 'form-snapshot' ? formProjection?.template ?? '[欄位格式無法判讀]'
      : field.type === 'form-answers' ? formProjection?.answers ?? '[欄位格式無法判讀]'
      : field.type === 'form-attachment-ids' ? formProjection?.attachmentIds ?? '[欄位格式無法判讀]'
      : field.type === 'series-end-day' ? source[field.key] === undefined ? '[未另存，舊同日格式]' : source[field.key] === 'same' ? '明確同日結束' : source[field.key] === 'next' ? '明確翌日結束' : '[欄位格式無法判讀]'
      : field.type === 'series-weekdays' ? seriesWeekdays(source[field.key])
      : field.type === 'business-rule-parameters' ? ruleParameters(source)
      : ['billing-line-items', 'payroll-line-items'].includes(field.type) ? financialHistoryLines(source[field.key], entity === 'payroll-statements')
      : field.type === 'financial-summary' ? financialHistorySummary(source[field.key], entity === 'payroll-statements')
      : field.type === 'financial-party' ? financialHistoryParty(source, entity === 'payroll-statements')
      : field.type === 'assessment-answers' ? normalizeAssessmentAnswers(source, templatesMap)
      : field.type === 'services' ? (entity==='shift-series'?seriesServices(source[field.key]):services(source[field.key]))
      : field.type === 'regions' ? normalizeEmployeeRegions(source[field.key]) : scalar(source[field.key]),
  ]));
}

function seriesWeekdays(value) {
  if(!Array.isArray(value)||value.length<1||value.length>7||Reflect.ownKeys(value).length!==value.length+1)return '[欄位格式無法判讀]';
  const days=[];
  for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value')||!Number.isSafeInteger(d.value)||d.value<1||d.value>7||days.some(day=>day.value===d.value))return '[欄位格式無法判讀]';days.push({value:d.value,label:['週一','週二','週三','週四','週五','週六','週日'][d.value-1]});}
  return days;
}

function seriesServices(value) {
  if(!Array.isArray(value)||value.length<1||value.length>100||Reflect.ownKeys(value).length!==value.length+1)return '[欄位格式無法判讀]';
  for(let i=0;i<value.length;i++){
    const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value'))return '[欄位格式無法判讀]';
    const item=d.value;if(!item||typeof item!=='object'||Array.isArray(item)||Reflect.ownKeys(item).length!==2)return '[欄位格式無法判讀]';
    const service=Object.getOwnPropertyDescriptor(item,'serviceItemId'),quantity=Object.getOwnPropertyDescriptor(item,'quantity');
    if(!service||!quantity||!Object.hasOwn(service,'value')||!Object.hasOwn(quantity,'value')||typeof service.value!=='string'||!service.value||!Number.isSafeInteger(quantity.value)||quantity.value<1)return '[欄位格式無法判讀]';
  }
  return services(value);
}

function ruleParameters(source) {
  const definitions = Object.hasOwn(RULE_PARAMETERS, source.kind) ? RULE_PARAMETERS[source.kind] : null;
  const value = source.parameters;
  if (!definitions || !value || typeof value !== 'object' || Array.isArray(value)) return '[欄位格式無法判讀]';
  return definitions.map(d => ({ label: d.label, value: scalar(value[d.key]) }));
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
