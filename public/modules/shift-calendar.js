import { api, el, button, getContext, openDetails, createForm, table, errorState, today } from '../ui.js';
import { parseCalendarDate, calendarPeriod, spanCalendarFilters as calendarFilters, confirmSpanCalendarReport as confirmCalendarReport, groupSpanCalendarRows as groupCalendarRows } from '../data/shift-calendar.js';
import { calendarPersonFilters, confirmCalendarLookupPage, confirmCalendarLookups, calendarPersonSelection, confirmCalendarPersonSelection } from '../data/shift-calendar-person-filters.js';
import { openReportPreview } from './report-view.js';
import { shiftCalendarReportConfig as shiftReportConfig } from './shift-report.js';

const weekdays = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];
const statuses = [
  { value: 'scheduled', label: '已排班' }, { value: 'completed', label: '已完成' }, { value: 'cancelled', label: '已取消' },
];
const identity = () => {
  const context = getContext();
  return JSON.stringify([context.user?.id, context.organizationId, context.role, context.user?.employeeId]);
};
const cancelled = () => new DOMException('班表查詢已取消', 'AbortError');
const weekday = date => weekdays[(parseCalendarDate(date).ordinal + 5) % 7];

function dailyTable(result, group) {
  const node = table([{ key: 'displaySegment', label: '本日顯示區段' }, ...result.columns].map(column => ({ ...column,
    render: row => el('span', { class: 'pre-wrap' }, String(row[column.key])),
  })), group.rows, { caption: `${group.date} 完整班表` });
  node.classList.add('shift-calendar-daily-table');
  node.querySelectorAll('tbody tr').forEach((row, index) => { row.dataset.shiftId = group.rows[index].shiftId; });
  return node;
}

function confirmedContent(result, period, groups, isCurrent, personEnabled) {
  const headings = new Map();
  const agenda = el('section', { class: 'shift-calendar-agenda', 'aria-label': '完整每日班表' },
    groups.map(group => {
      const heading = el('h3', { tabindex: '-1' }, `${group.date}（${weekday(group.date)}）・共 ${group.rows.length} 班次`);
      headings.set(group.date, heading);
      return el('section', { class: 'shift-calendar-day', 'data-date': group.date }, heading,
        group.rows.length ? dailyTable(result, group) : el('p', { class: 'muted' }, '此日沒有班次。'));
    }));
  const counts = new Map(groups.map(group => [group.date, group.rows.length]));
  const indexRows = [];
  for (let offset = 0; offset < period.slots.length; offset += 7) {
    indexRows.push(el('tr', {}, period.slots.slice(offset, offset + 7).map(date => {
      if (date === null) return el('td', { class: 'shift-calendar-unavailable', 'aria-label': '本期不可用日期' });
      const indexButton = button('', () => {
        if (!isCurrent()) return;
        const heading = headings.get(date);
        if (!heading.isConnected) return;
        heading.focus({ preventScroll: true }); heading.scrollIntoView({ block: 'start', behavior: 'auto' });
      }, { variant: 'outline', 'aria-label': `查看 ${date} ${weekday(date)}，共 ${counts.get(date)} 班次` });
      indexButton.append(el('span', {}, date), el('span', {}, weekday(date)), el('span', {}, `${counts.get(date)} 班次`));
      return el('td', {}, indexButton);
    })));
  }
  const index = el('section', { class: 'shift-calendar-index', 'aria-label': '日期索引' },
    el('h3', {}, '日期索引'),
    el('div', { class: 'table-scroll' }, el('table', {},
      el('caption', { class: 'sr-only' }, period.mode === 'week' ? '本週七日日期索引' : '本月六週日期索引'),
      el('thead', {}, el('tr', {}, weekdays.map(label => el('th', { scope: 'col' }, label)))),
      el('tbody', {}, indexRows))));
  return el('section', { 'aria-label': '已確認完整班表' },
    el('dl', { class: 'detail-grid' },
      [['機構', result.organization.name], ...(personEnabled ? [['個案', result.selection.case], ['服務人員', result.selection.employee]] : []), ['班次狀態', result.selection.status], ['資料讀取時間（UTC）', result.generatedAt]].map(([label, value]) =>
        el('div', {}, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value)))),
    el('p', { role: 'status' }, `本期共 ${result.total} 個班次；跨日班次依實際占用日期分段，同一識別碼只計一次。`),
    el('p', { class: 'notice' }, result.note + ' 每日區段只供閱讀；完整保存開始日與結束日仍列於表格，00:00結束不另列零分鐘翌日。'), index, agenda);
}

