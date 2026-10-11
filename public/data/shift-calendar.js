import { visibleSpanSegments } from './shift-span.js';
import { reportRowSpan } from './span-report.js';
import { confirmReport } from '../modules/report-view.js';
import { shiftReportConfig, shiftCalendarReportConfig } from '../modules/shift-report.js';
import { calendarPersonFilters } from './shift-calendar-person-filters.js';

const LAST_ORDINAL = 3652424;
const MAX_ROWS = 1000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const envelopeKeys = ['title', 'organization', 'filters', 'selection', 'generatedAt', 'columns', 'rows', 'totals', 'total', 'page', 'pageSize', 'note'];
const filterKeys = ['startDate', 'endDate', 'caseId', 'employeeId', 'status'];
const sortKeys = ['date', 'startTime', 'caseNo', 'employeeNo', 'shiftId'];
const fieldError = (field, message) => Object.assign(new Error(message), { fields: { [field]: message } });
const unconfirmed = () => Object.assign(new Error('未取得完整且一致的班表，請重新讀取或調整查詢條件。'), { code: 'CALENDAR_UNCONFIRMED' });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
});
const array = value => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  && Reflect.ownKeys(value).length === value.length + 1 && Reflect.ownKeys(value).every((key, index) => {
    if (index === value.length) return key === 'length';
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return key === String(index) && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value');
  });
const leap = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const monthDays = (year, month) => month === 2 ? (leap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
const beforeYear = year => 365 * year + Math.floor((year + 3) / 4) - Math.floor((year + 99) / 100) + Math.floor((year + 399) / 400);
const dateText = (year, month, day) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

export function parseCalendarDate(value) {
  const match = typeof value === 'string' && value.length === 10 && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw fieldError('anchor', '請填寫有效的西元日期 YYYY-MM-DD（0000 至 9999 年）。');
  const [, y, m, d] = match, year = Number(y), month = Number(m), day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > monthDays(year, month)) {
    throw fieldError('anchor', '請填寫有效的西元日期 YYYY-MM-DD（0000 至 9999 年）。');
  }
  let ordinal = beforeYear(year) + day - 1;
  for (let previous = 1; previous < month; previous++) ordinal += monthDays(year, previous);
  return Object.freeze({ year, month, day, ordinal });
}

function fromOrdinal(ordinal) {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > LAST_ORDINAL) return null;
  let low = 0, high = 10000;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (beforeYear(middle) <= ordinal) low = middle;
    else high = middle;
  }
  let month = 1, remaining = ordinal - beforeYear(low);
  while (remaining >= monthDays(low, month)) remaining -= monthDays(low, month++);
  return dateText(low, month, remaining + 1);
}

export function calendarPeriod(mode, anchor) {
  if (mode !== 'week' && mode !== 'month') throw fieldError('mode', '請選擇週或月檢視。');
  const parsed = parseCalendarDate(anchor);
  let start, end, slots, previousAnchor, nextAnchor, rangeClipped = false;
  if (mode === 'week') {
    const monday = parsed.ordinal - (parsed.ordinal + 5) % 7;
    start = Math.max(0, monday); end = Math.min(LAST_ORDINAL, monday + 6);
    slots = Array.from({ length: 7 }, (_, index) => fromOrdinal(monday + index));
    previousAnchor = start === 0 ? null : fromOrdinal(Math.max(0, monday - 7));
    nextAnchor = fromOrdinal(monday + 7);
    rangeClipped = monday < 0 || monday + 6 > LAST_ORDINAL;
  } else {
    const { year, month } = parsed;
    start = parseCalendarDate(dateText(year, month, 1)).ordinal;
    end = start + monthDays(year, month) - 1;
    const offset = (start + 5) % 7;
    slots = Array.from({ length: 42 }, (_, index) => {
      const ordinal = start - offset + index;
      return ordinal < start || ordinal > end ? null : fromOrdinal(ordinal);
    });
    previousAnchor = year === 0 && month === 1 ? null : dateText(month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1, 1);
    nextAnchor = year === 9999 && month === 12 ? null : dateText(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1);
  }
  const dates = Array.from({ length: end - start + 1 }, (_, index) => fromOrdinal(start + index));
  return Object.freeze({ mode, anchor, startDate: fromOrdinal(start), endDate: fromOrdinal(end),
    slots: Object.freeze(slots), dates: Object.freeze(dates), previousAnchor, nextAnchor, rangeClipped });
}

