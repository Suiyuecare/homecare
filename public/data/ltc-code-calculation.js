import { LTC_BA_AA_CATALOG } from './ltc-ba-aa-catalog.js';
import {
  CalculationError, CALCULATION_ROUNDINGS, assertCalculationSource, exactCentsOperation, immutableCalculationCopy,
} from './calculation-core.js';
import { serviceSpan, spanCoveredByDates } from './shift-span.js';

export const LTC_CODE_CALCULATION_MODE = 'ltc-ba-aa-price-preview-v1';
export const LTC_CATALOG_VERSION = LTC_BA_AA_CATALOG.version;
export const LTC_CATALOG_SOURCE_SHA256 = '78df59bc8828b7495da524a445c9a000e7bd20b7ce12b41f8b1a47705d95a9e4';
export const LTC_CODE_REGIONS = Object.freeze(['ordinary', 'indigenous-or-island']);
export const LTC_CODE_CONTEXTS = Object.freeze(['standard', 'shared-family-50-percent', 'case-management-over-limit-90-percent']);
const own = (value, key) => Object.getOwnPropertyDescriptor(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && own(value, key)?.enumerable && Object.hasOwn(own(value, key), 'value'));
const closed = (value, fields) => plain(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const dense = value => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && Reflect.ownKeys(value).length === value.length + 1
  && Array.from({ length: value.length }, (_, i) => String(i)).every(key => own(value, key)?.enumerable && Object.hasOwn(own(value, key), 'value'));
const safe = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max;
const text = (value, max, required = false) => typeof value === 'string' && value.length <= max && !value.includes('\0') && (!required || !!value.trim());
const ref = value => text(value, 100, true) && value === value.trim() && !/[\r\n]/.test(value);
const date = value => typeof value === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) && value.length === 10
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const reject = (code, message, status = 422) => { throw new CalculationError(code, message, status); };
const catalogFields = ['schema', 'version', 'currency', 'sourceUrl', 'lawUrl', 'sourceSha256', 'checkedOn', 'priceColumnsVisuallyReviewed', 'items'];
const itemFields = ['code', 'name', 'conditions', 'ordinaryCents', 'indigenousIslandCents', 'sourcePage', 'effectiveFrom', 'effectiveTo', 'copayExempt', 'countsTowardCareQuota'];

/** Shape and source provenance are checked; only the bundled reviewed catalog is used for prices. */
export function assertReviewedLtcCatalog(catalog) {
  if (!closed(catalog, catalogFields) || catalog.schema !== 'ltc-ba-aa-catalog-v1' || catalog.version !== LTC_CATALOG_VERSION || catalog.currency !== 'TWD'
    || catalog.sourceUrl !== 'https://law.moj.gov.tw/LawClass/LawGetFile.ashx?FileId=0000398331&lan=C'
    || catalog.lawUrl !== 'https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=L0070059' || catalog.sourceSha256 !== LTC_CATALOG_SOURCE_SHA256
    || !date(catalog.checkedOn) || catalog.priceColumnsVisuallyReviewed !== true || !dense(catalog.items) || catalog.items.length !== 39)
    reject('LTC_CATALOG_INVALID', '官方支付清冊的固定來源、版次或人工價格欄核對無法確認。', 409);
  const seen = new Set(); let aa = 0, ba = 0;
  for (const item of catalog.items) {
    if (!closed(item, itemFields) || !/^(?:AA\d{2}|BA\d{2}(?:a|b|c|d1|d2|e)?)$/.test(item.code) || seen.has(item.code)
      || !text(item.name, 500, true) || !text(item.conditions, 20000, true) || !safe(item.ordinaryCents, 0, 1000000000) || !safe(item.indigenousIslandCents, 0, 1000000000)
      || !safe(item.sourcePage, 1, 53) || !date(item.effectiveFrom) || !(item.effectiveTo === null || date(item.effectiveTo) && item.effectiveTo >= item.effectiveFrom)
      || typeof item.copayExempt !== 'boolean' || typeof item.countsTowardCareQuota !== 'boolean'
      || (item.code.startsWith('AA') ? !item.copayExempt || item.countsTowardCareQuota : item.copayExempt || !item.countsTowardCareQuota))
      reject('LTC_CATALOG_INVALID', '官方支付清冊的代碼、條件、金額或適用日期無法確認。', 409);
    seen.add(item.code); if (item.code.startsWith('AA')) aa++; else ba++;
  }
  if (aa !== 12 || ba !== 27) reject('LTC_CATALOG_INVALID', '官方 BA／AA 清冊的完整筆數無法核對。', 409);
  return catalog;
}
assertReviewedLtcCatalog(LTC_BA_AA_CATALOG);

