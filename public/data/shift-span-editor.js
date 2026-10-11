import { calendarDay, shiftSpan, serviceSpan } from './shift-span.js';

export const CALENDAR_SPAN_MODE = 'calendar-two-day-v1';
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const data = (value, key) => {
  if (!plain(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !own(descriptor, 'value')) fail(key, '日期時段資料不可使用存取器，請重新讀取。');
  return descriptor.value;
};
const fail = (key, message) => { throw Object.assign(new Error(message), { fields: { [key]: message } }); };
const validDate = value => { try { calendarDay(value); return true; } catch { return false; } };
const nativeDate = value => validDate(value) && !value.startsWith('0000-');
const pick = (record, keys) => Object.fromEntries(keys.filter(key => own(record, key)).map(key => [key, data(record, key)]));

// UI-only mode and saved values remain private. They are never submitted as
// generic entity fields, and legacy omission is never represented by undefined.
export function createEndDateControl({ existing, entity = 'shifts', date = '' } = {}) {
  const service = entity === 'service-records', endKey = service ? 'actualEndDate' : 'endDate';
  const clockKeys = service ? ['actualStart', 'actualEnd'] : ['startTime', 'endTime'];
  const editing = existing !== undefined && existing !== null;
  if (editing && !plain(existing)) fail(endKey, '保存完整日期資料無法取得。');
  if (editing && Reflect.ownKeys(existing).some(key => typeof key !== 'string' || !Object.getOwnPropertyDescriptor(existing, key)?.enumerable
    || !own(Object.getOwnPropertyDescriptor(existing, key), 'value'))) fail(endKey, '保存資料不可使用存取器或未知符號，請重新讀取。');
  const explicit = editing && own(existing, endKey), savedEnd = explicit ? data(existing, endKey) : undefined;
  if (explicit && !validDate(savedEnd)) fail(endKey, '保存的明確結束日期無法確認；不能當成舊同日格式。');
  const preserve = explicit && !nativeDate(savedEnd);
  const initial = { spanMode: explicit ? CALENDAR_SPAN_MODE : 'legacy', [endKey]: explicit && !preserve ? savedEnd : '' };
  if (preserve) initial[endKey + 'Intent'] = 'keep';
  const fields = [{ name: 'spanMode', label: service ? '實際日期保存方式' : '日期保存方式', type: 'select', required: true,
    disabled: explicit, options: [{ value: 'legacy', label: '舊同日格式（不另存結束日）' },
      { value: CALENDAR_SPAN_MODE, label: '明確完整日期（同日或翌日結束）' }],
    help: explicit ? '已保存明確結束日；編輯保留完整日期，不能清除或切回舊格式。'
      : '只有明確選擇完整日期模式才保存結束日；不依較早的結束時間猜測翌日。' }];
  if (preserve) fields.push({ name: endKey + 'Intent', label: '保存結束日期處理方式', type: 'select', required: true,
    options: [{ value: 'keep', label: '保持原值' }, { value: 'replace', label: '以本次輸入取代' }],
    help: '原結束日不由原生日期控制項覆寫；保持時不提交此欄。' });
  fields.push({ name: endKey, label: service ? '實際結束日期' : '結束日期', type: 'date', required: explicit && !preserve,
    disabled: !explicit || preserve,
    help: service ? '須人工填寫本次實際結束日；原班結束日只供參考，不預填為實際事實。'
      : '填完整 YYYY-MM-DD，同開始日或翌日；結束須晚於開始，不推定工時、假額或加給。' });
  const initialDate = date;
  function mode(values = {}) {
    const value = own(values, 'spanMode') ? data(values, 'spanMode') : initial.spanMode;
    if (!['legacy', CALENDAR_SPAN_MODE].includes(value) || explicit && value !== CALENDAR_SPAN_MODE)
      fail('spanMode', '請明確選擇日期模式；已有完整結束日不可撤回為舊格式。');
    return value;
  }
  function enabled(name, values = {}) {
    if (name === 'spanMode') return !explicit;
    if (name === endKey + 'Intent') return preserve;
    if (name !== endKey) return undefined;
    return mode(values) === CALENDAR_SPAN_MODE && (!preserve
      || (own(values, endKey + 'Intent') ? data(values, endKey + 'Intent') : 'keep') === 'replace');
  }
  function apply(payload, values, original = {}) {
    if (!plain(payload) || !plain(values) || !plain(original)) fail(endKey, '完整日期表單資料無法確認。');
    if (mode(values) === 'legacy') return payload;
    const intent = preserve ? own(values, endKey + 'Intent') ? data(values, endKey + 'Intent') : 'keep' : 'replace';
    if (!['keep', 'replace'].includes(intent)) fail(endKey + 'Intent', '請選擇保持或明確取代保存結束日。');
    const end = intent === 'keep' ? savedEnd : own(values, endKey) ? data(values, endKey) : initial[endKey];
    if (!validDate(end) || intent === 'replace' && !nativeDate(end)) fail(endKey, '請人工填寫完整有效的同日或翌日結束日期。');
    const candidate = { date: own(payload, 'date') ? data(payload, 'date') : own(original, 'date') ? data(original, 'date') : initialDate };
    for (const key of clockKeys) candidate[key] = own(payload, key) ? data(payload, key) : data(original, key);
    candidate[endKey] = end;
    try { (service ? serviceSpan : shiftSpan)(candidate); }
    catch (error) { fail(endKey, error.message + ' 已保存 ISO 時段須先明確取代為完整 HH:mm。'); }
    if (!explicit || end !== savedEnd) payload[endKey] = end;
    return payload;
  }
  return { initial: { ...initial }, fields, endKey, explicit, enabled, apply, mode };
}

export function spanRecordText(record, entity = 'shifts') {
  try {
    if (!plain(record)) return '完整日期時段未取得';
    const service = entity === 'service-records', endKey = service ? 'actualEndDate' : 'endDate';
    const startKey = service ? 'actualStart' : 'startTime', endTimeKey = service ? 'actualEnd' : 'endTime';
    const value = pick(record, ['date', startKey, endTimeKey, endKey]);
    const span = (service ? serviceSpan : shiftSpan)(value);
    return own(value, endKey) ? `${value.date} ${value[startKey]} 至 ${value[endKey]} ${value[endTimeKey]}`
      : `${value.date} ${value[startKey]} 至 ${value[endTimeKey]}（舊同日格式）`;
  } catch { return '完整日期時段未取得'; }
}

export function explicitSpanSubset(record, entity = 'shifts') {
  if (!plain(record)) fail('date', '日期時段資料無法取得。');
  const service = entity === 'service-records';
  const value = pick(record, service ? ['date', 'actualStart', 'actualEnd', 'actualEndDate'] : ['date', 'startTime', 'endTime', 'endDate']);
  (service ? serviceSpan : shiftSpan)(value);
  return value;
}

/** Closed data traversal before any DTO array/object read; never invokes accessors. */
export function assertSpanData(value, ancestors = new Set(), depth = 0) {
  if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || depth > 30 || ancestors.has(value)) throw new Error('完整日期資料須為純粹保存資料。');
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
  if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) throw new Error('完整日期資料不接受自訂物件。');
  if (array && (!Number.isSafeInteger(descriptors.length?.value) || descriptors.length.value < 0 || descriptors.length.value > 10000 || keys.length !== descriptors.length.value + 1)) throw new Error('完整日期清單未完整確認。');
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    const d = descriptors[key];
    if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value') || array && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= descriptors.length.value)) throw new Error('完整日期資料不接受未知或執行型欄位。');
    assertSpanData(d.value, ancestors, depth + 1);
  }
  ancestors.delete(value); return value;
}
export function shiftReferenceProjection(item) {
  assertSpanData(item);
  const keys = ['id', 'orgId', 'version', 'employeeId', 'date', 'startTime', 'endTime', ...(Object.hasOwn(item, 'endDate') ? ['endDate'] : [])];
  return Object.fromEntries(keys.map(key => [key, item[key]]));
}
export function sameEndingDate(a, b) { return Object.hasOwn(a, 'endDate') === Object.hasOwn(b, 'endDate') && (!Object.hasOwn(a, 'endDate') || a.endDate === b.endDate); }
