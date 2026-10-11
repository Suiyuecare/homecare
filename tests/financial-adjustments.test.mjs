import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { initDb, insert, replace, validate, business, now } from '../src/server/model.mjs';
import { guardFinancialAdjustmentAccess, financialAdjustmentQuery, listFinancialAdjustments, readFinancialAdjustment, readFinancialAdjustmentHistory, commitFinancialAdjustmentCreate, commitFinancialAdjustmentDraft, commitFinancialAdjustmentSubmit, commitFinancialAdjustmentReview, preflightFinancialAdjustmentReceipt, confirmFinancialAdjustmentResponse } from '../src/server/financial-adjustments.mjs';
import { commitAccountChange } from '../src/server/account-administration.mjs';
import { confirmFinancialAdjustment, confirmFinancialAdjustmentList, confirmFinancialAdjustmentHistory, confirmFinancialAdjustmentAck, buildFinancialAdjustmentCreate, buildFinancialAdjustmentDraft, FINANCIAL_ADJUSTMENT_NOTICE } from '../public/data/financial-adjustment-core.js';

const raw = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
const state = db => ({ tables: raw(db), changes: db.prepare('SELECT total_changes() AS n').get().n });
const rejected = (db, expected, call) => { const before = state(db); assert.throws(call, error => error.code === expected, expected); assert.deepEqual(state(db), before); };
const tx = (db, fn) => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
function fixture(t) {
  const db = new DatabaseSync(':memory:'); initDb(db); t.after(() => db.close()); const org = randomUUID(), user = randomUUID(); db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(org, '合成財務調整機構', now());
  const ctxs = {};
  for (const role of ['admin', 'finance', 'supervisor', 'caregiver']) { const id = role === 'admin' ? user : randomUUID(); db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id, '合成' + role, id + '@example.invalid', '!synthetic-only!', now()); db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(org, id, role, null); ctxs[role] = { orgId: org, role, user: { id } }; }
  const ctx = ctxs.admin, parent = insert(db, org, 'cases', { name: '合成原單據個案', caseNo: 'SYN-CORRECTION-C', status: 'active' }), employee = insert(db, org, 'employees', { name: '合成原單據員工', employeeNo: 'SYN-CORRECTION-E', status: 'active' });
  const createDocument = (kind, status) => {
    const entity = kind === 'billing' ? 'billing-documents' : 'payroll-statements', data = { ...(kind === 'billing' ? { caseId: parent.id, lineItems: [{ label: '合成原帳單一分', quantity: 1, unitPriceCents: 1 }] } : { employeeId: employee.id, lineItems: [{ label: '合成原薪資一分', kind: 'earning', amountCents: 1 }] }), month: '2026-10', number: 'SYN-' + kind + '-' + randomUUID(), sourceReference: '合成已核定人工依據', status: 'draft', note: '合成原單據不可改寫' };
    validate(db, ctx, entity, data); let document = insert(db, org, entity, data);
    for (const next of kind === 'billing' ? (status === 'issued' ? ['issued'] : []) : (status === 'closed' ? ['reviewed', 'closed'] : status === 'reviewed' ? ['reviewed'] : [])) { const changed = { ...business(document), status: next }; validate(db, ctx, entity, changed, document); document = replace(db, org, entity, document, changed); }
    return document;
  };
  const bill = createDocument('billing', 'issued'), payroll = createDocument('payroll', 'closed');
  const payload = (kind = 'billing', changes = {}) => { const source = kind === 'billing' ? bill : payroll; return { sourceKind: kind, sourceId: source.id, sourceVersion: source.version, number: 'SYN-ADJUST-' + randomUUID(), effectiveMonth: '2026-11', direction: 'credit', amountCents: 1, reason: '合成人工跨月更正依據', ...changes }; };
  const create = (kind = 'billing', changes = {}, actor = ctx) => tx(db, () => commitFinancialAdjustmentCreate(db, actor, payload(kind, changes)));
  const draft = (item, changes = {}, actor = ctx) => tx(db, () => commitFinancialAdjustmentDraft(db, actor, item.id, { version: item.version, number: item.number, effectiveMonth: item.effectiveMonth, direction: item.direction, amountCents: item.amountCents, reason: item.reason, ...changes }));
  const submit = (item, actor = ctx) => tx(db, () => commitFinancialAdjustmentSubmit(db, actor, item.id, { version: item.version }));
  const review = (item, decision = 'approved', actor = ctxs.finance) => tx(db, () => commitFinancialAdjustmentReview(db, actor, item.id, { version: item.version, decision, reviewNote: '合成實際覆核原因' }));
  const originals = () => raw(db).records.filter(row => row.entity !== 'financial-adjustments');
  return { db, org, user, ctx, ctxs, parent, employee, bill, payroll, createDocument, payload, create, draft, submit, review, originals };
}