export function assertLtcCodePolicy(policy) {
  const eligibilityFields = ['confirmed', 'sourceReference'];
  const eligibilityValid = plain(policy) && (closed(policy.eligibility, eligibilityFields)
    || closed(policy.eligibility, [...eligibilityFields, 'specialApprovalReference']) && text(policy.eligibility.specialApprovalReference, 2000, true));
  if (!closed(policy, ['operation', 'serviceItemId', 'code', 'region', 'paymentContext', 'rounding', 'eligibility'])
    || policy.operation !== 'official-code-quantity' || !ref(policy.serviceItemId) || !ref(policy.code)
    || !LTC_CODE_REGIONS.includes(policy.region) || !LTC_CODE_CONTEXTS.includes(policy.paymentContext) || !CALCULATION_ROUNDINGS.includes(policy.rounding)
    || !eligibilityValid || policy.eligibility.confirmed !== true || !text(policy.eligibility.sourceReference, 2000, true))
    reject('LTC_POLICY_REQUIRED', '須明確選取原核閱項目、官方代碼、居住區域、支付情形、捨入及人工資格核對依據。');
  if (policy.paymentContext === 'shared-family-50-percent' && !['BA15', 'BA16'].includes(policy.code))
    reject('LTC_PAYMENT_CONTEXT_INVALID', '共同區域或家人物品的百分之五十支付僅適用 BA15、BA16。');
  if (policy.paymentContext === 'case-management-over-limit-90-percent' && !['AA01', 'AA02'].includes(policy.code))
    reject('LTC_PAYMENT_CONTEXT_INVALID', '個案管理超額組數的百分之九十支付僅適用 AA01、AA02。');
  return policy;
}

/** Only constraints evidenced by this exact captured source are checked. No per-item timing is invented. */
function assertKnownSourceConditions(source, policy, span) {
  const quantities = new Map();
  for (const item of source.billingSnapshot.items) quantities.set(item.code, (quantities.get(item.code) || 0n) + BigInt(item.quantity));
  const has = code => quantities.has(code), quantity = code => quantities.get(code) || 0n;
  const conflict = message => reject('LTC_SOURCE_CONDITION_CONFLICT', message, 409);
  const incompatible = (left, right) => {
    if (has(left) && has(right)) conflict(`${left} 與 ${right} 不能在此未分段的同一服務來源併計，請先釐清並重新核閱服務來源。`);
  };
  for (const [code, value] of quantities) {
    if (/^AA\d{2}$/.test(code) && value > 1n) conflict(`${code} 的單次加計在此單一個案來源只能試算一組；跨紀錄日／月／年次數仍待核對。`);
  }
  incompatible('AA01', 'AA02'); incompatible('AA08', 'AA09');
  for (const [left, right] of [['BA01', 'BA07'], ['BA01', 'BA23'], ['BA07', 'BA23'], ['BA01', 'BA24'], ['BA07', 'BA24']]) incompatible(left, right);
  const baCodes = [...quantities.keys()].filter(code => /^BA\d{2}(?:a|b|c|d1|d2|e)?$/.test(code));
  for (const code of ['BA02', 'BA18', 'BA20', 'BA22']) {
    if (has(code) && baCodes.some(other => other !== code)) conflict(`${code} 不能與其他 BA 在此未分段的同一服務來源併計；可接續服務須另保存可辨識時段後重新核閱。`);
  }
  if (quantity('BA01') > 2n) conflict('BA01 原則每日一組，必要早晚最多各一組；此來源超過兩組，不能以人工勾選覆蓋。');
  const special = Object.hasOwn(policy.eligibility, 'specialApprovalReference');
  if (quantity('BA01') === 2n && (policy.code !== 'BA01' || !special))
    reject('LTC_SPECIAL_APPROVAL_REQUIRED', 'BA01 兩組須明確記錄必要早晚例外的核定依據；一般資格勾選不能代替。');
  if (special && (policy.code !== 'BA01' || quantity('BA01') !== 2n)) reject('LTC_SPECIAL_APPROVAL_INVALID', '必要早晚例外依據僅適用此來源 BA01 恰好兩組的試算。');
  if (quantity('BA02') > 6n) conflict('BA02 每組三十分鐘，每日最多三小時；此來源超過六組。');
  const timedQuantity = ['BA02', 'BA13', 'BA15', 'BA18', 'BA20'].reduce((total, code) => total + quantity(code), 0n);
  if (timedQuantity * 30n > BigInt(span.durationMinutes)) conflict('此來源三十分鐘組合的合計分鐘超過已核閱實際服務分鐘，不能套用官方單價。');
  if (has('AA08') && !span.segments.some(segment => segment.startMinute < 1440 && segment.endMinute > 1200))
    conflict('AA08 須有晚間二十點至二十四點的實際服務；此來源完全未佔用該時段。');
  if (has('AA10') && !span.segments.some(segment => segment.startMinute < 360 && segment.endMinute > 0))
    conflict('AA10 須有零點至六點的實際緊急服務；此來源完全未佔用該時段。');
}

