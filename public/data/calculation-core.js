/** Explicit organization-rule calculations. No official rates or settlement defaults. */
import { RULE_PARAMETERS } from './business-rule-fields.js';
import { serviceSpan, spanCoveredByDates } from './shift-span.js';

export const CALCULATION_MODE = 'configurable-calculation-preview-v1';
export const CALCULATION_ROUNDINGS = Object.freeze(['floor', 'ceiling', 'half-up', 'half-even']);
export class CalculationError extends Error {
  constructor(code, message, status = 422) { super(message); this.name = 'CalculationError'; this.code = code; this.status = status; }
}
const reject = (code, message, status) => { throw new CalculationError(code, message, status); };
const descriptor = (value, key) => Object.getOwnPropertyDescriptor(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && descriptor(value, key)?.enumerable && Object.hasOwn(descriptor(value, key), 'value'));
const closed = (value, required, optional = []) => plain(value) && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => [...required, ...optional].includes(key));
const dense = (value, min, max) => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length >= min && value.length <= max
  && Reflect.ownKeys(value).length === value.length + 1
  && Array.from({ length: value.length }, (_, i) => String(i)).every(key => descriptor(value, key)?.enumerable && Object.hasOwn(descriptor(value, key), 'value'));
const safe = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max;
const text = (value, max, required = false) => typeof value === 'string' && value.length <= max && !value.includes('\0') && (!required || !!value.trim());
const ref = value => text(value, 100, true) && value === value.trim() && !/[\r\n]/.test(value);
const date = value => typeof value === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) && value.length === 10
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const iso = value => typeof value === 'string' && value.length === 24 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** Canonical copies never retain input references or invoke accessor properties. */
export function immutableCalculationCopy(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') { if (!safe(value)) reject('CALCULATION_UNSAFE_INTEGER', '計算內容須使用非負安全整數。'); return value; }
  if (Array.isArray(value)) {
    if (!dense(value, 0, 10000)) reject('CALCULATION_INVALID', '計算陣列必須為完整、沒有額外欄位的資料。');
    return Object.freeze(value.map(immutableCalculationCopy));
  }
  if (!plain(value)) reject('CALCULATION_INVALID', '計算內容必須為沒有未知型態的資料。');
  return Object.freeze(Object.fromEntries(Object.keys(value).sort().map(key => [key, immutableCalculationCopy(value[key])])));
}
export const canonicalCalculationJson = value => JSON.stringify(immutableCalculationCopy(value));

const safeResult = value => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) reject('CALCULATION_OVERFLOW', '計算結果超出安全整數分範圍。');
  return Number(value);
};
function rational(numerator, denominator, rounding, step, operation) {
  const quotient = numerator / denominator, remainder = numerator % denominator;
  let result = quotient;
  if (rounding === 'ceiling' && remainder > 0n) result++;
  if (rounding === 'half-up' && 2n * remainder >= denominator) result++;
  if (rounding === 'half-even' && (2n * remainder > denominator || 2n * remainder === denominator && quotient % 2n === 1n)) result++;
  return Object.freeze({ step, operation, numerator: numerator.toString(), denominator: denominator.toString(), rounding,
    quotientCents: safeResult(quotient), remainderNumerator: remainder.toString(), resultCents: safeResult(result) });
}

/** Low-level exact cents helper; all operation/operand/rounding choices are explicit. */
export function exactCentsOperation(input) {
  if (!plain(input)) reject('CALCULATION_POLICY_REQUIRED', '請明確選擇計算方式與參數。');
  const operations = {
    flat: ['operation', 'amountCents'],
    'quantity-rate': ['operation', 'quantity', 'rateCents'],
    'minutes-hourly': ['operation', 'minutes', 'hourlyRateCents', 'rounding'],
    'basis-points': ['operation', 'amountCents', 'basisPoints', 'rounding'],
  };
  const fields = Object.hasOwn(operations, input.operation) ? operations[input.operation] : null;
  if (!fields || !closed(input, fields)) reject('CALCULATION_POLICY_REQUIRED', '請提供此計算方式的完整明確參數，不能省略或加入其他欄位。');
  for (const key of fields.filter(key => !['operation', 'rounding'].includes(key))) {
    if (!safe(input[key], 0, key === 'basisPoints' ? 10000 : Number.MAX_SAFE_INTEGER)) reject('CALCULATION_UNSAFE_INTEGER', '金額、數量、分鐘與比例須為有效的非負安全整數。');
  }
  if (Object.hasOwn(input, 'rounding') && !CALCULATION_ROUNDINGS.includes(input.rounding)) reject('CALCULATION_ROUNDING_REQUIRED', '分鐘折算與比例計算必須明確選擇捨入方式。');
  let numerator, denominator = 1n;
  if (input.operation === 'flat') numerator = BigInt(input.amountCents);
  if (input.operation === 'quantity-rate') numerator = BigInt(input.quantity) * BigInt(input.rateCents);
  if (input.operation === 'minutes-hourly') { numerator = BigInt(input.minutes) * BigInt(input.hourlyRateCents); denominator = 60n; }
  if (input.operation === 'basis-points') { numerator = BigInt(input.amountCents) * BigInt(input.basisPoints); denominator = 10000n; }
  return rational(numerator, denominator, input.rounding || 'exact', 'amount', input.operation);
}

