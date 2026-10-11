import { api, el, button, badge, openForm, openDetails, confirmAction, toast, today, getContext, searchBox, pagination, errorState, fetchAll } from '../ui.js';
import { CASE_CONTACT_FOOTPRINT_PROFILE as profile, CASE_CONTACT_FOOTPRINT_STATUSES as statuses, createCaseContactFootprintEditor, assertCaseContactFootprintItem, confirmCaseContactFootprintList, projectCaseContactFootprintCaseLookups } from '../data/case-contact-footprint-editor.js';
import { openRecordHistory } from './history.js';

const entity = 'case-contact-footprints', identity = () => { const ctx = getContext(); return JSON.stringify([ctx.user?.id, ctx.organizationId || ctx.orgId, ctx.role, ctx.user?.employeeId]); }, statusLabel = status => statuses.find(item => item.value === status)?.label || '狀態未確認';
/** Candidate case-local island. All dialog/form/focus/dirty owners remain ui.js. */
export function createCaseContactFootprintPanel({ caseRecord, isCurrent = () => true }) {
  const context = getContext(), orgId = context.organizationId || context.orgId, caseId = caseRecord?.id;
  if (!['admin', 'supervisor'].includes(context.role) || typeof caseId !== 'string' || !caseId.trim() || caseId !== caseId.trim() || caseRecord.orgId !== orgId) throw new Error('人工接觸足跡權限或個案範圍未確認。');
  const captured = identity(), hash = window.location.hash, heading = 'footprint-' + crypto.randomUUID(), state = { q: '', date: '', status: '', page: 1 }, results = el('div', { class: 'contacts-list' }), footer = el('div'), actions = el('div', { class: 'actions' });
  const element = el('section', { class: 'panel', 'aria-labelledby': heading, 'data-case-contact-footprints': entity }, el('div', { class: 'section-heading' }, el('h2', { id: heading }, profile.title), actions), el('p', { class: 'muted small' }, profile.description));
  let invalidated = false, sequence = 0, controller, observer, cases = [];
  const current = () => !invalidated && isCurrent() && element.isConnected && context === getContext() && captured === identity() && hash === window.location.hash && caseRecord.id === caseId && caseRecord.orgId === orgId;
  const invalidate = () => { if (invalidated || current()) return; invalidated = true; controller?.abort(); element.replaceChildren(); observer?.disconnect(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate); };
  const observe = () => { if (observer) return; observer = new MutationObserver(invalidate); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] }); window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate); };
  const aliveFor = trigger => () => current() && trigger.isConnected;
  const formFor = item => createCaseContactFootprintEditor({ existing: item || null, caseId, orgId, defaultDate: today(), cases });
  const refreshAfter = outcome => { outcome.then(saved => { if (saved && current()) void load(); }); return outcome; };
  const action = (label, handler) => { const trigger = button(label, () => { if (aliveFor(trigger)()) return Promise.resolve().then(() => handler(trigger)).catch(error => { if (aliveFor(trigger)() && error.name !== 'AbortError') toast(error.message, 'error'); }); }, { variant: 'secondary' }); return trigger; };
  function edit(item = null, trigger) {
    const alive = trigger ? aliveFor(trigger) : current; if (!alive()) return; const editor = formFor(item), keys = new Map();
    return refreshAfter(openForm({ title: `${item ? '編輯' : '新增'}${profile.singular}`, fields: editor.fields, initial: editor.initial, isCurrent: alive,
      onChange: (values, helpers) => { for (const field of editor.fields) if (!field.name.endsWith('Intent')) helpers.setDisabled(field.name, !editor.enabled(field.name, values)); },
      onSubmit: async (values, { signal, isCurrent: formCurrent }) => {
        const payload = editor.buildPayload(values); if (item && !Object.keys(payload).length) { if (formCurrent()) toast('接觸足跡沒有變更。', 'info'); return; }
        const signature = JSON.stringify(payload); if (!keys.has(signature)) keys.set(signature, crypto.randomUUID()); let response;
        try { response = await api(`/api/${entity}${item ? '/' + encodeURIComponent(item.id) : ''}`, { method: item ? 'PATCH' : 'POST', body: item ? { ...payload, version: item.version } : payload, signal, ...(!item ? { headers: { 'Idempotency-Key': keys.get(signature) } } : {}) }); } catch (error) { if (error.status === 409) error.message += ' 請保留輸入，關閉表單後重新讀取目前紀錄再修改。'; throw error; }
        if (!formCurrent()) return; editor.confirm(response, payload); toast(`${profile.singular}已${item ? '更新' : '新增'}。`, 'success');
      } }));
  }
  function transition(item, trigger) {
    const alive = aliveFor(trigger), editor = formFor(item), restoring = item.status === 'inactive', status = restoring ? 'active' : 'inactive', verb = restoring ? '恢復使用' : '停用', payload = { status };
    return refreshAfter(confirmAction({ title: `${verb}這筆${profile.singular}？`, confirmLabel: `確認${verb}`, danger: !restoring, isCurrent: alive, message: '只改紀錄狀態；原文與版本歷程保留，不代表通報或健康判讀。', onConfirm: async ({ signal, isCurrent: actionCurrent }) => {
      const response = await api(`/api/${entity}/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: { version: item.version, ...payload }, signal }); if (!actionCurrent()) return; editor.confirm(response, payload); toast(`${profile.singular}已${verb}。`, 'success');
    } }));
  }
  function details(item, trigger) {
    return openDetails({ title: '人工接觸足跡詳情', wide: true, guardedRead: true, isCurrent: aliveFor(trigger), load: async (signal, helpers) => {
      const response = await api(`/api/${entity}/${encodeURIComponent(item.id)}`, { signal }); if (!helpers.isCurrent()) return el('div'); const fresh = assertCaseContactFootprintItem(response?.item, { caseId, orgId, id: item.id });
      return el('div', {}, el('p', { class: 'notice' }, profile.description), el('dl', { class: 'detail-grid' }, profile.fields.map(key => el('div', {}, el('dt', {}, profile.labels[key]), el('dd', { class: 'pre-wrap' }, key === 'status' ? statusLabel(fresh[key]) : key === 'relatedCaseId' ? fresh[key] ? cases.find(record => record.id === fresh[key])?.name || '名稱未取得' : '未提供' : fresh[key] || '未提供')), ), el('div', {}, el('dt', {}, '保存版次'), el('dd', {}, String(fresh.version)))));
    } });
  }
  function card(item) {
    const status = badge(item.status); status.textContent = statusLabel(item.status);
    return el('article', { class: 'contact-card', 'data-case-contact-footprint-id': item.id, 'aria-label': '接觸足跡：' + item.date + ' ' + item.location }, el('div', { class: 'section-heading' }, el('h3', { class: 'pre-wrap' }, item.date + (item.time ? ' ' + item.time : '（時間未提供）') + ' · ' + item.location), status),
      el('dl', { class: 'contact-fields' }, ['contactDescription', 'relatedCaseId', 'source'].map(key => el('div', {}, el('dt', {}, profile.labels[key]), el('dd', { class: 'pre-wrap' }, key === 'relatedCaseId' ? item[key] ? cases.find(record => record.id === item[key])?.name || '名稱未取得' : '未提供' : item[key].length > 160 ? item[key].slice(0, 160) + '…（詳情保留全文）' : item[key] || '未提供')))),
      el('div', { class: 'actions' }, action('查看詳情', trigger => details(item, trigger)), action('版本歷程', trigger => openRecordHistory({ entity, id: item.id, lookups: { cases: new Map(cases.map(record => [record.id, record])) }, isCurrent: aliveFor(trigger) })), action('編輯', trigger => edit(item, trigger)), action(item.status === 'inactive' ? '恢復使用' : '停用', trigger => transition(item, trigger))));
  }
  const changed = (key, value) => { if (current()) { state[key] = value; state.page = 1; void load(); } }, search = searchBox({ label: '人工接觸足跡搜尋', placeholder: '搜尋人工保存的文字', onSearch: value => changed('q', value) }); search.querySelector('input').maxLength = 200;
  const date = el('input', { type: 'date', 'aria-label': '人工接觸足跡日期篩選', onchange: event => changed('date', event.target.value) }), status = el('select', { 'aria-label': '人工接觸足跡狀態篩選', onchange: event => changed('status', event.target.value) }, el('option', { value: '' }, '全部狀態'), statuses.map(option => el('option', { value: option.value }, option.label)));
  actions.append(button('新增接觸足跡', () => edit()), button('重新讀取', () => load(), { variant: 'secondary' })); element.append(el('div', { class: 'toolbar' }, search, el('label', { class: 'field' }, el('span', {}, '日期'), date), button('清除日期', () => { date.value = ''; changed('date', ''); date.focus(); }, { variant: 'ghost' }), el('label', { class: 'field' }, el('span', {}, '紀錄狀態'), status)), results, footer);
  async function load() {
    if (!current()) return; observe(); controller?.abort(); controller = new AbortController(); const requestSequence = ++sequence, requested = { ...state, pageSize: 25, caseId, orgId };
    results.setAttribute('aria-busy', 'true'); results.replaceChildren(el('p', { role: 'status' }, '正在讀取人工接觸足跡…')); footer.replaceChildren(); const params = new URLSearchParams({ caseId, page: String(state.page), pageSize: '25' }); for (const key of ['q', 'date', 'status']) if (state[key]) params.set(key, state[key]);
    try {
      const [response, records] = await Promise.all([api(`/api/${entity}?${params}`, { signal: controller.signal }), fetchAll('cases')]); if (!current() || requestSequence !== sequence || controller.signal.aborted) return; confirmCaseContactFootprintList(response, requested);
      const projectedCases = projectCaseContactFootprintCaseLookups(records, { orgId }); createCaseContactFootprintEditor({ caseId, orgId, cases: projectedCases }); if (!projectedCases.some(item => item.id === caseId)) throw new Error('所屬個案目前不可讀取。'); cases = projectedCases;
      const lastPage = Math.max(1, Math.ceil(response.total / 25)); if (state.page > lastPage) { state.page = lastPage; return load(); }
      results.replaceChildren(...(response.items.length ? response.items.map(card) : [el('div', { class: 'empty-state', role: 'status' }, '尚無符合條件的人工接觸足跡。')])); results.setAttribute('aria-busy', 'false'); footer.replaceChildren(pagination({ page: response.page, pageSize: 25, total: response.total, onChange: page => { if (current()) { state.page = page; void load(); } } }));
    } catch (error) { if (error.name === 'AbortError' || !current() || requestSequence !== sequence) return; results.setAttribute('aria-busy', 'false'); results.replaceChildren(errorState(error, load)); }
  }
  return { element, load };
}
