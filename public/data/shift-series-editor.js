import { shiftSpan, recurringShiftSpan, moveShiftSpan } from './shift-span.js';
import { sameEndingDate } from './shift-span-editor.js';
const dayMs = 86400000;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);
const identity = value => typeof value === 'string' && Boolean(value.trim()) && value === value.trim() && !/[\r\n]/.test(value) && value.length <= 500;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const error = (key, message) => { const issue = new Error(message); issue.fields = { [key]: message }; throw issue; };
const invalid = () => { throw new Error('永久週期回應未完整確認；請保留輸入並重新讀取。'); };
// DTOs are data, never executable objects. Check descriptors before any field read,
// array method or JSON comparison so a malformed response cannot execute getters.
function safeData(value, ancestors = new Set(), depth = 0) {
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return;
  if (typeof value !== 'object' || depth > 20 || ancestors.has(value)) invalid();
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) invalid();
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (array) {
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 10000 || keys.length !== length + 1) invalid();
    for (let index = 0; index < length; index++) if (!Object.hasOwn(descriptors, String(index))) invalid();
  }
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || array && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= descriptors.length.value)) invalid();
    safeData(descriptor.value, ancestors, depth + 1);
  }
  ancestors.delete(value);
}
export const SHIFT_SERIES_FIELDS = ['name', 'caseId', 'employeeId', 'carePlanId', 'startDate', 'endDate', 'intervalWeeks', 'weekdays', 'startTime', 'endTime', 'services', 'status', 'note'];
export const SHIFT_SERIES_OPTIONAL_FIELDS = ['endDay'];
export const SHIFT_SERIES_LABELS = { endDay: '每班明確結束日（未另存為舊同日格式）', name: '週期名稱', caseId: '個案', employeeId: '服務人員', carePlanId: '照顧計畫', startDate: '週期起算日期', endDate: '週期尾日', intervalWeeks: '每隔幾週', weekdays: '服務星期', startTime: '開始時間', endTime: '結束時間', services: '每班服務明細', status: '週期狀態', note: '每班交班備註' };
export const SHIFT_SERIES_WEEKDAYS = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'].map((label, index) => ({ label, value: index + 1 }));
export function seriesCalendarDay(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const date = new Date(value + 'T00:00:00Z'); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date.getTime() / dayMs : NaN;
}
export function assertShiftSeriesRecord(item, orgId, metadata = true) {
  safeData(item);
  if (!plain(item) || Object.keys(item).some(key => ![...SHIFT_SERIES_FIELDS, ...SHIFT_SERIES_OPTIONAL_FIELDS, ...(metadata ? ['id', 'orgId', 'version', 'createdAt', 'updatedAt'] : [])].includes(key))) invalid();
  if (metadata && (!identity(item.id) || item.orgId !== orgId || !Number.isSafeInteger(item.version) || item.version < 1 || ['createdAt', 'updatedAt'].some(key => !own(item, key) || typeof item[key] !== 'string' || !item[key]))) invalid();
  if (SHIFT_SERIES_FIELDS.some(key => !own(item, key)) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 || ['caseId', 'employeeId', 'carePlanId'].some(key => !identity(item[key]))) invalid();
  if (!Number.isFinite(seriesCalendarDay(item.startDate)) || typeof item.endDate !== 'string' || item.endDate !== '' && (!Number.isFinite(seriesCalendarDay(item.endDate)) || item.endDate < item.startDate)) invalid();
  if (!Number.isSafeInteger(item.intervalWeeks) || item.intervalWeeks < 1 || item.intervalWeeks > 4 || !Array.isArray(item.weekdays) || !item.weekdays.length || item.weekdays.length > 7 || new Set(item.weekdays).size !== item.weekdays.length || item.weekdays.some(day => !Number.isSafeInteger(day) || day < 1 || day > 7)) invalid();
  if (!Array.isArray(item.services) || !item.services.length || item.services.length > 100 || new Set(item.services.map(line => line?.serviceItemId)).size !== item.services.length) invalid();
  for (const line of item.services) if (!plain(line) || Object.keys(line).length !== 2 || Object.keys(line).some(key => !['serviceItemId', 'quantity'].includes(key)) || !identity(line.serviceItemId) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 10000) invalid();
  if (['startTime', 'endTime'].some(key => typeof item[key] !== 'string' || item[key].length !== 5 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item[key])) || !['active', 'paused', 'ended'].includes(item.status) || typeof item.note !== 'string' || item.note.length > 10000) invalid();
  try { recurringShiftSpan(item.startDate, { startTime: item.startTime, endTime: item.endTime, ...(own(item, 'endDay') ? { endDay: item.endDay } : {}) }); } catch { invalid(); }
  return item;
}
const nl = text => text.replace(/\r\n?/g, '\n');
export function shiftSeriesDraft(values, data, existing) {
  safeData(values); safeData(data); if (existing) safeData(existing);
  const allowed = [...SHIFT_SERIES_FIELDS.filter(key => key !== 'caseId'), 'endDay', 'replaceNote']; if (!plain(values) || Object.keys(values).some(key => !allowed.includes(key))) error('name', '表單含未知欄位');
  const plan = data['care-plans'].find(item => item.id === values.carePlanId && item.orgId === data.orgId), employee = data.employees.find(item => item.id === values.employeeId && item.orgId === data.orgId), caseItem = data.cases.find(item => item.id === plan?.caseId && item.orgId === data.orgId);
  if (!plan || !employee || !caseItem) error('carePlanId', '請選擇同機構個案、計畫與人員');
  if (values.status === 'active' && [plan, employee, caseItem].some(item => item.status !== 'active')) error('carePlanId', '啟用需要服務中的個案、計畫與人員');
  const intervalWeeks = typeof values.intervalWeeks === 'number' ? values.intervalWeeks : typeof values.intervalWeeks === 'string' && values.intervalWeeks.length === 1 && /^[1-4]$/.test(values.intervalWeeks) ? Number(values.intervalWeeks) : NaN;
  const note = existing && values.replaceNote !== true && typeof values.note === 'string' && nl(values.note) === nl(existing.note) ? existing.note : values.note;
  const draft = Object.fromEntries(SHIFT_SERIES_FIELDS.map(key => [key, key === 'caseId' ? plan.caseId : key === 'intervalWeeks' ? intervalWeeks : key === 'note' ? note : values[key]]));
  if (own(values, 'endDay') && values.endDay !== 'legacy') { if (!['same', 'next'].includes(values.endDay)) error('endDay', '請明確選擇同日或翌日'); draft.endDay = values.endDay; }
  else if (existing && own(existing, 'endDay')) error('endDay', '已明確設定結束日的週期不能改為舊格式');
  for (const key of ['name', 'status']) if (typeof draft[key] === 'string' && !(existing && draft[key] === existing[key])) draft[key] = draft[key].trim();
  assertShiftSeriesRecord(draft, data.orgId, false);
  if (draft.services.some(line => !plan.services.some(allowed => allowed.serviceItemId === line.serviceItemId) || !data['service-items'].some(service => service.id === line.serviceItemId && service.orgId === data.orgId && (draft.status !== 'active' || service.status === 'active')))) error('services', '服務须為同機構且在計畫允許範圍');
  if (existing && (draft.caseId !== existing.caseId || draft.startDate !== existing.startDate || existing.status === 'ended')) error('startDate', '原個案、起算日固定且已結束週期不可修改'); return draft;
}
export function shiftSeriesPatch(draft, existing) { safeData(draft); safeData(existing); return Object.fromEntries([...SHIFT_SERIES_FIELDS, ...SHIFT_SERIES_OPTIONAL_FIELDS].filter(key => own(draft, key) !== own(existing, key) || !same(draft[key], existing[key])).map(key => [key, draft[key]])); }
export function confirmShiftSeriesSave(response, draft, orgId, existing) {
  safeData(response); safeData(draft); if (existing) safeData(existing);
  if (!plain(response) || Object.keys(response).length !== 1 || !own(response, 'item')) invalid(); const item = assertShiftSeriesRecord(response.item, orgId);
  if (existing ? item.id !== existing.id || item.version !== existing.version + 1 || item.createdAt !== existing.createdAt : item.version !== 1) invalid();
  for (const key of [...SHIFT_SERIES_FIELDS, ...SHIFT_SERIES_OPTIONAL_FIELDS]) if (own(item, key) !== own(draft, key) || !same(item[key], draft[key])) invalid(); return item;
}
export function shiftSeriesRange(values, existing) {
  safeData(values); safeData(existing);
  const first = seriesCalendarDay(values.fromDate), last = seriesCalendarDay(values.toDate);
  if (!Number.isFinite(first)) error('fromDate', '請填寫有效開始日期');
  if (!Number.isFinite(last) || last < first || last - first + 1 > 93) error('toDate', '含起訖最多93日，尾日不可早於起日');
  return { version: existing.version, fromDate: values.fromDate, toDate: values.toDate };
}
function occurrenceMinute(value, date) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return NaN;
  const text = value.length === 5 ? value : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && value.slice(0, 10) === date && Number.isFinite(Date.parse(value)) ? value.slice(11, 16) : '';
  if (text.length !== 5 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) return NaN; return Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));
}
function assertOccurrence(item, series, orgId) {
  if (!plain(item) || Object.keys(item).some(key => !['date', 'movedDate', 'shiftId', 'seriesVersion', 'seriesSnapshot', 'shift', 'createdAt', 'editable', 'lockReason'].includes(key)) || !Number.isFinite(seriesCalendarDay(item.date)) || !identity(item.shiftId) || !Number.isSafeInteger(item.seriesVersion) || item.seriesVersion < 1 || typeof item.createdAt !== 'string' || typeof item.editable !== 'boolean' || !['', '已有服務紀錄', '班次已完成', '班次已取消'].includes(item.lockReason) || item.editable !== (item.lockReason === '')) invalid();
  const source = assertShiftSeriesRecord(item.seriesSnapshot, orgId), shift = item.shift;
  if (source.id !== series.id || source.caseId !== series.caseId || source.startDate !== series.startDate || source.version !== item.seriesVersion || !plain(shift) || Object.keys(shift).some(key => !['id', 'orgId', 'version', 'createdAt', 'updatedAt', 'caseId', 'employeeId', 'carePlanId', 'date', 'startTime', 'endTime', 'services', 'status', 'note', 'endDate'].includes(key)) || shift.id !== item.shiftId || shift.orgId !== orgId || shift.caseId !== series.caseId || !Number.isFinite(seriesCalendarDay(shift.date)) || !Number.isSafeInteger(shift.version) || shift.version < 1
    || !identity(shift.employeeId) || !identity(shift.carePlanId) || typeof shift.note !== 'string' || shift.note.length > 10000 || !['scheduled', 'completed', 'cancelled'].includes(shift.status) || item.editable && shift.status !== 'scheduled' || ['createdAt', 'updatedAt'].some(key => !own(shift, key) || typeof shift[key] !== 'string' || !shift[key]) || ['startTime', 'endTime'].some(key => !Number.isFinite(occurrenceMinute(shift[key], shift.date))) ) invalid();
  try { shiftSpan({ date: shift.date, startTime: shift.startTime, endTime: shift.endTime, ...(own(shift, 'endDate') ? { endDate: shift.endDate } : {}) }); } catch { invalid(); }
  if (shift.date !== item.date ? !own(item, 'movedDate') || item.movedDate !== shift.date : own(item, 'movedDate')) invalid();
  const projection = { ...source, employeeId: shift.employeeId, carePlanId: shift.carePlanId, startTime: shift.startTime.length === 5 ? shift.startTime : shift.startTime.slice(11, 16), endTime: shift.endTime.length === 5 ? shift.endTime : shift.endTime.slice(11, 16), services: shift.services, note: shift.note }; if (own(shift, 'endDate')) projection.endDay = shift.endDate === shift.date ? 'same' : 'next'; else delete projection.endDay; assertShiftSeriesRecord(projection, orgId); return item;
}
function sameSeries(value, series, orgId) { assertShiftSeriesRecord(value, orgId); if (!same(value, series)) invalid(); }
export function confirmShiftSeriesOccurrences(result, series, range, orgId) {
  safeData(result); safeData(series); safeData(range);
  if (!plain(result) || Object.keys(result).some(key => !['series', 'range', 'items', 'total'].includes(key)) || !same(result.range, range) || !Array.isArray(result.items) || result.total !== result.items.length || result.total > 93) invalid(); sameSeries(result.series, series, orgId);
  let previous = ''; for (const item of result.items) { assertOccurrence(item, series, orgId); if (item.date <= previous || item.date < range.fromDate || item.date > range.toDate) invalid(); previous = item.date; } return result;
}
export function confirmShiftSeriesGenerationPreview(result, series, range, orgId) {
  safeData(result); safeData(series); safeData(range);
  if (!plain(result) || Object.keys(result).some(key => !['series', 'range', 'items', 'total', 'readyCount', 'existingCount', 'conflictCount', 'canCommit'].includes(key)) || !same(result.range, range) || !Array.isArray(result.items) || result.total !== result.items.length || result.total > 93) invalid(); sameSeries(result.series, series, orgId);
  const dates = expectedShiftSeriesDates(series, range); if (!same(result.items.map(item => item.date), dates)) invalid();
  let ready = 0, existing = 0, conflicts = 0, previous = '';
  for (const item of result.items) {
    if (!plain(item) || Object.keys(item).some(key => !['date', 'status', 'candidate', 'occurrence', 'conflicts'].includes(key)) || !Number.isFinite(seriesCalendarDay(item.date)) || item.date <= previous || item.date < range.fromDate || item.date > range.toDate || !Array.isArray(item.conflicts)) invalid(); previous = item.date;
    for (const issue of item.conflicts) if (!plain(issue) || Object.keys(issue).some(key => !['code', 'message', 'fields'].includes(key)) || typeof issue.code !== 'string' || !issue.code || typeof issue.message !== 'string' || !issue.message || own(issue, 'fields') && (!plain(issue.fields) || Object.values(issue.fields).some(value => typeof value !== 'string'))) invalid();
    if (item.status === 'ready' && item.conflicts.length === 0 && !own(item, 'occurrence')) {
      const candidate = item.candidate, expected = { caseId: series.caseId, employeeId: series.employeeId, carePlanId: series.carePlanId, ...recurringShiftSpan(item.date, { startTime: series.startTime, endTime: series.endTime, ...(own(series, 'endDay') ? { endDay: series.endDay } : {}) }), services: series.services, status: 'scheduled', note: series.note }; if (!plain(candidate) || Object.keys(candidate).length !== Object.keys(expected).length || Object.keys(expected).some(key => !own(candidate, key) || !same(candidate[key], expected[key]))) invalid(); ready++;
    } else if (item.status === 'existing' && item.conflicts.length === 0 && !own(item, 'candidate')) { assertOccurrence(item.occurrence, series, orgId); if (item.occurrence.date !== item.date) invalid(); existing++; }
    else if (item.status === 'conflict' && item.conflicts.length && !own(item, 'candidate') && !own(item, 'occurrence')) conflicts++; else invalid();
  }
  if (result.readyCount !== ready || result.existingCount !== existing || result.conflictCount !== conflicts || result.canCommit !== (ready > 0 && conflicts === 0)) invalid(); return result;
}
export function expectedShiftSeriesDates(series, range) {
  safeData(series); safeData(range);
  const start = seriesCalendarDay(series.startDate), monday = start - (new Date(start * dayMs).getUTCDay() + 6) % 7, dates = [];
  for (let day = seriesCalendarDay(range.fromDate); day <= seriesCalendarDay(range.toDate); day++) { const text = new Date(day * dayMs).toISOString().slice(0, 10); if (text < series.startDate || series.endDate && text > series.endDate) continue;
    if (Math.floor((day - monday) / 7) % series.intervalWeeks === 0 && series.weekdays.includes((new Date(day * dayMs).getUTCDay() + 6) % 7 + 1)) dates.push(text); }
  return dates;
}
export function shiftSeriesAdjustmentDefinition(values, occurrences, series, orgId) {
  safeData(values); safeData(occurrences); safeData(series);
  if (!plain(values) || Object.keys(values).some(key => !['fromDate', 'toDate', 'action', 'items', 'employeeId', 'startTime', 'endTime', 'endDay', 'daysOffset', 'reason', 'selectionState'].includes(key))) error('items', '整組表單含未知欄位');
  const range = shiftSeriesRange(values, series), items = occurrences.items.filter(item => item.editable);
  if (!items.length || items.length > 50) error('items', '本期間可操作整組須為1至50筆；請縮小明確範圍');
  if (!Array.isArray(values.items) || values.items.length !== items.length || new Set(values.items).size !== values.items.length || items.some(item => !values.items.includes(item.shiftId))) error('items', '請明確勾選本範圍內的全部可操作班次；若只操作部分請縮小日期');
  if (!['reassign', 'cancel', 'reschedule', 'move'].includes(values.action)) error('action', '請選擇改派、取消、同日調時或整組移日');
  if (typeof values.reason !== 'string' || !values.reason.trim() || values.reason.length > 2000) error('reason', '本次原因必填且最多2000字');
  for (const item of items) assertOccurrence(item, series, orgId);
  const definition = { ...range, action: values.action, items: items.map(item => ({ id: item.shiftId, version: item.shift.version })), reason: values.reason };
  if (values.action === 'reassign') { if (!identity(values.employeeId)) error('employeeId', '請選擇改派人員'); definition.employeeId = values.employeeId; }
  if (values.action === 'reschedule') { for (const key of ['startTime', 'endTime']) if (typeof values[key] !== 'string' || values[key].length !== 5 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(values[key])) error(key, '請填寫同日有效HH:mm'); if (own(values, 'endDay') && !['preserve', 'same', 'next'].includes(values.endDay)) error('endDay', '請選擇保留、同日或翌日'); definition.startTime = values.startTime; definition.endTime = values.endTime; if (own(values, 'endDay') && values.endDay !== 'preserve') definition.endDay = values.endDay; for (const item of items) { try { const endDay = own(definition, 'endDay') ? definition.endDay : own(item.shift, 'endDate') ? item.shift.endDate === item.shift.date ? 'same' : 'next' : undefined; recurringShiftSpan(item.shift.date, { startTime: values.startTime, endTime: values.endTime, ...(endDay !== undefined ? { endDay } : {}) }); } catch { error('endTime', '每班結束須晚於開始；保留原格式時不能猜測跨日'); } } }
  if (values.action === 'move') { definition.daysOffset = shiftSeriesMoveOffset(values.daysOffset); for (const item of items) shiftSeriesMovedDate(item.shift.date, definition.daysOffset); }
  return definition;
}
export function confirmShiftSeriesAdjustment(result, definition, series, orgId, committed = false) {
  safeData(result); safeData(definition); safeData(series);
  const payloadKey = committed ? 'result' : 'preview';
  if (!plain(result) || Object.keys(result).length !== 4 || Object.keys(result).some(key => !['series', 'range', 'excluded', payloadKey].includes(key)) || !own(result, payloadKey) || !plain(result[payloadKey]) || !same(result.range, { version: definition.version, fromDate: definition.fromDate, toDate: definition.toDate }) || !Array.isArray(result.excluded)) invalid(); sameSeries(result.series, series, orgId);
  const selected = new Set(definition.items.map(item => item.id)), seen = new Set(); for (const link of result.excluded) { assertOccurrence(link, series, orgId); if (link.editable || selected.has(link.shiftId) || seen.has(link.shiftId) || link.date < definition.fromDate || link.date > definition.toDate) invalid(); seen.add(link.shiftId); }
  return result;
}
export function confirmShiftSeriesGenerationSave(result, prepared, series, range, orgId) {
  safeData(result);
  confirmShiftSeriesGenerationPreview(prepared, series, range, orgId);
  if (!plain(result) || Object.keys(result).some(key => !['batchId', 'series', 'range', 'items', 'total', 'createdCount', 'existingCount'].includes(key)) || !identity(result.batchId) || !same(result.range, range) || !Array.isArray(result.items) || result.total !== prepared.total || result.items.length !== prepared.total || result.createdCount !== prepared.readyCount || result.existingCount !== prepared.existingCount) invalid(); sameSeries(result.series, series, orgId);
  const ids = new Set(); for (let index = 0; index < result.items.length; index++) {
    const item = result.items[index], before = prepared.items[index]; if (!plain(item) || Object.keys(item).length !== 3 || item.date !== before.date || item.created !== (before.status === 'ready')) invalid(); const link = assertOccurrence(item.occurrence, series, orgId); if (ids.has(link.shiftId) || link.date !== item.date) invalid(); ids.add(link.shiftId);
    if (!item.created) { if (!same(link, before.occurrence)) invalid(); }
    else { if (!same(link.seriesSnapshot, series) || link.seriesVersion !== series.version || link.shift.version !== 1) invalid(); for (const [key, value] of Object.entries(before.candidate)) if (!same(link.shift[key], value)) invalid(); }
  }
  return result;
}

