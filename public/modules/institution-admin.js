import { api, el, pageHeader, table, badge, button, openForm, confirmAction, openDetails,
  toast, formatDate, today, getContext, searchBox, pagination, errorState } from '../ui.js';
import { openRecordHistory } from './history.js';
import { createInstitutionAdminPayloadBuilder } from '../data/institution-admin-editor.js';

const eventCategories = { meeting: '會議', training: '訓練', administration: '行政', other: '其他' };
const complaintCategories = { service_quality: '服務品質', personnel: '人員', safety: '安全', fees: '費用', other: '其他' };
const eventStatuses = { active: '啟用', cancelled: '已取消' };
const complaintStatuses = { received: '已受理', in_progress: '處理中', closed: '已結案', cancelled: '已取消' };
const eventFields = ['title', 'date', 'startTime', 'endTime', 'category', 'location', 'note', 'status'];
const complaintFields = ['title', 'receivedDate', 'category', 'content', 'receiverEmployeeId', 'responsibleEmployeeId',
  'caseId', 'employeeId', 'handlingLog', 'resolution', 'closedDate', 'status'];
const fieldLabels = { title: '標題', date: '日期', startTime: '開始時間', endTime: '結束時間', category: '分類', location: '地點', note: '備註',
  receivedDate: '受理日期', content: '申訴內容', receiverEmployeeId: '受理員工', responsibleEmployeeId: '負責員工', caseId: '相關個案', employeeId: '相關員工',
  handlingLog: '處理紀錄', resolution: '處理結果／取消原因', closedDate: '結案日期', status: '狀態' };
const options = values => Object.entries(values).map(([value, label]) => ({ value, label }));
const identity = () => { const ctx = getContext(); return JSON.stringify([ctx.user?.id, ctx.organizationId || ctx.orgId, ctx.role, ctx.user?.employeeId || ctx.employeeId || '']); };
const validDate = value => typeof value === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const statusBadge = (value, statuses) => { const node = badge(value); node.textContent = statuses[value] || value; return node; };
const org = () => getContext().organizationId || getContext().orgId;
const editable = () => ['admin', 'supervisor'].includes(getContext().role);
const notice = message => el('p', { class: 'notice', role: 'note' }, message);

function actionButton(label, action, variant = 'outline') {
  let busy = false;
  const trigger = button(label, async () => {
    if (busy) return;
    busy = true; trigger.setAttribute('aria-disabled', 'true'); trigger.setAttribute('aria-busy', 'true');
    try { await action(trigger); }
    catch (error) { if (trigger.isConnected && error.name !== 'AbortError') toast(error.message || '操作失敗，請重試。', 'error'); }
    finally { busy = false; trigger.removeAttribute('aria-disabled'); trigger.removeAttribute('aria-busy'); }
  }, { variant });
  return trigger;
}

function checkItem(result, { entity, id, orgId }) {
  const item = result?.item;
  const fields = entity === 'institution-events' ? eventFields : complaintFields;
  if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || (id && item.id !== id)
      || item.orgId !== orgId || !Number.isSafeInteger(item.version) || item.version < 1
      || fields.some(key => typeof item[key] !== 'string')) throw new Error('無法確認保存資料，請重新讀取。');
  const statuses = entity === 'institution-events' ? eventStatuses : complaintStatuses;
  const categories = entity === 'institution-events' ? eventCategories : complaintCategories;
  const date = entity === 'institution-events' ? item.date : item.receivedDate;
  if (!Object.hasOwn(statuses, item.status) || !Object.hasOwn(categories, item.category) || !validDate(date)
      || (item.closedDate && !validDate(item.closedDate))) throw new Error('保存的日期或狀態無法確認，請重新讀取。');
  return item;
}

function selectFilter(label, values, changed) {
  const id = `institution-filter-${crypto.randomUUID()}`;
  const control = el('select', { id, class: 'input' }, el('option', { value: '' }, `全部${label}`), options(values).map(o => el('option', { value: o.value }, o.label)));
  control.addEventListener('change', () => changed(control.value));
  return el('label', { class: 'filter-field', for: id }, el('span', {}, label), control);
}

async function referenceChoices(entity, signal, isCurrent) {
  const items = [];
  for (let page = 1; page <= 100; page++) {
    const result = await api(`/api/${entity}?page=${page}&pageSize=100`, { signal });
    if (!isCurrent()) throw new DOMException('操作已取消。', 'AbortError');
    if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0
        || result.items.some(item => item.orgId !== org() || typeof item.id !== 'string' || typeof item.name !== 'string'))
      throw new Error('無法確認同機構選項，請重新讀取。');
    items.push(...result.items);
    if (items.length >= result.total) return items;
    if (!result.items.length) throw new Error('選項資料不完整，請重新讀取。');
  }
  throw new Error('選項超過可選範圍，請縮小資料範圍。');
}

