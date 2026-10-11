import { api, el, button, badge, openForm, openDetails, confirmAction, toast, today, getContext, searchBox, pagination, errorState } from '../ui.js';
import { CASE_HEALTH_PROFILES, CASE_HEALTH_STATUSES, createCaseHealthEditor, assertCaseHealthItem, confirmCaseHealthList, caseHealthText, caseHealthStatusLabel } from '../data/case-health-editor.js';
import { openRecordHistory } from './history.js';

const PAGE_SIZE = 25;
const identity = () => { const context = getContext(); return JSON.stringify([context.user?.id, context.organizationId || context.orgId, context.role, context.user?.employeeId]); };
const conflict = error => { if (error.status === 409) error.message += ' 請保留輸入，關閉表單並重新讀取目前紀錄後再修改。'; return error; };

/** Case-local islands; ui.js owns dialogs, forms, search, busy, focus and dirty state. */
export function createCaseHealthPanel({ entity, caseRecord, isCurrent = () => true }) {
  const profile = CASE_HEALTH_PROFILES[entity], context = getContext(), orgId = context.organizationId || context.orgId;
  if (!profile || !['admin', 'supervisor'].includes(context.role)) throw new Error('此角色無權查看個案健康紀錄。');
  const caseId = caseRecord?.id;
  if (typeof caseId !== 'string' || !caseId.trim() || caseId !== caseId.trim() || caseRecord.orgId !== orgId) throw new Error('個案健康紀錄範圍未確認。');
  const contextIdentity = identity(), hash = window.location.hash, titleId = `case-health-${crypto.randomUUID()}`;
  const state = { q: '', date: '', status: '', page: 1 };
  const results = el('div', { class: 'contacts-list', 'aria-busy': 'true' }), footer = el('div'), actions = el('div', { class: 'actions' });
  const element = el('section', { class: 'panel', 'aria-labelledby': titleId, 'data-case-health': entity },
    el('div', { class: 'section-heading' }, el('h2', { id: titleId }, profile.title), actions), el('p', { class: 'muted small' }, profile.description));
  let invalidated = false, sequence = 0, controller, observer;
  const current = () => !invalidated && isCurrent() && element.isConnected && context === getContext() && contextIdentity === identity() && hash === window.location.hash && caseRecord.id === caseId && caseRecord.orgId === orgId;
  const invalidate = () => {
    if (invalidated || current()) return;
    invalidated = true; controller?.abort(); element.replaceChildren(); observer?.disconnect(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate);
  };
  const observe = () => {
    if (observer) return;
    observer = new MutationObserver(invalidate); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
    window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
  };
  const rowCurrent = trigger => () => current() && trigger.isConnected;
  const action = (label, handler) => { const trigger = button(label, () => { if (current() && trigger.isConnected) return handler(trigger); }, { variant: 'secondary' }); return trigger; };
  const editor = item => createCaseHealthEditor({ entity, existing: item, caseId, orgId, defaultDate: today() });
  function edit(item = null, trigger) {
    const alive = trigger ? rowCurrent(trigger) : current; if (!alive()) return;
    const form = editor(item), create = !item, keys = new Map();
    const outcome = openForm({ title: `${create ? '新增' : '編輯'}${profile.singular}`, initial: form.initial, fields: form.fields, isCurrent: alive,
      onChange: (values, helpers) => { for (const field of form.fields) if (!field.name.endsWith('Intent')) helpers.setDisabled(field.name, !form.enabled(field.name, values)); },
      onSubmit: async (values, { signal, isCurrent: formCurrent }) => {
        if (!formCurrent()) return;
        const payload = form.buildPayload(values);
        if (!create && !Object.keys(payload).length) { toast('健康紀錄沒有變更。', 'info'); return; }
        const signature = JSON.stringify(payload); if (create && !keys.has(signature)) keys.set(signature, crypto.randomUUID());
        let response;
        try { response = await api(`/api/${entity}${create ? '' : '/' + encodeURIComponent(item.id)}`, { method: create ? 'POST' : 'PATCH', body: create ? payload : { ...payload, version: item.version }, signal,
          ...(create ? { headers: { 'Idempotency-Key': keys.get(signature) } } : {}) }); } catch (error) { throw conflict(error); }
        if (!formCurrent()) return;
        form.confirm(response?.item, payload); toast(`${profile.singular}已${create ? '新增' : '更新'}。`, 'success');
      },
    });
    outcome.then(saved => { if (saved && current()) void load(); }); return outcome;
  }
  function changeStatus(item, trigger) {
    const alive = rowCurrent(trigger); if (!alive()) return;
    const form = editor(item), restoring = item.status === 'inactive', status = restoring ? 'active' : 'inactive', verb = restoring ? '恢復使用' : '停用', payload = { status };
    const outcome = confirmAction({ title: `${verb}這筆${profile.singular}？`, confirmLabel: `確認${verb}`, danger: !restoring, isCurrent: alive,
      message: `紀錄將改為${restoring ? '使用中' : '已停用'}。原文與版本歷程保留。`,
      onConfirm: async ({ signal, isCurrent: actionCurrent }) => {
        let response; try { response = await api(`/api/${entity}/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: { ...payload, version: item.version }, signal }); } catch (error) { throw conflict(error); }
        if (!actionCurrent()) return;
        form.confirm(response?.item, payload); toast(`${profile.singular}已${verb}。`, 'success');
      },
    });
    outcome.then(saved => { if (saved && current()) void load(); }); return outcome;
  }
  function details(item, trigger) {
    const alive = rowCurrent(trigger);
    return openDetails({ title: profile.singular + '詳情', wide: true, guardedRead: true, loadingText: `正在讀取${profile.singular}…`, isCurrent: alive,
      load: async (signal, helpers) => {
        const response = await api(`/api/${entity}/${encodeURIComponent(item.id)}`, { signal }); if (!helpers.isCurrent()) return el('div');
        const fresh = assertCaseHealthItem(response?.item, { entity, caseId, orgId, id: item.id });
        return el('div', {}, el('p', { class: 'notice' }, profile.description),
          el('dl', { class: 'detail-grid' }, profile.fields.map(key => el('div', {}, el('dt', {}, profile.labels[key]), el('dd', { class: 'pre-wrap' }, key === 'status' ? caseHealthStatusLabel(fresh[key]) : caseHealthText(fresh[key])))),
            el('div', {}, el('dt', {}, '保存版次'), el('dd', {}, String(fresh.version)))));
      },
    });
  }
  function card(item) {
    const status = badge(item.status); status.textContent = caseHealthStatusLabel(item.status);
    const heading = `${item.date}${entity === 'case-vitals' ? ' ' + item.time : ''} · ${caseHealthText(item[entity === 'case-vaccinations' ? 'vaccine' : entity === 'case-infection-records' ? 'category' : 'metric'])}`;
    const summaryFields = entity === 'case-vaccinations' ? ['dose', 'provider', 'source'] : entity === 'case-infection-records' ? ['observation', 'followUpDate', 'source'] : ['value', 'unit', 'source'];
    const controls = el('div', { class: 'actions' }, action('查看詳情', trigger => details(item, trigger)),
      action('版本歷程', trigger => openRecordHistory({ entity, id: item.id, lookups: { cases: new Map([[caseId, caseRecord]]) }, isCurrent: rowCurrent(trigger) })),
      action('編輯', trigger => edit(item, trigger)), action(item.status === 'inactive' ? '恢復使用' : '停用', trigger => changeStatus(item, trigger)));
    return el('article', { class: 'contact-card', 'data-case-health-id': item.id, 'aria-label': `${profile.singular}：${heading}` },
      el('div', { class: 'section-heading' }, el('h3', { class: 'pre-wrap' }, heading), status),
      el('dl', { class: 'contact-fields' }, summaryFields.map(key => el('div', {}, el('dt', {}, profile.labels[key]), el('dd', { class: 'pre-wrap' }, item[key].length > 160 ? item[key].slice(0, 160) + '…（詳情保留全文）' : caseHealthText(item[key]))))), controls);
  }
  const changed = (key, value) => { if (current()) { state[key] = value; state.page = 1; void load(); } };
  const search = searchBox({ label: `${profile.title}搜尋`, placeholder: '搜尋目前保存的文字', onSearch: value => changed('q', value) }); search.querySelector('input').maxLength = 200;
  const date = el('input', { type: 'date', 'aria-label': `${profile.title}日期篩選`, onchange: event => changed('date', event.target.value) });
  const status = el('select', { 'aria-label': `${profile.title}狀態篩選`, onchange: event => changed('status', event.target.value) }, el('option', { value: '' }, '全部狀態'), CASE_HEALTH_STATUSES.map(option => el('option', { value: option.value }, option.label)));
  actions.append(button(`新增${profile.singular}`, () => edit()), button('重新讀取', () => load(), { variant: 'secondary' }));
  element.append(el('div', { class: 'toolbar' }, search, el('label', { class: 'field' }, el('span', {}, '日期'), date), button('清除日期', () => { date.value = ''; changed('date', ''); date.focus(); }, { variant: 'ghost' }),
    el('label', { class: 'field' }, el('span', {}, '紀錄狀態'), status)), results, footer);
  async function load() {
    if (!current()) return;
    observe(); controller?.abort(); controller = new AbortController(); const requestSequence = ++sequence, requested = { ...state, pageSize: PAGE_SIZE, caseId, orgId, entity };
    results.setAttribute('aria-busy', 'true'); results.replaceChildren(el('p', { class: 'loading', role: 'status' }, `正在讀取${profile.title}…`)); footer.replaceChildren();
    const params = new URLSearchParams({ caseId, page: String(state.page), pageSize: String(PAGE_SIZE) }); for (const key of ['q', 'date', 'status']) if (state[key]) params.set(key, state[key]);
    try {
      const response = await api(`/api/${entity}?${params}`, { signal: controller.signal }); if (!current() || requestSequence !== sequence) return;
      confirmCaseHealthList(response, requested);
      const lastPage = Math.max(1, Math.ceil(response.total / PAGE_SIZE)); if (state.page > lastPage) { state.page = lastPage; return load(); }
      results.replaceChildren(...(response.items.length ? response.items.map(card) : [el('div', { class: 'empty-state', role: 'status' }, state.q || state.date || state.status ? '找不到符合條件的健康紀錄，請調整搜尋或篩選。' : `尚未建立${profile.title}。`)]));
      results.setAttribute('aria-busy', 'false'); footer.replaceChildren(pagination({ page: response.page, pageSize: PAGE_SIZE, total: response.total, onChange: page => { if (current()) { state.page = page; void load(); } } }));
    } catch (error) { if (error.name === 'AbortError' || !current() || requestSequence !== sequence) return; results.setAttribute('aria-busy', 'false'); results.replaceChildren(errorState(error, load)); }
  }
  return { element, load };
}
