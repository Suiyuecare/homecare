import { api, el, pageHeader, table, badge, button, openForm, confirmAction, openDetails, toast,
  formatMoney, today, getContext, searchBox, pagination, errorState, downloadCsv } from '../ui.js';
import { openRecordHistory } from './history.js';
import { checkBillingRecord } from '../data/billing-document-editor.js';
import { claimStatuses, claimResponseStatuses, checkClaimBatchRecord, createClaimBatchDraftEditor, createClaimResponseEditor } from '../data/claim-batch-editor.js';

const entity = 'claim-batches';
const org = () => getContext().organizationId || getContext().orgId;
const identity = () => { const ctx = getContext(); return JSON.stringify([ctx.user?.id, org(), ctx.role, ctx.user?.employeeId || ctx.employeeId || '']); };
const abort = () => { throw new DOMException('操作已取消，請重新讀取。', 'AbortError'); };
const notice = text => el('p', { class: 'notice', role: 'note' }, text);
const field = (label, value, wide = false) => el('div', { class: wide ? 'field-wide' : '' }, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value || '未填寫'));
const statusBadge = status => { const node = badge(status); node.textContent = claimStatuses[status]; return node; };
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
function collection(result, { page, pageSize, orgId }) {
  if (!Array.isArray(result?.items) || !Number.isSafeInteger(result.total) || result.total < 0 || result.page !== page || result.pageSize !== pageSize || result.items.length > pageSize)
    throw new Error('批次清單回應無法確認，請重新讀取。');
  const ids = new Set();
  return result.items.map(item => {
    const row = checkClaimBatchRecord({ item }, { orgId });
    if (ids.has(row.id)) throw new Error('批次清單有重複資料，請重新讀取。'); ids.add(row.id); return row;
  });
}
async function sourceBills(month, signal, isCurrent) {
  const all = [], ids = new Set(); let total;
  for (let page = 1; page <= 100; page++) {
    const query = new URLSearchParams({ month, status: 'issued', page: String(page), pageSize: '100' });
    const result = await api(`/api/billing-documents?${query}`, { signal });
    if (!isCurrent()) abort();
    if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0 || result.page !== page || result.pageSize !== 100 || result.items.length > 100
      || (total !== undefined && result.total !== total)) throw new Error('來源帳單分頁已變動，請重新讀取。');
    total = result.total;
    for (const raw of result.items) {
      const item = checkBillingRecord({ item: raw }, { entity: 'billing-documents', orgId: org() });
      if (item.month !== month || item.status !== 'issued' || ids.has(item.id)) throw new Error('同月份已開立帳單無法確認。');
      ids.add(item.id); all.push(item);
    }
    if (all.length === total) return all;
    if (!result.items.length || all.length > total) throw new Error('來源帳單清單不完整，請重新讀取。');
  }
  throw new Error('同月份可選帳單超過10000筆，請先整理來源資料。');
}