test('Issued billing and closed payroll create documentary correction snapshots without changing source, parties or balances', t => {
  const f = fixture(t), before = f.originals();
  for (const kind of ['billing', 'payroll']) {
    const payload = f.payload(kind), result = tx(f.db, () => commitFinancialAdjustmentCreate(f.db, f.ctx, payload));
    assert.equal(result.notice, FINANCIAL_ADJUSTMENT_NOTICE); assert.equal(result.item.status, 'draft'); assert.equal(result.item.version, 1); assert.equal(result.item.sourceEligible, true); assert.equal(result.item.sourceSnapshot.record.summary[kind === 'billing' ? 'amountCents' : 'netCents'], 1);
    confirmFinancialAdjustment(result.item, { orgId: f.org }); confirmFinancialAdjustmentAck(result, { orgId: f.org, payload, status: 'draft' });
  }
  assert.deepEqual(f.originals(), before); assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM records WHERE entity='payment-receipts'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n, 11); assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger'").get().n, 6);
});

test('Mutation acknowledgements reject consistent stale-source projections while historical reads stay valid', t => {
  const f = fixture(t);
  for (const kind of ['billing', 'payroll']) {
    const payload = f.payload(kind), response = tx(f.db, () => commitFinancialAdjustmentCreate(f.db, f.ctx, payload));
    const expected = { orgId: f.org, payload, status: 'draft' };
    confirmFinancialAdjustmentAck(response, expected);
    const stale = structuredClone(response);
    stale.item.sourceCurrentVersion++;
    stale.item.sourceCurrentStatus = 'voided';
    stale.item.sourceEligible = false;
    // A source can become void after saving, so this is a valid historical read.
    // It must not confirm a mutation whose contract requires an eligible source.
    confirmFinancialAdjustment(stale.item, { orgId: f.org });
    const before = state(f.db);
    assert.throws(() => confirmFinancialAdjustmentAck(stale, expected), /保存來源、版次或狀態未確認/);
    assert.deepEqual(state(f.db), before);
  }
});

test('Draft→submitted→approved/rejected uses CAS, actor IDs and immutable content without executing payouts', t => {
  const f = fixture(t), sourceBefore = f.originals();
  for (const decision of ['approved', 'rejected']) {
    const initial = f.create('payroll').item, edited = f.draft(initial, { direction: 'debit', amountCents: 19, reason: '合成修正十九分' }).item, submitted = f.submit(edited, f.ctxs.finance).item, result = f.review(submitted, decision, f.ctx), final = result.item;
    assert.equal(final.version, 4); assert.equal(final.status, decision); assert.equal(final.createdBy, f.user); assert.equal(final.submittedBy, f.ctxs.finance.user.id); assert.equal(final.reviewedBy, f.user); assert.equal(final.amountCents, 19);
    for (const key of ['sourceKind', 'sourceId', 'sourceVersion', 'number', 'effectiveMonth', 'direction', 'amountCents', 'reason', 'sourceSnapshot', 'createdBy']) assert.deepEqual(final[key], edited[key]);
    const history = readFinancialAdjustmentHistory(f.db, f.ctx, final.id); assert.equal(history.total, 4); assert.deepEqual(history.items.map(row => row.snapshot.status), [decision, 'submitted', 'draft', 'draft']); confirmFinancialAdjustmentHistory(history, { orgId: f.org, id: final.id });
    const events = f.db.prepare("SELECT user_id,detail FROM audit WHERE entity='financial-adjustments' AND record_id=? ORDER BY rowid").all(final.id); assert.equal(events.length, 4); assert.equal(events[3].user_id, f.user); assert.equal(JSON.parse(events[3].detail).decision, decision);
    assert.throws(() => f.db.prepare('DELETE FROM record_versions WHERE record_id=?').run(final.id), /immutable/);
  }
  assert.deepEqual(f.originals(), sourceBefore);
});

