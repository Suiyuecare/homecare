import { api, el, button, getContext, openDetails, createForm, table, errorState, today } from '../ui.js';
import { parseCalendarDate } from '../data/shift-calendar.js';
import { personalCalendarIdentity, PERSONAL_CALENDAR_STATUSES, formatPersonalCalendarText, formatPersonalCalendarStatus } from '../data/personal-calendar-editor.js';
import { personalCalendarMonthPeriod, personalCalendarMonthFilters, confirmPersonalCalendarMonth, groupPersonalCalendarMonth } from '../data/personal-calendar-month.js';

const weekdays = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];
const weekday = date => weekdays[(parseCalendarDate(date).ordinal + 5) % 7];
const cancelled = () => new DOMException('月份事件查詢已取消', 'AbortError');
const columns = [
  ['title', '事件標題'], ['date', '事件日期'], ['startTime', '開始時間'],
  ['endTime', '結束時間'], ['note', '備註'], ['status', '事件狀態'],
].map(([key, label]) => ({ key, label, render: row => el('span', { class: 'pre-wrap' },
  key === 'status' ? formatPersonalCalendarStatus(row[key]) : formatPersonalCalendarText(row[key], Object.hasOwn(row, key))) }));

function confirmedContent(result, period, groups, current) {
  const headings = new Map();
  const agenda = el('section', { class: 'shift-calendar-agenda', 'aria-label': '完整每日個人事件' }, groups.map(group => {
    const heading = el('h3', { tabindex: '-1' }, `${group.date}（${weekday(group.date)}）・共 ${group.rows.length} 筆事件`);
    headings.set(group.date, heading);
    let content = el('p', { class: 'muted' }, '此日沒有事件。');
    if (group.rows.length) {
      content = table(columns, group.rows, { caption: `${group.date} 完整個人事件` });
      content.classList.add('shift-calendar-daily-table');
      content.querySelectorAll('tbody tr').forEach((row, index) => { row.dataset.eventId = group.rows[index].id; });
    }
    return el('section', { class: 'shift-calendar-day', 'data-date': group.date }, heading, content);
  }));
  const counts = new Map(groups.map(group => [group.date, group.rows.length])), indexRows = [];
  for (let offset = 0; offset < period.slots.length; offset += 7) {
    indexRows.push(el('tr', {}, period.slots.slice(offset, offset + 7).map(date => {
      if (date === null) return el('td', { class: 'shift-calendar-unavailable', 'aria-label': '本月以外日期' });
      const jump = button('', () => {
        const heading = headings.get(date);
        if (!current() || !heading.isConnected) return;
        heading.focus({ preventScroll: true }); heading.scrollIntoView({ block: 'start', behavior: 'auto' });
      }, { variant: 'outline', 'aria-label': `查看 ${date} ${weekday(date)}，共 ${counts.get(date)} 筆事件` });
      jump.append(el('span', {}, date), el('span', {}, weekday(date)), el('span', {}, `${counts.get(date)} 筆事件`));
      return el('td', {}, jump);
    })));
  }
  const index = el('section', { class: 'shift-calendar-index', 'aria-label': '日期索引' }, el('h3', {}, '日期索引'),
    el('div', { class: 'table-scroll' }, el('table', {}, el('caption', { class: 'sr-only' }, '本月六週日期索引'),
      el('thead', {}, el('tr', {}, weekdays.map(label => el('th', { scope: 'col' }, label)))), el('tbody', {}, indexRows))));
  return el('section', { 'aria-label': '已確認完整月份事件' },
    el('p', { role: 'status' }, `本月共 ${result.total} 筆事件，以下為完整每日資料。`),
    el('p', { class: result.undatedCount ? 'notice' : 'muted' }, `無法歸月的本人事件：${result.undatedCount} 筆，未計入本月。請回原清單核對保存日期。`),
    el('p', { class: 'muted' }, '桌機提供日期索引；窄螢幕可閱讀完整每日清單。維護事件請回原清單。'), index, agenda);
}