export function shiftSeriesMoveOffset(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value === value.trim() && !/[\r\n]/.test(value) && /^[+-]?[1-9]\d*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number === 0 || Math.abs(number) > 3652058) error('daysOffset', '移動日數須為非零整數；正數往後，負數往前');
  return number;
}
export function shiftSeriesMovedDate(date, daysOffset) {
  const start = seriesCalendarDay(date), offset = shiftSeriesMoveOffset(daysOffset), target = start + offset;
  if (!Number.isFinite(start) || target < seriesCalendarDay('0001-01-01') || target > seriesCalendarDay('9999-12-31')) error('daysOffset', '移日後日期須在0001-01-01至9999-12-31内');
  return new Date(target * dayMs).toISOString().slice(0, 10);
}
const shiftFields = ['caseId', 'employeeId', 'carePlanId', 'date', 'startTime', 'endTime', 'services', 'status', 'note'];
function moveShift(item, orgId, withMetadata) {
  const allowed = [...shiftFields, ...(own(item, 'endDate') ? ['endDate'] : []), ...(withMetadata ? ['id', 'orgId', 'version', 'createdAt', 'updatedAt'] : [])];
  if (!plain(item) || Object.keys(item).length !== allowed.length || Object.keys(item).some(key => !allowed.includes(key)) || shiftFields.some(key => !own(item, key))
    || ['caseId', 'employeeId', 'carePlanId'].some(key => !identity(item[key])) || !Number.isFinite(seriesCalendarDay(item.date)) || item.status !== 'scheduled' || typeof item.note !== 'string' || item.note.length > 10000
    || ['startTime', 'endTime'].some(key => typeof item[key] !== 'string' || item[key].length !== 5 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item[key]))
    || !Array.isArray(item.services) || !item.services.length || item.services.length > 100 || new Set(item.services.map(line => line.serviceItemId)).size !== item.services.length) invalid();
  for (const line of item.services) if (!plain(line) || Object.keys(line).length !== 2 || Object.keys(line).some(key => !['serviceItemId', 'quantity'].includes(key)) || !identity(line.serviceItemId) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 10000) invalid();
  try { shiftSpan({ date: item.date, startTime: item.startTime, endTime: item.endTime, ...(own(item, 'endDate') ? { endDate: item.endDate } : {}) }); } catch { invalid(); }
  if (withMetadata && (!identity(item.id) || item.orgId !== orgId || !Number.isSafeInteger(item.version) || item.version < 1 || ['createdAt', 'updatedAt'].some(key => !identity(item[key])))) invalid();
  return item;
}
function moveDefinition(definition) {
  if (!plain(definition) || definition.action !== 'move' || definition.daysOffset !== shiftSeriesMoveOffset(definition.daysOffset) || !Array.isArray(definition.items)
    || !definition.items.length || definition.items.length > 50 || typeof definition.reason !== 'string' || !definition.reason.trim() || definition.reason.length > 2000) invalid();
  const ids = new Set();
  for (const selection of definition.items) { if (!plain(selection) || Object.keys(selection).length !== 2 || !identity(selection.id) || !Number.isSafeInteger(selection.version) || selection.version < 1 || selection.version === Number.MAX_SAFE_INTEGER || ids.has(selection.id)) invalid(); ids.add(selection.id); }
  return { action: 'move', items: definition.items, reason: definition.reason, daysOffset: definition.daysOffset };
}
export function confirmShiftSeriesMovePreview(preview, definition, orgId) {
  safeData(preview); safeData(definition); const expected = moveDefinition(definition);
  if (!plain(preview) || Object.keys(preview).length !== 6 || Object.keys(preview).some(key => !['definition', 'items', 'total', 'readyCount', 'conflictCount', 'canCommit'].includes(key))
    || !same(preview.definition, expected) || !Array.isArray(preview.items) || preview.items.length !== definition.items.length || preview.total !== definition.items.length) invalid();
  let ready = 0, conflict = 0;
  for (let index = 0; index < preview.items.length; index++) {
    const row = preview.items[index], selection = definition.items[index];
    if (!plain(row) || Object.keys(row).some(key => !['id', 'version', 'originalDate', 'status', 'before', 'after', 'conflicts'].includes(key)) || row.id !== selection.id || row.version !== selection.version
      || !Number.isFinite(seriesCalendarDay(row.originalDate)) || row.originalDate < definition.fromDate || row.originalDate > definition.toDate || !Array.isArray(row.conflicts)) invalid();
    for (const problem of row.conflicts) if (!plain(problem) || Object.keys(problem).some(key => !['code', 'message', 'fields'].includes(key)) || !identity(problem.code) || typeof problem.message !== 'string' || !problem.message || own(problem, 'fields') && (!plain(problem.fields) || Object.values(problem.fields).some(value => typeof value !== 'string'))) invalid();
    if (own(row, 'before') !== own(row, 'after')) invalid();
    if (own(row, 'before')) {
      moveShift(row.before, orgId, true); moveShift(row.after, orgId, false);
      if (row.before.id !== selection.id || row.before.version !== selection.version || row.after.date !== shiftSeriesMovedDate(row.before.date, definition.daysOffset)) invalid();
      if (own(row.before, 'endDate') !== own(row.after, 'endDate') || own(row.before, 'endDate') && row.after.endDate !== shiftSeriesMovedDate(row.before.endDate, definition.daysOffset)) invalid();
      for (const key of shiftFields.filter(key => key !== 'date')) if (!same(row.before[key], row.after[key])) invalid();
    }
    if (row.status === 'ready' && row.conflicts.length === 0 && own(row, 'before')) ready++;
    else if (row.status === 'conflict' && row.conflicts.length > 0) conflict++;
    else invalid();
  }
  if (preview.readyCount !== ready || preview.conflictCount !== conflict || preview.canCommit !== (conflict === 0)) invalid(); return preview;
}
export function confirmShiftSeriesMoveSave(result, preview, definition, orgId) {
  safeData(result); confirmShiftSeriesMovePreview(preview, definition, orgId);
  if (!preview.canCommit || !plain(result) || Object.keys(result).length !== 6 || Object.keys(result).some(key => !['batchId', 'action', 'daysOffset', 'reason', 'items', 'total'].includes(key))
    || !identity(result.batchId) || result.action !== 'move' || result.daysOffset !== definition.daysOffset || result.reason !== definition.reason || result.total !== definition.items.length || !Array.isArray(result.items) || result.items.length !== result.total) invalid();
  for (let index = 0; index < result.items.length; index++) {
    const item = moveShift(result.items[index], orgId, true), before = preview.items[index].before, after = preview.items[index].after;
    if (item.id !== before.id || item.version !== before.version + 1 || item.createdAt !== before.createdAt) invalid();
    if (!sameEndingDate(item, after)) invalid();
    for (const key of shiftFields) if (!same(item[key], after[key])) invalid();
  }
  return result;
}
