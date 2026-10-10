import { fail } from './model.mjs';
import { safeVersionReader } from './report-query.mjs';

const indexedEntities = new Set(['care-plans', 'shifts', 'service-records', 'assessments']);
const routeIdentifier = value => typeof value === 'string' && /^[a-f0-9-]+$/.test(value);
const invalid = () => fail(409, 'CASE_RECORD_INDEX_INVALID', '符合查詢的保存紀錄識別或版次無法確認，請先核對；本次未呈現索引。');

export function guardCaseRecordIndexAccess(ctx) {
  if (!['admin', 'supervisor'].includes(ctx.role))
    fail(403, 'ROLE_FORBIDDEN', '僅管理者或督導可讀取個案保存紀錄索引');
}

function parseQuery(params) {
  const allowed = new Set(['entity', 'page', 'pageSize']);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1)
      fail(422, 'INVALID_QUERY', '不允許未知或重複的索引查詢參數', { [key]: '查詢參數不合法' });
  }
  const entity = params.get('entity');
  if (!indexedEntities.has(entity))
    fail(422, 'INVALID_QUERY', '請選擇照顧計畫、班次、服務紀錄或評估紀錄', { entity: '紀錄種類必填且須為指定代碼' });
  const integer = (key, fallback, maximum) => {
    const raw = params.has(key) ? params.get(key) : String(fallback), value = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value > maximum)
      fail(422, 'PAGINATION', 'page須為正整數，pageSize介於1至100', { [key]: '分頁不合法' });
    return value;
  };
  return { entity, page: integer('page', 1, Number.MAX_SAFE_INTEGER), pageSize: integer('pageSize', 25, 100) };
}

function belongsToCase(raw, caseId) {
  let data;
  try { data = JSON.parse(raw); } catch { return false; }
  return data !== null && typeof data === 'object' && !Array.isArray(data)
    && Object.hasOwn(data, 'caseId') && typeof data.caseId === 'string' && data.caseId === caseId;
}

/** Current SQL metadata only. Saved business fields never enter the response. */
export function readCaseRecordIndex(db, ctx, caseId, params) {
  guardCaseRecordIndexAccess(ctx);
  const { entity, page, pageSize } = parseQuery(params);
  const parent = db.prepare('SELECT id FROM records WHERE org_id=? AND entity=? AND id=?').get(ctx.orgId, 'cases', caseId);
  if (!parent) fail(404, 'NOT_FOUND', '找不到目前可讀取的個案');
  const candidates = safeVersionReader(db)
    .prepare('SELECT * FROM records WHERE org_id=? AND entity=? ORDER BY created_at DESC,id')
    .all(ctx.orgId, entity).filter(row => belongsToCase(row.data, parent.id));
  // Validate the whole matching set before pagination, including off-page versions.
  const projected = candidates.map(row => {
    if (!routeIdentifier(row.id) || typeof row.org_id !== 'string' || row.org_id !== ctx.orgId || row.entity !== entity
      || !Number.isSafeInteger(row.version) || row.version < 1 || typeof row.updated_at !== 'string') invalid();
    return { entity: row.entity, id: row.id, orgId: row.org_id, caseId: parent.id, version: row.version, updatedAt: row.updated_at };
  });
  return { items: projected.slice((page - 1) * pageSize, page * pageSize), total: projected.length, page, pageSize, entity, orgId: ctx.orgId, caseId: parent.id };
}
