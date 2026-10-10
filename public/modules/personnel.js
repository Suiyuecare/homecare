import {
  api, el, button, pageHeader, table, badge, openForm,
  confirmAction, toast, formatDate, today, getContext, fetchAll,
  searchBox, pagination, errorState,
} from '../ui.js';
import { openRecordHistory } from './history.js';
import { createCertificationAttachmentsPanel } from './certification-attachments.js';
import { createCertificationEditor } from '../data/certification-editor.js';
import { createTrainingEditor, formatTrainingMinutes, formatTrainingCategory } from '../data/training-editor.js';

const PAGE_SIZE = 25;
const filters = new Map();
let generation = 0;
const categories = { pre_service: '職前訓練', in_service: '在職訓練', other: '其他訓練' };
const recordStatuses = { active: '有效紀錄', revoked: '已撤銷', completed: '已完成', cancelled: '已取消' };
const expiryLabels = { expired: '已到期', due_soon: '即將到期', valid: '有效期內', no_expiry: '未填到期日', revoked: '已撤銷' };
const routeConfig = {
  '/certifications': { entity: 'employee-certifications', title: '員工證照', noun: '證照', statuses: ['active', 'revoked'] },
  '/training': { entity: 'employee-training', title: '教育訓練', noun: '訓練', statuses: ['completed', 'cancelled'] },
};
const orgId = () => getContext().organizationId || getContext().orgId;
const contextIdentity = () => {
  const context = getContext();
  return `${context.user?.id || ''}:${orgId() || ''}:${context.role || ''}:${context.user?.employeeId || ''}`;
};
const contextKey = route => `${contextIdentity()}:${route}`;
const canWrite = () => ['admin', 'supervisor'].includes(getContext().role);
const field = (name, label, type = 'text', extra = {}) => ({ name, label, type, ...extra });
const choices = labels => Object.entries(labels).map(([value, label]) => ({ value, label }));
const actionGroup = (...nodes) => el('div', { class: 'actions row-actions' }, ...nodes.filter(Boolean));
const minutesText = minutes => {
  const value = Number(minutes);
  if (!Number.isFinite(value)) return '—';
  const hours = Math.floor(value / 60), remainder = value % 60;
  return `${hours ? `${hours} 小時` : ''}${hours && remainder ? ' ' : ''}${remainder || !hours ? `${remainder} 分鐘` : ''}`;
};
function stateFor(route) {
  const key = contextKey(route);
  if (!filters.has(key)) filters.set(key, { page: 1, q: '', employeeId: '', status: '', expiry: '', category: '', asOf: today() });
  return filters.get(key);
}

// Employee navigation carries its filter in memory, never in the URL or storage.
export function setPersonnelEmployeeFilter(route, employeeId) {
  if (!routeConfig[route]) return;
  Object.assign(stateFor(route), { employeeId, page: 1, q: '', status: '', expiry: '', category: '' });
}

function selectFilter(label, options, value, onChange) {
  const control = el('select', { 'aria-label': label }, options.map(option => el('option', { value: option.value }, option.label)));
  control.value = value;
  control.addEventListener('change', () => onChange(control.value));
  return el('label', { class: 'filter-field' }, el('span', {}, label), control);
}
function statusBadge(status) {
  const tag = badge(status === 'revoked' ? 'inactive' : status);
  tag.textContent = recordStatuses[status] || status;
  return tag;
}
function expiryCell(row) {
  const state = row.status === 'revoked' ? 'revoked' : row.expiryState;
  const tone = { expired: 'closed', due_soon: 'pending', valid: 'active', no_expiry: 'active', revoked: 'inactive' }[state];
  const tag = badge(tone || 'inactive');
  tag.textContent = expiryLabels[state] || '尚未取得效期狀態';
  const days = Number(row.daysToExpiry);
  const hint = state === 'revoked' || state === 'no_expiry' || row.daysToExpiry === null || !Number.isFinite(days)
    ? '' : days < 0 ? `已過 ${Math.abs(days)} 天` : days === 0 ? '今日到期' : `剩 ${days} 天`;
  return el('div', {}, tag, hint && el('div', { class: 'small muted' }, hint));
}
function fieldError(name, message) {
  const error = new Error(message);
  error.fields = { [name]: message };
  return error;
}
function toMinutes(hours) {
  const raw = Number(hours) * 60;
  const minutes = Math.round(raw);
  if (!Number.isFinite(raw) || Math.abs(raw - minutes) > 1e-7 || minutes < 1 || minutes > 60000) {
    throw fieldError('trainingHours', '請輸入可換算為整數分鐘的時數，範圍為 1 分鐘至 1,000 小時。');
  }
  return minutes;
}

