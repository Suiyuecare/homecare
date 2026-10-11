import { api, el, pageHeader, table, badge, button, openForm, openDetails, confirmAction, getContext, searchBox, pagination, errorState, toast, today } from '../ui.js';
import { FINANCIAL_ADJUSTMENT_NOTICE, financialAdjustmentStatuses, confirmFinancialAdjustment, confirmFinancialAdjustmentList, confirmFinancialAdjustmentHistory, confirmFinancialAdjustmentAck, buildFinancialAdjustmentCreate, buildFinancialAdjustmentDraft, financialAdjustmentSourceLabel } from '../data/financial-adjustment-core.js';
import { confirmFinancialOutput, financialOutputPath, financialOutputMoney } from '../data/financial-output-editor.js';
import { checkBillingRecord, parseBillingMoney, formatBillingCents } from '../data/billing-document-editor.js';
import { assertPayrollStatement } from '../data/payroll-statement-editor.js';

const kinds = { billing: '已開立帳單', payroll: '已關帳薪資' }, directions = { debit: '加項', credit: '減項' };
const options = labels => Object.entries(labels).map(([value, label]) => ({ value, label }));
const identity = () => { const c = getContext(); return JSON.stringify([c.user?.id, c.organizationId || c.orgId, c.role, c.user?.employeeId || c.employeeId || '']); };
const abort = () => { throw new DOMException('操作已取消，請重新讀取目前資料。', 'AbortError'); };
const fields = pairs => el('dl', { class: 'detail-grid' }, pairs.map(([label, value]) => el('div', { class: ['更正原因', '覆核原因', '原單據備註', '原單據人工依據'].includes(label) ? 'field-wide' : '' }, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value === null || value === '' ? '未填寫' : String(value)))));
const timestamp = value => value ? new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '尚未操作';
function action(label, run, variant = 'outline') {
  let busy = false;
  const trigger = button(label, async () => {
    if (busy) return; busy = true; trigger.setAttribute('aria-disabled', 'true'); trigger.setAttribute('aria-busy', 'true');
    try { await run(trigger); } catch (error) { if (trigger.isConnected && error.name !== 'AbortError') toast(error.message, 'error'); }
    finally { busy = false; trigger.removeAttribute('aria-disabled'); trigger.removeAttribute('aria-busy'); }
  }, { variant }); return trigger;
}
function filter(label, labels, changed) {
  const id = 'adjustment-filter-' + crypto.randomUUID(), select = el('select', { id, class: 'input' }, el('option', { value: '' }, `全部${label}`), options(labels).map(o => el('option', { value: o.value }, o.label)));
  select.addEventListener('change', () => changed(select.value)); return el('label', { class: 'filter-field', for: id }, el('span', {}, label), select);
}
function originalView(snapshot) {
  const r = snapshot.record, payroll = snapshot.kind === 'payroll', party = payroll ? r.employeeSnapshot : r.caseSnapshot;
  return el('section', {}, el('h3', {}, '建立調整單時的原單據快照'),
    fields([['原單據類型', kinds[snapshot.kind]], ['原單據編號', r.number], ['原單據月份', r.month], ['原單據保存版本', `第 ${r.version} 版`], ['原單據對象（保存姓名）', party.name], ['原單據對象識別', party.id], ['原單據識別', r.id], ['原單據保存總額', financialOutputMoney(payroll ? r.summary.netCents : r.summary.amountCents)]]),
    table(payroll ? [{ label: '原明細名稱', key: 'label' }, { label: '加項／減項', render: row => row.kind === 'earning' ? '加項' : '減項' }, { label: '原保存金額', render: row => financialOutputMoney(row.amountCents) }]
      : [{ label: '原明細名稱', key: 'label' }, { label: '原數量', key: 'quantity' }, { label: '原單價', render: row => financialOutputMoney(row.unitPriceCents) }], r.lineItems, { caption: '完整原單據保存明細' }),
    payroll && fields([['原加項合計', financialOutputMoney(r.summary.earningCents)], ['原減項合計', financialOutputMoney(r.summary.deductionCents)]]),
    fields([['原單據人工依據', r.sourceReference], ['原單據備註', r.note]]));
}
function savedView(item) {
  return el('section', {}, fields([['調整單編號', item.number], ['生效月份', item.effectiveMonth], ['調整方向', directions[item.direction]], ['人工調整金額', financialOutputMoney(item.amountCents)], ['保存狀態', financialAdjustmentStatuses[item.status]], ['調整單版本', `第 ${item.version} 版`], ['更正原因', item.reason], ['建立者識別', item.createdBy], ['建立時間（臺北）', timestamp(item.createdAt)], ['提交者識別', item.submittedBy], ['提交時間（臺北）', timestamp(item.submittedAt)], ['覆核者識別', item.reviewedBy], ['覆核時間（臺北）', timestamp(item.reviewedAt)], ['覆核原因', item.reviewNote]]), originalView(item.sourceSnapshot));
}

