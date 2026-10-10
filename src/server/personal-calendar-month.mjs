import { dateValid, fail, scopedRows } from './model.mjs';
import { personalCalendarEntity, guardPersonalCalendarAccess, assertPersonalCalendarItem, personalCalendarDate, filterPersonalCalendar } from './personal-calendar.mjs';

const maximumItems = 1000;
const maximumBytes = 2 * 1024 * 1024;

function monthQuery(params) {
  const allowed = new Set(['month', 'q', 'status']);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1)
      fail(422, 'INVALID_QUERY', '月份檢視查詢欄位不合法或重複', { [key]: '請使用單一合法查詢欄位' });
  }
  const month = params.get('month'), q = params.get('q') || '', status = params.get('status') || '';
  if (typeof month !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) || month.slice(0, 4) === '0000')
    fail(422, 'INVALID_DATE', '月份須為0001至9999的有效YYYY-MM', { month: '請提供有效月份' });
  if (q.length > 200) fail(422, 'INVALID_QUERY', '搜尋文字最多200字元', { q: '搜尋文字過長' });
  if (status && !['active', 'cancelled'].includes(status))
    fail(422, 'INVALID_STATUS', '行事事件狀態不合法', { status: '狀態不合法' });
  return { month, q, status };
}

function literalOrder(a, b) {
  for (const key of ['date', 'startTime', 'endTime', 'id']) {
    const left = typeof a[key] === 'string' ? a[key] : '', right = typeof b[key] === 'string' ? b[key] : '';
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** Complete self-owned month reading; no inferred dates, repairs or writes. */
export function readPersonalCalendarMonth(db, ctx, params) {
  guardPersonalCalendarAccess(personalCalendarEntity, ctx, fail);
  const { month, q, status } = monthQuery(params);
  const selected = filterPersonalCalendar(scopedRows(db, ctx, personalCalendarEntity), { q, status, date: '' });
  const items = [];
  let undatedCount = 0;
  for (const item of selected) {
    const dated = personalCalendarDate(item.date, dateValid);
    if (dated && item.date.slice(0, 7) !== month) continue;
    // Every visible monthly or undated candidate is checked before either bound.
    assertPersonalCalendarItem(item, ctx, fail);
    if (dated) items.push(item);
    else undatedCount++;
  }
  const limit = () => fail(422, 'CALENDAR_LIMIT', '完整月份資料超過1000筆或2MiB，請加搜尋文字或狀態縮小條件，或回清單閱讀。');
  if (items.length > maximumItems) limit();
  items.sort(literalOrder);
  const result = { month, q, status, orgId: ctx.orgId, ownerUserId: ctx.user.id, items, total: items.length, undatedCount };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maximumBytes) limit();
  return result;
}
