import { api, el, pageHeader, table, badge, button, openForm, confirmAction, openDetails, toast,
  formatDate, formatMoney, today, getContext, searchBox, pagination, errorState } from '../ui.js';
import { financialOutputActions } from './financial-outputs.js';
import { openRecordHistory } from './history.js';
import { createBillingDocumentEditor, createPaymentReceiptPayload, checkBillingRecord, formatBillingCents } from '../data/billing-document-editor.js';

const bills = 'billing-documents', receipts = 'payment-receipts';
const billStatuses = { draft: '草稿', issued: '已開立', voided: '已作廢' };
const receiptStatuses = { active: '有效收款', cancelled: '已取消' };
const methods = { cash: '現金', transfer: '轉帳', other: '其他' };
const org = () => getContext().organizationId || getContext().orgId;
const identity = () => { const ctx = getContext(); return JSON.stringify([ctx.user?.id, org(), ctx.role, ctx.user?.employeeId || ctx.employeeId || '']); };
const notice = text => el('p', { class: 'notice', role: 'note' }, text);
const options = source => Object.entries(source).map(([value, label]) => ({ value, label }));
const statusBadge = (status, labels) => { const node = badge(status); node.textContent = labels[status]; return node; };
const abort = () => { throw new DOMException('操作已取消，請重新讀取保存狀態。', 'AbortError'); };

function actionButton(label, action, variant = 'outline') {
  let busy = false;
  const trigger = button(label, async () => {
    if (busy) return;
    busy = true; trigger.setAttribute('aria-disabled', 'true'); trigger.setAttribute('aria-busy', 'true');
    try { await action(trigger); }
    catch (error) { if (trigger.isConnected && error.name !== 'AbortError') toast(error.message || '操作失敗，請重試。', 'error'); }
    finally { busy = false; trigger.removeAttribute('aria-disabled'); trigger.removeAttribute('aria-busy'); }
  }, { variant });
  return trigger;
}
function collection(result, { entity, page, pageSize, orgId, parentId }) {
  if (!Array.isArray(result?.items) || !Number.isSafeInteger(result.total) || result.total < 0 || result.page !== page
    || result.pageSize !== pageSize || result.items.length > pageSize) throw new Error('查詢回應無法確認，請重新讀取。');
  return result.items.map(item => {
    const row = checkBillingRecord({ item }, { entity, orgId });
    if (parentId && row.billingDocumentId !== parentId) throw new Error('收款的父帳單無法確認，請重新讀取。');
    return row;
  });
}
async function caseChoices(signal, isCurrent) {
  const resultItems = [], ids = new Set(); let total;
  for (let page = 1; page <= 100; page++) {
    const result = await api(`/api/cases?page=${page}&pageSize=100`, { signal });
    if (!isCurrent()) abort();
    if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0 || result.items.length > 100
      || (total !== undefined && result.total !== total)) throw new Error('個案選項有變動，請重新讀取。');
    total = result.total;
    for (const item of result.items) {
      if (item.orgId !== org() || typeof item.id !== 'string' || ids.has(item.id) || typeof item.name !== 'string' || typeof item.caseNo !== 'string')
        throw new Error('同機構個案選項無法確認。');
      ids.add(item.id); resultItems.push(item);
    }
    if (resultItems.length === total) return resultItems;
    if (!result.items.length || resultItems.length > total) throw new Error('個案選項不完整，請重新讀取。');
  }
  throw new Error('可選個案超過目前範圍，請先整理個案資料。');
}
async function receiptRows(documentId, signal, isCurrent) {
  const all = [], ids = new Set(); let total;
  for (let page = 1; page <= 100; page++) {
    const params = new URLSearchParams({ billingDocumentId: documentId, page: String(page), pageSize: '100' });
    const result = await api(`/api/${receipts}?${params}`, { signal });
    if (!isCurrent()) abort();
    const items = collection(result, { entity: receipts, page, pageSize: 100, orgId: org(), parentId: documentId });
    if (total !== undefined && result.total !== total) throw new Error('收款筆數有變動，請重新讀取完整餘額。');
    total = result.total;
    for (const item of items) { if (ids.has(item.id)) throw new Error('收款分頁有變動，請重新讀取完整餘額。'); ids.add(item.id); all.push(item); }
    if (all.length === total) return all;
    if (!items.length || all.length > total) throw new Error('收款明細不完整，請重新讀取。');
  }
  throw new Error('此帳單收款筆數超過可核對範圍，請先整理資料。');
}
function filterSelect(label, source, changed) {
  const id = `billing-filter-${crypto.randomUUID()}`, control = el('select', { id, class: 'input' },
    el('option', { value: '' }, `全部${label}`), options(source).map(item => el('option', { value: item.value }, item.label)));
  control.addEventListener('change', () => changed(control.value));
  return el('label', { for: id, class: 'filter-field' }, el('span', {}, label), control);
}
function detailField(label, value, wide = false) {
  return el('div', { class: wide ? 'field-wide' : '' }, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value || '未填寫'));
}

