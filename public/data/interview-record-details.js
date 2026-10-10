export const INTERVIEW_RECORD_FIELDS = Object.freeze([
  { key: 'name', label: '姓名' },
  { key: 'phone', label: '電話' },
  { key: 'interviewDate', label: '面試日期' },
  { key: 'city', label: '縣市' },
  { key: 'district', label: '鄉鎮區' },
  { key: 'interviewContent', label: '面試內容' },
  { key: 'note', label: '備註' },
  { key: 'status', label: '名單狀態' },
].map(Object.freeze));

const metadataKeys = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const identifier = value => typeof value === 'string' && Boolean(value.trim());
export const isInterviewRecordDetailsId = value => typeof value === 'string' && /^[a-f0-9-]+$/.test(value);

export function interviewRecordDetailsIdentity(context) {
  return JSON.stringify([context?.user?.id ?? null, context?.organizationId ?? context?.orgId ?? null,
    context?.role ?? null, context?.user?.employeeId ?? null]);
}

function unconfirmed() {
  throw Object.assign(new Error('面試紀錄回應無法確認；請重新讀取。'), { code: 'INTERVIEW_RECORD_DETAILS_UNCONFIRMED' });
}

function dataValue(value, key, { required = true, enumerable = true } = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    if (required) unconfirmed();
    return { present: false };
  }
  if (!Object.hasOwn(descriptor, 'value') || (enumerable && !descriptor.enumerable)) unconfirmed();
  return { present: true, value: descriptor.value };
}

function exactData(value, keys) {
  if (!plain(value)) unconfirmed();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) unconfirmed();
  return Object.fromEntries(keys.map(key => [key, dataValue(value, key).value]));
}

function fieldProjection(item, field) {
  const saved = dataValue(item, field.key, { required: false, enumerable: false });
  let kind, text;
  if (!saved.present) { kind = 'missing'; text = '未保存'; }
  else if (saved.value === null) { kind = 'null'; text = '未提供（null）'; }
  else if (typeof saved.value === 'string') {
    kind = saved.value === '' ? 'empty' : 'text';
    text = saved.value === '' ? '空白' : saved.value;
  } else {
    kind = 'non-text';
    text = `非文字值（${Array.isArray(saved.value) ? 'array' : typeof saved.value}）`;
  }
  return Object.freeze({ key: field.key, label: field.label, kind, text });
}

/** Fresh, descriptor-confirmed projection. Unknown item fields and nested values are never read. */
export function confirmInterviewRecordDetails(response, requested) {
  try {
    const query = exactData(requested, ['id', 'orgId']);
    const envelope = exactData(response, ['item']);
    if (!isInterviewRecordDetailsId(query.id) || !identifier(query.orgId) || !plain(envelope.item)) unconfirmed();
    const item = envelope.item;
    const metadata = Object.fromEntries(metadataKeys.map(key => [key, dataValue(item, key).value]));
    if (metadata.id !== query.id || metadata.orgId !== query.orgId
      || !Number.isSafeInteger(metadata.version) || metadata.version < 1
      || typeof metadata.createdAt !== 'string' || typeof metadata.updatedAt !== 'string') unconfirmed();
    return Object.freeze({ ...metadata, fields: Object.freeze(INTERVIEW_RECORD_FIELDS.map(field => fieldProjection(item, field))) });
  } catch { unconfirmed(); }
}