function editCertification(employees, state, refresh, alive, existing) {
  const editor = createCertificationEditor({ existing, employees, defaultDate: today(), defaultEmployeeId: state.employeeId });
  const organizationId = orgId();
  return openForm({
    title: `${existing ? '編輯' : '新增'}證照`,
    fields: editor.fields, initial: editor.initial, isCurrent: alive,
    onChange: (values, helpers) => {
      for (const descriptor of editor.fields) if (editor.needsIntent(descriptor.name)) {
        helpers.setDisabled(descriptor.name, !editor.enabled(descriptor.name, values));
      }
    },
    onSubmit: async (values, { signal, isCurrent }) => {
      const payload = editor.buildPayload(values);
      const result = await api(`/api/employee-certifications${existing ? `/${encodeURIComponent(existing.id)}` : ''}`, {
        method: existing ? 'PATCH' : 'POST', body: existing ? { ...payload, version: existing.version } : payload, signal,
      });
      if (!isCurrent()) return;
      editor.confirm(result?.item, organizationId, payload);
      toast('證照紀錄已儲存', 'success'); await refresh();
    },
  });
}

function changeCertificationStatus(record, refresh, alive) {
  const editor = createCertificationEditor({ existing: record });
  const organizationId = orgId();
  const inactive = record.status === 'revoked';
  const status = inactive ? 'active' : 'revoked';
  const verb = inactive ? '恢復有效紀錄' : '撤銷證照';
  const name = typeof record.name === 'string' && record.name && !/[\r\n]/.test(record.name) ? record.name : '這筆證照紀錄';
  return confirmAction({
    title: verb, confirmLabel: `確認${verb}`, danger: !inactive, isCurrent: alive,
    message: `${verb}「${name}」？原資料與版本歷程會保留。${inactive ? '效期仍依發證日期與到期日期判定。' : '撤銷後不再顯示到期警示。'}`,
    onConfirm: async ({ signal, isCurrent }) => {
      const payload = { status };
      const result = await api(`/api/employee-certifications/${encodeURIComponent(record.id)}`, {
        method: 'PATCH', body: { version: record.version, ...payload }, signal,
      });
      if (!isCurrent()) return;
      editor.confirm(result?.item, organizationId, payload);
      toast(`已${verb}`, 'success'); await refresh();
    },
  });
}

function editTraining(employees, state, refresh, alive, existing) {
  const editor = createTrainingEditor({ existing, employees, defaultDate: today(), defaultEmployeeId: state.employeeId });
  const organizationId = orgId(), recordId = existing?.id, version = existing?.version;
  return openForm({
    title: `${existing ? '編輯' : '新增'}訓練`,
    fields: editor.fields, initial: editor.initial, isCurrent: alive,
    onChange: (values, helpers) => {
      for (const descriptor of editor.fields) if (editor.needsIntent(descriptor.name)) {
        helpers.setDisabled(descriptor.name, !editor.enabled(descriptor.name, values));
      }
    },
    onSubmit: async (values, { signal, isCurrent }) => {
      const payload = editor.buildPayload(values);
      let result;
      try {
        result = await api(`/api/employee-training${existing ? `/${encodeURIComponent(recordId)}` : ''}`, {
          method: existing ? 'PATCH' : 'POST', body: existing ? { ...payload, version } : payload, signal,
        });
      } catch (error) {
        if (error.fields?.trainingMinutes) error.fields = { ...error.fields, trainingHours: error.fields.trainingMinutes };
        throw error;
      }
      if (!isCurrent()) return;
      editor.confirm(result?.item, organizationId, payload);
      toast('訓練紀錄已儲存', 'success'); await refresh();
    },
  });
}

