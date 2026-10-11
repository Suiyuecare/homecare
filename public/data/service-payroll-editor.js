import { CALENDAR_SPAN_MODE } from './shift-span-editor.js';
// Closed manual service-to-payroll adapters; original trial prices never prefill amounts.
import { checkServiceBillingSource, serviceBillingSnapshotForDisplay } from './service-billing-editor.js';
import { parsePayrollAmount, payrollAmountText } from './payroll-statement-editor.js';

const mode = 'manual-service-payroll-v1';
const spanModeAck = 'manual-service-payroll-span-v1';
const modeValue = spanMode => { if (spanMode !== undefined && spanMode !== CALENDAR_SPAN_MODE) invalid('spanMode', '只接受完整日期檢視模式。'); return spanMode; };
const ackMode = payload => Object.hasOwn(payload, 'spanMode') ? spanModeAck : mode;
const stripSpanMode = payload => Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'spanMode'));
const metadata = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
const statementFields = ['employeeId', 'month', 'number', 'lineItems', 'sourceReference', 'status', 'note', 'summary', 'employeeSnapshot'];
const originFields = ['payrollStatementId', 'employeeId', 'month', 'number', 'sourceReference', 'note', 'sourceSnapshots', 'manualLines', 'initialStatementSnapshot'];
const payloadFields = ['employeeId', 'month', 'number', 'sourceReference', 'note', 'lines'];
const manualLineFields = ['serviceRecordId', 'version', 'label', 'amountCents', 'sourceReference'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const closed = (value, keys) => plain(value) && Reflect.ownKeys(value).every(key => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return typeof key === 'string' && descriptor.enumerable && Object.hasOwn(descriptor, 'value');
}) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const safeArray = (value, minimum = 0, maximum = 100) => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < minimum || length.value > maximum) return false;
  if (Reflect.ownKeys(value).length !== length.value + 1) return false;
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
  }
  return true;
};
const idValid = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && value === value.trim() && !/[\r\n]/.test(value);
const monthValid = value => typeof value === 'string' && value.length === 7 && /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
const isoValid = value => typeof value === 'string' && value.length === 24 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const boundedText = (value, maximum, required = false, single = false) => typeof value === 'string' && value.length <= maximum
  && (!required || !!value.trim()) && (!single || !/[\r\n]/.test(value));