/** Catalog price preview with an explicit human eligibility attestation. No inferred AA, cap ledger or claim. */
export function calculateLtcCodeAmount(input) {
  if (!closed(input, ['catalogVersion', 'source', 'policy'])) reject('LTC_POLICY_REQUIRED', '須提供固定清冊版次、原核閱來源及完整明確政策。');
  if (input.catalogVersion !== LTC_CATALOG_VERSION) reject('LTC_CATALOG_VERSION_CONFLICT', '官方支付清冊版次已變更，請重新選取並核對。', 409);
  assertCalculationSource(input.source); assertLtcCodePolicy(input.policy);
  const { source, policy } = input;
  const code = LTC_BA_AA_CATALOG.items.find(item => item.code === policy.code);
  if (!code) reject('LTC_CODE_NOT_FOUND', '此版官方 BA／AA 清冊沒有所選代碼。', 409);
  const item = source.billingSnapshot.items.find(item => item.serviceItemId === policy.serviceItemId);
  if (!item || item.code !== policy.code) reject('LTC_SOURCE_CODE_MISMATCH', '官方代碼須精確符合原核閱所選項目，不能自動添加 AA 或替換來源。', 409);
  const span = serviceSpan({ date: source.date, actualStart: source.actualStart, actualEnd: source.actualEnd, ...(Object.hasOwn(source, 'actualEndDate') ? { actualEndDate: source.actualEndDate } : {}) });
  if (!spanCoveredByDates(span, code.effectiveFrom, code.effectiveTo || '9999-12-31')) reject('LTC_CODE_NOT_EFFECTIVE', '官方代碼的版本須涵蓋服務實際佔用的完整日期。', 409);
  assertKnownSourceConditions(source, policy, span);
  const rateCents = policy.region === 'ordinary' ? code.ordinaryCents : code.indigenousIslandCents;
  const amount = exactCentsOperation({ operation: 'quantity-rate', quantity: item.quantity, rateCents });
  let paymentBase = amount.resultCents, sharedFamilySelfPayCents = 0, caseloadReductionCents = 0;
  const trace = [{ ...amount, step: 'catalog-gross' }];
  if (policy.paymentContext !== 'standard') {
    const adjusted = exactCentsOperation({ operation: 'basis-points', amountCents: amount.resultCents,
      basisPoints: policy.paymentContext === 'shared-family-50-percent' ? 5000 : 9000, rounding: policy.rounding });
    trace.push({ ...adjusted, step: 'payment-base' }); paymentBase = adjusted.resultCents;
    if (policy.paymentContext === 'shared-family-50-percent') sharedFamilySelfPayCents = amount.resultCents - paymentBase;
    else caseloadReductionCents = amount.resultCents - paymentBase;
  }
  const catalogSnapshot = Object.fromEntries(catalogFields.filter(key => key !== 'items').map(key => [key, LTC_BA_AA_CATALOG[key]]));
  return immutableCalculationCopy({ mode: LTC_CODE_CALCULATION_MODE, currency: 'TWD', previewOnly: true, eligibilityVerification: 'manual-attestation',
    sourceConditionsVerification: 'verified-known-source-constraints', crossRecordLimitsVerification: 'not-verified',
    catalogSnapshot, codeSnapshot: code, sourceSnapshot: source, policySnapshot: policy, quantity: item.quantity, unitPriceCents: rateCents,
    catalogGrossCents: amount.resultCents, eligiblePaymentBaseCents: paymentBase, sharedFamilySelfPayCents, caseloadReductionCents,
    copayExempt: code.copayExempt, countsTowardCareQuota: code.countsTowardCareQuota,
    copayCents: code.copayExempt ? 0 : null, capUsageCents: code.countsTowardCareQuota ? null : 0, trace });
}

export function ltcCatalogSnapshot() { return immutableCalculationCopy(LTC_BA_AA_CATALOG); }
