import {
  api, el, pageHeader, table, badge, button, openForm, confirmAction,
  toast, formatDate, today, getContext, navigate, fetchAll,
  searchBox, pagination, errorState,
} from '../ui.js';
import { openRecordHistory } from './history.js';
import { openCaseRecordIndex } from './case-record-index.js';
import { createContactsPanel } from './contacts.js';
import { createAttachmentsPanel } from './attachments.js';
import { createCaseStatusFollowupsPanel } from './case-status-followups.js';
import { openRecurringShifts } from './recurring-shifts.js';
import { openShiftCalendar } from './shift-calendar.js';
import { createCaseEditor, formatCaseText, formatCaseCms, formatCaseBirthDate, formatCaseStatus } from '../data/case-editor.js';
import { createCarePlanEditor, formatCarePlanText, formatCarePlanDate, formatCarePlanStatus, formatCarePlanServices } from '../data/care-plan-editor.js';
import { createShiftEditor, formatShiftDate, formatShiftTime, formatShiftStatus, formatShiftServices } from '../data/shift-editor.js';
import { createServiceRecordEditor, createServiceRecordReview } from '../data/service-record-editor.js';

const managementRoles = new Set(['admin', 'supervisor']);
const savedLists = new Map();
let renderVersion = 0;

const caseStatuses = [
  { value: 'active', label: '服務中' }, { value: 'paused', label: '暫停' }, { value: 'closed', label: '結案' },
];
const planStatuses = [
  { value: 'draft', label: '草稿' }, { value: 'active', label: '生效中' }, { value: 'ended', label: '已結束' },
];
const shiftStatuses = [
  { value: 'scheduled', label: '已排班' }, { value: 'completed', label: '已完成' }, { value: 'cancelled', label: '已取消' },
];
const recordStatuses = [
  { value: 'draft', label: '草稿' }, { value: 'submitted', label: '待核閱' },
  { value: 'approved', label: '已核閱' }, { value: 'returned', label: '已退回' },
];
const canManage = () => managementRoles.has(getContext().role);
const isOwnRecord = item => getContext().role === 'caregiver' && getContext().user?.employeeId === item.employeeId;
const canEditRecord = item => ['draft', 'returned'].includes(item.status) && (canManage() || isOwnRecord(item));
const mapById = items => new Map(items.map(item => [item.id, item]));
const option = (value, label) => ({ value, label });
const nameOf = (map, id, fallback = '未提供') => map.get(id)?.name || fallback;
const timeRange = item => `${item.startTime || '—'}–${item.endTime || '—'}`;
const actualTimeRange = item => `${formatShiftTime(item.actualStart)}–${formatShiftTime(item.actualEnd)}`;
const recordText = value => typeof value === 'string' ? value || '未提供' : value === undefined ? '未提供' : '內容未取得';
const recordBadge = value => { const node = badge(recordStatuses.some(status => status.value === value) ? value : ''); node.textContent = recordStatuses.find(status => status.value === value)?.label || '狀態未取得'; return node; };
const field = (name, label, type = 'text', extra = {}) => ({ name, label, type, ...extra });
const link = (label, route) => el('a', { href: `#${route}` }, label);
const actionGroup = (...children) => el('div', { class: 'actions' }, ...children.filter(Boolean));
const message = text => el('p', { class: 'muted' }, text);
const sectionTitle = (title, actions) => el('div', { class: 'section-heading' }, el('h2', {}, title), actions || null);
const historyAction = (entity, record, lookups, container, version, label = '版本歷程') => button(label, () => openRecordHistory({
  entity, id: record.id, lookups, isCurrent: () => version === renderVersion && container.isConnected,
}), { variant: 'secondary' });
const listKey = route => `${getContext().user?.id}:${getContext().organizationId}:${getContext().role}:${route}`;
const readListState = route => {
  const key = listKey(route);
  if (!savedLists.has(key)) savedLists.set(key, { q: '', status: '', date: '', month: '', page: 1, pageSize: 25 });
  return savedLists.get(key);
};
const filteredNavigation = (route, filters) => {
  Object.assign(readListState(route), { q: '', status: '', caseId: undefined, period: 'all' }, filters, { page: 1 });
  navigate(route);
};
const queryString = values => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== '' && value !== null && value !== undefined)).toString();
const apiList = (entity, values, signal) => api(`/api/${entity}?${queryString(values)}`, { signal });
const mutationHeaders = () => ({ 'Idempotency-Key': crypto.randomUUID() });
const textValue = value => value === undefined || value === null || value === '' ? '未提供' : String(value);
const planBadge = value => { const node = badge(value); node.textContent = planStatuses.find(s => s.value === value)?.label || value; return node; };

function liveRegion(text = '正在讀取資料…') {
  return el('div', { class: 'empty-state', role: 'status', 'aria-live': 'polite' }, text);
}

function serviceSummary(services, items) {
  if (!Array.isArray(services) || !services.length) return '尚未設定';
  return services.map(entry => {
    const service = items.get(entry.serviceItemId);
    return `${service ? `${service.code} ${service.name}` : '服務項目'} × ${entry.quantity}`;
  }).join('、');
}

function serviceOptions(items, allowedIds) {
  return items.filter(item => !allowedIds || allowedIds.has(item.id))
    .map(item => option(item.id, `${item.code} ${item.name}`));
}

function validateServices(values, allowedIds) {
  if (!Array.isArray(values) || !values.length) throw fieldError('services', '請至少選擇一項服務並填寫數量。');
  if (values.some(item => !Number.isSafeInteger(Number(item.quantity)) || Number(item.quantity) < 1 || Number(item.quantity) > 10000)) {
    throw fieldError('services', '服務數量必須為 1 至 10000 的整數。');
  }
  if (allowedIds && values.some(item => !allowedIds.has(item.serviceItemId))) {
    throw fieldError('services', '服務項目必須屬於所選照顧計畫。請重新選擇。');
  }
  return values.map(item => ({ serviceItemId: item.serviceItemId, quantity: Number(item.quantity) }));
}

