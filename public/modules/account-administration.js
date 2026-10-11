import { api, el, pageHeader, table, badge, button, openForm, openDetails, confirmAction, getContext, searchBox, pagination, errorState, toast } from '../ui.js';
import { accountRoles, accountStatuses, confirmAccount, confirmAccountList, buildAccountChange, confirmAccountChange, confirmAccountHistory } from '../data/account-administration-core.js';
const options = values => Object.entries(values).map(([value, label]) => ({ value, label }));
const identity = () => { const c = getContext(); return JSON.stringify([c.user?.id, c.organizationId || c.orgId, c.role, c.user?.employeeId || c.employeeId || '']); };
const stateBadge = row => { const node = badge(row.status); node.textContent = accountStatuses[row.status]; return node; };
function action(label, run) {
  const trigger = button(label, async () => {
    if (trigger.disabled) return;
    trigger.disabled = true; trigger.setAttribute('aria-busy', 'true');
    try { await run(trigger); }
    catch (error) { if (trigger.isConnected && error.name !== 'AbortError') toast(error.message, 'error'); }
    finally { trigger.disabled = false; trigger.removeAttribute('aria-busy'); }
  }, { variant: 'outline' }); return trigger;
}
function filter(label, values, changed) {
  const id = 'account-filter-' + crypto.randomUUID();
  const select = el('select', { id, class: 'input' }, el('option', { value: '' }, `全部${label}`), options(values).map(o => el('option', { value: o.value }, o.label)));
  select.addEventListener('change', () => changed(select.value));
  return el('label', { class: 'filter-field', for: id }, el('span', {}, label), select);
}
async function employeeChoices(orgId, signal, current) {
  const rows = [], ids = new Set();
  for (let page = 1; page <= 100; page++) {
    const result = await api(`/api/employees?page=${page}&pageSize=100`, { signal });
    if (!current()) throw new DOMException('操作已取消。', 'AbortError');
    if (!Array.isArray(result?.items) || !Number.isSafeInteger(result.total) || result.total < 0
        || result.items.length > 100 || result.items.some(row => row.orgId !== orgId || typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.status !== 'string' || ids.has(row.id)))
      throw new Error('員工選項無法確認，請重新讀取。');
    for (const row of result.items) { ids.add(row.id); rows.push(row); }
    if (rows.length >= result.total) return rows;
    if (!result.items.length) throw new Error('員工選項不完整，請重新讀取。');
  }
  throw new Error('員工選項超過可管理範圍，請聯絡管理者。');
}
export async function mountAccountAdministration(container, { isCurrent = () => true } = {}) {
  const context = getContext(), stamp = identity(), hash = location.hash;
  const alive = () => container.isConnected && isCurrent() && getContext() === context && identity() === stamp && location.hash === hash;
  if (context.role !== 'admin') { const error = new Error('僅本機構管理者可管理帳號。'); error.status = 403; container.replaceChildren(errorState(error)); return; }
  const scope = { orgId: context.organizationId || context.orgId, userId: context.user.id };
  let page = 1, q = '', role = '', status = '', sequence = 0, controller;
  const list = el('div', { class: 'list-content', 'aria-live': 'polite' }), footer = el('div', { class: 'list-footer' });
  const details = (row, history = false) => openDetails({ title: history ? `${row.name} · 帳號授權歷程` : `${row.name} · 帳號資料`, guardedRead: true, wide: true, isCurrent: alive,
    load: async (signal, owner) => {
      const result = await api(`/api/account-administration/${encodeURIComponent(row.id)}${history ? '/history' : ''}`, { signal });
      if (!alive() || !owner.isCurrent()) throw new DOMException('操作已取消。', 'AbortError');
      if (history) {
        const saved = confirmAccountHistory(result, { ...scope, id: row.id });
        return el('section', {}, el('p', { class: 'notice' }, '首次變更會保存既有授權基準；其後每次變更保存原因與版本。'),
          table([{ label: '版本', render: r => `第 ${r.version} 版${r.source === 'account.baseline' ? '（既有基準）' : ''}` },
            { label: '時間', render: r => new Date(r.createdAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) },
            { label: '角色', render: r => accountRoles[r.snapshot.role] }, { label: '帳號狀態', render: r => accountStatuses[r.snapshot.status] },
            { label: '員工連結', render: r => r.snapshot.employeeId || '未連結' },
            { label: '操作者', render: r => r.snapshot.changedBy || '既有授權基準' }, { label: '原因', render: r => r.snapshot.reason }], saved.items,
          { emptyText: '尚未變更授權；目前使用既有帳號基準。', caption: '帳號授權版本歷程' }));
      }
      const item = confirmAccount(result.item, { ...scope, id: row.id });
      const pairs = [['姓名', item.name], ['電子信箱', item.email], ['角色', accountRoles[item.role]], ['帳號狀態', accountStatuses[item.status]],
        ['員工連結', item.employeeName || (item.employeeId ? '目前員工名稱未確認' : '未連結')], ['員工狀態', item.employeeStatus === 'active' ? '在職／有效' : item.employeeStatus || '未連結'],
        ['公司登入綁定', item.portalBound ? (item.bindingActive ? '有效綁定' : '綁定已停用') : '尚未綁定'], ['保存版本', item.version ? `第 ${item.version} 版` : '既有授權基準']];
      return el('dl', { class: 'detail-grid' }, pairs.map(([label, value]) => el('div', {}, el('dt', {}, label), el('dd', {}, value))));
    } });
  const edit = async (row, trigger) => {
    if (!alive() || !row.canManage) return;
    const current = () => alive() && trigger.isConnected;
    const item = confirmAccount((await api(`/api/account-administration/${encodeURIComponent(row.id)}`)).item, { ...scope, id: row.id });
    if (!current()) return;
    const employees = await employeeChoices(scope.orgId, undefined, current);
    if (!current()) return;
    const choices = employees.filter(e => e.status === 'active').map(e => ({ value: e.id, label: `${e.name} · ${e.employeeNo || '有效員工'}` }));
    if (item.employeeId && !choices.some(e => e.value === item.employeeId)) choices.push({ value: item.employeeId, label: `${item.employeeName || '既有連結'} · 非有效員工；停用可保留，啟用須改選或解除` });
    let signature, key;
    const saved = await openForm({ title: `${item.name} · 變更帳號授權`, isCurrent: current, returnSubmitResult: true,
      fields: [{ name: 'role', label: '角色', type: 'select', required: true, options: options(accountRoles) },
        { name: 'employeeId', label: '員工連結', type: 'select', options: choices, placeholder: '不連結員工', help: '居服員必須連結本機構有效員工；其他角色可不連結。' },
        { name: 'status', label: '帳號狀態', type: 'select', required: true, options: options(accountStatuses) },
        { name: 'reason', label: '變更原因', type: 'textarea', required: true, maxLength: 1000, help: '原因會保存於授權歷程；變更後會撤銷這個帳號現有的登入。' }],
      initial: { role: item.role, employeeId: item.employeeId || '', status: item.status, reason: '' },
      onSubmit: async (values, owner) => {
        const payload = buildAccountChange(values, item.version);
        if (payload.role === item.role && payload.employeeId === item.employeeId && payload.status === item.status) throw new Error('授權與狀態沒有變更，請調整後再儲存。');
        const accepted = await confirmAction({ title: '確認變更此帳號授權？',
          message: `${item.name}將使用「${accountRoles[payload.role]}」角色，帳號狀態為「${accountStatuses[payload.status]}」。現有登入會被撤銷，需重新進入系統。`,
          confirmLabel: '變更並撤銷現有登入', danger: payload.status === 'suspended', signal: owner.signal, isCurrent: owner.isCurrent });
        if (!accepted) throw new Error('尚未確認變更；輸入內容仍保留。');
        const next = JSON.stringify(payload); if (signature !== next) { signature = next; key = crypto.randomUUID(); }
        const response = await api(`/api/account-administration/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: payload, headers: { 'Idempotency-Key': key }, signal: owner.signal });
        if (!current() || !owner.isCurrent()) throw new DOMException('操作已取消。', 'AbortError');
        return confirmAccountChange(response, { ...scope, id: item.id }, payload);
      } });
    if (saved && current()) { toast(`授權已保存；撤銷 ${saved.sessionsRevoked} 個登入。`); await load(); }
  };
  async function load() {
    const own = ++sequence; controller?.abort(); controller = new AbortController();
    list.replaceChildren(el('p', { role: 'status' }, '正在讀取本機構帳號…')); footer.replaceChildren();
    try {
      const query = new URLSearchParams({ page, pageSize: 25, q, role, status });
      const result = confirmAccountList(await api('/api/account-administration?' + query, { signal: controller.signal }), scope, { page, pageSize: 25, role, status });
      if (!alive() || own !== sequence) return;
      list.replaceChildren(table([{ label: '帳號', render: row => el('div', {}, el('strong', {}, row.name), el('p', { class: 'subtitle' }, row.email)) },
        { label: '角色', render: row => accountRoles[row.role] }, { label: '員工', render: row => row.employeeName || (row.employeeId ? '名稱未確認' : '未連結') },
        { label: '狀態', render: stateBadge }, { label: '操作', render: row => el('div', { class: 'table-actions' }, action('查看', () => details(row)), action('歷程', () => details(row, true)),
          row.canManage ? action('變更授權', trigger => edit(row, trigger)) : el('span', { class: 'subtitle' }, '本人帳號：由其他管理者變更')) }], result.items,
      { caption: '本機構帳號與授權', emptyText: '沒有符合條件的本機構帳號。' }));
      footer.replaceChildren(pagination({ page, pageSize: 25, total: result.total, onChange: value => { page = value; load(); } }));
    } catch (error) { if (alive() && own === sequence && error.name !== 'AbortError') list.replaceChildren(errorState(error, load)); }
  }
  container.replaceChildren(pageHeader('帳號與權限', '管理本機構帳號的角色、員工連結與使用狀態'),
    el('p', { class: 'notice' }, '停用或變更授權會立即撤銷現有登入。至少保留一位有效管理者；本人授權由另一位管理者變更。公司登入帳號需先由管理者明確綁定。'),
    el('div', { class: 'toolbar' }, searchBox({ label: '搜尋帳號', placeholder: '姓名、電子信箱或員工姓名', onSearch: value => { q = value; page = 1; load(); } }),
      filter('角色', accountRoles, value => { role = value; page = 1; load(); }), filter('狀態', accountStatuses, value => { status = value; page = 1; load(); })), list, footer);
  await load();
}
