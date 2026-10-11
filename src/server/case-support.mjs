/** Human-authored case support documentation. No diagnosis, scoring or prescription engine. */
export const caseSupportEntities = {
  'case-relationships': {
    fields: 'caseId kind name role relationship direction support date source status note',
    required: ['caseId', 'kind', 'name', 'relationship', 'date'],
    statuses: ['active', 'inactive'],
    defaults: { kind: 'family', role: '', direction: 'bidirectional', support: 'unknown', source: '', status: 'active', note: '' },
  },
  'medical-opinions': {
    fields: 'caseId date practitionerName profession organization summary recommendation followUpDate source status note',
    required: ['caseId', 'date', 'practitionerName', 'summary'],
    statuses: ['active', 'inactive'],
    defaults: { profession: '', organization: '', recommendation: '', followUpDate: '', source: '', status: 'active', note: '' },
  },
};
export const isCaseSupportEntity = entity => Object.hasOwn(caseSupportEntities, entity);

export function guardCaseSupportAccess(entity, ctx, _readOnly, fail) {
  if (isCaseSupportEntity(entity) && !['admin', 'supervisor'].includes(ctx.role))
    fail(403, 'ROLE_FORBIDDEN', '僅管理者或督導可讀取與維護個案關係及醫事意見');
}

export function normalizeCaseSupportPayload(entity, payload) {
  if (!isCaseSupportEntity(entity)) return payload;
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
}

export function validateCaseSupport(entity, data, old, fail, dateValid, db, ctx, get) {
  if (!isCaseSupportEntity(entity)) return;
  if (old && data.caseId !== old.caseId)
    fail(409, 'CASE_IMMUTABLE', '建立後不可更換紀錄所屬個案', { caseId: '不可變更' });
  const spec = caseSupportEntities[entity];
  for (const key of spec.fields.split(' ')) {
    const maximum = key === 'note' ? 10000 : ['name', 'practitionerName', 'profession', 'role', 'relationship'].includes(key) ? 100 : 500;
    if (data[key] !== undefined && (typeof data[key] !== 'string' || data[key].length > maximum))
      fail(422, 'INVALID_FIELD', '紀錄欄位格式或長度不符', { [key]: `請提供最多${maximum}字的文字` });
  }
  for (const key of spec.required) if (typeof data[key] !== 'string' || !data[key].trim())
    fail(422, 'REQUIRED', '請填寫必要欄位', { [key]: '必填且不能只有空白' });
  for (const key of ['date', 'followUpDate']) if ((key === 'date' || data[key]) && (!dateValid(data[key]) || data[key].startsWith('0000-')))
    fail(422, 'INVALID_DATE', '日期必須為有效YYYY-MM-DD', { [key]: '請核對日期' });
  if (!spec.statuses.includes(data.status)) fail(422, 'INVALID_STATUS', '只允許使用中或已停用的紀錄', { status: '狀態不合法' });
  if (entity === 'case-relationships') {
    for (const [key, allowed] of Object.entries({ kind: ['family', 'community'], direction: ['toward_case', 'from_case', 'bidirectional'], support: ['supportive', 'strained', 'neutral', 'unknown'] }))
      if (!allowed.includes(data[key])) fail(422, 'INVALID_OPTION', '請選擇有效的關係分類', { [key]: '選項不合法' });
  }
  // Recheck the immutable parent inside the same transaction as the write.
  if (!get(db, ctx.orgId, 'cases', data.caseId))
    fail(422, 'INVALID_REFERENCE', '個案不存在或不屬於本機構', { caseId: '同機構個案必要' });
}

/** Closed list/single query contract; sensitive search stays out of persistent URL state. */
export function caseSupportQuery(entity, searchParams, fail, dateValid) {
  if (!isCaseSupportEntity(entity)) return {};
  const allowed = new Set(['page', 'pageSize', 'q', 'caseId', 'status', 'date']);
  for (const key of searchParams.keys()) if (!allowed.has(key) || searchParams.getAll(key).length !== 1)
    fail(422, 'INVALID_QUERY', '查詢欄位不合法或重複', { [key]: '請使用單一合法欄位' });
  for (const key of ['caseId', 'q']) if (searchParams.has(key) && (searchParams.get(key).length > (key === 'q' ? 200 : 500) || key === 'caseId' && !searchParams.get(key).trim()))
    fail(422, 'INVALID_QUERY', '查詢文字格式或長度不符', { [key]: '請核對查詢文字' });
  if (searchParams.has('status') && !caseSupportEntities[entity].statuses.includes(searchParams.get('status')))
    fail(422, 'INVALID_STATUS', '紀錄狀態不合法', { status: '狀態不合法' });
  if (searchParams.has('date') && (!dateValid(searchParams.get('date')) || searchParams.get('date').startsWith('0000-')))
    fail(422, 'INVALID_DATE', '查詢日期格式不符', { date: '請使用有效日期' });
  return {};
}
