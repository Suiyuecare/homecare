import { api, el, pageHeader, table, badge, button, openForm, confirmAction, openDetails, toast, today, getContext, searchBox, pagination, errorState } from '../ui.js';
import { openRecordHistory } from './history.js';
import { contractStatuses, internalTaskStatuses, priorities, expiryLabels, contractFields, internalTaskFields, checkContractsTasksRecord,
  createContractsTasksEditor, createContractsTasksTransitionEditor, contractExpiryForDisplay, contractsTasksDate } from '../data/contracts-tasks-editor.js';

const org = () => getContext().organizationId || getContext().orgId;
const identity = () => { const ctx = getContext(); return JSON.stringify([ctx.user?.id, org(), ctx.role, ctx.user?.employeeId || ctx.employeeId || '']); };
const abort = () => { throw new DOMException('操作已取消，請重新讀取確認保存狀態。', 'AbortError'); };
const managers = () => ['admin', 'supervisor'].includes(getContext().role);
const options = values => Object.entries(values).map(([value, label]) => ({ value, label }));
const notice = message => el('p', { class: 'notice', role: 'note' }, message);
const field = (label, value, wide = false) => el('div', { class: `detail-field${wide ? ' wide' : ''}` }, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value || '未填寫'));
const badgeFor = (status, names) => { const node = badge(status); node.textContent = names[status]; return node; };
const labels = { caseId: '契約個案', number: '契約編號', title: '標題', startDate: '開始日期', endDate: '結束日期', signedDate: '簽署日期', documentReference: '文件識別',
  sourceReference: '人工核對來源', renewedFromId: '原契約', status: '狀態', statusDate: '最近處理日期', statusReason: '處理原因', note: '備註',
  content: '待辦內容', assigneeEmployeeId: '受指派員工', dueDate: '應完成日期', priority: '優先程度', result: '完成結果' };
function actionButton(label, action, variant = 'outline') {
  let busy = false;
  const trigger = button(label, async () => {
    if (busy) return; busy = true; trigger.setAttribute('aria-busy', 'true'); trigger.setAttribute('aria-disabled', 'true');
    try { await action(trigger); } catch (error) { if (trigger.isConnected && error.name !== 'AbortError') toast(error.message || '操作失敗，請重新讀取。', 'error'); }
    finally { busy = false; trigger.removeAttribute('aria-busy'); trigger.removeAttribute('aria-disabled'); }
  }, { variant });
  return trigger;
}
async function referenceChoices(kind, signal, current) {
  const items = [], ids = new Set(); let total;
  for (let page = 1; page <= 100; page++) {
    const result = await api(`/api/${kind}?page=${page}&pageSize=100`, { signal });
    if (!current()) abort();
    if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0 || result.page !== page || result.pageSize !== 100 || result.items.length > 100
      || total !== undefined && total !== result.total) throw new Error('選項分頁已變動，請重新讀取。');
    total = result.total;
    for (const item of result.items) {
      const code = kind === 'cases' ? 'caseNo' : 'employeeNo';
      if (item.orgId !== org() || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || typeof item[code] !== 'string' || ids.has(item.id)) throw new Error('同機構選項無法確認。');
      ids.add(item.id); items.push(item);
    }
    if (items.length === total) return items;
    if (!result.items.length || items.length > total) throw new Error('選項清單不完整，請重新讀取。');
  }
  throw new Error('同機構選項超過10000筆，請先整理資料。');
}

export const mountCaseContracts = (container, options) => mountContractsTasks(container, 'case-contracts', options);
export const mountInternalTasks = (container, options) => mountContractsTasks(container, 'internal-tasks', options);