function calendarContent({ values, period, result, groups, error, helpers, setDraft, personEnabled, lookups, caregiver, enablePeople }) {
  let initializing = true, formHelpers;
  let navigationCurrent = Boolean(period);
  const interactionCurrent = () => helpers.isCurrent() && form.isConnected;
  const results = el('div', { class: 'shift-calendar-results', 'aria-live': 'polite' });
  const previous = button('上一期', () => { if (navigationCurrent && period.previousAnchor !== null) submit({ ...form.getValues(), anchor: period.previousAnchor }); }, { variant: 'outline' });
  const next = button('下一期', () => { if (navigationCurrent && period.nextAnchor !== null) submit({ ...form.getValues(), anchor: period.nextAnchor }); }, { variant: 'outline' });
  const reread = button('重新讀取', () => { if (navigationCurrent && interactionCurrent()) helpers.reload(); }, { variant: 'outline' });
  const boundary = el('p', { class: 'muted', role: 'status' });
  const updateNavigation = () => {
    previous.disabled = !navigationCurrent || period?.previousAnchor === null;
    next.disabled = !navigationCurrent || period?.nextAnchor === null;
    reread.disabled = !navigationCurrent;
    boundary.textContent = !navigationCurrent ? '請先查詢目前條件，再使用上一期、下一期或重新讀取。'
      : [period.previousAnchor === null ? '上一期超出支援日期範圍。' : '', period.nextAnchor === null ? '下一期超出支援日期範圍。' : ''].filter(Boolean).join(' ');
    boundary.hidden = boundary.textContent === '';
  };
  const retract = () => {
    navigationCurrent = false;
    results.replaceChildren(el('p', { role: 'status' }, '條件已變更，請查詢班表。'));
    updateNavigation();
  };
  const personFields = personEnabled ? [['caseId', '個案', 'cases', '全部可讀個案'], ['employeeId', '服務人員', 'employees', '全部可讀人員']].map(([name, label, entity, placeholder]) => {
    const options = (lookups?.[entity] || []).map(row => ({ value: row.id, label: row.label }));
    if (values[name] !== '' && !options.some(option => option.value === values[name])) options.push({ value: values[name], label: '原選項目前不可用' });
    return { name, label, type: 'select', placeholder, options, disabled: !lookups || (caregiver && name === 'employeeId'),
      help: error?.fields?.[name] || (caregiver && name === 'employeeId' ? '依目前本人連結的人員查詢。' : undefined) };
  }) : [];
  const form = createForm({
    fields: [
      { name: 'mode', label: '檢視', type: 'select', required: true, options: [{ value: 'week', label: '週' }, { value: 'month', label: '月' }] },
      { name: 'anchor', label: '日期', type: 'text', required: true, help: '請輸入精確西元 YYYY-MM-DD；支援 0000 至 9999 年。' },
      { name: 'status', label: '班次狀態', type: 'select', placeholder: '全部狀態', options: statuses },
      ...personFields,
    ],
    initial: values, submitLabel: '查詢班表',
    onChange: (draft, controls) => {
      formHelpers = controls;
      if (initializing || !interactionCurrent()) return;
      setDraft({ ...draft }); retract();
    },
    onSubmit: async draft => {
      if (!interactionCurrent()) return;
      const requestedPeriod = calendarPeriod(draft.mode, draft.anchor);
      const people = personEnabled ? calendarPersonFilters({ caseId: draft.caseId, employeeId: draft.employeeId }) : undefined;
      calendarFilters(requestedPeriod, draft.status, people);
      if (personEnabled && lookups) calendarPersonSelection(people, lookups);
      setDraft({ ...draft }); await helpers.reload();
    },
  });
  initializing = false;
  function submit(draft) {
    if (!interactionCurrent()) return;
    for (const [key, value] of Object.entries(draft)) formHelpers.setValue(key, value);
    setDraft({ ...draft }); retract(); form.requestSubmit();
  }
  const todayButton = button('今天', () => {
    const draft = form.getValues();
    submit({ ...draft, mode: ['week', 'month'].includes(draft.mode) ? draft.mode : 'week', anchor: today() });
  }, { variant: 'outline' });
  updateNavigation();
  if (period) results.append(el('h3', {}, `${period.mode === 'week' ? '週' : '月'}班表：${period.startDate} 至 ${period.endDate}`));
  if (period?.rangeClipped) results.append(el('p', { class: 'notice' }, '本週跨越支援日期邊界；不可用日期留空，只查詢 0000 至 9999 年內的日期。'));
  if (result) {
    const confirmed = confirmedContent(result, period, groups, helpers.isCurrent, personEnabled);
    if (result.total) {
      const people = personEnabled ? calendarPersonFilters({ caseId: values.caseId, employeeId: values.employeeId }) : undefined;
      const filters = calendarFilters(period, values.status, people);
      const outputCurrent = () => navigationCurrent && interactionCurrent() && confirmed.isConnected;
      confirmed.prepend(el('div', { class: 'actions' }, button('完整報表／下載', () => {
        if (!outputCurrent()) return;
        return openReportPreview({ config: shiftReportConfig, filters, isCurrent: outputCurrent, downloadable: true,
          confirmComplete: response => confirmCalendarReport(response, period, values.status, people) });
      }, { variant: 'outline' })));
    }
    results.append(confirmed);
  } else results.append(errorState(error, () => { if (navigationCurrent && interactionCurrent()) helpers.reload(); }));
  const peopleControl = personEnabled ? el('p', { class: 'muted', role: 'status' }, '已啟用個案／人員篩選；查詢會重新確認完整有權名單。')
    : button('啟用個案／人員篩選', () => { if (interactionCurrent()) { setDraft({ ...form.getValues() }); enablePeople(); } }, { variant: 'outline' });
  return el('section', { class: 'shift-calendar', 'aria-label': '週／月班表查詢' }, peopleControl, form,
    el('div', { class: 'actions' }, previous, next, todayButton, reread), boundary, results);
}

