import { api, el, pageHeader, table, badge, button, openForm, confirmAction, openDetails, toast, today, getContext, searchBox, pagination, errorState } from '../ui.js';
import { openRecordHistory } from './history.js';
import { contractDeadlineEntity as entity, contractDeadlineFields, contractDeadlineSnapshotFields, contractDeadlineStatuses, contractDeadlinePriorities,
  contractDeadlineWorkStates, contractDeadlineLabels, contractDeadlineDate, contractDeadlineWorkState, checkContractDeadlineRecord,
  contractDeadlineSnapshotValid, createContractDeadlineEditor, createContractDeadlineTransitionEditor } from '../data/contract-deadline-editor.js';
import { checkContractsTasksRecord, contractStatuses } from '../data/contracts-tasks-editor.js';

const org = () => getContext().organizationId || getContext().orgId;
const identity = () => { const context = getContext(); return JSON.stringify([context.user?.id, org(), context.role]); };
const abort = () => { throw new DOMException('目前操作已失效，請重新讀取保存結果。', 'AbortError'); };
const notice = text => el('p', { class: 'notice', role: 'note' }, text);
const options = values => Object.entries(values).map(([value, label]) => ({ value, label }));
const field = (label, value, wide = false) => el('div', { class: `detail-field${wide ? ' wide' : ''}` }, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value || '未填寫'));
const manualNotice = '僅機構人工期限工作清單；不推定法定期限、不改契約或既有待辦狀態，不建立公告、不執行背景提醒或發送外部訊息。';
function actionButton(label, action, variant = 'outline') {
  let busy = false;
  const trigger = button(label, async () => {
    if (busy) return; busy = true; trigger.setAttribute('aria-busy', 'true'); trigger.setAttribute('aria-disabled', 'true');
    try { await action(trigger); } catch (error) { if (trigger.isConnected && error.name !== 'AbortError') toast(error.message || '操作失敗，請重新讀取。', 'error'); }
    finally { busy = false; trigger.removeAttribute('aria-busy'); trigger.removeAttribute('aria-disabled'); }
  }, { variant }); return trigger;
}
export async function mountContractDeadlines(container, { isCurrent = () => true } = {}) {
  const startContext = getContext(), startIdentity = identity(), startHash = location.hash;
  const alive = () => container.isConnected && isCurrent() && getContext() === startContext && identity() === startIdentity && location.hash === startHash;
  if (!['admin', 'supervisor'].includes(startContext.role)) { const error = Object.assign(new Error('只有管理者與督導可使用契約期限提醒。'), { status: 403 }); container.replaceChildren(errorState(error)); return; }
  let page = 1, query = '', status = '', filters = { asOf: today() }, sequence = 0, controller;
  const body = el('div', { class: 'list-content', 'aria-live': 'polite' }), footer = el('div', { class: 'list-footer' });
  const dateNotice = notice('');
  const setDateNotice = () => { dateNotice.textContent = `明確比對日期：${filters.asOf}；${contractDeadlineWorkStates[filters.workState] || '所有人工期限分類'}${filters.dueFrom ? `；人工應完成期間 ${filters.dueFrom} 至 ${filters.dueTo}` : ''}。分類只依人工應完成日；不代表契約法律效力。`; };
  const read = async (id, signal, current) => { const result = checkContractDeadlineRecord(await api(`/api/${entity}/${encodeURIComponent(id)}`, { signal }), { id, orgId: org() }); if (!current()) abort(); return result; };
  const readContract = async (id, signal, current) => { const result = checkContractsTasksRecord(await api(`/api/case-contracts/${encodeURIComponent(id)}`, { signal }), { entity: 'case-contracts', id, orgId: org() }); if (!current()) abort(); return result; };
  const references = async (kind, signal, current) => {
    const items = [], ids = new Set(); let total;
    for (let p = 1; p <= 100; p++) {
      const result = await api(`/api/${kind}?page=${p}&pageSize=100`, { signal }); if (!current()) abort();
      if (!Array.isArray(result.items) || result.page !== p || result.pageSize !== 100 || !Number.isSafeInteger(result.total) || result.total < 0 || result.items.length > 100 || total !== undefined && total !== result.total) throw new Error('同機構來源分頁已變動，請重新核對。');
      total = result.total;
      for (const raw of result.items) {
        const item = kind === 'case-contracts' ? checkContractsTasksRecord({ item: raw }, { entity: kind, orgId: org() }) : raw;
        if (!item || item.orgId !== org() || typeof item.id !== 'string' || !item.id || ids.has(item.id) || kind === 'employees' && (typeof item.name !== 'string' || typeof item.employeeNo !== 'string' || !['active', 'inactive'].includes(item.status))) throw new Error('同機構來源身份無法確認。');
        ids.add(item.id); items.push(item);
      }
      if (items.length === total) return items;
      if (!result.items.length || items.length > total) throw new Error('同機構來源資料不完整。');
    }
    throw new Error('同機構來源超過10000筆，請先整理資料。');
  };
  const employeeName = async (id, signal, current) => {
    const result = await api(`/api/employees/${encodeURIComponent(id)}`, { signal }); if (!current()) abort();
    const item = result.item;
    if (!item || item.id !== id || item.orgId !== org() || typeof item.name !== 'string' || typeof item.employeeNo !== 'string') throw new Error('受指派員工目前名稱無法確認。');
    return `${item.name} · ${item.employeeNo}`;
  };
  const actionRead = async (trigger, action, parentCurrent = alive) => {
    const request = new AbortController(), current = () => parentCurrent() && (!trigger || trigger.isConnected);
    const invalidate = () => { if (!current()) request.abort(); }, observer = new MutationObserver(invalidate);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
    window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
    try { if (current()) await action(request.signal, current); }
    finally { request.abort(); observer.disconnect(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate); }
  };
  const edit = (row, trigger, owner) => actionRead(trigger, async (signal, current) => {
    const existing = row ? await read(row.id, signal, current) : undefined;
    if (existing && (existing.version !== row.version || existing.status !== row.status)) throw new Error('提醒已更新，請重新讀取再編輯。');
    let source;
    if (!existing) {
      const contracts = (await references('case-contracts', signal, current)).filter(item => item.status === 'active');
      if (!contracts.length) throw new Error('目前沒有可選的已記錄生效契約，請先核對契約資料。');
      const selection = await openForm({ title: '選擇人工提醒來源契約', submitLabel: '核對此契約', isCurrent: current,
        fields: [{ name: 'contractId', label: '目前已記錄生效契約', type: 'select', required: true, options: contracts.map(item => ({ value: item.id, label: `${item.number} · ${item.title} · 結束 ${item.endDate}` })), help: manualNotice }],
        onSubmit: async values => { if (!contracts.some(item => item.id === values.contractId)) throw new Error('請選擇完整且可讀的來源契約。'); } });
      if (!selection || !current()) return;
      const parent = await readContract(selection.contractId, signal, current);
      if (parent.status !== 'active') throw new Error('來源已不再是生效契約，請重新核對。');
      source = Object.fromEntries(contractDeadlineSnapshotFields.map(key => [key, parent[key]])); if (!contractDeadlineSnapshotValid(source)) throw new Error('來源契約快照無法確認。');
    }
    const employees = (await references('employees', signal, current)).map(item => ({ value: item.id, label: `${item.name} · ${item.employeeNo}`, active: item.status === 'active' }));
    const editor = createContractDeadlineEditor({ existing, source, employees }); let key = crypto.randomUUID(), signature, didWrite = false;
    const saved = await openForm({ title: existing ? '編輯契約期限提醒' : '新增契約期限提醒', fields: editor.fields, initial: editor.initial, submitLabel: '儲存人工提醒', isCurrent: current,
      onSubmit: async (values, formOwner) => {
        const payload = editor.buildPayload(values); if (existing && !Object.keys(payload).length) return;
        const sent = existing ? { ...payload, version: existing.version } : payload, next = JSON.stringify(sent);
        if (signature !== undefined && signature !== next) key = crypto.randomUUID(); signature = next;
        const response = await api(`/api/${entity}${existing ? '/' + encodeURIComponent(existing.id) : ''}`, { method: existing ? 'PATCH' : 'POST', body: sent, headers: { 'Idempotency-Key': key }, signal: formOwner.signal });
        if (!formOwner.isCurrent()) abort(); checkContractDeadlineRecord(response, { id: existing?.id, orgId: org(), original: existing, payload }); didWrite = true;
      } });
    if (saved && current()) { if (owner) await owner.reload(); else await load(); if ((owner ? owner.isCurrent() : alive()) && didWrite) toast('已保存人工契約提醒', 'success'); }
  }, owner?.isCurrent || alive);
  const transition = (row, target, trigger, owner) => actionRead(trigger, async (signal, current) => {
    const original = await read(row.id, signal, current);
    if (original.version !== row.version || original.status !== row.status) throw new Error('提醒已更新，請重新讀取再處理。');
    const editor = createContractDeadlineTransitionEditor(original, target), operation = { in_progress: '開始人工處理', completed: '人工完成提醒', cancelled: '取消人工提醒' }[target];
    const saved = await openForm({ title: operation, submitLabel: '核對並保存本次處理', fields: editor.fields, initial: editor.initial, isCurrent: current,
      onSubmit: async (values, formOwner) => {
        const payload = editor.buildPayload(values), confirmed = await confirmAction({ title: `確認${operation}？`, message: `${original.title}。${manualNotice}${target === 'completed' || target === 'cancelled' ? '本次處理後提醒鎖定。' : ''}`,
          confirmLabel: `確認${operation}`, danger: target === 'cancelled', signal: formOwner.signal, isCurrent: formOwner.isCurrent });
        if (!confirmed) throw new Error('尚未確認本次人工處理，輸入仍保留。');
        const response = await api(`/api/${entity}/${encodeURIComponent(original.id)}`, { method: 'PATCH', body: { ...payload, version: original.version }, signal: formOwner.signal });
        if (!formOwner.isCurrent()) abort(); checkContractDeadlineRecord(response, { id: original.id, orgId: org(), original, payload });
      } });
    if (saved && owner.isCurrent()) { await owner.reload(); if (owner.isCurrent()) toast('已保存本次人工處理', 'success'); }
  }, owner.isCurrent);
  const details = async (row, trigger, request) => {
    await openDetails({ title: '契約期限提醒完整紀錄', wide: true, guardedRead: true, isCurrent: () => alive() && trigger.isConnected && sequence === request,
      load: async (signal, owner) => {
        const item = await read(row.id, signal, owner.isCurrent), parent = await readContract(item.contractId, signal, owner.isCurrent), name = await employeeName(item.assigneeEmployeeId, signal, owner.isCurrent);
        const actions = el('div', { class: 'actions' });
        if (item.status === 'pending') actions.append(actionButton('開始處理', next => transition(item, 'in_progress', next, owner), 'primary'));
        if (item.status === 'in_progress') actions.append(actionButton('完成提醒', next => transition(item, 'completed', next, owner), 'primary'));
        if (['pending', 'in_progress'].includes(item.status)) actions.append(actionButton('取消提醒', next => transition(item, 'cancelled', next, owner), 'danger'));
        return el('section', {}, notice(manualNotice), notice(`來源目前狀態：${contractStatuses[parent.status]}；建立時來源版次 ${item.contractVersion}。目前來源狀態不會自動改變提醒。`),
          el('dl', { class: 'detail-grid' }, contractDeadlineFields.filter(key => key !== 'contractSnapshot').map(key => field(contractDeadlineLabels[key], key === 'contractId' ? `${item.contractSnapshot.number} · ${item.contractSnapshot.title}`
            : key === 'contractVersion' ? String(item[key]) : key === 'assigneeEmployeeId' ? name : key === 'status' ? contractDeadlineStatuses[item.status] : key === 'priority' ? contractDeadlinePriorities[item.priority] : item[key], ['content', 'note', 'result', 'statusReason'].includes(key))),
          field('建立時契約開始日期', item.contractSnapshot.startDate), field('建立時契約結束日期', item.contractSnapshot.endDate), field('明確比對日期', filters.asOf),
          field('人工期限分類', contractDeadlineWorkStates[contractDeadlineWorkState(item, filters.asOf)]), field('保存版次', String(item.version)), field('建立時間', item.createdAt), field('最近保存時間', item.updatedAt)),
          el('div', { class: 'actions' }, el('a', { class: 'btn btn-outline', href: '#/case-contracts' }, '查看契約工作區')), actions);
      } });
    if (alive() && sequence === request) await load();
  };
  const setFilters = trigger => actionRead(trigger, async (_signal, current) => {
    const saved = await openForm({ title: '明確指定期限工作清單', submitLabel: '套用唯讀查詢', isCurrent: current, initial: { asOf: filters.asOf, workState: filters.workState || '', dueFrom: filters.dueFrom || '', dueTo: filters.dueTo || '', priority: filters.priority || '' },
      fields: [{ name: 'asOf', label: '明確比對日期', type: 'date', required: true, help: '只依人工應完成日分類，不代表契約自動到期或法律效力。' },
        { name: 'workState', label: '人工期限分類', type: 'select', options: [{ value: '', label: '全部人工期限分類' }, ...options(contractDeadlineWorkStates)] },
        { name: 'dueFrom', label: '人工應完成起日', type: 'date' }, { name: 'dueTo', label: '人工應完成迄日', type: 'date', help: '期間須成對依序，最多366日含端。' },
        { name: 'priority', label: '優先程度', type: 'select', options: [{ value: '', label: '全部優先程度' }, ...options(contractDeadlinePriorities)] }],
      onSubmit: async values => {
        if (!contractDeadlineDate(values.asOf) || ['dueFrom', 'dueTo'].some(key => values[key] && !contractDeadlineDate(values[key])) || !!values.dueFrom !== !!values.dueTo
          || values.dueFrom && (values.dueTo < values.dueFrom || Date.parse(values.dueTo) - Date.parse(values.dueFrom) > 365 * 86400000)) throw new Error('請核對明確日期與成對且有界的期間。');
        if (values.workState && !Object.hasOwn(contractDeadlineWorkStates, values.workState) || values.priority && !Object.hasOwn(contractDeadlinePriorities, values.priority)) throw new Error('查詢分類無法確認。');
      } });
    if (!saved || !current()) return; filters = Object.fromEntries(Object.entries(saved).filter(([, value]) => value)); page = 1; setDateNotice(); await load();
  });
  const load = async () => {
    if (!alive()) return; const request = ++sequence; controller?.abort(); controller = new AbortController(); body.dataset.renderVersion = `${entity}:${request}`;
    body.replaceChildren(el('p', { class: 'loading', role: 'status' }, '正在讀取契約期限提醒…')); footer.replaceChildren();
    const params = new URLSearchParams({ page: String(page), pageSize: '25', ...filters }); if (query) params.set('q', query); if (status) params.set('status', status);
    try {
      const result = await api(`/api/${entity}?${params}`, { signal: controller.signal }); if (!alive() || sequence !== request) return;
      if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0 || result.page !== page || result.pageSize !== 25 || result.items.length > 25) throw new Error('契約提醒清單分頁無法確認。');
      const items = result.items.map(item => checkContractDeadlineRecord({ item }, { orgId: org() })), names = new Map();
      if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('契約提醒清單身份重複。');
      if (page > 1 && !items.length && result.total) { page = Math.ceil(result.total / 25); return load(); }
      for (const item of items) if (!names.has(item.assigneeEmployeeId)) names.set(item.assigneeEmployeeId, await employeeName(item.assigneeEmployeeId, controller.signal, () => alive() && sequence === request));
      if (!alive() || sequence !== request) return;
      body.replaceChildren(table([{ key: 'title', label: '提醒標題' }, { label: '來源契約', render: row => `${row.contractSnapshot.number} · ${row.contractSnapshot.title}` },
        { label: '受指派員工', render: row => names.get(row.assigneeEmployeeId) }, { key: 'dueDate', label: '人工應完成日期' },
        { label: '指定日分類', render: row => contractDeadlineWorkStates[contractDeadlineWorkState(row, filters.asOf)] }, { label: '優先程度', render: row => contractDeadlinePriorities[row.priority] },
        { label: '提醒狀態', render: row => { const node = badge(row.status); node.textContent = contractDeadlineStatuses[row.status]; return node; } },
        { label: '操作', render: row => { const actions = el('div', { class: 'actions row-actions' }); actions.append(actionButton('查看紀錄', trigger => details(row, trigger, request)));
          if (['pending', 'in_progress'].includes(row.status)) actions.append(actionButton('編輯提醒', trigger => edit(row, trigger)));
          actions.append(actionButton('版本歷程', trigger => openRecordHistory({ entity, id: row.id, lookups: { employees: new Map([...names].map(([id, name]) => [id, { name }])) }, isCurrent: () => alive() && trigger.isConnected && sequence === request }))); return actions; } }], items,
        { caption: '契約期限提醒工作清單', emptyText: '沒有符合條件的人工提醒；可調整查詢或由生效契約新增。' }));
      footer.replaceChildren(pagination({ page, pageSize: 25, total: result.total, onChange: next => { if (alive()) { page = next; void load(); } } }));
    } catch (error) { if (alive() && sequence === request && error.name !== 'AbortError') body.replaceChildren(errorState(error, load)); }
  };
  const statusId = `contract-reminder-status-${crypto.randomUUID()}`, select = el('select', { id: statusId, class: 'input' }, el('option', { value: '' }, '全部提醒狀態'), options(contractDeadlineStatuses).map(option => el('option', { value: option.value }, option.label)));
  select.addEventListener('change', () => { if (alive()) { status = select.value; page = 1; void load(); } });
  const toolbar = el('div', { class: 'toolbar' }, searchBox({ label: '搜尋契約提醒', placeholder: '搜尋提醒內容、結果或來源契約編號', onSearch: value => { if (alive()) { query = value; page = 1; void load(); } } }),
    el('label', { for: statusId, class: 'filter-field' }, el('span', {}, '提醒狀態'), select), actionButton('設定比對日期／期限', setFilters),
    actionButton('清除期間與分類', async () => { filters = { asOf: filters.asOf }; page = 1; setDateNotice(); await load(); }));
  toolbar.querySelector('input[type="search"]').maxLength = 200; setDateNotice();
  container.replaceChildren(pageHeader('契約期限提醒', '人工建立、指派與追蹤；來源契約快照及處理歷程保留', [actionButton('新增期限提醒', trigger => edit(null, trigger), 'primary')]),
    notice(manualNotice), el('section', { class: 'panel' }, toolbar, dateNotice, body, footer));
  const invalidate = () => { if (alive()) return; ++sequence; controller?.abort(); observer.disconnect(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate); };
  const observer = new MutationObserver(invalidate); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
  window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate); await load();
}
