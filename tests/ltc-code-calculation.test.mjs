import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { initDb, insert, replace, billingSnapshot, fail, now } from '../src/server/model.mjs';
import { commitAccountChange } from '../src/server/account-administration.mjs';
import { LTC_BA_AA_CATALOG } from '../public/data/ltc-ba-aa-catalog.js';
import { canonicalCalculationJson } from '../public/data/calculation-core.js';
import {
  LTC_CATALOG_VERSION, LTC_CATALOG_SOURCE_SHA256, LTC_CODE_CALCULATION_MODE, assertReviewedLtcCatalog, calculateLtcCodeAmount, ltcCatalogSnapshot,
} from '../public/data/ltc-code-calculation.js';
import { ltcCatalogQuery, listLtcCatalog, previewLtcCodeCalculation, validateLtcCalculationPayload } from '../src/server/ltc-code-calculation.mjs';
const hooks = { fail }, rejects = (action, code, status) => assert.throws(action, error => error.code === code && (!status || error.status === status));
function fixture(t) {
  const db = new DatabaseSync(':memory:'); initDb(db); t.after(() => db.close()); const org = randomUUID(), user = randomUUID();
  db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(org, '合成官方清冊试算機構', now());
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(user, '合成清冊試算管理者', 'ltc-' + user + '@example.test', 'synthetic-unused-password-hash', now());
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(org, user, 'admin', null);
  const ctx = { orgId: org, user: { id: user }, role: 'admin' };
  const parent = insert(db, org, 'cases', { name: '合成個案', caseNo: 'SYN-LTC-C1', status: 'active' }), employee = insert(db, org, 'employees', { name: '合成人員', employeeNo: 'SYN-LTC-E1', status: 'active', hourlyRateCents: 11 });
  const source = (code = 'BA02', quantity = 3, options = {}) => {
    const date = options.date || '2026-10-05', start = options.start || '09:00', end = options.end || '10:30';
    const item = insert(db, org, 'service-items', { code, name: '合成原核閱名稱', minutes: 30, unitPriceCents: 7, status: 'active' });
    const extraItems = (options.extraCodes || []).map(extra => insert(db, org, 'service-items', { code: extra.code, name: '合成額外核閱項目', minutes: 30, unitPriceCents: 7, status: 'active' }));
    const services = [{ serviceItemId: item.id, quantity }, ...extraItems.map((extra, i) => ({ serviceItemId: extra.id, quantity: options.extraCodes[i].quantity || 1 }))],
      plan = insert(db, org, 'care-plans', { caseId: parent.id, validFrom: date, validTo: options.endDate || date, services, status: 'active' });
    const shift = insert(db, org, 'shifts', { caseId: parent.id, employeeId: employee.id, carePlanId: plan.id, date, startTime: start, endTime: end, ...(options.endDate ? { endDate: options.endDate } : {}), services, status: 'completed' });
    const data = { shiftId: shift.id, caseId: parent.id, employeeId: employee.id, date, actualStart: start, actualEnd: end,
      ...(options.endDate ? { actualEndDate: options.endDate } : {}), services, status: 'approved', note: '合成服務', reviewNote: '人工合成核阅' };
    data.billingSnapshot = billingSnapshot(db, org, data); return { record: insert(db, org, 'service-records', data), item };
  };
  const first = source();
  const body = (selected = first, extra = {}) => ({ catalogVersion: LTC_CATALOG_VERSION,
    source: { id: selected.record.id, version: selected.record.version },
    policy: { operation: 'official-code-quantity', serviceItemId: selected.item.id, code: selected.item.code, region: 'ordinary', paymentContext: 'standard', rounding: 'half-up',
      eligibility: { confirmed: true, sourceReference: '合成條件人工核對（非真實資格核定）' }, ...extra } });
  const state = () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    return { tables: Object.fromEntries(tables.map(name => { const statement = db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid'); statement.setReadBigInts(true); return [name, statement.all()]; })),
      schema: db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(), changes: db.prepare('SELECT total_changes() changes').get().changes };
  };
  return { db, org, user, ctx, parent, employee, source, first, body, state };
}
// Independently reviewed official price column golden values in whole NTD.
const officialPricePairs = {
  AA01: [1700, 2040], AA02: [400, 480], AA03: [600, 720], AA04: [1200, 1440], AA05: [200, 240], AA06: [200, 240], AA07: [760, 915],
  AA08: [385, 465], AA09: [770, 925], AA10: [1000, 1200], AA11: [50, 60], AA12: [1500, 1800],
  BA01: [260, 310], BA02: [195, 235], BA03: [35, 40], BA04: [130, 155], BA05: [310, 370], BA07: [325, 385], BA08: [500, 600],
  BA09: [2200, 2640], BA09a: [2500, 3000], BA10: [155, 190], BA11: [195, 235], BA12: [130, 155], BA13: [195, 235], BA14: [685, 825],
  BA15: [195, 235], BA16: [130, 155], BA17a: [75, 90], BA17b: [65, 80], BA17c: [50, 60], BA17d1: [50, 60], BA17d2: [50, 60], BA17e: [50, 60],
  BA18: [200, 240], BA20: [175, 210], BA22: [130, 160], BA23: [200, 240], BA24: [220, 265],
};

test('all 39 reviewed official BA/AA prices and effectivity dates match independent golden price columns', () => {
  assert.equal(LTC_BA_AA_CATALOG.items.length, 39); assert.equal(LTC_BA_AA_CATALOG.sourceSha256, LTC_CATALOG_SOURCE_SHA256);
  assert.deepEqual(LTC_BA_AA_CATALOG.items.map(item => item.code).sort(), Object.keys(officialPricePairs).sort());
  for (const item of LTC_BA_AA_CATALOG.items) {
    assert.deepEqual([item.ordinaryCents, item.indigenousIslandCents], officialPricePairs[item.code].map(value => value * 100));
    assert.equal(item.effectiveFrom, ['BA08', 'BA09', 'BA09a'].includes(item.code) ? '2026-01-01' : '2025-09-01');
    assert.equal(item.effectiveTo, null); assert.ok(item.conditions.length > 20); assert.ok(item.sourcePage >= 1 && item.sourcePage <= 18);
    assert.equal(item.copayExempt, item.code.startsWith('AA')); assert.equal(item.countsTowardCareQuota, item.code.startsWith('BA'));
  }
  assert.equal(assertReviewedLtcCatalog(LTC_BA_AA_CATALOG), LTC_BA_AA_CATALOG);
  assert.equal(ltcCatalogSnapshot().items.find(item => item.code === 'BA16').name, '代購或代領或代送服務');
  assert.equal(ltcCatalogSnapshot().items.find(item => item.code === 'BA17b').name, '口腔內（懸壅垂之前）分泌物抽吸');
});
test('full cross-page eligibility conditions and original policy exemptions remain present', () => {
  const item = code => LTC_BA_AA_CATALOG.items.find(item => item.code === code);
  assert.match(item('AA01').conditions, /一百五十/); assert.match(item('AA02').conditions, /申訴紀錄/);
  assert.match(item('AA03').conditions, /CC01/); assert.match(item('AA08').conditions, /AA09/); assert.match(item('AA09').conditions, /AA08/);
  assert.match(item('AA11').conditions, /獎勵機制/); assert.match(item('BA09a').conditions, /百分之三十/);
  assert.match(item('BA15').conditions, /百分之五十/); assert.match(item('BA15').conditions, /浴室/);
  assert.match(item('BA16').conditions, /五公里/); assert.match(item('BA24').conditions, /不得併計/);
});
test('pinned catalog validation rejects missing provenance, duplicates, unsafe rates and field widening', () => {
  for (const mutate of [value => delete value.sourceSha256, value => value.sourceSha256 = '0'.repeat(64), value => value.priceColumnsVisuallyReviewed = false,
    value => value.version = 'old-2017-table', value => value.items.pop(), value => value.items[1].code = value.items[0].code,
    value => value.items[0].ordinaryCents = 0.5, value => value.items[0].copayExempt = false, value => value.items[0].hidden = 'unexpected']) {
    const value = structuredClone(LTC_BA_AA_CATALOG); mutate(value); rejects(() => assertReviewedLtcCatalog(value), 'LTC_CATALOG_INVALID', 409);
  }
  assert.throws(() => { LTC_BA_AA_CATALOG.items[0].ordinaryCents = 150000; }, TypeError);
});
test('approved original quantity selects exact official region rate while original trial amount remains unchanged', t => {
  const f = fixture(t), before = f.state(); const normal = previewLtcCodeCalculation(f.db, f.ctx, f.body(), hooks);
  assert.equal(normal.mode, LTC_CODE_CALCULATION_MODE); assert.equal(normal.previewOnly, true); assert.equal(normal.eligibilityVerification, 'manual-attestation');
  assert.equal(normal.sourceConditionsVerification, 'verified-known-source-constraints'); assert.equal(normal.crossRecordLimitsVerification, 'not-verified');
  assert.equal(normal.unitPriceCents, 19500); assert.equal(normal.quantity, 3); assert.equal(normal.catalogGrossCents, 58500); assert.equal(normal.eligiblePaymentBaseCents, 58500);
  assert.equal(normal.sourceSnapshot.billingSnapshot.items[0].unitPriceCents, 7); assert.equal(normal.sourceSnapshot.billingSnapshot.items[0].amountCents, 21);
  assert.equal(normal.copayCents, null); assert.equal(normal.capUsageCents, null); assert.equal(normal.copayExempt, false); assert.equal(normal.countsTowardCareQuota, true);
  const island = previewLtcCodeCalculation(f.db, f.ctx, f.body(f.first, { region: 'indigenous-or-island' }), hooks);
  assert.equal(island.unitPriceCents, 23500); assert.equal(island.catalogGrossCents, 70500); assert.equal(island.eligiblePaymentBaseCents, 70500);
  assert.deepEqual(normal.sourceSnapshot, f.first.record); assert.deepEqual(f.state(), before);
});
test('BA15/BA16 shared-family 50 percent is explicit and preserves exact remaining individual portion', t => {
  const f = fixture(t), house = f.source('BA15'), goods = f.source('BA16'), before = f.state();
  const halfHouse = previewLtcCodeCalculation(f.db, f.ctx, f.body(house, { paymentContext: 'shared-family-50-percent' }), hooks);
  assert.deepEqual([halfHouse.catalogGrossCents, halfHouse.eligiblePaymentBaseCents, halfHouse.sharedFamilySelfPayCents], [58500, 29250, 29250]);
  assert.equal(halfHouse.copayCents, null); assert.equal(halfHouse.capUsageCents, null); assert.equal(halfHouse.caseloadReductionCents, 0);
  const halfGoods = previewLtcCodeCalculation(f.db, f.ctx, f.body(goods, { paymentContext: 'shared-family-50-percent', region: 'indigenous-or-island' }), hooks);
  assert.deepEqual([halfGoods.catalogGrossCents, halfGoods.eligiblePaymentBaseCents, halfGoods.sharedFamilySelfPayCents], [46500, 23250, 23250]);
  const standard = previewLtcCodeCalculation(f.db, f.ctx, f.body(house), hooks); assert.equal(standard.sharedFamilySelfPayCents, 0);
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(f.first, { paymentContext: 'shared-family-50-percent' }), hooks), 'LTC_PAYMENT_CONTEXT_INVALID');
  assert.deepEqual(f.state(), before);
});
test('AA exemptions are code-specific; AA01/02 caseload reduction is explicit and never billed to the individual', t => {
  const f = fixture(t), plan = f.source('AA01', 1), management = f.source('AA02', 1), evening = f.source('AA08', 1, { start: '20:00', end: '21:30' }), before = f.state();
  const ordinary = previewLtcCodeCalculation(f.db, f.ctx, f.body(plan), hooks);
  assert.deepEqual([ordinary.catalogGrossCents, ordinary.copayCents, ordinary.capUsageCents], [170000, 0, 0]);
  const reduced = previewLtcCodeCalculation(f.db, f.ctx, f.body(plan, { paymentContext: 'case-management-over-limit-90-percent' }), hooks);
  assert.deepEqual([reduced.catalogGrossCents, reduced.eligiblePaymentBaseCents, reduced.caseloadReductionCents, reduced.sharedFamilySelfPayCents], [170000, 153000, 17000, 0]);
  const region = previewLtcCodeCalculation(f.db, f.ctx, f.body(management, { paymentContext: 'case-management-over-limit-90-percent', region: 'indigenous-or-island' }), hooks);
  assert.deepEqual([region.catalogGrossCents, region.eligiblePaymentBaseCents, region.caseloadReductionCents], [48000, 43200, 4800]);
  assert.equal(previewLtcCodeCalculation(f.db, f.ctx, f.body(evening), hooks).catalogGrossCents, 38500);
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(evening, { paymentContext: 'case-management-over-limit-90-percent' }), hooks), 'LTC_PAYMENT_CONTEXT_INVALID');
  assert.deepEqual(f.state(), before);
});
test('no AA is inferred, no case/code replacement, no manual quantity/rate override or policy default', t => {
  const f = fixture(t), before = f.state();
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(f.first, { code: 'AA08' }), hooks), 'LTC_SOURCE_CODE_MISMATCH', 409);
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(f.first, { serviceItemId: randomUUID() }), hooks), 'LTC_SOURCE_CODE_MISMATCH', 409);
  for (const [key, value] of [['quantity', 9], ['unitPriceCents', 1], ['copayBasisPoints', 0], ['monthlyCapCents', 1], ['officialEligibility', true]])
    rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(f.first, { [key]: value }), hooks), 'LTC_POLICY_REQUIRED');
  for (const key of Object.keys(f.body().policy)) { const payload = f.body(); delete payload.policy[key]; rejects(() => previewLtcCodeCalculation(f.db, f.ctx, payload, hooks), 'LTC_POLICY_REQUIRED'); }
  for (const eligibility of [{ confirmed: false, sourceReference: '合成' }, { confirmed: true, sourceReference: '' }, { confirmed: true }, { confirmed: true, sourceReference: '合成', officialApproval: true }])
    rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(f.first, { eligibility }), hooks), 'LTC_POLICY_REQUIRED');
  assert.deepEqual(f.state(), before);
});
test('AA single-source quantity limits reject duplicate items and cannot be covered by manual eligibility', t => {
  const f = fixture(t);
  for (const code of Object.keys(officialPricePairs).filter(code => code.startsWith('AA'))) {
    const invalid = f.source(code, 2), duplicate = f.source(code, 1, { extraCodes: [{ code, quantity: 1 }] }), before = f.state();
    rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(invalid), hooks), 'LTC_SOURCE_CONDITION_CONFLICT', 409);
    rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(duplicate), hooks), 'LTC_SOURCE_CONDITION_CONFLICT', 409);
    assert.deepEqual(f.state(), before);
  }
});
test('BA01 two-unit morning/evening exception requires a distinct explicit approval reference and never permits three units', t => {
  const f = fixture(t), one = f.source('BA01', 1), two = f.source('BA01', 2), three = f.source('BA01', 3),
    duplicate = f.source('BA01', 1, { extraCodes: [{ code: 'BA01', quantity: 2 }] }), before = f.state();
  assert.equal(previewLtcCodeCalculation(f.db, f.ctx, f.body(one), hooks).catalogGrossCents, 26000);
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(two), hooks), 'LTC_SPECIAL_APPROVAL_REQUIRED');
  const exception = { confirmed: true, sourceReference: '合成一般資格依據', specialApprovalReference: '合成必要早晚各一組之明確核定依據' };
  assert.equal(previewLtcCodeCalculation(f.db, f.ctx, f.body(two, { eligibility: exception }), hooks).catalogGrossCents, 52000);
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(three, { eligibility: exception }), hooks), 'LTC_SOURCE_CONDITION_CONFLICT', 409);
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(duplicate, { eligibility: exception }), hooks), 'LTC_SOURCE_CONDITION_CONFLICT', 409);
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(one, { eligibility: exception }), hooks), 'LTC_SPECIAL_APPROVAL_INVALID');
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(two, { eligibility: { ...exception, specialApprovalReference: ' ' } }), hooks), 'LTC_POLICY_REQUIRED');
  assert.deepEqual(f.state(), before);
});
test('BA02 six-unit daily ceiling and known thirty-minute unit duration reject overstatement at exact boundaries', t => {
  const f = fixture(t), six = f.source('BA02', 6, { end: '12:00' }), seven = f.source('BA02', 7, { end: '12:30' }),
    short = f.source('BA02', 3, { end: '10:29' }), before = f.state();
  assert.equal(previewLtcCodeCalculation(f.db, f.ctx, f.body(six), hooks).catalogGrossCents, 117000);
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(seven), hooks), 'LTC_SOURCE_CONDITION_CONFLICT', 409);
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(short), hooks), 'LTC_SOURCE_CONDITION_CONFLICT', 409); assert.deepEqual(f.state(), before);
  for (const code of ['BA13', 'BA15', 'BA18', 'BA20']) {
    const full = f.source(code, 3), under = f.source(code, 3, { end: '10:29' }), saved = f.state();
    assert.equal(previewLtcCodeCalculation(f.db, f.ctx, f.body(full), hooks).catalogGrossCents, officialPricePairs[code][0] * 300);
    rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(under), hooks), 'LTC_SOURCE_CONDITION_CONFLICT', 409); assert.deepEqual(f.state(), saved);
  }
  const overlaid = f.source('BA13', 2, { extraCodes: [{ code: 'BA15', quantity: 2 }] }), saved = f.state();
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(overlaid), hooks), 'LTC_SOURCE_CONDITION_CONFLICT', 409); assert.deepEqual(f.state(), saved);
});
test('known incompatible codes anywhere in the same unsegmented source reject without automatic item omission', t => {
  const f = fixture(t);
  for (const [left, right] of [['AA01', 'AA02'], ['AA08', 'AA09'], ['BA01', 'BA07'], ['BA01', 'BA23'], ['BA07', 'BA23'],
    ['BA01', 'BA24'], ['BA07', 'BA24'], ['BA02', 'BA15'], ['BA18', 'BA15'], ['BA20', 'BA15'], ['BA18', 'BA20'], ['BA22', 'BA15']]) {
    const invalid = f.source(left, 1, { extraCodes: [{ code: right, quantity: 1 }] }), before = f.state();
    rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(invalid), hooks), 'LTC_SOURCE_CONDITION_CONFLICT', 409); assert.deepEqual(f.state(), before);
  }
});
test('AA08 evening and AA10 overnight source windows use occupied half-open minutes including midnight boundaries', t => {
  const f = fixture(t), afternoon = f.source('AA08', 1, { start: '19:00', end: '20:00' }), evening = f.source('AA08', 1, { start: '19:59', end: '20:01' }),
    early = f.source('AA10', 1, { start: '05:59', end: '06:00' }), after = f.source('AA10', 1, { start: '06:00', end: '07:00' }),
    midnightEnd = f.source('AA10', 1, { start: '23:00', end: '00:00', endDate: '2026-10-06' }),
    midnightOccupied = f.source('AA10', 1, { start: '23:00', end: '00:01', endDate: '2026-10-06' }), before = f.state();
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(afternoon), hooks), 'LTC_SOURCE_CONDITION_CONFLICT', 409);
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(after), hooks), 'LTC_SOURCE_CONDITION_CONFLICT', 409);
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(midnightEnd), hooks), 'LTC_SOURCE_CONDITION_CONFLICT', 409);
  assert.equal(previewLtcCodeCalculation(f.db, f.ctx, f.body(evening), hooks).catalogGrossCents, 38500);
  assert.equal(previewLtcCodeCalculation(f.db, f.ctx, f.body(early), hooks).catalogGrossCents, 100000);
  assert.equal(previewLtcCodeCalculation(f.db, f.ctx, f.body(midnightOccupied), hooks).catalogGrossCents, 100000);
  assert.deepEqual(f.state(), before);
});
test('the catalog version and actual occupied days enforce 2025/2026 per-code effective dates', t => {
  const f = fixture(t), early = f.source('BA08', 1, { date: '2025-12-31' }), effective = f.source('BA08', 1, { date: '2026-01-01' }),
    ordinaryEarly = f.source('BA02', 1, { date: '2025-08-31' }), ordinaryEffective = f.source('BA02', 1, { date: '2025-09-01' }), before = f.state();
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(early), hooks), 'LTC_CODE_NOT_EFFECTIVE', 409);
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(ordinaryEarly), hooks), 'LTC_CODE_NOT_EFFECTIVE', 409);
  assert.equal(previewLtcCodeCalculation(f.db, f.ctx, f.body(effective), hooks).catalogGrossCents, 50000);
  assert.equal(previewLtcCodeCalculation(f.db, f.ctx, f.body(ordinaryEffective), hooks).catalogGrossCents, 19500);
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, { ...f.body(), catalogVersion: '2017' }, hooks), 'LTC_CATALOG_VERSION_CONFLICT', 409); assert.deepEqual(f.state(), before);
});
test('official catalog is same-org authenticated, closed, paginated and searchable without private account data', t => {
  const f = fixture(t), before = f.state(), full = listLtcCatalog(f.db, f.ctx, ltcCatalogQuery(new URLSearchParams('pageSize=100')), hooks);
  assert.equal(full.orgId, f.org); assert.equal(full.total, 39); assert.equal(full.items.length, 39); assert.equal(full.catalog.sourceSha256, LTC_CATALOG_SOURCE_SHA256);
  assert.equal(listLtcCatalog(f.db, f.ctx, ltcCatalogQuery(new URLSearchParams('category=AA')), hooks).total, 12);
  assert.equal(listLtcCatalog(f.db, f.ctx, ltcCatalogQuery(new URLSearchParams('category=BA&pageSize=100')), hooks).total, 27);
  const selected = listLtcCatalog(f.db, f.ctx, ltcCatalogQuery(new URLSearchParams({ q: 'BA09a' })), hooks);
  assert.equal(selected.items[0].code, 'BA09a'); assert.equal(selected.total, 1);
  const last = listLtcCatalog(f.db, f.ctx, ltcCatalogQuery(new URLSearchParams('page=2&pageSize=25')), hooks); assert.equal(last.items.length, 14);
  assert.equal(JSON.stringify(full).includes('password'), false); assert.equal(JSON.stringify(full).includes(f.user), false); assert.deepEqual(f.state(), before);
});
test('four-role, cross-org, retained-membership suspension and version guards reject with zero writes', t => {
  const f = fixture(t), before = f.state();
  for (const role of ['supervisor', 'caregiver', 'unknown']) {
    rejects(() => previewLtcCodeCalculation(f.db, { ...f.ctx, role }, null, hooks), 'ROLE_FORBIDDEN', 403);
    rejects(() => listLtcCatalog(f.db, { ...f.ctx, role }, null, hooks), 'ROLE_FORBIDDEN', 403);
  }
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, { ...f.body(), source: { ...f.body().source, version: 2 } }, hooks), 'CALCULATION_VERSION_CONFLICT', 409); assert.deepEqual(f.state(), before);
  const other = randomUUID(), target = randomUUID(); f.db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(other, '合成第二機構', now());
  f.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(other, f.user, 'admin', null);
  const scoped = f.state(); rejects(() => previewLtcCodeCalculation(f.db, { ...f.ctx, orgId: other }, f.body(), hooks), 'NOT_FOUND', 404); assert.deepEqual(f.state(), scoped);
  f.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(target, '合成財務', 'ltc-finance-' + target + '@example.test', 'synthetic-unused-password-hash', now());
  f.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(f.org, target, 'finance', null); const finance = { orgId: f.org, user: { id: target }, role: 'finance' };
  assert.equal(previewLtcCodeCalculation(f.db, finance, f.body(), hooks).catalogGrossCents, 58500);
  f.db.exec('BEGIN IMMEDIATE'); try { commitAccountChange(f.db, f.ctx, target, { version: 0, role: 'finance', employeeId: null, status: 'suspended', reason: '合成停用' }); f.db.exec('COMMIT'); } catch (error) { f.db.exec('ROLLBACK'); throw error; }
  const revoked = f.state(); rejects(() => previewLtcCodeCalculation(f.db, finance, f.body(), hooks), 'ROLE_FORBIDDEN', 403); assert.deepEqual(f.state(), revoked);
});
test('catalog previews are immutable, reproducible, fully traced and do not mutate original legal or service values', t => {
  const f = fixture(t), before = f.state(), first = previewLtcCodeCalculation(f.db, f.ctx, f.body(), hooks), second = previewLtcCodeCalculation(f.db, f.ctx, f.body(), hooks);
  assert.deepEqual(first, second); assert.match(first.previewHash, /^[a-f0-9]{64}$/); assert.equal(first.trace[0].numerator, '58500'); assert.equal(first.trace[0].denominator, '1');
  assert.equal(first.catalogSnapshot.sourceUrl, LTC_BA_AA_CATALOG.sourceUrl); assert.equal(first.codeSnapshot.conditions, LTC_BA_AA_CATALOG.items.find(item => item.code === 'BA02').conditions);
  assert.throws(() => { first.sourceSnapshot.billingSnapshot.items[0].quantity = 5; }, TypeError); assert.throws(() => { first.codeSnapshot.ordinaryCents = 1; }, TypeError);
  const { previewHash: _hash, ...body } = first;
  assert.equal(canonicalCalculationJson(body), canonicalCalculationJson(calculateLtcCodeAmount({ catalogVersion: LTC_CATALOG_VERSION, source: f.first.record, policy: f.body().policy })));
  assert.deepEqual(f.state(), before);
});
test('unknown catalog code never uses a fabricated or legacy fallback price', t => {
  const f = fixture(t), unknown = f.source('BA06', 1), lower = f.source('ba02', 1), before = f.state();
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(unknown), hooks), 'LTC_CODE_NOT_FOUND', 409);
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(lower), hooks), 'LTC_CODE_NOT_FOUND', 409); assert.deepEqual(f.state(), before);
});
test('corrupt current SQL/head or stopped original approval is rejected without repairing the source', t => {
  for (const corrupt of [f => f.db.prepare('UPDATE records SET data=? WHERE id=?').run('{}', f.first.record.id),
    f => f.db.prepare('UPDATE records SET version=? WHERE id=?').run(BigInt(Number.MAX_SAFE_INTEGER) + 1n, f.first.record.id),
    f => { const data = { ...f.first.record }; for (const key of ['id', 'orgId', 'version', 'createdAt', 'updatedAt']) delete data[key]; replace(f.db, f.org, 'service-records', f.first.record, { ...data, status: 'returned' }); }]) {
    const f = fixture(t); corrupt(f); const before = f.state(); assert.throws(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(), hooks)); assert.deepEqual(f.state(), before);
  }
});
test('closed queries, bodies and nested manual attestation do not coerce values or evaluate getters', t => {
  for (const query of ['q=a&q=b', 'category=BA&category=AA', 'category=BB', 'page=01', 'pageSize=101', 'page=1%0A', 'q=' + '核'.repeat(201), 'page=9007199254740991&pageSize=100', 'manualRate=1'])
    rejects(() => ltcCatalogQuery(new URLSearchParams(query)), 'LTC_CALCULATION_INVALID');
  const f = fixture(t), before = f.state();
  for (const payload of [null, { ...f.body(), officialCatalog: LTC_BA_AA_CATALOG }, { ...f.body(), source: { ...f.body().source, orgId: f.org } }])
    rejects(() => previewLtcCodeCalculation(f.db, f.ctx, payload, hooks), 'LTC_CALCULATION_INVALID');
  let calls = 0; const request = f.body(); Object.defineProperty(request, 'policy', { enumerable: true, get() { calls++; return {}; } });
  rejects(() => validateLtcCalculationPayload(request, fail), 'LTC_CALCULATION_INVALID');
  const eligibility = { confirmed: true }; Object.defineProperty(eligibility, 'sourceReference', { enumerable: true, get() { calls++; return '合成'; } });
  rejects(() => previewLtcCodeCalculation(f.db, f.ctx, f.body(f.first, { eligibility }), hooks), 'LTC_POLICY_REQUIRED');
  const root = { catalogVersion: LTC_CATALOG_VERSION, source: f.first.record, policy: f.body().policy }; Object.defineProperty(root, 'source', { enumerable: true, get() { calls++; return f.first.record; } });
  rejects(() => calculateLtcCodeAmount(root), 'LTC_POLICY_REQUIRED'); assert.equal(calls, 0); assert.deepEqual(f.state(), before);
});