test('All roles, revoked membership and suspended account guards precede record or source disclosure', t => {
  const f = fixture(t), initial = f.create().item;
  for (const role of ['supervisor', 'caregiver']) {
    rejected(f.db, 'ROLE_FORBIDDEN', () => readFinancialAdjustment(f.db, f.ctxs[role], initial.id));
    rejected(f.db, 'ROLE_FORBIDDEN', () => tx(f.db, () => commitFinancialAdjustmentCreate(f.db, f.ctxs[role], f.payload())));
    rejected(f.db, 'ROLE_FORBIDDEN', () => readFinancialAdjustmentHistory(f.db, f.ctxs[role], initial.id));
  }
  tx(f.db, () => commitAccountChange(f.db, f.ctx, f.ctxs.finance.user.id, { version: 0, role: 'finance', employeeId: null, status: 'suspended', reason: '合成撤銷財務權限' }));
  rejected(f.db, 'ROLE_FORBIDDEN', () => guardFinancialAdjustmentAccess(f.db, f.ctxs.finance));
  f.db.prepare('DELETE FROM memberships WHERE org_id=? AND user_id=?').run(f.org, f.user); rejected(f.db, 'ROLE_FORBIDDEN', () => readFinancialAdjustment(f.db, f.ctx, initial.id));
});

test('Cross-org source IDs, adjustment IDs and parent references never disclose old snapshots', t => {
  const f = fixture(t), initial = f.create().item, foreign = randomUUID(); f.db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(foreign, '合成另一更正機構', now()); f.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(foreign, f.user, 'admin', null); const other = { ...f.ctx, orgId: foreign };
  rejected(f.db, 'NOT_FOUND', () => readFinancialAdjustment(f.db, other, initial.id)); rejected(f.db, 'NOT_FOUND', () => readFinancialAdjustmentHistory(f.db, other, initial.id)); rejected(f.db, 'NOT_FOUND', () => tx(f.db, () => commitFinancialAdjustmentCreate(f.db, other, f.payload())));
  const before = state(f.db), list = listFinancialAdjustments(f.db, other, financialAdjustmentQuery(new URLSearchParams(), { list: true })); assert.equal(list.total, 0); assert.deepEqual(state(f.db), before);
});

test('Draft source, reviewed payroll, stale source version and nonexistent source never create partial correction records', t => {
  const f = fixture(t), billDraft = f.createDocument('billing', 'draft'), payrollReviewed = f.createDocument('payroll', 'reviewed');
  for (const [kind, source] of [['billing', billDraft], ['payroll', payrollReviewed]]) rejected(f.db, 'ADJUSTMENT_SOURCE_NOT_FINAL', () => tx(f.db, () => commitFinancialAdjustmentCreate(f.db, f.ctx, f.payload(kind, { sourceId: source.id, sourceVersion: source.version }))));
  rejected(f.db, 'VERSION_CONFLICT', () => tx(f.db, () => commitFinancialAdjustmentCreate(f.db, f.ctx, f.payload('billing', { sourceVersion: 1 }))));
  rejected(f.db, 'NOT_FOUND', () => tx(f.db, () => commitFinancialAdjustmentCreate(f.db, f.ctx, f.payload('billing', { sourceId: randomUUID() }))));
});

test('Voided/later source head blocks further writes and cached receipt while preserving readable exact original history', t => {
  const f = fixture(t), created = f.create(), submitted = f.submit(created.item).item;
  const cancelled = { ...business(f.bill), status: 'voided', note: '合成原帳單撤銷' }; validate(f.db, f.ctx, 'billing-documents', cancelled, f.bill); const later = replace(f.db, f.org, 'billing-documents', f.bill, cancelled);
  const before = state(f.db), current = readFinancialAdjustment(f.db, f.ctx, submitted.id).item; assert.equal(current.sourceEligible, false); assert.equal(current.sourceCurrentStatus, 'voided'); assert.equal(current.sourceCurrentVersion, later.version); assert.deepEqual(current.sourceSnapshot.record, f.bill); confirmFinancialAdjustment(current, { orgId: f.org });
  const history = readFinancialAdjustmentHistory(f.db, f.ctx, submitted.id); assert.equal(history.total, 2); assert.deepEqual(state(f.db), before);
  rejected(f.db, 'ADJUSTMENT_SOURCE_CHANGED', () => f.review(submitted)); rejected(f.db, 'ADJUSTMENT_SOURCE_CHANGED', () => preflightFinancialAdjustmentReceipt(f.db, f.ctx, submitted.id)); rejected(f.db, 'ADJUSTMENT_SOURCE_CHANGED', () => confirmFinancialAdjustmentResponse(f.db, f.ctx, created));
});

