import { TRAINING_CREDIT_FIELDS, TRAINING_CREDIT_LIMITS, creditPlain, creditClosed, creditId, assertTrainingCreditBusiness, assertTrainingCreditItem, trainingCreditFail } from './training-credit-core.js';
const editable = ['employeeId', 'date', 'activityName', 'provider', 'creditValue', 'creditUnit', 'sourceReference', 'reference', 'note'];
const baseline = value => value.replace(/\r\n?/g, '\n');
const bad = (key, message) => trainingCreditFail(422, 'TRAINING_CREDIT_INPUT', message, { [key]: message });
export function createTrainingCreditEditor({ existing, employees = [], date = '' } = {}) {
  if (existing) { assertTrainingCreditItem(existing); if (existing.status !== 'draft') bad('status', '只可編輯未核對草稿。'); }
  if (!Array.isArray(employees) || employees.length > 10000) bad('employeeId', '員工清單無法確認。');
  const ids = new Set(), organizations = new Set();
  for (const item of employees) { if (!creditPlain(item) || !creditId(item.id) || !creditId(item.orgId) || typeof item.name !== 'string' || !item.name.trim() || ids.has(item.id) || existing && item.orgId !== existing.orgId) bad('employeeId', '員工選取身份無法確認。'); ids.add(item.id); organizations.add(item.orgId); }
  if (organizations.size > 1 || existing && !ids.has(existing.employeeId)) bad('employeeId', '請重新讀取同機構員工。');
  const initial = Object.fromEntries(editable.map(key => [key, baseline(existing?.[key] || (key === 'date' ? date : ''))]));
  const fields = [
    { name: 'employeeId', label: '所屬員工', type: 'select', required: true, disabled: !!existing, options: employees.map(item => ({ value: item.id, label: item.name })), help: '建立後所屬員工固定。' },
    { name: 'date', label: '活動日期', type: 'date', required: true },
    { name: 'activityName', label: '活動名稱', required: true, maxLength: 200 },
    { name: 'provider', label: '辦訓／活動單位', required: true, maxLength: 200 },
    { name: 'creditValue', label: '人工積分原文', type: 'text', required: true, inputMode: 'decimal', maxLength: 22, help: '非負十進位文字；小數最多6位。保留原始小數位，不由時數换算。' },
    { name: 'creditUnit', label: '積分單位原文', required: true, maxLength: 100, help: '請依來源輸入單位；不同單位不加總。' },
    { name: 'sourceReference', label: '原始來源依據', type: 'textarea', required: true, maxLength: 10000, wide: true },
    { name: 'reference', label: '來源編號／文件參照', maxLength: 2000 },
    { name: 'note', label: '備註', type: 'textarea', maxLength: 10000, wide: true }
  ];
  function build(values) {
    if (!creditClosed(values, editable)) bad('status', '表單含未知或未確認控制項。');
    const data = { ...(existing ? Object.fromEntries(TRAINING_CREDIT_FIELDS.map(key => [key, existing[key]])) : { status: 'draft', verifiedOn: '', verificationBasis: '', voidedOn: '', voidReason: '' }) };
    for (const key of editable) { if (typeof values[key] !== 'string' || values[key].length > TRAINING_CREDIT_LIMITS[key] || ['employeeId', 'activityName', 'provider', 'creditUnit', 'reference'].includes(key) && /[\r\n]/.test(values[key])) bad(key, '請輸入上限內文字；單行欄位不可換行。'); data[key] = existing && values[key] === initial[key] ? existing[key] : ['employeeId', 'activityName', 'provider', 'creditUnit'].includes(key) ? values[key].trim() : values[key]; }
    if (!ids.has(data.employeeId) || existing && data.employeeId !== existing.employeeId) bad('employeeId', '請核對原同機構員工。');
    assertTrainingCreditBusiness(data); return existing ? Object.fromEntries(TRAINING_CREDIT_FIELDS.filter(key => data[key] !== existing[key]).map(key => [key, data[key]])) : data;
  }
  return { fields, initial, build };
}
export function confirmTrainingCreditSave(result, { orgId, original, payload } = {}) {
  if (!creditClosed(result, ['item'])) bad('status', '保存回應格式未確認。');
  const item = assertTrainingCreditItem(result.item, orgId);
  if (original ? item.id !== original.id || item.version !== original.version + 1 || item.createdAt !== original.createdAt : item.version !== 1) bad('status', '保存識別碼或版次未確認。');
  for (const key of TRAINING_CREDIT_FIELDS) if (Object.hasOwn(payload, key) ? item[key] !== payload[key] : original && item[key] !== original[key]) bad('status', '保存原文內容未確認，請保留輸入並重新讀取。');
  return item;
}
export const trainingCreditHistoryFields = [
  ['employeeId', '所屬員工', 'reference'], ['date', '活動日期', 'date'], ['activityName', '活動名稱'], ['provider', '辦訓／活動單位'], ['creditValue', '人工積分原文'], ['creditUnit', '積分單位原文'], ['sourceReference', '原始來源依據'], ['reference', '來源編號／文件參照'], ['note', '備註'], ['status', '紀錄狀態', 'training-credit-status'], ['verifiedOn', '本次核對日期', 'date'], ['verificationBasis', '本次核對依據'], ['voidedOn', '本次作廢日期', 'date'], ['voidReason', '本次作廢原因']
].map(([key, label, type = 'text']) => ({ key, label, type, ...(type === 'reference' ? { reference: 'employees' } : {}) }));
