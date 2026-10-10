import { api, el, button, getContext, openDetails, createForm, table, errorState, today } from '../ui.js';
import { personalCalendarIdentity, PERSONAL_CALENDAR_STATUSES, formatPersonalCalendarText, formatPersonalCalendarStatus } from '../data/personal-calendar-editor.js';
import { personalCalendarYearPeriod, personalCalendarYearFilters, confirmPersonalCalendarYear, groupPersonalCalendarYear } from '../data/personal-calendar-year.js';

const cancelled = () => new DOMException('年度事件查詢已取消', 'AbortError');
const columns = [
  ['title', '事件標題'], ['date', '事件日期'], ['startTime', '開始時間'],
  ['endTime', '結束時間'], ['note', '備註'], ['status', '事件狀態'],
].map(([key, label]) => ({ key, label, render: row => el('span', { class: 'pre-wrap' },
  key === 'status' ? formatPersonalCalendarStatus(row[key]) : formatPersonalCalendarText(row[key], Object.hasOwn(row, key))) }));

function confirmedContent(result, period, groups, current) {
  const headings = new Map();
  const agenda = el('section', { class: 'shift-calendar-agenda', 'aria-label': '完整十二月份個人事件' }, groups.map(group => {
    const heading = el('h3', { tabindex: '-1' }, `${group.month}・共 ${group.rows.length} 筆事件`);
    headings.set(group.month, heading);
    let content = el('p', { class: 'muted' }, '此月沒有事件。');
    if (group.rows.length) {
      content = table(columns, group.rows, { caption: `${group.month} 完整個人事件` });
      content.classList.add('shift-calendar-daily-table');
      content.querySelectorAll('tbody tr').forEach((row, index) => { row.dataset.eventId = group.rows[index].id; });
    }
    return el('section', { class: 'shift-calendar-day', 'data-month': group.month }, heading, content);
  }));
  const counts = new Map(groups.map(group => [group.month, group.rows.length])), indexRows = [];
  for (let offset = 0; offset < 14; offset += 7) {
    indexRows.push(el('tr', {}, Array.from({ length: 7 }, (_, column) => {
      const month = period.months[offset + column]?.month;
      if (!month) return el('td', { class: 'shift-calendar-unavailable', 'aria-hidden': 'true' });
      const jump = button('', () => {
        const heading = headings.get(month);
        if (!current() || !heading.isConnected) return;
        heading.focus({ preventScroll: true }); heading.scrollIntoView({ block: 'start', behavior: 'auto' });
      }, { variant: 'outline', 'aria-label': `查看 ${month}，共 ${counts.get(month)} 筆事件` });
      jump.append(el('span', {}, month), el('span', {}, `${counts.get(month)} 筆事件`));
      return el('td', {}, jump);
    })));
  }
  const index = el('section', { class: 'shift-calendar-index', 'aria-label': '月份索引' }, el('h3', {}, '月份索引'),
    el('div', { class: 'table-scroll' }, el('table', {}, el('caption', { class: 'sr-only' }, '全年十二月份索引'), el('tbody', {}, indexRows))));
  return el('section', { 'aria-label': '已確認完整年度事件' },
    el('p', { role: 'status' }, `本年共 ${result.total} 筆事件，以下為完整十二月份資料。`),
    el('p', { class: result.undatedCount ? 'notice' : 'muted' }, `無法歸年的本人事件：${result.undatedCount} 筆，未計入本年。請回原清單核對保存日期。`),
    el('p', { class: 'muted' }, '桌機提供月份索引；窄螢幕可閱讀完整十二月份清單。維護事件請回原清單。'), index, agenda);
}

