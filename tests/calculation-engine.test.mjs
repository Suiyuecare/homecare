import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { initDb, insert, replace, decode, business, billingSnapshot, fail, now } from '../src/server/model.mjs';
import { seedDemo } from '../src/server/demo.mjs';
import { commitAccountChange } from '../src/server/account-administration.mjs';
import {
  CALCULATION_MODE, exactCentsOperation, allocatePricingCents, assertCalculationSource, calculateConfiguredAmount, canonicalCalculationJson,
} from '../public/data/calculation-core.js';
import {
  guardCalculationAccess, calculationPreviewQuery, calculationCandidateQuery, listCalculationCandidates, previewCalculation,
  readApprovedCalculationRule, readApprovedCalculationSource, validateCalculationPayload,
} from '../src/server/calculation-engine.mjs';

const hooks = { fail }, rejects = (call, code, status) => assert.throws(call, error => error.code === code && (!status || error.status === status));
function fixture(t, { approvedSource = true } = {}) {
  const db = new DatabaseSync(':memory:'); initDb(db); t.after(() => db.close());
  const org = randomUUID(), user = randomUUID();
  db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(org, '合成明確試算機構', now());
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(user, '合成試算管理者', 'calc-' + user + '@example.test', 'synthetic-unused-password-hash', now());
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(org, user, 'admin', null);
  const ctx = { orgId: org, user: { id: user }, role: 'admin' };
  const parent = insert(db, org, 'cases', { name: '合成個案甲', caseNo: 'SYN-CALC-C1', status: 'active' });
  const employee = insert(db, org, 'employees', { name: '合成人員甲', employeeNo: 'SYN-CALC-E1', status: 'active', hourlyRateCents: 123 });
  const item = insert(db, org, 'service-items', { name: '合成服務甲', code: 'SYN-CALC-S1', minutes: 30, unitPriceCents: 7, status: 'active' });
  const services = [{ serviceItemId: item.id, quantity: 3 }];
  const source = (options = {}) => {
    const date = options.date || '2026-10-05', start = options.start || '09:00', end = options.end || '10:01';
    const plan = insert(db, org, 'care-plans', { caseId: parent.id, validFrom: date, validTo: options.endDate || date, services, status: 'active' });
    const shift = insert(db, org, 'shifts', { caseId: parent.id, employeeId: employee.id, carePlanId: plan.id, date,
      startTime: start, endTime: end, ...(options.endDate ? { endDate: options.endDate } : {}), services, status: 'completed' });
    const data = { shiftId: shift.id, caseId: parent.id, employeeId: employee.id, date, actualStart: start, actualEnd: end,
      ...(options.endDate ? { actualEndDate: options.endDate } : {}), services, status: 'approved', note: ' 原始合成\r\n服務 ', reviewNote: ' 合成核阅 ' };
    data.billingSnapshot = billingSnapshot(db, org, data);
    return insert(db, org, 'service-records', data);
  };
  const rule = (kind = 'pricing', extra = {}) => insert(db, org, 'business-rules', {
    kind, code: 'SYN-CALC-' + kind, name: '合成核定規則（非正式費率）', validFrom: '2026-10-01', validTo: '2026-10-31',
    sourceReference: '人工核定合成測試：所有數字僅供測試', parameters: kind === 'pricing'
      ? { unitPriceCents: 101, copayBasisPoints: 2000, monthlyCapCents: 250 }
      : { baseCents: 1001, shareBasisPoints: 5000 }, status: 'approved', note: '合成測試', ...extra,
  });
  const first = approvedSource ? source() : null, pricing = rule(), payroll = rule('payroll');
  const body = (selected = pricing, policy = { operation: 'quantity-rate', rateParameter: 'unitPriceCents', serviceItemId: item.id }, selectedSource = first) => ({
    rule: { id: selected.id, version: selected.version }, source: { id: selectedSource.id, version: selectedSource.version }, policy,
  });
  const state = () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    return { tables: Object.fromEntries(tables.map(name => { const statement = db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid'); statement.setReadBigInts(true); return [name, statement.all()]; })),
      schema: db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(), changes: db.prepare('SELECT total_changes() changes').get().changes };
  };
  return { db, org, user, ctx, parent, employee, item, source, rule, first, pricing, payroll, body, state };
}
function seededSource(f, ctx = f.ctx) {
  assert.equal(seedDemo(f.db, ctx).seeded, true);
  const row = f.db.prepare("SELECT * FROM records WHERE org_id=? AND entity='service-records' AND json_extract(data,'$.billingSnapshot.source')='synthetic-demo'").get(ctx.orgId);
  assert(row, 'Actual seedDemo must create the recognized non-approval service snapshot');
  return decode(row);
}

test('golden exact integer arithmetic is manually derived for flat, quantity, hourly and shares', () => {
  const rows = [
    [{ operation: 'flat', amountCents: 101 }, 101, '101', '1', '0'],
    [{ operation: 'quantity-rate', quantity: 3, rateCents: 101 }, 303, '303', '1', '0'],
    [{ operation: 'minutes-hourly', minutes: 61, hourlyRateCents: 1001, rounding: 'floor' }, 1017, '61061', '60', '41'],
    [{ operation: 'minutes-hourly', minutes: 61, hourlyRateCents: 1001, rounding: 'ceiling' }, 1018, '61061', '60', '41'],
    [{ operation: 'minutes-hourly', minutes: 61, hourlyRateCents: 1001, rounding: 'half-up' }, 1018, '61061', '60', '41'],
    [{ operation: 'basis-points', amountCents: 101, basisPoints: 5000, rounding: 'half-up' }, 51, '505000', '10000', '5000'],
    [{ operation: 'basis-points', amountCents: 101, basisPoints: 5000, rounding: 'half-even' }, 50, '505000', '10000', '5000'],
  ];
  for (const [input, expected, numerator, denominator, remainder] of rows) {
    const trace = exactCentsOperation(input); assert.equal(trace.resultCents, expected); assert.equal(trace.numerator, numerator);
    assert.equal(trace.denominator, denominator); assert.equal(trace.remainderNumerator, remainder); assert.ok(Object.isFrozen(trace));
  }
});
test('one-cent boundaries require explicit rounding and keep half-even parity', () => {
  assert.equal(exactCentsOperation({ operation: 'minutes-hourly', minutes: 3, hourlyRateCents: 10, rounding: 'half-up' }).resultCents, 1);
  assert.equal(exactCentsOperation({ operation: 'minutes-hourly', minutes: 3, hourlyRateCents: 10, rounding: 'half-even' }).resultCents, 0);
  assert.equal(exactCentsOperation({ operation: 'minutes-hourly', minutes: 9, hourlyRateCents: 10, rounding: 'half-even' }).resultCents, 2);
  assert.equal(exactCentsOperation({ operation: 'basis-points', amountCents: 1, basisPoints: 4999, rounding: 'half-up' }).resultCents, 0);
  assert.equal(exactCentsOperation({ operation: 'basis-points', amountCents: 1, basisPoints: 5000, rounding: 'half-up' }).resultCents, 1);
  for (const input of [null, { operation: 'minutes-hourly', minutes: 1, hourlyRateCents: 1 }, { operation: 'basis-points', amountCents: 1, basisPoints: 2000 },
    { operation: 'basis-points', amountCents: 1, basisPoints: 2000, rounding: 'automatic' }, { operation: 'flat', amountCents: 1, rounding: 'floor' }])
    assert.throws(() => exactCentsOperation(input));
});
test('BigInt intermediates protect MAX_SAFE integer boundary without floats or coercion', () => {
  assert.equal(exactCentsOperation({ operation: 'quantity-rate', quantity: Number.MAX_SAFE_INTEGER, rateCents: 1 }).resultCents, Number.MAX_SAFE_INTEGER);
  const split = exactCentsOperation({ operation: 'basis-points', amountCents: Number.MAX_SAFE_INTEGER, basisPoints: 10000, rounding: 'half-even' });
  assert.equal(split.numerator, '90071992547409910000'); assert.equal(split.resultCents, Number.MAX_SAFE_INTEGER);
  rejects(() => exactCentsOperation({ operation: 'quantity-rate', quantity: Number.MAX_SAFE_INTEGER, rateCents: 2 }), 'CALCULATION_OVERFLOW');
  rejects(() => exactCentsOperation({ operation: 'minutes-hourly', minutes: Number.MAX_SAFE_INTEGER, hourlyRateCents: Number.MAX_SAFE_INTEGER, rounding: 'floor' }), 'CALCULATION_OVERFLOW');
  for (const value of [-0, -1, 0.1, '1', Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    rejects(() => exactCentsOperation({ operation: 'flat', amountCents: value }), 'CALCULATION_UNSAFE_INTEGER');
  rejects(() => exactCentsOperation({ operation: 'basis-points', amountCents: 1, basisPoints: 10001, rounding: 'floor' }), 'CALCULATION_UNSAFE_INTEGER');
});
test('two distinct cap meanings have explicit copay, excess and exact sum with no monthly defaults', () => {
  const input = { grossCents: 303, capCents: 250, consumedCents: 100, copayBasisPoints: 2000, capMeaning: 'eligible-gross-ceiling', rounding: 'half-up' };
  const gross = allocatePricingCents(input);
  assert.deepEqual([gross.eligibleCents, gross.copayCents, gross.subsidyCents, gross.excessCents, gross.payableCents, gross.capUsageCents, gross.consumedAfterCents], [150, 30, 120, 153, 183, 150, 250]);
  const subsidy = allocatePricingCents({ ...input, capMeaning: 'subsidy-ceiling' });
  assert.deepEqual([subsidy.eligibleCents, subsidy.copayCents, subsidy.subsidyCents, subsidy.excessCents, subsidy.payableCents, subsidy.capUsageCents, subsidy.consumedAfterCents], [303, 61, 150, 92, 153, 150, 250]);
  for (const allocation of [gross, subsidy]) assert.equal(allocation.payableCents + allocation.subsidyCents, 303);
  for (const capMeaning of ['eligible-gross-ceiling', 'subsidy-ceiling']) {
    const zero = allocatePricingCents({ ...input, capMeaning, capCents: 0, consumedCents: 0 }); assert.equal(zero.subsidyCents, 0); assert.equal(zero.payableCents, 303);
    const exhausted = allocatePricingCents({ ...input, capMeaning, consumedCents: 251 }); assert.equal(exhausted.subsidyCents, 0); assert.equal(exhausted.capUsageCents, 0); assert.equal(exhausted.consumedAfterCents, 251);
    const one = allocatePricingCents({ grossCents: 1, capCents: 1, consumedCents: 0, copayBasisPoints: 5000, capMeaning, rounding: 'half-even' }); assert.equal(one.payableCents, 0); assert.equal(one.subsidyCents, 1);
  }
  for (const key of Object.keys(input)) { const missing = { ...input }; delete missing[key]; rejects(() => allocatePricingCents(missing), 'CALCULATION_ALLOCATION_REQUIRED'); }
  rejects(() => allocatePricingCents({ ...input, unexpected: true }), 'CALCULATION_ALLOCATION_REQUIRED');
});
test('approved rule/source preview is reproducible and immutable and never replaces original trial snapshot', t => {
  const f = fixture(t), before = f.state(); const preview = previewCalculation(f.db, f.ctx, f.body(), hooks);
  assert.equal(preview.mode, CALCULATION_MODE); assert.equal(preview.previewOnly, true); assert.equal(preview.amountCents, 303);
  assert.equal(preview.sourceSnapshot.billingSnapshot.items[0].unitPriceCents, 7); assert.equal(preview.sourceSnapshot.billingSnapshot.items[0].amountCents, 21);
  assert.equal(preview.ruleSnapshot.parameters.unitPriceCents, 101); assert.equal(preview.ruleSnapshot.sourceReference, f.pricing.sourceReference);
  assert.deepEqual(preview.sourceSnapshot, f.first); assert.deepEqual(preview.ruleSnapshot, f.pricing);
  assert.match(preview.previewHash, /^[a-f0-9]{64}$/); assert.deepEqual(previewCalculation(f.db, f.ctx, f.body(), hooks), preview);
  assert.equal(canonicalCalculationJson(preview), canonicalCalculationJson({ ...preview, policySnapshot: { serviceItemId: f.item.id, rateParameter: 'unitPriceCents', operation: 'quantity-rate' } }));
  assert.throws(() => { preview.sourceSnapshot.billingSnapshot.items[0].amountCents = 999; }, TypeError);
  assert.throws(() => { preview.policySnapshot.rateParameter = 'other'; }, TypeError);
  assert.deepEqual(f.state(), before);
});
test('payroll chooses fixed amount, hourly interpretation or basis-share explicitly without insurance/tax defaults', t => {
  const f = fixture(t), before = f.state();
  const policies = [[{ operation: 'flat', amountParameter: 'baseCents' }, 1001],
    [{ operation: 'minutes-hourly', rateParameter: 'baseCents', rounding: 'half-up' }, 1018],
    [{ operation: 'basis-points', amountParameter: 'baseCents', ratioParameter: 'shareBasisPoints', rounding: 'half-even' }, 500]];
  for (const [policy, expected] of policies) {
    const preview = previewCalculation(f.db, f.ctx, f.body(f.payroll, policy), hooks); assert.equal(preview.amountCents, expected); assert.equal(preview.allocation, null);
    assert.deepEqual(Object.keys(preview).sort(), ['allocation', 'amountCents', 'currency', 'mode', 'policySnapshot', 'previewHash', 'previewOnly', 'ruleSnapshot', 'sourceSnapshot', 'trace']);
  }
  for (const policy of [{ operation: 'minutes-hourly', rateParameter: 'baseCents' }, { operation: 'flat' },
    { operation: 'basis-points', amountParameter: 'baseCents', ratioParameter: 'unknown', rounding: 'floor' }])
    rejects(() => previewCalculation(f.db, f.ctx, f.body(f.payroll, policy), hooks), 'CALCULATION_POLICY_REQUIRED');
  assert.deepEqual(f.state(), before);
});
test('allocation preview manual basis-points must match selected approved rule and consumed cap is never saved', t => {
  const f = fixture(t), before = f.state(), policy = { ...f.body().policy, allocation: { capMeaning: 'eligible-gross-ceiling', consumedCents: 100, capParameter: 'monthlyCapCents', copayBasisPoints: 2000, rounding: 'half-up' } };
  assert.equal(previewCalculation(f.db, f.ctx, f.body(f.pricing, policy), hooks).allocation.payableCents, 183);
  rejects(() => previewCalculation(f.db, f.ctx, f.body(f.pricing, { ...policy, allocation: { ...policy.allocation, copayBasisPoints: 1999 } }), hooks), 'CALCULATION_COPAY_MISMATCH');
  for (const key of Object.keys(policy.allocation)) {
    const allocation = { ...policy.allocation }; delete allocation[key];
    rejects(() => previewCalculation(f.db, f.ctx, f.body(f.pricing, { ...policy, allocation }), hooks), 'CALCULATION_ALLOCATION_REQUIRED');
  }
  assert.deepEqual(f.state(), before);
});
test('current memberships authorize only admin and finance before malformed input; revocation causes zero writes', t => {
  const f = fixture(t), original = f.state();
  for (const role of ['supervisor', 'caregiver', 'unknown']) {
    rejects(() => previewCalculation(f.db, { ...f.ctx, role }, null, hooks), 'ROLE_FORBIDDEN', 403);
    rejects(() => listCalculationCandidates(f.db, { ...f.ctx, role }, null, hooks), 'ROLE_FORBIDDEN', 403);
  }
  assert.deepEqual(f.state(), original);
  f.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('finance', f.org, f.user);
  const before = f.state(); rejects(() => previewCalculation(f.db, f.ctx, f.body(), hooks), 'ROLE_FORBIDDEN', 403);
  assert.equal(previewCalculation(f.db, { ...f.ctx, role: 'finance' }, f.body(), hooks).amountCents, 303); assert.deepEqual(f.state(), before);
  f.db.prepare('DELETE FROM memberships WHERE org_id=? AND user_id=?').run(f.org, f.user);
  const revoked = f.state(); rejects(() => guardCalculationAccess(f.db, { ...f.ctx, role: 'finance' }, fail), 'ROLE_FORBIDDEN', 403); assert.deepEqual(f.state(), revoked);
});
test('wrong org selections, missing versions and stale source/rule versions fail with no reads disclosed or writes', t => {
  const f = fixture(t), org2 = randomUUID(); f.db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(org2, '合成另一機構', now());
  f.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(org2, f.user, 'admin', null);
  const foreign = { ...f.ctx, orgId: org2 }, before = f.state();
  rejects(() => previewCalculation(f.db, foreign, f.body(), hooks), 'NOT_FOUND', 404);
  assert.equal(listCalculationCandidates(f.db, foreign, calculationCandidateQuery(new URLSearchParams()), hooks).rules.total, 0);
  assert.equal(listCalculationCandidates(f.db, foreign, calculationCandidateQuery(new URLSearchParams()), hooks).sources.total, 0);
  for (const key of ['rule', 'source']) {
    const body = f.body(); body[key].version++;
    rejects(() => previewCalculation(f.db, f.ctx, body, hooks), 'CALCULATION_VERSION_CONFLICT', 409);
    delete body[key].version; rejects(() => previewCalculation(f.db, f.ctx, body, hooks), 'CALCULATION_INVALID', 422);
  }
  assert.deepEqual(f.state(), before);
});
test('suspended finance lifecycle is enforced even when its original membership row remains present', t => {
  const f = fixture(t), target = randomUUID();
  f.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(target, '合成待停用財務', 'calc-finance-' + target + '@example.test', 'synthetic-unused-password-hash', now());
  f.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(f.org, target, 'finance', null);
  const targetContext = { orgId: f.org, role: 'finance', user: { id: target } };
  assert.equal(previewCalculation(f.db, targetContext, f.body(), hooks).amountCents, 303);
  f.db.exec('BEGIN IMMEDIATE');
  try { commitAccountChange(f.db, f.ctx, target, { version: 0, role: 'finance', employeeId: null, status: 'suspended', reason: '合成停用測試' }); f.db.exec('COMMIT'); }
  catch (error) { f.db.exec('ROLLBACK'); throw error; }
  assert.equal(f.db.prepare('SELECT role FROM memberships WHERE org_id=? AND user_id=?').get(f.org, target).role, 'finance');
  const before = f.state(); rejects(() => previewCalculation(f.db, targetContext, f.body(), hooks), 'ROLE_FORBIDDEN', 403);
  rejects(() => listCalculationCandidates(f.db, targetContext, calculationCandidateQuery(new URLSearchParams()), hooks), 'ROLE_FORBIDDEN', 403); assert.deepEqual(f.state(), before);
});
test('rule is approved and effective over full occupied source days; ending exactly midnight does not add next day', t => {
  const f = fixture(t), tests = [f.rule('pricing', { status: 'draft' }), f.rule('pricing', { status: 'inactive' }),
    f.rule('pricing', { validFrom: '2026-10-06' }), f.rule('pricing', { validTo: '2026-10-04' })];
  const before = f.state();
  for (const rule of tests) rejects(() => previewCalculation(f.db, f.ctx, f.body(rule), hooks), ['draft', 'inactive'].includes(rule.status) ? 'CALCULATION_RULE_NOT_APPROVED' : 'CALCULATION_RULE_NOT_EFFECTIVE', 409);
  assert.deepEqual(f.state(), before);
  const overnight = f.source({ date: '2026-10-31', start: '23:30', end: '00:30', endDate: '2026-11-01' });
  const midnight = f.source({ date: '2026-10-31', start: '23:30', end: '00:00', endDate: '2026-11-01' });
  const saved = f.state(); rejects(() => previewCalculation(f.db, f.ctx, f.body(f.pricing, undefined, overnight), hooks), 'CALCULATION_RULE_NOT_EFFECTIVE', 409);
  assert.equal(previewCalculation(f.db, f.ctx, f.body(f.pricing, undefined, midnight), hooks).amountCents, 303); assert.deepEqual(f.state(), saved);
});
test('late rule/source changes use version conflicts and an inactive rule never falls back to current service prices', t => {
  const f = fixture(t), old = f.body(); const data = { ...f.pricing }; for (const key of ['id', 'orgId', 'version', 'createdAt', 'updatedAt']) delete data[key];
  replace(f.db, f.org, 'business-rules', f.pricing, { ...data, status: 'inactive' });
  const before = f.state(); rejects(() => previewCalculation(f.db, f.ctx, old, hooks), 'CALCULATION_VERSION_CONFLICT', 409);
  rejects(() => previewCalculation(f.db, f.ctx, { ...old, rule: { ...old.rule, version: 2 } }, hooks), 'CALCULATION_RULE_NOT_APPROVED', 409); assert.deepEqual(f.state(), before);
});
test('missing policy/item, unknown fields, unsafe nested numbers and accessors are rejected without getter evaluation or writes', t => {
  const f = fixture(t), before = f.state();
  for (const body of [null, { ...f.body(), hidden: 'do not accept' }, { ...f.body(), rule: { ...f.body().rule, status: 'approved' } },
    { ...f.body(), source: { ...f.body().source, amountCents: 1 } }, { rule: f.body().rule, source: f.body().source }, { ...f.body(), policy: {} },
    { ...f.body(), policy: { ...f.body().policy, amountCents: 1 } }]) assert.throws(() => previewCalculation(f.db, f.ctx, body, hooks));
  rejects(() => previewCalculation(f.db, f.ctx, { ...f.body(), policy: { ...f.body().policy, serviceItemId: randomUUID() } }, hooks), 'CALCULATION_ITEM_NOT_FOUND', 409);
  let calls = 0;
  const body = { ...f.body() }; Object.defineProperty(body, 'policy', { enumerable: true, get() { calls++; return {}; } });
  rejects(() => validateCalculationPayload(body, fail), 'CALCULATION_INVALID');
  const policy = { ...f.body().policy }; Object.defineProperty(policy, 'rateParameter', { enumerable: true, get() { calls++; return 'unitPriceCents'; } });
  rejects(() => previewCalculation(f.db, f.ctx, { ...f.body(), policy }, hooks), 'CALCULATION_INVALID');
  const calculation = { rule: f.pricing, source: f.first, policy: f.body().policy };
  Object.defineProperty(calculation, 'rule', { enumerable: true, get() { calls++; return f.pricing; } });
  rejects(() => calculateConfiguredAmount(calculation), 'CALCULATION_POLICY_REQUIRED');
  const allocation = { grossCents: 1, capCents: 1, consumedCents: 0, copayBasisPoints: 0, capMeaning: 'subsidy-ceiling', rounding: 'floor' };
  Object.defineProperty(allocation, 'rounding', { enumerable: true, get() { calls++; return 'floor'; } }); rejects(() => allocatePricingCents(allocation), 'CALCULATION_ALLOCATION_REQUIRED');
  assert.equal(calls, 0); assert.deepEqual(f.state(), before);
});
test('approved candidates are fixed projections, paginated/searchable and never disclose user binding or unapproved inputs', t => {
  const f = fixture(t); f.rule('pricing', { status: 'draft', name: '不列出未核定' }); f.rule('attendance', { parameters: { graceMinutes: 1, roundingMinutes: 1 }, name: '不列出差勤' });
  const before = f.state(), query = calculationCandidateQuery(new URLSearchParams()), output = listCalculationCandidates(f.db, f.ctx, query, hooks);
  assert.equal(output.rules.total, 2); assert.equal(output.sources.total, 1); assert.ok(Object.isFrozen(output.sources.items[0].items));
  assert.equal(output.orgId, f.org); assert.equal(output.rules.items[0].orgId, f.org); assert.equal(output.sources.items[0].orgId, f.org);
  assert.deepEqual(Object.keys(output.rules.items[0]).sort(), ['code', 'id', 'kind', 'name', 'orgId', 'parameters', 'sourceReference', 'validFrom', 'validTo', 'version']);
  assert.deepEqual(Object.keys(output.sources.items[0]).sort(), ['caseId', 'date', 'employeeId', 'id', 'items', 'label', 'orgId', 'serviceMinutes', 'version']);
  assert.deepEqual(Object.keys(output.sources.items[0].items[0]).sort(), ['code', 'name', 'quantity', 'serviceItemId']);
  assert.equal(output.sources.items[0].label, '合成個案甲 · 合成人員甲');
  assert.equal(JSON.stringify(output).includes('password'), false); assert.equal(JSON.stringify(output).includes(f.user), false);
  const page = listCalculationCandidates(f.db, f.ctx, calculationCandidateQuery(new URLSearchParams('rulePage=2&pageSize=1')), hooks);
  assert.equal(page.rules.items.length, 1); assert.equal(page.rules.total, 2); assert.equal(page.rules.page, 2);
  const filtered = listCalculationCandidates(f.db, f.ctx, calculationCandidateQuery(new URLSearchParams({ q: 'SYN-CALC-S1' })), hooks);
  assert.equal(filtered.sources.total, 1); assert.equal(filtered.rules.total, 0);
  assert.deepEqual(f.state(), before);
});
test('all candidate/preview query fields are closed and canonical without duplicate, coercion or unsafe offsets', () => {
  assert.deepEqual(calculationPreviewQuery(new URLSearchParams()), {});
  for (const query of ['q=a', 'sourcePage=1']) rejects(() => calculationPreviewQuery(new URLSearchParams(query)), 'CALCULATION_INVALID');
  for (const query of ['rulePage=1&rulePage=2', 'hidden=x', 'rulePage=01', 'sourcePage=1e0', 'pageSize=101', 'pageSize=1%0A', 'q=' + '核'.repeat(201), 'q=a&q=b', 'rulePage=9007199254740991&pageSize=100'])
    rejects(() => calculationCandidateQuery(new URLSearchParams(query)), 'CALCULATION_INVALID');
});
test('raw SQL, UTF-8, immutablehead and orphan parent corruption fail closed with complete database zero-write proof', t => {
  const corruptions = [
    f => f.db.prepare('UPDATE records SET data=? WHERE id=?').run('{', f.first.id),
    f => f.db.prepare('UPDATE records SET version=? WHERE id=?').run(BigInt(Number.MAX_SAFE_INTEGER) + 1n, f.pricing.id),
    f => f.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...f.first, id: 'spoofed' }), f.first.id),
    f => f.db.prepare('UPDATE records SET data=CAST(? AS TEXT) WHERE id=?').run(Buffer.from([0xff]), f.pricing.id),
    f => f.db.prepare('UPDATE records SET data=? WHERE id=?').run('{}', f.pricing.id),
    f => f.db.prepare('UPDATE records SET entity=? WHERE id=?').run('synthetic-orphan', f.first.shiftId),
    f => f.db.prepare('UPDATE records SET entity=? WHERE id=?').run('synthetic-orphan', f.parent.id),
    f => f.db.prepare('UPDATE records SET entity=? WHERE id=?').run('synthetic-orphan', f.employee.id),
  ];
  for (const corrupt of corruptions) {
    const f = fixture(t); corrupt(f); const before = f.state();
    rejects(() => previewCalculation(f.db, f.ctx, f.body(), hooks), 'CALCULATION_STORED_INVALID', 409);
    assert.throws(() => listCalculationCandidates(f.db, f.ctx, calculationCandidateQuery(new URLSearchParams()), hooks)); assert.deepEqual(f.state(), before);
  }
});
test('standalone approved-rule/source readers enforce current permission and exact requested version without modification', t => {
  const f = fixture(t), before = f.state();
  assert.deepEqual(readApprovedCalculationRule(f.db, f.ctx, f.body().rule, hooks), f.pricing);
  assert.deepEqual(readApprovedCalculationSource(f.db, f.ctx, f.body().source, hooks), f.first);
  rejects(() => readApprovedCalculationRule(f.db, f.ctx, { ...f.body().rule, version: 2 }, hooks), 'CALCULATION_VERSION_CONFLICT', 409);
  rejects(() => readApprovedCalculationSource(f.db, f.ctx, { ...f.body().source, hidden: true }, hooks), 'CALCULATION_INVALID', 422);
  assert.deepEqual(f.state(), before);
});
test('actual seeded demo-only organization has zero eligible sources and no candidate reads write any SQL state', t => {
  const f = fixture(t, { approvedSource: false }), demo = seededSource(f), before = f.state();
  const output = listCalculationCandidates(f.db, f.ctx, calculationCandidateQuery(new URLSearchParams()), hooks);
  assert.equal(output.sources.total, 0); assert.deepEqual(output.sources.items, []); assert.equal(output.rules.total, 2);
  rejects(() => readApprovedCalculationSource(f.db, f.ctx, { id: demo.id, version: demo.version }, hooks), 'CALCULATION_SOURCE_INVALID', 409);
  rejects(() => previewCalculation(f.db, f.ctx, f.body(f.payroll, { operation: 'flat', amountParameter: 'baseCents' }, demo), hooks), 'CALCULATION_SOURCE_INVALID', 409);
  assert.deepEqual(f.state(), before);
});
test('actual seeded demo and real approval coexist without hiding real eligible sources or admitting demo previews', t => {
  const f = fixture(t), demo = seededSource(f), before = f.state();
  const output = listCalculationCandidates(f.db, f.ctx, calculationCandidateQuery(new URLSearchParams()), hooks);
  assert.equal(output.sources.total, 1); assert.equal(output.sources.items[0].id, f.first.id); assert.equal(output.sources.items.some(item => item.id === demo.id), false);
  const search = listCalculationCandidates(f.db, f.ctx, calculationCandidateQuery(new URLSearchParams('q=TEST-CARE-01')), hooks);
  assert.equal(search.sources.total, 0);
  assert.equal(previewCalculation(f.db, f.ctx, f.body(), hooks).amountCents, 303);
  rejects(() => readApprovedCalculationSource(f.db, f.ctx, { id: demo.id, version: demo.version }, hooks), 'CALCULATION_SOURCE_INVALID', 409);
  assert.deepEqual(f.state(), before);
});
test('recognized demo classification still validates complete snapshots, exact arithmetic, immutable heads and completed same-org parents', t => {
  const corruptions = [
    ['unknown snapshot source', 'CALCULATION_SOURCE_INVALID', (f, demo) => replace(f.db, f.org, 'service-records', demo, { ...business(demo), billingSnapshot: { ...demo.billingSnapshot, source: 'synthetic-demo-unknown' } })],
    ['unknown eighth snapshot field', 'CALCULATION_SOURCE_INVALID', (f, demo) => replace(f.db, f.org, 'service-records', demo, { ...business(demo), billingSnapshot: { ...demo.billingSnapshot, spanMode: 'calendar-two-day-v1' } })],
    ['inconsistent quantity and exact amount', 'CALCULATION_SOURCE_INVALID', (f, demo) => replace(f.db, f.org, 'service-records', demo, { ...business(demo), billingSnapshot: { ...demo.billingSnapshot, items: [{ ...demo.billingSnapshot.items[0], amountCents: demo.billingSnapshot.items[0].amountCents + 1 }] } })],
    ['inconsistent original service minutes', 'CALCULATION_SOURCE_INVALID', (f, demo) => replace(f.db, f.org, 'service-records', demo, { ...business(demo), billingSnapshot: { ...demo.billingSnapshot, serviceMinutes: demo.billingSnapshot.serviceMinutes + 1 } })],
    ['employee snapshot identity mismatch', 'CALCULATION_SOURCE_INVALID', (f, demo) => replace(f.db, f.org, 'service-records', demo, { ...business(demo), billingSnapshot: { ...demo.billingSnapshot, employee: { ...demo.billingSnapshot.employee, id: f.employee.id } } })],
    ['unsafe amount', 'CALCULATION_SOURCE_INVALID', (f, demo) => replace(f.db, f.org, 'service-records', demo, { ...business(demo), billingSnapshot: { ...demo.billingSnapshot, items: [{ ...demo.billingSnapshot.items[0], amountCents: Number.MAX_SAFE_INTEGER + 1 }] } })],
    ['current source head drift', 'CALCULATION_STORED_INVALID', (f, demo) => f.db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify({ ...business(demo), note: 'synthetic changed without new head' }), demo.id)],
    ['missing source head', 'CALCULATION_STORED_INVALID', (f, demo) => f.db.prepare('UPDATE records SET version=version+1 WHERE id=?').run(demo.id)],
    ['current parent head drift', 'CALCULATION_STORED_INVALID', (f, demo) => f.db.prepare('UPDATE records SET data=? WHERE id=?').run('{}', demo.caseId)],
    ['orphan employee', 'CALCULATION_STORED_INVALID', (f, demo) => f.db.prepare('UPDATE records SET entity=? WHERE id=?').run('synthetic-orphan', demo.employeeId)],
    ['unfinished source shift', 'CALCULATION_STORED_INVALID', (f, demo) => { const shift = decode(f.db.prepare('SELECT * FROM records WHERE id=?').get(demo.shiftId)); replace(f.db, f.org, 'shifts', shift, { ...business(shift), status: 'scheduled' }); }],
    ['wrong linked case', 'CALCULATION_STORED_INVALID', (f, demo) => { const shift = decode(f.db.prepare('SELECT * FROM records WHERE id=?').get(demo.shiftId)); replace(f.db, f.org, 'shifts', shift, { ...business(shift), caseId: f.parent.id }); }],
  ];
  for (const [label, code, corrupt] of corruptions) {
    const f = fixture(t), demo = seededSource(f); corrupt(f, demo); const before = f.state();
    assert.throws(() => listCalculationCandidates(f.db, f.ctx, calculationCandidateQuery(new URLSearchParams()), hooks), error => error.status === 409 && error.code === code, label);
    assert.deepEqual(f.state(), before, label + ' must perform zero writes');
  }
});
test('demo compatibility preserves current role authorization and isolates foreign malformed demos before candidate selection', t => {
  const f = fixture(t), demo = seededSource(f), foreign = randomUUID();
  f.db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(foreign, '合成另一示範機構', now());
  f.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(foreign, f.user, 'admin', null);
  const foreignContext = { ...f.ctx, orgId: foreign }, foreignDemo = seededSource(f, foreignContext);
  replace(f.db, foreign, 'service-records', foreignDemo, { ...business(foreignDemo), billingSnapshot: { ...foreignDemo.billingSnapshot, source: 'unknown-demo' } });
  const before = f.state(), query = calculationCandidateQuery(new URLSearchParams());
  assert.equal(listCalculationCandidates(f.db, f.ctx, query, hooks).sources.items[0].id, f.first.id);
  for (const ctx of [null, { ...f.ctx, role: 'supervisor' }, { ...f.ctx, role: 'caregiver' }, { ...f.ctx, role: 'finance' }])
    rejects(() => listCalculationCandidates(f.db, ctx, null, hooks), 'ROLE_FORBIDDEN', 403);
  rejects(() => readApprovedCalculationSource(f.db, foreignContext, { id: demo.id, version: demo.version }, hooks), 'NOT_FOUND', 404);
  rejects(() => listCalculationCandidates(f.db, foreignContext, query, hooks), 'CALCULATION_SOURCE_INVALID', 409);
  assert.deepEqual(f.state(), before);
  f.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('finance', f.org, f.user);
  const financeState = f.state(); assert.equal(listCalculationCandidates(f.db, { ...f.ctx, role: 'finance' }, query, hooks).sources.total, 1);
  rejects(() => listCalculationCandidates(f.db, f.ctx, query, hooks), 'ROLE_FORBIDDEN', 403); assert.deepEqual(f.state(), financeState);
});
test('maximum 2879-minute explicit calendar source retains the seven-field approval snapshot and exact hourly preview beside demo data', t => {
  const f = fixture(t), extended = f.source({ date: '2026-10-05', start: '00:00', end: '23:59', endDate: '2026-10-06' });
  const hourly = f.rule('payroll', { parameters: { baseCents: 60, shareBasisPoints: 5000 } }); seededSource(f);
  const before = f.state(), preview = previewCalculation(f.db, f.ctx, f.body(hourly, { operation: 'minutes-hourly', rateParameter: 'baseCents', rounding: 'floor' }, extended), hooks);
  assert.equal(preview.amountCents, 2879); assert.equal(preview.sourceSnapshot.billingSnapshot.serviceMinutes, 2879);
  assert.equal(preview.sourceSnapshot.actualEndDate, '2026-10-06'); assert.equal(Object.keys(preview.sourceSnapshot.billingSnapshot).length, 7); assert.deepEqual(preview.sourceSnapshot, extended);
  assert.equal(listCalculationCandidates(f.db, f.ctx, calculationCandidateQuery(new URLSearchParams()), hooks).sources.total, 2);
  rejects(() => assertCalculationSource({ ...extended, billingSnapshot: { ...extended.billingSnapshot, spanMode: 'calendar-two-day-v1' } }), 'CALCULATION_SOURCE_INVALID', 409);
  assert.deepEqual(f.state(), before);
});
