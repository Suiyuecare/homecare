import { api, el, pageHeader, table, button, getContext, createForm, openDetails, searchBox, pagination, errorState, formatMoney } from '../ui.js';
import { LTC_BA_AA_CATALOG } from '../data/ltc-ba-aa-catalog.js';
import { LTC_CODE_CALCULATION_MODE, calculateLtcCodeAmount } from '../data/ltc-code-calculation.js';
import { canonicalCalculationJson } from '../data/calculation-core.js';
const roundings = [{ value: 'floor', label: '無條件捨去至分' }, { value: 'ceiling', label: '無條件進位至分' }, { value: 'half-up', label: '四捨五入至分' }, { value: 'half-even', label: '同值取偶數至分' }];
const contexts = { standard: '一般支付情形', 'shared-family-50-percent': 'BA15 共用區域／BA16 含家人物品：50% 支付', 'case-management-over-limit-90-percent': 'AA01／AA02 核准超額組數：90% 支付' };
const identity = () => { const c = getContext(); return JSON.stringify([c.user?.id, c.organizationId || c.orgId, c.role, c.user?.employeeId || c.employeeId || '']); };
const invalid = () => { throw new Error('無法確認官方清冊、來源機構或試算結果，請重新讀取。'); };
export async function confirmLtcPreview(response, payload, orgId) {
  if (response?.mode !== LTC_CODE_CALCULATION_MODE || response.sourceSnapshot?.orgId !== orgId || response.sourceSnapshot.id !== payload.source.id
      || response.sourceSnapshot.version !== payload.source.version || typeof response.previewHash !== 'string') invalid();
  const expected = calculateLtcCodeAmount({ catalogVersion: payload.catalogVersion, source: response.sourceSnapshot, policy: payload.policy });
  const { previewHash, ...body } = response;
  if (canonicalCalculationJson(body) !== canonicalCalculationJson(expected)) invalid();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalCalculationJson(expected)));
  if ([...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') !== previewHash) invalid();
  return response;
}
export async function mountLtcCodes(container, { isCurrent = () => true } = {}) {
  const context = getContext(), stamp = identity(), hash = location.hash, orgId = context.organizationId || context.orgId;
  const alive = () => container.isConnected && isCurrent() && getContext() === context && identity() === stamp && location.hash === hash;
  if (!['admin', 'finance'].includes(context.role)) { const error = new Error('僅管理者與財務可核對清冊及試算。'); error.status = 403; container.replaceChildren(errorState(error)); return; }
  const catalogArea = el('div', { 'aria-live': 'polite' }), sourceArea = el('div', {}), resultArea = el('div', { 'aria-live': 'polite' });
  let page = 1, q = '', category = '', sourcePage = 1, sourceQuery = '', catalogSequence = 0, sourceSequence = 0, catalogController, sourceController;
  const conditions = row => openDetails({ title: `${row.code} · ${row.name}適用條件`, guardedRead: true, isCurrent: alive, wide: true,
    load: async () => el('section', {}, el('p', { class: 'notice' }, `清冊 ${LTC_BA_AA_CATALOG.version}；附表四第 ${row.sourcePage} 頁起。適用日 ${row.effectiveFrom}。`),
      el('p', { class: 'pre-wrap' }, row.conditions), el('a', { href: LTC_BA_AA_CATALOG.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, '查看官方附表四')) });
  async function loadCatalog() {
    const own = ++catalogSequence; catalogController?.abort(); catalogController = new AbortController(); catalogArea.replaceChildren(el('p', { role: 'status' }, '正在讀取 BA／AA 清冊…'));
    try {
      const result = await api('/api/ltc-codes/catalog?' + new URLSearchParams({ page, pageSize: 25, q, category }), { signal: catalogController.signal });
      if (!alive() || own !== catalogSequence) return;
      const { items: _items, ...metadata } = LTC_BA_AA_CATALOG, needle = q.toLocaleLowerCase('zh-TW');
      const expected = LTC_BA_AA_CATALOG.items.filter(i => (!category || i.code.startsWith(category)) && (!needle || [i.code, i.name, i.conditions].some(v => v.toLocaleLowerCase('zh-TW').includes(needle))));
      if (result?.mode !== LTC_CODE_CALCULATION_MODE || result.orgId !== orgId || result.page !== page || result.pageSize !== 25 || result.total !== expected.length
          || canonicalCalculationJson(result.catalog) !== canonicalCalculationJson(metadata) || canonicalCalculationJson(result.items) !== canonicalCalculationJson(expected.slice((page - 1) * 25, page * 25))) invalid();
      catalogArea.replaceChildren(table([{ label: '碼別', render: r => r.code }, { label: '名稱', render: r => r.name }, { label: '一般區價格', render: r => formatMoney(r.ordinaryCents) },
        { label: '原民區／離島', render: r => formatMoney(r.indigenousIslandCents) }, { label: '適用日', render: r => r.effectiveFrom },
        { label: '額度／自付', render: r => r.copayExempt ? '免部分負擔、不扣服務額度' : '依核定資格與額度另行分攤' },
        { label: '核對', render: r => button('查看條件', () => conditions(r), { variant: 'outline' }) }], result.items, { caption: '官方 BA／AA 支付清冊', emptyText: '沒有符合條件的代碼。' }),
        pagination({ page, pageSize: 25, total: result.total, onChange: value => { page = value; loadCatalog(); } }));
    } catch (error) { if (alive() && own === catalogSequence && error.name !== 'AbortError') catalogArea.replaceChildren(errorState(error, loadCatalog)); }
  }
  async function loadSources() {
    const own = ++sourceSequence; sourceController?.abort(); sourceController = new AbortController(); const signal = sourceController.signal;
    const current = () => alive() && own === sourceSequence && !signal.aborted;
    sourceArea.replaceChildren(el('p', { role: 'status' }, '正在讀取已核閱服務…')); resultArea.replaceChildren();
    try {
      const response = await api('/api/calculations/candidates?' + new URLSearchParams({ rulePage: 1, sourcePage, pageSize: 25, q: sourceQuery }), { signal });
      if (!current()) return;
      const data = response?.sources;
      if (response.orgId !== orgId || !data || data.page !== sourcePage || data.pageSize !== 25 || !Number.isSafeInteger(data.total) || data.total < 0 || !Array.isArray(data.items)
          || data.items.length !== Math.min(25, Math.max(0, data.total - (sourcePage - 1) * 25))
          || data.items.some(r => r.orgId !== orgId || typeof r.id !== 'string' || !Number.isSafeInteger(r.version) || r.version < 1 || typeof r.date !== 'string' || typeof r.label !== 'string' || !Array.isArray(r.items)
            || r.items.some(i => typeof i.serviceItemId !== 'string' || typeof i.code !== 'string' || typeof i.name !== 'string' || !Number.isSafeInteger(i.quantity) || i.quantity < 1))) invalid();
      const sources = data.items.filter(r => r.items.some(i => LTC_BA_AA_CATALOG.items.some(code => code.code === i.code)));
      const pages = () => pagination({ page: sourcePage, pageSize: 25, total: data.total, onChange: value => { sourcePage = value; loadSources(); } });
      if (!sources.length) { sourceArea.replaceChildren(el('p', { class: 'notice' }, '此頁沒有保存 BA／AA 代碼的已核閱服務。請核對服務項目的代碼，或搜尋其他服務來源。'), pages()); return; }
      const selectedSource = value => sources.find(s => s.id === value); let previousSource = '', previousItem = '', formSequence = 0;
      const requiresBa01Approval = (source, item) => item?.code === 'BA01' && source.items.filter(i => i.code === 'BA01').reduce((sum, i) => sum + i.quantity, 0) === 2;
      const form = createForm({ readOnlySubmission: true, submitLabel: '依官方清冊試算', fields: [
        { name: 'sourceId', label: '官方試算服務來源', type: 'select', required: true, options: sources.map(s => ({ value: s.id, label: `${s.date} · ${s.label} · 第 ${s.version} 版` })) },
        { name: 'serviceItemId', label: '原核閱 BA／AA 項目', type: 'select', required: true, options: [] },
        { name: 'region', label: '個案居住地支付區域', type: 'select', required: true, options: [{ value: 'ordinary', label: '一般區' }, { value: 'indigenous-or-island', label: '核定原民區或離島' }] },
        { name: 'paymentContext', label: '支付情形', type: 'select', required: true, options: [] },
        { name: 'rounding', label: '條件支付進位方式', type: 'select', required: true, options: roundings, help: '進位方式由機構核對；不提供隱含預設。' },
        { name: 'eligibilityConfirmed', label: '已人工核對個案、員工資格及服務適用條件', type: 'checkbox', required: true, help: '系統只檢查已可識別的數量、併用與生效條件。跨紀錄的每日、每週及每月限制須另核對。' },
        { name: 'sourceReference', label: '資格與適用條件核對依據', type: 'textarea', required: true, maxLength: 2000 },
        { name: 'specialApprovalReference', label: 'BA01 早晚兩組之特別核定依據', type: 'textarea', hidden: true, maxLength: 2000 }],
        onChange: (values, helpers) => {
          formSequence++; resultArea.replaceChildren(); const source = selectedSource(values.sourceId);
          if (values.sourceId !== previousSource) { previousSource = values.sourceId; helpers.setOptions('serviceItemId', (source?.items || []).filter(i => LTC_BA_AA_CATALOG.items.some(c => c.code === i.code)).map(i => ({ value: i.serviceItemId, label: `${i.code} · ${i.name} · ${i.quantity} 組` }))); helpers.setValue('serviceItemId', ''); }
          const item = source?.items.find(i => i.serviceItemId === values.serviceItemId);
          if (values.serviceItemId !== previousItem) { previousItem = values.serviceItemId; const keys = item ? ['standard', ...(['BA15', 'BA16'].includes(item.code) ? ['shared-family-50-percent'] : []), ...(['AA01', 'AA02'].includes(item.code) ? ['case-management-over-limit-90-percent'] : [])] : [];
            helpers.setOptions('paymentContext', keys.map(value => ({ value, label: contexts[value] }))); helpers.setValue('paymentContext', ''); }
          helpers.setHidden('specialApprovalReference', !requiresBa01Approval(source, item));
        },
        onSubmit: async values => {
          if (!current()) throw new DOMException('操作已取消。', 'AbortError');
          const submittedSequence = formSequence;
          if (values.eligibilityConfirmed !== true) { const error = new Error('請先人工核對資格與適用條件，再勾選確認。'); error.fields = { eligibilityConfirmed: error.message }; throw error; }
          const source = selectedSource(values.sourceId), item = source?.items.find(i => i.serviceItemId === values.serviceItemId); if (!item) invalid();
          const eligibility = { confirmed: true, sourceReference: values.sourceReference }; if (requiresBa01Approval(source, item)) eligibility.specialApprovalReference = values.specialApprovalReference;
          const payload = { catalogVersion: LTC_BA_AA_CATALOG.version, source: { id: source.id, version: source.version }, policy: { operation: 'official-code-quantity', serviceItemId: item.serviceItemId, code: item.code, region: values.region, paymentContext: values.paymentContext, rounding: values.rounding, eligibility } };
          const response = await api('/api/ltc-codes/preview', { method: 'POST', body: payload, signal }); const result = await confirmLtcPreview(response, payload, orgId);
          if (!current() || submittedSequence !== formSequence) throw new DOMException('輸入已變更，請依目前資料重新試算。', 'AbortError');
          const fields = [['官方代碼', `${result.codeSnapshot.code} · ${result.codeSnapshot.name}`], ['固定清冊版本', result.catalogSnapshot.version], ['官方單價', formatMoney(result.unitPriceCents)],
            ['核閱保存數量', `${result.quantity} 組`], ['清冊總價', formatMoney(result.catalogGrossCents)], ['條件支付基數', formatMoney(result.eligiblePaymentBaseCents)], ['共用／家人物品自行負擔', formatMoney(result.sharedFamilySelfPayCents)],
            ['超額組數減付', formatMoney(result.caseloadReductionCents)], ['部分負擔', result.copayCents === null ? '待核定資格與額度分攤' : '免部分負擔'], ['月額度', result.capUsageCents === null ? '待正式額度帳核對' : '不扣服務額度'], ['資格確認', '人工核對依據，非自動資格判定']];
          const content = el('section', { class: 'panel', tabindex: '-1', 'aria-label': '官方碼試算結果' }, el('h3', {}, '官方碼試算結果'), el('p', { class: 'notice' }, '僅核對清冊價格與本次條件支付基數。未核定月額度分攤、跨筆頻次或正式申報，不會更改原核閱快照。'),
            el('dl', { class: 'detail-grid' }, fields.map(([label, value]) => el('div', {}, el('dt', {}, label), el('dd', {}, value)))));
          resultArea.replaceChildren(content); content.focus({ preventScroll: true }); content.scrollIntoView({ block: 'nearest' });
        } });
      sourceArea.replaceChildren(form, pages());
    } catch (error) { if (current() && error.name !== 'AbortError') sourceArea.replaceChildren(errorState(error, loadSources)); }
  }
  const categoryId = 'ltc-category-' + crypto.randomUUID(), categoryFilter = el('select', { id: categoryId, class: 'input' }, el('option', { value: '' }, '全部 BA／AA'), el('option', { value: 'BA' }, 'BA 居家照顧'), el('option', { value: 'AA' }, 'AA 政策鼓勵與管理'));
  categoryFilter.addEventListener('change', () => { category = categoryFilter.value; page = 1; loadCatalog(); });
  container.replaceChildren(pageHeader('BA／AA 清冊與試算', '核對官方服務碼、價格與適用條件'), el('p', { class: 'notice' }, '依官方附表四固定版本提供 39 個 BA／AA 代碼。價格來源與生效日可追溯；資格、分攤與正式申報需分別核定。'),
    el('div', { class: 'toolbar' }, searchBox({ label: '搜尋官方服務碼', placeholder: '碼別、名稱或適用條件', onSearch: value => { q = value; page = 1; loadCatalog(); } }), el('label', { class: 'filter-field', for: categoryId }, el('span', {}, '類別'), categoryFilter)), catalogArea,
    el('h2', {}, '依原核閱紀錄試算'), searchBox({ label: '搜尋官方試算來源', placeholder: '個案、員工、日期或服務碼', onSearch: value => { sourceQuery = value; sourcePage = 1; loadSources(); } }), sourceArea, resultArea);
  await Promise.all([loadCatalog(), loadSources()]);
}
