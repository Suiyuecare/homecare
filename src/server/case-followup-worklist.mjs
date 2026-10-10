import { dateValid, fail, scopedRows } from './model.mjs';
import { safeVersionReader } from './report-query.mjs';

const fields = Object.freeze(['kind', 'startDate', 'endDate', 'reason', 'followUpDate', 'outcome', 'note', 'status']);
const searchable = Object.freeze(['reason', 'outcome', 'note']);
const kinds = new Set(['pause', 'closure']);
const statuses = new Set(['pending', 'completed', 'cancelled']);
const identifier = value => typeof value === 'string' && Boolean(value.trim());
const invalid = () => fail(409, 'FOLLOWUP_DATA_INVALID', '符合查詢的人工追蹤保存資料不完整，請先核對；本次未呈現紀錄。');

export function guardCaseFollowupWorklistAccess(ctx) {
  if (!['admin', 'supervisor'].includes(ctx.role))
    fail(403, 'ROLE_FORBIDDEN', '僅管理者或督導可使用人工追蹤查詢');
}

function parseQuery(params) {
  const allowed = new Set(['page', 'pageSize', 'q', 'kind', 'status', 'followUpDate', 'caseId']);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1)
      fail(422, 'INVALID_QUERY', '不允許未知或重複的人工追蹤查詢參數', { [key]: '查詢參數不合法' });
  }
  const filters = Object.fromEntries(['q', 'kind', 'status', 'followUpDate', 'caseId'].map(key => [key, params.get(key) || '']));
  if (filters.q.length > 200) fail(422, 'INVALID_QUERY', '搜尋文字最多200字元', { q: '搜尋文字過長' });
  if (filters.kind && !kinds.has(filters.kind)) fail(422, 'INVALID_KIND', '不支援的追蹤類型', { kind: '類型不合法' });
  if (filters.status && !statuses.has(filters.status)) fail(422, 'INVALID_STATUS', '不支援的人工追蹤狀態', { status: '狀態不合法' });
  if (filters.followUpDate && !dateValid(filters.followUpDate)) fail(422, 'INVALID_DATE', '人工追蹤日期須為有效YYYY-MM-DD', { followUpDate: '日期格式錯誤' });
  if (filters.caseId && (!identifier(filters.caseId) || filters.caseId.length > 500)) fail(422, 'INVALID_QUERY', '請提供有效個案識別', { caseId: '不可只有空白且最多500字元' });
  const integer = (key, fallback, maximum) => {
    const raw = params.has(key) ? params.get(key) : String(fallback), value = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value > maximum)
      fail(422, 'PAGINATION', 'page須為正整數，pageSize介於1至100', { [key]: '分頁不合法' });
    return value;
  };
  return { filters, page: integer('page', 1, Number.MAX_SAFE_INTEGER), pageSize: integer('pageSize', 25, 100) };
}

function taggedValue(item, key) {
  if (!Object.hasOwn(item, key)) return { kind: 'missing' };
  const value = item[key];
  if (value === null) return { kind: 'null' };
  if (Array.isArray(value)) return { kind: 'array' };
  if (typeof value === 'object') return { kind: 'object' };
  if (typeof value === 'string') return { kind: 'string', value };
  if (typeof value === 'boolean') return { kind: 'boolean' };
  if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'number' };
  invalid();
}

function authorizedRows(db, ctx) {
  const reader = safeVersionReader(db);
  const cases = new Map(scopedRows(reader, ctx, 'cases').filter(item => item.orgId === ctx.orgId).map(item => [item.id, item]));
  const items = scopedRows(reader, ctx, 'case-status-followups').filter(item => item.orgId === ctx.orgId && cases.has(item.caseId));
  return { cases, items };
}

function project(item, parent, ctx) {
  if (!identifier(item.id) || item.orgId !== ctx.orgId || !identifier(item.orgId) || !identifier(item.caseId) ||
      !parent || parent.orgId !== ctx.orgId || parent.id !== item.caseId || !Number.isSafeInteger(item.version) || item.version < 1) invalid();
  return {
    id: item.id, orgId: item.orgId, version: item.version, caseId: item.caseId,
    caseNo: typeof parent.caseNo === 'string' ? parent.caseNo : '', caseName: typeof parent.name === 'string' ? parent.name : '',
    fields: Object.fromEntries(fields.map(key => [key, taggedValue(item, key)])),
  };
}

/** Read existing manual documentation; never calculate deadlines or repair saved values. */
export function readCaseFollowupWorklist(db, ctx, params) {
  guardCaseFollowupWorklistAccess(ctx);
  const { filters, page, pageSize } = parseQuery(params), { cases, items } = authorizedRows(db, ctx);
  if (filters.caseId && !cases.has(filters.caseId)) fail(404, 'NOT_FOUND', '找不到可讀取的查詢個案');
  const q = filters.q.toLowerCase();
  const selected = items.filter(item => {
    for (const key of ['caseId', 'kind', 'status', 'followUpDate']) if (filters[key] && item[key] !== filters[key]) return false;
    return !q || searchable.some(key => Object.hasOwn(item, key) && typeof item[key] === 'string' && item[key].toLowerCase().includes(q));
  });
  const projected = selected.map(item => project(item, cases.get(item.caseId), ctx));
  return { items: projected.slice((page - 1) * pageSize, page * pageSize), total: projected.length, page, pageSize, filters };
}

export function readCaseFollowupWorklistItem(db, ctx, recordId, params) {
  guardCaseFollowupWorklistAccess(ctx);
  if ([...params.keys()].length) fail(422, 'INVALID_QUERY', '單筆人工追蹤讀取不接受查詢參數');
  const { cases, items } = authorizedRows(db, ctx), item = items.find(candidate => candidate.id === recordId);
  if (!item) fail(404, 'NOT_FOUND', '找不到可讀取的人工追蹤保存紀錄');
  return { item: project(item, cases.get(item.caseId), ctx) };
}