function fieldError(name, messageText) {
  const error = new Error(messageText);
  error.fields = { [name]: messageText };
  return error;
}

function dateOrder(values, from = 'validFrom', to = 'validTo') {
  if (values[from] && values[to] && values[to] < values[from]) {
    throw fieldError(to, '結束日期不能早於開始日期。');
  }
}

function timeOrder(values, start = 'startTime', end = 'endTime') {
  if (values[start] && values[end] && values[end] <= values[start]) {
    throw fieldError(end, '結束時間必須晚於開始時間。');
  }
}

function selectFilter(label, choices, value, onChange) {
  const select = el('select', { 'aria-label': label }, ...choices.map(item => el('option', { value: item.value }, item.label)));
  select.value = value || '';
  select.addEventListener('change', () => onChange(select.value));
  return el('label', { class: 'field' }, el('span', {}, label), select);
}

function dateFilter(label, type, value, onChange) {
  const input = el('input', { type, 'aria-label': label, value: value || '' });
  input.addEventListener('change', () => onChange(input.value));
  return el('label', { class: 'field' }, el('span', {}, label), input);
}

async function withLookups(container, version, names) {
  const result = await Promise.all(names.map(async entity => [entity, await fetchAll(entity)]));
  if (version !== renderVersion || !container.isConnected) return null;
  return Object.fromEntries(result);
}

async function recordsForShifts(items, params, signal) {
  const wanted = new Set(items.map(item => item.id));
  const records = new Map();
  let page = 1, seen = 0;
  while (wanted.size && page <= 100) {
    const result = await apiList('service-records', { caseId: params.caseId, employeeId: params.employeeId, date: params.date, month: params.month, page, pageSize: 100 }, signal);
    for (const record of result.items) if (wanted.has(record.shiftId)) { records.set(record.shiftId, record); wanted.delete(record.shiftId); }
    seen += result.items.length;
    if (seen >= result.total || !result.items.length || !wanted.size) return records;
    page += 1;
  }
  if (page > 100) throw new Error('服務紀錄超過可核對範圍，請縮小日期或個案條件後重試。');
  return records;
}

/** Shared paged list behavior; query and person filters remain in memory. */
async function renderList({ route, container, version, title, subtitle, entity, columns, createAction,
  statuses = [], dateMode = false, onlyOwn = false, renderItems, enrichItems, extraActions, isCurrent = () => true }) {
  const state = readListState(route);
  const orgId = getContext().organizationId;
  const current = () => version === renderVersion && getContext().organizationId === orgId && container.isConnected && isCurrent();
  let controller;
  let requestId = 0;
  const results = el('section', { class: 'panel', 'aria-label': `${title}結果`, 'aria-busy': 'true' });
  const footer = el('div', { class: 'list-footer' });
  const toolbar = el('div', { class: 'toolbar' });
  const headerActions = actionGroup(
    createAction && button(createAction.label, () => createAction.open(reload)),
    ...(extraActions?.(reload) || []),
  );
  container.replaceChildren(pageHeader(title, subtitle, headerActions), toolbar, results, footer);
  const search = searchBox({
    value: state.q, label: `${title}搜尋`, placeholder: '輸入姓名、編號或關鍵字',
    onSearch: value => { state.q = value; state.page = 1; reload(); },
  });
  toolbar.append(search);
  if (statuses.length) toolbar.append(selectFilter('狀態', [option('', '全部狀態'), ...statuses], state.status, value => {
    state.status = value; state.page = 1; reload();
  }));
  let periodFilters;
  if (dateMode) {
    state.period ||= route === '/my-services' ? 'day' : 'month';
    if (state.period === 'day' && !state.date) state.date = today();
    if (state.period === 'month' && !state.month) state.month = today().slice(0, 7);
    periodFilters = el('div', { class: 'actions' });
    const drawPeriod = () => {
      periodFilters.replaceChildren(selectFilter('日期範圍', [option('day', '單日'), option('month', '整月'), option('all', '全部日期')], state.period, value => {
        state.period = value;
        state.date ||= today(); state.month ||= today().slice(0, 7);
        state.page = 1; drawPeriod(); reload();
      }));
      if (state.period === 'all') return;
      const day = state.period === 'day';
      periodFilters.append(dateFilter(day ? '服務日期' : '服務月份', day ? 'date' : 'month', day ? state.date : state.month, value => {
        state[day ? 'date' : 'month'] = value; state.page = 1; reload();
      }));
    };
    drawPeriod(); toolbar.append(periodFilters);
  }
  const scopedFilter = el('div', { class: 'actions' });
  const drawScope = () => {
    scopedFilter.replaceChildren();
    if (state.caseId) scopedFilter.append(message('目前只顯示指定個案'), button('清除個案篩選', () => {
      delete state.caseId; state.page = 1; drawScope(); reload();
    }, { variant: 'secondary' }));
  };
  drawScope(); toolbar.append(scopedFilter);

  async function reload() {
    if (!current()) return;
    controller?.abort(); controller = new AbortController();
    const currentRequest = ++requestId;
    results.setAttribute('aria-busy', 'true');
    results.replaceChildren(liveRegion()); footer.replaceChildren();
    try {
      const params = { q: state.q, status: state.status, caseId: state.caseId, page: state.page, pageSize: state.pageSize };
      if (dateMode && state.period !== 'all') params[state.period === 'day' ? 'date' : 'month'] = state.period === 'day' ? state.date : state.month;
      if (onlyOwn) params.employeeId = getContext().user?.employeeId;
      const response = await apiList(entity, params, controller.signal);
      if (!current() || currentRequest !== requestId) return;
      const lastPage = Math.max(1, Math.ceil(response.total / state.pageSize));
      if (state.page > lastPage) { state.page = lastPage; return reload(); }
      const extra = enrichItems ? await enrichItems(response.items, params, controller.signal) : undefined;
      if (!current() || currentRequest !== requestId) return;
      const filtered = Boolean(state.q || state.status || state.caseId || (dateMode && state.period !== 'all' && (state.date || state.month)));
      const emptyText = filtered ? '找不到符合條件的資料，請調整搜尋或篩選。' : '目前沒有資料。';
      results.replaceChildren(renderItems ? renderItems(response.items, reload, extra, emptyText) : table(columns(reload, extra), response.items, { emptyText }));
      results.setAttribute('aria-busy', 'false');
      footer.replaceChildren(pagination({ page: state.page, pageSize: state.pageSize, total: response.total, onChange: page => {
        state.page = typeof page === 'object' ? page.page : page;
        if (typeof page === 'object' && page.pageSize) state.pageSize = page.pageSize;
        reload();
      } }));
    } catch (error) {
      if (error.name === 'AbortError' || !current() || currentRequest !== requestId) return;
      results.setAttribute('aria-busy', 'false');
      results.replaceChildren(errorState(error, reload));
    }
  }
  await reload();
}