export async function mountBillingDocuments(container, { isCurrent = () => true } = {}) {
  const startedContext = getContext(), startedIdentity = identity(), startedHash = location.hash;
  const alive = () => container.isConnected && isCurrent() && getContext() === startedContext && identity() === startedIdentity && location.hash === startedHash;
  if (!['admin', 'finance'].includes(getContext().role)) { const error = new Error('僅管理者或財務可使用人工帳單與收款。'); error.status = 403; container.replaceChildren(errorState(error)); return; }
  let page = 1, query = '', status = '', month = '', sequence = 0, controller;
  const body = el('div', { class: 'list-content', 'aria-live': 'polite' }), footer = el('div', { class: 'list-footer' });
  const readBill = async (id, signal, current) => {
    const item = checkBillingRecord(await api(`/api/${bills}/${encodeURIComponent(id)}`, { signal }), { entity: bills, id, orgId: org() });
    if (!current()) abort(); return item;
  };

  // Abort initial reads as soon as their route, session or invoking row expires.
  const actionRead = async (trigger, action, parentCurrent = alive) => {
    const request = new AbortController(), current = () => parentCurrent() && (!trigger || trigger.isConnected);
    const invalidate = () => { if (!current()) request.abort(); };
    const observer = new MutationObserver(invalidate); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
    window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
    try { if (!current()) return; await action(request.signal, current); }
    finally { request.abort(); observer.disconnect(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate); }
  };

  const editDraft = (row, trigger) => actionRead(trigger, async (signal, current) => {
    const item = row ? await readBill(row.id, signal, current) : undefined;
    if (item && item.status !== 'draft') throw new Error('此帳單已鎖定，請重新讀取目前狀態。');
    const cases = item ? [] : await caseChoices(signal, current);
    if (!current()) abort();
    if (!item && !cases.length) throw new Error('請先建立同機構個案，再新增帳單草稿。');
    const countResult = await openForm({ title: '設定帳單明細筆數', submitLabel: '繼續填寫', isCurrent: current,
      initial: { lineCount: item?.lineItems.length || 1 }, fields: [{ name: 'lineCount', label: '明細筆數', type: 'number', min: 1, max: 100, step: 1, required: true,
        help: '1至100筆。每筆分別填寫名稱、數量與元單價；減少筆數會移除最後的明細。' }],
      onSubmit: async (values, owner) => {
        if (!Number.isSafeInteger(values.lineCount) || values.lineCount < 1 || values.lineCount > 100) { const error = new Error('明細筆數須為1至100的整數。'); error.fields = { lineCount: error.message }; throw error; }
        if (item && values.lineCount < item.lineItems.length) {
          if (!await confirmAction({ title: '減少草稿明細筆數？', message: `最後 ${item.lineItems.length - values.lineCount} 筆明細會在儲存草稿後移除；版本歷程仍保留。`, confirmLabel: '繼續調整明細', danger: true, signal: owner.signal, isCurrent: owner.isCurrent }))
            throw new Error('尚未確認減少明細；原草稿仍保留。');
        }
      } });
    if (!countResult || !current()) return;
    const editor = createBillingDocumentEditor({ existing: item, lineCount: countResult.lineCount, cases, month: today().slice(0, 7) });
    let signature, key = crypto.randomUUID(), didWrite = false;
    const saved = await openForm({ title: item ? '編輯帳單草稿' : '新增帳單草稿', fields: editor.fields, initial: editor.initial, isCurrent: current, submitLabel: '儲存草稿',
      onSubmit: async (values, owner) => {
        const payload = editor.buildPayload(values);
        if (item && !Object.keys(payload).length) return;
        const sent = item ? { ...payload, version: item.version } : payload, nextSignature = JSON.stringify(sent);
        if (signature !== undefined && signature !== nextSignature) key = crypto.randomUUID(); signature = nextSignature;
        const response = await api(item ? `/api/${bills}/${encodeURIComponent(item.id)}` : `/api/${bills}`, {
          method: item ? 'PATCH' : 'POST', body: sent, headers: { 'Idempotency-Key': key }, signal: owner.signal });
        if (!owner.isCurrent()) abort();
        checkBillingRecord(response, { entity: bills, id: item?.id, orgId: org(), original: item, payload: item ? payload : { sourceReference: '', note: '', ...payload } });
        didWrite = true;
      } });
    if (saved && alive()) { await load(); if (alive() && didWrite) toast('已儲存帳單草稿', 'success'); }
  });

  const transitionBill = (item, nextStatus, trigger, detailOwner) => actionRead(trigger, async (signal, current) => {
    const original = await readBill(item.id, signal, current);
    if (original.version !== item.version || original.status !== item.status) throw new Error('帳單已更新，請重新讀取詳情後操作。');
    const issue = nextStatus === 'issued';
    const saved = await openForm({ title: issue ? '開立帳單' : '作廢帳單', submitLabel: issue ? '核對並開立' : '核對並作廢', isCurrent: current,
      initial: issue ? { sourceReference: original.sourceReference } : { note: '' },
      fields: [issue ? { name: 'sourceReference', label: '人工計價依據', type: 'textarea', required: true, maxLength: 2000,
        help: '開立後個案、月份、編號、明細與計價依據會鎖定。' } : { name: 'note', label: '本次作廢原因', type: 'textarea', required: true, maxLength: 10000,
        help: '作廢前必須取消全部有效收款；作廢後不能恢復或修改。' }],
      onSubmit: async (values, owner) => {
        const value = issue ? values.sourceReference.trim() : values.note;
        if (!value.trim()) { const error = new Error(issue ? '請填寫人工計價依據。' : '請填寫本次作廢原因。'); error.fields = { [issue ? 'sourceReference' : 'note']: error.message }; throw error; }
        const accepted = await confirmAction({ title: issue ? '確認開立這份人工帳單？' : '確認作廢這份人工帳單？',
          message: `${original.number} · ${original.caseSnapshot.name} · ${original.month} · ${formatMoney(original.summary.amountCents)}。${issue ? '開立後內容鎖定；此紀錄不具正式發票或申報效力。' : '作廢後保留歷程且不可恢復，不會執行退款。'}`,
          confirmLabel: issue ? '確認開立' : '確認作廢', danger: !issue, signal: owner.signal, isCurrent: owner.isCurrent });
        if (!accepted) throw new Error('尚未確認狀態變更；輸入仍保留。');
        const payload = { status: nextStatus, [issue ? 'sourceReference' : 'note']: value };
        const response = await api(`/api/${bills}/${encodeURIComponent(original.id)}`, { method: 'PATCH', body: { ...payload, version: original.version }, signal: owner.signal });
        if (!owner.isCurrent()) abort(); checkBillingRecord(response, { entity: bills, id: original.id, orgId: org(), original, payload });
      } });
    if (saved && detailOwner.isCurrent()) { await detailOwner.reload(); if (detailOwner.isCurrent()) toast(issue ? '已開立人工帳單' : '已作廢人工帳單', 'success'); }
  }, detailOwner.isCurrent);

  const addReceipt = (item, remaining, trigger, detailOwner) => actionRead(trigger, async (_signal, current) => {
    if (item.status !== 'issued' || remaining < 1) throw new Error('目前沒有可登錄的未收餘額。');
    let signature, key = crypto.randomUUID();
    const saved = await openForm({ title: '新增收款紀錄', submitLabel: '核對並登錄收款', isCurrent: current,
      initial: { date: today(), amount: formatBillingCents(Math.min(remaining, 1000000000)), method: 'cash', reference: '', note: '' },
      fields: [{ name: 'date', label: '實際收款日期', type: 'date', required: true }, { name: 'amount', label: '已收金額（元）', inputMode: 'decimal', required: true,
        maxLength: 15, help: `目前核對未收餘額 ${formatMoney(remaining)}；單筆上限10,000,000元。` },
        { name: 'method', label: '已收款方式', type: 'select', required: true, options: options(methods) },
        { name: 'reference', label: '人工收款核對依據', maxLength: 500 }, { name: 'note', label: '備註', type: 'textarea', maxLength: 10000,
          help: '僅記錄已收到款項，不會執行轉帳、扣款、申報或開立正式憑證。' }],
      onSubmit: async (values, owner) => {
        const payload = createPaymentReceiptPayload(values, item.id);
        if (payload.amountCents > remaining) { const error = new Error('本次收款超過目前核對餘額。'); error.fields = { amount: error.message }; throw error; }
        if (!await confirmAction({ title: '確認款項已收取？', message: `${item.number} · ${formatMoney(payload.amountCents)} · ${methods[payload.method]}。這裡保存人工已收款紀錄，不會執行銀行或付款操作。`,
          confirmLabel: '確認登錄已收款', signal: owner.signal, isCurrent: owner.isCurrent })) throw new Error('尚未確認收款；輸入仍保留。');
        const nextSignature = JSON.stringify(payload); if (signature !== undefined && signature !== nextSignature) key = crypto.randomUUID(); signature = nextSignature;
        let response;
        try { response = await api(`/api/${receipts}`, { method: 'POST', body: payload, headers: { 'Idempotency-Key': key }, signal: owner.signal }); }
        catch (error) { if (error.fields?.amountCents) error.fields.amount = error.fields.amountCents; throw error; }
        if (!owner.isCurrent()) abort(); checkBillingRecord(response, { entity: receipts, orgId: org(), payload });
      } });
    if (saved && detailOwner.isCurrent()) { await detailOwner.reload(); if (detailOwner.isCurrent()) toast('已登錄收款紀錄', 'success'); }
  }, detailOwner.isCurrent);

  const cancelReceipt = (row, bill, trigger, detailOwner) => actionRead(trigger, async (signal, current) => {
    const original = checkBillingRecord(await api(`/api/${receipts}/${encodeURIComponent(row.id)}`, { signal }), { entity: receipts, id: row.id, orgId: org() });
    if (!current()) abort();
    if (original.billingDocumentId !== bill.id || original.status !== 'active') throw new Error('此收款已取消或父帳單無法確認，請重新讀取。');
    const saved = await openForm({ title: '取消收款紀錄', submitLabel: '核對並取消收款', fields: [{ name: 'note', label: '本次取消原因', type: 'textarea', required: true, maxLength: 10000,
      help: '取消後原金額與收款日保留，不會執行退款；不可恢復或改寫。' }], initial: { note: '' }, isCurrent: current,
      onSubmit: async (values, owner) => {
        if (!values.note.trim()) { const error = new Error('請填寫本次取消原因。'); error.fields = { note: error.message }; throw error; }
        if (!await confirmAction({ title: '確認取消這筆收款紀錄？', message: `${bill.number} · ${formatDate(original.date)} · ${formatMoney(original.amountCents)}。紀錄會標示已取消，帳單未收餘額重新計算；不會執行退款。`,
          confirmLabel: '確認取消收款', danger: true, signal: owner.signal, isCurrent: owner.isCurrent })) throw new Error('尚未確認取消；原因仍保留。');
        const payload = { status: 'cancelled', note: values.note };
        const response = await api(`/api/${receipts}/${encodeURIComponent(original.id)}`, { method: 'PATCH', body: { ...payload, version: original.version }, signal: owner.signal });
        if (!owner.isCurrent()) abort(); checkBillingRecord(response, { entity: receipts, id: original.id, orgId: org(), original, payload });
      } });
    if (saved && detailOwner.isCurrent()) { await detailOwner.reload(); if (detailOwner.isCurrent()) toast('已取消收款紀錄', 'success'); }
  }, detailOwner.isCurrent);

  const details = async (row, trigger, request) => {
    let receiptPage = 1, receiptQuery = '', receiptStatus = '';
    const current = () => alive() && trigger.isConnected && request === sequence;
    await openDetails({ title: '人工帳單詳情與收款', wide: true, guardedRead: true, isCurrent: current, loadingText: '正在重新核對帳單與完整收款餘額…',
      load: async (signal, owner) => {
        const item = await readBill(row.id, signal, owner.isCurrent), allReceipts = await receiptRows(item.id, signal, owner.isCurrent);
        if (!current() || !owner.isCurrent()) abort();
        const total = BigInt(item.summary.amountCents), collected = allReceipts.filter(item => item.status === 'active').reduce((sum, item) => sum + BigInt(item.amountCents), 0n);
        if (collected > total) throw new Error('保存收款超過帳單總額，請先核對資料；暫不提供新增收款。');
        const remaining = Number(total - collected);
        const info = el('dl', { class: 'detail-grid' }, detailField('帳單編號', item.number), detailField('帳單月份', item.month),
          detailField('個案（帳單保存快照）', `${item.caseSnapshot.name} · ${item.caseSnapshot.caseNo}`), detailField('帳單狀態', billStatuses[item.status]),
          detailField('人工明細總額', formatMoney(item.summary.amountCents)), detailField('有效已收金額', formatMoney(Number(collected))), detailField('未收餘額', formatMoney(remaining)),
          detailField('人工計價依據', item.sourceReference, true), detailField(item.status === 'voided' ? '作廢原因' : '備註', item.note, true));
        const actions = el('div', { class: 'actions' });
        actions.append(financialOutputActions({ kind: 'billing', record: item, signal, isCurrent: owner.isCurrent }));
        if (item.status === 'draft') actions.append(actionButton('開立帳單', trigger => transitionBill(item, 'issued', trigger, owner), 'primary'));
        if (item.status === 'issued') {
          if (remaining > 0) actions.append(actionButton('新增收款紀錄', trigger => addReceipt(item, remaining, trigger, owner), 'primary'));
          actions.append(actionButton('作廢帳單', trigger => transitionBill(item, 'voided', trigger, owner), 'danger'));
        }
        const keyword = receiptQuery.toLowerCase(), filtered = allReceipts.filter(row => (!receiptStatus || row.status === receiptStatus)
          && (!keyword || [row.reference, row.note, row.method].some(value => value.toLowerCase().includes(keyword))));
        receiptPage = Math.min(receiptPage, Math.max(1, Math.ceil(filtered.length / 25)));
        const toolbar = el('div', { class: 'toolbar' }, searchBox({ label: '搜尋此帳單收款', placeholder: '搜尋核對依據、備註或方式代碼', value: receiptQuery,
          onSearch: value => { if (owner.isCurrent()) { receiptQuery = value; receiptPage = 1; void owner.reload(); } } }),
          filterSelect('收款狀態', receiptStatuses, value => { if (owner.isCurrent()) { receiptStatus = value; receiptPage = 1; void owner.reload(); } }));
        toolbar.querySelector('input[type="search"]').value = receiptQuery; toolbar.querySelector('input[type="search"]').maxLength = 200;
        toolbar.querySelector('select').value = receiptStatus;
        const list = table([{ label: '收款日期', render: row => formatDate(row.date) }, { label: '已收金額', render: row => formatMoney(row.amountCents) },
          { label: '方式', render: row => methods[row.method] }, { label: '狀態', render: row => statusBadge(row.status, receiptStatuses) }, { key: 'reference', label: '核對依據' },
          { label: '操作', render: row => {
            const group = el('div', { class: 'actions row-actions' });
            group.append(actionButton('收款詳情', trigger => openDetails({ title: '人工收款詳情', guardedRead: true, isCurrent: () => owner.isCurrent() && trigger.isConnected,
              load: async (receiptSignal, receiptOwner) => {
                const receipt = checkBillingRecord(await api(`/api/${receipts}/${encodeURIComponent(row.id)}`, { signal: receiptSignal }), { entity: receipts, id: row.id, orgId: org() });
                if (!receiptOwner.isCurrent()) abort(); if (receipt.billingDocumentId !== item.id) throw new Error('收款的父帳單無法確認。');
                return el('section', {}, notice(`本機人工紀錄第 ${receipt.version} 版；此紀錄不具正式付款或憑證效力。`), el('dl', { class: 'detail-grid' }, detailField('父帳單', item.number),
                  detailField('收款日期', formatDate(receipt.date)), detailField('已收金額', formatMoney(receipt.amountCents)), detailField('方式', methods[receipt.method]), detailField('狀態', receiptStatuses[receipt.status]),
                  detailField('人工核對依據', receipt.reference, true), detailField(receipt.status === 'cancelled' ? '取消原因' : '備註', receipt.note, true)));
              } })));
            if (row.status === 'active') group.append(actionButton('取消收款', trigger => cancelReceipt(row, item, trigger, owner), 'danger'));
            group.append(actionButton('版本歷程', trigger => openRecordHistory({ entity: receipts, id: row.id, isCurrent: () => owner.isCurrent() && trigger.isConnected })));
            return group;
          } }], filtered.slice((receiptPage - 1) * 25, receiptPage * 25), { caption: '本帳單人工收款紀錄', emptyText: receiptQuery || receiptStatus ? '沒有符合條件的收款紀錄。' : '目前尚無收款紀錄。' });
        return el('section', {}, notice(`目前保存第 ${item.version} 版。草稿保存與開立時擷取個案識別快照；開立後內容鎖定。收款餘額依本次完整讀取的有效人工紀錄計算。`), info,
          el('h3', {}, '人工計價明細'), table([{ key: 'label', label: '名稱' }, { key: 'quantity', label: '數量' }, { label: '單價', render: row => formatMoney(row.unitPriceCents) },
            { label: '小計', render: row => formatMoney(Number(BigInt(row.quantity) * BigInt(row.unitPriceCents))) }], item.lineItems, { caption: '帳單計價明細' }), actions,
          el('h3', {}, '人工收款紀錄'), toolbar, list, pagination({ page: receiptPage, pageSize: 25, total: filtered.length, onChange: next => { if (owner.isCurrent()) { receiptPage = next; void owner.reload(); } } }));
      } });
    if (alive() && request === sequence) await load();
  };

  const load = async () => {
    if (!alive()) return;
    const request = ++sequence; controller?.abort(); controller = new AbortController(); body.dataset.renderVersion = `billing:${request}`;
    body.replaceChildren(el('p', { class: 'loading', role: 'status' }, '正在讀取人工帳單…')); footer.replaceChildren();
    const params = new URLSearchParams({ page: String(page), pageSize: '25' }); if (query) params.set('q', query); if (status) params.set('status', status); if (month) params.set('month', month);
    try {
      const result = await api(`/api/${bills}?${params}`, { signal: controller.signal });
      if (!alive() || request !== sequence) return;
      const items = collection(result, { entity: bills, page, pageSize: 25, orgId: org() });
      if (page > 1 && !items.length && result.total) { page = Math.ceil(result.total / 25); return load(); }
      body.replaceChildren(table([{ key: 'month', label: '月份' }, { key: 'number', label: '帳單編號' }, { label: '個案', render: row => `${row.caseSnapshot.name} · ${row.caseSnapshot.caseNo}` },
        { label: '人工明細總額', render: row => formatMoney(row.summary.amountCents) }, { label: '狀態', render: row => statusBadge(row.status, billStatuses) },
        { label: '操作', render: row => {
          const group = el('div', { class: 'actions row-actions' }); group.append(actionButton('詳情', trigger => details(row, trigger, request)));
          if (row.status === 'draft') group.append(actionButton('編輯草稿', trigger => editDraft(row, trigger)));
          group.append(actionButton('版本歷程', trigger => openRecordHistory({ entity: bills, id: row.id, isCurrent: () => alive() && trigger.isConnected && request === sequence })));
          return group;
        } }], items, { caption: '人工帳單與收款', emptyText: query || status || month ? '沒有符合條件的帳單，請調整查詢。' : '目前尚無人工帳單；建立個案後可新增草稿。' }));
      footer.replaceChildren(pagination({ page, pageSize: 25, total: result.total, onChange: next => { if (alive()) { page = next; void load(); } } }));
    } catch (error) { if (alive() && request === sequence && error.name !== 'AbortError') body.replaceChildren(errorState(error, load)); }
  };
  const toolbar = el('div', { class: 'toolbar' }, searchBox({ label: '搜尋人工帳單', placeholder: '搜尋編號、人工計價依據或備註', onSearch: value => { if (alive()) { query = value; page = 1; void load(); } } }),
    filterSelect('帳單狀態', billStatuses, value => { status = value; page = 1; void load(); }));
  toolbar.querySelector('input[type="search"]').maxLength = 200;
  const monthId = `billing-month-${crypto.randomUUID()}`, monthControl = el('input', { id: monthId, type: 'month', class: 'input' });
  monthControl.addEventListener('change', () => { if (alive()) { month = monthControl.value; page = 1; void load(); } });
  toolbar.append(el('label', { for: monthId, class: 'filter-field' }, el('span', {}, '帳單月份'), monthControl));
  container.replaceChildren(pageHeader('人工帳單與收款', '建立草稿、核對人工明細，再保存開立與收款歷程', [actionButton('新增帳單草稿', trigger => editDraft(null, trigger), 'primary')]),
    notice('僅管理者與財務可使用。這裡依人工核定的名稱、數量與單價保存公司帳單；尚未套用官方費率、自付額、補助、月額度、核銷或支付規則。'),
    el('section', { class: 'panel' }, toolbar, body, footer));
  const invalidate = () => { if (alive()) return; ++sequence; controller?.abort(); observer.disconnect(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate); };
  const observer = new MutationObserver(invalidate); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
  window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate); await load();
}
