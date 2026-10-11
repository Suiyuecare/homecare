import { api, el, button, pageHeader, table, pagination, searchBox, openForm, openDetails, confirmAction, toast, getContext, errorState } from '../ui.js';
import { openRecordHistory } from './history.js';
import { RULE_KINDS, RULE_STATUSES, RULE_PARAMETERS, confirmRule } from '../data/business-rule-fields.js';
const options = values => Object.entries(values).map(([value, label]) => ({ value, label }));
export async function mountBusinessRules(container, parentCurrent = () => true) {
  const c = getContext(), identity = JSON.stringify([c.user?.id, c.organizationId, c.role, c.user?.employeeId]), hash = location.hash;
  const alive = () => parentCurrent() && container.isConnected && location.hash === hash && JSON.stringify([getContext().user?.id, getContext().organizationId, getContext().role, getContext().user?.employeeId]) === identity;
  const writable = c.role === 'admin', orgId = c.organizationId;
  let page = 1, q = '', sequence = 0, controller;
  const content = el('div', { class: 'list-content' }), footer = el('div', { class: 'list-footer' });
  const failAction = fn => async () => { try { await fn(); } catch (e) { if (alive() && e.name !== 'AbortError') toast(e.message, 'error'); } };
  function editor(item, copy = false, chosenKind) {
    if (!alive()) return;
    if (!chosenKind && !item) return openForm({ title: '選擇規則類型', fields: [{ name: 'kind', label: '規則類型', type: 'select', required: true, options: options(RULE_KINDS) }], isCurrent: alive, onSubmit: async value => { setTimeout(() => editor(null, false, value.kind), 0); } });
    const kind = chosenKind || item.kind, existing = item && !copy ? item : null;
    if (existing) confirmRule(existing, { orgId });
    const fields = [{ name: 'code', label: '規則代碼', required: true, disabled: !!existing }, { name: 'name', label: '規則名稱', required: true }, { name: 'validFrom', label: '生效日期', type: 'date', required: true }, { name: 'validTo', label: '截止日期', type: 'date', required: true }, { name: 'sourceReference', label: '核定依據', type: 'textarea', maxLength: 2000, help: '填寫公司核定文件或外部規格名稱及版次。' }, ...RULE_PARAMETERS[kind].map(d => ({ name: d.key, label: d.label, type: d.type || 'number', required: true, min: d.min || 0, max: d.max, maxLength: d.maxLength, step: 1 })), { name: 'note', label: '適用方式與備註', type: 'textarea', maxLength: 10000 }];
    const initial = { code: item?.code || '', name: item?.name || '', validFrom: item?.validFrom || '', validTo: item?.validTo || '', sourceReference: item?.sourceReference || '', note: item?.note || '', ...item?.parameters };
    const key = crypto.randomUUID();
    return openForm({ title: `${existing ? '編輯' : copy ? '建立新版本' : '新增'}${RULE_KINDS[kind]}規則`, fields, initial, isCurrent: alive,
      onSubmit: async (values, { signal, isCurrent }) => {
        const parameters = Object.fromEntries(RULE_PARAMETERS[kind].map(d => [d.key, values[d.key]]));
        const payload = { kind, code: existing?.code || values.code.trim(), name: values.name.trim(), validFrom: values.validFrom, validTo: values.validTo, sourceReference: values.sourceReference.trim(), parameters, note: values.note, status: 'draft' };
        const result = await api('/api/business-rules' + (existing ? '/' + existing.id : ''), { method: existing ? 'PATCH' : 'POST', body: existing ? { ...payload, version: existing.version } : payload, headers: existing ? {} : { 'Idempotency-Key': key }, signal });
        if (!isCurrent()) return;
        confirmRule(result.item, { orgId, id: existing?.id, version: existing ? existing.version + 1 : 1, expected: payload });
        toast('待核定規則已保存。', 'success'); await load();
      } });
  }
  async function read(row, fn) {
    const result = await api('/api/business-rules/' + row.id);
    if (alive()) return fn(confirmRule(result.item, { orgId, id: row.id }));
  }
  function status(item, next) {
    if (!alive()) return;
    return confirmAction({ title: next === 'approved' ? '核定這個規則版本' : '停用這個規則版本', message: next === 'approved' ? `確認「${item.name}」的依據、參數與期間已經機構核定。核定後內容會鎖定；此動作不執行付款、薪資發放或外部申報。` : `停用「${item.name}」後保留原版本與歷程。`, confirmLabel: next === 'approved' ? '確認機構核定' : '確認停用', danger: next === 'inactive', isCurrent: alive,
      onConfirm: async ({ signal, isCurrent }) => {
        const result = await api('/api/business-rules/' + item.id, { method: 'PATCH', body: { version: item.version, status: next }, signal });
        if (!isCurrent()) return;
        confirmRule(result.item, { orgId, id: item.id, version: item.version + 1, expected: { status: next } });
        toast(next === 'approved' ? '機構核定版本已保存。' : '規則版本已停用。', 'success'); await load();
      } });
  }
  async function load() {
    controller?.abort(); controller = new AbortController(); const request = ++sequence;
    content.replaceChildren(el('p', { class: 'loading', role: 'status' }, '正在讀取業務規則…'));
    try {
      const params = new URLSearchParams({ page, pageSize: 25 }); if (q) params.set('q', q);
      const result = await api('/api/business-rules?' + params, { signal: controller.signal });
      if (!alive() || request !== sequence) return;
      if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.page !== page || result.pageSize !== 25) throw new Error('規則清單回應無法確認。');
      result.items.forEach(item => confirmRule(item, { orgId }));
      content.replaceChildren(table([{ key: 'kind', label: '類型', render: r => RULE_KINDS[r.kind] }, { key: 'name', label: '規則', render: r => el('span', {}, r.name, el('small', { class: 'muted' }, ' · ' + r.code)) }, { key: 'validFrom', label: '有效期間', render: r => r.validFrom + ' ～ ' + r.validTo }, { key: 'status', label: '狀態', render: r => RULE_STATUSES[r.status] }, { key: 'actions', label: '操作', render: r => el('div', { class: 'actions row-actions' }, button('查看規則', () => openDetails({ title: r.name, guardedRead: true, isCurrent: alive, load: async (signal, { isCurrent }) => { const result = await api('/api/business-rules/' + r.id, { signal }); if (!isCurrent()) return el('div'); const item = confirmRule(result.item, { orgId, id: r.id }); return el('div', {}, table([{ key: 'label', label: '項目' }, { key: 'value', label: '保存內容' }], [{ label: '核定依據', value: item.sourceReference || '尚未提供' }, ...RULE_PARAMETERS[item.kind].map(d => ({ label: d.label, value: item.parameters[d.key] })), { label: '適用方式與備註', value: item.note }]), el('p', { class: 'notice' }, '這是保存的機構規則；正式計算、結算與外部介接另依核定契約驗收。')); } }), { variant: 'outline' }), button('歷程', () => openRecordHistory({ entity: 'business-rules', id: r.id, isCurrent: alive }), { variant: 'ghost' }), writable && r.status === 'draft' ? button('編輯', failAction(() => read(r, x => editor(x))), { variant: 'outline' }) : null, writable && r.status === 'draft' ? button('核定', failAction(() => read(r, x => status(x, 'approved'))), { variant: 'outline' }) : null, writable && r.status === 'approved' ? button('停用', failAction(() => read(r, x => status(x, 'inactive'))), { variant: 'outline' }) : null, writable ? button('建立新版本', failAction(() => read(r, x => editor(x, true))), { variant: 'ghost' }) : null) }], result.items, { emptyText: q ? '找不到符合條件的規則，請調整搜尋。' : '尚未建立規則，請由管理者新增待核定版本。' }));
      footer.replaceChildren(pagination({ page, pageSize: 25, total: result.total, onChange: value => { page = typeof value === 'object' ? value.page : value; load(); } }));
    } catch (e) { if (alive() && request === sequence && e.name !== 'AbortError') content.replaceChildren(errorState(e, load)); }
  }
  container.replaceChildren(pageHeader('業務規則設定', '保存公司核定依據、有效期間與參數，保留每次修改歷程。', writable ? button('新增規則', failAction(() => editor())) : null), el('p', { class: 'notice' }, '新規則先保存為待核定；機構核定後鎖定內容。金額以分保存、比例以萬分比保存，不預填官方費率。'), searchBox({ placeholder: '搜尋規則名稱、代碼或依據', value: q, label: '搜尋業務規則', onSearch: value => { q = value; page = 1; load(); } }), content, footer);
  await load();
}