function caseOnlyCurrent(container, version) {
  const identity = () => { const context = getContext(); return JSON.stringify([context.user?.id, context.organizationId, context.role, context.user?.employeeId]); };
  const originalIdentity = identity(), hash = window.location.hash;
  const stamp = `cases:${version}:${crypto.randomUUID()}`;
  container.dataset.renderVersion = stamp;
  return () => version === renderVersion && originalIdentity === identity() && hash === window.location.hash
    && container.isConnected && container.dataset.renderVersion === stamp;
}
const caseName = value => typeof value === 'string' && value && !/[\r\n]/.test(value) ? value : '這筆個案';
const caseSupervisorName = (employees, id) => id === '' || id === undefined ? '尚未指定'
  : typeof id === 'string' && typeof employees.get(id)?.name === 'string' && employees.get(id).name ? employees.get(id).name : '主責督導名稱未取得';
const caseStatusBadge = value => { const node = badge(caseStatuses.some(status => status.value === value) ? value : ''); node.textContent = formatCaseStatus(value); return node; };

function caseForm(item, employees, refresh, alive) {
  if (!alive()) return;
  const create = !item, editor = createCaseEditor({ existing: item, employees });
  const id = item?.id, version = item?.version, organizationId = getContext().organizationId;
  const headers = mutationHeaders();
  return openForm({
    title: create ? '新增個案' : `編輯個案：${caseName(item.name)}`,
    initial: editor.initial, fields: editor.fields, isCurrent: alive,
    onChange: (values, helpers) => {
      for (const descriptor of editor.fields) if (editor.needsIntent(descriptor.name))
        helpers.setDisabled(descriptor.name, !editor.enabled(descriptor.name, values));
    },
    onSubmit: async (values, { signal, isCurrent }) => {
      const payload = editor.buildPayload(values);
      const result = await api(create ? '/api/cases' : `/api/cases/${encodeURIComponent(id)}`, {
        method: create ? 'POST' : 'PATCH', body: create ? payload : { ...payload, version }, headers, signal,
      });
      if (!isCurrent()) return;
      editor.confirm(result?.item, organizationId, payload);
      toast(create ? '個案已新增。' : '個案資料已更新。', 'success'); await refresh();
    },
  });
}

function changeCaseStatus(item, status, refresh, alive) {
  if (!alive()) return;
  const editor = createCaseEditor({ existing: item }), id = item.id, version = item.version, organizationId = getContext().organizationId;
  const statusText = caseStatuses.find(s => s.value === status)?.label;
  const name = caseName(item.name);
  const messageText = status === 'active'
    ? `將「${name}」改為服務中。安排新班次前，請核對目前生效的照顧計畫。`
    : `將「${name}」改為${statusText}，之後不能新增服務班次。已排班次仍需另外核對處理。`;
  return confirmAction({ title: `${statusText}個案`, message: messageText, confirmLabel: `確認${statusText}`, danger: status !== 'active', isCurrent: alive,
    onConfirm: async ({ signal, isCurrent }) => {
      const payload = { status };
      const result = await api(`/api/cases/${encodeURIComponent(id)}`, { method: 'PATCH', body: { ...payload, version }, signal });
      if (!isCurrent()) return;
      editor.confirm(result?.item, organizationId, payload);
      toast(`個案已改為${statusText}。`, 'success'); await refresh();
    },
  });
}

async function renderCases(route, container, version) {
  const alive = caseOnlyCurrent(container, version);
  const data = await withLookups(container, version, ['employees']).catch(error => { if (alive()) throw error; return null; });
  if (!data || !alive()) return;
  const employees = mapById(data.employees);
  await renderList({ route, container, version, title: '個案', subtitle: '查找個案、維護聯絡資料，接續照顧計畫與服務。', entity: 'cases', statuses: caseStatuses, isCurrent: alive,
    createAction: canManage() ? { label: '新增個案', open: refresh => caseForm(null, data.employees, refresh, alive) } : null,
    columns: refresh => [
      { key: 'caseNo', label: '案號', render: row => formatCaseText(row.caseNo) }, { key: 'name', label: '個案', render: row => link(formatCaseText(row.name), `/cases/${encodeURIComponent(row.id)}`) },
      { label: '狀態', render: row => caseStatusBadge(row.status) }, { key: 'phone', label: '聯絡電話', render: row => formatCaseText(row.phone) },
      { label: '主責督導', render: row => caseSupervisorName(employees, row.supervisorId) },
      { key: 'contactName', label: '聯絡人', render: row => formatCaseText(row.contactName) },
      { label: '操作', render: row => actionGroup(link('查看個案', `/cases/${encodeURIComponent(row.id)}`),
        historyAction('cases', row, { employees }, container, version),
        canManage() ? button('編輯', () => caseForm(row, data.employees, refresh, alive), { variant: 'secondary' }) : null) },
    ],
  });
}