function changeTrainingStatus(record, refresh, alive) {
  const editor = createTrainingEditor({ existing: record });
  const organizationId = orgId(), recordId = record.id, version = record.version;
  const inactive = record.status === 'cancelled';
  const status = inactive ? 'completed' : 'cancelled';
  const verb = inactive ? '恢復完成紀錄' : '取消訓練紀錄';
  const name = typeof record.name === 'string' && record.name && !/[\r\n]/.test(record.name) ? record.name : '這筆訓練紀錄';
  return confirmAction({
    title: verb, confirmLabel: `確認${verb}`, danger: !inactive, isCurrent: alive,
    message: `${verb}「${name}」？原資料與版本歷程會保留；取消紀錄不算已完成訓練。`,
    onConfirm: async ({ signal, isCurrent }) => {
      const payload = { status };
      const result = await api(`/api/employee-training/${encodeURIComponent(recordId)}`, {
        method: 'PATCH', body: { version, ...payload }, signal,
      });
      if (!isCurrent()) return;
      editor.confirm(result?.item, organizationId, payload);
      toast(`已${verb}`, 'success'); await refresh();
    },
  });
}

function editRecord(config, employees, state, refresh, alive, existing) {
  if (config.entity === 'employee-certifications') return editCertification(employees, state, refresh, alive, existing);
  if (config.entity === 'employee-training') return editTraining(employees, state, refresh, alive, existing);
  const certification = config.entity === 'employee-certifications';
  const employeeOptions = employees.map(employee => ({ value: employee.id, label: `${employee.name} · ${employee.employeeNo}` }));
  const employeeField = field('employeeId', '員工', 'select', {
    required: true, options: employeeOptions, disabled: Boolean(existing),
    help: existing ? '紀錄建立後不可改換員工；若歸屬錯誤，請撤銷或取消後另建。' : '選擇這筆紀錄所屬的員工。',
  });
  const fields = certification ? [
    employeeField, field('name', '證照名稱', 'text', { required: true }),
    field('certificateNo', '證照編號'), field('issuer', '發證單位'),
    field('issuedOn', '發證日期', 'date', { required: true }),
    field('expiresOn', '到期日期', 'date', { help: '留空表示尚未提供到期日期；日期不可早於發證日期。' }),
    field('note', '備註', 'textarea', { wide: true }),
  ] : [
    employeeField, field('name', '課程名稱', 'text', { required: true }),
    field('category', '訓練類別', 'select', { required: true, options: choices(categories) }),
    field('provider', '辦訓單位'), field('date', '訓練日期', 'date', { required: true }),
    field('trainingHours', '訓練時數（小時）', 'number', {
      required: true, min: 1 / 60, max: 1000, step: 0.25,
      help: '每 0.25 小時為 15 分鐘；依實際完成時間保存為整數分鐘，不等同法定積分。',
    }),
    field('note', '備註', 'textarea', { wide: true }),
  ];
  const initial = existing ? { ...existing, trainingHours: existing.trainingMinutes / 60 }
    : { employeeId: state.employeeId, issuedOn: today(), date: today(), category: 'in_service', trainingHours: 1 };
  return openForm({
    title: `${existing ? '編輯' : '新增'}${config.noun}`, fields, initial,
    onSubmit: async values => {
      if (!alive()) throw new Error('機構或頁面已變更，請關閉後重新開啟表單。');
      if (certification && values.expiresOn && values.expiresOn < values.issuedOn) {
        throw fieldError('expiresOn', '到期日期不可早於發證日期。');
      }
      const data = { ...values };
      if (existing) delete data.employeeId;
      if (!certification) {
        data.trainingMinutes = toMinutes(values.trainingHours);
        delete data.trainingHours;
      }
      if (!existing) data.status = certification ? 'active' : 'completed';
      try {
        await api(`/api/${config.entity}${existing ? `/${encodeURIComponent(existing.id)}` : ''}`, {
          method: existing ? 'PATCH' : 'POST', body: existing ? { ...data, version: existing.version } : data,
        });
      } catch (error) {
        if (error.fields?.trainingMinutes) error.fields = { ...error.fields, trainingHours: error.fields.trainingMinutes };
        throw error;
      }
      if (alive()) { await refresh(); toast(`${config.noun}紀錄已儲存`, 'success'); }
    },
  });
}