const moneyValid = (value, maximum = 1000000000) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const copy = value => structuredClone(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function invalid(key, message) { const error = new Error(message); error.fields = { [key]: message }; throw error; }
function text(values, key) {
  const descriptor = plain(values) && Object.getOwnPropertyDescriptor(values, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') invalid(key, '表單文字無法確認。');
  return descriptor.value;
}

export function checkServicePayrollSource(value, { orgId, employeeId, month, spanMode } = {}) {
  const caseDescriptor = plain(value) && Object.getOwnPropertyDescriptor(value, 'caseId');
  if (!caseDescriptor || !Object.hasOwn(caseDescriptor, 'value') || !idValid(caseDescriptor.value)) invalid('employeeId', '來源個案識別無法確認。');
  const source = checkServiceBillingSource(value, { orgId, caseId: caseDescriptor.value, month, spanMode });
  if (!idValid(employeeId) || source.employeeId !== employeeId) invalid('employeeId', '只能選擇同員工、同月份的已核閱服務；不同個案可一同核對。');
  return source;
}
function selectedSources(sources, orgId, payload) {
  if (!safeArray(sources, 1)) invalid('employeeId', '請選擇1至100筆已確認服務。');
  return sources.map(source => checkServicePayrollSource(source, { orgId, employeeId: payload.employeeId, month: payload.month, spanMode: payload.spanMode }));
}
function collectionEnvelope(result, options) {
  const { employeeId, month, q = '', page = 1, pageSize = 25, spanMode } = options; modeValue(spanMode);
  if (!closed(result, ['query', 'items', 'total', 'page', 'pageSize']) || !closed(result.query, ['employeeId', 'month', 'q', ...(spanMode ? ['spanMode'] : [])]) || (spanMode ? result.query.spanMode !== spanMode : Object.hasOwn(result.query, 'spanMode'))
    || result.query.employeeId !== employeeId || result.query.month !== month || result.query.q !== q || result.page !== page || result.pageSize !== pageSize
    || !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
    || !Number.isSafeInteger(result.total) || result.total < 0 || !safeArray(result.items, 0, pageSize)
    || result.items.length !== Math.max(0, Math.min(pageSize, result.total - (page - 1) * pageSize))) invalid('employeeId', '薪資服務來源查詢回應無法完整確認，請重新讀取。');
}
export function checkServicePayrollCollection(result, options = {}) {
  collectionEnvelope(result, options); const seen = new Set();
  return result.items.map(value => {
    const source = checkServicePayrollSource(value, options);
    if (seen.has(source.id)) invalid('employeeId', '服務來源重複，請重新讀取。');
    seen.add(source.id); return source;
  });
}
export function servicePayrollManualTotal(lines) {
  if (!safeArray(lines, 1)) invalid('number', '請選擇1至100筆服務來源。');
  const seen = new Set(); let amount = 0n;
  for (const line of lines) {
    if (!closed(line, manualLineFields) || !idValid(line.serviceRecordId) || seen.has(line.serviceRecordId)
      || !Number.isSafeInteger(line.version) || line.version < 1 || !boundedText(line.label, 100, true, true)
      || !moneyValid(line.amountCents) || !boundedText(line.sourceReference, 2000, true)) invalid('number', '人工服務薪資明細或核對依據無法確認。');
    seen.add(line.serviceRecordId); amount += BigInt(line.amountCents);
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) invalid('number', '人工薪資總額超出精確保存範圍。');
  }
  return Number(amount);
}
function confirmedPayload(payload) {
  const explicit = plain(payload) && Object.hasOwn(payload, 'spanMode');
  if (!closed(payload, [...payloadFields, ...(explicit ? ['spanMode'] : [])]) || explicit && payload.spanMode !== CALENDAR_SPAN_MODE || !idValid(payload.employeeId) || !monthValid(payload.month) || !idValid(payload.number)
    || !boundedText(payload.sourceReference, 500, true) || !boundedText(payload.note, 10000)) invalid('number', '人工薪資核對內容無法確認。');
  servicePayrollManualTotal(payload.lines); return copy(payload);
}
function confirmedStatement(value, { orgId, draftOnly = false, stored = true } = {}) {
  if (!closed(value, [...statementFields, ...(stored ? metadata : [])]) || !idValid(value.employeeId) || !monthValid(value.month) || !idValid(value.number)
    || !boundedText(value.sourceReference, 500, draftOnly || ['reviewed', 'closed'].includes(value.status)) || !boundedText(value.note, 10000)
    || !['draft', 'reviewed', 'closed', 'voided'].includes(value.status) || (draftOnly && value.status !== 'draft')
    || !closed(value.employeeSnapshot, ['id', 'name', 'employeeNo']) || value.employeeSnapshot.id !== value.employeeId
    || !boundedText(value.employeeSnapshot.name, 500) || !boundedText(value.employeeSnapshot.employeeNo, 500)
    || !closed(value.summary, ['earningCents', 'deductionCents', 'netCents'])
    || !Object.values(value.summary).every(cents => moneyValid(cents, Number.MAX_SAFE_INTEGER)) || !safeArray(value.lineItems, 1)) invalid('number', '薪資保存明細、員工與精確加減淨額無法確認。');
  if (stored && (!idValid(value.id) || value.orgId !== orgId || !idValid(orgId) || !Number.isSafeInteger(value.version) || value.version < 1
    || !isoValid(value.createdAt) || !isoValid(value.updatedAt) || value.updatedAt < value.createdAt)) invalid('number', '薪資保存身份與版次無法確認。');
  let earning = 0n, deduction = 0n;
  for (const line of value.lineItems) {
    if (!closed(line, ['label', 'kind', 'amountCents']) || !boundedText(line.label, 100, true)
      || !['earning', 'deduction'].includes(line.kind) || !moneyValid(line.amountCents)) invalid('number', '保存薪資加減項格式無法確認。');
    if (line.kind === 'earning') earning += BigInt(line.amountCents); else deduction += BigInt(line.amountCents);
    if (earning > BigInt(Number.MAX_SAFE_INTEGER) || deduction > BigInt(Number.MAX_SAFE_INTEGER)) invalid('number', '薪資加減項超出可精確核對範圍。');
  }
  if (deduction > earning || earning !== BigInt(value.summary.earningCents) || deduction !== BigInt(value.summary.deductionCents)
    || earning - deduction !== BigInt(value.summary.netCents)) invalid('number', '薪資加減項與保存淨額不符。');
  return copy(value);
}
function expectedDraft(payload) {
  const total = servicePayrollManualTotal(payload.lines);
  return { employeeId: payload.employeeId, month: payload.month, number: payload.number,
    lineItems: payload.lines.map(line => ({ label: line.label, kind: 'earning', amountCents: line.amountCents })),
    sourceReference: payload.sourceReference, status: 'draft', note: payload.note,
    summary: { earningCents: total, deductionCents: 0, netCents: total } };
}
function matchDraft(statement, payload) { const expected = expectedDraft(payload); return Object.keys(expected).every(key => same(statement[key], expected[key])); }
const matchSourceLines = (sources, lines) => sources.length === lines.length && sources.every((source, index) => source.id === lines[index].serviceRecordId && source.version === lines[index].version);
export function checkServicePayrollPreview(result, { orgId, payload, sources } = {}) {
  const confirmed = confirmedPayload(payload), selected = selectedSources(sources, orgId, confirmed);
  if (!closed(result, ['mode', 'draft', 'sources', 'manualLines', 'sourceCount', 'previewHash']) || result.mode !== ackMode(confirmedPayload(payload))
    || typeof result.previewHash !== 'string' || result.previewHash.length !== 64 || !/^[a-f0-9]{64}$/.test(result.previewHash)
    || !safeArray(result.sources, 1) || !safeArray(result.manualLines, 1) || !Number.isSafeInteger(result.sourceCount)
    || result.sourceCount !== result.sources.length) invalid('number', '薪資預覽回應無法確認，請保留輸入並重新預覽。');
  servicePayrollManualTotal(result.manualLines);
  const sourceRows = selectedSources(result.sources, orgId, confirmed);
  if (!same(result.manualLines, confirmed.lines) || !matchSourceLines(sourceRows, confirmed.lines) || !same(sourceRows, selected)) invalid('number', '預覽來源版次、金額或核對原文不符。');
  const draft = confirmedStatement(result.draft, { stored: false, draftOnly: true });
  if (!matchDraft(draft, confirmed)) invalid('number', '預覽人工薪資金額或原文與輸入不符。');
  return copy(result);
}
export function checkServicePayrollOrigin(value, { orgId, statementId, payload, sources, spanMode } = {}) {
  const sourceMode = modeValue(payload === undefined ? spanMode : confirmedPayload(payload).spanMode);
  if (!closed(value, [...metadata, ...originFields]) || !idValid(value.id) || value.orgId !== orgId || !idValid(orgId)
    || value.version !== 1 || !isoValid(value.createdAt) || value.updatedAt !== value.createdAt || !idValid(value.payrollStatementId)
    || (statementId && value.payrollStatementId !== statementId) || !idValid(value.employeeId) || !monthValid(value.month) || !idValid(value.number)
    || !boundedText(value.sourceReference, 500, true) || !boundedText(value.note, 10000) || !safeArray(value.sourceSnapshots, 1) || !safeArray(value.manualLines, 1)) invalid('number', '薪資生成來源保存紀錄無法確認。');
  const generatedPayload = confirmedPayload({ employeeId: value.employeeId, month: value.month, number: value.number, sourceReference: value.sourceReference, note: value.note, lines: value.manualLines });
  const sourceRows = selectedSources(value.sourceSnapshots, orgId, { ...generatedPayload, ...(sourceMode ? { spanMode: sourceMode } : {}) });
  if (!matchSourceLines(sourceRows, value.manualLines)) invalid('number', '保存來源與人工薪資明細不符。');
  const initial = confirmedStatement(value.initialStatementSnapshot, { orgId, draftOnly: true });
  if (initial.id !== value.payrollStatementId || initial.version !== 1 || !matchDraft(initial, generatedPayload)) invalid('number', '生成當時薪資草稿快照無法確認。');
  if (payload !== undefined) {
    const confirmed = confirmedPayload(payload), selected = selectedSources(sources, orgId, confirmed);
    if (!same(stripSpanMode(confirmed), generatedPayload) || !same(selected, sourceRows)) invalid('number', '薪資生成保存結果與本次核對內容不符。');
  }
  return copy(value);
}
export function checkServicePayrollSaved(result, { orgId, payload, sources, preview } = {}) {
  if (!closed(result, ['mode', 'item', 'origin']) || result.mode !== ackMode(confirmedPayload(payload))) invalid('number', '無法確認已生成薪資草稿，請保留輸入並重試。');
  const confirmedPreview = preview === undefined ? undefined : checkServicePayrollPreview(preview, { orgId, payload, sources });
  const item = confirmedStatement(result.item, { orgId, draftOnly: true });
  const origin = checkServicePayrollOrigin(result.origin, { orgId, statementId: item.id, payload, sources });
  if (item.version !== 1 || !same(item, origin.initialStatementSnapshot) || !matchDraft(item, confirmedPayload(payload))
    || (confirmedPreview && !same(item.employeeSnapshot, confirmedPreview.draft.employeeSnapshot))) invalid('number', '薪資保存 ACK 不完整或與預覽不符；輸入仍保留。');
  return { mode: result.mode, item, origin };
}
export function checkServicePayrollOriginDetail(result, { orgId, statementId, spanMode } = {}) {
  if (!closed(result, ['origin', 'statement'])) invalid('number', '薪資來源詳情回應無法確認。');
  const statement = confirmedStatement(result.statement, { orgId });
  const origin = checkServicePayrollOrigin(result.origin, { orgId, statementId: statementId || statement.id, spanMode });
  if (statement.id !== origin.payrollStatementId || statement.employeeId !== origin.employeeId || statement.month !== origin.month || statement.number !== origin.number
    || statement.version < origin.initialStatementSnapshot.version || statement.createdAt !== origin.initialStatementSnapshot.createdAt) invalid('number', '目前薪資與保存來源身份不符。');
  return { origin, statement };
}
export function checkServicePayrollOriginCollection(result, options = {}) {
  collectionEnvelope(result, options); const ids = new Set();
  return result.items.map(value => {
    const row = checkServicePayrollOriginDetail(value, { orgId: options.orgId, spanMode: options.spanMode });
    if (row.origin.employeeId !== options.employeeId || row.origin.month !== options.month || ids.has(row.statement.id)) invalid('number', '薪資來源清單範圍或重複資料無法確認。');
    ids.add(row.statement.id); return row;
  });
}

export function createServicePayrollEditor({ sources, orgId, employeeId, employeeName = '', month, spanMode } = {}) {
  const confirmed = selectedSources(sources, orgId, { employeeId, month, ...(modeValue(spanMode) ? { spanMode } : {}) });
  if (new Set(confirmed.map(source => source.id)).size !== confirmed.length || !boundedText(employeeName, 1100)) invalid('employeeId', '服務來源重複或員工文字無法確認。');
  const initial = { employeeId, month, number: '', sourceReference: '', note: '' };
  const fields = [{ name: 'employeeId', label: '員工', groupLabel: '薪資草稿識別', type: 'select', disabled: true,
    options: [{ value: employeeId, label: employeeName || employeeId }], help: '依已選來源固定員工；可合併不同個案，但生成後不可換員工。' },
    { name: 'month', label: '薪資月份', type: 'month', readOnly: true, required: true },
    { name: 'number', label: '結算編號', required: true, maxLength: 100 }];
  confirmed.forEach((source, index) => {
    initial[`lineLabel${index}`] = `${source.date} ${source.billingSnapshot.items.map(item => item.name).join('、')}`.slice(0, 100).replace(/[\r\n]/g, ' ');
    initial[`lineAmount${index}`] = ''; initial[`lineReference${index}`] = '';
    fields.push({ name: `lineLabel${index}`, label: `服務${index + 1} 薪資明細名稱`, groupLabel: `服務${index + 1} · ${source.date} · ${source.billingSnapshot.employee.name}`,
      required: true, maxLength: 100, wide: true, help: '每個已核閱服務生成一筆人工加項總額，不從試算時薪或分鐘推算。' },
    { name: `lineAmount${index}`, label: `服務${index + 1} 人工核定加項（元）`, required: true, inputMode: 'decimal', maxLength: 15,
      help: '人工明確填寫，最多兩位小數；沒有時薪、試算或目前員工費率預填。' },
    { name: `lineReference${index}`, label: `服務${index + 1} 人工核對依據`, required: true, type: 'textarea', maxLength: 2000, wide: true });
  });
  fields.push({ name: 'sourceReference', label: '薪資共同人工核定依據', groupLabel: '共同核對與備註', required: true, type: 'textarea', maxLength: 500, wide: true,
    help: '本機人工公司紀錄，不代表法定工資、保險、稅費或付款。' }, { name: 'note', label: '薪資備註', type: 'textarea', maxLength: 10000, wide: true });
  const keys = fields.map(field => field.name);
  return { fields, initial, sources: copy(confirmed), buildPayload(values) {
    if (!closed(values, keys)) invalid('number', '表單包含未知或缺少欄位。');
    if (text(values, 'employeeId') !== employeeId || text(values, 'month') !== month) invalid('employeeId', '已選來源的員工與月份不可變更。');
    const number = text(values, 'number').trim(), sourceReference = text(values, 'sourceReference'), note = text(values, 'note');
    if (!idValid(number)) invalid('number', '請填寫最多100字元的單行結算編號。');
    if (!boundedText(sourceReference, 500, true)) invalid('sourceReference', '請填寫最多500字元的共同人工核定依據。');
    if (!boundedText(note, 10000)) invalid('note', '備註超過10000字元。');
    const lines = confirmed.map((source, index) => {
      const label = text(values, `lineLabel${index}`).trim(), sourceReference = text(values, `lineReference${index}`);
      if (!boundedText(label, 100, true, true)) invalid(`lineLabel${index}`, '請填寫最多100字元的單行明細名稱。');
      if (!boundedText(sourceReference, 2000, true)) invalid(`lineReference${index}`, '請填寫本筆服務的人工核對依據。');
      return { serviceRecordId: source.id, version: source.version, label, amountCents: parsePayrollAmount(text(values, `lineAmount${index}`), `lineAmount${index}`), sourceReference };
    });
    servicePayrollManualTotal(lines); return { employeeId, month, number, sourceReference, note, lines, ...(modeValue(spanMode) ? { spanMode } : {}) };
  } };
}
export const servicePayrollKnownFields = Object.freeze({ statement: Object.freeze(statementFields), origin: Object.freeze(originFields), payload: Object.freeze(payloadFields), manualLine: Object.freeze(manualLineFields) });
export { serviceBillingSnapshotForDisplay as servicePayrollSnapshotForDisplay, payrollAmountText as formatPayrollCents };