function planOnlyCurrent(container, version) {
  const identity = () => { const context = getContext(); return JSON.stringify([context.user?.id, context.organizationId, context.role, context.user?.employeeId]); };
  const originalIdentity = identity(), hash = window.location.hash;
  const stamp = `plans:${version}:${crypto.randomUUID()}`;
  container.dataset.renderVersion = stamp;
  return () => version === renderVersion && originalIdentity === identity() && hash === window.location.hash
    && container.isConnected && container.dataset.renderVersion === stamp;
}
const planOnlyBadge = value => { const node = badge(planStatuses.some(status => status.value === value) ? value : ''); node.textContent = formatCarePlanStatus(value); return node; };
const planCaseLink = (cases, id) => {
  const item = typeof id === 'string' ? cases.get(id) : null;
  const name = typeof item?.name === 'string' && item.name ? item.name : '個案名稱未取得';
  return item && typeof item === 'object' && !Array.isArray(item) ? link(name, `/cases/${encodeURIComponent(id)}`) : el('span', {}, '個案名稱未取得');
};

function planForm(item, data, refresh, alive, fixedCaseId) {
  if (!alive()) return;
  const create = !item, editor = createCarePlanEditor({ existing: item, cases: data.cases, serviceItems: data['service-items'], defaultDate: today(), fixedCaseId });
  const id = item?.id, version = item?.version, organizationId = getContext().organizationId;
  const headers = mutationHeaders();
  return openForm({ title: create ? '新增照顧計畫' : '編輯照顧計畫', initial: editor.initial, fields: editor.fields, isCurrent: alive,
    onChange: (values, helpers) => {
      for (const descriptor of editor.fields) if (editor.needsIntent(descriptor.name))
        helpers.setDisabled(descriptor.name, !editor.enabled(descriptor.name, values));
    },
    onSubmit: async (values, { signal, isCurrent }) => {
      const payload = editor.buildPayload(values);
      const result = await api(create ? '/api/care-plans' : `/api/care-plans/${encodeURIComponent(id)}`, {
        method: create ? 'POST' : 'PATCH', body: create ? payload : { ...payload, version }, headers, signal,
      });
      if (!isCurrent()) return;
      editor.confirm(result?.item, organizationId, payload);
      toast(create ? '照顧計畫已新增。' : '照顧計畫已更新。', 'success'); await refresh();
    },
  });
}

function changePlanStatus(plan, status, refresh, alive) {
  if (!alive()) return;
  const editor = createCarePlanEditor({ existing: plan }), id = plan.id, version = plan.version, organizationId = getContext().organizationId;
  const title = status === 'active' ? '啟用照顧計畫' : '結束照顧計畫';
  return confirmAction({ title, message: status === 'active' ? '啟用後，此計畫可用來安排有效期間內的新班次。' : '結束後，不能再依此計畫新增排班。請先核對尚未執行的班次。', confirmLabel: title, danger: status === 'ended', isCurrent: alive,
    onConfirm: async ({ signal, isCurrent }) => {
      const payload = { status };
      const result = await api(`/api/care-plans/${encodeURIComponent(id)}`, { method: 'PATCH', body: { ...payload, version }, signal });
      if (!isCurrent()) return;
      editor.confirm(result?.item, organizationId, payload);
      toast(`${title}完成。`, 'success'); await refresh();
    },
  });
}

async function renderPlans(route, container, version) {
  const alive = planOnlyCurrent(container, version);
  const data = await withLookups(container, version, ['cases', 'employees', 'service-items', 'care-plans']).catch(error => { if (alive()) throw error; return null; });
  if (!data || !alive()) return;
  const cases = mapById(data.cases), services = mapById(data['service-items']);
  await renderList({ route, container, version, title: '照顧計畫', subtitle: '先確認生效期間與服務項目，再安排班次。', entity: 'care-plans', statuses: planStatuses, isCurrent: alive,
    createAction: canManage() ? { label: '新增照顧計畫', open: refresh => planForm(null, data, refresh, alive, readListState(route).caseId) } : null,
    columns: refresh => [
      { label: '個案', render: row => planCaseLink(cases, row.caseId) },
      { label: '有效期間', render: row => `${formatCarePlanDate(row.validFrom)} 至 ${formatCarePlanDate(row.validTo)}` },
      { label: '服務內容', render: row => formatCarePlanServices(row.services, services) },
      { label: '狀態', render: row => planOnlyBadge(row.status) }, { key: 'goals', label: '照顧目標', render: row => formatCarePlanText(row.goals) },
      { label: '操作', render: row => actionGroup(
        historyAction('care-plans', row, { cases, 'service-items': services }, container, version),
        canManage() ? button('編輯', () => planForm(row, data, refresh, alive), { variant: 'secondary' }) : null,
        canManage() && row.status === 'draft' ? button('啟用', () => changePlanStatus(row, 'active', refresh, alive), { variant: 'secondary' }) : null,
        canManage() && row.status === 'active' ? button('新增排班', () => shiftForm(null, data, refresh, alive, row), { variant: 'secondary' }) : null,
        canManage() && row.status === 'active' ? button('結束計畫', () => changePlanStatus(row, 'ended', refresh, alive), { variant: 'secondary' }) : null,
      ) },
    ],
  });
}

