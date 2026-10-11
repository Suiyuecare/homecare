import { shiftSpan, spansOverlap } from '../data/shift-span.js';
import { assertSpanData, spanRecordText } from '../data/shift-span-editor.js';
import { api, el, button, getContext, openDetails, pagination } from '../ui.js';

const PAGE_SIZE = 25;
const leaveStatuses = { pending: '待審核', approved: '已核准', rejected: '已駁回', cancelled: '已取消' };
const shiftStatuses = { scheduled: '已排班', completed: '已完成' };
const employeeStatuses = { active: '啟用', inactive: '停用' };
const caseStatuses = { active: '服務中', paused: '暫停', closed: '結案' };
const identity = () => {
  const context = getContext();
  return JSON.stringify([context.user?.id, context.organizationId || context.orgId, context.role, context.user?.employeeId]);
};
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const nullableText = value => value === null || text(value);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const keys = (value, expected) => record(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

// Saved same-day ISO time uses its written HH:mm, as the existing conflict rule does.
function savedMinute(value, date) {
  if (typeof value !== 'string') return NaN;
  if (/^\d{2}:\d{2}$/.test(value)) {
    const [hour, minute] = value.split(':').map(Number);
    return hour < 24 && minute < 60 ? hour * 60 + minute : NaN;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && value.slice(0, 10) === date && Number.isFinite(Date.parse(value))) return savedMinute(value.slice(11, 16), date);
  return NaN;
}
function conflictSpan(item) { return shiftSpan({ date: item.date, startTime: item.startTime, endTime: item.endTime, ...(Object.hasOwn(item, 'endDate') ? { endDate: item.endDate } : {}) }); }
function validInterval(item) { try { return Boolean(conflictSpan(item)); } catch { return false; } }
function validTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !validDate(value.slice(0, 10))) return false;
  return Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60 && Number.isFinite(Date.parse(value));
}
function validEmployee(value) {
  return keys(value, ['id', 'name', 'employeeNo', 'status']) && text(value.id) && nullableText(value.name)
    && nullableText(value.employeeNo) && Object.hasOwn(employeeStatuses, value.status);
}
function validCase(value) {
  return value === null || (keys(value, ['id', 'name', 'caseNo', 'status']) && text(value.id) && nullableText(value.name)
    && nullableText(value.caseNo) && Object.hasOwn(caseStatuses, value.status));
}
export function confirmLeaveShiftConflicts(value, id, page) {
  const invalid = () => { throw new Error('未取得完整且有效的衝突班次資料，請重新讀取。'); };
  assertSpanData(value);
  if (!keys(value, ['leave', 'generatedAt', 'items', 'total', 'page', 'pageSize', 'note'])
    || !validTimestamp(value.generatedAt) || !text(value.note) || !Array.isArray(value.items)
    || !Number.isSafeInteger(value.total) || value.total < 0 || value.page !== page || value.pageSize !== PAGE_SIZE) invalid();
  const leave = value.leave;
  if (!keys(leave, ['id', 'version', 'employee', 'date', 'startTime', 'endTime', 'type', 'status', ...(Object.hasOwn(leave, 'endDate') ? ['endDate'] : [])])
    || leave.id !== id || !positiveInteger(leave.version) || !validEmployee(leave.employee)
    || !validInterval(leave) || !text(leave.type) || !Object.hasOwn(leaveStatuses, leave.status)) invalid();
  const expectedCount = Math.min(PAGE_SIZE, Math.max(0, value.total - (page - 1) * PAGE_SIZE));
  if (value.items.length !== expectedCount) invalid();
  const ids = new Set();
  let previous;
  for (const item of value.items) {
    if (!keys(item, ['shiftId', 'version', 'date', 'startTime', 'endTime', 'status', 'employee', 'case', 'hasServiceRecord', ...(Object.hasOwn(item, 'endDate') ? ['endDate'] : [])])
      || !text(item.shiftId) || ids.has(item.shiftId) || !positiveInteger(item.version) || !validInterval(item)
      || !Object.hasOwn(shiftStatuses, item.status) || !validEmployee(item.employee)
      || !['id', 'name', 'employeeNo', 'status'].every(key => item.employee[key] === leave.employee[key])
      || !validCase(item.case) || typeof item.hasServiceRecord !== 'boolean') invalid();
    const interval = conflictSpan(item), start = interval.start, end = interval.end;
    if (!spansOverlap(interval, conflictSpan(leave))) invalid();
    if (previous && (previous.start > start || (previous.start === start && (previous.end > end || (previous.end === end && previous.id > item.shiftId))))) invalid();
    previous = { start, end, id: item.shiftId };
    ids.add(item.shiftId);
  }
  return value;
}

