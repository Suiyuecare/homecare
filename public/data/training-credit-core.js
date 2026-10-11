export const TRAINING_CREDIT_ENTITY = 'employee-training-credits';
export const TRAINING_CREDIT_FIELDS = ['employeeId', 'date', 'activityName', 'provider', 'creditValue', 'creditUnit', 'sourceReference', 'reference', 'note', 'status', 'verifiedOn', 'verificationBasis', 'voidedOn', 'voidReason'];
export const TRAINING_CREDIT_METADATA = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
export const TRAINING_CREDIT_STATUSES = { draft: '草稿', verified: '人工核對完成', voided: '已作廢' };
export const TRAINING_CREDIT_LIMITS = { employeeId: 100, date: 10, activityName: 200, provider: 200, creditValue: 22, creditUnit: 100, sourceReference: 10000, reference: 2000, note: 10000, status: 20, verifiedOn: 10, verificationBasis: 10000, voidedOn: 10, voidReason: 10000 };
export const TRAINING_CREDIT_REQUIRED = ['employeeId', 'date', 'activityName', 'provider', 'creditValue', 'creditUnit', 'sourceReference'];
export function trainingCreditFail(status, code, message, errors) { const error = new Error(message); Object.assign(error, { status, code, ...(errors ? { errors } : {}) }); throw error; }
export function creditPlain(value) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
export const creditClosed = (value, keys) => creditPlain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const creditId = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && value === value.trim() && !/[\r\n]/.test(value);
export const isTrainingCreditYear = value => typeof value === 'string' && value.length === 4 && /^\d{4}$/.test(value) && value !== '0000';
export function isTrainingCreditDate(value) {
  if (typeof value !== 'string' || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !isTrainingCreditYear(value.slice(0, 4))) return false;
  const [year, month, day] = value.split('-').map(Number), leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
export const isTrainingCreditValue = value => typeof value === 'string' && value.length <= 22 && !/[\r\n]/.test(value) && /^\d{1,15}(?:\.\d{1,6})?$/.test(value);
export function assertTrainingCreditBusiness(value, fail = trainingCreditFail) {
  const bad = (key, message) => fail(422, 'TRAINING_CREDIT_INVALID', message, { [key]: message });
  if (!creditClosed(value, TRAINING_CREDIT_FIELDS)) bad('status', '人工積分只接受完整已知欄位。');
  for (const key of TRAINING_CREDIT_FIELDS) if (typeof value[key] !== 'string' || value[key].length > TRAINING_CREDIT_LIMITS[key]) bad(key, '請使用上限內的文字欄位。');
  for (const key of TRAINING_CREDIT_REQUIRED) if (!value[key].trim()) bad(key, '此欄位必填。');
  for (const key of ['activityName', 'provider', 'creditUnit', 'reference']) if (/[\r\n]/.test(value[key])) bad(key, '此欄位不接受換行。');
  if (!creditId(value.employeeId)) bad('employeeId', '員工識別碼不合法。');
  if (!isTrainingCreditDate(value.date)) bad('date', '請填入0001至9999年間有效活動日期。');
  if (!isTrainingCreditValue(value.creditValue)) bad('creditValue', '請填入原始非負十進位文字，整數最多15位、小數最多6位。');
  if (!Object.hasOwn(TRAINING_CREDIT_STATUSES, value.status)) bad('status', '紀錄狀態不合法。');
  if (value.status === 'draft' && ['verifiedOn', 'verificationBasis', 'voidedOn', 'voidReason'].some(key => value[key] !== '')) bad('status', '草稿不得預填核對或作廢欄位。');
  if (value.status !== 'draft' && (!isTrainingCreditDate(value.verifiedOn) || !value.verificationBasis.trim())) bad('verificationBasis', '人工核對日期與依據需完整保存。');
  if (value.status === 'verified' && (value.voidedOn !== '' || value.voidReason !== '')) bad('voidReason', '人工核對紀錄尚未作廢。');
  if (value.status === 'voided' && (!isTrainingCreditDate(value.voidedOn) || !value.voidReason.trim())) bad('voidReason', '作廢紀錄需保存日期與原因。');
  return value;
}
export function assertTrainingCreditItem(value, orgId, fail = trainingCreditFail) {
  if (!creditClosed(value, [...TRAINING_CREDIT_FIELDS, ...TRAINING_CREDIT_METADATA]) || !creditId(value.id) || !creditId(value.orgId) || orgId && value.orgId !== orgId || !Number.isSafeInteger(value.version) || value.version < 1 || ['createdAt', 'updatedAt'].some(key => typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 100)) fail(422, 'TRAINING_CREDIT_INVALID', '人工積分識別碼、機構或保存版次無法確認。');
  assertTrainingCreditBusiness(Object.fromEntries(TRAINING_CREDIT_FIELDS.map(key => [key, value[key]])), fail); return value;
}
export function trainingCreditYearList(items, year) { if (!isTrainingCreditYear(year) || !Array.isArray(items)) trainingCreditFail(422, 'INVALID_QUERY', '年度或清單無法確認。'); return items.filter(item => assertTrainingCreditItem(item).date.slice(0, 4) === year); }
export function trainingCreditReadModel(item, orgId) { assertTrainingCreditItem(item, orgId); return { item: structuredClone(item), year: item.date.slice(0, 4), creditDisplay: item.creditValue + ' ' + item.creditUnit, official: false, warning: '人工逐筆保存；不同單位不加總，訓練分鐘不換積分，沒有法定資格判定。' }; }