function shiftOnlyCurrent(container, version) {
  const identity = () => { const context = getContext(); return JSON.stringify([context.user?.id, context.organizationId, context.role, context.user?.employeeId]); };
  const originalIdentity = identity(), hash = window.location.hash;
  const stamp = ['shifts', version, crypto.randomUUID()].join(':');
  container.dataset.renderVersion = stamp;
  return () => version === renderVersion && originalIdentity === identity() && hash === window.location.hash
    && container.isConnected && container.dataset.renderVersion === stamp;
}
const shiftOnlyTimeRange = item => formatShiftTime(item.startTime) + '–' + formatShiftTime(item.endTime);
const shiftOnlyName = (items, id, fallback) => typeof id === 'string' && typeof items.get(id)?.name === 'string' && items.get(id).name
  ? items.get(id).name : fallback;
const shiftOnlyBadge = value => { const node = badge(shiftStatuses.some(status => status.value === value) ? value : ''); node.textContent = formatShiftStatus(value); return node; };

function shiftForm(item, data, refresh, alive, fixedPlan) {
  if (!alive()) return;
  const create = !item, editor = createShiftEditor({ existing: item, cases: data.cases, employees: data.employees,
    carePlans: fixedPlan ? [fixedPlan] : data['care-plans'], serviceItems: data['service-items'], defaultDate: today(), fixedPlanId: fixedPlan?.id || '' });
  if (create && !editor.fields.find(descriptor => descriptor.name === 'carePlanId').options.length) {
    toast('請先建立並啟用個案的照顧計畫，再新增排班。', 'info'); return;
  }
  const id = item?.id, version = item?.version, organizationId = getContext().organizationId;
  const headers = mutationHeaders();
  let optionsSignature = JSON.stringify(editor.serviceOptions(editor.initial));
  let selectedPlanId = editor.initial.carePlanId;
  return openForm({ title: create ? '新增排班' : '調整班次／代班', initial: editor.initial, fields: editor.fields, isCurrent: alive,
    onChange: (values, helpers) => {
      const options = editor.serviceOptions(values), signature = JSON.stringify(options);
      if (values.carePlanId !== selectedPlanId || signature !== optionsSignature) {
        selectedPlanId = values.carePlanId;
        optionsSignature = signature;
        const allowedIds = new Set(options.map(option => option.value));
        const pendingServices = !create && Array.isArray(values.services)
          ? values.services.filter(entry => entry && allowedIds.has(entry.serviceItemId)) : [];
        helpers.setOptions('services', options);
        helpers.setValue('services', pendingServices);
      }
      for (const descriptor of editor.fields) if (editor.needsIntent(descriptor.name))
        helpers.setDisabled(descriptor.name, !editor.enabled(descriptor.name, values));
    },
    onSubmit: async (values, { signal, isCurrent }) => {
      const payload = editor.buildPayload(values);
      const result = await api(create ? '/api/shifts' : '/api/shifts/' + encodeURIComponent(id), {
        method: create ? 'POST' : 'PATCH', body: create ? payload : { ...payload, version }, headers, signal,
      });
      if (!isCurrent()) return;
      editor.confirm(result?.item, organizationId, payload);
      toast(create ? '班次已新增。' : '班次已調整。', 'success'); await refresh();
    },
  });
}

function cancelShift(item, caseName, refresh, alive) {
  if (!alive()) return;
  const editor = createShiftEditor({ existing: item }), id = item.id, version = item.version, organizationId = getContext().organizationId;
  return confirmAction({ title: '取消班次', message: '取消「' + caseName + '」' + formatShiftDate(item.date) + ' ' + shiftOnlyTimeRange(item) + ' 的班次。已建立服務紀錄的班次不能取消。', confirmLabel: '確認取消班次', danger: true, isCurrent: alive,
    onConfirm: async ({ signal, isCurrent }) => {
      const payload = { status: 'cancelled' };
      const result = await api('/api/shifts/' + encodeURIComponent(id), { method: 'PATCH', body: { ...payload, version }, signal });
      if (!isCurrent()) return;
      editor.confirm(result?.item, organizationId, payload);
      toast('班次已取消。', 'success'); await refresh();
    },
  });
}

async function renderShifts(route, container, version) {
  const alive = shiftOnlyCurrent(container, version);
  const data = await withLookups(container, version, ['cases', 'employees', 'service-items', 'care-plans']).catch(error => { if (alive()) throw error; return null; });
  if (!data || !alive()) return;
  const cases = mapById(data.cases), employees = mapById(data.employees), services = mapById(data['service-items']);
  const historyLookups = { cases, employees, 'service-items': services, 'care-plans': mapById(data['care-plans']) };
  await renderList({ route, container, version, title: '班表', subtitle: '依日或月份核對班次，安排服務人員與代班。', entity: 'shifts', statuses: shiftStatuses, dateMode: true, isCurrent: alive,
    createAction: canManage() ? { label: '新增排班', open: refresh => shiftForm(null, data, refresh, alive) } : null,
    extraActions: canManage() ? refresh => [button('週期排班', () => openRecurringShifts({ data, refresh, isCurrent: () => version === renderVersion && container.isConnected }), { variant: 'secondary' }),
      button('週／月班表', () => openShiftCalendar({ isCurrent: alive }), { variant: 'secondary' })] : undefined,
    enrichItems: recordsForShifts,
    columns: (refresh, records) => [
      { label: '服務日期', render: row => formatShiftDate(row.date) }, { label: '時段', render: shiftOnlyTimeRange },
      { label: '個案', render: row => planCaseLink(cases, row.caseId) },
      { label: '服務人員', render: row => shiftOnlyName(employees, row.employeeId, '服務人員名稱未取得') },
      { label: '服務內容', render: row => formatShiftServices(row.services, services) },
      { label: '狀態', render: row => shiftOnlyBadge(row.status) },
      { label: '操作', render: row => actionGroup(
        historyAction('shifts', row, historyLookups, container, version),
        ...(row.status === 'scheduled' && canManage() && !records.has(row.id) ? [
          button('調整／代班', () => shiftForm(row, data, refresh, alive), { variant: 'secondary' }),
          button('取消班次', () => cancelShift(row, shiftOnlyName(cases, row.caseId, '這筆個案'), refresh, alive), { variant: 'secondary' }),
        ] : [message(row.status === 'completed' ? '已核閱完成' : row.status === 'cancelled' ? '已取消' : records.has(row.id) ? '已有服務紀錄，班次已鎖定' : '唯讀')]),
      ) },
    ],
  });
}

