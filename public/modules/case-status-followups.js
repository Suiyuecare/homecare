import { api, el, button, badge, openForm, confirmAction, toast, today, getContext, searchBox, pagination, errorState } from '../ui.js';
import { FOLLOWUP_KINDS, FOLLOWUP_STATUSES, createCaseStatusFollowupEditor, formatFollowupText, formatFollowupDate, formatFollowupKind, formatFollowupStatus } from '../data/case-status-followup-editor.js';
import { openRecordHistory } from './history.js';

const PAGE_SIZE = 25;
const contextIdentity = () => {
  const context = getContext();
  return JSON.stringify([context.user?.id, context.organizationId || context.orgId, context.role, context.user?.employeeId]);
};
function filter(label, choices, onChange) {
  const select = el('select', { 'aria-label': label }, choices.map(item => el('option', { value: item.value }, item.label)));
  select.addEventListener('change', () => onChange(select.value));
  return el('label', { class: 'field' }, el('span', {}, label), select);
}
function mutationError(error) {
  if (error.status === 409) error.message = `${error.message} 請保留本次輸入，關閉表單並重新讀取追蹤紀錄後再修改。`;
  return error;
}

/** Case-scoped island. Shared forms own busy, dirty, focus, abort and context invalidation. */
export function createCaseStatusFollowupsPanel({ caseRecord, isCurrent = () => true }) {
  const identity = contextIdentity(), hash = window.location.hash;
  const orgId = getContext().organizationId || getContext().orgId;
  const mayWrite = ['admin', 'supervisor'].includes(getContext().role);
  const state = { q: '', kind: '', status: '', page: 1 };
  const titleId = `case-followups-${crypto.randomUUID()}`;
  const results = el('div', { class: 'contacts-list', 'aria-busy': 'true' });
  const footer = el('div');
  const actions = el('div', { class: 'actions' });
  const element = el('section', { class: 'panel', 'aria-label': '暫停與結案追蹤', 'aria-labelledby': titleId },
    el('div', { class: 'section-heading' }, el('h2', { id: titleId }, '暫停與結案追蹤'), actions),
    el('p', { class: 'muted small' }, '保存原因、期間與人工追蹤結果；不會更改個案服務狀態、取消班次或調整收費。'),
  );
  const current = () => isCurrent() && element.isConnected && identity === contextIdentity() && hash === window.location.hash;
  let request = 0, controller;

  function editFollowup(item) {
    if (!current() || !mayWrite) return;
    const create = !item, editor = createCaseStatusFollowupEditor({ existing: item, caseId: caseRecord.id, defaultDate: today() });
    const id = item?.id, version = item?.version;
    const keysByPayload = new Map();
    return openForm({
      title: create ? '新增追蹤紀錄' : '編輯追蹤紀錄',
      initial: editor.initial, fields: editor.fields, isCurrent: current,
      onChange: (values, helpers) => {
        for (const descriptor of editor.fields) if (editor.needsIntent(descriptor.name))
          helpers.setDisabled(descriptor.name, !editor.enabled(descriptor.name, values));
      },
      onSubmit: async (values, { signal, isCurrent: formCurrent }) => {
        const payload = editor.buildPayload(values);
        if (!create && !Object.keys(payload).length) { if (formCurrent()) toast('追蹤紀錄沒有變更。', 'info'); return; }
        const signature = JSON.stringify(payload);
        if (create && !keysByPayload.has(signature)) keysByPayload.set(signature, crypto.randomUUID());
        let response;
        try {
          response = await api(create ? '/api/case-status-followups' : `/api/case-status-followups/${encodeURIComponent(id)}`, {
            method: create ? 'POST' : 'PATCH', body: create ? payload : { ...payload, version },
            ...(create ? { headers: { 'Idempotency-Key': keysByPayload.get(signature) } } : {}), signal,
          });
        } catch (error) { throw mutationError(error); }
        if (!formCurrent()) return;
        editor.confirm(response?.item, orgId, payload);
        await load();
        if (formCurrent()) toast(create ? '追蹤紀錄已新增。' : '追蹤紀錄已更新。', 'success');
      },
    });
  }

  function changeStatus(item) {
    if (!current() || !mayWrite) return;
    const editor = createCaseStatusFollowupEditor({ existing: item, caseId: caseRecord.id });
    const reopening = item.status === 'cancelled';
    const status = reopening ? 'pending' : 'cancelled';
    const verb = reopening ? '恢復' : '取消';
    const payload = editor.buildStatusChange(status);
    return confirmAction({
      title: `${verb}這筆追蹤？`, confirmLabel: `確認${verb}追蹤`, danger: !reopening, isCurrent: current,
      message: `將${formatFollowupKind(item.kind)}追蹤（開始日期：${formatFollowupDate(item.startDate)}）改為${formatFollowupStatus(status)}。紀錄與版本歷程會保留，個案服務狀態、班次及收費不受影響。`,
      onConfirm: async ({ signal, isCurrent: actionCurrent }) => {
        let response;
        try {
          response = await api(`/api/case-status-followups/${encodeURIComponent(item.id)}`, {
            method: 'PATCH', body: { ...payload, version: item.version }, signal,
          });
        } catch (error) { throw mutationError(error); }
        if (!actionCurrent()) return;
        editor.confirm(response?.item, orgId, payload);
        await load();
        if (actionCurrent()) toast(`追蹤紀錄已${verb}。`, 'success');
      },
    });
  }

  function card(item) {
    const knownStatus = FOLLOWUP_STATUSES.some(status => status.value === item.status);
    const status = badge(knownStatus ? item.status : ''); status.textContent = formatFollowupStatus(item.status);
    const details = [
      ['追蹤類型', formatFollowupKind(item.kind)], ['開始日期', formatFollowupDate(item.startDate)],
      ['結束日期', formatFollowupDate(item.endDate)], ['追蹤日期', formatFollowupDate(item.followUpDate)],
      ['原因', formatFollowupText(item.reason)], ['追蹤結果', formatFollowupText(item.outcome)], ['備註', formatFollowupText(item.note)],
    ];
    const controls = el('div', { class: 'actions' },
      button('版本歷程', () => openRecordHistory({ entity: 'case-status-followups', id: item.id, lookups: { cases: new Map([[caseRecord.id, caseRecord]]) }, isCurrent: current }), { variant: 'secondary' }),
      mayWrite && button('編輯', () => editFollowup(item), { variant: 'secondary' }),
      mayWrite && knownStatus && button(item.status === 'cancelled' ? '恢復追蹤' : '取消追蹤', () => changeStatus(item), { variant: 'secondary' }),
    );
    return el('article', { class: 'contact-card', 'data-followup-id': item.id, 'aria-label': `${formatFollowupKind(item.kind)}追蹤：${formatFollowupDate(item.startDate)}` },
      el('div', { class: 'section-heading' }, el('h3', { class: 'pre-wrap' }, `${formatFollowupKind(item.kind)}追蹤 · ${formatFollowupDate(item.startDate)}`), status),
      el('dl', { class: 'contact-fields' }, details.map(([label, value]) => el('div', { class: ['原因', '備註'].includes(label) ? 'contact-note' : undefined }, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value)))), controls,
    );
  }

  const changed = (key, value) => {
    if (!current()) return;
    state[key] = value; state.page = 1; void load();
  };
  const search = searchBox({ label: '追蹤紀錄搜尋', placeholder: '搜尋原因、追蹤結果或備註', onSearch: value => changed('q', value) });
  search.querySelector('input').maxLength = 200;
  const toolbar = el('div', { class: 'toolbar' }, search,
    filter('追蹤類型篩選', [{ value: '', label: '全部類型' }, ...FOLLOWUP_KINDS], value => changed('kind', value)),
    filter('追蹤狀態篩選', [{ value: '', label: '全部狀態' }, ...FOLLOWUP_STATUSES], value => changed('status', value)),
  );
  if (mayWrite) actions.append(button('新增追蹤紀錄', () => editFollowup(null)));
  actions.append(button('重新讀取追蹤紀錄', () => load(), { variant: 'secondary' }));
  element.append(toolbar, results, footer);

  async function load() {
    if (!current()) return;
    controller?.abort(); controller = new AbortController();
    const sequence = ++request;
    results.setAttribute('aria-busy', 'true');
    results.replaceChildren(el('p', { class: 'loading', role: 'status' }, '正在讀取追蹤紀錄…')); footer.replaceChildren();
    const params = new URLSearchParams({ caseId: caseRecord.id, page: String(state.page), pageSize: String(PAGE_SIZE) });
    for (const key of ['q', 'kind', 'status']) if (state[key]) params.set(key, state[key]);
    try {
      const response = await api(`/api/case-status-followups?${params}`, { signal: controller.signal });
      if (!current() || sequence !== request) return;
      if (!Array.isArray(response?.items) || !Number.isSafeInteger(response.total) || response.total < 0
        || response.page !== state.page || response.pageSize !== PAGE_SIZE || response.items.length > PAGE_SIZE
        || response.items.length !== Math.min(PAGE_SIZE, Math.max(0, response.total - (state.page - 1) * PAGE_SIZE))
        || new Set(response.items.map(item => item?.id)).size !== response.items.length
        || response.items.some(item => !item || typeof item !== 'object' || Array.isArray(item)
          || typeof item.id !== 'string' || !item.id.trim() || item.orgId !== orgId || item.caseId !== caseRecord.id
          || !Number.isSafeInteger(item.version) || item.version < 1))
        throw new Error('追蹤紀錄回應無法確認，請重新讀取。');
      const lastPage = Math.max(1, Math.ceil(response.total / PAGE_SIZE));
      if (state.page > lastPage) { state.page = lastPage; return load(); }
      results.replaceChildren(...(response.items.length ? response.items.map(card) : [el('div', { class: 'empty-state', role: 'status' },
        state.q || state.kind || state.status ? '找不到符合條件的追蹤紀錄，請調整搜尋或篩選。' : '尚未建立暫停或結案追蹤紀錄。',
      )]));
      results.setAttribute('aria-busy', 'false');
      footer.replaceChildren(pagination({ page: state.page, pageSize: PAGE_SIZE, total: response.total, onChange: page => { if (!current()) return; state.page = page; void load(); } }));
    } catch (error) {
      if (error.name === 'AbortError' || !current() || sequence !== request) return;
      results.setAttribute('aria-busy', 'false');
      results.replaceChildren(errorState(error, load));
    }
  }
  return { element, load };
}
