import { RULE_KINDS, RULE_PARAMETERS } from '../../public/data/business-rule-fields.js';
export const businessRuleEntities = { 'business-rules': {
  fields: 'kind code name validFrom validTo sourceReference parameters status note',
  required: ['kind', 'code', 'name', 'validFrom', 'validTo', 'parameters'],
  statuses: ['draft', 'approved', 'inactive'], defaults: { status: 'draft', sourceReference: '', note: '' },
  jsonFields: ['parameters'], maxLengths: { sourceReference: 2000 },
} };
export const isBusinessRuleEntity = entity => entity === 'business-rules';
export function guardBusinessRuleAccess(entity, ctx, readOnly, fail) {
  if (isBusinessRuleEntity(entity) && !(readOnly ? ['admin', 'supervisor', 'finance'] : ['admin']).includes(ctx.role))
    fail(403, 'ROLE_FORBIDDEN', '規則由管理者維護，督導與財務僅可查閱');
}
export function normalizeBusinessRulePayload(entity, data) {
  if (!isBusinessRuleEntity(entity)) return data;
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' && k !== 'note' ? v.trim() : v]));
}
export function validateBusinessRule(db, ctx, entity, data, old, fail, dateValid, rows) {
  if (!isBusinessRuleEntity(entity)) return;
  guardBusinessRuleAccess(entity, ctx, false, fail);
  if (!Object.hasOwn(RULE_KINDS, data.kind)) fail(422, 'INVALID_KIND', '請選擇支援的規則類型', { kind: '類型不合法' });
  for (const k of ['code', 'name']) if (typeof data[k] !== 'string' || !data[k].trim()) fail(422, 'REQUIRED', '請填寫規則代碼與名稱', { [k]: '必填' });
  if (!dateValid(data.validFrom) || !dateValid(data.validTo) || data.validFrom.slice(0, 4) === '0000' || data.validTo.slice(0, 4) === '0000' || data.validTo < data.validFrom)
    fail(422, 'DATE_RANGE', '請填寫有效的規則起訖日期', { validTo: '請核對有效區間' });
  const spec = RULE_PARAMETERS[data.kind], p = data.parameters;
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.getPrototypeOf(p) !== Object.prototype || Object.keys(p).length !== spec.length)
    fail(422, 'INVALID_PARAMETERS', '參數必須符合此類規則', { parameters: '參數欄位不符' });
  for (const d of spec) {
    const v = p[d.key];
    if (d.type === 'text' ? typeof v !== 'string' || !v.trim() || v.length > d.maxLength
      : !Number.isSafeInteger(v) || v < (d.min || 0) || v > d.max) fail(422, 'INVALID_PARAMETERS', '請檢查' + d.label, { [d.key]: '數值或格式不符' });
  }
  if (data.kind === 'assessment' && p.minimumScore > p.maximumScore) fail(422, 'INVALID_PARAMETERS', '最低分數不可高於最高分數', { minimumScore: '請核對上下限' });
  if (!old && data.status !== 'draft') fail(422, 'APPROVAL_REQUIRED', '新規則必須先建立待核定版本');
  if (old && (data.kind !== old.kind || data.code !== old.code)) fail(409, 'RULE_IDENTITY_IMMUTABLE', '建立後不可更換規則類型與代碼');
  if (old && old.status !== 'draft') {
    const keys = Object.keys(businessRuleEntities[entity].defaults).concat(['kind', 'code', 'name', 'validFrom', 'validTo', 'sourceReference', 'parameters']);
    if (data.status !== 'inactive' || keys.filter(k => k !== 'status').some(k => JSON.stringify(data[k]) !== JSON.stringify(old[k])))
      fail(409, 'RULE_LOCKED', '核定或停用版本不可改寫；請建立新的待核定版本');
  }
  if (data.status === 'approved') {
    if (typeof data.sourceReference !== 'string' || !data.sourceReference.trim()) fail(422, 'SOURCE_REQUIRED', '核定前請填寫依據與規格來源', { sourceReference: '核定依據必填' });
    if (rows(db, ctx.orgId, entity).some(x => x.id !== old?.id && x.kind === data.kind && x.code === data.code && x.status === 'approved' && x.validFrom <= data.validTo && data.validFrom <= x.validTo))
      fail(409, 'RULE_PERIOD_CONFLICT', '相同規則代碼已有重疊期間的核定版本');
  }
}
export function businessRuleQuery(entity, params, fail) {
  if (!isBusinessRuleEntity(entity)) return {};
  for (const k of params.keys()) if (!['page', 'pageSize', 'q', 'status', 'kind'].includes(k) || params.getAll(k).length !== 1) fail(422, 'INVALID_QUERY', '規則查詢欄位不合法或重複');
  if (params.has('kind') && !Object.hasOwn(RULE_KINDS, params.get('kind'))) fail(422, 'INVALID_KIND', '規則類型不合法');
  if (params.has('status') && !businessRuleEntities[entity].statuses.includes(params.get('status'))) fail(422, 'INVALID_STATUS', '規則狀態不合法');
  if ((params.get('q') || '').length > 200) fail(422, 'INVALID_QUERY', '搜尋文字最多200字');
  return { kind: params.get('kind') || undefined };
}
