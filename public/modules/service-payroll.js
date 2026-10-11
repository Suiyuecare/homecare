import { CALENDAR_SPAN_MODE, spanRecordText } from '../data/shift-span-editor.js';
import { api, el, pageHeader, table, button, openForm, openDetails, confirmAction, toast,
  searchBox, pagination, getContext, today, errorState } from '../ui.js';
import { checkServicePayrollCollection, checkServicePayrollPreview, checkServicePayrollSaved,
  checkServicePayrollOriginCollection, checkServicePayrollOriginDetail, createServicePayrollEditor,
  servicePayrollSnapshotForDisplay, formatPayrollCents } from '../data/service-payroll-editor.js';

const spanMode = CALENDAR_SPAN_MODE;
const base = '/api/service-payroll';
const org = () => getContext().organizationId || getContext().orgId;
const identity = () => { const ctx = getContext(); return JSON.stringify([ctx.user?.id, org(), ctx.role, ctx.user?.employeeId || ctx.employeeId || '']); };
const abort = () => { throw new DOMException('操作已失效，請重新讀取保存結果。', 'AbortError'); };
const notice = text => el('p', { class: 'notice', role: 'note' }, text);
const money = value => `${formatPayrollCents(value)} 元`;
const statusLabels = { draft: '草稿', reviewed: '已覆核', closed: '已關帳', voided: '已取消' };
const field = (label, value, wide = false) => el('div', { class: wide ? 'field-wide' : '' }, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value || '未填寫'));
function actionButton(label, action, variant = 'outline') {
  let busy = false;
  const trigger = button(label, async () => {
    if (busy) return; busy = true; trigger.setAttribute('aria-busy', 'true'); trigger.setAttribute('aria-disabled', 'true');
    try { await action(trigger); }
    catch (error) { if (trigger.isConnected && error.name !== 'AbortError') toast(error.message || '操作失敗，請重試。', 'error'); }
    finally { busy = false; trigger.removeAttribute('aria-busy'); trigger.removeAttribute('aria-disabled'); }
  }, { variant }); return trigger;
}
function sourceView(source, index, caseNames = new Map()) {
  const snapshot = servicePayrollSnapshotForDisplay(source.billingSnapshot, source);
  if (!snapshot) throw new Error('來源保存快照無法確認。');
  return el('section', {}, el('h3', {}, `服務${index + 1} · ${source.date} · ${snapshot.employee.name}`),
    el('dl', { class: 'detail-grid' }, field('保存開始日期', source.date), ...(Object.hasOwn(source, 'actualEndDate') ? [field('保存實際結束日期', source.actualEndDate)] : []), field('個案（讀取範圍時參考名稱）', caseNames.get(source.caseId) || '請展開保存個案識別碼'), field('來源版次', String(source.version)),
      field('實際開始時間', source.actualStart), field('實際結束時間', source.actualEnd), field('保存實際分鐘', String(snapshot.serviceMinutes)),
      field('核閱快照捕捉時間', snapshot.capturedAt), field('保存員工姓名與編號', `${snapshot.employee.name} · ${snapshot.employee.employeeNo}`),
      field('保存試算時薪（未用於薪資結算）', money(snapshot.employee.hourlyRateCents)), field('快照幣別／來源／試算標記', `${snapshot.currency} · ${snapshot.source} · trial=true`)),
    notice('以下是核閱當時保存試算，僅供追溯；本次薪資結算使用另外人工核定的整體金額，不沿用此單價。個案參考名稱來自本次讀取範圍的同機構名單，不是核閱當時保存姓名；原個案識別碼可展開查閱。'),
    table([{ label: '保存服務代碼', render: item => el('span', { class: 'pre-wrap' }, item.code) }, { label: '保存服務名稱', render: item => el('span', { class: 'pre-wrap' }, item.name) }, { key: 'quantity', label: '保存數量' },
      { label: '保存試算單價', render: item => money(item.unitPriceCents) }, { label: '保存試算小計', render: item => money(item.amountCents) }], snapshot.items,
      { caption: `服務${index + 1} 完整核閱保存試算明細` }),
    el('details', {}, el('summary', {}, '保存來源識別與時間'), el('dl', { class: 'detail-grid' }, field('服務紀錄識別碼', source.id), field('機構識別碼', source.orgId),
      field('個案識別碼', source.caseId), field('員工識別碼', source.employeeId), field('班次識別碼', source.shiftId), field('快照員工識別碼', snapshot.employee.id),
      field('服務建立時間', source.createdAt), field('服務更新時間', source.updatedAt)),
    table([{ key: 'serviceItemId', label: '保存服務項目識別碼' }, { key: 'code', label: '服務代碼' }], snapshot.items, { caption: `服務${index + 1} 保存項目識別碼` })));
}
const manualTable = lines => table([{ label: '人工薪資結算明細名稱', render: row => el('span', { class: 'pre-wrap' }, row.label) }, { label: '人工核定整體金額', render: row => money(row.amountCents) },
  { label: '來源保存版次', render: row => String(row.version) }, { label: '本筆人工核對依據', render: row => el('span', { class: 'pre-wrap' }, row.sourceReference) }], lines, { caption: '人工核對薪資結算明細與依據' });
