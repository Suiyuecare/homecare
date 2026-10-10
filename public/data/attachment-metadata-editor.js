import { ATTACHMENT_CATEGORIES, ATTACHMENT_STATUSES } from './history-fields.js';

const entities = Object.freeze({
  'case-attachments': Object.freeze({ parentKey: 'caseId', fields: ['caseId', 'title', 'category', 'note', 'status'], controls: ['title', 'category', 'note'] }),
  'certification-attachments': Object.freeze({ parentKey: 'certificationId', fields: ['certificationId', 'title', 'note', 'status'], controls: ['title', 'note'] }),
});
const fileFields = ['fileName', 'mimeType', 'sizeBytes', 'sha256'];
const labels = { title: '附件標題', category: '附件分類', note: '備註' };
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const identity = value => typeof value === 'string' && Boolean(value.trim());
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
function invalid(name, message) { const error = new Error(message); error.fields = { [name]: message }; throw error; }
function unconfirmed() { const error = new Error('儲存結果未確認；請保留輸入並重新讀取確認。'); error.code = 'SAVE_UNCONFIRMED'; throw error; }
function configOf(entity) {
  if (!own(entities, entity)) invalid('title', '附件資料類型無法確認，請重新讀取。');
  return entities[entity];
}

// JSON stays outside the DOM. Accessors, sparse arrays and non-JSON values are not read or coerced.
function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) invalid('title', '保存資料不是可安全保留的 JSON，請重新讀取。');
  ancestors.add(value);
  const array = Array.isArray(value), result = array ? [] : {};
  const keys = Reflect.ownKeys(value).filter(key => !(array && key === 'length'));
  if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index))))
    invalid('title', '保存資料不是可安全保留的 JSON，請重新讀取。');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !own(descriptor, 'value'))
      invalid('title', '保存資料不是可安全保留的 JSON，請重新讀取。');
    put(result, key, copyJson(descriptor.value, ancestors));
  }
  ancestors.delete(value);
  return result;
}
function equalJson(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => own(right, key) && equalJson(left[key], right[key]));
}
function savedKind(present, value) {
  if (!present) return '未保存';
  if (value === null) return '空值';
  if (Array.isArray(value)) return '清單';
  return { string: '文字', number: '數字', boolean: '布林值', object: '物件' }[typeof value] || '其他類型';
}
export function formatAttachmentMetadataText(value, present = value !== undefined) {
  if (!present) return '未保存';
  if (typeof value === 'string') return value || '未提供';
  return `保存${savedKind(true, value)}（內容未展示）`;
}
export const formatAttachmentMetadataCategory = value => ATTACHMENT_CATEGORIES.find(item => item.value === value)?.label || '分類未取得';
export const formatAttachmentMetadataStatus = value => ATTACHMENT_STATUSES.find(item => item.value === value)?.label || '狀態未取得';
const mimeLabels = Object.freeze({ 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPEG' });
export const formatAttachmentMetadataMime = (value, present = value !== undefined) => typeof value === 'string' && own(mimeLabels, value)
  ? mimeLabels[value] : formatAttachmentMetadataText(value, present);
export const attachmentMetadataIdentity = context => JSON.stringify([
  context?.user?.id ?? null, context?.organizationId ?? context?.orgId ?? null,
  context?.role ?? null, context?.user?.employeeId ?? null,
]);

export function confirmAttachmentMetadataList(result, { entity, orgId, parentId, employeeId, page, pageSize = 25, category = '', status = '' } = {}) {
  try {
    const config = configOf(entity), copied = copyJson(result);
    if (!plain(copied) || Object.keys(copied).sort().join(',') !== 'items,page,pageSize,total'
      || !identity(orgId) || !identity(parentId) || !Number.isSafeInteger(page) || page < 1 || pageSize !== 25
      || (entity === 'certification-attachments' && (!identity(employeeId) || category !== ''))
      || (category !== '' && !ATTACHMENT_CATEGORIES.some(item => item.value === category))
      || (status !== '' && !ATTACHMENT_STATUSES.some(item => item.value === status))
      || !Array.isArray(copied.items) || !Number.isSafeInteger(copied.total) || copied.total < 0
      || copied.page !== page || copied.pageSize !== pageSize
      || copied.items.length !== Math.min(pageSize, Math.max(0, copied.total - (page - 1) * pageSize))) throw new Error();
    const ids = new Set();
    for (const item of copied.items) {
      if (!plain(item) || !own(item, 'id') || !identity(item.id) || ids.has(item.id)
        || !own(item, 'orgId') || item.orgId !== orgId || !own(item, config.parentKey) || item[config.parentKey] !== parentId
        || !own(item, 'version') || !Number.isSafeInteger(item.version) || item.version < 1
        || (entity === 'certification-attachments' && (!own(item, 'employeeId') || item.employeeId !== employeeId))
        || (category !== '' && (!own(item, 'category') || item.category !== category))
        || (status !== '' && (!own(item, 'status') || item.status !== status))) throw new Error();
      ids.add(item.id);
    }
    return copied;
  } catch { throw new Error('附件清單回應無法確認，請重新讀取。'); }
}

/** Existing metadata only. Upload and file replacement retain their original separate pipeline. */
export function createAttachmentMetadataEditor({ entity, existing, parentId, employeeId } = {}) {
  const config = configOf(entity), source = copyJson(existing);
  if (!plain(source) || !identity(parentId) || !own(source, 'id') || !identity(source.id)
    || !own(source, 'orgId') || !identity(source.orgId) || !own(source, 'version') || !Number.isSafeInteger(source.version) || source.version < 1
    || !own(source, config.parentKey) || source[config.parentKey] !== parentId
    || (entity === 'certification-attachments' && (!identity(employeeId) || !own(source, 'employeeId') || source.employeeId !== employeeId)))
    invalid('title', '附件識別或所屬資料無法確認，請重新讀取。');
  const names = [...config.fields, ...fileFields, ...(entity === 'certification-attachments' ? ['employeeId'] : [])];
  const original = {};
  for (const name of names) if (own(source, name)) put(original, name, source[name]);
  const savedIdentity = { id: source.id, orgId: source.orgId, version: source.version };
  const initial = {}, fields = [], intents = new Set();
  const knownStatus = own(original, 'status') && ATTACHMENT_STATUSES.some(item => item.value === original.status);
  const compatible = (name, value) => name === 'category' ? ATTACHMENT_CATEGORIES.some(item => item.value === value)
    : typeof value === 'string' && value.length <= (name === 'title' ? 200 : 10000)
      && !(name === 'title' ? /[\r\n]/.test(value) : /\r/.test(value))
      && (name !== 'title' || Boolean(value.trim()));
  for (const name of config.controls) {
    const present = own(original, name), unsafe = !present || !compatible(name, original[name]);
    if (unsafe) {
      intents.add(name); initial[name + 'Intent'] = 'keep';
      fields.push({ name: name + 'Intent', label: labels[name] + '處理方式', type: 'select', required: true,
        options: [{ value: 'keep', label: '保持原值' }, { value: 'replace', label: '以本次輸入取代' }, ...(name === 'note' ? [{ value: 'clear', label: '明確清空' }] : [])],
        help: `保存類型：${savedKind(present, original[name])}。原值不在表單展示；保持時不覆寫此欄。` });
    }
    initial[name] = unsafe ? '' : original[name];
    fields.push({ name, label: labels[name], type: name === 'category' ? 'select' : name === 'note' ? 'textarea' : 'text',
      required: name !== 'note' && !unsafe, disabled: unsafe,
      ...(name === 'category' ? { options: ATTACHMENT_CATEGORIES.map(item => ({ ...item })) } : { maxLength: name === 'title' ? 200 : 10000 }),
      ...(name === 'title' ? { help: '所屬資料固定；此表單只修改附件描述，不會更換檔案。' } : {}),
      ...(name === 'note' ? { help: '最多 10000 個字元；未變更時保留原保存內容。' } : {}),
    });
  }
  if (!knownStatus) {
    initial.statusRepair = 'keep';
    fields.push({ name: 'statusRepair', label: '附件狀態修復', type: 'select', required: true,
      options: [{ value: 'keep', label: '保持原值' }, ...ATTACHMENT_STATUSES.map(item => ({ value: item.value, label: `明確改為${item.label}` }))],
      help: `保存類型：${savedKind(own(original, 'status'), original.status)}。未知狀態不推測；只有明確選擇才取代。` });
  }
  const allowed = new Set(Object.keys(initial));
  const valuesOf = values => {
    const result = copyJson(values);
    if (!plain(result)) invalid('title', '表單資料格式不正確，請保留輸入並重試。');
    for (const key of Object.keys(result)) if (!allowed.has(key)) invalid(key, '表單包含未知欄位，請重新讀取。');
    return result;
  };
  const valueOf = (values, name) => own(values, name) ? values[name] : initial[name];
  const needsIntent = name => intents.has(name);
  const enabled = (name, values = {}) => {
    try {
      const parsed = valuesOf(values);
      return allowed.has(name) && (!needsIntent(name) || valueOf(parsed, name + 'Intent') === 'replace');
    } catch { return false; }
  };
  const nextVersion = () => { if (savedIdentity.version >= Number.MAX_SAFE_INTEGER) invalid('title', '附件版次無法安全更新，請重新讀取。'); };
  function buildPayload(input) {
    const values = valuesOf(input), payload = {};
    for (const name of config.controls) {
      let value = valueOf(values, name);
      if (needsIntent(name)) {
        const intent = valueOf(values, name + 'Intent');
        if (!['keep', 'replace', ...(name === 'note' ? ['clear'] : [])].includes(intent)) invalid(name + 'Intent', '請選擇有效的保存處理方式。');
        if (intent === 'keep') continue;
        if (intent === 'clear') value = '';
      } else if (value === initial[name]) continue;
      if (typeof value !== 'string') invalid(name, '請填寫符合此欄格式的文字。');
      value = value.trim();
      if (name === 'category' ? !ATTACHMENT_CATEGORIES.some(item => item.value === value)
        : value.length > (name === 'title' ? 200 : 10000) || (name === 'title' && !value))
        invalid(name, name === 'category' ? '請選擇有效附件分類。' : name === 'title' ? '附件標題必填且最多200字。' : '備註最多10000字。');
      if (!own(original, name) || original[name] !== value) put(payload, name, value);
    }
    if (!knownStatus) {
      const repair = valueOf(values, 'statusRepair');
      if (repair !== 'keep' && !ATTACHMENT_STATUSES.some(item => item.value === repair)) invalid('statusRepair', '請明確選擇有效的附件狀態。');
      if (repair !== 'keep') payload.status = repair;
    }
    if (Object.keys(payload).length) nextVersion();
    return payload;
  }
  function buildStatusChange(status) {
    if (!knownStatus || !ATTACHMENT_STATUSES.some(item => item.value === status) || status === original.status)
      invalid('status', '請使用已確認的附件狀態動作。');
    nextVersion(); return { status };
  }
  function confirm(item, orgId, submitted) {
    try {
      const confirmed = copyJson(item), payload = copyJson(submitted);
      if (!plain(confirmed) || !plain(payload) || !identity(orgId) || own(confirmed, 'fileId')
        || !own(confirmed, 'id') || confirmed.id !== savedIdentity.id || !identity(confirmed.id)
        || !own(confirmed, 'orgId') || confirmed.orgId !== orgId || savedIdentity.orgId !== orgId
        || !own(confirmed, 'version') || !Number.isSafeInteger(confirmed.version) || savedIdentity.version >= Number.MAX_SAFE_INTEGER
        || confirmed.version !== savedIdentity.version + 1) unconfirmed();
      const mutationFields = [...config.controls, 'status'];
      if (!Object.keys(payload).length || Object.keys(payload).some(name => !mutationFields.includes(name) || typeof payload[name] !== 'string')) unconfirmed();
      if (own(payload, 'title') && (!payload.title.trim() || payload.title.trim().length > 200)
        || own(payload, 'note') && payload.note.trim().length > 10000
        || own(payload, 'category') && !ATTACHMENT_CATEGORIES.some(item => item.value === payload.category.trim())
        || own(payload, 'status') && !ATTACHMENT_STATUSES.some(item => item.value === payload.status.trim())) unconfirmed();
      for (const name of names) {
        const supplied = own(payload, name), present = supplied || own(original, name);
        if (own(confirmed, name) !== present) unconfirmed();
        const expected = supplied ? typeof payload[name] === 'string' ? payload[name].trim() : payload[name] : original[name];
        if (present && !equalJson(confirmed[name], expected)) unconfirmed();
      }
      return confirmed;
    } catch { unconfirmed(); }
  }
  return { initial: { ...initial }, fields, needsIntent, enabled, buildPayload, buildStatusChange, confirm };
}