function changeRecordStatus(config, record, refresh, alive) {
  if (config.entity === 'employee-certifications') return changeCertificationStatus(record, refresh, alive);
  if (config.entity === 'employee-training') return changeTrainingStatus(record, refresh, alive);
  const certification = config.entity === 'employee-certifications';
  const inactive = record.status === (certification ? 'revoked' : 'cancelled');
  const status = certification ? inactive ? 'active' : 'revoked' : inactive ? 'completed' : 'cancelled';
  const verb = certification ? inactive ? '恢復有效紀錄' : '撤銷證照' : inactive ? '恢復完成紀錄' : '取消訓練紀錄';
  return confirmAction({
    title: verb, confirmLabel: `確認${verb}`, danger: !inactive,
    message: certification
      ? `${verb}「${record.name}」？原資料與版本歷程會保留。${inactive ? '效期仍依發證日期與到期日期判定。' : '撤銷後不再顯示到期警示。'}`
      : `${verb}「${record.name}」？原資料與版本歷程會保留；取消紀錄不算已完成訓練。`,
    onConfirm: async () => {
      if (!alive()) throw new Error('機構或頁面已變更，請重新開啟紀錄。');
      await api(`/api/${config.entity}/${encodeURIComponent(record.id)}`, { method: 'PATCH', body: { version: record.version, status } });
      if (alive()) { await refresh(); toast(`已${verb}`, 'success'); }
    },
  });
}