function fields(entries) {
  return el('dl', { class: 'history-fields' }, entries.map(([label, value]) => el('div', {}, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value))));
}
function employeeNode(employee) {
  return el('div', {}, el('span', {}, employee.name || '目前員工名稱無法取得'),
    el('p', { class: 'muted' }, `員工編號：${employee.employeeNo || '未提供'} · ${employeeStatuses[employee.status]}`),
    el('details', {}, el('summary', {}, '查看員工識別碼'), el('code', { class: 'pre-wrap' }, employee.id)));
}
function caseNode(item) {
  if (!item) return el('span', { class: 'notice' }, '目前個案資料無法取得，請核對資料');
  return el('div', {}, el('span', {}, item.name || '目前個案名稱無法取得'),
    el('p', { class: 'muted' }, `個案編號：${item.caseNo || '未提供'} · ${caseStatuses[item.status]}`),
    el('details', {}, el('summary', {}, '查看個案識別碼'), el('code', { class: 'pre-wrap' }, item.id)));
}
function shiftCard(item, index) {
  const guidance = [];
  if (item.hasServiceRecord) guidance.push('已有服務紀錄，不能改派、改時段或取消此班次。');
  if (item.status === 'completed') guidance.push('此班次已完成，不能依一般待服務班次操作改派或取消；請核對既有紀錄與狀態限制。');
  if (!item.hasServiceRecord && item.status === 'scheduled') guidance.push('目前沒有服務紀錄；可前往排班管理查看，任何變更仍須通過既有權限、狀態與衝突檢查。');
  return el('article', { class: 'service-card', 'aria-label': `衝突班次 ${index}` },
    el('h3', {}, `衝突班次 ${index}`),
    fields([
      ['班次識別碼', el('code', {}, item.shiftId)], ['班次版本', `第 ${item.version} 版`],
      ['班次完整日期時段', spanRecordText(item)], ['保存開始日期', item.date], ...(Object.hasOwn(item, 'endDate') ? [['保存明確結束日期', item.endDate]] : []), ['保存開始時間', item.startTime], ['保存結束時間', item.endTime],
      ['班次狀態', shiftStatuses[item.status]], ['目前員工', employeeNode(item.employee)], ['目前個案', caseNode(item.case)],
      ['服務紀錄鎖定', item.hasServiceRecord ? '已有服務紀錄' : '目前沒有服務紀錄'],
    ]),
    el('p', { class: 'notice' }, guidance.join(' ')));
}
function contentNode(response, { reload, isCurrent }, changePage) {
  const { leave } = response;
  const summary = el('section', { 'aria-label': '本次請假資料' }, el('h3', {}, '本次請假資料'),
    fields([
      ['目前員工', employeeNode(leave.employee)], ['請假完整日期時段', spanRecordText(leave)], ['保存開始日期', leave.date], ...(Object.hasOwn(leave, 'endDate') ? [['保存明確結束日期', leave.endDate]] : []),
      ['保存開始時間', leave.startTime], ['保存結束時間', leave.endTime], ['假別', leave.type],
      ['請假狀態', leaveStatuses[leave.status]], ['請假版本', `第 ${leave.version} 版`],
      ['資料讀取時間（UTC）', el('time', { datetime: response.generatedAt }, response.generatedAt)],
    ]),
    leave.status !== 'pending' && el('p', { class: 'notice' }, '此申請目前不是待審核狀態；這裡只查看保存時段的目前重疊班次，不代表可重新核准。'));
  return el('section', { 'aria-label': '請假衝突查詢結果' }, summary,
    el('div', { class: 'actions' }, button('重新檢查', () => { if (isCurrent()) { changePage(1); reload(); } }, { variant: 'outline' }),
      el('a', { class: 'btn btn-secondary', href: '#/shifts' }, '前往排班管理')),
    el('p', { class: 'muted' }, response.note),
    el('section', { 'aria-label': '目前衝突班次' }, el('h3', {}, `目前衝突班次：共 ${response.total} 筆`),
      response.items.length ? el('div', { class: 'service-list' }, response.items.map((item, index) => shiftCard(item, (response.page - 1) * response.pageSize + index + 1)))
        : el('p', { class: 'empty-state', role: 'status' }, '目前沒有重疊班次；核准時仍會重新檢查。'),
      pagination({ page: response.page, pageSize: response.pageSize, total: response.total, onChange: next => { if (isCurrent()) { changePage(next); reload(); } } })));
}

/** Read-only adapter; openDetails owns all loading, retry, cancellation and focus. */
export function openLeaveShiftConflicts({ id, isCurrent = () => true }) {
  const startedIdentity = identity(), startedHash = window.location.hash;
  const current = () => isCurrent() && identity() === startedIdentity && window.location.hash === startedHash;
  if (!text(id) || !current() || !['admin', 'supervisor'].includes(getContext().role)) return Promise.resolve();
  let page = 1;
  return openDetails({
    title: '請假衝突班次', wide: true, loadingText: '正在檢查衝突班次…', isCurrent: current,
    load: async (signal, helpers) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (signal.aborted || !helpers.isCurrent()) throw new DOMException('查詢已取消', 'AbortError');
        const response = confirmLeaveShiftConflicts(await api(`/api/leave-requests/${encodeURIComponent(id)}/shift-conflicts?page=${page}&pageSize=${PAGE_SIZE}`, { signal }), id, page);
        if (signal.aborted || !helpers.isCurrent()) throw new DOMException('查詢已取消', 'AbortError');
        const lastPage = Math.max(1, Math.ceil(response.total / PAGE_SIZE));
        // A concurrent change can remove the requested last page. Read its new last page afresh.
        if (page > lastPage) { page = lastPage; continue; }
        return contentNode(response, helpers, next => { page = next; });
      }
      throw new Error('衝突班次在查詢期間已變更，請重新讀取。');
    },
  });
}
