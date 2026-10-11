import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fail as defaultFail } from './model.mjs';
import { accountMembershipActive } from './account-administration.mjs';
import {
  CALCULATION_MODE, CalculationError, assertCalculationRule, assertCalculationSource, assertSyntheticDemoCalculationSource, calculateConfiguredAmount,
  immutableCalculationCopy, canonicalCalculationJson,
} from '../../public/data/calculation-core.js';

const own = (value, key) => Object.getOwnPropertyDescriptor(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && own(value, key)?.enumerable && Object.hasOwn(own(value, key), 'value'));
const closed = (value, fields) => plain(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const ref = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && value === value.trim() && !/[\r\n\0]/.test(value);
const safe = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max;
const text = (value, max) => typeof value === 'string' && value.length <= max && !value.includes('\0');
const metadata = ['id', 'orgId', 'version', 'createdAt', 'updatedAt'];
const invalid = (fail, message) => fail(422, 'CALCULATION_INVALID', message);
const broken = (fail, message) => fail(409, 'CALCULATION_STORED_INVALID', message);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const mapped = (action, fail) => {
  try { return action(); } catch (error) { if (error instanceof CalculationError) fail(error.status, error.code, error.message); throw error; }
};
function statementRows(db, sql, args) { const statement = db.prepare(sql); statement.setReadBigInts(true); return statement.all(...args); }
function blobText(value, fail) {
  if (!(value instanceof Uint8Array)) broken(fail, '保存文字的原始 SQL 型態無法確認。');
  try { return utf8.decode(value); } catch { broken(fail, '保存文字的 UTF-8 無法確認。'); }
}
function response(value, fail) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 2 * 1024 * 1024) fail(413, 'CALCULATION_TOO_LARGE', '完整試算超過 2MiB，請縮小候選查詢；不會省略任何來源或追溯。');
  return immutableCalculationCopy(value);
}

/** Enforce the current membership before reading candidate IDs or request data. */
export function guardCalculationAccess(db, ctx, fail = defaultFail) {
  if (!['admin', 'finance'].includes(ctx?.role) || !ref(ctx?.orgId) || !ref(ctx?.user?.id))
    fail(403, 'ROLE_FORBIDDEN', '僅目前機構管理者或財務可使用核定規則试算。');
  const memberships = statementRows(db, 'SELECT CAST(role AS BLOB) role,typeof(role) role_type FROM memberships WHERE org_id=? AND user_id=?', [ctx.orgId, ctx.user.id]);
  if (memberships.length !== 1 || memberships[0].role_type !== 'text' || blobText(memberships[0].role, fail) !== ctx.role || !accountMembershipActive(db, ctx.orgId, ctx.user.id))
    fail(403, 'ROLE_FORBIDDEN', '本次機構或角色授權已變更，請重新讀取。');
}

/** Read SQL identities byte-exactly and require the current immutable head. */
function readRecord(db, orgId, entity, recordId, fail) {
  const rows = statementRows(db, `SELECT CAST(id AS BLOB) id,CAST(org_id AS BLOB) org_id,CAST(entity AS BLOB) entity,
    CAST(data AS BLOB) data,version,CAST(created_at AS BLOB) created_at,CAST(updated_at AS BLOB) updated_at,
    typeof(id) id_type,typeof(org_id) org_type,typeof(entity) entity_type,typeof(data) data_type,typeof(version) version_type,
    typeof(created_at) created_type,typeof(updated_at) updated_type FROM records WHERE org_id=? AND entity=? AND id=?`, [orgId, entity, recordId]);
  if (!rows.length) return null;
  const row = rows[0];
  if (rows.length !== 1 || ['id_type', 'org_type', 'entity_type', 'data_type', 'created_type', 'updated_type'].some(key => row[key] !== 'text')
    || row.version_type !== 'integer' || typeof row.version !== 'bigint' || row.version < 1n || row.version > BigInt(Number.MAX_SAFE_INTEGER))
    broken(fail, '保存資料的 SQL 型態或版次無法確認。');
  const identity = { id: blobText(row.id, fail), orgId: blobText(row.org_id, fail), entity: blobText(row.entity, fail) };
  if (identity.id !== recordId || identity.orgId !== orgId || identity.entity !== entity) broken(fail, '保存資料的 SQL 身份不一致。');
  let data;
  try { data = JSON.parse(blobText(row.data, fail)); } catch { broken(fail, '保存業務資料無法解析。'); }
  if (!plain(data) || metadata.some(key => Object.hasOwn(data, key))) broken(fail, '業務資料不能覆寫 SQL 保存身份。');
  const record = { ...data, id: identity.id, orgId: identity.orgId, version: Number(row.version), createdAt: blobText(row.created_at, fail), updatedAt: blobText(row.updated_at, fail) };
  const versions = statementRows(db, `SELECT CAST(org_id AS BLOB) org_id,CAST(entity AS BLOB) entity,CAST(record_id AS BLOB) record_id,
    version,CAST(snapshot AS BLOB) snapshot,CAST(created_at AS BLOB) created_at,
    typeof(org_id) org_type,typeof(entity) entity_type,typeof(record_id) record_type,typeof(version) version_type,typeof(snapshot) snapshot_type,typeof(created_at) created_type
    FROM record_versions WHERE org_id=? AND entity=? AND record_id=? AND version=?`, [orgId, entity, recordId, record.version]);
  if (versions.length !== 1 || versions[0].version_type !== 'integer' || versions[0].version !== row.version
    || ['org_type', 'entity_type', 'record_type', 'snapshot_type', 'created_type'].some(key => versions[0][key] !== 'text'))
    broken(fail, '目前保存版次必須有唯一不可改寫的歷程。');
  const head = versions[0]; let snapshot;
  try { snapshot = JSON.parse(blobText(head.snapshot, fail)); } catch { broken(fail, '不可改寫的保存歷程無法解析。'); }
  if (blobText(head.org_id, fail) !== orgId || blobText(head.entity, fail) !== entity || blobText(head.record_id, fail) !== recordId
    || blobText(head.created_at, fail) !== record.updatedAt || !isDeepStrictEqual(record, snapshot))
    broken(fail, '目前內容與不可改寫的版本歷程不一致。');
  return record;
}

