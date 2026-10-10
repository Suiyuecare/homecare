// Display-only confirmation of the dedicated assessment-04 projection.
export const SUPERVISORY_VISIT_TEMPLATE_ID = 'assessment-04';
export const SUPERVISORY_VISIT_QUESTIONS = Object.freeze([
  ['q001', '訪視日期'], ['q002', '照服員姓名'], ['q003', '訪視'], ['q004', '地點'],
  ['q005', '方式'], ['q006', '對象'], ['q007', '訪視內容'], ['q008', '追蹤處理'],
  ['q009', '填表日期'], ['q010', '下次評估日期'],
].map(([key, label]) => Object.freeze({ key, label })));
export const SUPERVISORY_VISIT_STATUSES = Object.freeze({ draft: '草稿', submitted: '已提交' });
const questionKeys = SUPERVISORY_VISIT_QUESTIONS.map(question => question.key);
const rowKeys = ['id', 'orgId', 'version', 'templateId', 'caseId', 'caseNo', 'caseName', 'date', 'status',
  'answerContainerKind', 'hasUnknownAnswerKeys', 'answers'];
const filterKeys = ['q', 'status', 'date', 'caseId'];
const containerKinds = new Set(['missing', 'null', 'object', 'array', 'string', 'number', 'boolean']);
const hiddenKinds = new Set(['missing', 'null', 'array', 'object', 'number', 'boolean']);
const tagText = Object.freeze({ missing: '未保存', null: '保存空值', array: '已保存清單（內容不展示）',
  object: '已保存物件（內容不展示）', number: '已保存數字（非文字值不展示）', boolean: '已保存布林值（非文字值不展示）' });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const dataObject = value => plain(value) && Reflect.ownKeys(value).every(key => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return typeof key === 'string' && descriptor.enumerable && Object.hasOwn(descriptor, 'value');
});
const exact = (value, keys) => dataObject(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const dense = value => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  && Reflect.ownKeys(value).length === value.length + 1 && Reflect.ownKeys(value).every((key, index) => {
    if (index === value.length) return key === 'length';
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return key === String(index) && descriptor.enumerable && Object.hasOwn(descriptor, 'value');
  });
const identifier = value => typeof value === 'string' && Boolean(value.trim());
const knownStatus = value => typeof value === 'string' && Object.hasOwn(SUPERVISORY_VISIT_STATUSES, value);
function unconfirmed() { const error = new Error('督導訪視回應無法確認，請重新讀取。'); error.code = 'VISIT_RESPONSE_UNCONFIRMED'; throw error; }

// Saved year 0000 is valid; readonly display never passes it through a native editor.
export function isSupervisoryVisitDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function answerValid(answer) {
  return dataObject(answer) && (answer.kind === 'string'
    ? exact(answer, ['kind', 'value']) && typeof answer.value === 'string'
    : exact(answer, ['kind']) && hiddenKinds.has(answer.kind));
}
function rowValid(row, orgId) {
  return exact(row, rowKeys) && identifier(row.id) && row.orgId === orgId
    && Number.isSafeInteger(row.version) && row.version > 0 && row.templateId === SUPERVISORY_VISIT_TEMPLATE_ID
    && identifier(row.caseId) && typeof row.caseNo === 'string' && typeof row.caseName === 'string'
    && isSupervisoryVisitDate(row.date) && knownStatus(row.status)
    && containerKinds.has(row.answerContainerKind) && typeof row.hasUnknownAnswerKeys === 'boolean'
    && exact(row.answers, questionKeys) && questionKeys.every(key => answerValid(row.answers[key]))
    && (row.answerContainerKind === 'object' || !row.hasUnknownAnswerKeys
      && questionKeys.every(key => row.answers[key].kind === 'missing'));
}
export function confirmSupervisoryVisitList(result, requested) {
  try {
    if (!exact(requested, ['page', 'pageSize', 'orgId', ...filterKeys]) || !identifier(requested.orgId)
      || !Number.isSafeInteger(requested.page) || requested.page < 1 || requested.pageSize !== 25
      || typeof requested.q !== 'string' || requested.q.length > 200
      || typeof requested.status !== 'string' || requested.status !== '' && !knownStatus(requested.status)
      || typeof requested.date !== 'string' || requested.date !== '' && !isSupervisoryVisitDate(requested.date)
      || typeof requested.caseId !== 'string' || requested.caseId.length > 500 || requested.caseId !== '' && !identifier(requested.caseId)
      || !exact(result, ['items', 'total', 'page', 'pageSize', 'filters']) || !exact(result.filters, filterKeys)
      || filterKeys.some(key => result.filters[key] !== requested[key]) || !dense(result.items)
      || !Number.isSafeInteger(result.total) || result.total < 0
      || result.page !== requested.page || result.pageSize !== requested.pageSize
      || result.items.length !== Math.min(25, Math.max(0, result.total - (requested.page - 1) * 25))) unconfirmed();
    const ids = new Set(), q = requested.q.toLowerCase();
    for (const row of result.items) {
      if (!rowValid(row, requested.orgId) || ids.has(row.id)
        || requested.status !== '' && row.status !== requested.status
        || requested.date !== '' && row.date !== requested.date
        || requested.caseId !== '' && row.caseId !== requested.caseId
        || q !== '' && !questionKeys.some(key => row.answers[key].kind === 'string' && row.answers[key].value.toLowerCase().includes(q))) unconfirmed();
      ids.add(row.id);
    }
  } catch { unconfirmed(); }
  return result;
}
export function confirmSupervisoryVisitItem(result, requested) {
  try {
    if (!exact(requested, ['id', 'orgId']) || !identifier(requested.id) || !identifier(requested.orgId)
      || !exact(result, ['item']) || !rowValid(result.item, requested.orgId) || result.item.id !== requested.id) unconfirmed();
  } catch { unconfirmed(); }
  return result.item;
}
export function supervisoryVisitAnswerText(answer) {
  if (!answerValid(answer)) return '保存內容未確認';
  return answer.kind === 'string' ? answer.value === '' ? '已保存空文字' : answer.value : tagText[answer.kind];
}
export function supervisoryVisitAnswerSummary(answer) {
  const text = supervisoryVisitAnswerText(answer), characters = Array.from(text);
  return characters.length > 160 ? characters.slice(0, 160).join('') + '…' : text;
}
export const formatSupervisoryVisitStatus = status => knownStatus(status) ? SUPERVISORY_VISIT_STATUSES[status] : '狀態未確認';