export async function mountClaimBatches(container, { isCurrent = () => true } = {}) {
  const startedContext = getContext(), startedIdentity = identity(), startedHash = location.hash;
  const alive = () => container.isConnected && isCurrent() && getContext() === startedContext && identity() === startedIdentity && location.hash === startedHash;
  if (!['admin', 'finance'].includes(getContext().role)) { const error = new Error('僅管理者或財務可使用離線核銷與人工對帳。'); error.status = 403; container.replaceChildren(errorState(error)); return; }
  let page = 1, query = '', status = '', month = '', sequence = 0, controller;
  const body = el('div', { class: 'list-content', 'aria-live': 'polite' }), footer = el('div', { class: 'list-footer' });
  const readBatch = async (id, signal, current) => {
    const item = checkClaimBatchRecord(await api(`/api/${entity}/${encodeURIComponent(id)}`, { signal }), { id, orgId: org() });
    if (!current()) abort(); return item;
  };
  const actionRead = async (trigger, action, parentCurrent = alive) => {
    const request = new AbortController(), current = () => parentCurrent() && (!trigger || trigger.isConnected);
    const invalidate = () => { if (!current()) request.abort(); };
    const observer = new MutationObserver(invalidate); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
    window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
    try { if (!current()) return; await action(request.signal, current); }
    finally { request.abort(); observer.disconnect(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate); }
  };
  const editDraft = (row, trigger) => actionRead(trigger, async (signal, current) => {
    const existing = row ? await readBatch(row.id, signal, current) : undefined;
    if (existing && existing.status !== 'draft') throw new Error('批次已鎖定，請重新讀取目前狀態。');
    let chosenMonth = existing?.month || today().slice(0, 7);
    if (!existing) {
      const chosen = await openForm({ title: '選擇離線批次月份', submitLabel: '查看可選帳單', isCurrent: current, initial: { month: chosenMonth },
        fields: [{ name: 'month', label: '來源帳單月份', type: 'month', required: true }], onSubmit: async values => {
          if (!/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(values.month)) { const error = new Error('請選擇有效月份。'); error.fields = { month: error.message }; throw error; }
        } });
      if (!chosen || !current()) return; chosenMonth = chosen.month;
    }
    const bills = await sourceBills(chosenMonth, signal, current);
    if (!bills.length) throw new Error('此月份尚無已開立帳單；請先核對並開立人工帳單。');
    if (existing && existing.billingDocumentIds.some(id => !bills.some(item => item.id === id))) throw new Error('草稿來源已作廢或不再可選；請核對後取消原批次，再建立新草稿。');
    const editor = createClaimBatchDraftEditor({ existing, bills, month: chosenMonth });
    let key = crypto.randomUUID(), signature, didWrite = false;
    const saved = await openForm({ title: existing ? '編輯離線批次草稿' : '新增離線批次草稿', fields: editor.fields, initial: editor.initial, isCurrent: current, submitLabel: '儲存批次草稿',
      onSubmit: async (values, owner) => {
        const payload = editor.buildPayload(values); if (existing && !Object.keys(payload).length) return;
        const sent = existing ? { ...payload, version: existing.version } : payload, nextSignature = JSON.stringify(sent);
        if (signature !== undefined && signature !== nextSignature) key = crypto.randomUUID(); signature = nextSignature;
        const response = await api(existing ? `/api/${entity}/${encodeURIComponent(existing.id)}` : `/api/${entity}`, { method: existing ? 'PATCH' : 'POST', body: sent, headers: { 'Idempotency-Key': key }, signal: owner.signal });
        if (!owner.isCurrent()) abort();
        checkClaimBatchRecord(response, { orgId: org(), id: existing?.id, original: existing, payload: existing ? payload : { responseSourceReference: '', responses: [], ...payload } });
        didWrite = true;
      } });
    if (saved && alive()) { await load(); if (alive() && didWrite) toast('已儲存離線批次草稿', 'success'); }
  });
  const transition = (row, target, trigger, detailOwner) => actionRead(trigger, async (signal, current) => {
    const original = await readBatch(row.id, signal, current);
    if (original.version !== row.version || original.status !== row.status) throw new Error('批次已更新，請重新讀取後操作。');
    const save = async (payload, owner) => {
      const accepted = await confirmAction({ title: target === 'verified' ? '確認核對並鎖定批次？' : target === 'closed' ? '確認完成人工對帳？' : '確認取消離線批次？',
        message: `${original.number} · ${original.month} · ${original.summary.sourceCount} 筆帳單 · ${formatMoney(original.summary.amountCents)}。${target === 'verified' ? '來源與內容將鎖定，匯出僅為本機格式，尚未送出任何申報。' : target === 'closed' ? '每筆須有接受或退件結果；完成後不能再修改，這不代表政府核准。' : '取消後保留歷程且不能恢復；來源帳單可加入新的批次。'}`,
        confirmLabel: target === 'verified' ? '確認核對鎖定' : target === 'closed' ? '確認人工對帳完成' : '確認取消批次', danger: target === 'cancelled', signal: owner.signal, isCurrent: owner.isCurrent });
      if (!accepted) throw new Error('尚未確認狀態變更；輸入仍保留。');
      const response = await api(`/api/${entity}/${encodeURIComponent(original.id)}`, { method: 'PATCH', body: { ...payload, version: original.version }, signal: owner.signal });
      if (!owner.isCurrent()) abort(); checkClaimBatchRecord(response, { id: original.id, orgId: org(), original, payload });
    };
    let saved;
    if (target === 'closed') { await save({ status: 'closed' }, { signal, isCurrent: current }); saved = true; }
    else {
      const verify = target === 'verified', key = verify ? 'sourceReference' : 'note';
      saved = await openForm({ title: verify ? '核對並鎖定離線批次' : '取消離線批次', submitLabel: verify ? '核對來源與鎖定' : '核對並取消', isCurrent: current,
        initial: { [key]: verify ? original.sourceReference : '' }, fields: [{ name: key, label: verify ? '批次人工依據' : '本次取消原因', type: 'textarea', required: true, maxLength: verify ? 2000 : 10000, wide: true }],
        onSubmit: async (values, owner) => {
          if (!values[key].trim()) { const error = new Error('請填寫本次依據或原因。'); error.fields = { [key]: error.message }; throw error; }
          const value = verify && values[key] === original[key].replace(/\r\n?/g, '\n') ? original[key] : values[key];
          await save({ status: target, [key]: value }, owner);
        } });
    }
    if (saved && detailOwner.isCurrent()) { await detailOwner.reload(); if (detailOwner.isCurrent()) toast(target === 'verified' ? '已核對並鎖定離線批次' : target === 'closed' ? '已完成人工對帳' : '已取消離線批次', 'success'); }
  }, detailOwner.isCurrent);
  const recordResponse = (row, source, trigger, detailOwner) => actionRead(trigger, async (signal, current) => {
    const original = await readBatch(row.id, signal, current);
    if (original.version !== row.version) throw new Error('批次已更新，請重新讀取再記錄回應。');
    const editor = createClaimResponseEditor(original, source.billingDocumentId); let didWrite = false;
    const saved = await openForm({ title: `人工回應：${source.number}`, submitLabel: '儲存人工回應', fields: editor.fields, initial: editor.initial, isCurrent: current,
      onSubmit: async (values, owner) => {
        const payload = editor.buildPayload(values); if (!Object.keys(payload).length) return;
        const response = await api(`/api/${entity}/${encodeURIComponent(original.id)}`, { method: 'PATCH', body: { ...payload, version: original.version }, signal: owner.signal });
        if (!owner.isCurrent()) abort(); checkClaimBatchRecord(response, { id: original.id, orgId: org(), original, payload }); didWrite = true;
      } });
    if (saved && detailOwner.isCurrent()) { await detailOwner.reload(); if (detailOwner.isCurrent() && didWrite) toast('已儲存人工回應', 'success'); }
  }, detailOwner.isCurrent);
  const details = async (row, trigger, request) => {
    const current = () => alive() && trigger.isConnected && sequence === request;
    await openDetails({ title: '離線核銷批次詳情', wide: true, guardedRead: true, isCurrent: current, loadingText: '正在核對批次保存快照…',
      load: async (signal, owner) => {
        const item = await readBatch(row.id, signal, owner.isCurrent), replies = new Map(item.responses.map(reply => [reply.billingDocumentId, reply]));
        const actions = el('div', { class: 'actions' });
        if (item.status === 'draft') actions.append(actionButton('核對並鎖定', trigger => transition(item, 'verified', trigger, owner), 'primary'));
        if (item.status === 'reconciling') actions.append(actionButton('完成人工對帳', trigger => transition(item, 'closed', trigger, owner), 'primary'));
        if (!['draft', 'cancelled'].includes(item.status)) actions.append(actionButton('下載本機 CSV', trigger => actionRead(trigger, async (downloadSignal, downloadCurrent) => {
          const latest = await readBatch(item.id, downloadSignal, downloadCurrent);
          if (latest.version !== item.version) throw new Error('批次已更新，請重新讀取後下載。');
          await downloadCsv(`/api/${entity}/${encodeURIComponent(item.id)}/export?format=csv`, { filename: `本機核銷-${item.number}-v${item.version}.csv`, signal: downloadSignal, isCurrent: downloadCurrent });
          if (downloadCurrent()) toast('本機 CSV 下載已開始；尚未送出申報。', 'success');
        }, owner.isCurrent)));
        if (['draft', 'verified', 'reconciling'].includes(item.status)) actions.append(actionButton('取消批次', trigger => transition(item, 'cancelled', trigger, owner), 'danger'));
        const sources = item.sourceSnapshots.map(source => ({ ...source, response: replies.get(source.billingDocumentId) }));
        return el('section', {}, notice('本機格式，非FA或政府正式申報格式。這裡保存收到回應的人工記錄；人工對帳完成不代表政府核准，不會付款或對外送出。'),
          el('dl', { class: 'detail-grid' }, field('批次編號', item.number), field('月份', item.month), field('狀態', claimStatuses[item.status]), field('保存版次', String(item.version)),
            field('來源總額', formatMoney(item.summary.amountCents)), field('接受來源金額', formatMoney(item.summary.acceptedAmountCents)), field('退件來源金額', formatMoney(item.summary.rejectedAmountCents)),
            field('待定來源金額', formatMoney(item.summary.pendingAmountCents)), field('未回應來源金額', formatMoney(item.summary.unansweredAmountCents)), field('回應筆數', `${item.summary.responseCount} / ${item.summary.sourceCount}`),
            field('批次人工依據', item.sourceReference, true), field('收到回應的共同依據', item.responseSourceReference, true), field(item.status === 'cancelled' ? '取消原因' : '備註', item.note, true)), actions,
          el('h3', {}, '帳單保存快照與人工回應'), notice('下列姓名、金額與帳單版次依批次當時快照保存；核對鎖定後不回算。退件金額指被退件的原來源金額，接受金額欄才是本筆人工記錄接受值。'),
          table([{ key: 'number', label: '帳單編號' }, { key: 'caseName', label: '保存姓名' }, { key: 'version', label: '來源版次' }, { label: '原來源金額', render: source => formatMoney(source.amountCents) },
            { label: '回應結果', render: source => source.response ? claimResponseStatuses[source.response.status] : '尚未回應' }, { label: '回應接受金額', render: source => source.response ? formatMoney(source.response.amountCents) : '尚未回應' },
            { label: '本筆回應依據與原因', render: source => source.response ? el('div', { class: 'pre-wrap' }, source.response.reference, '\n', source.response.reason) : '尚未回應' },
            { label: '操作', render: source => ['verified', 'reconciling'].includes(item.status) ? actionButton(source.response ? '編輯人工回應' : '記錄人工回應', trigger => recordResponse(item, source, trigger, owner)) : '唯讀保存快照' }], sources,
          { caption: '批次來源與人工回應', emptyText: '無法確認來源帳單。' }));
      } });
    if (alive() && sequence === request) await load();
  };
  const load = async () => {
    if (!alive()) return;
    const request = ++sequence; controller?.abort(); controller = new AbortController(); body.dataset.renderVersion = `claim-batch:${request}`;
    body.replaceChildren(el('p', { class: 'loading', role: 'status' }, '正在讀取離線核銷批次…')); footer.replaceChildren();
    const params = new URLSearchParams({ page: String(page), pageSize: '25' }); if (query) params.set('q', query); if (status) params.set('status', status); if (month) params.set('month', month);
    try {
      const result = await api(`/api/${entity}?${params}`, { signal: controller.signal });
      if (!alive() || sequence !== request) return;
      const items = collection(result, { page, pageSize: 25, orgId: org() });
      if (page > 1 && !items.length && result.total) { page = Math.ceil(result.total / 25); return load(); }
      body.replaceChildren(table([{ key: 'month', label: '月份' }, { key: 'number', label: '批次編號' }, { label: '來源帳單', render: row => `${row.summary.sourceCount} 筆` },
        { label: '來源總額', render: row => formatMoney(row.summary.amountCents) }, { label: '已記錄回應', render: row => `${row.summary.responseCount} / ${row.summary.sourceCount}` },
        { label: '狀態', render: row => statusBadge(row.status) }, { label: '操作', render: row => {
          const actions = el('div', { class: 'actions row-actions' }); actions.append(actionButton('批次詳情', trigger => details(row, trigger, request)));
          if (row.status === 'draft') actions.append(actionButton('編輯草稿', trigger => editDraft(row, trigger)));
          actions.append(actionButton('版本歷程', trigger => openRecordHistory({ entity, id: row.id, isCurrent: () => alive() && trigger.isConnected && sequence === request })));
          return actions;
        } }], items, { caption: '離線核銷與人工對帳', emptyText: query || status || month ? '沒有符合條件的批次，請調整查詢。' : '目前尚無離線批次；請先建立並開立同月份人工帳單。' }));
      footer.replaceChildren(pagination({ page, pageSize: 25, total: result.total, onChange: next => { if (alive()) { page = next; void load(); } } }));
    } catch (error) { if (alive() && sequence === request && error.name !== 'AbortError') body.replaceChildren(errorState(error, load)); }
  };
  const statusId = `claim-status-${crypto.randomUUID()}`, statusControl = el('select', { id: statusId, class: 'input' }, el('option', { value: '' }, '全部狀態'), Object.entries(claimStatuses).map(([value, label]) => el('option', { value }, label)));
  statusControl.addEventListener('change', () => { if (alive()) { status = statusControl.value; page = 1; void load(); } });
  const monthId = `claim-month-${crypto.randomUUID()}`, monthControl = el('input', { id: monthId, type: 'month', class: 'input' });
  monthControl.addEventListener('change', () => { if (alive()) { month = monthControl.value; page = 1; void load(); } });
  const toolbar = el('div', { class: 'toolbar' }, searchBox({ label: '搜尋離線批次', placeholder: '搜尋批次、帳單編號、保存姓名或人工依據', onSearch: value => { if (alive()) { query = value; page = 1; void load(); } } }),
    el('label', { for: statusId, class: 'filter-field' }, el('span', {}, '狀態'), statusControl), el('label', { for: monthId, class: 'filter-field' }, el('span', {}, '月份'), monthControl));
  toolbar.querySelector('input[type="search"]').maxLength = 200;
  container.replaceChildren(pageHeader('離線核銷與人工對帳', '選取已開立帳單、核對鎖定，再逐筆保存收到的人工回應', [actionButton('新增離線批次', trigger => editDraft(null, trigger), 'primary')]),
    notice('僅管理者與財務可使用。匯出為本機公司資料，非FA正式格式或政府申報；人工對帳完成不代表政府核准。'), el('section', { class: 'panel' }, toolbar, body, footer));
  const invalidate = () => { if (alive()) return; ++sequence; controller?.abort(); observer.disconnect(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate); };
  const observer = new MutationObserver(invalidate); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
  window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate); await load();
}
