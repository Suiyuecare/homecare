import { serviceSpan } from './shift-span.js';
import { CALENDAR_SPAN_MODE } from './shift-span-editor.js';
// Pure closed adapters for manual service-to-bill reconciliation. No trial price defaults.
import { formatBillingCents, parseBillingMoney } from './billing-document-editor.js';

const sourceFields = ['id', 'orgId', 'version', 'caseId', 'employeeId', 'shiftId', 'date', 'actualStart', 'actualEnd', 'billingSnapshot', 'createdAt', 'updatedAt'];
const snapshotFields = ['capturedAt', 'currency', 'trial', 'source', 'serviceMinutes', 'employee', 'items'];
const employeeFields = ['id', 'name', 'employeeNo', 'hourlyRateCents'];
const itemFields = ['serviceItemId', 'code', 'name', 'quantity', 'unitPriceCents', 'amountCents'];
const lineFields = ['serviceRecordId', 'version', 'label', 'amountCents', 'sourceReference'];
const payloadFields = ['caseId', 'month', 'number', 'sourceReference', 'note', 'lines'];
const billFields = ['caseId', 'month', 'number', 'lineItems', 'sourceReference', 'status', 'note', 'summary', 'caseSnapshot'];
const metadata = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
const originFields = ['billingDocumentId', 'caseId', 'month', 'number', 'sourceReference', 'note', 'sourceSnapshots', 'manualLines', 'initialBillSnapshot'];
const mode = 'manual-service-billing-v1';
const spanModeAck = 'manual-service-billing-span-v1';
const owns = (value, key) => Object.hasOwn(value, key);
const modeValue = spanMode => { if (spanMode !== undefined && spanMode !== CALENDAR_SPAN_MODE) invalid('spanMode', '只接受已核定完整日期檢視模式。'); return spanMode; };
const ackMode = payload => owns(payload, 'spanMode') ? spanModeAck : mode;
const stripSpanMode = payload => Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'spanMode'));
const sourceKeys = value => [...sourceFields, ...(plain(value) && owns(value, 'actualEndDate') ? ['actualEndDate'] : [])];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const closed = (value, names) => plain(value) && Reflect.ownKeys(value).every(key => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return typeof key === 'string' && descriptor.enumerable && Object.hasOwn(descriptor, 'value');
}) && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const safeArray = (value, minimum = 0, maximum = 100) => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < minimum || length.value > maximum) return false;
  const names = Reflect.ownKeys(value);
  if (names.length !== length.value + 1 || names.some(key => typeof key !== 'string' || (key !== 'length' && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length.value)))) return false;
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
  }
  return true;
};
const idValid = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && value === value.trim() && !/[\r\n]/.test(value);
const monthValid = value => typeof value === 'string' && value.length === 7 && /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
const dateValid = value => typeof value === 'string' && value.length === 10 && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const isoValid = value => typeof value === 'string' && value.length === 24 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const boundedText = (value, maximum, required = false, single = false) => typeof value === 'string' && value.length <= maximum
  && (!required || !!value.trim()) && (!single || !/[\r\n]/.test(value));
