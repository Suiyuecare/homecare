import { api, el, pageHeader, table, badge, button, openForm, confirmAction, openDetails, toast, today, getContext, searchBox, pagination, errorState } from '../ui.js';
import { openRecordHistory } from './history.js';
import { institutionHolidayFields, institutionHolidayKinds, institutionHolidayStatuses, institutionHolidayYear,
  checkInstitutionHolidayRecord, createInstitutionHolidayEditor } from '../data/institution-holiday-editor.js';

const entity = 'institution-holidays';
const org = () => getContext().organizationId || getContext().orgId;
const identity = () => { const ctx = getContext(); return JSON.stringify([ctx.user?.id, org(), ctx.role, ctx.user?.employeeId || ctx.employeeId || '']); };
const cancel = () => { throw new DOMException('目前情境已變動，請重新讀取確認保存狀態。', 'AbortError'); };
const notice = message => el('p', { class: 'notice', role: 'note' }, message);
const labels = { date: '指定日期', title: '名稱', kind: '人工指定類型', sourceReference: '人工設定依據', note: '備註', status: '紀錄狀態' };
const boundary = '僅保存機構人工指定日期；不會自動拒絕排班、計算加給或假額，亦不推定法定假日、例休或發票規則。';
function actionButton(label, action, variant = 'outline') {
  let busy = false;
  const trigger = button(label, async () => {
    if (busy) return; busy = true; trigger.setAttribute('aria-busy', 'true'); trigger.setAttribute('aria-disabled', 'true');
    try { await action(trigger); } catch (error) { if (trigger.isConnected && error.name !== 'AbortError') toast(error.message || '操作失敗，請重新讀取。', 'error'); }
    finally { busy = false; trigger.removeAttribute('aria-busy'); trigger.removeAttribute('aria-disabled'); }
  }, { variant }); return trigger;
}
export async function mountInstitutionHolidays(container, { isCurrent = () => true } = {}) {
  const initialContext = getContext(), initialIdentity = identity(), initialHash = location.hash;
  const alive = () => container.isConnected && isCurrent() && getContext() === initialContext && identity() === initialIdentity && location.hash === initialHash;
  if (!initialContext.user?.id || !org() || !['admin', 'supervisor'].includes(getContext().role)) { const error = new Error('只有已登入的管理者與督導可查閱及維護目前機構指定日期。'); error.status = 403; container.replaceChildren(errorState(error)); return; }
  let year = today().slice(0, 4), page = 1, query = '', status = '', sequence = 0, controller;
  const body = el('div', { class: 'list-content', 'aria-live': 'polite' }), footer = el('div', { class: 'list-footer' });
  const yearNotice = notice(`查詢年度：${year}年。日期設定只供人工參考。`);
  const readItem = async (id, signal, current) => {
    const item = checkInstitutionHolidayRecord(await api(`/api/${entity}/${encodeURIComponent(id)}`, { signal }), { id, orgId: org() });
    if (!current()) cancel(); return item;
  };
  const actionRead = async (trigger, action) => {
    const request = new AbortController(), current = () => alive() && (!trigger || trigger.isConnected);
    const invalidate = () => { if (!current()) request.abort(); };
    const observer = new MutationObserver(invalidate); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
    window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
    try { if (current()) await action(request.signal, current); }
    finally { request.abort(); observer.disconnect(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate); }
  };
  const edit = (row, trigger) => actionRead(trigger, async (signal, current) => {
    const existing = row ? await readItem(row.id, signal, current) : undefined;
    if (existing && (existing.version !== row.version || existing.status !== row.status)) throw new Error('此指定日期已更新，請重新讀取。');
    const editor = createInstitutionHolidayEditor({ existing, defaultDate: today() });
    let key = crypto.randomUUID(), signature, written = false;
    const saved = await openForm({ title: existing ? '編輯機構指定日期' : '新增機構指定日期', submitLabel: '儲存指定日期', fields: editor.fields, initial: editor.initial, isCurrent: current,
      onSubmit: async (values, owner) => {
        const payload = editor.buildPayload(values); if (existing && !Object.keys(payload).length) return;
        const sent = existing ? { ...payload, version: existing.version } : payload, next = JSON.stringify(sent);
        if (signature !== undefined && signature !== next) key = crypto.randomUUID(); signature = next;
        const response = await api(`/api/${entity}${existing ? '/' + encodeURIComponent(existing.id) : ''}`, { method: existing ? 'PATCH' : 'POST', body: sent, headers: { 'Idempotency-Key': key }, signal: owner.signal });
        if (!owner.isCurrent()) cancel(); checkInstitutionHolidayRecord(response, { id: existing?.id, orgId: org(), original: existing, payload }); written = true;
      } });
    if (saved && current()) { await load(); if (alive() && written) toast('已儲存機構指定日期', 'success'); }
  });
  const changeStatus = (row, trigger) => actionRead(trigger, async (signal, current) => {
    const original = await readItem(row.id, signal, current);
    if (original.version !== row.version || original.status !== row.status) throw new Error('此指定日期已更新，請重新讀取。');
    const next = original.status === 'active' ? 'inactive' : 'active', operation = next === 'inactive' ? '停用' : '恢復使用', key = crypto.randomUUID();
    const saved = await confirmAction({ title: `確認${operation}此設定？`, message: `${original.date} ${original.title}。保留原文及版本歷程；恢復使用時，系統會檢查同日是否已有有效設定。${boundary}`,
      confirmLabel: `確認${operation}`, danger: next === 'inactive', signal, isCurrent: current,
      onConfirm: async owner => {
        const payload = { status: next }, response = await api(`/api/${entity}/${encodeURIComponent(original.id)}`, { method: 'PATCH', body: { ...payload, version: original.version }, headers: { 'Idempotency-Key': key }, signal: owner.signal });
        if (!owner.isCurrent()) cancel(); checkInstitutionHolidayRecord(response, { id: original.id, orgId: org(), original, payload });
      } });
    if (saved && current()) { await load(); if (alive()) toast(`已${operation}指定日期設定`, 'success'); }
  });
  const details = (row, trigger, request) => openDetails({ title: '機構指定日期完整紀錄', wide: true, guardedRead: true,
    isCurrent: () => alive() && trigger.isConnected && sequence === request,
    load: async (signal, owner) => { const item = await readItem(row.id, signal, owner.isCurrent);
      const field = (label, value) => el('div', {}, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value || '未填寫'));
      return el('section', {}, notice(boundary), el('dl', { class: 'detail-grid' }, institutionHolidayFields.map(key => field(labels[key], key === 'kind' ? institutionHolidayKinds[item.kind] : key === 'status' ? institutionHolidayStatuses[item.status] : item[key])),
        field('保存版次', String(item.version)), field('建立時間', item.createdAt), field('最近保存時間', item.updatedAt))); } });
  const queryYear = trigger => actionRead(trigger, async (_signal, current) => {
    const saved = await openForm({ title: '查詢指定日期年度', fields: [{ name: 'year', label: '查詢年度', maxLength: 4, help: '填0001至9999四位數；留空查詢全部年度。' }], initial: { year }, submitLabel: '查詢清單', isCurrent: current,
      onSubmit: values => { if (values.year && !institutionHolidayYear(values.year)) { const error = new Error('請提供四位有效年度，或留空查詢全部。'); error.fields = { year: error.message }; throw error; } } });
    if (saved && current()) { year = saved.year; page = 1; yearNotice.textContent = year ? `查詢年度：${year}年。日期設定只供人工參考。` : '查詢全部年度；日期設定只供人工參考。'; await load(); }
  });
  const load = async () => {
    if (!alive()) return; const request = ++sequence; controller?.abort(); controller = new AbortController(); body.dataset.renderVersion = `${entity}:${request}`;
    body.replaceChildren(el('p', { class: 'loading', role: 'status' }, '正在讀取機構指定日期…')); footer.replaceChildren();
    const params = new URLSearchParams({ page: String(page), pageSize: '25' }); if (year) params.set('year', year); if (query) params.set('q', query); if (status) params.set('status', status);
    try {
      const result = await api(`/api/${entity}?${params}`, { signal: controller.signal }); if (!alive() || sequence !== request) return;
      if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0 || result.page !== page || result.pageSize !== 25 || result.items.length > 25) throw new Error('指定日期清單分頁無法確認。');
      const items = result.items.map(item => checkInstitutionHolidayRecord({ item }, { orgId: org() }));
      if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('指定日期清單識別重複，請重新讀取。');
      if (page > 1 && !items.length && result.total) { page = Math.ceil(result.total / 25); return load(); }
      body.replaceChildren(table([{ key: 'date', label: '日期' }, { key: 'title', label: '名稱' }, { label: '人工指定類型', render: row => institutionHolidayKinds[row.kind] },
        { label: '狀態', render: row => { const node = badge(row.status); node.textContent = institutionHolidayStatuses[row.status]; return node; } },
        { label: '操作', render: row => el('div', { class: 'actions row-actions' }, actionButton('查看紀錄', trigger => details(row, trigger, request)), actionButton('編輯', trigger => edit(row, trigger)),
          actionButton(row.status === 'active' ? '停用' : '恢復使用', trigger => changeStatus(row, trigger), row.status === 'active' ? 'danger' : 'outline'),
          actionButton('版本歷程', trigger => openRecordHistory({ entity, id: row.id, isCurrent: () => alive() && trigger.isConnected && sequence === request }))) }], items,
        { caption: '機構人工指定日期', emptyText: query || status || year ? '此查詢沒有指定日期，請調整年度或搜尋條件。' : '尚無指定日期，請先新增機構設定。' }));
      footer.replaceChildren(pagination({ page, pageSize: 25, total: result.total, onChange: next => { if (alive()) { page = next; void load(); } } }));
    } catch (error) { if (alive() && sequence === request && error.name !== 'AbortError') body.replaceChildren(errorState(error, load)); }
  };
  const statusId = `holiday-status-${crypto.randomUUID()}`, select = el('select', { id: statusId, class: 'input' }, el('option', { value: '' }, '全部狀態'),
    Object.entries(institutionHolidayStatuses).map(([value, label]) => el('option', { value }, label)));
  select.addEventListener('change', () => { if (alive()) { status = select.value; page = 1; void load(); } });
  const toolbar = el('div', { class: 'toolbar' }, searchBox({ label: '搜尋指定日期', placeholder: '搜尋名稱、日期或人工依據', onSearch: value => { if (alive()) { query = value; page = 1; void load(); } } }),
    el('label', { for: statusId, class: 'filter-field' }, el('span', {}, '狀態'), select), actionButton('查詢年度', queryYear));
  toolbar.querySelector('input[type="search"]').maxLength = 200;
  container.replaceChildren(pageHeader('機構人工假日', '保存公司指定的假日、工作日與停止服務日期', [actionButton('新增指定日期', trigger => edit(null, trigger), 'primary')]), notice(boundary), el('section', { class: 'panel' }, toolbar, yearNotice, body, footer));
  const invalidate = () => { if (alive()) return; ++sequence; controller?.abort(); observer.disconnect(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate); };
  const observer = new MutationObserver(invalidate); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
  window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate); await load();
}