function previewView(preview, caseNames) {
  return el('div', {}, notice('本次預覽不寫入資料。確認後原子生成一份薪資結算草稿與不可改寫的來源保存紀錄；不會覆核、關帳、付款、推算薪資規則或執行任何法定申報。'),
    el('dl', { class: 'detail-grid' }, field('薪資結算編號', preview.draft.number), field('薪資結算月份', preview.draft.month),
      field('員工（本次預覽）', `${preview.draft.employeeSnapshot.name} · ${preview.draft.employeeSnapshot.employeeNo}`), field('人工明細筆數', String(preview.sourceCount)),
      field('人工核定加項總額', money(preview.draft.summary.earningCents)), field('減項合計', money(preview.draft.summary.deductionCents)), field('人工核定淨額', money(preview.draft.summary.netCents)), field('薪資結算共同人工核定依據', preview.draft.sourceReference, true), field('薪資結算備註', preview.draft.note, true)),
    manualTable(preview.manualLines), preview.sources.map((source, index) => sourceView(source, index, caseNames)));
}

export async function mountServicePayroll(container, { isCurrent = () => true } = {}) {
  const startedContext = getContext(), startedIdentity = identity(), startedHash = location.hash;
  const alive = () => container.isConnected && isCurrent() && getContext() === startedContext && identity() === startedIdentity && location.hash === startedHash;
  if (!['admin', 'finance'].includes(getContext().role)) { const error = new Error('僅管理者或財務可使用服務轉薪資。'); error.status = 403; container.replaceChildren(errorState(error)); return; }
  let caseNames = new Map();
  let scope, mode = 'sources', page = 1, query = '', sequence = 0, controller;
  const selected = new Map(), body = el('div', { class: 'list-content', 'aria-live': 'polite' }), footer = el('div', { class: 'list-footer' });
  const selectedPanel = el('section', { class: 'panel', 'aria-label': '待人工核對服務' }), scopePanel = el('div', { class: 'notice', role: 'note' });
  const searchSlot = el('div', {});
  const renderSearch = () => searchSlot.replaceChildren(searchBox({ value: query, label: '搜尋服務轉薪資',
    placeholder: '服務日期／保存服務名稱／代碼，或已生成結算編號', onSearch: value => { query = value; page = 1; load(); } }));
  const actionRead = async (trigger, action) => {
    const request = new AbortController(), current = () => alive() && (!trigger || trigger.isConnected);
    const invalidate = () => { if (!current()) request.abort(); };
    const observer = new MutationObserver(invalidate); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
    window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
    try { if (!current()) return; await action(request.signal, current); }
    finally { request.abort(); observer.disconnect(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate); }
  };
  const lookupChoices = async (entity, codeKey, signal, current) => {
    const values = [], ids = new Set(); let total;
    for (let page = 1; page <= 100; page++) {
      const response = await api(`/api/${entity}?page=${page}&pageSize=100`, { signal }); if (!current()) abort();
      if (!Array.isArray(response.items) || !Number.isSafeInteger(response.total) || response.total < 0 || response.items.length > 100
        || (total !== undefined && response.total !== total)) throw new Error('員工選項有變動，請重新讀取。');
      total = response.total;
      for (const row of response.items) {
        if (!row || row.orgId !== org() || typeof row.id !== 'string' || !row.id || ids.has(row.id) || typeof row.name !== 'string' || typeof row[codeKey] !== 'string' || !Number.isSafeInteger(row.version) || row.version < 1) throw new Error('同機構員工選項無法確認。');
        ids.add(row.id); values.push({ id: row.id, name: row.name, code: row[codeKey] });
      }
      if (values.length === total) return values;
      if (!response.items.length || values.length > total) throw new Error('員工選項不完整，請重新讀取。');
    }
    throw new Error('員工超過可選範圍，請先整理資料。');
  };
  const configure = trigger => actionRead(trigger, async (signal, current) => {
    const [employees, cases] = await Promise.all([lookupChoices('employees', 'employeeNo', signal, current), lookupChoices('cases', 'caseNo', signal, current)]); if (!current()) abort(); if (!employees.length) throw new Error('請先建立同機構員工。');
    const saved = await openForm({ title: '選擇服務來源範圍', submitLabel: '讀取此員工與月份', isCurrent: current,
      fields: [{ name: 'employeeId', label: '員工', type: 'select', required: true, options: employees.map(row => ({ value: row.id, label: `${row.name} · ${row.code}` })) },
        { name: 'month', label: '服務與薪資結算月份', type: 'month', required: true, help: '同員工、按保存開始日歸屬月份可合併不同個案；只選通過核閱且尚未導入薪資的服務。' }],
      initial: { employeeId: scope?.employeeId || '', month: scope?.month || today().slice(0, 7) },
      onSubmit: async (values, owner) => {
        const item = employees.find(row => row.id === values.employeeId);
        if (!item || typeof values.month !== 'string' || values.month.length !== 7 || !/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(values.month)) throw new Error('請選擇已確認員工及有效月份。');
        if (selected.size && (scope.employeeId !== item.id || scope.month !== values.month)) {
          if (!await confirmAction({ title: '改選服務來源範圍？', message: `目前 ${selected.size} 筆待核對選擇會清除；尚未產生薪資結算。`, confirmLabel: '改選並清除選擇', signal: owner.signal, isCurrent: owner.isCurrent })) throw new Error('尚未改選；原選擇仍保留。');
          selected.clear();
        }
        caseNames = new Map(cases.map(row => [row.id, `${row.name} · ${row.code}`]));
        scope = { employeeId: item.id, employeeName: `${item.name} · ${item.code}`, month: values.month }; page = 1; query = '';
      } });
    if (saved && alive()) { renderSearch(); renderSelected(); await load(); }
  });
  const originDetails = (row, trigger, request) => openDetails({ title: '已產生薪資及保存來源', wide: true, guardedRead: true,
    isCurrent: () => alive() && trigger.isConnected && request === sequence, loadingText: '正在重新核對保存來源與目前薪資結算…',
    load: async (signal, owner) => {
      const response = checkServicePayrollOriginDetail(await api(`${base}/origins/${encodeURIComponent(row.statement.id)}?spanMode=${spanMode}`, { signal }), { orgId: org(), statementId: row.statement.id, spanMode });
      if (!owner.isCurrent()) abort(); const { origin, statement } = response;
      return el('div', {}, notice('來源紀錄與生成當時薪資結算快照固定保留；目前薪資可沿原草稿編輯／人工加減項／覆核／關帳流程操作。生成當時人工金額、目前加減淨額與原服務試算分開顯示，不相互回算。'),
        el('dl', { class: 'detail-grid' }, field('薪資結算編號', origin.number), field('月份', origin.month), field('生成時員工姓名', `${origin.initialStatementSnapshot.employeeSnapshot.name} · ${origin.initialStatementSnapshot.employeeSnapshot.employeeNo}`),
          field('生成當時人工加項總額', money(origin.initialStatementSnapshot.summary.earningCents)), field('生成當時人工淨額', money(origin.initialStatementSnapshot.summary.netCents)), field('目前加項合計', money(statement.summary.earningCents)), field('目前減項合計', money(statement.summary.deductionCents)), field('目前人工核定淨額', money(statement.summary.netCents)), field('目前薪資結算狀態／版次', `${statusLabels[statement.status]} · ${statement.version}`),
          field('生成當時共同人工依據', origin.sourceReference, true), field('生成當時備註', origin.note, true), field('來源保存建立時間', origin.createdAt)),
        manualTable(origin.manualLines), el('h3', {}, '目前薪資結算明細'), table([{ label: '目前明細名稱', render: row => el('span', { class: 'pre-wrap' }, row.label) }, { label: '加項／減項', render: row => row.kind === 'earning' ? '加項' : '減項' },
          { label: '目前人工金額', render: row => money(row.amountCents) }], statement.lineItems, { caption: '目前薪資結算明細，與生成當時資料分開核對' }),
        el('dl', { class: 'detail-grid' }, field('目前薪資結算人工核定依據', statement.sourceReference, true), field('目前薪資備註／取消原因', statement.note, true)),
        el('details', {}, el('summary', {}, '保存來源與薪資結算識別／版次'), el('dl', { class: 'detail-grid' }, field('薪資結算識別碼', statement.id),
          field('來源保存識別碼', origin.id), field('機構識別碼', origin.orgId), field('來源保存版次', String(origin.version)),
          field('生成當時薪資結算版次', String(origin.initialStatementSnapshot.version)), field('生成當時薪資結算建立時間', origin.initialStatementSnapshot.createdAt),
          field('生成當時薪資結算更新時間', origin.initialStatementSnapshot.updatedAt), field('目前薪資結算更新時間', statement.updatedAt), field('來源保存更新時間', origin.updatedAt))),
        el('p', {}, el('a', { class: 'btn btn-outline', href: '#/payroll-statements' }, '前往人工薪資結算')),
        notice(`可於人工薪資結算清單搜尋編號「${origin.number}」，沿原流程編輯加減項、人工覆核與關帳。本機關帳不代表支付、法定工資核定、保險或稅務申報。`),
        origin.sourceSnapshots.map((source, index) => sourceView(source, index, caseNames)));
    } });
  const generate = trigger => actionRead(trigger, async (_signal, current) => {
    if (!scope || !selected.size) throw new Error('請先加入至少一筆待核對服務。');
    const editor = createServicePayrollEditor({ sources: [...selected.values()], orgId: org(), ...scope, spanMode });
    let preview, previewPayload, signature, key = crypto.randomUUID(), generated;
    const saved = await openForm({ title: '人工核對服務轉薪資', fields: editor.fields, initial: editor.initial, isCurrent: current,
      previewLabel: '預覽薪資結算與保存來源', submitLabel: '確認生成薪資結算草稿', previewInstruction: '人工輸入每筆總額與依據後先預覽；原核閱試算不會自動成為單價。',
      previewRequiredMessage: '請先核對金額、依據與保存來源預覽，再生成草稿。',
      onPreview: async (values, owner) => {
        const payload = editor.buildPayload(values);
        const response = await api(`${base}/preview`, { method: 'POST', body: payload, signal: owner.signal }); if (!current()) abort();
        preview = checkServicePayrollPreview(response, { orgId: org(), payload, sources: editor.sources }); previewPayload = JSON.stringify(payload);
        return { content: previewView(preview, caseNames), canSubmit: true };
      },
      onSubmit: async (values, owner) => {
        const payload = editor.buildPayload(values);
        if (!preview || previewPayload !== JSON.stringify(payload)) throw new Error('內容與預覽不同，請重新預覽。');
        if (!await confirmAction({ title: '確認生成這份人工薪資結算草稿？', message: `${payload.number} · ${scope.employeeName} · ${payload.month} · ${money(preview.draft.summary.netCents)}。${payload.lines.length} 筆來源將永久標示已導入，薪資結算取消也不釋放；帳單導入與薪資導入各自獨立。只生成草稿，不覆核、關帳或付款。`,
          confirmLabel: '確認生成草稿', signal: owner.signal, isCurrent: owner.isCurrent })) throw new Error('尚未生成；金額與依據仍保留。');
        const sent = { ...payload, previewHash: preview.previewHash }, nextSignature = JSON.stringify(sent);
        if (signature !== undefined && signature !== nextSignature) key = crypto.randomUUID(); signature = nextSignature;
        let response;
        try { response = await api(`${base}/create`, { method: 'POST', body: sent, headers: { 'Idempotency-Key': key }, signal: owner.signal }); }
        catch (error) { if (error.status === 409) error.invalidatePreview = true; throw error; }
        if (!owner.isCurrent()) abort(); generated = checkServicePayrollSaved(response, { orgId: org(), payload, sources: editor.sources, preview });
      } });
    if (saved && alive() && generated) { selected.clear(); mode = 'origins'; query = ''; page = 1; renderSearch(); renderSelected(); await load(); if (alive()) toast(`已生成薪資結算草稿 ${generated.item.number}`, 'success'); }
  });
  function renderSelected() {
    if (!alive()) return;
    const generateButton = actionButton('人工核對並預覽', generate, 'primary'); generateButton.disabled = selected.size === 0;
    selectedPanel.replaceChildren(el('h2', {}, `待人工核對服務 · ${selected.size} 筆`), notice('加入或移除選擇不寫入資料；只有預覽後明確確認才生成草稿。'),
      selected.size ? table([{ label: '保存完整實際時段', render: row => Object.hasOwn(row, 'actualEndDate') ? spanRecordText(row, 'service-records') : row.date }, { label: '個案（讀取範圍時參考名稱）', render: row => caseNames.get(row.caseId) || '請查看保存識別' }, { label: '保存員工姓名', render: row => row.billingSnapshot.employee.name },
        { label: '保存服務名稱與數量', render: row => row.billingSnapshot.items.map(item => `${item.name} × ${item.quantity}`).join('；') },
        { label: '操作', render: row => actionButton('移除待核對', async () => { selected.delete(row.id); renderSelected(); await load(); }) }], [...selected.values()], { emptyText: '尚未選擇待核對服務。', caption: '待人工核對服務來源' }) : el('p', {}, '尚未選擇；請在下方已核閱服務清單加入待核對來源。'),
      generateButton);
  }
  async function load() {
    if (!alive()) return; controller?.abort(); controller = new AbortController(); const request = ++sequence, signal = controller.signal; body.dataset.renderVersion = `service-payroll:${request}`;
    scopePanel.textContent = scope ? `目前員工：${scope.employeeName}；服務／薪資結算月份：${scope.month}；模式：${mode === 'sources' ? '可導入已核閱服務' : '已產生薪資及來源'}。` : '尚未指定員工與月份；請先選擇服務來源範圍。';
    footer.replaceChildren(); body.replaceChildren(el('p', { role: 'status' }, scope ? '正在讀取…' : '請先指定員工及月份，再選擇服務或查看已生成來源。'));
    if (!scope) return;
    try {
      const params = new URLSearchParams({ employeeId: scope.employeeId, month: scope.month, q: query, page: String(page), pageSize: '25', spanMode });
      const response = await api(`${base}/${mode}?${params}`, { signal });
      if (!alive() || request !== sequence) return;
      const options = { orgId: org(), employeeId: scope.employeeId, month: scope.month, q: query, page, pageSize: 25, spanMode };
      const rows = mode === 'sources' ? checkServicePayrollCollection(response, options) : checkServicePayrollOriginCollection(response, options);
      if (page > 1 && !rows.length && response.total <= (page - 1) * 25) { page = Math.max(1, Math.ceil(response.total / 25)); return load(); }
      const columns = mode === 'sources' ? [{ label: '保存完整實際時段', render: row => Object.hasOwn(row, 'actualEndDate') ? spanRecordText(row, 'service-records') : row.date }, { label: '個案（讀取範圍時參考名稱）', render: row => caseNames.get(row.caseId) || '請查看保存個案識別' }, { label: '保存員工姓名／編號', render: row => `${row.billingSnapshot.employee.name} · ${row.billingSnapshot.employee.employeeNo}` },
        { label: '保存服務名稱與數量', render: row => row.billingSnapshot.items.map(item => `${item.name} × ${item.quantity}`).join('；') }, { label: '版次', render: row => String(row.version) },
        { label: '操作', render: row => el('div', { class: 'actions' }, actionButton(selected.has(row.id) ? '已加入待核對' : '加入待核對', async () => {
          if (selected.has(row.id)) return; if (selected.size >= 100) throw new Error('每次最多核對100筆服務。'); selected.set(row.id, row); renderSelected(); await load(); }),
        actionButton('查看核閱保存來源', trigger => openDetails({ title: '已核閱服務保存來源', wide: true, guardedRead: true, isCurrent: () => alive() && trigger.isConnected && request === sequence,
          load: async (signal, owner) => { const fresh = await api(`${base}/sources?${new URLSearchParams({ employeeId: options.employeeId, month: options.month, q: options.q, page: String(options.page), pageSize: String(options.pageSize), spanMode })}`, { signal });
            if (!owner.isCurrent()) abort(); const confirmed = checkServicePayrollCollection(fresh, options).find(source => source.id === row.id);
            if (!confirmed || confirmed.version !== row.version || JSON.stringify(confirmed) !== JSON.stringify(row)) throw new Error('來源已變動或超出目前可核對範圍，請重新讀取。'); return sourceView(confirmed, 0, caseNames); } }))) }]
        : [{ label: '薪資結算編號', render: row => row.origin.number }, { label: '生成當時人工淨額', render: row => money(row.origin.initialStatementSnapshot.summary.netCents) },
          { label: '目前人工核定淨額', render: row => money(row.statement.summary.netCents) }, { label: '目前狀態', render: row => statusLabels[row.statement.status] },
          { label: '保存來源筆數', render: row => String(row.origin.sourceSnapshots.length) }, { label: '操作', render: row => actionButton('查看薪資結算及保存來源', trigger => originDetails(row, trigger, request)) }];
      body.replaceChildren(table(columns, rows, { caption: mode === 'sources' ? '可導入的已核閱服務' : '已產生薪資及保存來源', emptyText: query ? '此範圍沒有符合搜尋的資料。' : mode === 'sources' ? '此員工月份沒有尚可導入的已核閱服務。' : '此員工月份尚無服務生成薪資結算。' }));
      footer.replaceChildren(pagination({ page, pageSize: 25, total: response.total, onChange: value => { page = value; load(); } }));
    } catch (error) { if (alive() && request === sequence && error.name !== 'AbortError') body.replaceChildren(errorState(error, load)); }
  }
  const switchMode = next => { if (!alive() || mode === next) return; mode = next; page = 1; query = ''; renderSearch(); load(); };
  container.replaceChildren(pageHeader('服務轉薪資', '核閱服務 → 人工核對金額與依據 → 預覽 → 生成薪資結算草稿', [actionButton('選擇員工與月份', configure, 'primary')]),
    notice('只處理本機人工薪資加項草稿；不推定正式薪資、最低工資、保險、稅費、法定資格或支付規則。不同個案可按同員工月份合併；帳單與薪資導入各自獨立。核閱試算與人工金額分開保存。'),
    scopePanel, el('div', { class: 'actions' }, actionButton('可導入已核閱服務', async () => switchMode('sources')), actionButton('已產生薪資及來源', async () => switchMode('origins'))),
    selectedPanel, el('section', { class: 'panel' }, searchSlot, body, footer));
  const invalidate = () => { if (alive()) return; ++sequence; controller?.abort(); observer.disconnect(); window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate); };
  const observer = new MutationObserver(invalidate); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
  window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
  renderSearch(); renderSelected(); await load();
}