function requireVersion(item, expected, fail) {
  if (!item) fail(404, 'NOT_FOUND', '找不到本機構可讀取的規則或來源。');
  if (item.version !== expected) fail(409, 'CALCULATION_VERSION_CONFLICT', '來源或核定規則版次已變更，請重新選取並試算。');
  return item;
}
function ruleRecord(db, ctx, selection, fail) {
  const record = requireVersion(readRecord(db, ctx.orgId, 'business-rules', selection.id, fail), selection.version, fail);
  return mapped(() => assertCalculationRule(record), fail);
}
function sourceParents(db, ctx, source, fail) {
  const parent = readRecord(db, ctx.orgId, 'cases', source.caseId, fail), employee = readRecord(db, ctx.orgId, 'employees', source.employeeId, fail), shift = readRecord(db, ctx.orgId, 'shifts', source.shiftId, fail);
  if (!parent || !employee || !shift || shift.caseId !== source.caseId || shift.employeeId !== source.employeeId || shift.date !== source.date || shift.status !== 'completed'
    || !text(parent.name, 500) || !text(parent.caseNo, 500) || !text(employee.name, 500) || !text(employee.employeeNo, 500))
    broken(fail, '來源同機構個案、員工或原完成班次無法確認。');
  return { parent, employee };
}
function sourceRecord(db, ctx, selection, fail) {
  const record = requireVersion(readRecord(db, ctx.orgId, 'service-records', selection.id, fail), selection.version, fail);
  mapped(() => assertCalculationSource(record), fail); sourceParents(db, ctx, record, fail);
  return record;
}

export function readApprovedCalculationRule(db, ctx, selection, { fail = defaultFail } = {}) {
  guardCalculationAccess(db, ctx, fail);
  if (!closed(selection, ['id', 'version']) || !ref(selection.id) || !safe(selection.version, 1)) invalid(fail, '規則識別與版次必须明確指定。');
  return immutableCalculationCopy(ruleRecord(db, ctx, selection, fail));
}
export function readApprovedCalculationSource(db, ctx, selection, { fail = defaultFail } = {}) {
  guardCalculationAccess(db, ctx, fail);
  if (!closed(selection, ['id', 'version']) || !ref(selection.id) || !safe(selection.version, 1)) invalid(fail, '來源識別與版次必須明確指定。');
  return immutableCalculationCopy(sourceRecord(db, ctx, selection, fail));
}

export function calculationPreviewQuery(params, fail = defaultFail) {
  if (!(params instanceof URLSearchParams) || [...params.keys()].length) invalid(fail, '試算操作不接受查詢欄位。');
  return {};
}
export function validateCalculationPayload(payload, fail = defaultFail) {
  if (!closed(payload, ['rule', 'source', 'policy']) || !closed(payload.rule, ['id', 'version']) || !closed(payload.source, ['id', 'version'])
    || ![payload.rule, payload.source].every(selection => ref(selection.id) && safe(selection.version, 1)) || !plain(payload.policy))
    invalid(fail, '每次試算須提供明確的核定規則、來源、目前版次及計算方式，不能加入其他欄位。');
  return payload;
}
export function previewCalculation(db, ctx, payload, { fail = defaultFail } = {}) {
  guardCalculationAccess(db, ctx, fail); validateCalculationPayload(payload, fail);
  const rule = ruleRecord(db, ctx, payload.rule, fail), source = sourceRecord(db, ctx, payload.source, fail);
  const preview = mapped(() => calculateConfiguredAmount({ rule, source, policy: payload.policy }), fail);
  const previewHash = createHash('sha256').update(canonicalCalculationJson(preview), 'utf8').digest('hex');
  return response({ ...preview, previewHash }, fail);
}

