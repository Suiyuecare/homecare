import { api, el, pageHeader, table, getContext, createForm, searchBox, pagination, errorState, formatMoney } from '../ui.js';
import { CALCULATION_MODE, calculateConfiguredAmount, canonicalCalculationJson } from '../data/calculation-core.js';
const operations = { 'quantity-rate': '項目數量 × 核定單價', flat: '核定固定金額', 'minutes-hourly': '服務分鐘 × 核定時薪 ÷ 60', 'basis-points': '核定拆帳基數 × 拆帳比例' };
const roundings = { floor: '無條件捨去至分', ceiling: '無條件進位至分', 'half-up': '四捨五入至分', 'half-even': '銀行家進位至分（同值取偶數）' };
const options = values => Object.entries(values).map(([value, label]) => ({ value, label }));
const identity = () => { const c = getContext(); return JSON.stringify([c.user?.id, c.organizationId || c.orgId, c.role, c.user?.employeeId || c.employeeId || '']); };
const fail = () => { throw new Error('無法確認本機構的試算來源與結果，請重新讀取。'); };
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 100;
function candidates(result, orgId, query) {
  if (result?.mode !== CALCULATION_MODE || result.orgId !== orgId) fail();
  for (const [name, current] of [['rules', query.rulePage], ['sources', query.sourcePage]]) {
    const page = result[name];
    if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < 0 || page.page !== current || page.pageSize !== query.pageSize
        || page.items.length !== Math.min(query.pageSize, Math.max(0, page.total - (current - 1) * query.pageSize))) fail();
    const seen = new Set();
    for (const item of page.items) {
      if (!validId(item.id) || item.orgId !== orgId || seen.has(item.id) || !Number.isSafeInteger(item.version) || item.version < 1) fail();
      seen.add(item.id);
      if (name === 'rules' && (!['pricing', 'payroll'].includes(item.kind) || ['code', 'name', 'sourceReference', 'validFrom', 'validTo'].some(key => typeof item[key] !== 'string') || !item.parameters)) fail();
      if (name === 'sources' && (typeof item.label !== 'string' || typeof item.date !== 'string' || !Number.isSafeInteger(item.serviceMinutes) || !Array.isArray(item.items)
          || !item.items.length || item.items.some(i => !validId(i.serviceItemId) || typeof i.name !== 'string' || typeof i.code !== 'string' || !Number.isSafeInteger(i.quantity) || i.quantity < 1))) fail();
    }
  }
  return result;
}
export async function confirmCalculationPreview(result, payload, orgId) {
  if (!result || result.mode !== CALCULATION_MODE || result.currency !== 'TWD' || result.previewOnly !== true
      || result.ruleSnapshot?.orgId !== orgId || result.sourceSnapshot?.orgId !== orgId
      || result.ruleSnapshot.id !== payload.rule.id || result.ruleSnapshot.version !== payload.rule.version
      || result.sourceSnapshot.id !== payload.source.id || result.sourceSnapshot.version !== payload.source.version
      || typeof result.previewHash !== 'string' || !/^[0-9a-f]{64}$/.test(result.previewHash)) fail();
  const confirmed = calculateConfiguredAmount({ rule: result.ruleSnapshot, source: result.sourceSnapshot, policy: payload.policy });
  const { previewHash, ...body } = result;
  if (canonicalCalculationJson(body) !== canonicalCalculationJson(confirmed)) fail();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalCalculationJson(confirmed)));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== previewHash) fail();
  return result;
}
function output(result) {
  const policy = result.policySnapshot, rule = result.ruleSnapshot, source = result.sourceSnapshot;
  const trace = [...result.trace, ...(result.allocation?.trace || [])];
  const explanation = policy.operation === 'quantity-rate' ? `${source.billingSnapshot.items.find(i => i.serviceItemId === policy.serviceItemId).quantity} 次 × ${formatMoney(rule.parameters.unitPriceCents)}`
    : policy.operation === 'minutes-hourly' ? `${source.billingSnapshot.serviceMinutes} 分鐘 × ${formatMoney(rule.parameters.baseCents)}／時 ÷ 60`
      : policy.operation === 'basis-points' ? `${formatMoney(rule.parameters.baseCents)} × ${rule.parameters.shareBasisPoints / 100}%` : formatMoney(rule.parameters.baseCents);
  const fields = [['試算金額', formatMoney(result.amountCents)], ['算式', explanation], ['核定規則', `${rule.code} · ${rule.name} · 第 ${rule.version} 版`],
    ['規則依據', rule.sourceReference], ['來源紀錄', `${source.date} · 第 ${source.version} 版`], ['服務分鐘', `${source.billingSnapshot.serviceMinutes} 分鐘`],
    ['進位', roundings[policy.rounding || policy.allocation?.rounding] || '整數精確計算']];
  if (result.allocation) fields.push(['假設剩餘額度', formatMoney(result.allocation.remainingBeforeCents)], ['假設補助分攤', formatMoney(result.allocation.subsidyCents)],
    ['試算自付', formatMoney(result.allocation.copayCents)], ['試算超額', formatMoney(result.allocation.excessCents)], ['試算個案應付', formatMoney(result.allocation.payableCents)]);
  return el('section', { class: 'panel', tabindex: '-1', 'aria-label': '試算結果' }, el('h2', {}, '試算結果'),
    el('p', { class: 'notice' }, '這是規則試算，不會產生帳單、薪資結算或正式申報。額度分攤使用本次人工輸入的假設已用額度。'),
    el('dl', { class: 'detail-grid' }, fields.map(([label, value]) => el('div', {}, el('dt', {}, label), el('dd', {}, value)))),
    table([{ label: '步驟', render: row => row.step }, { label: '整數分子', render: row => row.numerator }, { label: '整數分母', render: row => row.denominator },
      { label: '進位方式', render: row => roundings[row.rounding] || '精確' }, { label: '結果', render: row => formatMoney(row.resultCents) }], trace, { caption: '精確計算追溯' }));
}
export async function mountCalculations(container, { isCurrent = () => true } = {}) {
  const context = getContext(), stamp = identity(), hash = location.hash, orgId = context.organizationId || context.orgId;
  const alive = () => container.isConnected && isCurrent() && getContext() === context && identity() === stamp && location.hash === hash;
  if (!['admin', 'finance'].includes(context.role)) { const error = new Error('僅管理者與財務可使用試算。'); error.status = 403; container.replaceChildren(errorState(error)); return; }
  let rulePage = 1, sourcePage = 1, q = '', sequence = 0, controller;
  const body = el('div', { class: 'list-content' }), resultArea = el('div', { 'aria-live': 'polite' });
  async function load() {
    const own = ++sequence; controller?.abort(); controller = new AbortController(); const signal = controller.signal;
    const current = () => alive() && own === sequence && !signal.aborted;
    body.replaceChildren(el('p', { role: 'status' }, '正在讀取已核定規則與已核閱服務…')); resultArea.replaceChildren();
    try {
      const query = { rulePage, sourcePage, pageSize: 25, q };
      const data = candidates(await api('/api/calculations/candidates?' + new URLSearchParams(query), { signal }), orgId, query);
      if (!current()) return;
      if (!data.rules.items.length || !data.sources.items.length) {
        body.replaceChildren(el('p', { class: 'notice' }, '請先保存並核定計價／薪資規則，以及核閱完成的服務紀錄。也可調整搜尋或分頁，選取其他候選資料。'),
          pager(data)); return;
      }
      const selectedRule = value => data.rules.items.find(item => item.id === value);
      const selectedSource = value => data.sources.items.find(item => item.id === value);
      let previousRule = '', previousSource = '', formSequence = 0;
      const form = createForm({ readOnlySubmission: true, submitLabel: '執行試算', fields: [
        { name: 'ruleId', label: '已核定規則', type: 'select', required: true, options: data.rules.items.map(r => ({ value: r.id, label: `${r.kind === 'pricing' ? '計價' : '薪資'} · ${r.code} · ${r.name} · 第 ${r.version} 版` })) },
        { name: 'sourceId', label: '已核閱服務', type: 'select', required: true, options: data.sources.items.map(s => ({ value: s.id, label: `${s.date} · ${s.label} · ${s.serviceMinutes} 分鐘 · 第 ${s.version} 版` })) },
        { name: 'operation', label: '計算方式', type: 'select', required: true, options: [], help: '時薪使用規則保存的每小時金額；拆帳使用規則保存的基數與比例。' },
        { name: 'serviceItemId', label: '服務項目', type: 'select', hidden: true, options: [] },
        { name: 'rounding', label: '進位方式', type: 'select', hidden: true, options: options(roundings) },
        { name: 'allocate', label: '試算假設額度分攤', type: 'checkbox', hidden: true, help: '此處不讀取官方月額度帳；請明確輸入假設值。' },
        { name: 'capMeaning', label: '額度計算基準', type: 'select', hidden: true, options: [{ value: 'eligible-gross-ceiling', label: '符合資格的總服務費上限' }, { value: 'subsidy-ceiling', label: '假設補助方額度上限' }] },
        { name: 'consumedCents', label: '假設已使用額度（分）', type: 'number', min: 0, max: Number.MAX_SAFE_INTEGER, step: 1, hidden: true },
        { name: 'copayBasisPoints', label: '自付比例（基點，100 基點＝1%）', type: 'number', min: 0, max: 10000, step: 1, hidden: true, help: '須與所選核定規則一致；0 必須明確填寫。' }],
        onChange: (values, helpers) => {
          formSequence++; resultArea.replaceChildren();
          const rule = selectedRule(values.ruleId), source = selectedSource(values.sourceId);
          if (previousRule !== values.ruleId) {
            previousRule = values.ruleId;
            const available = rule?.kind === 'pricing' ? ['quantity-rate'] : rule ? ['flat', 'minutes-hourly', 'basis-points'] : [];
            helpers.setOptions('operation', available.map(value => ({ value, label: operations[value] }))); helpers.setValue('operation', ''); helpers.setValue('allocate', false);
          }
          if (previousSource !== values.sourceId) { previousSource = values.sourceId; helpers.setOptions('serviceItemId', (source?.items || []).map(i => ({ value: i.serviceItemId, label: `${i.code} · ${i.name} · ${i.quantity} 次` }))); helpers.setValue('serviceItemId', ''); }
          const pricing = rule?.kind === 'pricing', allocation = pricing && values.allocate;
          helpers.setHidden('serviceItemId', !pricing); helpers.setHidden('allocate', !pricing);
          helpers.setHidden('rounding', !(allocation || (!pricing && ['minutes-hourly', 'basis-points'].includes(values.operation))));
          for (const name of ['capMeaning', 'consumedCents', 'copayBasisPoints']) helpers.setHidden(name, !allocation);
        },
        onSubmit: async values => {
          if (!current()) throw new DOMException('操作已取消。', 'AbortError');
          const submittedSequence = formSequence;
          const rule = selectedRule(values.ruleId), source = selectedSource(values.sourceId);
          if (!rule || !source) fail();
          let policy;
          if (values.operation === 'quantity-rate') policy = { operation: values.operation, rateParameter: 'unitPriceCents', serviceItemId: values.serviceItemId };
          if (values.operation === 'flat') policy = { operation: values.operation, amountParameter: 'baseCents' };
          if (values.operation === 'minutes-hourly') policy = { operation: values.operation, rateParameter: 'baseCents', rounding: values.rounding };
          if (values.operation === 'basis-points') policy = { operation: values.operation, amountParameter: 'baseCents', ratioParameter: 'shareBasisPoints', rounding: values.rounding };
          if (rule.kind === 'pricing' && values.allocate) policy.allocation = { capMeaning: values.capMeaning, consumedCents: values.consumedCents, capParameter: 'monthlyCapCents', copayBasisPoints: values.copayBasisPoints, rounding: values.rounding };
          const payload = { rule: { id: rule.id, version: rule.version }, source: { id: source.id, version: source.version }, policy };
          const response = await api('/api/calculations/preview', { method: 'POST', body: payload, signal });
          const confirmed = await confirmCalculationPreview(response, payload, orgId);
          if (!current() || submittedSequence !== formSequence) throw new DOMException('輸入已變更，請依目前資料重新試算。', 'AbortError');
          const content = output(confirmed); resultArea.replaceChildren(content); content.focus({ preventScroll: true }); content.scrollIntoView({ block: 'nearest' });
        } });
      body.replaceChildren(form, pager(data));
    } catch (error) { if (current() && error.name !== 'AbortError') body.replaceChildren(errorState(error, load)); }
  }
  function pager(data) {
    return el('div', {}, el('section', { 'aria-label': '核定規則分頁' }, el('h3', {}, '核定規則分頁'), pagination({ page: rulePage, pageSize: 25, total: data.rules.total, onChange: value => { rulePage = value; load(); } })),
      el('section', { 'aria-label': '核閱服務分頁' }, el('h3', {}, '核閱服務分頁'), pagination({ page: sourcePage, pageSize: 25, total: data.sources.total, onChange: value => { sourcePage = value; load(); } })));
  }
  container.replaceChildren(pageHeader('計價與薪資試算', '核定規則、來源版本及精確計算追溯'),
    el('p', { class: 'notice' }, '請選擇機構已核定的規則。BA／AA 官方清冊與適用資格需分別核對；試算通過不代表正式薪資或核銷已核定。'),
    searchBox({ label: '搜尋規則與服務', placeholder: '規則名稱、個案、員工、日期或服務碼', onSearch: value => { q = value; rulePage = 1; sourcePage = 1; load(); } }), body, resultArea);
  await load();
}
