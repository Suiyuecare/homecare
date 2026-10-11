import { calendarDay, shiftSpan, serviceSpan } from './shift-span.js';
import { CALENDAR_SPAN_MODE } from './shift-span-editor.js';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const closed = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => { const d = Object.getOwnPropertyDescriptor(value, key); return d?.enumerable && Object.hasOwn(d, 'value'); });
const array = value => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && Reflect.ownKeys(value).length === value.length + 1 && Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i))).every(d => d?.enumerable && Object.hasOwn(d, 'value'));
export function reportRowSpan(row, entity) {
  const service = entity === 'service-records', ending = service ? 'actualEndDate' : 'endDate';
  const start = service ? 'actualStart' : 'startTime', end = service ? 'actualEnd' : 'endTime';
  const keys = ['date', start, end, ending];
  if (!plain(row) || !keys.every(key => { const d = Object.getOwnPropertyDescriptor(row, key); return d?.enumerable && Object.hasOwn(d, 'value') && typeof d.value === 'string'; })) return null;
  const input = Object.fromEntries(keys.map(key => [key, row[key]]));
  // Full reports show an ending date for legacy rows too, without changing their stored presence or ISO text.
  if (input[ending] === input.date && (!/^\d{2}:\d{2}$/.test(input[start]) || !/^\d{2}:\d{2}$/.test(input[end]))) delete input[ending];
  try { return service ? serviceSpan(input) : shiftSpan(input); } catch { return null; }
}
export function spanReportConfig(base, entity, { rangeMode = 'starts' } = {}) {
  const service = entity === 'service-records', ending = service ? 'actualEndDate' : 'endDate';
  const fixedFilters = Object.freeze({ spanMode: CALENDAR_SPAN_MODE, ...(entity === 'shifts' ? { rangeMode } : {}) });
  if (!['starts', 'intersects'].includes(rangeMode) || (entity !== 'shifts' && rangeMode !== 'starts')) throw new Error('未知完整日期報表範圍。');
  const columns = Object.freeze(base.columns.flatMap(column => column.key === 'date' ? [column, Object.freeze({ key: ending, label: '結束日期' })] : [column]));
  const rowFields = Object.freeze({ ...base.rowFields, [ending]: 'string' });
  const envelope = ['title', 'organization', 'filters', 'selection', 'generatedAt', 'columns', 'rows', 'totals', 'total', 'page', 'pageSize', 'note'];
  const selection = entity === 'leave-requests' ? ['employee', 'status'] : ['case', 'employee', 'status'];
  const filters = entity === 'leave-requests' ? ['startDate', 'endDate', 'q', 'employeeId', 'status', 'spanMode'] : ['startDate', 'endDate', 'caseId', 'employeeId', 'status', 'spanMode', ...(entity === 'shifts' ? ['rangeMode'] : [])];
  return Object.freeze({ ...base, columns, rowFields, fixedFilters,
    date: Object.freeze({ ...base.date, displayRowKeys: [ending], ...(rangeMode === 'intersects' ? { intersects: true } : {}) }),
    copy: Object.freeze({ ...base.copy, help: base.copy.help + (rangeMode === 'intersects' ? ' 完整日期模式依實際重疊日期顯示，包含前日開始的班次。' : ' 完整日期模式依保存開始日查詢；結束日期另列，不回寫舊紀錄。') }),
    confirmEnvelope: value => closed(value, envelope) && closed(value.organization, ['name']) && closed(value.filters, filters) && closed(value.selection, selection)
      && closed(value.totals, service ? ['count', 'serviceMinutes'] : ['count']) && array(value.columns) && value.columns.every(c => closed(c, ['key', 'label']))
      && array(value.rows) && value.rows.every(r => closed(r, Object.keys(rowFields))),
    validateRow: (row, { filters: requested }) => {
      const span = reportRowSpan(row, entity); if (!span) return false;
      if (rangeMode === 'intersects' && !(span.start < (calendarDay(requested.endDate) + 1) * 1440 && calendarDay(requested.startDate) * 1440 < span.end)) return false;
      if (service && row.serviceMinutes !== span.durationMinutes) return false;
      if (entity === 'leave-requests') {
        if (requested.employeeId && row.employeeId !== requested.employeeId) return false;
        if (requested.q && ![row.employeeNo, row.employee, row.type, row.reason, row.statusLabel].some(v => v.toLowerCase().includes(requested.q.toLowerCase()))) return false;
      }
      return true;
    },
  });
}
