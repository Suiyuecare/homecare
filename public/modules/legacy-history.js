import { api, el, pageHeader, table, button, openDetails, getContext, pagination, errorState, toast } from '../ui.js';
import { legacyHistoryIdentity, legacyHistoryScalarText, legacyHistoryCategories, confirmLegacyHistoryList, confirmLegacyHistoryBatch, confirmLegacyHistoryRow } from '../data/legacy-history.js';

let generation = 0;
const note = value => el('p', { class: 'muted' }, value);
const literal = value => el('span', { class: 'pre-wrap' }, legacyHistoryScalarText(value));
const technicalDetails = (label, value) => el('details', {}, el('summary', {}, label), el('p', { class: 'pre-wrap' }, value));
const sourceNotice = () => el('aside', { class: 'notice', role: 'note' }, el('strong', {}, '已封存的歷史原始紀錄'),
  el('p', {}, '供核對原匯出與原頁內容，尚未轉成新系統排班、核閱服務、帳務或核定薪資。已封存不代表原平台全部資料已移轉，也不會持續同步原平台。'));
const periodsText = values => values.length ? values.join('、') : '來源未提供月份';
function metadataList(pairs) { return el('dl', { class: 'detail-grid' }, pairs.map(([label, value]) => el('div', {}, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value)))); }
function readAction(label, current, run) {
  let busy = false;
  const trigger = button(label, async () => {
    if (busy || !current() || !trigger.isConnected) return;
    busy = true; trigger.setAttribute('aria-busy', 'true'); trigger.setAttribute('aria-disabled', 'true');
    try { await run(trigger); }
    catch (error) { if (current() && trigger.isConnected && error.name !== 'AbortError') toast(error.message, 'error'); }
    finally { busy = false; trigger.removeAttribute('aria-busy'); trigger.removeAttribute('aria-disabled'); }
  }, { variant: 'outline' });
  return trigger;
}
function linkedPerson(reference, entity) {
  if (!reference) return note('尚未核對關聯');
  const number = entity === 'case' ? reference.caseNo : reference.employeeNo;
  return el('div', {}, literal(reference.name), note(`${number} · 目前主檔第 ${reference.version} 版`),
    note(entity === 'case' ? ({ active: '目前服務中', paused: '目前暫停服務', closed: '目前已結案' })[reference.status]
      : ({ active: '目前在職', inactive: '目前已停用' })[reference.status]));
}
function originalIdentity(row) {
  return row.sourceNativeId === null ? '來源未提供原始識別碼'
    : row.sourceNativeId === '' ? '來源保存空白識別碼' : row.sourceNativeId;
}
function locatorText(value) {
  return value.kind === 'worksheet-row' ? `原工作表第 ${value.sheetIndex} 張／原列第 ${value.rowNumber} 列` : `原 JSON 位置（只讀文字）：${value.pointer === '' ? '根位置' : value.pointer}`;
}