test('CAS, duplicate numbers, approved/rejected locks and malformed transition are zero-write', t => {
  const f = fixture(t), created = f.create().item, updated = f.draft(created, { reason: '合成新原因' }).item;
  rejected(f.db, 'VERSION_CONFLICT', () => f.draft(created, { amountCents: 9 })); rejected(f.db, 'DUPLICATE_NUMBER', () => f.create('payroll', { number: updated.number }));
  rejected(f.db, 'ADJUSTMENT_LOCKED', () => f.review(updated));
  const submitted = f.submit(updated).item; rejected(f.db, 'ADJUSTMENT_LOCKED', () => f.draft(submitted, { amountCents: 99 })); rejected(f.db, 'ADJUSTMENT_LOCKED', () => f.submit(submitted));
  rejected(f.db, 'ADJUSTMENT_PAYLOAD_INVALID', () => tx(f.db, () => commitFinancialAdjustmentReview(f.db, f.ctx, submitted.id, { version: submitted.version, decision: 'approved', reviewNote: '' })));
  const approved = f.review(submitted).item; rejected(f.db, 'ADJUSTMENT_LOCKED', () => f.review(approved, 'rejected')); rejected(f.db, 'ADJUSTMENT_LOCKED', () => f.draft(approved));
});

for (const [name, patch] of [
  ['negative cents', { amountCents: -1 }], ['fractional cents', { amountCents: 0.1 }], ['unsafe cents', { amountCents: Number.MAX_SAFE_INTEGER + 1 }], ['coerced cents', { amountCents: '1' }],
  ['bad direction', { direction: 'earning' }], ['bad month', { effectiveMonth: '2026-13' }], ['newline month', { effectiveMonth: '2026-11\n' }], ['empty reason', { reason: '' }], ['negative source version', { sourceVersion: -1 }], ['extra snapshot', { sourceSnapshot: {} }], ['false final status', { status: 'approved' }],
]) test('Malformed financial adjustment ' + name + ' rejects before all writes', t => {
  const f = fixture(t); rejected(f.db, 'ADJUSTMENT_PAYLOAD_INVALID', () => tx(f.db, () => commitFinancialAdjustmentCreate(f.db, f.ctx, f.payload('billing', patch))));
});

test('Exact zero and safe maximum integer corrections remain documentary and do not round cents', t => {
  const f = fixture(t);
  for (const amountCents of [0, 1, Number.MAX_SAFE_INTEGER]) { const result = f.create('payroll', { amountCents }); assert.equal(result.item.amountCents, amountCents); confirmFinancialAdjustment(result.item, { orgId: f.org }); }
});

test('Read-only pagination/filter, exact history and stale cached receipt preserve source and storage', t => {
  const f = fixture(t), first = f.create(), second = f.create('payroll'), before = state(f.db), query = financialAdjustmentQuery(new URLSearchParams('page=1&pageSize=1&sourceKind=payroll&effectiveMonth=2026-11'), { list: true }), result = listFinancialAdjustments(f.db, f.ctx, query);
  assert.equal(result.items[0].id, second.item.id); confirmFinancialAdjustmentList(result, { orgId: f.org, ...query }); assert.deepEqual(state(f.db), before);
  const confirmed = confirmFinancialAdjustmentResponse(f.db, f.ctx, first); assert.deepEqual(confirmed, first); assert.deepEqual(state(f.db), before);
  f.draft(first.item, { amountCents: 10 }); rejected(f.db, 'ADJUSTMENT_RECEIPT_STALE', () => confirmFinancialAdjustmentResponse(f.db, f.ctx, first));
  for (const text of ['page=01', 'page=0', 'pageSize=101', 'status=approved&status=draft', 'unknown=1', 'sourceKind=claims']) assert.throws(() => financialAdjustmentQuery(new URLSearchParams(text), { list: true }), error => error.status === 422);
});