function descriptors(entity, item, lookups) {
  const field = (name, type = 'text', extra = {}) => ({ name, label: fieldLabels[name], type, ...extra });
  if (entity === 'institution-events') return [field('title', 'text', { required: true, maxLength: 200 }),
    field('date', 'date', { required: true }), field('startTime', 'time', { required: true }), field('endTime', 'time', { required: true }),
    field('category', 'select', { required: true, options: options(eventCategories) }), field('location', 'text', { maxLength: 300 }),
    field('note', 'textarea', { maxLength: 10000, help: '全機構四角色共讀，請勿填個案敏感內容。' }),
    ...(item ? [field('status', 'select', { required: true, options: options(eventStatuses) })] : [])];
  const people = lookups.employees.map(p => ({ value: p.id, label: `${p.name} · ${p.employeeNo}` }));
  const cases = lookups.cases.map(p => ({ value: p.id, label: `${p.name} · ${p.caseNo}` }));
  const transitions = { received: ['received', 'in_progress', 'cancelled'], in_progress: ['in_progress', 'closed', 'cancelled'], closed: ['closed'], cancelled: ['cancelled'] };
  return [field('title', 'text', { required: true, maxLength: 200 }), field('receivedDate', 'date', { required: true }),
    field('category', 'select', { required: true, options: options(complaintCategories) }), field('content', 'textarea', { required: true, maxLength: 10000 }),
    field('receiverEmployeeId', 'select', { required: true, options: people }), field('responsibleEmployeeId', 'select', { required: true, options: people }),
    field('caseId', 'select', { options: cases, placeholder: '未指定個案' }), field('employeeId', 'select', { options: people, placeholder: '未指定員工' }),
    field('handlingLog', 'textarea', { maxLength: 10000 }), field('resolution', 'textarea', { maxLength: 10000, help: '結案或取消時必填結果或原因。' }),
    field('closedDate', 'date', { help: '只有已結案填寫；不得早於受理日。' }),
    ...(item ? [field('status', 'select', { required: true, options: transitions[item.status].map(value => ({ value, label: complaintStatuses[value] })),
      help: '結案或取消後只能更正同狀態內容，不能重新開案。' })] : [])];
}

/** Thin route adapters reuse the established table/form/history/dialog owners. */
export const mountInstitutionEvents = (container, options) => mountInstitutionAdmin(container, 'institution-events', options);
export const mountComplaints = (container, options) => mountInstitutionAdmin(container, 'complaints', options);