function recordOnlyCurrent(container, version) {
  const identity = () => { const context = getContext(); return JSON.stringify([context.user?.id, context.organizationId, context.role, context.user?.employeeId]); };
  const originalIdentity = identity(), hash = window.location.hash;
  const stamp = `service-records:${version}:${crypto.randomUUID()}`;
  container.dataset.renderVersion = stamp;
  return () => version === renderVersion && originalIdentity === identity() && hash === window.location.hash
    && container.isConnected && container.dataset.renderVersion === stamp;
}

function recordForm(shift, existing, items, refresh, alive) {
  if (!alive() || (existing && !canEditRecord(existing))) return;
  if (!existing && !(canManage() || isOwnRecord(shift))) return;
  const editor = createServiceRecordEditor({ existing, shift, serviceItems: items });
  const id = existing?.id, version = existing?.version, organizationId = getContext().organizationId;
  const headers = mutationHeaders();
  return openForm({ title: existing?.status === 'returned' ? '修正退回的服務紀錄' : '填寫服務紀錄',
    initial: editor.initial, fields: editor.fields, isCurrent: alive,
    onChange: (values, helpers) => {
      for (const descriptor of editor.fields) if (editor.needsIntent(descriptor.name))
        helpers.setDisabled(descriptor.name, !editor.enabled(descriptor.name, values));
    },
    onSubmit: async (values, { signal, isCurrent }) => {
      const payload = editor.buildPayload(values);
      const result = await api(existing ? `/api/service-records/${encodeURIComponent(id)}` : '/api/service-records', {
        method: existing ? 'PATCH' : 'POST', body: existing ? { ...payload, version } : payload, headers, signal,
      });
      if (!isCurrent()) return;
      editor.confirm(result?.item, organizationId, payload);
      const status = Object.hasOwn(payload, 'status') ? payload.status : existing?.status;
      toast(status === 'submitted' ? '服務紀錄已送督導核閱。' : status === 'returned' ? '退回紀錄已儲存，尚未重送。' : '服務紀錄草稿已儲存。', 'success');
      await refresh();
    },
  });
}

function reviewRecord(item, refresh, alive) {
  if (!alive() || !canManage() || item.status !== 'submitted') return;
  const reviewer = createServiceRecordReview({ existing: item });
  const id = item.id, version = item.version, organizationId = getContext().organizationId;
  const headers = mutationHeaders();
  return openForm({ title: '核閱服務紀錄', initial: reviewer.initial, fields: reviewer.fields, isCurrent: alive,
    onSubmit: async (values, { signal, isCurrent }) => {
      const payload = reviewer.buildPayload(values);
      const result = await api(`/api/service-records/${encodeURIComponent(id)}/review`, {
        method: 'POST', body: { version, ...payload }, headers, signal,
      });
      if (!isCurrent()) return;
      reviewer.confirm(result?.item, organizationId, payload);
      toast(payload.decision === 'approved' ? '服務紀錄已完成核閱。' : '服務紀錄已退回修正。', 'success');
      await refresh();
    },
  });
}

async function renderRecords(route, container, version) {
  const alive = recordOnlyCurrent(container, version);
  const data = await withLookups(container, version, ['cases', 'employees', 'service-items', 'shifts']).catch(error => { if (alive()) throw error; return null; });
  if (!data || !alive()) return;
  const cases = mapById(data.cases), employees = mapById(data.employees), services = mapById(data['service-items']), shifts = mapById(data.shifts);
  const historyLookups = { cases, employees, 'service-items': services, shifts };
  await renderList({ route, container, version, title: '服務紀錄與核閱', subtitle: '檢查實際服務內容。待核閱紀錄只能由督導或管理者通過、退回。', entity: 'service-records', statuses: recordStatuses, dateMode: true, isCurrent: alive,
    columns: refresh => [
      { label: '日期', render: row => formatShiftDate(row.date) }, { label: '個案', render: row => planCaseLink(cases, row.caseId) },
      { label: '服務人員', render: row => shiftOnlyName(employees, row.employeeId, '服務人員名稱未取得') },
      { label: '實際時間', render: actualTimeRange },
      { label: '服務內容', render: row => formatShiftServices(row.services, services) },
      { label: '狀態', render: row => recordBadge(row.status) }, { label: '服務紀錄', render: row => recordText(row.note) }, { label: '核閱說明', render: row => recordText(row.reviewNote) },
      { label: '操作', render: row => actionGroup(
        historyAction('service-records', row, historyLookups, container, version),
        row.status === 'submitted' && canManage()
        ? button('核閱', () => reviewRecord(row, refresh, alive), { variant: 'secondary' })
        : canEditRecord(row) && shifts.has(row.shiftId)
          ? button(row.status === 'returned' ? '修正退回紀錄' : '編輯草稿', () => recordForm(shifts.get(row.shiftId), row, data['service-items'], refresh, alive), { variant: 'secondary' })
          : message(row.status === 'approved' ? '已完成核閱' : row.status === 'submitted' ? '等待督導核閱' : '唯讀'),
      ) },
    ],
  });
}

