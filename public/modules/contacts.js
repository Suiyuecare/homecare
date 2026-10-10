import { api, el, button, badge, openForm, confirmAction, toast, getContext, searchBox, pagination, errorState } from '../ui.js';
import { CONTACT_CATEGORIES, CONTACT_STATUSES } from '../data/history-fields.js';
import { createCaseContactEditor, confirmCaseContactList, formatContactText, formatContactCategory, formatContactStatus } from '../data/case-contact-editor.js';
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

function contactError(error) {
  if (error.status === 409) error.message = `${error.message} 請保留本次輸入，關閉表單並重新讀取聯絡人資料後再修改。`;
  return error;
}

/** A case-scoped island: failures and reloads never replace the surrounding case detail. */
export function createContactsPanel({ caseRecord, isCurrent = () => true }) {
  const identity = contextIdentity(), hash = window.location.hash;
  const orgId = getContext().organizationId || getContext().orgId;
  const mayWrite = ['admin', 'supervisor'].includes(getContext().role);
  const state = { q: '', category: '', status: '', page: 1 };
  const titleId = `contacts-${crypto.randomUUID()}`;
  const results = el('div', { class: 'contacts-list', 'aria-busy': 'true' });
  const footer = el('div');
  const actions = el('div', { class: 'actions' });
  const element = el('section', { class: 'panel', 'aria-labelledby': titleId },
    el('div', { class: 'section-heading' }, el('h2', { id: titleId }, '多組聯絡人'), actions),
    el('p', { class: 'muted small' }, '這裡可保存多筆分類聯絡人；既有個案聯絡欄位仍獨立保留，不會自動同步。'),
  );
  let invalidated = false, request = 0, controller, observer;
  const current = () => !invalidated && isCurrent() && element.isConnected && identity === contextIdentity() && hash === window.location.hash;
  const invalidate = () => {
    if (invalidated || current()) return;
    invalidated = true; controller?.abort(); element.replaceChildren();
    observer?.disconnect(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate);
  };
  const observe = () => {
    if (observer) return;
    observer = new MutationObserver(invalidate);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
    window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
  };

  function editContact(item) {
    if (!current() || !mayWrite) return;
    const create = !item, editor = createCaseContactEditor({ existing: item, caseId: caseRecord.id });
    const id = item?.id, version = item?.version, keysByPayload = new Map();
    return openForm({
      title: create ? '新增聯絡人' : '編輯聯絡人',
      initial: editor.initial, fields: editor.fields, isCurrent: current,
      onChange: (values, helpers) => {
        for (const descriptor of editor.fields) if (editor.needsIntent(descriptor.name))
          helpers.setDisabled(descriptor.name, !editor.enabled(descriptor.name, values));
      },
      onSubmit: async (values, { signal, isCurrent: formCurrent }) => {
        if (!formCurrent()) return;
        const payload = editor.buildPayload(values);
        if (!create && !Object.keys(payload).length) { if (formCurrent()) toast('聯絡人資料沒有變更。', 'info'); return; }
        const signature = JSON.stringify(payload);
        if (create && !keysByPayload.has(signature)) keysByPayload.set(signature, crypto.randomUUID());
        let response;
        try {
          response = await api(create ? '/api/case-contacts' : `/api/case-contacts/${encodeURIComponent(id)}`, {
            method: create ? 'POST' : 'PATCH', body: create ? payload : { ...payload, version }, signal,
            ...(create ? { headers: { 'Idempotency-Key': keysByPayload.get(signature) } } : {}),
          });
        } catch (error) { throw contactError(error); }
        if (!formCurrent()) return;
        editor.confirm(response?.item, orgId, payload);
        await load();
        if (formCurrent()) toast(create ? '聯絡人已新增。' : '聯絡人資料已更新。', 'success');
      },
    });
  }

  function changeStatus(item) {
    if (!current() || !mayWrite || !CONTACT_STATUSES.some(status => status.value === item.status)) return;
    const active = item.status === 'inactive';
    const verb = active ? '恢復使用' : '停用';
    const editor = createCaseContactEditor({ existing: item, caseId: caseRecord.id });
    const id = item.id, version = item.version, payload = editor.buildStatusChange(active ? 'active' : 'inactive');
    return confirmAction({
      title: `${verb}聯絡人？`,
      message: `將「${formatContactText(item.name)}」改為${active ? '使用中' : '已停用'}。資料與版本歷程會保留，既有個案聯絡欄位不受影響。`,
      confirmLabel: `確認${verb}`, danger: !active, isCurrent: current,
      onConfirm: async ({ signal, isCurrent: actionCurrent }) => {
        if (!actionCurrent()) return;
        let response;
        try {
          response = await api(`/api/case-contacts/${encodeURIComponent(id)}`, {
            method: 'PATCH', body: { version, ...payload }, signal,
          });
        } catch (error) { throw contactError(error); }
        if (!actionCurrent()) return;
        editor.confirm(response?.item, orgId, payload);
        await load();
        if (actionCurrent()) toast(`聯絡人已${verb}。`, 'success');
      },
    });
  }

  function card(item) {
    const knownStatus = CONTACT_STATUSES.some(status => status.value === item.status);
    const status = badge(knownStatus ? item.status : ''); status.textContent = formatContactStatus(item.status);
    const fields = [
      ['聯絡人分類', formatContactCategory(item.category)], ['關係', formatContactText(item.relationship)],
      ['主要電話', formatContactText(item.phone)], ['其他電話', formatContactText(item.alternatePhone)],
      ['電子信箱', formatContactText(item.email)], ['所屬單位', formatContactText(item.organization)], ['備註', formatContactText(item.note)],
    ];
    const controls = el('div', { class: 'actions' },
      button('版本歷程', () => openRecordHistory({ entity: 'case-contacts', id: item.id, lookups: { cases: new Map([[caseRecord.id, caseRecord]]) }, isCurrent: current }), { variant: 'secondary' }),
      mayWrite && button('編輯', () => editContact(item), { variant: 'secondary' }),
      mayWrite && knownStatus && button(item.status === 'inactive' ? '恢復使用' : '停用', () => changeStatus(item), { variant: 'secondary' }),
    );
    return el('article', { class: 'contact-card', 'data-contact-id': item.id, 'aria-label': `聯絡人：${formatContactText(item.name)}` },
      el('div', { class: 'section-heading' }, el('h3', { class: 'pre-wrap' }, formatContactText(item.name)), status),
      el('dl', { class: 'contact-fields' }, fields.map(([label, value]) => el('div', { class: label === '備註' ? 'contact-note' : undefined }, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value)))), controls,
    );
  }

  const changed = (key, value) => {
    if (!current()) return;
    state[key] = value; state.page = 1; void load();
  };
  const toolbar = el('div', { class: 'toolbar' },
    searchBox({ label: '聯絡人搜尋', placeholder: '搜尋姓名、電話或聯絡資訊', onSearch: value => changed('q', value) }),
    filter('聯絡人分類篩選', [{ value: '', label: '全部分類' }, ...CONTACT_CATEGORIES], value => changed('category', value)),
    filter('聯絡人狀態篩選', [{ value: '', label: '全部狀態' }, ...CONTACT_STATUSES], value => changed('status', value)),
  );
  if (mayWrite) actions.append(button('新增聯絡人', () => editContact(null)));
  actions.append(button('重新讀取聯絡人', () => load(), { variant: 'secondary' }));
  element.append(toolbar, results, footer);

  async function load() {
    if (!current()) return;
    observe(); controller?.abort(); controller = new AbortController();
    const sequence = ++request, page = state.page;
    const requested = { page, pageSize: PAGE_SIZE, orgId, caseId: caseRecord.id, category: state.category, status: state.status };
    results.setAttribute('aria-busy', 'true');
    results.replaceChildren(el('p', { class: 'loading', role: 'status' }, '正在讀取聯絡人…')); footer.replaceChildren();
    const params = new URLSearchParams({ caseId: caseRecord.id, page: String(page), pageSize: String(PAGE_SIZE) });
    for (const key of ['q', 'category', 'status']) if (state[key]) params.set(key, state[key]);
    try {
      const response = await api(`/api/case-contacts?${params}`, { signal: controller.signal });
      if (!current() || sequence !== request) return;
      confirmCaseContactList(response, requested);
      const lastPage = Math.max(1, Math.ceil(response.total / PAGE_SIZE));
      if (page > lastPage) { state.page = lastPage; return load(); }
      results.replaceChildren(...(response.items.length ? response.items.map(card) : [el('div', { class: 'empty-state', role: 'status' },
        state.q || state.category || state.status ? '找不到符合條件的聯絡人，請調整搜尋或篩選。' : '尚未建立多組聯絡人。',
      )]));
      results.setAttribute('aria-busy', 'false');
      footer.replaceChildren(pagination({ page, pageSize: PAGE_SIZE, total: response.total, onChange: next => { if (!current()) return; state.page = next; void load(); } }));
    } catch (error) {
      if (error.name === 'AbortError' || !current() || sequence !== request) return;
      results.setAttribute('aria-busy', 'false');
      results.replaceChildren(errorState(error, load));
    }
  }

  return { element, load };
}
