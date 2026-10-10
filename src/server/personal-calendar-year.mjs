import { dateValid, fail, scopedRows } from './model.mjs';
import { personalCalendarEntity, guardPersonalCalendarAccess, assertPersonalCalendarItem, personalCalendarDate, filterPersonalCalendar } from './personal-calendar.mjs';

const maximumItems = 1000;
const maximumBytes = 2 * 1024 * 1024;

function yearQuery(params) {
  const allowed = new Set(['year', 'q', 'status']);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1)
      fail(422, 'INVALID_QUERY', '年度檢視查詢欄位不合法或重複', { [key]: '請使用單一合法查詢欄位' });
  }
  const year = params.get('year'), q = params.get('q') || '', status = params.get('status') || '';
  if (typeof year !== 'string' || !/^(?!0000)\d{4}$/.test(year))
    fail(422, 'INVALID_DATE', '年度須為0001至9999的四位西元年', { year: '請提供有效年度' });
  if (q.length > 200) fail(422, 'INVALID_QUERY', '搜尋文字最多200字元', { q: '搜尋文字過長' });
  if (status && !['active', 'cancelled'].includes(status))
    fail(422, 'INVALID_STATUS', '行事事件狀態不合法', { status: '狀態不合法' });
  return { year, q, status };
}

function literalOrder(a, b) {
  for (const key of ['date', 'startTime', 'endTime', 'id']) {
    const left = typeof a[key] === 'string' ? a[key] : '', right = typeof b[key] === 'string' ? b[key] : '';
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** Complete self-owned year reading; no inferred dates, repairs or writes. */
export function readPersonalCalendarYear(db, ctx, params) {
  guardPersonalCalendarAccess(personalCalendarEntity, ctx, fail);
  const { year, q, status } = yearQuery(params);
  const selected = filterPersonalCalendar(scopedRows(db, ctx, personalCalendarEntity), { q, status, date: '' });
  const items = [];
  let undatedCount = 0;
  for (const item of selected) {
    const dated = personalCalendarDate(item.date, dateValid);
    if (dated && item.date.slice(0, 4) !== year) continue;
    // Check every visible year or undated candidate before applying either bound.
    assertPersonalCalendarItem(item, ctx, fail);
    if (dated) items.push(item);
    else undatedCount++;
  }
  const limit = () => fail(422, 'CALENDAR_LIMIT', '完整年度資料超過1000筆或2MiB，請加搜尋文字或狀態縮小條件，或改用月份檢視／原清單。');
  if (items.length > maximumItems) limit();
  items.sort(literalOrder);
  const result = { year, q, status, orgId: ctx.orgId, ownerUserId: ctx.user.id, items, total: items.length, undatedCount };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maximumBytes) limit();
  return result;
}