async function renderMyServices(route, container, version) {
  const alive = recordOnlyCurrent(container, version);
  if (!getContext().user?.employeeId) {
    container.replaceChildren(pageHeader('我的服務', '查看自己的班次與填寫服務紀錄。'), el('section', { class: 'panel' }, el('h2', {}, '此帳號尚未連結員工'), message('請由管理者建立帳號與員工的對應後再使用。'), link('查看班表', '/shifts')));
    return;
  }
  const data = await withLookups(container, version, ['cases', 'employees', 'service-items', 'care-plans']).catch(error => { if (alive()) throw error; return null; });
  if (!data || !alive()) return;
  const cases = mapById(data.cases), services = mapById(data['service-items']);
  const historyLookups = { cases, employees: mapById(data.employees), 'service-items': services, 'care-plans': mapById(data['care-plans']) };
  await renderList({ route, container, version, title: '我的服務', subtitle: '出發前核對地址與交班事項，服務後填寫實際紀錄。', entity: 'shifts', statuses: shiftStatuses, dateMode: true, onlyOwn: true, isCurrent: alive,
    extraActions: getContext().role === 'caregiver' ? () => [button('週／月班表', () => openShiftCalendar({ isCurrent: alive }), { variant: 'secondary' })] : undefined,
    enrichItems: recordsForShifts,
    renderItems: (items, refresh, records, emptyText) => {
      if (!items.length) return el('div', { class: 'empty-state' }, emptyText);
      const recordHistoryLookups = { ...historyLookups, shifts: mapById(items) };
      return el('div', { class: 'service-list' }, ...items.map(shift => {
        const person = cases.get(shift.caseId), record = records.get(shift.id);
        const canStart = shift.status === 'scheduled' && !record;
        const card = el('article', { class: 'service-card' },
          el('div', { class: 'card-meta' }, el('strong', {}, `${formatDate(shift.date)} ${timeRange(shift)}`), record ? recordBadge(record.status) : badge(shift.status)),
          el('h2', {}, link(person?.name || '個案', `/cases/${encodeURIComponent(shift.caseId)}`)),
          el('p', {}, person?.address || '尚未提供地址'), el('p', { class: 'service-items' }, serviceSummary(shift.services, services)),
          person?.note ? el('p', {}, `照顧注意：${person.note}`) : null,
          shift.note ? el('p', {}, `交班備註：${shift.note}`) : null,
          record && Object.hasOwn(record, 'reviewNote') ? el('p', {}, `核閱說明：${recordText(record.reviewNote)}`) : null,
          record ? el('p', {}, `實際服務：${actualTimeRange(record)}`) : null,
          actionGroup(
            canStart || (record && canEditRecord(record))
              ? button(record ? record.status === 'returned' ? '修正退回紀錄' : '繼續填寫草稿' : '填寫服務紀錄', () => recordForm(shift, record, data['service-items'], refresh, alive))
              : message(record?.status === 'submitted' ? '已送出，等待督導核閱。' : record?.status === 'approved' ? '已由督導完成核閱。' : '此班次無須填寫新紀錄。'),
            historyAction('shifts', shift, historyLookups, container, version),
            record && historyAction('service-records', record, recordHistoryLookups, container, version, '服務紀錄版本歷程'),
          ),
        );
        return card;
      }));
    },
  });
}