export async function mountContractsTasks(container, entity, { isCurrent = () => true } = {}) {
  const contract = entity === 'case-contracts';
  if (!contract && entity !== 'internal-tasks') throw new Error('不支援此作業入口。');
  const startedContext = getContext(), startedIdentity = identity(), startedHash = location.hash;
  const alive = () => container.isConnected && isCurrent() && getContext() === startedContext && identity() === startedIdentity && location.hash === startedHash;
  if (!['admin', 'supervisor', 'finance', 'caregiver'].includes(getContext().role) || contract && !managers()) {
    const error = new Error('您沒有此項契約或內部待辦操作權限。'); error.status = 403; container.replaceChildren(errorState(error)); return;
  }
  const title = contract ? '個案契約與期限' : '內部待辦', statuses = contract ? contractStatuses : internalTaskStatuses;
  let page = 1, query = '', status = '', dateQuery = {}, sequence = 0, controller;
  const body = el('div', { class: 'list-content', 'aria-live': 'polite' }), footer = el('div', { class: 'list-footer' });
  const dateNotice = el('p', { class: 'notice', role: 'note' }, '尚未指定日期查詢；目前列出所有可讀紀錄。');
  const readItem = async (id, signal, current) => {
    const item = checkContractsTasksRecord(await api(`/api/${entity}/${encodeURIComponent(id)}`, { signal }), { entity, id, orgId: org() });
    if (!current()) abort(); return item;
  };
  const actionRead = async (trigger, action, parentCurrent = alive) => {
    const request = new AbortController(), current = () => parentCurrent() && (!trigger || trigger.isConnected);
    const invalidate = () => { if (!current()) request.abort(); };
    const observer = new MutationObserver(invalidate); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
    window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
    try { if (current()) await action(request.signal, current); }
    finally { request.abort(); observer.disconnect(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate); }
  };
  const referenceName = async (kind, id, signal, current) => {
    const result = await api(`/api/${kind}/${encodeURIComponent(id)}`, { signal }), item = result.item;
    if (!current()) abort();
    if (!item || item.id !== id || item.orgId !== org() || typeof item.name !== 'string' || typeof item[kind === 'cases' ? 'caseNo' : 'employeeNo'] !== 'string') throw new Error('目前同機構關聯名稱無法確認。');
    return `${item.name} · ${item[kind === 'cases' ? 'caseNo' : 'employeeNo']}`;
  };
  const edit = (row, trigger, { renewal: renewing = false, owner } = {}) => actionRead(trigger, async (signal, current) => {
    if (!managers()) throw new Error('只有管理者或督導可維護紀錄。');
    const source = row ? await readItem(row.id, signal, current) : undefined, renewal = renewing ? source : undefined, existing = renewing ? undefined : source;
    if (source && (source.version !== row.version || source.status !== row.status)) throw new Error('紀錄已更新，請重新讀取後操作。');
    const references = renewing ? [] : (await referenceChoices(contract ? 'cases' : 'employees', signal, current))
      .filter(item => contract || item.status === 'active' || item.id === existing?.assigneeEmployeeId)
      .map(item => ({ value: item.id, label: `${item.name} · ${item[contract ? 'caseNo' : 'employeeNo']}${item.status === 'inactive' ? '（已停用，僅保留既有指派）' : ''}` }));
    const editor = createContractsTasksEditor({ entity, existing, references, renewal });
    let key = crypto.randomUUID(), signature, didWrite = false;
    const saved = await openForm({ title: renewing ? '建立續約草稿' : existing ? contract ? '編輯契約草稿' : '編輯內部待辦' : contract ? '新增契約草稿' : '新增內部待辦',
      fields: editor.fields, initial: editor.initial, submitLabel: renewing ? '儲存新續約草稿' : '儲存紀錄', isCurrent: current,
      onSubmit: async (values, formOwner) => {
        const payload = editor.buildPayload(values); if (existing && !Object.keys(payload).length) return;
        const sent = existing ? { ...payload, version: existing.version } : payload, next = JSON.stringify(sent);
        if (signature !== undefined && signature !== next) key = crypto.randomUUID(); signature = next;
        const response = await api(`/api/${entity}${existing ? '/' + encodeURIComponent(existing.id) : ''}`, { method: existing ? 'PATCH' : 'POST', body: sent, headers: { 'Idempotency-Key': key }, signal: formOwner.signal });
        if (!formOwner.isCurrent()) abort(); checkContractsTasksRecord(response, { entity, id: existing?.id, orgId: org(), original: existing, payload }); didWrite = true;
      } });
    if (saved && current()) {
      if (owner) { await owner.reload(); if (owner.isCurrent() && didWrite) toast(renewing ? '已儲存新續約草稿，原契約保留' : '已儲存紀錄', 'success'); }
      else { await load(); if (alive() && didWrite) toast('已儲存紀錄', 'success'); }
    }
  }, owner?.isCurrent || alive);
  const transition = (row, target, trigger, owner) => actionRead(trigger, async (signal, current) => {
    const original = await readItem(row.id, signal, current);
    if (original.version !== row.version || original.status !== row.status) throw new Error('紀錄已更新，請重新讀取後操作。');
    const editor = createContractsTasksTransitionEditor(entity, original, target);
    const operation = contract ? { active: '記錄契約生效', terminated: '人工終止契約', expired: '人工處理到期', cancelled: '取消契約草稿' }[target]
      : { in_progress: '開始處理待辦', completed: '完成待辦', cancelled: '取消待辦' }[target];
    const saved = await openForm({ title: operation, submitLabel: '核對並儲存處理', fields: editor.fields, initial: editor.initial, isCurrent: current,
      onSubmit: async (values, formOwner) => {
        const payload = editor.buildPayload(values);
        const confirmed = await confirmAction({ title: `確認${operation}？`, message: `${original.title}。${contract ? '這是公司人工管理紀錄，不推定契約法律效力；生效內容與結束紀錄鎖定，續約另建新紀錄。' : '這是內部待辦紀錄，完成或取消後鎖定，不會發送外部通知。'}`,
          confirmLabel: `確認${operation}`, danger: ['cancelled', 'terminated'].includes(target), signal: formOwner.signal, isCurrent: formOwner.isCurrent });
        if (!confirmed) throw new Error('尚未確認本次處理，輸入仍保留。');
        const response = await api(`/api/${entity}/${encodeURIComponent(original.id)}`, { method: 'PATCH', body: { ...payload, version: original.version }, signal: formOwner.signal });
        if (!formOwner.isCurrent()) abort(); checkContractsTasksRecord(response, { entity, id: original.id, orgId: org(), original, payload });
      } });
    if (saved && owner.isCurrent()) { await owner.reload(); if (owner.isCurrent()) toast(`已${operation}`, 'success'); }
  }, owner.isCurrent);
  const details = async (row, trigger, request) => {
    const current = () => alive() && trigger.isConnected && sequence === request;
    await openDetails({ title: contract ? '契約完整紀錄' : '內部待辦完整紀錄', wide: true, guardedRead: true, isCurrent: current,
      load: async (signal, owner) => {
        const item = await readItem(row.id, signal, owner.isCurrent), refKey = contract ? 'caseId' : 'assigneeEmployeeId';
        const name = await referenceName(contract ? 'cases' : 'employees', item[refKey], signal, owner.isCurrent);
        let previousNumber = '';
        if (contract && item.renewedFromId) { const previous = await readItem(item.renewedFromId, signal, owner.isCurrent); previousNumber = `${previous.number} · ${previous.title}`; }
        const actions = el('div', { class: 'actions' });
        if (managers()) {
          if (contract && item.status === 'draft') actions.append(actionButton('記錄生效', trigger => transition(item, 'active', trigger, owner), 'primary'), actionButton('取消草稿', trigger => transition(item, 'cancelled', trigger, owner), 'danger'));
          if (contract && item.status === 'active') actions.append(actionButton('人工終止', trigger => transition(item, 'terminated', trigger, owner)), actionButton('人工到期處理', trigger => transition(item, 'expired', trigger, owner)));
          if (contract && ['active', 'terminated', 'expired'].includes(item.status)) actions.append(actionButton('建立續約草稿', trigger => edit(item, trigger, { renewal: true, owner })));
          if (!contract && item.status === 'pending') actions.append(actionButton('開始處理', trigger => transition(item, 'in_progress', trigger, owner), 'primary'));
          if (!contract && item.status === 'in_progress') actions.append(actionButton('完成待辦', trigger => transition(item, 'completed', trigger, owner), 'primary'));
          if (!contract && ['pending', 'in_progress'].includes(item.status)) actions.append(actionButton('取消待辦', trigger => transition(item, 'cancelled', trigger, owner), 'danger'));
        }
        return el('section', {}, notice(contract ? '本頁保存公司人工契約紀錄，不推定法律效力；日期查詢不會自動到期、發訊息或修改資料。' : '僅內部待辦；受指派員工可看本人任務，管理者或督導保存處理結果，不提供代理操作或外部通知。'),
          el('dl', { class: 'detail-grid' }, (contract ? contractFields : internalTaskFields).map(key => field(labels[key], key === refKey ? name : key === 'renewedFromId' ? previousNumber
            : key === 'status' ? statuses[item.status] : key === 'priority' ? priorities[item.priority] : item[key], ['content', 'note', 'sourceReference', 'statusReason', 'result'].includes(key))),
            field('保存版次', String(item.version)), field('建立時間', item.createdAt), field('最近保存時間', item.updatedAt)), actions);
      } });
    if (alive() && sequence === request) await load();
  };
  const queryDates = trigger => actionRead(trigger, async (_signal, current) => {
    const names = contract ? ['asOf', 'expiry', 'expiryFrom', 'expiryTo'] : ['dueFrom', 'dueTo'];
    const saved = await openForm({ title: contract ? '查詢契約效期與結束期間' : '查詢待辦應完成期間', submitLabel: '查詢清單', isCurrent: current,
      initial: Object.fromEntries(names.map(name => [name, dateQuery[name] || ''])), fields: contract ? [
        { name: 'asOf', label: '明確指定比對日期', type: 'date', required: true, help: '依目前生效狀態及保存起迄比對，不代表此日歷史法律效力。' },
        { name: 'expiry', label: '生效契約日期比對', type: 'select', options: options({ not_started: expiryLabels.not_started, within_term: expiryLabels.within_term, past_end: expiryLabels.past_end }), placeholder: '不限制比對分類' },
        { name: 'expiryFrom', label: '保存結束日期起日', type: 'date', help: '期間選填；起訖須成對且最多366日含端。' }, { name: 'expiryTo', label: '保存結束日期迄日', type: 'date' }
      ] : [{ name: 'dueFrom', label: '應完成日期起日', type: 'date', required: true }, { name: 'dueTo', label: '應完成日期迄日', type: 'date', required: true }],
      onSubmit: async values => {
        const from = contract ? 'expiryFrom' : 'dueFrom', to = contract ? 'expiryTo' : 'dueTo';
        for (const name of names.filter(name => name !== 'expiry')) if (values[name] && !contractsTasksDate(values[name])) { const error = new Error('請提供有效完整日期。'); error.fields = { [name]: error.message }; throw error; }
        if (contract && !values.asOf || !!values[from] !== !!values[to] || values[from] && (values[to] < values[from] || Date.parse(values[to]) - Date.parse(values[from]) > 365 * 86400000)) throw new Error('請核對明確日期；期間起訖須成對、依序且最多366日含端。');
      } });
    if (!saved || !current()) return;
    dateQuery = Object.fromEntries(Object.entries(saved).filter(([, value]) => value)); page = 1;
    dateNotice.textContent = contract ? `指定比對日：${dateQuery.asOf}；${expiryLabels[dateQuery.expiry] || '所有目前狀態'}${dateQuery.expiryFrom ? `；結束期間 ${dateQuery.expiryFrom} 至 ${dateQuery.expiryTo}` : ''}。只查詢，不自動處理到期。`
      : `應完成期間：${dateQuery.dueFrom} 至 ${dateQuery.dueTo}。只查詢，不會自動完成或發通知。`;
    await load();
  });
  const load = async () => {
    if (!alive()) return; const request = ++sequence; controller?.abort(); controller = new AbortController(); body.dataset.renderVersion = `${entity}:${request}`;
    body.replaceChildren(el('p', { class: 'loading', role: 'status' }, '正在讀取保存紀錄…')); footer.replaceChildren();
    const params = new URLSearchParams({ page: String(page), pageSize: '25', ...dateQuery }); if (query) params.set('q', query); if (status) params.set('status', status);
    try {
      const result = await api(`/api/${entity}?${params}`, { signal: controller.signal }); if (!alive() || sequence !== request) return;
      if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0 || result.page !== page || result.pageSize !== 25 || result.items.length > 25) throw new Error('清單分頁無法確認。');
      const items = result.items.map(item => checkContractsTasksRecord({ item }, { entity, orgId: org() })), names = new Map(), refKey = contract ? 'caseId' : 'assigneeEmployeeId';
      if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('清單識別重複，請重新讀取。');
      if (page > 1 && !items.length && result.total) { page = Math.ceil(result.total / 25); return load(); }
      for (const item of items) if (!names.has(item[refKey])) names.set(item[refKey], await referenceName(contract ? 'cases' : 'employees', item[refKey], controller.signal, () => alive() && sequence === request));
      if (!alive() || sequence !== request) return;
      body.replaceChildren(table([{ key: 'title', label: '標題' }, ...(contract ? [{ key: 'number', label: '契約編號' }] : []), { label: contract ? '個案' : '受指派員工', render: row => names.get(row[refKey]) },
        ...(contract ? [{ key: 'startDate', label: '開始日期' }, { key: 'endDate', label: '結束日期' }, ...(dateQuery.asOf ? [{ label: '指定日比對', render: row => expiryLabels[contractExpiryForDisplay(row, dateQuery.asOf)] }] : [])]
          : [{ key: 'dueDate', label: '應完成日期' }, { label: '優先程度', render: row => priorities[row.priority] }]), { label: '狀態', render: row => badgeFor(row.status, statuses) },
        { label: '操作', render: row => { const actions = el('div', { class: 'actions row-actions' }); actions.append(actionButton('查看紀錄', trigger => details(row, trigger, request)));
          if (managers() && (contract ? row.status === 'draft' : ['pending', 'in_progress'].includes(row.status))) actions.append(actionButton(contract ? '編輯草稿' : '編輯待辦', trigger => edit(row, trigger)));
          actions.append(actionButton('版本歷程', trigger => openRecordHistory({ entity, id: row.id,
            lookups: { [contract ? 'cases' : 'employees']: new Map([...names].map(([id, name]) => [id, { name }])) },
            isCurrent: () => alive() && trigger.isConnected && sequence === request }))); return actions; } }], items,
        { caption: title, emptyText: query || status || Object.keys(dateQuery).length ? '沒有符合條件的紀錄，請調整查詢。' : managers() ? '尚無紀錄，請先新增。' : '目前沒有可讀的本人待辦；帳號需有同機構員工連結。' }));
      footer.replaceChildren(pagination({ page, pageSize: 25, total: result.total, onChange: next => { if (alive()) { page = next; void load(); } } }));
    } catch (error) { if (alive() && sequence === request && error.name !== 'AbortError') body.replaceChildren(errorState(error, load)); }
  };
  const statusId = `contracts-tasks-status-${crypto.randomUUID()}`, select = el('select', { id: statusId, class: 'input' }, el('option', { value: '' }, '全部狀態'), options(statuses).map(option => el('option', { value: option.value }, option.label)));
  select.addEventListener('change', () => { if (alive()) { status = select.value; page = 1; void load(); } });
  const toolbar = el('div', { class: 'toolbar' }, searchBox({ label: contract ? '搜尋契約' : '搜尋待辦', placeholder: contract ? '搜尋契約編號、標題或人工依據' : '搜尋標題、內容或結果', onSearch: value => { if (alive()) { query = value; page = 1; void load(); } } }),
    el('label', { for: statusId, class: 'filter-field' }, el('span', {}, '狀態'), select), actionButton(contract ? '查詢效期／期限' : '查詢應完成期間', queryDates),
    actionButton('清除日期查詢', async () => { dateQuery = {}; page = 1; dateNotice.textContent = '尚未指定日期查詢；目前列出所有可讀紀錄。'; await load(); }));
  toolbar.querySelector('input[type="search"]').maxLength = 200;
  container.replaceChildren(pageHeader(title, contract ? '保存契約、人工處理狀態，續約另建紀錄' : managers() ? '指派同機構員工並保存人工處理結果' : '查看目前指派給本人的內部待辦', managers() ? [actionButton(contract ? '新增契約草稿' : '新增內部待辦', trigger => edit(null, trigger), 'primary')] : []),
    notice(contract ? '人工契約管理不推定法律效力；指定日期查詢不會自動到期或發通知。' : '僅內部待辦。管理者與督導維護；財務與居服員只讀本人指派，不提供代理或外部通知。'), el('section', { class: 'panel' }, toolbar, dateNotice, body, footer));
  const invalidate = () => { if (alive()) return; ++sequence; controller?.abort(); observer.disconnect(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate); };
  const observer = new MutationObserver(invalidate); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
  window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate); await load();
}
