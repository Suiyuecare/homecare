import { api, el, button, table, openForm, openDetails, confirmAction, toast, getContext, searchBox, pagination, errorState, formatMoney } from '../ui.js';
import { financialOutputActions } from './financial-outputs.js';
import { openRecordHistory } from './history.js';
import { PAYROLL_STATEMENT_STATUSES, PAYROLL_LINE_KINDS, createPayrollStatementEditor, assertPayrollStatement, confirmPayrollStatementList, confirmPayrollTransition, payrollSummary } from '../data/payroll-statement-editor.js';

const entity = 'payroll-statements';
const identity = () => { const context = getContext(); return JSON.stringify([context.user?.id, context.organizationId || context.orgId, context.role, context.user?.employeeId]); };
const statusLabel = status => PAYROLL_STATEMENT_STATUSES.find(item => item.value === status)?.label || '狀態未確認';
const conflict = error => { if (error.status === 409) error.message += ' 請保留輸入，關閉表單並重新讀取目前結算後再操作。'; return error; };
function summaryNode(summary) {
  return el('dl', { class: 'detail-grid' }, [['加項合計', summary.earningCents], ['減項合計', summary.deductionCents], ['人工核定淨額', summary.netCents]].map(([label, cents]) => el('div', {}, el('dt', {}, label), el('dd', {}, formatMoney(cents)))));
}