const moneyValid = (value, maximum = 1000000000) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const copy = value => structuredClone(value);
function minute(value, date) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return NaN;
  if (value.length === 5 && /^\d{2}:\d{2}$/.test(value)) { const [hour, min] = value.split(':').map(Number); return hour < 24 && min < 60 ? hour * 60 + min : NaN; }
  if (value.slice(0, 10) === date && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && Number.isFinite(Date.parse(value))) return minute(value.slice(11, 16), date);
  return NaN;
}
function invalid(key, message) { const error = new Error(message); error.fields = { [key]: message }; throw error; }
function text(values, key) {
  const descriptor = plain(values) && Object.getOwnPropertyDescriptor(values, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') invalid(key, '表單文字無法確認。');
  return descriptor.value;
}

export function serviceBillingSnapshotForDisplay(snapshot, source) {
  let maximumMinutes = 1440, capturedMinutes;
  if (source !== undefined) {
    if (!closed(source, sourceKeys(source))) return null;
    try { const span = serviceSpan({ date: source.date, actualStart: source.actualStart, actualEnd: source.actualEnd, ...(owns(source, 'actualEndDate') ? { actualEndDate: source.actualEndDate } : {}) }); capturedMinutes = span.durationMinutes; maximumMinutes = owns(source, 'actualEndDate') ? 2879 : 1440; } catch { return null; }
  }
  if (!closed(snapshot, snapshotFields) || !isoValid(snapshot.capturedAt) || snapshot.currency !== 'TWD'
    || snapshot.trial !== true || snapshot.source !== 'approval' || !Number.isSafeInteger(snapshot.serviceMinutes) || snapshot.serviceMinutes < 1 || snapshot.serviceMinutes > maximumMinutes || capturedMinutes !== undefined && snapshot.serviceMinutes !== capturedMinutes
    || !closed(snapshot.employee, employeeFields) || !idValid(snapshot.employee.id) || !boundedText(snapshot.employee.name, 500)
    || !boundedText(snapshot.employee.employeeNo, 500) || !moneyValid(snapshot.employee.hourlyRateCents)
    || !safeArray(snapshot.items, 1)) return null;
  const ids = new Set();
  for (const item of snapshot.items) {
    if (!closed(item, itemFields) || !idValid(item.serviceItemId) || ids.has(item.serviceItemId)
      || !boundedText(item.code, 500) || !boundedText(item.name, 500)
      || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10000 || !moneyValid(item.unitPriceCents)
      || !moneyValid(item.amountCents, Number.MAX_SAFE_INTEGER) || BigInt(item.amountCents) !== BigInt(item.quantity) * BigInt(item.unitPriceCents)) return null;
    ids.add(item.serviceItemId);
  }
  return copy(snapshot);
}

/** Caller receives only confirmed closed source DTOs, never unknown source fields. */
export function checkServiceBillingSource(value, { orgId, caseId, month, spanMode } = {}) {
  modeValue(spanMode);
  const explicit = plain(value) && owns(value, 'actualEndDate');
  if (explicit && spanMode !== CALENDAR_SPAN_MODE) invalid('spanMode', '來源有明確結束日，請使用完整日期檢視。');
  if (!closed(value, sourceKeys(value)) || !idValid(value.id) || value.orgId !== orgId || !idValid(value.orgId)
    || !Number.isSafeInteger(value.version) || value.version < 1 || value.caseId !== caseId || !idValid(caseId)
    || !idValid(value.employeeId) || !idValid(value.shiftId) || !dateValid(value.date) || !monthValid(month) || value.date.slice(0, 7) !== month
    || !boundedText(value.actualStart, 100, true) || !boundedText(value.actualEnd, 100, true)
    || !isoValid(value.createdAt) || !isoValid(value.updatedAt) || value.updatedAt < value.createdAt
    || !serviceBillingSnapshotForDisplay(value.billingSnapshot, value) || value.billingSnapshot.employee.id !== value.employeeId) invalid('caseId', '核閱服務的保存來源無法確認，請重新讀取。');
  if (!explicit) { const start = minute(value.actualStart, value.date), end = minute(value.actualEnd, value.date);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || value.billingSnapshot.serviceMinutes !== end - start) invalid('caseId', '保存實際時段與核閱分鐘不符。'); }
  return copy(value);
}