function yearContent({ values, period, result, groups, error, helpers, setDraft }) {
  let initializing = true, controls, navigationCurrent = Boolean(period);
  const current = () => helpers.isCurrent() && form.isConnected;
  const results = el('div', { class: 'shift-calendar-results', 'aria-live': 'polite' });
  const previous = button('上一年', () => { if (current() && navigationCurrent && period.previousYear) submit({ ...form.getValues(), year: period.previousYear }); }, { variant: 'outline' });
  const next = button('下一年', () => { if (current() && navigationCurrent && period.nextYear) submit({ ...form.getValues(), year: period.nextYear }); }, { variant: 'outline' });
  const reread = button('重新讀取', () => { if (current() && navigationCurrent) helpers.reload(); }, { variant: 'outline' });
  const boundary = el('p', { class: 'muted', role: 'status' });
  const updateNavigation = () => {
    previous.disabled = !navigationCurrent || period?.previousYear === null;
    next.disabled = !navigationCurrent || period?.nextYear === null;
    reread.disabled = !navigationCurrent;
    boundary.textContent = !navigationCurrent ? '條件已變更，請先查詢年度。'
      : [period.previousYear === null ? '上一年超出支援年份。' : '', period.nextYear === null ? '下一年超出支援年份。' : ''].filter(Boolean).join(' ');
    boundary.hidden = boundary.textContent === '';
  };
  const retract = () => {
    navigationCurrent = false; results.replaceChildren(el('p', { role: 'status' }, '條件已變更，請查詢年度。')); updateNavigation();
  };
  const form = createForm({
    fields: [
      { name: 'year', label: '年度', type: 'text', required: true, maxLength: 4, help: '精確四碼西元 YYYY，支援 0001 至 9999 年。' },
      { name: 'q', label: '搜尋標題或備註', type: 'text', maxLength: 200, help: '依輸入原文查詢，保留前後空白。' },
      { name: 'status', label: '事件狀態', type: 'select', placeholder: '全部狀態', options: PERSONAL_CALENDAR_STATUSES.map(item => ({ ...item })) },
    ], initial: values, submitLabel: '查詢年度',
    onChange: (draft, helpers) => {
      controls = helpers;
      if (initializing || !current()) return;
      setDraft({ ...draft }); retract();
    },
    onSubmit: async draft => {
      if (!current()) return;
      personalCalendarYearFilters(draft.year, draft.q, draft.status);
      setDraft({ ...draft }); await helpers.reload();
    },
  });
  initializing = false;
  function submit(draft) {
    if (!current()) return;
    for (const [name, value] of Object.entries(draft)) controls.setValue(name, value);
    setDraft({ ...draft }); retract(); form.requestSubmit();
  }
  const thisYear = button('今年', () => { if (current()) submit({ ...form.getValues(), year: today().slice(0, 4) }); }, { variant: 'outline' });
  const clearSearch = button('清除搜尋', () => {
    if (!current()) return;
    const draft = form.getValues();
    controls.setValue('q', ''); setDraft({ ...draft, q: '' }); retract();
    form.querySelector('[name="q"]').focus();
  }, { variant: 'ghost' });
  updateNavigation();
  if (period) results.append(el('h3', {}, `${period.year}：${period.startDate} 至 ${period.endDate}`));
  if (result) results.append(confirmedContent(result, period, groups, () => current() && navigationCurrent));
  else results.append(errorState(error, () => { if (current() && navigationCurrent) helpers.reload(); }));
  return el('section', { class: 'shift-calendar', 'aria-label': '本人事件年度查詢' },
    el('p', { class: 'muted' }, '若全年資料過多，請縮小搜尋或事件狀態條件，或回原清單使用月份檢視。'), form,
    el('div', { class: 'actions' }, previous, next, thisYear, reread, clearSearch), boundary, results);
}

/** Business adapter; shared openDetails owns loading, retry, Abort, Escape and focus. */
export function openPersonalCalendarYear({ isCurrent = () => true } = {}) {
  const startedContext = getContext(), identity = personalCalendarIdentity(startedContext), hash = window.location.hash;
  const current = () => getContext() === startedContext && personalCalendarIdentity(getContext()) === identity
    && window.location.hash === hash && isCurrent();
  if (!current() || !startedContext.user || !['admin', 'supervisor', 'caregiver', 'finance'].includes(startedContext.role)) return Promise.resolve();
  const orgId = startedContext.organizationId ?? startedContext.orgId, ownerUserId = startedContext.user.id;
  let draft = { year: today().slice(0, 4), q: '', status: '' };
  return openDetails({ title: '個人事件年度檢視', wide: true, guardedRead: true,
    loadingText: '正在讀取完整年度事件…', isCurrent: current,
    load: async (signal, helpers) => {
      const values = { ...draft }; let period, filters;
      const content = extras => yearContent({ values, period: filters ? period : undefined, helpers,
        setDraft: value => { draft = value; }, ...extras });
      try {
        period = personalCalendarYearPeriod(values.year);
        filters = personalCalendarYearFilters(values.year, values.q, values.status);
        const requested = { ...filters, orgId, ownerUserId };
        const response = await api(`/api/personal-calendar-events/year?${new URLSearchParams(filters)}`, { signal });
        if (signal.aborted || !helpers.isCurrent()) throw cancelled();
        const result = confirmPersonalCalendarYear(response, requested), groups = groupPersonalCalendarYear(result, requested);
        return content({ result, groups });
      } catch (error) {
        if (signal.aborted || !helpers.isCurrent() || error.name === 'AbortError') throw cancelled();
        return content({ error });
      }
    },
  });
}