export function calculationCandidateQuery(params, fail = defaultFail) {
  if (!(params instanceof URLSearchParams)) invalid(fail, '候選查詢格式無法確認。');
  for (const key of params.keys()) if (!['rulePage', 'sourcePage', 'pageSize', 'q'].includes(key) || params.getAll(key).length !== 1) invalid(fail, '候選查詢欄位未知或重複。');
  const query = { rulePage: 1, sourcePage: 1, pageSize: 25, q: params.get('q') ?? '' };
  for (const key of ['rulePage', 'sourcePage', 'pageSize']) {
    const input = params.get(key) ?? String(query[key]);
    if (!/^[1-9]\d*$/.test(input) || /[\r\n]/.test(input) || !safe(Number(input), 1, key === 'pageSize' ? 100 : Number.MAX_SAFE_INTEGER)) invalid(fail, '候選分頁须為安全正整數，pageSize最多100。');
    query[key] = Number(input);
  }
  if (![query.rulePage, query.sourcePage].every(page => safe((page - 1) * query.pageSize)) || !text(query.q, 200)) invalid(fail, '候選分頁範圍或搜尋文字不合法。');
  return query;
}
function page(items, current, pageSize) { return { items: items.slice((current - 1) * pageSize, current * pageSize), total: items.length, page: current, pageSize }; }
export function listCalculationCandidates(db, ctx, query, { fail = defaultFail } = {}) {
  guardCalculationAccess(db, ctx, fail);
  if (!closed(query, ['rulePage', 'sourcePage', 'pageSize', 'q']) || !safe(query.rulePage, 1) || !safe(query.sourcePage, 1) || !safe(query.pageSize, 1, 100)
    || ![query.rulePage, query.sourcePage].every(current => safe((current - 1) * query.pageSize)) || !text(query.q, 200)) invalid(fail, '請使用完整候選查詢。');
  const selected = query.q.toLocaleLowerCase('zh-TW'), rules = [], sources = [];
  for (const entity of ['business-rules', 'service-records']) {
    const identities = statementRows(db, 'SELECT CAST(id AS BLOB) id,typeof(id) id_type FROM records WHERE org_id=? AND entity=? ORDER BY created_at DESC,id', [ctx.orgId, entity]);
    for (const row of identities) {
      if (row.id_type !== 'text') broken(fail, '候選來源 SQL 識別無法確認。');
      const recordId = blobText(row.id, fail); if (!ref(recordId)) broken(fail, '候選來源識別格式無法確認。');
      const record = readRecord(db, ctx.orgId, entity, recordId, fail);
      if (!record || record.status !== 'approved') continue;
      if (entity === 'business-rules') {
        if (!['pricing', 'payroll'].includes(record.kind)) continue;
        mapped(() => assertCalculationRule(record), fail);
        const candidate = Object.fromEntries(['id', 'orgId', 'version', 'kind', 'code', 'name', 'validFrom', 'validTo', 'parameters', 'sourceReference'].map(key => [key, record[key]]));
        if (!selected || [record.code, record.name, record.sourceReference].some(value => value.toLocaleLowerCase('zh-TW').includes(selected))) rules.push(candidate);
      } else {
        if (record.billingSnapshot?.source === 'synthetic-demo') {
          mapped(() => assertSyntheticDemoCalculationSource(record), fail); sourceParents(db, ctx, record, fail);
          continue;
        }
        mapped(() => assertCalculationSource(record), fail); const { parent, employee } = sourceParents(db, ctx, record, fail);
        const candidate = { id: record.id, orgId: record.orgId, version: record.version, date: record.date, label: parent.name + ' · ' + employee.name,
          caseId: record.caseId, employeeId: record.employeeId, serviceMinutes: record.billingSnapshot.serviceMinutes,
          items: record.billingSnapshot.items.map(item => Object.fromEntries(['serviceItemId', 'code', 'name', 'quantity'].map(key => [key, item[key]]))) };
        if (!selected || [candidate.label, candidate.date, ...candidate.items.flatMap(item => [item.code, item.name])].some(value => value.toLocaleLowerCase('zh-TW').includes(selected))) sources.push(candidate);
      }
    }
  }
  return response({ mode: CALCULATION_MODE, orgId: ctx.orgId, rules: page(rules, query.rulePage, query.pageSize), sources: page(sources, query.sourcePage, query.pageSize) }, fail);
}
