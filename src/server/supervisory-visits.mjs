import { dateValid, fail, scopedRows } from './model.mjs';
import { safeVersionReader } from './report-query.mjs';

const templateId = 'assessment-04';
const questions = Object.freeze(Array.from({ length: 10 }, (_, index) => 'q' + String(index + 1).padStart(3, '0')));
const statuses = new Set(['draft', 'submitted']);
const identifier = value => typeof value === 'string' && Boolean(value.trim());
const invalid = () => fail(409, 'VISIT_DATA_INVALID', '符合查詢的督導訪視保存資料不完整，請先核對；本次未呈現紀錄。');

export function guardSupervisoryVisitAccess(ctx) {
  if (!['admin', 'supervisor'].includes(ctx.role))
    fail(403, 'ROLE_FORBIDDEN', '僅管理者或督導可讀取督導訪視保存紀錄');
}

function parseQuery(params) {
  const allowed = new Set(['page', 'pageSize', 'q', 'status', 'date', 'caseId']);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1)
      fail(422, 'INVALID_QUERY', '不允許未知或重複的訪視查詢參數', { [key]: '查詢參數不合法' });
  }
  const filters = Object.fromEntries(['q', 'status', 'date', 'caseId'].map(key => [key, params.get(key) || '']));
  if (filters.q.length > 200) fail(422, 'INVALID_QUERY', '搜尋文字最多200字元', { q: '搜尋文字過長' });
  if (filters.status && !statuses.has(filters.status)) fail(422, 'INVALID_STATUS', '不支援的訪視保存狀態', { status: '狀態不合法' });
  if (filters.date && !dateValid(filters.date)) fail(422, 'INVALID_DATE', '填寫日期須為有效YYYY-MM-DD', { date: '日期格式錯誤' });
  if (filters.caseId && (!identifier(filters.caseId) || filters.caseId.length > 500)) fail(422, 'INVALID_QUERY', '請提供有效個案識別', { caseId: '不可只有空白且最多500字元' });
  const integer = (key, fallback, maximum) => {
    const raw = params.has(key) ? params.get(key) : String(fallback), value = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value > maximum)
      fail(422, 'PAGINATION', 'page須為正整數，pageSize介於1至100', { [key]: '分頁不合法' });
    return value;
  };
  return { filters, page: integer('page', 1, Number.MAX_SAFE_INTEGER), pageSize: integer('pageSize', 25, 100) };
}

/** Only primitives receive a tag; nested and unknown contents never enter the DTO. */
function kind(value, present) {
  if (!present) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'number' && !Number.isFinite(value)) invalid();
  if (['string', 'number', 'boolean'].includes(typeof value)) return typeof value;
  invalid();
}

function visibleAnswers(item) {
  return Object.hasOwn(item, 'answers') && item.answers !== null && typeof item.answers === 'object' && !Array.isArray(item.answers) ? item.answers : null;
}

function authorizedRows(db, ctx) {
  const reader = safeVersionReader(db);
  const cases = new Map(scopedRows(reader, ctx, 'cases').filter(item => item.orgId === ctx.orgId).map(item => [item.id, item]));
  const items = scopedRows(reader, ctx, 'assessments').filter(item => item.templateId === templateId && cases.has(item.caseId));
  return { cases, items };
}

function project(item, parent, ctx) {
  if (!identifier(item.id) || item.orgId !== ctx.orgId || !identifier(item.orgId) || !identifier(item.caseId) ||
      !parent || parent.orgId !== ctx.orgId || parent.id !== item.caseId || !Number.isSafeInteger(item.version) || item.version < 1 ||
      !dateValid(item.date) || !statuses.has(item.status)) invalid();
  const answerContainerKind = kind(item.answers, Object.hasOwn(item, 'answers'));
  const source = visibleAnswers(item);
  const answers = Object.fromEntries(questions.map(key => {
    const present = source !== null && Object.hasOwn(source, key), value = present ? source[key] : undefined;
    const tag = kind(value, present);
    return [key, tag === 'string' ? { kind: tag, value } : { kind: tag }];
  }));
  return {
    id: item.id, orgId: item.orgId, version: item.version, templateId, caseId: item.caseId,
    caseNo: typeof parent.caseNo === 'string' ? parent.caseNo : '', caseName: typeof parent.name === 'string' ? parent.name : '',
    date: item.date, status: item.status, answerContainerKind,
    hasUnknownAnswerKeys: source !== null && Object.keys(source).some(key => !questions.includes(key)), answers,
  };
}

/** Validation covers every selected candidate before paging; unrelated saved data is not repaired. */
export function readSupervisoryVisits(db, ctx, params) {
  guardSupervisoryVisitAccess(ctx);
  const { filters, page, pageSize } = parseQuery(params), { cases, items } = authorizedRows(db, ctx);
  if (filters.caseId && !cases.has(filters.caseId)) fail(404, 'NOT_FOUND', '找不到可讀取的查詢個案');
  const q = filters.q.toLowerCase();
  const selected = items.filter(item => {
    if ((filters.caseId && item.caseId !== filters.caseId) || (filters.date && item.date !== filters.date) || (filters.status && item.status !== filters.status)) return false;
    const answers = visibleAnswers(item);
    return !q || (answers !== null && questions.some(key => Object.hasOwn(answers, key) && typeof answers[key] === 'string' && answers[key].toLowerCase().includes(q)));
  });
  const projected = selected.map(item => project(item, cases.get(item.caseId), ctx));
  return { items: projected.slice((page - 1) * pageSize, page * pageSize), total: projected.length, page, pageSize, filters };
}

export function readSupervisoryVisit(db, ctx, recordId, params) {
  guardSupervisoryVisitAccess(ctx);
  if ([...params.keys()].length) fail(422, 'INVALID_QUERY', '單筆督導訪視讀取不接受查詢參數');
  const { cases, items } = authorizedRows(db, ctx), item = items.find(candidate => candidate.id === recordId);
  if (!item) fail(404, 'NOT_FOUND', '找不到可讀取的督導訪視保存紀錄');
  return { item: project(item, cases.get(item.caseId), ctx) };
}
