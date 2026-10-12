import { api, el, pageHeader, table, button, openDetails, getContext, pagination, errorState, toast } from '../ui.js';
import { formatTrialPriceCents } from '../data/history-fields.js';
import { legacyMigrationsIdentity, confirmLegacyMigrationList, confirmLegacyMigrationBatch, confirmLegacyMigrationRecord, legacyScalarText } from '../data/legacy-migrations.js';

let generation = 0;
const note = value => el('p', { class: 'muted' }, value);
const literal = value => el('span', { class: 'pre-wrap' }, legacyScalarText(value));
const entityLabel = entity => entity === 'cases' ? '個案' : '員工';
const identityDetails = (label, value) => el('details', {}, el('summary', {}, label), el('p', { class: 'pre-wrap' }, value));
const sourceNotice = () => el('aside', { class: 'notice', role: 'note' }, el('strong', {}, '保留移轉當時資料'),
  el('p', {}, '這裡顯示已匯入的營運資料與來源原欄位；原系統全部資料仍待盤點。沒有持續查詢或同步原系統目前資料。'));
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

export async function renderLegacyMigrations(container, { isCurrent = () => true } = {}) {
  const context = getContext(), identity = legacyMigrationsIdentity(context), startedHash = location.hash;
  const orgId = context.organizationId ?? context.orgId, render = 'legacy-migrations:' + ++generation;
  if (context.role !== 'admin' || typeof orgId !== 'string' || !orgId || typeof context.user?.id !== 'string' || !context.user.id) {
    const error = new Error('只有本機構管理者可以查看移轉來源欄位。'); error.status = 403; container.replaceChildren(errorState(error)); return;
  }
  container.dataset.renderVersion = render;
  let sequence = 0, page = 1, controller, invalidated = false;
  const alive = () => !invalidated && container.isConnected && isCurrent() && getContext() === context && context.role === 'admin'
    && legacyMigrationsIdentity(getContext()) === identity && location.hash === startedHash && container.dataset.renderVersion === render;
  const body = el('div', { class: 'list-content', 'aria-live': 'polite' }), footer = el('div', { class: 'list-footer' });
  const retire = error => {
    if (invalidated) return; invalidated = true; ++sequence; controller?.abort(); observer.disconnect();
    window.removeEventListener('hashchange', invalidate); window.removeEventListener('session-updated', invalidate);
    body.replaceChildren(); footer.replaceChildren();
    if (container.isConnected && container.dataset.renderVersion === render) {
      container.replaceChildren(errorState(error));
    }
  };
  const invalidate = () => {
    if (invalidated || alive()) return;
    const error = new Error('目前登入或機構已變更，請重新進入移轉紀錄。'); error.status = 403; retire(error);
  };
  const observer = new MutationObserver(invalidate);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-render-version'] });
  window.addEventListener('hashchange', invalidate); window.addEventListener('session-updated', invalidate);
  const read = async (path, signal) => {
    try { return await api(path, { signal }); }
    catch (error) {
      if ([401, 403].includes(error.status)) {
        const denied = new Error('目前無權查看移轉紀錄，請重新登入或聯絡機構管理者。'); denied.status = error.status; retire(denied);
      }
      throw error;
    }
  };

  const openRecord = (row, parent, trigger, parentCurrent) => {
    if (!alive() || !trigger.isConnected || !parentCurrent()) return;
    return openDetails({ title: '完整移轉來源欄位', wide: true, guardedRead: true, isCurrent: () => alive() && trigger.isConnected && parentCurrent(),
      loadingText: '正在重新讀取這筆來源資料…', load: async (signal, owner) => {
        const response = await read(`/api/legacy-migrations/records/${encodeURIComponent(row.id)}`, signal);
        if (signal.aborted || !owner.isCurrent()) throw new DOMException('操作已取消。', 'AbortError');
        const saved = confirmLegacyMigrationRecord(response, { orgId, id: row.id });
        if (saved.item.batchId !== parent.id || saved.item.entity !== row.entity || saved.item.sourceId !== row.sourceId || saved.item.targetId !== row.targetId
            || saved.batch.sourceHash !== parent.sourceHash || saved.batch.payloadHash !== parent.payloadHash) throw new Error('移轉批次已變更，請重新查詢。');
        const changed = saved.fields.filter(field => field.comparison !== 'same').length;
        return el('section', { 'aria-label': '完整移轉來源資料' }, sourceNotice(),
          saved.item.businessNoOrigin === 'derived' ? el('aside', { class: 'notice', role: 'note' }, el('strong', {}, '此編號由移轉時產生'), el('p', {}, '來源未提供員工編號，這是替代編號，不是原機構員工編號。')) : null,
          metadataList([['移轉時姓名', saved.item.name], ['資料種類', entityLabel(saved.item.entity)], ['移轉時編號', saved.item.businessNo],
            ['來源建立時間（原文）', legacyScalarText(saved.item.sourceCreatedAt)], ['來源工作表列號', String(saved.item.rowNumber)], ['目前主檔版次', `第 ${saved.currentTarget.version} 版`]]),
          el('h3', {}, '移轉時保存欄位與目前主檔'), note(`本次已對應 ${saved.fields.length} 欄；${changed} 欄有差異或目前未提供。僅比較本次對應欄位，不代表原系統目前狀態。`),
          table([{ label: '欄位', render: field => field.label }, { label: '移轉時保存', render: field => literal(field.source) }, { label: '目前主檔', render: field => literal(field.current) },
            { label: '比對', render: field => ({ same: '相同', changed: '不同', missing: '目前未提供' })[field.comparison] }], saved.fields, { caption: '移轉時保存欄位與目前主檔，可左右捲動' }),
          Object.hasOwn(saved.currentTarget, 'hourlyRateCents') ? note(`目前主檔的試算時薪：${formatTrialPriceCents(saved.currentTarget.hourlyRateCents)}。這不是本次移轉核定的薪資。`) : null,
          el('h3', {}, '完整來源原欄位'), note('原始值、公式及保存的計算值都按文字顯示；不執行公式、不開啟連結。'),
          table([{ label: '來源欄號', render: column => String(column.columnIndex) }, { label: '來源欄位名稱', render: column => literal(column.label) },
            { label: '原始值', render: column => literal(column.raw) }, { label: '公式（原文）', render: column => literal(column.formula) }, { label: '原保存計算值', render: column => literal(column.cached) }],
          saved.item.columns, { caption: '完整來源原欄位，可左右捲動' }),
          identityDetails('查看來源與移轉識別碼', `來源 ${saved.batch.provider}／${saved.batch.tenant}\n原識別碼 ${saved.item.sourceId}\n來源檔案 ${saved.item.sourceFileId}\n移轉紀錄 ${saved.item.id}\n目前主檔 ${saved.item.targetId}\n批次 ${saved.item.batchId}`));
      } });
  };
  const openBatch = (row, trigger) => {
    if (!alive() || !trigger.isConnected) return; let batchPage = 1;
    return openDetails({ title: '移轉批次資料', wide: true, guardedRead: true, isCurrent: () => alive() && trigger.isConnected,
      loadingText: '正在重新讀取移轉批次…', load: async (signal, owner) => {
        const requestedPage = batchPage;
        const response = await read(`/api/legacy-migrations/batches/${encodeURIComponent(row.id)}?page=${requestedPage}&pageSize=25`, signal);
        if (signal.aborted || !owner.isCurrent()) throw new DOMException('操作已取消。', 'AbortError');
        const saved = confirmLegacyMigrationBatch(response, { orgId, id: row.id, page: requestedPage, pageSize: 25 });
        if (saved.item.sourceHash !== row.sourceHash || saved.item.payloadHash !== row.payloadHash) throw new Error('移轉批次已變更，請重新查詢。');
        let pager;
        pager = pagination({ page: requestedPage, pageSize: 25, total: saved.total, onChange: next => { if (!owner.isCurrent() || !pager.isConnected) return; batchPage = next; owner.reload(); } });
        return el('section', { 'aria-label': '移轉批次保存資料' }, sourceNotice(),
          metadataList([['保存時間（UTC）', saved.item.importedAt], ['來源標記', `${saved.item.provider}／${saved.item.tenant}`], ['個案', `${saved.item.caseCount} 筆`], ['員工', `${saved.item.employeeCount} 筆`]]),
          el('h3', {}, '本批移轉紀錄'), table([{ label: '資料種類', render: record => entityLabel(record.entity) },
            { label: '移轉時姓名', render: record => literal(record.name) }, { label: '移轉時編號', render: record => el('div', {}, literal(record.businessNo), record.businessNoOrigin === 'derived' ? note('移轉產生的替代編號') : null) },
            { label: '來源建立時間（原文）', render: record => literal(record.sourceCreatedAt) }, { label: '操作', render: record =>
              readAction('查看原欄位', () => alive() && owner.isCurrent(), trigger => openRecord(record, saved.item, trigger, owner.isCurrent)) }], saved.records,
          { caption: '本批移轉紀錄，每頁最多 25 筆，可左右捲動' }), pager,
          identityDetails('查看批次完整性識別碼', `批次 ${saved.item.id}\n封存 ${saved.item.archiveId}\n封存完整性 ${saved.item.archiveManifestSha256}\n來源完整性 ${saved.item.sourceHash}\n移轉內容完整性 ${saved.item.payloadHash}`));
      } });
  };
  async function load() {
    if (!alive()) { invalidate(); return; }
    const own = ++sequence, requestedPage = page; controller?.abort(); controller = new AbortController(); const active = controller;
    body.replaceChildren(el('p', { class: 'loading', role: 'status' }, '正在讀取移轉紀錄…')); footer.replaceChildren();
    try {
      const response = await read(`/api/legacy-migrations?page=${requestedPage}&pageSize=25`, active.signal);
      if (!alive() || active.signal.aborted || own !== sequence) return;
      const saved = confirmLegacyMigrationList(response, { orgId, page: requestedPage, pageSize: 25 });
      body.replaceChildren(table([{ label: '移轉保存時間（UTC）', render: row => literal(row.importedAt) }, { label: '來源', render: row => `${row.provider}／${row.tenant}` },
        { label: '個案', render: row => `${row.caseCount} 筆` }, { label: '員工', render: row => `${row.employeeCount} 筆` },
        { label: '操作', render: row => readAction('查看批次', alive, trigger => openBatch(row, trigger)) }], saved.items,
      { caption: '移轉批次，每頁最多 25 筆，可左右捲動', emptyText: '尚無移轉批次；請由管理者依核定移轉流程建立。' }));
      footer.replaceChildren(pagination({ page: requestedPage, pageSize: 25, total: saved.total, onChange: next => { if (!alive()) return; page = next; load(); } }));
    } catch (error) { if (alive() && own === sequence && error.name !== 'AbortError') { body.replaceChildren(errorState(error, load)); footer.replaceChildren(); } }
  }
  container.replaceChildren(pageHeader('移轉紀錄', '核對已匯入資料與移轉當時的完整來源欄位'), sourceNotice(),
    el('div', { class: 'toolbar' }, note('完整原欄位可能包含身分或銀行資料，僅本機構管理者可查看。'), button('重新讀取', load, { variant: 'outline' })), body, footer);
  await load();
}