export function checkServiceBillingCollection(result, { orgId, caseId, month, q = '', page = 1, pageSize = 25, spanMode } = {}) {
  modeValue(spanMode);
  if (!closed(result, ['query', 'items', 'total', 'page', 'pageSize']) || !closed(result.query, ['caseId', 'month', 'q', ...(spanMode ? ['spanMode'] : [])])
    || (spanMode ? result.query.spanMode !== spanMode : owns(result.query, 'spanMode'))
    || result.query.caseId !== caseId || result.query.month !== month || result.query.q !== q || result.page !== page || result.pageSize !== pageSize
    || !Number.isSafeInteger(result.total) || result.total < 0 || !safeArray(result.items, 0, pageSize)
    || result.items.length > result.total || (result.total === 0 && page !== 1 && result.items.length)) invalid('caseId', '服務來源查詢回應無法確認，請重新讀取。');
  const seen = new Set();
  return result.items.map(value => {
    const source = checkServiceBillingSource(value, { orgId, caseId, month, spanMode });
    if (seen.has(source.id)) invalid('caseId', '服務來源重複，請重新讀取。');
    seen.add(source.id); return source;
  });
}

export function serviceBillingManualTotal(lines) {
  if (!safeArray(lines, 1)) invalid('number', '請選擇1至100筆服務來源。');
  let amount = 0n; const ids = new Set();
  for (const line of lines) {
    if (!closed(line, lineFields) || !idValid(line.serviceRecordId) || ids.has(line.serviceRecordId)
      || !Number.isSafeInteger(line.version) || line.version < 1 || !boundedText(line.label, 300, true, true)
      || !moneyValid(line.amountCents) || !boundedText(line.sourceReference, 2000, true)) invalid('number', '人工服務明細或核對依據無法確認。');
    ids.add(line.serviceRecordId); amount += BigInt(line.amountCents);
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) invalid('number', '人工明細總額超出可精確保存範圍。');
  }
  return Number(amount);
}

function confirmedBill(value, { orgId, draftOnly = false, stored = true } = {}) {
  if (!closed(value, [...billFields, ...(stored ? metadata : [])]) || !idValid(value.caseId) || !monthValid(value.month) || !idValid(value.number)
    || !boundedText(value.sourceReference, 2000, draftOnly || value.status === 'issued') || !boundedText(value.note, 10000)
    || !['draft', 'issued', 'voided'].includes(value.status) || (draftOnly && value.status !== 'draft')
    || !closed(value.caseSnapshot, ['id', 'name', 'caseNo']) || value.caseSnapshot.id !== value.caseId
    || !boundedText(value.caseSnapshot.name, 500) || !boundedText(value.caseSnapshot.caseNo, 500)
    || !closed(value.summary, ['amountCents']) || !moneyValid(value.summary.amountCents, Number.MAX_SAFE_INTEGER)
    || !safeArray(value.lineItems, 1)) invalid('number', '帳單保存明細、個案與精確總額無法確認。');
  if (stored && (!idValid(value.id) || value.orgId !== orgId || !idValid(orgId) || !Number.isSafeInteger(value.version) || value.version < 1
    || !isoValid(value.createdAt) || !isoValid(value.updatedAt) || value.updatedAt < value.createdAt)) invalid('number', '帳單保存身份與版次無法確認。');
  let amount = 0n;
  for (const line of value.lineItems) {
    if (!closed(line, ['label', 'quantity', 'unitPriceCents']) || !boundedText(line.label, 300, true, true)
      || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 10000 || !moneyValid(line.unitPriceCents)) invalid('number', '帳單明細無法確認。');
    amount += BigInt(line.quantity) * BigInt(line.unitPriceCents);
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) invalid('number', '帳單總額超出可精確保存範圍。');
  }
  if (BigInt(value.summary.amountCents) !== amount) invalid('number', '帳單總額與保存明細不符。');
  return copy(value);
}
function confirmedPayload(payload) {
  const explicit = plain(payload) && owns(payload, 'spanMode');
  if (!closed(payload, [...payloadFields, ...(explicit ? ['spanMode'] : [])]) || explicit && payload.spanMode !== CALENDAR_SPAN_MODE || !idValid(payload.caseId) || !monthValid(payload.month) || !idValid(payload.number)
    || !boundedText(payload.sourceReference, 2000, true) || !boundedText(payload.note, 10000)) invalid('number', '人工核對內容無法確認。');
  serviceBillingManualTotal(payload.lines); return copy(payload);
}
function expectedDraft(payload) {
  return { caseId: payload.caseId, month: payload.month, number: payload.number,
    lineItems: payload.lines.map(line => ({ label: line.label, quantity: 1, unitPriceCents: line.amountCents })),
    sourceReference: payload.sourceReference, status: 'draft', note: payload.note, summary: { amountCents: serviceBillingManualTotal(payload.lines) } };
}
function matchSourceLines(sources, lines) {
  return sources.length === lines.length && sources.every((source, index) => source.id === lines[index].serviceRecordId && source.version === lines[index].version);
}
function matchDraft(bill, payload) {
  const draft = expectedDraft(payload);
  return Object.keys(draft).every(key => same(bill[key], draft[key]));
}
function confirmedSources(sources, orgId, payload) {
  if (!safeArray(sources, 1)) invalid('number', '所選服務來源陣列無法確認。');
  return sources.map(source => checkServiceBillingSource(source, { orgId, caseId: payload.caseId, month: payload.month, spanMode: payload.spanMode }));
}
export function checkServiceBillingPreview(result, { orgId, payload, sources } = {}) {
  const confirmed = confirmedPayload(payload);
  const selectedSources = confirmedSources(sources, orgId, confirmed);
  if (!closed(result, ['mode', 'draft', 'sources', 'manualLines', 'sourceCount', 'previewHash']) || result.mode !== ackMode(confirmedPayload(payload))
    || typeof result.previewHash !== 'string' || !/^[a-f0-9]{64}$/.test(result.previewHash) || result.previewHash.length !== 64
    || !safeArray(result.sources, 1) || !safeArray(result.manualLines, 1) || !Number.isSafeInteger(result.sourceCount)
    || result.sourceCount !== result.sources.length) invalid('number', '預覽回應無法確認，請保留輸入並重新預覽。');
  serviceBillingManualTotal(result.manualLines);
  if (!same(result.manualLines, confirmed.lines)) invalid('number', '預覽人工明細與輸入不符。');
  const sourceRows = result.sources.map(source => checkServiceBillingSource(source, { orgId, caseId: confirmed.caseId, month: confirmed.month, spanMode: confirmed.spanMode }));
  if (!matchSourceLines(sourceRows, confirmed.lines) || !same(sourceRows, selectedSources)) invalid('number', '預覽來源與所選保存版次不符，請重新讀取來源。');
  const draft = confirmedBill(result.draft, { stored: false, draftOnly: true });
  if (!matchDraft(draft, confirmed)) invalid('number', '預覽人工金額或原文與輸入不符。');
  return copy(result);
}