async function renderList(route, container, alive) {
  const config = routeConfig[route];
  const certification = config.entity === 'employee-certifications';
  const employees = await fetchAll('employees');
  if (!alive()) return;
  const people = new Map(employees.map(employee => [employee.id, employee]));
  const state = stateFor(route);
  if (state.employeeId && !people.has(state.employeeId)) state.employeeId = '';
  if (getContext().role === 'caregiver') state.employeeId = getContext().user.employeeId || employees[0]?.id || '';
  let controller, asOfControl, sequence = 0;
  const body = el('div', { class: 'list-content', 'aria-live': 'polite', 'aria-atomic': 'false' });
  const footer = el('div', { class: 'list-footer' });
  const attachmentHost = el('div');
  let selectedAttachments, attachmentGeneration = 0, attachmentTrigger;
  function closeAttachments(restoreFocus = false) {
    attachmentGeneration += 1;
    selectedAttachments?.destroy(); selectedAttachments = null; attachmentHost.replaceChildren();
    if (restoreFocus && attachmentTrigger?.isConnected) attachmentTrigger.focus();
    attachmentTrigger = null;
  }
  function selectAttachments(record, trigger) {
    if (!alive()) return;
    closeAttachments();
    attachmentTrigger = trigger;
    const selection = attachmentGeneration;
    selectedAttachments = createCertificationAttachmentsPanel({
      certification: record, employees: people,
      isCurrent: () => alive() && attachmentHost.isConnected && selection === attachmentGeneration,
      onClose: () => closeAttachments(true),
    });
    attachmentHost.replaceChildren(selectedAttachments.element);
    const heading = selectedAttachments.element.querySelector('h2');
    heading?.focus(); heading?.scrollIntoView({ block: 'start' });
    void selectedAttachments.load();
  }
  const dateError = el('p', { class: 'field-error', role: 'alert', hidden: true, id: `as-of-error-${crypto.randomUUID()}` });
  const employeeName = record => people.get(record.employeeId)?.name || '未找到員工';
  const columns = () => [
    { label: '員工', render: row => employeeName(row) }, { label: certification ? '證照名稱' : '課程名稱', key: 'name' },
    ...(certification ? [
      { key: 'certificateNo', label: '證照編號' }, { key: 'issuer', label: '發證單位' },
      { label: '發證日期', render: row => formatDate(row.issuedOn) },
      { label: '到期日期', render: row => row.expiresOn ? formatDate(row.expiresOn) : '未填到期日' },
      { label: '效期狀態', render: expiryCell },
    ] : [
      { label: '訓練類別', render: row => formatTrainingCategory(row.category) },
      { key: 'provider', label: '辦訓單位' }, { label: '訓練日期', render: row => formatDate(row.date) },
      { label: '實際時數', render: row => formatTrainingMinutes(row.trainingMinutes) },
      { label: '紀錄狀態', render: row => statusBadge(row.status) },
    ]),
    { label: '操作', render: row => actionGroup(
      canWrite() && button('編輯', () => editRecord(config, employees, state, load, alive, row), { variant: 'outline' }),
      button('版本歷程', () => openRecordHistory({ entity: config.entity, id: row.id, lookups: { employees: people }, isCurrent: () => alive() && body.isConnected }), { variant: 'outline' }),
      certification && button('附件', event => selectAttachments(row, event.currentTarget), { variant: 'outline' }),
      canWrite() && button(certification ? row.status === 'revoked' ? '恢復有效' : '撤銷' : row.status === 'cancelled' ? '恢復完成' : '取消紀錄', () => changeRecordStatus(config, row, load, alive), { variant: 'ghost' }),
    ) },
  ];
  const load = async () => {
    if (!alive()) return;
    closeAttachments();
    const request = ++sequence;
    controller?.abort(); controller = new AbortController();
    dateError.hidden = true;
    asOfControl?.removeAttribute('aria-invalid');
    body.replaceChildren(el('p', { class: 'loading', role: 'status' }, '正在讀取資料…')); footer.replaceChildren();
    const params = new URLSearchParams({ page: String(state.page), pageSize: String(PAGE_SIZE) });
    for (const key of ['q', 'employeeId', 'status']) if (state[key]) params.set(key, state[key]);
    if (!certification && state.category) params.set('category', state.category);
    if (certification) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(state.asOf)) {
        dateError.textContent = '請選擇有效的效期基準日。'; dateError.hidden = false;
        asOfControl?.setAttribute('aria-invalid', 'true');
        body.replaceChildren(); return;
      }
      params.set('asOf', state.asOf);
      if (state.expiry) params.set('expiry', state.expiry);
    }
    try {
      const data = await api(`/api/${config.entity}?${params}`, { signal: controller.signal });
      if (!alive() || request !== sequence) return;
      if (state.page > 1 && !data.items.length) { state.page = Math.max(1, Math.ceil(data.total / PAGE_SIZE)); return load(); }
      const hasFilters = state.q || state.employeeId || state.status || state.expiry || state.category;
      body.replaceChildren(table(columns(), data.items, { caption: config.title, emptyText: hasFilters ? '沒有符合條件的紀錄，請調整篩選。' : `尚無${config.noun}紀錄。` }));
      footer.replaceChildren(pagination({ page: data.page, pageSize: data.pageSize, total: data.total, onChange: next => { state.page = next; void load(); } }));
    } catch (error) {
      if (!alive() || request !== sequence || error.name === 'AbortError') return;
      if (certification && error.fields?.asOf) {
        dateError.textContent = `效期基準日：${error.fields.asOf}，請調整日期後重試。`; dateError.hidden = false;
        asOfControl?.setAttribute('aria-invalid', 'true');
        body.replaceChildren(); return;
      }
      body.replaceChildren(errorState(error, load));
    }
  };
  const changeFilter = (key, value) => { state[key] = value; state.page = 1; void load(); };
  const toolbar = el('div', { class: 'toolbar' }, searchBox({
    value: state.q, label: `搜尋${config.noun}`, placeholder: certification ? '搜尋證照名稱、編號或發證單位' : '搜尋課程名稱或辦訓單位', onSearch: value => changeFilter('q', value),
  }));
  if (getContext().role !== 'caregiver') toolbar.append(selectFilter('員工篩選', [{ value: '', label: '全部員工' }, ...employees.map(employee => ({ value: employee.id, label: `${employee.name} · ${employee.employeeNo}` }))], state.employeeId, value => changeFilter('employeeId', value)));
  toolbar.append(selectFilter('紀錄狀態', [{ value: '', label: '全部狀態' }, ...config.statuses.map(value => ({ value, label: recordStatuses[value] }))], state.status, value => changeFilter('status', value)));
  if (!certification) toolbar.append(selectFilter('訓練類別篩選', [{ value: '', label: '全部類別' }, ...choices(categories)], state.category, value => changeFilter('category', value)));
  if (certification) {
    toolbar.append(selectFilter('效期狀態', [{ value: '', label: '全部效期' }, ...choices(expiryLabels)], state.expiry, value => changeFilter('expiry', value)));
    asOfControl = el('input', { type: 'date', value: state.asOf, 'aria-label': '效期基準日', 'aria-describedby': dateError.id });
    asOfControl.addEventListener('change', () => changeFilter('asOf', asOfControl.value));
    toolbar.append(el('label', { class: 'filter-field' }, el('span', {}, '效期基準日'), asOfControl));
  }
  const headerActions = canWrite() ? [button(`新增${config.noun}`, () => editRecord(config, employees, state, load, alive), { disabled: !employees.length, title: employees.length ? undefined : '請先建立員工' })] : [];
  container.replaceChildren(pageHeader(config.title, certification ? '保存證照與發證資料，依基準日查詢效期。' : '保存實際完成的課程與時數，查閱歷次變更。', headerActions),
    el('aside', { class: 'notice', role: 'note' }, certification
      ? '效期以所選基準日計算，預設為臺北今天。當日到期至 30 天內列為即將到期，早於基準日為已到期；日期留空只表示未填到期日。撤銷紀錄不顯示到期警示。效期提示不代表資格核定，也不自動限制排班。'
      : '時數以整數分鐘保存，畫面顯示實際小時與分鐘。這是訓練紀錄，不等同法定積分。'),
    ...(!employees.length ? [el('p', { class: 'muted' }, '目前尚無可選員工，請先到員工管理建立資料。')] : []),
    ...(getContext().role === 'caregiver' ? [el('p', { class: 'muted' }, '目前只顯示您本人的紀錄；如需更正，請聯絡機構管理者或督導。')] : []),
    toolbar, dateError, ...(certification ? [attachmentHost] : []), body, footer);
  await load();
}

export async function renderPersonnel(route, container) {
  if (!routeConfig[route]) return false;
  const token = ++generation, identity = contextIdentity(), hash = window.location.hash;
  const stamp = `personnel:${token}:${crypto.randomUUID()}`;
  container.dataset.renderVersion = stamp;
  const alive = () => token === generation && identity === contextIdentity() && hash === window.location.hash && container.isConnected && container.dataset.renderVersion === stamp;
  if (!['admin', 'supervisor', 'caregiver'].includes(getContext().role)) {
    const error = new Error('目前角色無法存取員工證照與訓練紀錄。'); error.status = 403;
    container.replaceChildren(errorState(error, () => renderPersonnel(route, container))); return true;
  }
  container.replaceChildren(el('p', { class: 'loading', role: 'status' }, '正在讀取頁面…'));
  try { await renderList(route, container, alive); }
  catch (error) { if (alive()) container.replaceChildren(errorState(error, () => renderPersonnel(route, container))); }
  return true;
}
