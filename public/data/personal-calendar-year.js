import { calendarPeriod } from './shift-calendar.js';
import { PERSONAL_CALENDAR_STATUSES, confirmPersonalCalendarList, isPersonalCalendarDate } from './personal-calendar-editor.js';

export const PERSONAL_CALENDAR_YEAR_MAX_ITEMS = 1000;
export const PERSONAL_CALENDAR_YEAR_MAX_BYTES = 2 * 1024 * 1024;
const envelope = ['year', 'q', 'status', 'orgId', 'ownerUserId', 'items', 'total', 'undatedCount'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, name) => Object.hasOwn(value, name);
const identifier = value => typeof value === 'string' && Boolean(value.trim());
const knownStatus = value => PERSONAL_CALENDAR_STATUSES.some(item => item.value === value);
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
const fieldError = (name, message) => Object.assign(new Error(message), { fields: { [name]: message } });
function unconfirmed() {
  throw Object.assign(new Error('年度事件回應無法確認；請重新讀取或縮小查詢條件。'), { code: 'PERSONAL_CALENDAR_YEAR_UNCONFIRMED' });
}
// Only descriptor values are copied; hidden accessors and opaque JSON never become display text.
function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)) return value;
  if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) unconfirmed();
  ancestors.add(value);
  const array = Array.isArray(value), result = array ? [] : {};
  if (array && (Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== value.length + 1)) unconfirmed();
  let index = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !own(descriptor, 'value')
      || array && key !== String(index++)) unconfirmed();
    put(result, key, copyJson(descriptor.value, ancestors));
  }
  ancestors.delete(value);
  return result;
}
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => own(value, key));

export function personalCalendarYearPeriod(year) {
  if (typeof year !== 'string' || !/^(?!0000)\d{4}$/.test(year))
    throw fieldError('year', '請填寫四碼有效西元年度 YYYY（0001 至 9999 年）。');
  const numericYear = Number(year);
  const months = Array.from({ length: 12 }, (_, index) => {
    const month = `${year}-${String(index + 1).padStart(2, '0')}`;
    return Object.freeze({ ...calendarPeriod('month', month + '-01'), month });
  });
  return Object.freeze({ year, startDate: `${year}-01-01`, endDate: `${year}-12-31`,
    previousYear: year === '0001' ? null : String(numericYear - 1).padStart(4, '0'),
    nextYear: year === '9999' ? null : String(numericYear + 1).padStart(4, '0'), months: Object.freeze(months) });
}

export function personalCalendarYearFilters(year, q = '', status = '') {
  personalCalendarYearPeriod(year);
  if (typeof q !== 'string' || q.length > 200) throw fieldError('q', '搜尋文字最多 200 個字元，依原文查詢。');
  if (typeof status !== 'string' || status !== '' && !knownStatus(status)) throw fieldError('status', '請選擇有效的事件狀態。');
  return Object.freeze({ year, q, status });
}

const orderValue = (row, name) => typeof row[name] === 'string' ? row[name] : '';
function ascending(previous, current) {
  for (const name of ['date', 'startTime', 'endTime', 'id']) {
    const left = orderValue(previous, name), right = orderValue(current, name);
    if (left < right) return true;
    if (left > right) return false;
  }
  return true;
}

export function confirmPersonalCalendarYear(result, requested) {
  try {
    result = copyJson(result); requested = copyJson(requested);
    if (!exact(requested, ['year', 'q', 'status', 'orgId', 'ownerUserId'])
      || !identifier(requested.orgId) || !identifier(requested.ownerUserId)) unconfirmed();
    personalCalendarYearFilters(requested.year, requested.q, requested.status);
    if (!exact(result, envelope) || ['year', 'q', 'status', 'orgId', 'ownerUserId'].some(key => result[key] !== requested[key])
      || !Array.isArray(result.items) || result.items.length > PERSONAL_CALENDAR_YEAR_MAX_ITEMS
      || !Number.isSafeInteger(result.total) || result.total !== result.items.length
      || !Number.isSafeInteger(result.undatedCount) || result.undatedCount < 0
      || new TextEncoder().encode(JSON.stringify(result)).byteLength > PERSONAL_CALENDAR_YEAR_MAX_BYTES) unconfirmed();
    for (let offset = 0; offset < result.items.length; offset += 25) {
      const items = result.items.slice(offset, offset + 25);
      confirmPersonalCalendarList({ items, total: items.length, page: 1, pageSize: 25 },
        { page: 1, pageSize: 25, orgId: requested.orgId, ownerUserId: requested.ownerUserId, q: requested.q, status: requested.status });
    }
    const ids = new Set();
    for (let index = 0; index < result.items.length; index++) {
      const item = result.items[index];
      if (!own(item, 'date') || !isPersonalCalendarDate(item.date) || item.date.slice(0, 4) !== requested.year
        || ids.has(item.id) || index > 0 && !ascending(result.items[index - 1], item)) unconfirmed();
      ids.add(item.id);
    }
    return result;
  } catch { unconfirmed(); }
}

export function groupPersonalCalendarYear(result, requested) {
  const confirmed = confirmPersonalCalendarYear(result, requested), period = personalCalendarYearPeriod(requested.year);
  const groups = period.months.map(item => ({ month: item.month, rows: [] })), byMonth = new Map(groups.map(group => [group.month, group]));
  for (const row of confirmed.items) byMonth.get(row.date.slice(0, 7)).rows.push(row);
  return Object.freeze(groups.map(group => Object.freeze({ month: group.month, rows: Object.freeze(group.rows) })));
}
