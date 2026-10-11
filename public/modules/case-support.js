import { api, el, button, badge, openForm, confirmAction, toast, today, getContext, searchBox, pagination, errorState } from '../ui.js';
import { CASE_SUPPORT_PROFILES, CASE_SUPPORT_STATUSES, createCaseSupportEditor, confirmCaseSupportList, formatCaseSupportText, caseSupportOptionLabel } from '../data/case-support-editor.js';
import { openRecordHistory } from './history.js';

const PAGE_SIZE = 25;
const identity = () => { const context = getContext(); return JSON.stringify([context.user?.id, context.organizationId || context.orgId, context.role, context.user?.employeeId]); };
const mutationError = error => { if (error.status === 409) error.message += ' 請保留輸入，關閉表單並重新讀取目前紀錄後再修改。'; return error; };

/** Case-centered direction diagram; boxes never encode gender, diagnosis or kinship symbols. */
function relationshipDiagram(item, caseName) {
  const namespace = 'http://www.w3.org/2000/svg';
  const node = (tag, attributes = {}, text) => {
    const element = document.createElementNS(namespace, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const name = formatCaseSupportText(item.name), parent = formatCaseSupportText(caseName);
  const caption = item.direction === 'toward_case' ? `${name} → ${parent}` : item.direction === 'from_case' ? `${parent} → ${name}` : item.direction === 'bidirectional' ? `${parent} ↔ ${name}` : `${parent}／${name}（方向未確認）`;
  const diagram = node('svg', { viewBox: '0 0 400 64', width: '100%', height: '64', role: 'img', 'aria-label': caption, focusable: 'false' });
  diagram.append(node('title', {}, caption), node('rect', { x: 5, y: 10, width: 100, height: 44, rx: 8, fill: 'none', stroke: 'currentColor' }), node('rect', { x: 295, y: 10, width: 100, height: 44, rx: 8, fill: 'none', stroke: 'currentColor' }),
    node('text', { x: 55, y: 37, 'text-anchor': 'middle', fill: 'currentColor', 'font-size': '16' }, '個案'),
    node('text', { x: 345, y: 37, 'text-anchor': 'middle', fill: 'currentColor', 'font-size': '16' }, item.kind === 'community' ? '社區支持' : item.kind === 'family' ? '家系關係' : '關係對象'),
    node('line', { x1: 112, x2: 288, y1: 32, y2: 32, stroke: 'currentColor', 'stroke-width': '2' }));
  if (['toward_case', 'bidirectional'].includes(item.direction)) diagram.append(node('polyline', { points: '124,25 112,32 124,39', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }));
  if (['from_case', 'bidirectional'].includes(item.direction)) diagram.append(node('polyline', { points: '276,25 288,32 276,39', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }));
  return el('figure', {}, diagram, el('figcaption', { class: 'pre-wrap small' }, caption));
}

/** Reuses the shared form, confirmation, history, search and paged case-card owners. */
export function createCaseSupportPanel({ entity, caseRecord, isCurrent = () => true }) {
  const profile = CASE_SUPPORT_PROFILES[entity];
  if (!profile || !['admin', 'supervisor'].includes(getContext().role)) throw new Error('此角色無權查看個案支持資料。');
  const context = getContext(), contextIdentity = identity(), hash = window.location.hash;
  const orgId = context.organizationId || context.orgId;
  const state = { q: '', status: '', page: 1 }, titleId = `case-support-${crypto.randomUUID()}`;
  const results = el('div', { class: 'contacts-list', 'aria-busy': 'true' }), footer = el('div'), actions = el('div', { class: 'actions' });
  const element = el('section', { class: 'panel', 'aria-labelledby': titleId, 'data-case-support': entity },
    el('div', { class: 'section-heading' }, el('h2', { id: titleId }, profile.title), actions),
    el('p', { class: 'muted small' }, entity === 'case-relationships'
      ? '以個案為中心，人工保存家人及社區支持的角色、方向與關係說明。'
      : '保存醫事人員提供的意見與人工追蹤內容；由管理者及督導維護。'),
  );
  let invalidated = false, sequence = 0, controller, observer;
  const current = () => !invalidated && isCurrent() && element.isConnected && context === getContext() && contextIdentity === identity() && hash === window.location.hash;
  const invalidate = () => {
    if (invalidated || current()) return;
    invalidated = true; controller?.abort(); element.replaceChildren(); observer?.disconnect();
    window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate);
  };
  const observe = () => {
    if (observer) return;
    observer = new MutationObserver(invalidate);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
    window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
  };
  function editor(item) { return createCaseSupportEditor({ entity, existing: item, caseId: caseRecord.id, orgId, defaultDate: today() }); }
  function edit(item = null) {
    if (!current()) return;
    const form = editor(item), create = !item, keys = new Map();
    return openForm({ title: `${create ? '新增' : '編輯'}${profile.singular}`, initial: form.initial, fields: form.fields, isCurrent: current,
      onChange: (values, helpers) => { for (const field of form.fields) if (!field.name.endsWith('Intent')) helpers.setDisabled(field.name, !form.enabled(field.name, values)); },
      onSubmit: async (values, { signal, isCurrent: formCurrent }) => {
        if (!formCurrent()) return;
        const payload = form.buildPayload(values);
        if (!create && !Object.keys(payload).length) { toast('紀錄沒有變更。', 'info'); return; }
        const signature = JSON.stringify(payload);
        if (create && !keys.has(signature)) keys.set(signature, crypto.randomUUID());
        let response;
        try { response = await api(`/api/${entity}${create ? '' : '/' + encodeURIComponent(item.id)}`, {
          method: create ? 'POST' : 'PATCH', body: create ? payload : { ...payload, version: item.version }, signal,
          ...(create ? { headers: { 'Idempotency-Key': keys.get(signature) } } : {}),
        }); } catch (error) { throw mutationError(error); }
        if (!formCurrent()) return;
        form.confirm(response?.item, payload);
        await load();
        if (formCurrent()) toast(`${profile.singular}已${create ? '新增' : '更新'}。`, 'success');
      },
    });
  }
  function statusChange(item) {
    if (!current()) return;
    const form = editor(item), restoring = item.status === 'inactive', status = restoring ? 'active' : 'inactive', verb = restoring ? '恢復使用' : '停用';
    const payload = form.buildPayload({ ...form.initial, status, ...(Object.hasOwn(form.initial, 'statusIntent') ? { statusIntent: 'replace' } : {}) });
    return confirmAction({ title: `${verb}這筆${profile.singular}？`, confirmLabel: `確認${verb}`, danger: !restoring, isCurrent: current,
      message: `${profile.singular}將改為${restoring ? '使用中' : '已停用'}。原文及版本歷程會保留。`,
      onConfirm: async ({ signal, isCurrent: actionCurrent }) => {
        let response;
        try { response = await api(`/api/${entity}/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: { ...payload, version: item.version }, signal }); }
        catch (error) { throw mutationError(error); }
        if (!actionCurrent()) return;
        form.confirm(response?.item, payload); await load();
        if (actionCurrent()) toast(`${profile.singular}已${verb}。`, 'success');
      },
    });
  }
  function card(item) {
    const status = badge(['active', 'inactive'].includes(item.status) ? item.status : '');
    status.textContent = caseSupportOptionLabel(entity, 'status', item.status);
    const heading = entity === 'case-relationships' ? formatCaseSupportText(item.name) : `${formatCaseSupportText(item.date)} · ${formatCaseSupportText(item.practitionerName)}`;
    const controls = el('div', { class: 'actions' },
      button('版本歷程', () => openRecordHistory({ entity, id: item.id, lookups: { cases: new Map([[caseRecord.id, caseRecord]]) }, isCurrent: current }), { variant: 'secondary' }),
      button('編輯', () => edit(item), { variant: 'secondary' }),
      button(item.status === 'inactive' ? '恢復使用' : '停用', () => statusChange(item), { variant: 'secondary' }),
    );
    return el('article', { class: 'contact-card', 'data-case-support-id': item.id, 'aria-label': `${profile.singular}：${heading}` },
      el('div', { class: 'section-heading' }, el('h3', { class: 'pre-wrap' }, heading), status),
      entity === 'case-relationships' && relationshipDiagram(item, caseRecord.name),
      el('dl', { class: 'contact-fields' }, profile.fields.filter(key => key !== 'status').map(key => el('div', { class: ['note', 'summary', 'recommendation'].includes(key) ? 'contact-note' : undefined },
        el('dt', {}, profile.labels[key]), el('dd', { class: 'pre-wrap' }, caseSupportOptionLabel(entity, key, item[key]))))), controls,
    );
  }
  const changed = (key, value) => { if (current()) { state[key] = value; state.page = 1; void load(); } };
  const search = searchBox({ label: `${profile.title}搜尋`, placeholder: '搜尋目前保存的文字', onSearch: value => changed('q', value) });
  search.querySelector('input').maxLength = 200;
  const select = el('select', { 'aria-label': `${profile.title}狀態篩選`, onchange: event => changed('status', event.target.value) },
    el('option', { value: '' }, '全部狀態'), CASE_SUPPORT_STATUSES.map(item => el('option', { value: item.value }, item.label)));
  actions.append(button(`新增${profile.singular}`, () => edit()), button('重新讀取', () => load(), { variant: 'secondary' }));
  element.append(el('div', { class: 'toolbar' }, search, el('label', { class: 'field' }, el('span', {}, '紀錄狀態'), select)), results, footer);
  async function load() {
    if (!current()) return;
    observe(); controller?.abort(); controller = new AbortController();
    const requestSequence = ++sequence, requested = { ...state, pageSize: PAGE_SIZE, caseId: caseRecord.id, orgId, entity };
    results.setAttribute('aria-busy', 'true'); results.replaceChildren(el('p', { class: 'loading', role: 'status' }, `正在讀取${profile.title}…`)); footer.replaceChildren();
    const params = new URLSearchParams({ caseId: caseRecord.id, page: String(state.page), pageSize: String(PAGE_SIZE) });
    for (const key of ['q', 'status']) if (state[key]) params.set(key, state[key]);
    try {
      const response = await api(`/api/${entity}?${params}`, { signal: controller.signal });
      if (!current() || requestSequence !== sequence) return;
      confirmCaseSupportList(response, requested);
      const lastPage = Math.max(1, Math.ceil(response.total / PAGE_SIZE));
      if (state.page > lastPage) { state.page = lastPage; return load(); }
      results.replaceChildren(...(response.items.length ? response.items.map(card) : [el('div', { class: 'empty-state', role: 'status' }, state.q || state.status ? '找不到符合條件的紀錄，請調整搜尋或篩選。' : `尚未建立${profile.title}。`)]));
      results.setAttribute('aria-busy', 'false');
      footer.replaceChildren(pagination({ page: response.page, pageSize: PAGE_SIZE, total: response.total, onChange: page => { if (current()) { state.page = page; void load(); } } }));
    } catch (error) {
      if (error.name === 'AbortError' || !current() || requestSequence !== sequence) return;
      results.setAttribute('aria-busy', 'false'); results.replaceChildren(errorState(error, load));
    }
  }
  return { element, load };
}
export const createCaseRelationshipsPanel = options => createCaseSupportPanel({ ...options, entity: 'case-relationships' });
export const createMedicalOpinionsPanel = options => createCaseSupportPanel({ ...options, entity: 'medical-opinions' });