export async function mountFinancialAdjustments(container, { isCurrent = () => true } = {}) {
  const context = getContext(), stamp = identity(), hash = location.hash, orgId = context.organizationId || context.orgId;
  const alive = () => container.isConnected && isCurrent() && getContext() === context && identity() === stamp && location.hash === hash;
  if (!['admin', 'finance'].includes(context.role)) { const error = new Error('僅管理者與財務可使用財務更正調整單。'); error.status = 403; container.replaceChildren(errorState(error)); return; }
  let page = 1, q = '', status = '', sourceKind = '', sequence = 0, controller;
  const list = el('div', { class: 'list-content', 'aria-live': 'polite' }), footer = el('div', { class: 'list-footer' });
  const focusSaved = id => { if (alive()) (list.querySelector(`tr[data-adjustment-id="${id}"] button`) || container.querySelector('h1'))?.focus({ preventScroll: true }); };
  const read = async (id, signal, current) => { const response = await api('/api/financial-adjustments/' + encodeURIComponent(id), { signal }); if (!current()) abort(); return confirmFinancialAdjustment(response.item, { orgId, id }); };
  const actionRead = async (trigger, run) => {
    const request = new AbortController(), current = () => alive() && trigger.isConnected;
    const invalidate = () => { if (!current()) request.abort(); }, observer = new MutationObserver(invalidate);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] }); window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
    try { if (current()) await run(request.signal, current); }
    finally { request.abort(); observer.disconnect(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate); }
  };
  async function sources(signal, current) {
    const rows = [];
    for (const [kind, entity, final] of [['billing', 'billing-documents', 'issued'], ['payroll', 'payroll-statements', 'closed']]) {
      const ids = new Set(); let total;
      for (let sourcePage = 1; sourcePage <= 100; sourcePage++) {
        const result = await api(`/api/${entity}?status=${final}&page=${sourcePage}&pageSize=100`, { signal }); if (!current()) abort();
        if (!Array.isArray(result?.items) || !Number.isSafeInteger(result.total) || result.total < 0 || result.page !== sourcePage || result.pageSize !== 100 || result.items.length !== Math.min(100, Math.max(0, result.total - (sourcePage - 1) * 100)) || total !== undefined && result.total !== total) throw new Error('原單據候選有變動，請重新讀取。');
        total = result.total;
        for (const candidate of result.items) {
          const row = kind === 'billing' ? checkBillingRecord({ item: candidate }, { entity, orgId }) : assertPayrollStatement(candidate, { orgId });
          if (row.status !== final || ids.has(row.id)) throw new Error('原單據候選無法確認，請重新讀取。'); ids.add(row.id);
          rows.push({ kind, record: row, value: kind + ':' + row.id, label: `${kinds[kind]} · ${row.number} · ${(kind === 'billing' ? row.caseSnapshot : row.employeeSnapshot).name} · ${row.month} · 第 ${row.version} 版` });
        }
        if (ids.size === total) break;
        if (sourcePage === 100) throw new Error('原單據候選超過可核對範圍，請先整理來源。');
      }
    } return rows;
  }
  const moneyFields = [
    { name: 'number', label: '調整單編號', required: true, maxLength: 100 },
    { name: 'effectiveMonth', label: '生效月份（YYYY-MM）', required: true, maxLength: 7, help: '人工指定更正適用月份；不會改寫原單據月份。' },
    { name: 'direction', label: '調整方向', type: 'select', required: true, options: options(directions), help: '加項或減項須由經核定的人工依據決定。' },
    { name: 'amount', label: '人工調整金額（元）', required: true, maxLength: 20, inputMode: 'decimal', help: '非負金額，最多兩位小數。系統精確保存為整數分，不自動計算稅額或餘額。' },
    { name: 'reason', label: '更正原因', type: 'textarea', required: true, maxLength: 2000, help: '原因為單行文字，可在欄位內自動換行；不含換行或控制字元。' },
  ];
  const edit = (row, trigger) => actionRead(trigger, async (signal, current) => {
    const item = row ? await read(row.id, signal, current) : null;
    if (item && (item.status !== 'draft' || !item.sourceEligible)) throw new Error('目前來源已變更或調整單已鎖定，請重新讀取。');
    const candidates = item ? [] : await sources(signal, current); if (!current()) abort();
    if (!item && !candidates.length) throw new Error('請先開立人工帳單或關帳人工薪資，再建立更正調整單。');
    const initial = { number: item?.number || '', effectiveMonth: item?.effectiveMonth || today().slice(0, 7), direction: item?.direction || 'credit', amount: formatBillingCents(item?.amountCents || 0), reason: item?.reason || '' };
    let signature, key;
    const saved = await openForm({ title: item ? '編輯調整單草稿' : '新增更正調整單', fields: [
      ...(!item ? [{ name: 'source', label: '原單據與保存版本', type: 'select', required: true, options: candidates, help: '只有本機構已開立帳單及已關帳薪資可選；來源保存後不能更換。' }] : []),
      { name: 'sourceSummary', label: '原單據核對資訊', type: 'textarea', disabled: true, help: FINANCIAL_ADJUSTMENT_NOTICE }, ...moneyFields],
      initial: { ...initial, sourceSummary: item ? financialAdjustmentSourceLabel(item) : '請先選取原單據。' }, isCurrent: current, submitLabel: '儲存草稿', returnSubmitResult: true,
      onChange: (values, helpers) => { if (!item) { const source = candidates.find(r => r.value === values.source); helpers.setValue('sourceSummary', source ? `${source.label}\n原保存總額 ${financialOutputMoney(source.kind === 'billing' ? source.record.summary.amountCents : source.record.summary.netCents)}` : '請先選取原單據。'); } },
      onSubmit: async (values, owner) => {
        const data = { ...values, amountCents: parseBillingMoney(values.amount, { key: 'amount', maxCents: Number.MAX_SAFE_INTEGER }) };
        const source = item ? null : candidates.find(r => r.value === values.source); if (!item && !source) throw new Error('請選擇可核對的原單據。');
        const payload = item ? buildFinancialAdjustmentDraft(data, item.version) : buildFinancialAdjustmentCreate({ ...data, sourceKind: source.kind, sourceId: source.record.id, sourceVersion: source.record.version });
        let sourceSnapshot;
        if (!item) { const request = { kind: payload.sourceKind, id: payload.sourceId, orgId, version: payload.sourceVersion }; sourceSnapshot = confirmFinancialOutput(await api(financialOutputPath(request), { signal: owner.signal }), request); if (sourceSnapshot.record.status !== (payload.sourceKind === 'billing' ? 'issued' : 'closed')) throw new Error('原單據已不是可更正狀態，請重新讀取。'); }
        if (!owner.isCurrent()) abort();
        const response = await send(item, payload, undefined, owner);
        if (!item && JSON.stringify(response.item.sourceSnapshot) !== JSON.stringify(sourceSnapshot)) throw new Error('原單據快照未確認，請保留輸入並重新讀取。');
        return response;
      } });
    if (saved && current()) { await load(); if (alive()) { focusSaved(saved.item.id); toast('已儲存更正調整單草稿'); } }
    async function send(original, payload, operation, owner) {
      const next = JSON.stringify(payload); if (next !== signature) { signature = next; key = crypto.randomUUID(); }
      const response = await api('/api/financial-adjustments' + (original ? '/' + encodeURIComponent(original.id) : ''), { method: original ? 'PATCH' : 'POST', body: payload, headers: { 'Idempotency-Key': key }, signal: owner.signal });
      if (!current() || !owner.isCurrent()) abort(); return confirmFinancialAdjustmentAck(response, { orgId, id: original?.id, version: original?.version, payload, status: 'draft', original });
    }
  });
  const transition = (row, trigger, review) => actionRead(trigger, async (signal, current) => {
    const item = await read(row.id, signal, current);
    if (!item.sourceEligible || item.status !== (review ? 'submitted' : 'draft')) throw new Error('目前來源已變更或調整單狀態已改變，請重新讀取。');
    let signature, key;
    const saved = await openForm({ title: review ? '覆核更正調整單' : '提交更正調整單', isCurrent: current, returnSubmitResult: true, submitLabel: review ? '核對並覆核' : '核對並提交',
      fields: [{ name: 'summary', label: '本次保存內容', type: 'textarea', disabled: true, help: FINANCIAL_ADJUSTMENT_NOTICE },
        ...(review ? [{ name: 'decision', label: '覆核結果', type: 'select', required: true, options: [{ value: 'approved', label: '覆核通過' }, { value: 'rejected', label: '退回（保留歷程，內容鎖定）' }] }, { name: 'reviewNote', label: '覆核原因', type: 'textarea', required: true, maxLength: 2000 }] : [])],
      initial: { summary: `${item.number} · ${financialAdjustmentSourceLabel(item)}\n${item.effectiveMonth} · ${directions[item.direction]} ${financialOutputMoney(item.amountCents)}\n${item.reason}` },
      onSubmit: async (values, owner) => {
        const payload = review ? { version: item.version, decision: values.decision, reviewNote: values.reviewNote.trim() } : { version: item.version };
        if (review && (!payload.reviewNote || /[\u0000-\u001f\u007f]/.test(payload.reviewNote))) { const error = new Error('請填寫單行覆核原因，不含換行或控制字元。'); error.fields = { reviewNote: error.message }; throw error; }
        if (!await confirmAction({ title: review ? '確認保存覆核結果？' : '確認提交這份調整單？', message: `${item.number} · ${item.effectiveMonth} · ${directions[item.direction]} ${financialOutputMoney(item.amountCents)}。${review ? '覆核後結果與內容鎖定。' : '提交後內容鎖定，交由管理者或財務覆核。'}原單據保持不變，不會執行收付款。`, confirmLabel: review ? '確認保存覆核' : '確認提交', danger: payload.decision === 'rejected', signal: owner.signal, isCurrent: owner.isCurrent })) throw new Error('尚未確認；輸入內容仍保留。');
        const next = JSON.stringify(payload); if (next !== signature) { signature = next; key = crypto.randomUUID(); }
        const response = await api(`/api/financial-adjustments/${encodeURIComponent(item.id)}/${review ? 'review' : 'submit'}`, { method: 'POST', body: payload, headers: { 'Idempotency-Key': key }, signal: owner.signal });
        if (!current() || !owner.isCurrent()) abort(); return confirmFinancialAdjustmentAck(response, { orgId, id: item.id, version: item.version, payload, status: review ? payload.decision : 'submitted', original: item });
      } });
    if (saved && current()) { await load(); if (alive()) { focusSaved(saved.item.id); toast(review ? '已保存更正調整單覆核結果' : '已提交更正調整單'); } }
  });
  const details = (row, history) => openDetails({ title: history ? '更正調整單版本歷程' : '更正調整單詳情', wide: true, guardedRead: true, isCurrent: alive,
    load: async (signal, owner) => {
      if (history) {
        const result = confirmFinancialAdjustmentHistory(await api(`/api/financial-adjustments/${encodeURIComponent(row.id)}/history`, { signal }), { orgId, id: row.id }); if (!alive() || !owner.isCurrent()) abort();
        return el('section', {}, el('p', { class: 'notice' }, FINANCIAL_ADJUSTMENT_NOTICE), result.items.map((version, index) => el('details', { class: 'panel', open: index === 0 }, el('summary', {}, `第 ${version.version} 版 · ${financialAdjustmentStatuses[version.snapshot.status]} · ${timestamp(version.createdAt)}`), savedView(version.snapshot))));
      }
      const item = await read(row.id, signal, owner.isCurrent); if (!alive() || !owner.isCurrent()) abort();
      return el('section', {}, el('p', { class: 'notice' }, FINANCIAL_ADJUSTMENT_NOTICE), !item.sourceEligible && el('p', { class: 'notice', role: 'alert' }, `原單據目前為第 ${item.sourceCurrentVersion} 版、${item.sourceCurrentStatus === 'voided' ? '已作廢／取消' : '已變更'}；只可查閱保存資料，無法繼續提交或覆核。`), savedView(item));
    } });
  async function load() {
    const own = ++sequence; controller?.abort(); controller = new AbortController();
    list.replaceChildren(el('p', { role: 'status' }, '正在核對更正調整單與原單據狀態…')); footer.replaceChildren();
    try {
      const query = { page, pageSize: 25, q, status, sourceKind }, result = confirmFinancialAdjustmentList(await api('/api/financial-adjustments?' + new URLSearchParams(query), { signal: controller.signal }), { orgId, ...query });
      if (!alive() || own !== sequence) return;
      list.replaceChildren(table([{ label: '調整單', render: row => el('div', {}, el('strong', {}, row.number), el('p', { class: 'subtitle' }, row.effectiveMonth)) },
        { label: '原單據（保存資料）', render: financialAdjustmentSourceLabel }, { label: '人工調整', render: row => `${directions[row.direction]} ${financialOutputMoney(row.amountCents)}` },
        { label: '狀態', render: row => { const node = badge(row.status); node.textContent = financialAdjustmentStatuses[row.status]; return node; } },
        { label: '操作', render: row => el('div', { class: 'table-actions' }, action('詳情', () => details(row, false)), action('歷程', () => details(row, true)),
          !row.sourceEligible ? el('span', { class: 'subtitle' }, '原單據已變更；僅可查閱') : row.status === 'draft' ? [action('編輯草稿', trigger => edit(row, trigger)), action('提交覆核', trigger => transition(row, trigger, false))] : row.status === 'submitted' ? action('覆核', trigger => transition(row, trigger, true)) : el('span', { class: 'subtitle' }, '內容已鎖定')) }], result.items, { caption: '本機構更正調整單', emptyText: '沒有符合條件的更正調整單。' }));
      list.querySelectorAll('tbody tr').forEach((row, index) => { row.dataset.adjustmentId = result.items[index].id; });
      footer.replaceChildren(pagination({ page, pageSize: 25, total: result.total, onChange: value => { page = value; load(); } }));
    } catch (error) { if (alive() && own === sequence && error.name !== 'AbortError') list.replaceChildren(errorState(error, load)); }
  }
  container.replaceChildren(pageHeader('財務更正調整單', '保留原帳單與薪資，以獨立調整單記錄人工更正及覆核', action('新增更正調整單', trigger => edit(null, trigger), 'primary')),
    el('p', { class: 'notice' }, FINANCIAL_ADJUSTMENT_NOTICE), el('div', { class: 'toolbar' }, searchBox({ label: '搜尋更正調整單', placeholder: '編號或更正原因', onSearch: value => { q = value; page = 1; load(); } }), filter('狀態', financialAdjustmentStatuses, value => { status = value; page = 1; load(); }), filter('來源', kinds, value => { sourceKind = value; page = 1; load(); })), list, footer);
  await load();
}