/** Business adapter; openDetails owns serial loading, cancellation, retry and focus. */
export function openShiftCalendar({ isCurrent = () => true } = {}) {
  const startedContext = getContext(), startedIdentity = identity(), startedHash = window.location.hash;
  const current = () => getContext() === startedContext && identity() === startedIdentity && window.location.hash === startedHash && isCurrent();
  if (!current() || !startedContext.user || !['admin', 'supervisor', 'caregiver'].includes(startedContext.role)
    || (startedContext.role === 'caregiver' && !startedContext.user.employeeId)) return Promise.resolve();
  let draft = { mode: 'week', anchor: today(), status: '' };
  let personEnabled = false;
  const caregiver = startedContext.role === 'caregiver';
  const readPeople = async (entity, signal, helpers) => {
    const pages = []; let total;
    for (let page = 1; page <= 100; page++) {
      if (signal.aborted || !helpers.isCurrent()) throw cancelled();
      const response = await api(`/api/${entity}?page=${page}&pageSize=100`, { signal });
      if (signal.aborted || !helpers.isCurrent()) throw cancelled();
      const confirmed = confirmCalendarLookupPage(response, entity, startedContext.organizationId, page, total);
      total = confirmed.total; pages.push(response);
      if (page * 100 >= total) return confirmCalendarLookups(pages, entity, startedContext.organizationId);
    }
    throw new Error('名單超出可確認範圍，請重新讀取。');
  };
  return openDetails({ title: '週／月班表', wide: true, guardedRead: true, loadingText: '正在讀取完整週／月班表…', isCurrent: current,
    load: async (signal, helpers) => {
      const values = { ...draft };
      let period, filters, lookups;
      const content = extras => calendarContent({ values, period: filters ? period : undefined, helpers,
        personEnabled, lookups, caregiver, setDraft: value => { draft = value; },
        enablePeople: () => {
          personEnabled = true;
          draft = { ...draft, caseId: '', employeeId: caregiver ? startedContext.user.employeeId : '' };
          helpers.reload();
        }, ...extras });
      try {
        period = calendarPeriod(values.mode, values.anchor);
        const people = personEnabled ? calendarPersonFilters({ caseId: values.caseId, employeeId: values.employeeId }) : undefined;
        if (caregiver && personEnabled && people.employeeId !== startedContext.user.employeeId) throw new Error('本人服務人員條件尚未確認，請關閉後重新開啟。');
        filters = calendarFilters(period, values.status, people);
        if (personEnabled) {
          const cases = await readPeople('cases', signal, helpers);
          const employees = await readPeople('employees', signal, helpers);
          lookups = Object.freeze({ cases, employees });
          calendarPersonSelection(people, lookups);
        }
        const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== ''));
        const response = await api(`/api/shift-report/export?${query}`, { signal });
        if (signal.aborted || !helpers.isCurrent()) throw cancelled();
        const groups = groupCalendarRows(response, period, values.status, people);
        if (personEnabled) confirmCalendarPersonSelection(response, people, lookups);
        return content({ result: response, groups });
      } catch (error) {
        if (signal.aborted || !helpers.isCurrent() || error.name === 'AbortError') throw cancelled();
        return content({ error });
      }
    },
  });
}