async function renderCaseDetail(id, route, container, version) {
  const alive = caseOnlyCurrent(container, version);
  const refresh = () => renderOperations(route, container);
  const result = await Promise.all([
    api(`/api/cases/${encodeURIComponent(id)}`),
    withLookups(container, version, ['employees', 'service-items']),
    apiList('care-plans', { caseId: id, status: 'active', page: 1, pageSize: 5 }),
    apiList('shifts', { caseId: id, page: 1, pageSize: 5 }),
    apiList('service-records', { caseId: id, page: 1, pageSize: 5 }),
    apiList('service-records', { caseId: id, status: 'approved', page: 1, pageSize: 1 }),
  ]).catch(error => { if (alive()) throw error; return null; });
  if (!result || !alive()) return;
  const [response, data, plans, shifts, records, approved] = result;
  if (!data) return;
  const item = response.item, employees = mapById(data.employees), services = mapById(data['service-items']);
  const recordHistoryLookups = { cases: mapById([item]), employees, 'service-items': services, shifts: mapById(shifts.items) };
  const isCaregiver = getContext().role === 'caregiver';
  const actions = actionGroup(link('回個案列表', '/cases'));
  actions.append(historyAction('cases', item, { employees }, container, version, '個案版本歷程'));
  if (canManage()) {
    actions.append(button('保存紀錄索引', () => openCaseRecordIndex({ caseRecord: item, lookups: recordHistoryLookups, isCurrent: alive }), { variant: 'secondary' }));
    actions.append(button('編輯個案', () => caseForm(item, data.employees, refresh, alive), { variant: 'secondary' }));
    for (const status of caseStatuses.filter(s => s.value !== item.status)) actions.append(button(status.value === 'active' ? '恢復服務' : status.label, () => changeCaseStatus(item, status.value, refresh, alive), { variant: 'secondary' }));
  }
  const detail = el('dl', { class: 'detail-grid' });
  const facts = [
    ['案號', formatCaseText(item.caseNo)], ['狀態', formatCaseStatus(item.status)],
    ['出生日期', formatCaseBirthDate(item.birthDate)], ['電話', formatCaseText(item.phone)], ['服務地址', formatCaseText(item.address)],
    ['CMS 等級', formatCaseCms(item.cmsLevel)], ['福利身分別', formatCaseText(item.welfare)], ['主責督導', caseSupervisorName(employees, item.supervisorId)],
    ['主要照顧者', formatCaseText(item.primaryCarer)], ['聯絡人', formatCaseText(item.contactName)], ['聯絡人電話', formatCaseText(item.contactPhone)], ['照顧注意事項', formatCaseText(item.note)],
  ];
  for (const [label, value] of facts) detail.append(el('div', {}, el('dt', {}, label), el('dd', {}, textValue(value))));
  const relay = el('ol', { class: 'service-relay', 'aria-label': '服務接力狀態' },
    ...[
      ['照顧計畫', `${plans.total} 份生效中`, '/plans'], ['排班', `${shifts.total} 筆班次`, '/shifts'],
      ['服務紀錄', `${records.total} 筆紀錄`, '/records'], ['督導核閱', `${approved.total} 筆已核閱`, '/records'],
    ].map(([name, count, target], index) => el('li', { class: 'relay-step' }, el('span', {}, name), el('strong', {}, count),
      canManage() ? button('查看', () => filteredNavigation(target, { caseId: id, status: index === 3 ? 'approved' : index === 0 ? 'active' : '' }), { variant: 'secondary' })
        : isCaregiver && index > 0 ? button('我的服務', () => filteredNavigation('/my-services', { caseId: id }), { variant: 'secondary' }) : null)),
  );
  const planActions = actionGroup(canManage() ? button('查看全部計畫', () => filteredNavigation('/plans', { caseId: id, status: '' }), { variant: 'secondary' }) : null);
  if (canManage() && item.status === 'active') planActions.append(button('新增照顧計畫', () => planForm(null, { cases: [item], employees: data.employees, 'service-items': data['service-items'] }, refresh, alive, id)));
  const contacts = createContactsPanel({ caseRecord: item, isCurrent: alive });
  const attachments = createAttachmentsPanel({ caseRecord: item, isCurrent: alive });
  const followups = createCaseStatusFollowupsPanel({ caseRecord: item, isCurrent: alive });
  container.replaceChildren(
    pageHeader(formatCaseText(item.name), '聯絡資料與服務接力，從目前計畫接續下一步作業。', actions),
    el('section', { class: 'panel' }, sectionTitle('服務接力'), relay),
    el('section', { class: 'panel' }, sectionTitle('個案與聯絡資料'), detail),
    contacts.element,
    attachments.element,
    followups.element,
    el('section', { class: 'panel' }, sectionTitle('生效中的照顧計畫', planActions), message(`共 ${plans.total} 份，顯示前 ${plans.items.length} 份。`), table([
      { label: '有效期間', render: row => `${formatCarePlanDate(row.validFrom)} 至 ${formatCarePlanDate(row.validTo)}` },
      { label: '服務內容', render: row => formatCarePlanServices(row.services, services) }, { key: 'goals', label: '照顧目標', render: row => formatCarePlanText(row.goals) },
      { label: '操作', render: row => actionGroup(
        historyAction('care-plans', row, { cases: mapById([item]), 'service-items': services }, container, version, '計畫版本歷程'),
        canManage() && item.status === 'active' ? button('新增排班', () => shiftForm(null, { cases: [item], employees: data.employees, 'service-items': data['service-items'], 'care-plans': plans.items }, refresh, alive, row), { variant: 'secondary' }) : planOnlyBadge(row.status),
      ) },
    ], plans.items, { emptyText: '尚無生效中的照顧計畫。' })),
    el('section', { class: 'panel' }, sectionTitle('班次', canManage() ? button('查看全部班次', () => filteredNavigation('/shifts', { caseId: id, status: '' }), { variant: 'secondary' }) : isCaregiver ? button('查看我的班次', () => filteredNavigation('/my-services', { caseId: id }), { variant: 'secondary' }) : null), message(`共 ${shifts.total} 筆，顯示前 ${shifts.items.length} 筆。`), table([
      { label: '日期', render: row => formatDate(row.date) }, { label: '時段', render: timeRange },
      { label: '服務人員', render: row => nameOf(employees, row.employeeId) }, { label: '狀態', render: row => badge(row.status) },
    ], shifts.items, { emptyText: '尚未安排班次。' })),
    el('section', { class: 'panel' }, sectionTitle('服務紀錄', canManage() ? button('查看全部紀錄', () => filteredNavigation('/records', { caseId: id, status: '' }), { variant: 'secondary' }) : isCaregiver ? button('查看我的服務', () => filteredNavigation('/my-services', { caseId: id }), { variant: 'secondary' }) : null), message(`共 ${records.total} 筆，顯示前 ${records.items.length} 筆。`), table([
      { label: '日期', render: row => formatShiftDate(row.date) }, { label: '實際時間', render: actualTimeRange },
      { label: '狀態', render: row => recordBadge(row.status) }, { label: '服務紀錄', render: row => recordText(row.note) },
      { label: '操作', render: row => actionGroup(
        historyAction('service-records', row, recordHistoryLookups, container, version),
        canManage() && row.status === 'submitted' ? button('核閱', () => reviewRecord(row, refresh, alive), { variant: 'secondary' }) : message('查看紀錄'),
      ) },
    ], records.items, { emptyText: '尚無服務紀錄。' })),
  );
  void contacts.load();
  void attachments.load();
  void followups.load();
}

export async function renderOperations(route, container) {
  const version = ++renderVersion;
  container.replaceChildren(liveRegion());
  try {
    if (route === '/cases') await renderCases(route, container, version);
    else if (/^\/cases\/[^/]+$/.test(route)) await renderCaseDetail(decodeURIComponent(route.split('/')[2]), route, container, version);
    else if (route === '/plans') await renderPlans(route, container, version);
    else if (route === '/shifts') await renderShifts(route, container, version);
    else if (route === '/records') await renderRecords(route, container, version);
    else if (route === '/my-services') await renderMyServices(route, container, version);
    else container.replaceChildren(pageHeader('找不到頁面', '請從導覽選擇要使用的功能。'), link('回個案列表', '/cases'));
  } catch (error) {
    if (error.name === 'AbortError' || version !== renderVersion || !container.isConnected) return;
    container.replaceChildren(pageHeader('資料暫時無法讀取', '請檢查連線或重新讀取。'), errorState(error, () => renderOperations(route, container)));
  }
}