function monthContent({ values, period, result, groups, error, helpers, setDraft }) {
  let initializing = true, controls, navigationCurrent = Boolean(period);
  const current = () => helpers.isCurrent() && form.isConnected;
  const results = el('div', { class: 'shift-calendar-results', 'aria-live': 'polite' });
  const previous = button('上一月', () => { if (current() && navigationCurrent && period.previousMonth) submit({ ...form.getValues(), month: period.previousMonth }); }, { variant: 'outline' });
  const next = button('下一月', () => { if (current() && navigationCurrent && period.nextMonth) submit({ ...form.getValues(), month: period.nextMonth }); }, { variant: 'outline' });
  const reread = button('重新讀取', () => { if (current() && navigationCurrent) helpers.reload(); }, { variant: 'outline' });
  const boundary = el('p', { class: 'muted', role: 'status' });
  const updateNavigation = () => {
    previous.disabled = !navigationCurrent || period?.previousMonth === null;
    next.disabled = !navigationCurrent || period?.nextMonth === null;
    reread.disabled = !navigationCurrent;
    boundary.textContent = !navigationCurrent ? '條件已變更，請先查詢月份。'
      : [period.previousMonth === null ? '上一月超出支援年份。' : '', period.nextMonth === null ? '下一月超出支援年份。' : ''].filter(Boolean).join(' ');
    boundary.hidden = boundary.textContent === '';
  };
  const retract = () => {
    navigationCurrent = false; results.replaceChildren(el('p', { role: 'status' }, '條件已變更，請查詢月份。')); updateNavigation();
  };
  const form = createForm({
    fields: [
      { name: 'month', label: '月份', type: 'text', required: true, maxLength: 7, help: '精確西元 YYYY-MM，支援 0001 至 9999 年。' },
      { name: 'q', label: '搜尋標題或備註', type: 'text', maxLength: 200, help: '依輸入原文查詢，保留前後空白。' },
      { name: 'status', label: '事件狀態', type: 'select', placeholder: '全部狀態', options: PERSONAL_CALENDAR_STATUSES.map(item => ({ ...item })) },
    ], initial: values, submitLabel: '查詢月份',
    onChange: (draft, helpers) => {
      controls = helpers;
      if (initializing || !current()) return;
      setDraft({ ...draft }); retract();
    },
    onSubmit: async draft => {
      if (!current()) return;
      personalCalendarMonthFilters(draft.month, draft.q, draft.status);
      setDraft({ ...draft }); await helpers.reload();
    },
  });
  initializing = false;
  function submit(draft) {
    if (!current()) return;
    for (const [name, value] of Object.entries(draft)) controls.setValue(name, value);
    setDraft({ ...draft }); retract(); form.requestSubmit();
  }
  const thisMonth = button('本月', () => { if (current()) submit({ ...form.getValues(), month: today().slice(0, 7) }); }, { variant: 'outline' });
  const clearSearch = button('清除搜尋', () => {
    if (!current()) return;
    const draft = form.getValues();
    controls.setValue('q', ''); setDraft({ ...draft, q: '' }); retract();
    form.querySelector('[name="q"]').focus();
  }, { variant: 'ghost' });
  updateNavigation();
  if (period) results.append(el('h3', {}, `${period.month}：${period.startDate} 至 ${period.endDate}`));
  if (result) results.append(confirmedContent(result, period, groups, () => current() && navigationCurrent));
  else results.append(errorState(error, () => { if (current() && navigationCurrent) helpers.reload(); }));
  return el('section', { class: 'shift-calendar', 'aria-label': '本人事件月份查詢' }, form,
    el('div', { class: 'actions' }, previous, next, thisMonth, reread, clearSearch), boundary, results);
}

/** Business adapter; shared openDetails owns loading, retry, Abort, Escape and focus. */
export function openPersonalCalendarMonth({ isCurrent = () => true } = {}) {
  const startedContext = getContext(), identity = personalCalendarIdentity(startedContext), hash = window.location.hash;
  const current = () => getContext() === startedContext && personalCalendarIdentity(getContext()) === identity
    && window.location.hash === hash && isCurrent();
  if (!current() || !startedContext.user || !['admin', 'supervisor', 'caregiver', 'finance'].includes(startedContext.role)) return Promise.resolve();
  const orgId = startedContext.organizationId ?? startedContext.orgId, ownerUserId = startedContext.user.id;
  let draft = { month: today().slice(0, 7), q: '', status: '' };
  return openDetails({ title: '個人事件月份檢視', wide: true, guardedRead: true,
    loadingText: '正在讀取完整月份事件…', isCurrent: current,
    load: async (signal, helpers) => {
      const values = { ...draft }; let period, filters;
      const content = extras => monthContent({ values, period: filters ? period : undefined, helpers,
        setDraft: value => { draft = value; }, ...extras });
      try {
        period = personalCalendarMonthPeriod(values.month);
        filters = personalCalendarMonthFilters(values.month, values.q, values.status);
        const requested = { ...filters, orgId, ownerUserId };
        const response = await api(`/api/personal-calendar-events/calendar?${new URLSearchParams(filters)}`, { signal });
        if (signal.aborted || !helpers.isCurrent()) throw cancelled();
        const result = confirmPersonalCalendarMonth(response, requested), groups = groupPersonalCalendarMonth(result, requested);
        return content({ result, groups });
      } catch (error) {
        if (signal.aborted || !helpers.isCurrent() || error.name === 'AbortError') throw cancelled();
        return content({ error });
      }
    },
  });
}