test('Current/source snapshot corruption and missing parent fail closed rather than skipping or recomputing amounts', t => {
  const f = fixture(t), initial = f.create().item;
  const rawSource = f.db.prepare('SELECT data FROM records WHERE id=?').get(f.bill.id).data;
  f.db.prepare('UPDATE records SET data=? WHERE id=?').run('{}', f.bill.id); rejected(f.db, 'FINANCIAL_OUTPUT_UNVERIFIABLE', () => readFinancialAdjustment(f.db, f.ctx, initial.id));
  f.db.prepare('UPDATE records SET data=? WHERE id=?').run(rawSource, f.bill.id);
  f.db.prepare('UPDATE records SET data=? WHERE id=?').run('{}', initial.id); rejected(f.db, 'FINANCIAL_ADJUSTMENT_INVALID', () => readFinancialAdjustment(f.db, f.ctx, initial.id));
});

test('Source master rename, employee inactive and price changes preserve original snapshot and correction amount', t => {
  const f = fixture(t), initial = f.create('payroll').item;
  replace(f.db, f.org, 'employees', f.employee, { ...business(f.employee), name: '合成新員工姓名', status: 'inactive', hourlyRateCents: 999999 });
  const before = state(f.db), result = readFinancialAdjustment(f.db, f.ctx, initial.id); assert.equal(result.item.sourceEligible, true); assert.equal(result.item.sourceSnapshot.record.employeeSnapshot.name, f.employee.name); assert.equal(result.item.amountCents, 1); assert.deepEqual(state(f.db), before);
});

test('Atomic audit failure rolls back adjustment/version/source and unsafe direct call cannot partially save', t => {
  const f = fixture(t), before = raw(f.db);
  assert.throws(() => commitFinancialAdjustmentCreate(f.db, f.ctx, f.payload()), error => error.code === 'ADJUSTMENT_TRANSACTION_REQUIRED'); assert.deepEqual(raw(f.db), before);
  f.db.exec("CREATE TRIGGER synthetic_adjustment_audit_failure BEFORE INSERT ON audit WHEN NEW.entity='financial-adjustments' BEGIN SELECT RAISE(ABORT,'synthetic adjustment failure'); END;");
  assert.throws(() => f.create(), /synthetic adjustment failure/); assert.deepEqual(raw(f.db), before);
});

test('Frontend response boundaries reject cross-scope, missing/unknown/duplicate/sparse fields and never execute response accessors', t => {
  const f = fixture(t), result = f.create(), item = result.item;
  for (const modify of [value => value.orgId = randomUUID(), value => value.amountCents = '1', value => value.amountCents = -1, value => value.sourceVersion++, value => value.sourceEligible = false, value => value.status = 'approved', value => value.extra = 'hidden', value => value.sourceSnapshot.record.summary.amountCents = 99]) { const bad = structuredClone(item); modify(bad); assert.throws(() => confirmFinancialAdjustment(bad, { orgId: f.org })); }
  let calls = 0; const bad = structuredClone(item); Object.defineProperty(bad, 'amountCents', { enumerable: true, get() { calls++; return 1; } }); assert.throws(() => confirmFinancialAdjustment(bad, { orgId: f.org })); assert.equal(calls, 0);
  const list = listFinancialAdjustments(f.db, f.ctx, financialAdjustmentQuery(new URLSearchParams(), { list: true })), duplicate = structuredClone(list); duplicate.items.push(duplicate.items[0]); duplicate.total++; assert.throws(() => confirmFinancialAdjustmentList(duplicate, { orgId: f.org, page: 1, pageSize: 25 }));
  const sparse = structuredClone(list); sparse.items.length = 2; sparse.total = 2; assert.throws(() => confirmFinancialAdjustmentList(sparse, { orgId: f.org, page: 1, pageSize: 25 }));
  f.draft(item, { reason: '合成較新原因' });
  const history = readFinancialAdjustmentHistory(f.db, f.ctx, item.id);
  for (const target of ['snapshot', 'sourceSnapshot']) {
    const badHistory = structuredClone(history), owner = target === 'snapshot' ? badHistory.items[1] : badHistory.items[1].snapshot;
    Object.defineProperty(owner, target, { enumerable: true, get() { calls++; return {}; } });
    assert.throws(() => confirmFinancialAdjustmentHistory(badHistory, { orgId: f.org, id: item.id })); assert.equal(calls, 0);
  }
  assert.deepEqual(buildFinancialAdjustmentCreate(f.payload('billing', { number: '  合成編號  ', reason: ' 合成原因 ' })).reason, '合成原因'); assert.throws(() => buildFinancialAdjustmentDraft({ number: '合成', effectiveMonth: '2026-11', direction: 'credit', amountCents: '1', reason: '合成' }, 1));
});
