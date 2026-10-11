import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { accountMembershipActive } from './account-administration.mjs';
import { audit, fail, get, now, saveVersion } from './model.mjs';
import { billingDocumentVisible } from './billing-documents.mjs';
import { payrollStatementVisible } from './payroll-statements.mjs';
import { readFinancialOutput } from './financial-outputs.mjs';
import { FINANCIAL_ADJUSTMENT_NOTICE, FINANCIAL_ADJUSTMENT_DATA_KEYS, financialAdjustmentStatuses, financialAdjustmentSourceStatuses, confirmFinancialAdjustmentSaved, confirmFinancialAdjustmentHistory, buildFinancialAdjustmentCreate, buildFinancialAdjustmentDraft } from '../../public/data/financial-adjustment-core.js';

export const financialAdjustmentEntity = 'financial-adjustments';
const META = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
const hooks = { fail, get, billingDocumentVisible, payrollStatementVisible };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const ref = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 500 && !/[\r\n]/.test(value);
const invalid = () => fail(409, 'FINANCIAL_ADJUSTMENT_INVALID', '人工調整單的保存內容、來源或不可改寫版本無法確認');
const business = item => Object.fromEntries(FINANCIAL_ADJUSTMENT_DATA_KEYS.map(key => [key, item[key]]));
const sourceEntity = kind => kind === 'billing' ? 'billing-documents' : 'payroll-statements';
const safeInt = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
function literal(bytes) { try { if (!(bytes instanceof Uint8Array)) throw new Error(); return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { invalid(); } }
function checked(call) { try { return call(); } catch (error) { if (error?.status) throw error; invalid(); } }

export function guardFinancialAdjustmentAccess(db, ctx) {
  if (!['admin', 'finance'].includes(ctx?.role) || !ref(ctx.orgId) || !ref(ctx.user?.id)
      || db.prepare('SELECT role FROM memberships WHERE org_id=? AND user_id=?').get(ctx.orgId, ctx.user.id)?.role !== ctx.role
      || !accountMembershipActive(db, ctx.orgId, ctx.user.id)) fail(403, 'ROLE_FORBIDDEN', '僅本機構有效管理者或財務可管理人工調整單');
}
function transactionRequired(db) { if (!db.isTransaction) fail(500, 'ADJUSTMENT_TRANSACTION_REQUIRED', '人工調整須在完整交易內保存'); }

function saved(db, ctx, id) {
  if (!ref(id)) fail(404, 'NOT_FOUND', '找不到本機構人工調整單');
  const stmt = db.prepare('SELECT *, CAST(id AS BLOB) AS exact_id_bytes FROM records WHERE org_id=? AND entity=? AND id=?'); stmt.setReadBigInts(true);
  const row = stmt.get(ctx.orgId, financialAdjustmentEntity, id);
  if (!row) fail(404, 'NOT_FOUND', '找不到本機構人工調整單');
  if (literal(row.exact_id_bytes) !== id || typeof row.version !== 'bigint' || row.version < 1n || row.version > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  let data; try { data = JSON.parse(row.data); } catch { invalid(); }
  if (!exact(data, FINANCIAL_ADJUSTMENT_DATA_KEYS)) invalid();
  const item = { ...data, id, orgId: row.org_id, version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at };
  checked(() => confirmFinancialAdjustmentSaved(item, { orgId: ctx.orgId, id }));
  const head = db.prepare('SELECT *,CAST(record_id AS BLOB) AS exact_id_bytes FROM record_versions WHERE org_id=? AND entity=? AND record_id=? AND version=?').get(ctx.orgId, financialAdjustmentEntity, id, item.version);
  let snapshot; try { snapshot = JSON.parse(head?.snapshot); } catch { invalid(); }
  if (!head || literal(head.exact_id_bytes) !== id || head.created_at !== item.updatedAt || !isDeepStrictEqual(snapshot, item)
      || !['financial-adjustment.create', 'financial-adjustment.update', 'financial-adjustment.submit', 'financial-adjustment.review'].includes(head.source)) invalid();
  return item;
}

function currentSource(db, ctx, kind, id, version) {
  return readFinancialOutput(db, ctx, kind, id, { version }, hooks);
}
function sourceState(db, ctx, item) {
  const pinned = db.prepare('SELECT *, CAST(record_id AS BLOB) AS exact_id_bytes FROM record_versions WHERE org_id=? AND entity=? AND record_id=? AND version=?').get(ctx.orgId, sourceEntity(item.sourceKind), item.sourceId, item.sourceVersion);
  let snapshot; try { snapshot = JSON.parse(pinned?.snapshot); } catch { invalid(); }
  if (!pinned || literal(pinned.exact_id_bytes) !== item.sourceId || pinned.created_at !== item.sourceSnapshot.record.updatedAt || !isDeepStrictEqual(snapshot, item.sourceSnapshot.record)) invalid();
  const statement = db.prepare('SELECT version FROM records WHERE org_id=? AND entity=? AND id=?'); statement.setReadBigInts(true);
  const row = statement.get(ctx.orgId, sourceEntity(item.sourceKind), item.sourceId);
  if (!row) fail(404, 'NOT_FOUND', '原單據已不屬於目前可讀取來源');
  if (typeof row.version !== 'bigint' || row.version < BigInt(item.sourceVersion) || row.version > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  const current = currentSource(db, ctx, item.sourceKind, item.sourceId, Number(row.version)).record;
  return { sourceCurrentVersion: current.version, sourceCurrentStatus: current.status, sourceEligible: current.version === item.sourceVersion && current.status === financialAdjustmentSourceStatuses[item.sourceKind] };
}
function project(db, ctx, item) { return { ...item, ...sourceState(db, ctx, item) }; }
function assertSourceEligible(db, ctx, item) { if (!sourceState(db, ctx, item).sourceEligible) fail(409, 'ADJUSTMENT_SOURCE_CHANGED', '原單據已變更或撤銷，保留本調整歷程，請重新核對來源'); }

export function financialAdjustmentQuery(params, { list = false } = {}) {
  const allowed = list ? ['page', 'pageSize', 'q', 'status', 'sourceKind', 'effectiveMonth'] : [];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) fail(422, 'INVALID_QUERY', '調整單查詢欄位不合法或重複');
  const number = (key, fallback, maximum) => { const raw = params.get(key) ?? String(fallback), value = Number(raw); if (!/^[1-9]\d*$/.test(raw) || !safeInt(value, 1) || value > maximum) fail(422, 'PAGINATION', '調整單分頁不合法'); return value; };
  const page = number('page', 1, Math.floor(Number.MAX_SAFE_INTEGER / 100)), pageSize = number('pageSize', 25, 100), q = params.get('q') || '', status = params.get('status') || '', sourceKind = params.get('sourceKind') || '', effectiveMonth = params.get('effectiveMonth') || '';
  if (q.length > 200 || /[\u0000-\u001f\u007f]/.test(q) || status && !Object.hasOwn(financialAdjustmentStatuses, status) || sourceKind && !Object.hasOwn(financialAdjustmentSourceStatuses, sourceKind) || effectiveMonth && (effectiveMonth.length !== 7 || !/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(effectiveMonth))) fail(422, 'INVALID_QUERY', '調整單查詢內容不合法');
  return { page, pageSize, q: q.toLocaleLowerCase('zh-TW'), status, sourceKind, effectiveMonth };
}
function allSaved(db, ctx) { return db.prepare('SELECT id FROM records WHERE org_id=? AND entity=? ORDER BY created_at DESC,id').all(ctx.orgId, financialAdjustmentEntity).map(row => saved(db, ctx, row.id)); }
export function listFinancialAdjustments(db, ctx, query) {
  guardFinancialAdjustmentAccess(db, ctx);
  const all = allSaved(db, ctx).map(item => project(db, ctx, item));
  const items = all.filter(item => (!query.status || item.status === query.status) && (!query.sourceKind || item.sourceKind === query.sourceKind) && (!query.effectiveMonth || item.effectiveMonth === query.effectiveMonth) && (!query.q || [item.number, item.reason, item.sourceSnapshot.record.number].some(value => value.toLocaleLowerCase('zh-TW').includes(query.q))));
  return { orgId: ctx.orgId, items: items.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: items.length, page: query.page, pageSize: query.pageSize, notice: FINANCIAL_ADJUSTMENT_NOTICE };
}
export function readFinancialAdjustment(db, ctx, id) { guardFinancialAdjustmentAccess(db, ctx); return { item: project(db, ctx, saved(db, ctx, id)), notice: FINANCIAL_ADJUSTMENT_NOTICE }; }
export function readFinancialAdjustmentHistory(db, ctx, id) {
  guardFinancialAdjustmentAccess(db, ctx); const current = saved(db, ctx, id); sourceState(db, ctx, current);
  const items = db.prepare('SELECT version,snapshot,created_at AS createdAt,source FROM record_versions WHERE org_id=? AND entity=? AND record_id=? ORDER BY version DESC').all(ctx.orgId, financialAdjustmentEntity, id).map(row => { let snapshot; try { snapshot = JSON.parse(row.snapshot); } catch { invalid(); } return { ...row, snapshot }; });
  const result = { orgId: ctx.orgId, id, items, total: items.length, notice: FINANCIAL_ADJUSTMENT_NOTICE };
  if (items.length !== current.version) invalid(); checked(() => confirmFinancialAdjustmentHistory(result, { orgId: ctx.orgId, id }));
  for (const row of items) { if (!['sourceKind', 'sourceId', 'sourceVersion', 'createdBy'].every(key => row.snapshot[key] === current[key]) || !isDeepStrictEqual(row.snapshot.sourceSnapshot, current.sourceSnapshot)) invalid(); }
  return result;
}

export function validateFinancialAdjustmentCreate(payload) {
  if (!exact(payload, ['sourceKind', 'sourceId', 'sourceVersion', 'number', 'effectiveMonth', 'direction', 'amountCents', 'reason'])) fail(422, 'ADJUSTMENT_PAYLOAD_INVALID', '請明確填寫原單據版次、編號、生效月份、方向、金額及原因');
  try { const normalized = buildFinancialAdjustmentCreate(payload); if (!isDeepStrictEqual(normalized, payload)) throw new Error(); return normalized; } catch { fail(422, 'ADJUSTMENT_PAYLOAD_INVALID', '人工調整欄位或整數分金額不合法'); }
}
export function validateFinancialAdjustmentDraft(payload) {
  if (!exact(payload, ['version', 'number', 'effectiveMonth', 'direction', 'amountCents', 'reason'])) fail(422, 'ADJUSTMENT_PAYLOAD_INVALID', '草稿須提供保存版本及完整人工調整內容');
  try { const normalized = buildFinancialAdjustmentDraft(payload, payload.version); if (!isDeepStrictEqual(normalized, payload)) throw new Error(); return normalized; } catch { fail(422, 'ADJUSTMENT_PAYLOAD_INVALID', '人工調整欄位或整數分金額不合法'); }
}
export function validateFinancialAdjustmentTransition(payload, operation) {
  const review = operation === 'review';
  if (!exact(payload, review ? ['version', 'decision', 'reviewNote'] : ['version']) || !safeInt(payload.version, 1) || review && (!['approved', 'rejected'].includes(payload.decision) || typeof payload.reviewNote !== 'string' || !payload.reviewNote.trim() || payload.reviewNote !== payload.reviewNote.trim() || payload.reviewNote.length > 2000 || /[\u0000-\u001f\u007f]/.test(payload.reviewNote))) fail(422, 'ADJUSTMENT_PAYLOAD_INVALID', '請提供保存版本，覆核時須明確填寫結果與原因');
  return payload;
}
function uniqueNumber(db, ctx, number, id) { if (allSaved(db, ctx).some(item => item.id !== id && item.number === number)) fail(409, 'DUPLICATE_NUMBER', '本機構已有相同調整單編號'); }
export function preflightFinancialAdjustmentCreate(db, ctx, payload) {
  guardFinancialAdjustmentAccess(db, ctx); validateFinancialAdjustmentCreate(payload); uniqueNumber(db, ctx, payload.number);
  const source = currentSource(db, ctx, payload.sourceKind, payload.sourceId, payload.sourceVersion);
  if (source.record.status !== financialAdjustmentSourceStatuses[payload.sourceKind]) fail(409, 'ADJUSTMENT_SOURCE_NOT_FINAL', '只有已開立帳單或已關帳薪資可建立調整單');
  return source;
}
export function preflightFinancialAdjustmentMutation(db, ctx, id, payload, operation) {
  guardFinancialAdjustmentAccess(db, ctx);
  if (!['update', 'submit', 'review'].includes(operation)) fail(405, 'METHOD_NOT_ALLOWED', '找不到此調整單操作');
  if (operation === 'update') validateFinancialAdjustmentDraft(payload); else validateFinancialAdjustmentTransition(payload, operation);
  const current = saved(db, ctx, id); if (current.version !== payload.version) fail(409, 'VERSION_CONFLICT', '調整單已變更，請重新讀取');
  const expectedStatus = operation === 'review' ? 'submitted' : 'draft';
  if (current.status !== expectedStatus) fail(409, 'ADJUSTMENT_LOCKED', '調整內容已鎖定，請沿提交與覆核流程操作');
  assertSourceEligible(db, ctx, current); if (operation === 'update') uniqueNumber(db, ctx, payload.number, id);
  return current;
}
function persist(db, ctx, old, data, operation) {
  const time = now(), item = { ...data, id: old?.id || randomUUID(), orgId: ctx.orgId, version: old ? old.version + 1 : 1, createdAt: old?.createdAt || time, updatedAt: time };
  checked(() => confirmFinancialAdjustmentSaved(item, { orgId: ctx.orgId }));
  if (old) { const result = db.prepare('UPDATE records SET data=?,version=version+1,updated_at=? WHERE id=? AND org_id=? AND entity=? AND version=?').run(JSON.stringify(data), time, item.id, ctx.orgId, financialAdjustmentEntity, old.version); if (!result.changes) fail(409, 'VERSION_CONFLICT', '調整單已變更，請重新讀取'); }
  else db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, ctx.orgId, financialAdjustmentEntity, JSON.stringify(data), 1, time, time);
  saveVersion(db, item, 'financial-adjustment.' + operation);
  audit(db, ctx, 'financial-adjustment.' + operation, financialAdjustmentEntity, item.id, { version: item.version, status: item.status, sourceKind: item.sourceKind, sourceId: item.sourceId, sourceVersion: item.sourceVersion, direction: item.direction, amountCents: item.amountCents, reason: item.reason, ...(operation === 'review' ? { reviewNote: item.reviewNote, decision: item.status } : {}) });
  return readFinancialAdjustment(db, ctx, item.id);
}
export function commitFinancialAdjustmentCreate(db, ctx, payload) {
  transactionRequired(db); const sourceSnapshot = preflightFinancialAdjustmentCreate(db, ctx, payload);
  return persist(db, ctx, null, { ...payload, status: 'draft', sourceSnapshot, createdBy: ctx.user.id, submittedBy: null, submittedAt: null, reviewedBy: null, reviewedAt: null, reviewNote: '' }, 'create');
}
export function commitFinancialAdjustmentDraft(db, ctx, id, payload) {
  transactionRequired(db); const current = preflightFinancialAdjustmentMutation(db, ctx, id, payload, 'update');
  return persist(db, ctx, current, { ...business(current), number: payload.number, effectiveMonth: payload.effectiveMonth, direction: payload.direction, amountCents: payload.amountCents, reason: payload.reason }, 'update');
}
export function commitFinancialAdjustmentSubmit(db, ctx, id, payload) {
  transactionRequired(db); const current = preflightFinancialAdjustmentMutation(db, ctx, id, payload, 'submit');
  return persist(db, ctx, current, { ...business(current), status: 'submitted', submittedBy: ctx.user.id, submittedAt: now() }, 'submit');
}
export function commitFinancialAdjustmentReview(db, ctx, id, payload) {
  transactionRequired(db); const current = preflightFinancialAdjustmentMutation(db, ctx, id, payload, 'review');
  return persist(db, ctx, current, { ...business(current), status: payload.decision, reviewedBy: ctx.user.id, reviewedAt: now(), reviewNote: payload.reviewNote }, 'review');
}
/** For idem preflight, revalidate access only; CAS executes inside uncached commit. */
export function preflightFinancialAdjustmentReceipt(db, ctx, id) { guardFinancialAdjustmentAccess(db, ctx); if (id) { const current = saved(db, ctx, id); assertSourceEligible(db, ctx, current); } }
export function confirmFinancialAdjustmentResponse(db, ctx, result) {
  guardFinancialAdjustmentAccess(db, ctx); if (!exact(result, ['item', 'notice']) || result.notice !== FINANCIAL_ADJUSTMENT_NOTICE || !plain(result.item)) invalid();
  const current = saved(db, ctx, result.item.id); assertSourceEligible(db, ctx, current);
  if (current.version !== result.item.version || !isDeepStrictEqual(current, Object.fromEntries([...FINANCIAL_ADJUSTMENT_DATA_KEYS, ...META].map(key => [key, result.item[key]])))) fail(409, 'ADJUSTMENT_RECEIPT_STALE', '調整單回執已非目前版本，請重新讀取');
  return readFinancialAdjustment(db, ctx, current.id);
}