/** Local-only manual settlement workflow; shared controls own modal/focus/dirty/busy semantics. */
export async function mountPayrollStatements(container, { isCurrent = () => true } = {}) {
  const context = getContext(), fingerprint = identity(), hash = window.location.hash, orgId = context.organizationId || context.orgId;
  if (!['admin', 'finance'].includes(context.role)) { container.replaceChildren(el('p', { class: 'notice', role: 'alert' }, '僅管理者或財務可使用人工薪資結算。')); return; }
  const state = { page: 1, q: '', employeeId: '', month: '', status: '' };
  const results = el('div'), footer = el('div'), toolbar = el('div', { class: 'toolbar' }), topActions = el('div', { class: 'actions' });
  let invalidated = false, sequence = 0, controller, employeeController, observer, employees = [];
  const current = () => !invalidated && isCurrent() && container.isConnected && getContext() === context && identity() === fingerprint && window.location.hash === hash;
  const invalidate = () => {
    if (invalidated || current()) return;
    invalidated = true; controller?.abort(); employeeController?.abort(); container.replaceChildren(); observer?.disconnect(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate);
  };
  const actionButton = (label, handler) => { const trigger = button(label, () => { if (current() && trigger.isConnected) return handler(trigger); }, { variant: 'secondary' }); return trigger; };
  const rowCurrent = trigger => () => current() && trigger.isConnected;
  const lookups = () => ({ employees: new Map(employees.map(employee => [employee.id, employee])) });
  async function read(item, signal) {
    const response = await api(`/api/${entity}/${encodeURIComponent(item.id)}`, { signal });
    return assertPayrollStatement(response?.item, { orgId, id: item.id });
  }
  function details(item, trigger) {
    return openDetails({ title: '人工薪資結算明細', wide: true, guardedRead: true, loadingText: '正在讀取薪資結算…', isCurrent: rowCurrent(trigger),
      load: async (signal, helpers) => {
        const fresh = await read(item, signal); if (!helpers.isCurrent()) return el('div');
        return el('div', {}, el('p', { class: 'notice' }, '這是人工核定的本機薪資結算紀錄，關帳不代表已付款。'),
          el('dl', { class: 'detail-grid' }, [['結算編號', fresh.number], ['薪資月份', fresh.month], ['建立時員工', `${fresh.employeeSnapshot.employeeNo} ${fresh.employeeSnapshot.name}`], ['狀態', statusLabel(fresh.status)], ['人工核定依據', fresh.sourceReference || '未提供'], ['備註', fresh.note || '未提供'], ['保存版次', String(fresh.version)]].map(([label, value]) => el('div', {}, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value)))),
          table([{ label: '人工明細名稱', key: 'label' }, { label: '加項／減項', render: line => PAYROLL_LINE_KINDS.find(kind => kind.value === line.kind).label }, { label: '金額', render: line => formatMoney(line.amountCents) }], fresh.lineItems, { caption: '保存的人工核定明細' }), summaryNode(fresh.summary), financialOutputActions({ kind: 'payroll', record: fresh, signal, isCurrent: helpers.isCurrent }));
      },
    });
  }
  function edit(item = null, trigger) {
    const alive = trigger ? rowCurrent(trigger) : current;
    if (!alive()) return;
    const editor = createPayrollStatementEditor({ existing: item, orgId, employees }), keys = new Map();
    let previousCount = editor.initial.rowCount, formNode;
    const syncForm = (values, helpers) => {
      if (values.rowCount !== previousCount) { helpers.setValue('confirmRemove', false); values.confirmRemove = false; previousCount = values.rowCount; }
      for (const field of editor.fields) {
        const match = field.name.match(/^(label|kind|amount)(\d+)$/);
        const disabled = !editor.enabled(field.name, values) || Boolean(match && Number(match[2]) > values.rowCount);
        if (!field.name.endsWith('Intent')) helpers.setDisabled(field.name, disabled);
        if (match) helpers.setHidden(field.name, disabled);
      }
      queueMicrotask(() => {
        if (!alive()) return;
        formNode ||= [...document.querySelectorAll('dialog[open] form')].find(form => form.querySelector('[name="rowCount"]') && form.querySelector('[name="employeeId"]') && form.querySelector('[name="number"]'));
        if (!formNode?.isConnected) return;
        let preview = formNode.querySelector('[data-payroll-draft-summary]');
        if (!preview) { preview = el('div', { class: 'notice field-wide', 'data-payroll-draft-summary': true, role: 'status' }); formNode.querySelector('.form-grid').append(preview); }
        try {
          const payload = editor.buildPayload(values), items = payload.lineItems || item?.lineItems;
          preview.replaceChildren(items ? summaryNode(payrollSummary(items)) : el('p', {}, '請完成明細後核對加項、減項及淨額。'));
        } catch { preview.replaceChildren(el('p', {}, '請完成明細後核對加項、減項及淨額；縮減已填明細須明確確認。')); }
      });
    };
    const outcome = openForm({ title: item ? '編輯人工薪資草稿' : '新增人工薪資草稿', fields: editor.fields, initial: editor.initial, isCurrent: alive, onChange: syncForm,
      onSubmit: async (values, { signal, isCurrent: formCurrent }) => {
        if (!formCurrent()) return;
        const payload = editor.buildPayload(values);
        if (item && !Object.keys(payload).length) { toast('薪資草稿沒有變更。', 'info'); return; }
        const signature = JSON.stringify(payload); if (!item && !keys.has(signature)) keys.set(signature, crypto.randomUUID());
        let response;
        try { response = await api(`/api/${entity}${item ? '/' + encodeURIComponent(item.id) : ''}`, { method: item ? 'PATCH' : 'POST', body: item ? { ...payload, version: item.version } : payload, signal,
          ...(!item ? { headers: { 'Idempotency-Key': keys.get(signature) } } : {}) }); } catch (error) { throw conflict(error); }
        if (!formCurrent()) return;
        editor.confirm(response?.item, payload);
        toast(item ? '人工薪資草稿已更新。' : '人工薪資草稿已新增。', 'success');
      },
    });
    outcome.then(saved => { if (saved && current()) void load(); }); return outcome;
  }
  function transition(item, status, trigger) {
    const alive = rowCurrent(trigger), verb = status === 'reviewed' ? '覆核' : status === 'closed' ? '關帳' : '取消';
    const commit = async (payload, { signal, isCurrent: actionCurrent }) => {
      let response;
      try { response = await api(`/api/${entity}/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: { ...payload, version: item.version }, signal }); } catch (error) { throw conflict(error); }
      if (!actionCurrent()) return;
      confirmPayrollTransition(response?.item, item, payload, orgId); toast(`人工薪資結算已${verb}。`, 'success');
    };
    if (status === 'voided') {
      const outcome = openForm({ title: `確認取消薪資結算 ${item.number}`, isCurrent: alive, submitLabel: '確認取消薪資結算', initial: { note: '' },
      fields: [{ name: 'note', label: '本次取消原因', type: 'textarea', required: true, maxLength: 10000, help: '取消後不能再修改；明細與版本歷程保留。請填寫本次原因。' }],
      onSubmit: (values, helpers) => { const note = typeof values.note === 'string' ? values.note : ''; if (!note.trim() || note.length > 10000) { const error = new Error('本次取消原因必填且最多10000字。'); error.fields = { note: error.message }; throw error; } return commit({ status, note }, helpers); },
      }); outcome.then(saved => { if (saved && current()) void load(); }); return outcome;
    }
    const outcome = confirmAction({ title: `確認${verb}薪資結算 ${item.number}？`, confirmLabel: `確認${verb}`, isCurrent: alive,
      message: status === 'reviewed' ? `核定淨額 ${formatMoney(item.summary.netCents)}。覆核後金額、明細與核定依據將鎖定，只能關帳或取消。` : '關帳後這筆人工結算不能再修改；這項操作不會執行銀行付款。',
      onConfirm: helpers => commit({ status }, helpers),
    });
    outcome.then(saved => { if (saved && current()) void load(); }); return outcome;
  }
  function rowActions(item) {
    const controls = el('div', { class: 'actions row-actions' });
    controls.append(actionButton('查看明細', trigger => details(item, trigger)), actionButton('版本歷程', trigger => openRecordHistory({ entity, id: item.id, lookups: lookups(), isCurrent: rowCurrent(trigger) })));
    if (item.status === 'draft') {
      controls.append(actionButton('編輯草稿', trigger => edit(item, trigger)));
      const review = actionButton('覆核', trigger => transition(item, 'reviewed', trigger)); review.disabled = !item.sourceReference.trim();
      if (review.disabled) review.title = '請先編輯草稿，填寫人工核定依據。'; controls.append(review);
      if (review.disabled) controls.append(el('span', { class: 'muted small' }, '填寫核定依據後可覆核'));
    }
    if (item.status === 'reviewed') controls.append(actionButton('關帳', trigger => transition(item, 'closed', trigger)));
    if (['draft', 'reviewed'].includes(item.status)) controls.append(actionButton('取消結算', trigger => transition(item, 'voided', trigger)));
    return controls;
  }
  const change = (key, value) => { if (current()) { state[key] = value; state.page = 1; void load(); } };
  const search = searchBox({ label: '薪資結算搜尋', placeholder: '搜尋編號、姓名或人工明細', onSearch: value => change('q', value) }); search.querySelector('input').maxLength = 200;
  const employeeFilter = el('select', { 'aria-label': '薪資員工篩選', onchange: event => change('employeeId', event.target.value) }, el('option', { value: '' }, '全部員工'));
  const month = el('input', { type: 'month', 'aria-label': '薪資月份篩選', onchange: event => change('month', event.target.value) });
  const status = el('select', { 'aria-label': '薪資結算狀態篩選', onchange: event => change('status', event.target.value) }, el('option', { value: '' }, '全部狀態'), PAYROLL_STATEMENT_STATUSES.map(item => el('option', { value: item.value }, item.label)));
  const newButton = button('新增人工薪資草稿', () => edit(), { disabled: true }); topActions.append(newButton, button('重新讀取', () => load(), { variant: 'secondary' }));
  toolbar.append(search, el('label', { class: 'field' }, el('span', {}, '員工'), employeeFilter), el('label', { class: 'field' }, el('span', {}, '月份'), month), button('清除月份', () => { month.value = ''; change('month', ''); month.focus(); }, { variant: 'ghost' }), el('label', { class: 'field' }, el('span', {}, '狀態'), status));
  container.replaceChildren(el('div', { class: 'page-header' }, el('div', {}, el('h1', {}, '人工薪資結算'), el('p', { class: 'muted' }, '人工輸入核定加減項、覆核與關帳，保留員工快照及每個版本。')), topActions),
    el('p', { class: 'notice' }, '此流程不自動計算薪資、保險、稅費或執行付款；請依已核定的依據人工輸入。'), el('section', { class: 'panel' }, toolbar, results, footer));
  observer = new MutationObserver(invalidate); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
  window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
  async function loadEmployees() {
    employeeController?.abort(); employeeController = new AbortController();
    const items = []; let page = 1, total = 0;
    do {
      const response = await api(`/api/employees?page=${page}&pageSize=100`, { signal: employeeController.signal }); if (!current()) return;
      if (!Array.isArray(response.items) || !Number.isSafeInteger(response.total) || response.total < 0 || response.page !== page || response.pageSize !== 100 || response.items.length > 100) throw new Error('員工選單回應未確認。');
      if (response.items.some(employee => employee.orgId !== orgId || typeof employee.id !== 'string' || typeof employee.name !== 'string' || typeof employee.employeeNo !== 'string')) throw new Error('員工選單範圍未確認。');
      total = response.total; items.push(...response.items); page++;
      if (page > 100) throw new Error('員工選單超出本機上限，請先限制機構資料。');
    } while (items.length < total);
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('員工選單有重複識別碼。');
    employees = items; employeeFilter.append(...items.map(employee => el('option', { value: employee.id }, `${employee.employeeNo} ${employee.name}`))); newButton.disabled = items.length === 0;
  }
  async function load() {
    if (!current()) return;
    controller?.abort(); controller = new AbortController(); const requestSequence = ++sequence, requested = { ...state, orgId };
    results.setAttribute('aria-busy', 'true'); results.replaceChildren(el('p', { class: 'loading', role: 'status' }, '正在讀取薪資結算…')); footer.replaceChildren();
    const params = new URLSearchParams({ page: String(state.page), pageSize: '25' }); for (const key of ['q', 'month', 'employeeId', 'status']) if (state[key]) params.set(key, state[key]);
    try {
      const response = await api(`/api/${entity}?${params}`, { signal: controller.signal }); if (!current() || requestSequence !== sequence) return;
      confirmPayrollStatementList(response, requested);
      const lastPage = Math.max(1, Math.ceil(response.total / 25)); if (state.page > lastPage) { state.page = lastPage; return load(); }
      results.replaceChildren(response.items.length ? table([
        { label: '結算編號', key: 'number' }, { label: '月份', key: 'month' }, { label: '建立時員工', render: item => `${item.employeeSnapshot.employeeNo} ${item.employeeSnapshot.name}` },
        { label: '人工核定淨額', render: item => formatMoney(item.summary.netCents) }, { label: '狀態', render: item => statusLabel(item.status) }, { label: '操作', render: rowActions },
      ], response.items, { caption: '人工薪資結算清單' }) : el('div', { class: 'empty-state', role: 'status' }, state.q || state.month || state.employeeId || state.status ? '找不到符合條件的人工薪資結算。' : '尚未建立人工薪資结算。'));
      results.setAttribute('aria-busy', 'false'); footer.replaceChildren(pagination({ page: state.page, pageSize: 25, total: response.total, onChange: page => { if (current()) { state.page = page; void load(); } } }));
    } catch (error) { if (error.name === 'AbortError' || !current() || requestSequence !== sequence) return; results.setAttribute('aria-busy', 'false'); results.replaceChildren(errorState(error, load)); }
  }
  try { await loadEmployees(); } catch (error) { if (current()) results.replaceChildren(errorState(error, async () => { await loadEmployees(); await load(); })); return; }
  await load();
}