const ruleFields = ['id', 'orgId', 'version', 'createdAt', 'updatedAt', 'kind', 'code', 'name', 'validFrom', 'validTo', 'sourceReference', 'parameters', 'status', 'note'];
export function assertCalculationRule(rule) {
  if (!closed(rule, ruleFields) || !ref(rule.id) || !ref(rule.orgId) || !safe(rule.version, 1) || !['pricing', 'payroll'].includes(rule.kind)
    || !text(rule.code, 500, true) || !text(rule.name, 500, true) || !text(rule.sourceReference, 2000, true) || !text(rule.note, 10000)
    || !date(rule.validFrom) || !date(rule.validTo) || rule.validTo < rule.validFrom || !iso(rule.createdAt) || !iso(rule.updatedAt) || rule.updatedAt < rule.createdAt)
    reject('CALCULATION_RULE_INVALID', '核定規則保存內容無法確認。', 409);
  if (rule.status !== 'approved') reject('CALCULATION_RULE_NOT_APPROVED', '僅可選取機構已核定的規則。', 409);
  const parameters = RULE_PARAMETERS[rule.kind];
  if (!closed(rule.parameters, parameters.map(item => item.key)) || parameters.some(item => !safe(rule.parameters[item.key], item.min || 0, item.max)))
    reject('CALCULATION_RULE_INVALID', '核定規則參數無法確認。', 409);
  return rule;
}

const sourceFields = ['id', 'orgId', 'version', 'createdAt', 'updatedAt', 'shiftId', 'caseId', 'employeeId', 'date', 'actualStart', 'actualEnd', 'services', 'status', 'billingSnapshot'];
function assertSourceSnapshot(source, snapshotSource) {
  if (!closed(source, sourceFields, ['actualEndDate', 'note', 'reviewNote']) || !['id', 'orgId', 'shiftId', 'caseId', 'employeeId'].every(key => ref(source[key]))
    || !safe(source.version, 1) || !date(source.date) || !iso(source.createdAt) || !iso(source.updatedAt) || source.updatedAt < source.createdAt
    || source.status !== 'approved' || !dense(source.services, 1, 100) || ['note', 'reviewNote'].some(key => Object.hasOwn(source, key) && !text(source[key], 10000)))
    reject('CALCULATION_SOURCE_INVALID', '請使用完整的原已核閱服務紀錄。', 409);
  const snapshot = source.billingSnapshot;
  if (!closed(snapshot, ['capturedAt', 'currency', 'trial', 'source', 'serviceMinutes', 'employee', 'items']) || !iso(snapshot.capturedAt)
    || snapshot.currency !== 'TWD' || snapshot.trial !== true || snapshot.source !== snapshotSource || !safe(snapshot.serviceMinutes, 1, 2879)
    || !closed(snapshot.employee, ['id', 'name', 'employeeNo', 'hourlyRateCents']) || snapshot.employee.id !== source.employeeId
    || !text(snapshot.employee.name, 500) || !text(snapshot.employee.employeeNo, 500) || !safe(snapshot.employee.hourlyRateCents, 0, 1000000000)
    || !dense(snapshot.items, 1, 100) || snapshot.items.length !== source.services.length)
    reject('CALCULATION_SOURCE_INVALID', '原核閱來源的固定試算與人員快照無法確認。', 409);
  const seen = new Set();
  snapshot.items.forEach((item, index) => {
    const service = source.services[index];
    if (!closed(item, ['serviceItemId', 'code', 'name', 'quantity', 'unitPriceCents', 'amountCents']) || !ref(item.serviceItemId) || seen.has(item.serviceItemId)
      || !text(item.code, 500) || !text(item.name, 500) || !safe(item.quantity, 1, 10000) || !safe(item.unitPriceCents, 0, 1000000000) || !safe(item.amountCents)
      || BigInt(item.quantity) * BigInt(item.unitPriceCents) !== BigInt(item.amountCents)
      || !closed(service, ['serviceItemId', 'quantity']) || service.serviceItemId !== item.serviceItemId || service.quantity !== item.quantity)
      reject('CALCULATION_SOURCE_INVALID', '原核閱來源的項目、數量或精確金額無法確認。', 409);
    seen.add(item.serviceItemId);
  });
  let span;
  try { span = serviceSpan({ date: source.date, actualStart: source.actualStart, actualEnd: source.actualEnd, ...(Object.hasOwn(source, 'actualEndDate') ? { actualEndDate: source.actualEndDate } : {}) }); }
  catch { reject('CALCULATION_SOURCE_INVALID', '原核閱服務的完整起訖日期無法確認。', 409); }
  if (span.durationMinutes !== snapshot.serviceMinutes) reject('CALCULATION_SOURCE_INVALID', '服務分鐘與原核閱快照不符。', 409);
  return source;
}