function checkedPeriod(period) {
  if (!plain(period) || !['mode', 'anchor', 'startDate', 'endDate'].every(key => Object.hasOwn(period, key))) throw fieldError('anchor', '期間尚未確認，請重新選擇日期。');
  const derived = calendarPeriod(period.mode, period.anchor);
  if (period.startDate !== derived.startDate || period.endDate !== derived.endDate) {
    throw fieldError('anchor', '期間尚未確認，請重新選擇日期。');
  }
  return derived;
}

export function calendarFilters(period, status = '', person) {
  const derived = checkedPeriod(period);
  if (typeof status !== 'string' || (status !== '' && !Object.hasOwn(shiftReportConfig.statuses, status))) {
    throw fieldError('status', '請選擇有效的班次狀態。');
  }
  const people = calendarPersonFilters(person);
  return Object.freeze({ startDate: derived.startDate, endDate: derived.endDate, ...people, status });
}

export function confirmCalendarReport(result, period, status = '', person) {
  try {
    const filters = calendarFilters(period, status, person);
    if (!exact(result, envelopeKeys) || !exact(result.organization, ['name'])
      || !exact(result.filters, filterKeys) || !exact(result.selection, ['case', 'employee', 'status'])
      || !exact(result.totals, ['count']) || !array(result.columns)
      || result.columns.some(column => !exact(column, ['key', 'label'])) || !array(result.rows)
      || result.rows.some(row => !exact(row, Object.keys(shiftReportConfig.rowFields)))
      || !Number.isSafeInteger(result.total) || result.total < 0 || result.total > MAX_ROWS) throw unconfirmed();
    confirmReport(shiftReportConfig, result, filters, { complete: true });
    for (let index = 1; index < result.rows.length; index++) {
      const previous = result.rows[index - 1], next = result.rows[index];
      for (const key of sortKeys) {
        if (previous[key] < next[key]) break;
        if (previous[key] > next[key]) throw unconfirmed();
      }
    }
    const serialized = JSON.stringify(result);
    if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).byteLength > MAX_JSON_BYTES) throw unconfirmed();
    return result;
  } catch {
    throw unconfirmed();
  }
}

export function groupCalendarRows(result, period, status = '', person) {
  confirmCalendarReport(result, period, status, person);
  const derived = checkedPeriod(period);
  const groups = derived.dates.map(date => ({ date, rows: [] }));
  const byDate = new Map(groups.map(group => [group.date, group]));
  for (const row of result.rows) byDate.get(row.date).rows.push(row);
  return Object.freeze(groups.map(group => Object.freeze({ date: group.date, rows: Object.freeze(group.rows) })));
}

/** Opt-in complete dates; original calendar exports keep their legacy DTO contract. */
export function spanCalendarFilters(period, status = '', person) {
  return Object.freeze({ ...calendarFilters(period, status, person), ...shiftCalendarReportConfig.fixedFilters });
}
export function confirmSpanCalendarReport(result, period, status = '', person) {
  try {
    const filters = spanCalendarFilters(period, status, person);
    if (!shiftCalendarReportConfig.confirmEnvelope(result) || !Number.isSafeInteger(result.total) || result.total < 0 || result.total > MAX_ROWS) throw unconfirmed();
    confirmReport(shiftCalendarReportConfig, result, filters, { complete: true });
    for (let i = 1; i < result.rows.length; i++) {
      const previous = result.rows[i - 1], next = result.rows[i];
      for (const key of sortKeys) { if (previous[key] < next[key]) break; if (previous[key] > next[key]) throw unconfirmed(); }
    }
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_JSON_BYTES) throw unconfirmed();
    return result;
  } catch { throw unconfirmed(); }
}
export function groupSpanCalendarRows(result, period, status = '', person) {
  confirmSpanCalendarReport(result, period, status, person);
  const derived = checkedPeriod(period), groups = derived.dates.map(date => ({ date, rows: [] })), byDate = new Map(groups.map(group => [group.date, group]));
  for (const row of result.rows) {
    const span = reportRowSpan(row, 'shifts');
    for (const segment of visibleSpanSegments(span, { startDate: derived.startDate, endDate: derived.endDate })) {
      const clock = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
      byDate.get(segment.date).rows.push(Object.freeze({ ...row, displaySegment: `${segment.date} ${clock(segment.startMinute)}–${clock(segment.endMinute)}${segment.date !== row.date ? '（前日開始，本日延續）' : span.hasEndDate && row.endDate !== row.date ? '（本日開始，翌日結束）' : ''}` }));
    }
  }
  return Object.freeze(groups.map(group => Object.freeze({ date: group.date, rows: Object.freeze(group.rows) })));
}
