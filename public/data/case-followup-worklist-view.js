import { FOLLOWUP_KINDS, FOLLOWUP_STATUSES } from './case-status-followup-editor.js';

// Read-only projection. No raw business value is converted into an editor payload.
export const CASE_FOLLOWUP_WORKLIST_FIELDS = Object.freeze([
  ['kind', '追蹤類型'], ['startDate', '開始日期'], ['endDate', '結束日期'], ['reason', '原因'],
  ['followUpDate', '追蹤日期'], ['outcome', '追蹤結果'], ['note', '備註'], ['status', '追蹤狀態'],
].map(([key, label]) => Object.freeze({ key, label })));
export const CASE_FOLLOWUP_WORKLIST_KINDS = Object.freeze(Object.fromEntries(FOLLOWUP_KINDS.map(item => [item.value, item.label])));
export const CASE_FOLLOWUP_WORKLIST_STATUSES = Object.freeze(Object.fromEntries(FOLLOWUP_STATUSES.map(item => [item.value, item.label])));
const fieldKeys = CASE_FOLLOWUP_WORKLIST_FIELDS.map(field => field.key);
const filterKeys = ['q', 'kind', 'status', 'followUpDate', 'caseId'];
const rowKeys = ['id', 'orgId', 'version', 'caseId', 'caseNo', 'caseName', 'fields'];
const searchable = ['reason', 'outcome', 'note'];
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
const known = (value, dictionary) => typeof value === 'string' && Object.hasOwn(dictionary, value);
function unconfirmed() { const error = new Error('人工追蹤回應無法確認，請重新讀取。'); error.code = 'FOLLOWUP_RESPONSE_UNCONFIRMED'; throw error; }

export function caseFollowupWorklistIdentity(context) {
  return JSON.stringify([context.user?.id ?? null, context.organizationId ?? context.orgId ?? null,
    context.role ?? null, context.user?.employeeId ?? null]);
}
export function isCaseFollowupWorklistDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function tagValid(tag) {
  return dataObject(tag) && (tag.kind === 'string'
    ? exact(tag, ['kind', 'value']) && typeof tag.value === 'string'
    : exact(tag, ['kind']) && hiddenKinds.has(tag.kind));
}
function rowValid(row, orgId) {
  return exact(row, rowKeys) && identifier(row.id) && row.orgId === orgId
    && Number.isSafeInteger(row.version) && row.version > 0 && identifier(row.caseId)
    && typeof row.caseNo === 'string' && typeof row.caseName === 'string'
    && exact(row.fields, fieldKeys) && fieldKeys.every(key => tagValid(row.fields[key]));
}
export function confirmCaseFollowupWorklistList(result, requested) {
  try {
    if (!exact(requested, ['page', 'pageSize', 'orgId', ...filterKeys]) || !identifier(requested.orgId)
      || !Number.isSafeInteger(requested.page) || requested.page < 1 || requested.pageSize !== 25
      || typeof requested.q !== 'string' || requested.q.length > 200
      || typeof requested.kind !== 'string' || requested.kind !== '' && !known(requested.kind, CASE_FOLLOWUP_WORKLIST_KINDS)
      || typeof requested.status !== 'string' || requested.status !== '' && !known(requested.status, CASE_FOLLOWUP_WORKLIST_STATUSES)
      || typeof requested.followUpDate !== 'string' || requested.followUpDate !== '' && !isCaseFollowupWorklistDate(requested.followUpDate)
      || typeof requested.caseId !== 'string' || requested.caseId.length > 500 || requested.caseId !== '' && !identifier(requested.caseId)
      || !exact(result, ['items', 'total', 'page', 'pageSize', 'filters']) || !exact(result.filters, filterKeys)
      || filterKeys.some(key => result.filters[key] !== requested[key]) || !dense(result.items)
      || !Number.isSafeInteger(result.total) || result.total < 0
      || result.page !== requested.page || result.pageSize !== requested.pageSize
      || result.items.length !== Math.min(25, Math.max(0, result.total - (requested.page - 1) * 25))) unconfirmed();
    const ids = new Set(), q = requested.q.toLowerCase();
    for (const row of result.items) {
      if (!rowValid(row, requested.orgId) || ids.has(row.id)
        || requested.caseId !== '' && row.caseId !== requested.caseId
        || ['kind', 'status', 'followUpDate'].some(key => requested[key] !== ''
          && (row.fields[key].kind !== 'string' || row.fields[key].value !== requested[key]))
        || q !== '' && !searchable.some(key => row.fields[key].kind === 'string'
          && row.fields[key].value.toLowerCase().includes(q))) unconfirmed();
      ids.add(row.id);
    }
  } catch { unconfirmed(); }
  return result;
}
export function confirmCaseFollowupWorklistItem(result, requested) {
  try {
    if (!exact(requested, ['id', 'orgId', 'caseId']) || !identifier(requested.id)
      || !identifier(requested.orgId) || !identifier(requested.caseId)
      || !exact(result, ['item']) || !rowValid(result.item, requested.orgId)
      || result.item.id !== requested.id || result.item.caseId !== requested.caseId) unconfirmed();
  } catch { unconfirmed(); }
  return result.item;
}
export function caseFollowupWorklistFieldText(tag) {
  if (!tagValid(tag)) return '保存內容未確認';
  return tag.kind === 'string' ? tag.value === '' ? '已保存空文字' : tag.value : tagText[tag.kind];
}
export function caseFollowupWorklistFieldSummary(tag) {
  const text = caseFollowupWorklistFieldText(tag), characters = Array.from(text);
  return characters.length > 160 ? characters.slice(0, 160).join('') + '…' : text;
}
function labelled(tag, dictionary) {
  if (!tagValid(tag) || tag.kind !== 'string' || tag.value === '') return caseFollowupWorklistFieldText(tag);
  return known(tag.value, dictionary) ? `${dictionary[tag.value]}（${tag.value}）` : `保存文字：${tag.value}`;
}
export const formatCaseFollowupWorklistKind = tag => labelled(tag, CASE_FOLLOWUP_WORKLIST_KINDS);
export const formatCaseFollowupWorklistStatus = tag => labelled(tag, CASE_FOLLOWUP_WORKLIST_STATUSES);