/** Origin is immutable generation evidence; current draft/issued/voided bill may differ. */
export function checkServiceBillingOrigin(value, { orgId, billId, payload, sources, spanMode } = {}) {
  const sourceMode = modeValue(payload === undefined ? spanMode : confirmedPayload(payload).spanMode);
  if (!closed(value, [...metadata, ...originFields]) || !idValid(value.id) || value.orgId !== orgId || !idValid(orgId)
    || value.version !== 1 || !isoValid(value.createdAt) || value.updatedAt !== value.createdAt || !idValid(value.billingDocumentId)
    || (billId && value.billingDocumentId !== billId) || !idValid(value.caseId) || !monthValid(value.month) || !idValid(value.number)
    || !boundedText(value.sourceReference, 2000, true) || !boundedText(value.note, 10000) || !safeArray(value.sourceSnapshots, 1)
    || !safeArray(value.manualLines, 1)) invalid('number', '帳單生成來源保存紀錄無法確認。');
  const generatedPayload = { caseId: value.caseId, month: value.month, number: value.number, sourceReference: value.sourceReference, note: value.note, lines: value.manualLines };
  confirmedPayload(generatedPayload);
  const sourceRows = value.sourceSnapshots.map(source => checkServiceBillingSource(source, { orgId, caseId: value.caseId, month: value.month, spanMode: sourceMode }));
  if (!matchSourceLines(sourceRows, value.manualLines)) invalid('number', '保存來源與人工核對明細不符。');
  const initial = confirmedBill(value.initialBillSnapshot, { orgId, draftOnly: true });
  if (initial.id !== value.billingDocumentId || initial.version !== 1 || !matchDraft(initial, generatedPayload)) invalid('number', '生成當時帳單快照無法確認。');
  if (payload !== undefined) {
    const confirmed = confirmedPayload(payload), selectedSources = confirmedSources(sources, orgId, confirmed);
    if (!same(stripSpanMode(confirmed), generatedPayload) || !same(selectedSources, sourceRows)) invalid('number', '帳單生成保存結果與本次核對內容不符。');
  }
  return copy(value);
}
export function checkServiceBillingSaved(result, { orgId, payload, sources, preview } = {}) {
  if (!closed(result, ['mode', 'item', 'origin']) || result.mode !== ackMode(confirmedPayload(payload))) invalid('number', '無法確認已生成帳單，請保留輸入並重試。');
  const confirmedPreview = preview === undefined ? undefined : checkServiceBillingPreview(preview, { orgId, payload, sources });
  const bill = confirmedBill(result.item, { orgId, draftOnly: true });
  const origin = checkServiceBillingOrigin(result.origin, { orgId, billId: bill.id, payload, sources });
  if (bill.version !== 1 || !same(bill, origin.initialBillSnapshot) || !matchDraft(bill, confirmedPayload(payload))
    || (confirmedPreview && !same(bill.caseSnapshot, confirmedPreview.draft.caseSnapshot))) invalid('number', '帳單保存 ACK 不完整或與預覽不符；輸入仍保留。');
  return { mode: result.mode, item: bill, origin };
}
export function checkServiceBillingOriginDetail(result, { orgId, billId, spanMode } = {}) {
  if (!closed(result, ['origin', 'bill'])) invalid('number', '帳單來源詳情回應無法確認。');
  const bill = confirmedBill(result.bill, { orgId }), origin = checkServiceBillingOrigin(result.origin, { orgId, billId: billId || bill.id, spanMode });
  if (bill.id !== origin.billingDocumentId || bill.caseId !== origin.caseId || bill.month !== origin.month || bill.number !== origin.number
    || bill.version < origin.initialBillSnapshot.version || bill.createdAt !== origin.initialBillSnapshot.createdAt) invalid('number', '目前帳單與來源保存身份不符。');
  return { origin, bill };
}
export function checkServiceBillingOriginCollection(result, { orgId, caseId, month, q = '', page = 1, pageSize = 25, spanMode } = {}) {
  modeValue(spanMode);
  if (!closed(result, ['query', 'items', 'total', 'page', 'pageSize']) || !closed(result.query, ['caseId', 'month', 'q', ...(spanMode ? ['spanMode'] : [])])
    || (spanMode ? result.query.spanMode !== spanMode : owns(result.query, 'spanMode'))
    || result.query.caseId !== caseId || result.query.month !== month || result.query.q !== q || result.page !== page || result.pageSize !== pageSize
    || !Number.isSafeInteger(result.total) || result.total < 0 || !safeArray(result.items, 0, pageSize) || result.items.length > result.total) invalid('number', '帳單來源清單回應無法確認。');
  const ids = new Set();
  return result.items.map(value => {
    const row = checkServiceBillingOriginDetail(value, { orgId, spanMode });
    if (row.origin.caseId !== caseId || row.origin.month !== month || ids.has(row.bill.id)) invalid('number', '帳單來源清單範圍或重複資料無法確認。');
    ids.add(row.bill.id); return row;
  });
}