export async function mountInstitutionAdmin(container, entity, { isCurrent = () => true } = {}) {
  const event = entity === 'institution-events';
  if (!event && entity !== 'complaints') throw new Error('不支援此機構行政入口。');
  const startedContext = getContext(), startedIdentity = identity(), startedHash = location.hash;
  const alive = () => container.isConnected && isCurrent() && getContext() === startedContext && identity() === startedIdentity && location.hash === startedHash;
  if ((!event && !editable()) || !['admin', 'supervisor', 'finance', 'caregiver'].includes(getContext().role)) {
    const error = new Error('您沒有此項機構行政操作權限。'); error.status = 403;
    container.replaceChildren(errorState(error)); return;
  }
  const statuses = event ? eventStatuses : complaintStatuses, categories = event ? eventCategories : complaintCategories;
  const title = event ? '機構行事曆' : '申訴案件管理', dateKey = event ? 'date' : 'receivedDate';
  const fields = event ? eventFields : complaintFields;
  let page = 1, query = '', status = '', category = '', date = '', sequence = 0, controller;
  const body = el('div', { class: 'list-content', 'aria-live': 'polite' }), footer = el('div', { class: 'list-footer' });
  const lookups = { employees: [], cases: [] };

  const details = (row, isCurrent) => openDetails({ title: `${title} · 查看資料`, wide: true, guardedRead: true, isCurrent, loadingText: '正在讀取目前完整資料…',
    load: async (signal, owner) => {
      const item = checkItem(await api(`/api/${entity}/${encodeURIComponent(row.id)}`, { signal }), { entity, id: row.id, orgId: org() });
      if (!isCurrent() || !owner.isCurrent()) throw new DOMException('操作已取消。', 'AbortError');
      const references = new Map();
      if (!event) {
        for (const key of ['receiverEmployeeId', 'responsibleEmployeeId', 'employeeId', 'caseId']) {
          if (!item[key]) continue;
          const kind = key === 'caseId' ? 'cases' : 'employees', identity = `${kind}/${item[key]}`;
          if (references.has(identity)) continue;
          try {
            const result = await api(`/api/${kind}/${encodeURIComponent(item[key])}`, { signal });
            if (!isCurrent() || !owner.isCurrent()) throw new DOMException('操作已取消。', 'AbortError');
            const reference = result?.item;
            if (!reference || reference.id !== item[key] || reference.orgId !== item.orgId || typeof reference.name !== 'string')
              throw new Error('名稱未確認');
            references.set(identity, reference.name ? `${reference.name}（目前保存名稱）` : '姓名尚未填寫');
          } catch (error) {
            if (signal.aborted || error.name === 'AbortError' || !isCurrent() || !owner.isCurrent()) throw new DOMException('操作已取消。', 'AbortError');
            references.set(identity, '目前名稱未確認；請重新讀取');
          }
        }
      }
      const list = el('dl', { class: 'detail-grid' });
      for (const key of fields) {
        const referenceKind = key === 'caseId' ? 'cases' : ['receiverEmployeeId', 'responsibleEmployeeId', 'employeeId'].includes(key) ? 'employees' : null;
        const value = key === 'status' ? statuses[item[key]] : key === 'category' ? categories[item[key]] : referenceKind && item[key]
          ? references.get(`${referenceKind}/${item[key]}`) : item[key] || '未填寫';
        list.append(el('div', { class: ['content', 'handlingLog', 'resolution', 'note'].includes(key) ? 'field-wide' : '' },
          el('dt', {}, fieldLabels[key]), el('dd', { class: 'pre-wrap' }, value)));
      }
      return el('section', {}, notice(`目前保存第 ${item.version} 版。受理人、負責人與實際保存操作者分開記錄；保存操作者請見版本歷程。`), list);
    } });

  const edit = async (row, trigger) => {
    if (!editable() || !alive()) return;
    const actionController = new AbortController();
    const actionCurrent = () => alive() && (!trigger || trigger.isConnected);
    const invalidate = () => { if (!actionCurrent()) actionController.abort(); };
    window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
    const observer = new MutationObserver(invalidate); observer.observe(document.body, { childList: true, subtree: true });
    try {
      let item;
      if (row) item = checkItem(await api(`/api/${entity}/${encodeURIComponent(row.id)}`, { signal: actionController.signal }), { entity, id: row.id, orgId: org() });
      if (!actionCurrent()) return;
      if (!event) {
        [lookups.employees, lookups.cases] = await Promise.all([referenceChoices('employees', actionController.signal, actionCurrent), referenceChoices('cases', actionController.signal, actionCurrent)]);
        if (!actionCurrent()) return;
        if (!lookups.employees.length) throw new Error('請先建立本機構員工，再指定受理及負責員工。');
      }
      const initial = item || (event ? { date: today(), category: 'other', location: '', note: '', status: 'active' }
        : { receivedDate: today(), category: 'other', caseId: '', employeeId: '', handlingLog: '', resolution: '', closedDate: '', status: 'received' });
      const formFields = descriptors(entity, item, lookups), key = crypto.randomUUID();
      const editor = createInstitutionAdminPayloadBuilder({ fields: formFields, initial, ...(item ? { existing: item } : {}) });
      let previousSubmission = null, submissionKey = key;
      const saved = await openForm({ title: `${item ? '編輯' : '新增'}${event ? '機構行事' : '申訴案件'}`, fields: formFields, initial, isCurrent: actionCurrent,
        onSubmit: async (values, owner) => {
          const payload = editor.buildPayload(values);
          if (item && !Object.keys(payload).length) return;
          if (item && payload.status && payload.status !== item.status) {
            const accepted = await confirmAction({ title: `將狀態改為${statuses[payload.status]}？`, message: event
              ? '機構行事會保留歷程，不更改班次、請假或薪資。'
              : '結案或取消後只能更正同狀態內容，不能重新開案；此操作不會對外通報。',
              confirmLabel: `改為${statuses[payload.status]}`, signal: owner.signal, isCurrent: owner.isCurrent,
            });
            if (!accepted) throw new Error('尚未確認狀態變更；輸入內容仍保留。');
          }
          const body = item ? { ...payload, version: item.version } : payload;
          const signature = JSON.stringify(body);
          if (previousSubmission !== null && previousSubmission !== signature) submissionKey = crypto.randomUUID();
          previousSubmission = signature;
          const result = await api(item ? `/api/${entity}/${encodeURIComponent(item.id)}` : `/api/${entity}`, {
            method: item ? 'PATCH' : 'POST', body, signal: owner.signal, headers: { 'Idempotency-Key': submissionKey },
          });
          if (!owner.isCurrent()) throw new DOMException('操作已取消，請重新讀取確認保存狀態。', 'AbortError');
          const confirmed = checkItem(result, { entity, id: item?.id, orgId: org() });
          if ((item && confirmed.version !== item.version + 1) || (!item && confirmed.version !== 1)
              || Object.entries(payload).some(([k, v]) => confirmed[k] !== v)
              || (item && fields.some(k => confirmed[k] !== (Object.hasOwn(payload, k) ? payload[k] : item[k]))))
            throw new Error('無法確認儲存結果；請保留輸入並重新讀取。');
        } });
      if (saved && alive()) { await load(); if (alive()) toast(`已儲存${event ? '機構行事' : '申訴案件'}`, 'success'); }
    } catch (error) { if (actionCurrent() && error.name !== 'AbortError') toast(error.message || '操作失敗，請重試。', 'error'); }
    finally { observer.disconnect(); actionController.abort(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate); }
  };

  const load = async () => {
    if (!alive()) return;
    const request = ++sequence; controller?.abort(); controller = new AbortController();
    body.dataset.renderVersion = `institution:${request}`;
    body.replaceChildren(el('p', { class: 'loading', role: 'status' }, '正在讀取資料…')); footer.replaceChildren();
    const params = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (query) params.set('q', query); if (status) params.set('status', status); if (category) params.set('category', category); if (date) params.set(dateKey, date);
    try {
      const result = await api(`/api/${entity}?${params}`, { signal: controller.signal });
      if (!alive() || request !== sequence) return;
      if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0 || result.page !== page || result.pageSize !== 25 || result.items.length > 25)
        throw new Error('無法確認查詢結果，請重新讀取。');
      for (const item of result.items) checkItem({ item }, { entity, orgId: org() });
      if (page > 1 && !result.items.length && result.total) { page = Math.ceil(result.total / 25); return load(); }
      body.replaceChildren(table([
        { label: event ? '日期／時段' : '受理日期', render: row => event ? `${formatDate(row.date)} ${row.startTime}–${row.endTime}` : formatDate(row.receivedDate) },
        { key: 'title', label: '標題' }, { label: '分類', render: row => categories[row.category] },
        { label: '狀態', render: row => statusBadge(row.status, statuses) },
        { label: '操作', render: row => {
          const actions = el('div', { class: 'actions row-actions' });
          actions.append(actionButton('查看資料', trigger => details(row, () => alive() && trigger.isConnected && request === sequence)));
          if (editable()) actions.append(actionButton('編輯', trigger => edit(row, trigger)));
          actions.append(actionButton('版本歷程', trigger => openRecordHistory({ entity, id: row.id, isCurrent: () => alive() && trigger.isConnected && request === sequence,
            lookups: { employees: new Map(lookups.employees.map(p => [p.id, p])), cases: new Map(lookups.cases.map(p => [p.id, p])) } })));
          return actions;
        } },
      ], result.items, { caption: title, emptyText: query || status || category || date ? '沒有符合條件的資料，請調整查詢。' : `目前尚無${event ? '機構行事' : '申訴案件'}。` }));
      footer.replaceChildren(pagination({ page, pageSize: 25, total: result.total, onChange: next => { if (alive()) { page = next; void load(); } } }));
    } catch (error) { if (alive() && request === sequence && error.name !== 'AbortError') body.replaceChildren(errorState(error, load)); }
  };

  const toolbar = el('div', { class: 'toolbar' }, searchBox({ label: `搜尋${title}`, placeholder: event ? '搜尋標題、地點或備註' : '搜尋標題、內容、處理紀錄或結果',
    onSearch: value => { if (alive()) { query = value; page = 1; void load(); } } }),
    selectFilter('狀態', statuses, value => { status = value; page = 1; void load(); }),
    selectFilter('分類', categories, value => { category = value; page = 1; void load(); }));
  toolbar.querySelector('input[type="search"]').maxLength = 200;
  const dateId = `institution-date-${crypto.randomUUID()}`, dateControl = el('input', { id: dateId, type: 'date', class: 'input' });
  dateControl.addEventListener('change', () => { date = dateControl.value; page = 1; void load(); });
  toolbar.append(el('label', { class: 'filter-field', for: dateId }, el('span', {}, event ? '日期' : '受理日期'), dateControl));
  const create = editable() ? actionButton(event ? '新增機構行事' : '受理申訴', trigger => edit(null, trigger), 'primary') : null;
  container.replaceChildren(pageHeader(title, event ? '全機構共同查看的人工行事安排' : '從受理、處理到結案，保留每次修改與實際操作者', create ? [create] : []),
    notice(event ? '全機構四角色共讀；請勿填個案敏感內容。行事不代表排班、出勤、請假、積分或薪資，不會自動發送提醒。'
      : '僅管理者與督導可查看。這裡記錄人工處理進度，不會對外通報或自動判定責任。'),
    el('section', { class: 'panel' }, toolbar, body, footer));
  const invalidate = () => {
    if (alive()) return;
    ++sequence; controller?.abort(); observer.disconnect();
    window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate);
  };
  const observer = new MutationObserver(invalidate); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
  window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
  await load();
}