export async function renderLegacyHistory(container, { isCurrent = () => true } = {}) {
  const context = getContext(), identity = legacyHistoryIdentity(context), startedHash = location.hash;
  const orgId = context.organizationId ?? context.orgId, render = 'legacy-history:' + ++generation;
  if (context.role !== 'admin' || typeof orgId !== 'string' || !orgId || typeof context.user?.id !== 'string' || !context.user.id) {
    const error = new Error('只有本機構管理者可以查看歷史原始紀錄。'); error.status = 403; container.replaceChildren(errorState(error)); return;
  }
  container.dataset.renderVersion = render;
  let sequence = 0, page = 1, controller, invalidated = false;
  const alive = () => !invalidated && container.isConnected && isCurrent() && getContext() === context && context.role === 'admin'
    && legacyHistoryIdentity(getContext()) === identity && location.hash === startedHash && container.dataset.renderVersion === render;
  const body = el('div', { class: 'list-content', 'aria-live': 'polite' }), footer = el('div', { class: 'list-footer' });
  const retire = error => {
    if (invalidated) return; invalidated = true; ++sequence; controller?.abort(); observer.disconnect();
    window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate);
    body.replaceChildren(); footer.replaceChildren();
    if (container.isConnected && container.dataset.renderVersion === render) container.replaceChildren(errorState(error));
  };
  const invalidate = () => {
    if (invalidated || alive()) return;
    const error = new Error('目前登入或機構已變更，請重新進入歷史原始紀錄。'); error.status = 403; retire(error);
  };
  const observer = new MutationObserver(invalidate);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
  window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
  const read = async (path, signal) => {
    try { return await api(path, { signal }); }
    catch (error) {
      if ([401, 403].includes(error.status)) {
        const denied = new Error('目前無權查看歷史原始紀錄，請重新登入或聯絡機構管理者。'); denied.status = error.status; retire(denied);
      }
      throw error;
    }
  };
  const openRow = (row, parent, trigger, parentCurrent) => {
    if (!alive() || !trigger.isConnected || !parentCurrent()) return;
    return openDetails({ title: '完整歷史原欄位', wide: true, guardedRead: true, isCurrent: () => alive() && trigger.isConnected && parentCurrent(),
      loadingText: '正在重新讀取這筆歷史原文…', load: async (signal, owner) => {
        const response = await read(`/api/legacy-history/rows/${encodeURIComponent(row.id)}`, signal);
        if (signal.aborted || !owner.isCurrent()) throw new DOMException('操作已取消。', 'AbortError');
        const saved = confirmLegacyHistoryRow(response, { orgId, id: row.id });
        const stable = ['batchId', 'category', 'reportingPeriod', 'sourceNativeId', 'sourceCreatedAt', 'caseId', 'employeeId', 'sourceFileId', 'sourceFileSha256', 'identityKind', 'version'];
        if (stable.some(key => saved.item[key] !== row[key]) || JSON.stringify(saved.item.locator) !== JSON.stringify(row.locator)
            || saved.batch.sourceHash !== parent.sourceHash || saved.batch.payloadHash !== parent.payloadHash || saved.batch.archiveManifestSha256 !== parent.archiveManifestSha256) throw new Error('歷史封存批次已變更，請重新查詢。');
        return el('section', { 'aria-label': '完整歷史原始資料' }, sourceNotice(),
          metadataList([['來源類別', legacyHistoryCategories[saved.item.category]], ['來源月份', saved.item.reportingPeriod ?? '來源未提供月份'],
            ['來源建立時間（原文）', legacyHistoryScalarText(saved.item.sourceCreatedAt)], ['原始識別碼', originalIdentity(saved.item)],
            ['原檔案位置', locatorText(saved.item.locator)]]),
          el('h3', {}, '已核對的目前主檔關聯'), note('下列名稱、編號、狀態及版次來自新系統目前主檔。這是人工核對關聯，不代表原始服務已轉換或核閱。'),
          metadataList([['關聯個案', linkedPerson(saved.item.caseReference, 'case')], ['關聯員工', linkedPerson(saved.item.employeeReference, 'employee')]]),
          el('h3', {}, '完整來源原欄位'), note(`共 ${saved.item.columns.length} 欄。原始值、公式及原保存計算值完整按文字呈現；不執行公式或連結，不把原價視為新系統核定價格。`),
          table([{ label: '原欄號', render: column => String(column.columnIndex) }, { label: '原欄位名稱', render: column => literal(column.label) },
            { label: '原始值', render: column => literal(column.raw) }, { label: '公式（原文）', render: column => literal(column.formula) },
            { label: '原保存計算值', render: column => literal(column.cached) }], saved.item.columns, { caption: '完整歷史原欄位，可左右捲動' }),
          technicalDetails('查看封存定位與完整性識別碼', `新系統封存列識別碼 ${saved.item.id}\n識別種類 archive-locator（封存定位，不是原服務事件 UUID）\n來源檔案 ${saved.item.sourceFileId}\n原檔案完整性 ${saved.item.sourceFileSha256}\n批次 ${saved.item.batchId}\n封存 ${saved.batch.archiveId}\n來源 ${saved.batch.provider}／${saved.batch.tenant}`));
      } });
  };
  const openBatch = (row, trigger) => {
    if (!alive() || !trigger.isConnected) return; let batchPage = 1;
    return openDetails({ title: '歷史原始批次', wide: true, guardedRead: true, isCurrent: () => alive() && trigger.isConnected,
      loadingText: '正在重新讀取歷史批次…', load: async (signal, owner) => {
        const requestedPage = batchPage, response = await read(`/api/legacy-history/batches/${encodeURIComponent(row.id)}?page=${requestedPage}&pageSize=25`, signal);
        if (signal.aborted || !owner.isCurrent()) throw new DOMException('操作已取消。', 'AbortError');
        const saved = confirmLegacyHistoryBatch(response, { orgId, id: row.id, page: requestedPage, pageSize: 25 });
        if (saved.item.sourceHash !== row.sourceHash || saved.item.payloadHash !== row.payloadHash || saved.item.archiveManifestSha256 !== row.archiveManifestSha256) throw new Error('歷史封存批次已變更，請重新查詢。');
        let pager;
        pager = pagination({ page: requestedPage, pageSize: 25, total: saved.total, onChange: next => { if (!owner.isCurrent() || !pager.isConnected) return; batchPage = next; owner.reload(); } });
        return el('section', { 'aria-label': '歷史批次原始紀錄' }, sourceNotice(),
          metadataList([['封存保存時間（UTC）', saved.item.importedAt], ['來源標記', `${saved.item.provider}／${saved.item.tenant}`],
            ['來源月份', periodsText(saved.item.reportingPeriods)], ['本批原始列數', `${saved.item.rowCount} 列`], ['來源類別', saved.item.categories.map(category => legacyHistoryCategories[category]).join('、')]]),
          el('h3', {}, '本批歷史原始紀錄'),
          table([{ label: '來源類別', render: record => legacyHistoryCategories[record.category] }, { label: '來源月份', render: record => record.reportingPeriod ?? '來源未提供月份' },
            { label: '已核對個案', render: record => linkedPerson(record.caseReference, 'case') }, { label: '已核對員工', render: record => linkedPerson(record.employeeReference, 'employee') },
            { label: '原始識別碼', render: record => literal(originalIdentity(record)) },
            { label: '操作', render: record => readAction('查看原文', () => alive() && owner.isCurrent(), trigger => openRow(record, saved.item, trigger, owner.isCurrent)) }],
          saved.records, { caption: '本批歷史原始列，每頁最多 25 列，可左右捲動' }), pager,
          technicalDetails('查看批次完整性識別碼', `批次 ${saved.item.id}\n封存 ${saved.item.archiveId}\n封存完整性 ${saved.item.archiveManifestSha256}\n來源完整性 ${saved.item.sourceHash}\n保存內容完整性 ${saved.item.payloadHash}`));
      } });
  };
  async function load() {
    if (!alive()) { invalidate(); return; }
    const own = ++sequence, requestedPage = page; controller?.abort(); controller = new AbortController(); const active = controller;
    body.replaceChildren(el('p', { class: 'loading', role: 'status' }, '正在讀取歷史原始批次…')); footer.replaceChildren();
    try {
      const response = await read(`/api/legacy-history?page=${requestedPage}&pageSize=25`, active.signal);
      if (!alive() || active.signal.aborted || own !== sequence) return;
      const saved = confirmLegacyHistoryList(response, { orgId, page: requestedPage, pageSize: 25 });
      body.replaceChildren(table([{ label: '封存保存時間（UTC）', render: row => literal(row.importedAt) }, { label: '來源', render: row => `${row.provider}／${row.tenant}` },
        { label: '來源月份', render: row => periodsText(row.reportingPeriods) }, { label: '來源類別', render: row => row.categories.map(category => legacyHistoryCategories[category]).join('、') }, { label: '原始列數', render: row => `${row.rowCount} 列` },
        { label: '操作', render: row => readAction('查看批次', alive, trigger => openBatch(row, trigger)) }], saved.items,
      { caption: '歷史原始批次，每頁最多 25 批，可左右捲動', emptyText: '尚無已封存的歷史原始批次；請由管理者依受控封存流程建立。' }));
      footer.replaceChildren(pagination({ page: requestedPage, pageSize: 25, total: saved.total, onChange: next => { if (!alive()) return; page = next; load(); } }));
    } catch (error) { if (alive() && own === sequence && error.name !== 'AbortError') { body.replaceChildren(errorState(error, load)); footer.replaceChildren(); } }
  }
  container.replaceChildren(pageHeader('歷史原始紀錄', '查閱已封存的原匯出與原頁，核對來源、月份及目前主檔關聯'), sourceNotice(),
    el('div', { class: 'toolbar' }, note('原欄位可能包含身分或銀行資料，僅本機構管理者可查看。'), button('重新讀取', load, { variant: 'outline' })), body, footer);
  await load();
}