export function assertCalculationSource(source) { return assertSourceSnapshot(source, 'approval'); }
/** Classify complete known demo snapshots as ineligible; never authorize a preview. */
export function assertSyntheticDemoCalculationSource(source) { return assertSourceSnapshot(source, 'synthetic-demo'); }

/** The cap basis is an explicit hypothetical input, never a saved monthly ledger. */
export function allocatePricingCents(input) {
  if (!closed(input, ['grossCents', 'capCents', 'consumedCents', 'copayBasisPoints', 'capMeaning', 'rounding']))
    reject('CALCULATION_ALLOCATION_REQUIRED', '分攤必須提供完整明確參數，不能省略或加入其他欄位。');
  const { grossCents, capCents, consumedCents, copayBasisPoints, capMeaning, rounding } = input;
  if (![grossCents, capCents, consumedCents].every(value => safe(value)) || !safe(copayBasisPoints, 0, 10000))
    reject('CALCULATION_UNSAFE_INTEGER', '分攤金額、已用額度與自付比例須為有效安全整數。');
  if (!['eligible-gross-ceiling', 'subsidy-ceiling'].includes(capMeaning) || !CALCULATION_ROUNDINGS.includes(rounding))
    reject('CALCULATION_ALLOCATION_REQUIRED', '必須明確選擇額度意義、自付比例與捨入方式。');
  const remainingCents = Math.max(0, capCents - consumedCents), trace = [];
  let eligibleCents, copayCents, subsidyCents, excessCents, capUsageCents;
  if (capMeaning === 'eligible-gross-ceiling') {
    eligibleCents = Math.min(grossCents, remainingCents);
    const copay = rational(BigInt(eligibleCents) * BigInt(copayBasisPoints), 10000n, rounding, 'copay', 'basis-points'); trace.push(copay);
    copayCents = copay.resultCents; subsidyCents = eligibleCents - copayCents; excessCents = grossCents - eligibleCents; capUsageCents = eligibleCents;
  } else {
    eligibleCents = grossCents;
    const copay = rational(BigInt(grossCents) * BigInt(copayBasisPoints), 10000n, rounding, 'copay', 'basis-points'); trace.push(copay);
    copayCents = copay.resultCents; const requestedSubsidyCents = grossCents - copayCents;
    subsidyCents = Math.min(requestedSubsidyCents, remainingCents); excessCents = requestedSubsidyCents - subsidyCents; capUsageCents = subsidyCents;
  }
  const payableCents = safeResult(BigInt(copayCents) + BigInt(excessCents));
  const consumedAfterCents = safeResult(BigInt(consumedCents) + BigInt(capUsageCents));
  if (BigInt(payableCents) + BigInt(subsidyCents) !== BigInt(grossCents)) reject('CALCULATION_ALLOCATION_INVALID', '分攤合計無法精確核對。', 409);
  return immutableCalculationCopy({ capMeaning, capCents, consumedBeforeCents: consumedCents, remainingBeforeCents: remainingCents,
    eligibleCents, copayBasisPoints, rounding, copayCents, excessCents, payableCents, subsidyCents, capUsageCents, consumedAfterCents, trace });
}

