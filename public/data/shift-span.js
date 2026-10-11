// v074 isolated candidate: calendar wall-clock arithmetic only. No DB, payroll, dates inferred from clock order, or runtime registration.
export const MINUTES_PER_DAY = 1440;
export const LAST_CALENDAR_DAY = 3652424;
export class ShiftSpanError extends Error {
  constructor(code, message) { super(message); this.name = 'ShiftSpanError'; this.code = code; }
}
const reject = (code, message) => { throw new ShiftSpanError(code, message); };
const mintedSpans = new WeakSet();
const assertMintedSpan = span => { if (!mintedSpans.has(span)) reject('SPAN_RESULT_INVALID', '須先使用本模組由封閉資料確認完整区間。'); return span; };
const closedKeys = (value, required, optional = []) => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key => typeof key === 'string' && [...required, ...optional].includes(key) && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) && required.every(key => Object.hasOwn(value, key));
const leap = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const monthDays = (year, month) => month === 2 ? leap(year) ? 29 : 28 : [4, 6, 9, 11].includes(month) ? 30 : 31;
const beforeYear = year => 365 * year + Math.floor((year + 3) / 4) - Math.floor((year + 99) / 100) + Math.floor((year + 399) / 400);
const closed = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.every(key => typeof key === 'string' && ['date', 'startTime', 'endTime', 'endDate'].includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))
    && ['date', 'startTime', 'endTime'].every(key => Object.hasOwn(value, key));
};
export function calendarDay(value) {
  if (typeof value !== 'string' || value.length !== 10 || /[\r\n]/.test(value) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) reject('SPAN_DATE_INVALID', '日期須為四碼年份的有效 Gregorian 日曆日期。');
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8));
  if (month < 1 || month > 12 || day < 1 || day > monthDays(year, month)) reject('SPAN_DATE_INVALID', '日期不存在。');
  let ordinal = beforeYear(year) + day - 1;
  for (let m = 1; m < month; m++) ordinal += monthDays(year, m);
  return ordinal;
}
export function calendarDate(ordinal) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > LAST_CALENDAR_DAY) reject('SPAN_DATE_LIMIT', '日期超出0000至9999的既有相容範圍。');
  let low = 0, high = 9999;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (beforeYear(mid) <= ordinal) low = mid; else high = mid - 1; }
  const year = low; let remaining = ordinal - beforeYear(year), month = 1;
  while (remaining >= monthDays(year, month)) remaining -= monthDays(year, month++);
  return String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(remaining + 1).padStart(2, '0');
}
export const nextCalendarDate = date => calendarDate(calendarDay(date) + 1);
export function exactTimeMinute(value) {
  if (typeof value !== 'string' || value.length !== 5 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return NaN;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
// Intentionally mirrors model.timeMinute for old same-day records only, including
// its literal minute precision and ignoring ISO seconds/offsets. No stored rewrite.
export function legacyTimeMinute(value, date) {
  if (typeof value !== 'string') return NaN;
  if (/^\d{2}:\d{2}$/.test(value)) { const [hour, minute] = value.split(':').map(Number); return hour < 24 && minute < 60 ? hour * 60 + minute : NaN; }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && value.slice(0, 10) === date && Number.isFinite(Date.parse(value))) return legacyTimeMinute(value.slice(11, 16), date);
  return NaN;
}
export function shiftSpan(value, options = {}) {
  if (!closedKeys(options, [], ['legacyWithoutEndDate']) || Object.hasOwn(options, 'legacyWithoutEndDate') && typeof options.legacyWithoutEndDate !== 'boolean') reject('SPAN_OPTIONS_INVALID', '只接受明確boolean相容選項，拒絕getter。');
  const legacyWithoutEndDate = Object.hasOwn(options, 'legacyWithoutEndDate') ? options.legacyWithoutEndDate : true;
  if (!closed(value)) reject('SPAN_SHAPE_INVALID', '只接受date/startTime/endTime及選填endDate的封閉資料；拒絕accessor。');
  const startDay = calendarDay(value.date), hasEndDate = Object.hasOwn(value, 'endDate'), endDate = hasEndDate ? value.endDate : value.date, endDay = calendarDay(endDate);
  if (endDay < startDay || endDay > startDay + 1) reject('SPAN_DATE_RANGE', '此提案只支援同日或翌日結束，最多兩個日曆日期。');
  const legacy = !hasEndDate && legacyWithoutEndDate, startMinute = legacy ? legacyTimeMinute(value.startTime, value.date) : exactTimeMinute(value.startTime), endMinute = legacy ? legacyTimeMinute(value.endTime, value.date) : exactTimeMinute(value.endTime);
  if (!Number.isSafeInteger(startMinute) || !Number.isSafeInteger(endMinute)) reject('SPAN_TIME_INVALID', '新增明確起訖日期時須填HH:mm；既有同日ISO只按原語意讀取。');
  const start = startDay * MINUTES_PER_DAY + startMinute, end = endDay * MINUTES_PER_DAY + endMinute;
  if (end <= start) reject('SPAN_TIME_RANGE', '結束須晚於開始；不能由較早時鐘時間猜測跨夜。');
  const segments = [];
  for (let day = startDay; day <= endDay; day++) {
    const a = Math.max(start, day * MINUTES_PER_DAY), b = Math.min(end, (day + 1) * MINUTES_PER_DAY);
    if (a < b) segments.push(Object.freeze({ date: calendarDate(day), startMinute: a - day * MINUTES_PER_DAY, endMinute: b - day * MINUTES_PER_DAY, minutes: b - a }));
  }
  const result = Object.freeze({ date: value.date, endDate, hasEndDate, startMinute, endMinute, start, end, durationMinutes: end - start, lastOccupiedDate: segments.at(-1).date, segments: Object.freeze(segments) });
  mintedSpans.add(result); return result;
}
export function spansOverlap(left, right) {
  assertMintedSpan(left); assertMintedSpan(right);
  return left.start < right.end && right.start < left.end;
}
export function spanCoveredByDates(span, validFrom, validTo) {
  assertMintedSpan(span);
  const first = calendarDay(validFrom), last = calendarDay(validTo);
  if (last < first) reject('SPAN_VALIDITY_INVALID', '有效期間或已佔用日期無法確認。');
  return span.segments.every(segment => { const day = calendarDay(segment.date); return day >= first && day <= last; });
}
export function moveCalendarDate(date, offsetDays) {
  if (!Number.isSafeInteger(offsetDays)) reject('SPAN_OFFSET_INVALID', '移日須為完整的整數日曆天數。');
  return calendarDate(calendarDay(date) + offsetDays);
}

// No full entity projection: caller must first apply its existing closed DTO,
// parent/org/version/current-head checks before selecting this typed subset.
export function serviceSpan(value) {
  if (!closedKeys(value, ['date', 'actualStart', 'actualEnd'], ['actualEndDate'])) reject('SPAN_SHAPE_INVALID', '只接受date/actualStart/actualEnd及選填actualEndDate。');
  return shiftSpan({ date: value.date, startTime: value.actualStart, endTime: value.actualEnd, ...(Object.hasOwn(value, 'actualEndDate') ? { endDate: value.actualEndDate } : {}) });
}
export const leaveSpan = value => shiftSpan(value);
export function visibleSpanSegments(span, range) {
  assertMintedSpan(span);
  if (!closedKeys(range, ['startDate', 'endDate'])) reject('SPAN_FILTER_INVALID', '只接受完整開始與結束日範圍。');
  const first = calendarDay(range.startDate), last = calendarDay(range.endDate);
  if (last < first) reject('SPAN_FILTER_INVALID', '結束日不可早於開始日。');
  return Object.freeze(span.segments.filter(segment => { const day = calendarDay(segment.date); return day >= first && day <= last; }));
}
export function spanWithinValidity(span, validity) {
  assertMintedSpan(span);
  if (!closedKeys(validity, [], ['validFrom', 'validTo'])) reject('SPAN_VALIDITY_INVALID', '只接受選填有效起訖日，missing才為無界。');
  const first = Object.hasOwn(validity, 'validFrom') ? calendarDay(validity.validFrom) : 0;
  const last = Object.hasOwn(validity, 'validTo') ? calendarDay(validity.validTo) : LAST_CALENDAR_DAY;
  if (last < first) reject('SPAN_VALIDITY_INVALID', '有效範圍次序不符。');
  return span.segments.every(segment => { const day = calendarDay(segment.date); return day >= first && day <= last; });
}
export function moveShiftSpan(value, offsetDays) {
  shiftSpan(value);
  if (!Number.isSafeInteger(offsetDays) || offsetDays === 0) reject('SPAN_OFFSET_INVALID', '移日需非零safe integer。');
  if (![value.startTime, value.endTime].every(time => Number.isSafeInteger(exactTimeMinute(time)))) reject('MOVE_CLOCK_REPLACEMENT_REQUIRED', '既有ISO原文不得裁切，請先明確取代為完整HH:mm再移日。');
  const moved = { date: moveCalendarDate(value.date, offsetDays), startTime: value.startTime, endTime: value.endTime, ...(Object.hasOwn(value, 'endDate') ? { endDate: moveCalendarDate(value.endDate, offsetDays) } : {}) };
  shiftSpan(moved); return Object.freeze(moved);
}
export function recurringShiftSpan(date, definition) {
  if (!closedKeys(definition, ['startTime', 'endTime'], ['endDay']) || ![definition.startTime, definition.endTime].every(time => Number.isSafeInteger(exactTimeMinute(time))) || Object.hasOwn(definition, 'endDay') && !['same', 'next'].includes(definition.endDay)) reject('SPAN_RECURRENCE_INVALID', '只接受HH:mm及選填same/next；週期尾日不得作為每班結束日。');
  calendarDay(date);
  const value = { date, startTime: definition.startTime, endTime: definition.endTime, ...(Object.hasOwn(definition, 'endDay') ? { endDate: definition.endDay === 'next' ? nextCalendarDate(date) : date } : {}) };
  shiftSpan(value); return Object.freeze(value);
}
const snapshotBase = Object.freeze(['id', 'orgId', 'version', 'employeeId', 'date', 'startTime', 'endTime']);
const idText = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && value === value.trim() && !/[\r\n]/.test(value);
// Shape discriminator only. Seven-key historical policy MUST continue through
// its original domain validator (attendance and substitution differ there).
export function referenceSnapshotKind(value) {
  if (!closedKeys(value, snapshotBase, ['endDate']) || !['id', 'orgId', 'employeeId'].every(key => idText(value[key])) || !Number.isSafeInteger(value.version) || value.version < 1 || ![value.startTime, value.endTime].every(time => Number.isSafeInteger(exactTimeMinute(time)))) reject('SPAN_REFERENCE_INVALID', '只接受七欄歷史或八欄明確span純scalar快照。');
  calendarDay(value.date); if (value.date.startsWith('0000-')) reject('SPAN_REFERENCE_INVALID', '依原兩個參照域，日期須0001以上；人工班次舊0000不在此推定新參照權。');
  if (!Object.hasOwn(value, 'endDate')) return 'legacy-seven';
  shiftSpan({ date: value.date, startTime: value.startTime, endTime: value.endTime, endDate: value.endDate }); return 'explicit-eight';
}
export function explicitReferenceSpan(value) {
  if (referenceSnapshotKind(value) !== 'explicit-eight') reject('SPAN_REFERENCE_LEGACY_POLICY_REQUIRED', '七欄歷史沿原domain validator，不猜補結束日期或重新計算。');
  return shiftSpan({ date: value.date, startTime: value.startTime, endTime: value.endTime, endDate: value.endDate });
}
export function assertCapturedServiceMinutes(minutes, span) {
  assertMintedSpan(span);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes !== span.durationMinutes) reject('SPAN_CAPTURED_MINUTES_INVALID', '核閱時保存技術分鐘須等於同一已保存完整span，不從現價或現班回算。');
  return minutes;
}