export function createServiceBillingEditor({ sources, orgId, caseId, caseName = '', month, spanMode } = {}) {
  if (!safeArray(sources, 1)) invalid('caseId', '請選擇1至100筆已確認服務。');
  const confirmed = sources.map(source => checkServiceBillingSource(source, { orgId, caseId, month, spanMode }));
  if (new Set(confirmed.map(source => source.id)).size !== confirmed.length || !boundedText(caseName, 1100)) invalid('caseId', '服務來源重複或個案文字無法確認。');
  const initial = { caseId, month, number: '', sourceReference: '', note: '' };
  const fields = [{ name: 'caseId', label: '個案', groupLabel: '帳單草稿識別', type: 'select', disabled: true,
    options: [{ value: caseId, label: caseName || caseId }], help: '依已選來源固定個案，生成草稿後不可換案。' },
    { name: 'month', label: '帳單月份', type: 'month', readOnly: true, required: true },
    { name: 'number', label: '帳單編號', required: true, maxLength: 100 }];
  confirmed.forEach((source, index) => {
    initial[`lineLabel${index}`] = `${source.date} ${source.billingSnapshot.items.map(item => item.name).join('、')}`.slice(0, 300).replace(/[\r\n]/g, ' ');
    initial[`lineAmount${index}`] = ''; initial[`lineReference${index}`] = '';
    fields.push({ name: `lineLabel${index}`, label: `服務${index + 1} 帳單明細名稱`, groupLabel: `服務${index + 1} · ${source.date} · ${source.billingSnapshot.employee.name}`,
      required: true, maxLength: 300, wide: true, help: '每個已核閱服務紀錄生成一筆人工整體金額，帳單數量固定為1。' },
    { name: `lineAmount${index}`, label: `服務${index + 1} 人工核定總額（元）`, required: true, inputMode: 'decimal', maxLength: 15,
      help: '明確人工填寫，最多兩位小數；不使用核閱保存的試算價預填。' },
    { name: `lineReference${index}`, label: `服務${index + 1} 人工核對依據`, required: true, type: 'textarea', maxLength: 2000, wide: true });
  });
  fields.push({ name: 'sourceReference', label: '帳單共同人工計價依據', groupLabel: '共同核對與備註', required: true, type: 'textarea', maxLength: 2000, wide: true,
    help: '保存人工已核對的依據；不代表官方費率、自付補助或正式申報。' },
  { name: 'note', label: '帳單備註', type: 'textarea', maxLength: 10000, wide: true });
  const keys = fields.map(field => field.name);
  return { fields, initial, sources: copy(confirmed), buildPayload(values) {
    if (!closed(values, keys)) invalid('number', '表單包含未知或缺少欄位。');
    if (text(values, 'caseId') !== caseId || text(values, 'month') !== month) invalid('caseId', '已選來源的個案與月份不可變更。');
    const number = text(values, 'number').trim(), sourceReference = text(values, 'sourceReference'), note = text(values, 'note');
    if (!idValid(number)) invalid('number', '請填寫最多100字元的單行帳單編號。');
    if (!boundedText(sourceReference, 2000, true)) invalid('sourceReference', '請填寫最多2000字元的共同人工計價依據。');
    if (!boundedText(note, 10000)) invalid('note', '備註超過10000字元。');
    const lines = confirmed.map((source, index) => {
      const label = text(values, `lineLabel${index}`).trim(), sourceReference = text(values, `lineReference${index}`);
      if (!boundedText(label, 300, true, true)) invalid(`lineLabel${index}`, '請填寫最多300字元的單行明細名稱。');
      if (!boundedText(sourceReference, 2000, true)) invalid(`lineReference${index}`, '請填寫本筆服務的人工核對依據。');
      return { serviceRecordId: source.id, version: source.version, label,
        amountCents: parseBillingMoney(text(values, `lineAmount${index}`), { key: `lineAmount${index}` }), sourceReference };
    });
    serviceBillingManualTotal(lines);
    return { caseId, month, number, sourceReference, note, lines, ...(modeValue(spanMode) ? { spanMode } : {}) };
  } };
}

export const serviceBillingKnownFields = Object.freeze({ source: Object.freeze(sourceFields), sourceSpan: Object.freeze([...sourceFields, 'actualEndDate']), snapshot: Object.freeze(snapshotFields), manualLine: Object.freeze(lineFields), payload: Object.freeze(payloadFields) });
export { formatBillingCents };