export function assertCalculationPolicy(policy, kind) {
  if (!plain(policy)) reject('CALCULATION_POLICY_REQUIRED', '每次試算必須明確選擇計算方式。');
  if (kind === 'pricing') {
    if (!closed(policy, ['operation', 'rateParameter', 'serviceItemId'], ['allocation']) || policy.operation !== 'quantity-rate'
      || policy.rateParameter !== 'unitPriceCents' || !ref(policy.serviceItemId)) reject('CALCULATION_POLICY_REQUIRED', '計價試算須明確選取單位金額與原核閱項目。');
    if (Object.hasOwn(policy, 'allocation')) {
      const allocation = policy.allocation;
      if (!closed(allocation, ['capMeaning', 'consumedCents', 'capParameter', 'copayBasisPoints', 'rounding']) || allocation.capParameter !== 'monthlyCapCents'
        || !safe(allocation.consumedCents) || !safe(allocation.copayBasisPoints, 0, 10000)
        || !['eligible-gross-ceiling', 'subsidy-ceiling'].includes(allocation.capMeaning) || !CALCULATION_ROUNDINGS.includes(allocation.rounding))
        reject('CALCULATION_ALLOCATION_REQUIRED', '分攤必須明確指定月額度意義、已用額度、自付比例及捨入，零額度按零處理。');
    }
  } else if (kind === 'payroll') {
    if (policy.operation === 'flat' && closed(policy, ['operation', 'amountParameter']) && policy.amountParameter === 'baseCents') return policy;
    if (policy.operation === 'minutes-hourly' && closed(policy, ['operation', 'rateParameter', 'rounding']) && policy.rateParameter === 'baseCents'
      && CALCULATION_ROUNDINGS.includes(policy.rounding)) return policy;
    if (policy.operation === 'basis-points' && closed(policy, ['operation', 'amountParameter', 'ratioParameter', 'rounding'])
      && policy.amountParameter === 'baseCents' && policy.ratioParameter === 'shareBasisPoints' && CALCULATION_ROUNDINGS.includes(policy.rounding)) return policy;
    reject('CALCULATION_POLICY_REQUIRED', '薪資試算須明確選擇固定金額、每小時基準或基準金額拆帳；折算必須明確指定捨入。');
  } else reject('CALCULATION_POLICY_REQUIRED', '此試算僅支援已核定計價及薪資規則。');
  return policy;
}

/** A reusable immutable preview; cannot issue bills, settle payroll or write cap usage. */
export function calculateConfiguredAmount(input) {
  if (!closed(input, ['rule', 'source', 'policy'])) reject('CALCULATION_POLICY_REQUIRED', '請提供明確的核定規則、來源與計算方式。');
  const { rule, source, policy } = input;
  assertCalculationRule(rule); assertCalculationSource(source);
  if (rule.orgId !== source.orgId) reject('CALCULATION_ORG_MISMATCH', '規則與來源必須屬於同一機構。', 403);
  const span = serviceSpan({ date: source.date, actualStart: source.actualStart, actualEnd: source.actualEnd, ...(Object.hasOwn(source, 'actualEndDate') ? { actualEndDate: source.actualEndDate } : {}) });
  if (!spanCoveredByDates(span, rule.validFrom, rule.validTo)) reject('CALCULATION_RULE_NOT_EFFECTIVE', '核定規則必須涵蓋服務實際佔用的完整日期。', 409);
  assertCalculationPolicy(policy, rule.kind);
  let arithmetic;
  if (policy.operation === 'quantity-rate') {
    const item = source.billingSnapshot.items.find(item => item.serviceItemId === policy.serviceItemId);
    if (!item) reject('CALCULATION_ITEM_NOT_FOUND', '所選項目不在原核閱來源中。', 409);
    arithmetic = exactCentsOperation({ operation: 'quantity-rate', quantity: item.quantity, rateCents: rule.parameters.unitPriceCents });
  }
  if (policy.operation === 'flat') arithmetic = exactCentsOperation({ operation: 'flat', amountCents: rule.parameters.baseCents });
  if (policy.operation === 'minutes-hourly') arithmetic = exactCentsOperation({ operation: 'minutes-hourly', minutes: source.billingSnapshot.serviceMinutes, hourlyRateCents: rule.parameters.baseCents, rounding: policy.rounding });
  if (policy.operation === 'basis-points') arithmetic = exactCentsOperation({ operation: 'basis-points', amountCents: rule.parameters.baseCents, basisPoints: rule.parameters.shareBasisPoints, rounding: policy.rounding });
  let allocation = null;
  if (Object.hasOwn(policy, 'allocation')) {
    if (policy.allocation.copayBasisPoints !== rule.parameters.copayBasisPoints) reject('CALCULATION_COPAY_MISMATCH', '本次明確填寫的自付比例須與所選核定規則一致。', 409);
    allocation = allocatePricingCents({ grossCents: arithmetic.resultCents, capCents: rule.parameters.monthlyCapCents,
      consumedCents: policy.allocation.consumedCents, copayBasisPoints: policy.allocation.copayBasisPoints,
      capMeaning: policy.allocation.capMeaning, rounding: policy.allocation.rounding });
  }
  return immutableCalculationCopy({ mode: CALCULATION_MODE, currency: 'TWD', previewOnly: true,
    ruleSnapshot: rule, sourceSnapshot: source, policySnapshot: policy, amountCents: arithmetic.resultCents, trace: [arithmetic], allocation });
}
