/** Manual follow-up documentation never changes a case's service status. */
export const caseStatusFollowupKinds = ['pause', 'closure'];
export const caseStatusFollowupStatuses = ['pending', 'completed', 'cancelled'];
export const caseStatusFollowupEntities = {
  'case-status-followups': {
    fields: 'caseId kind startDate endDate reason followUpDate outcome note status',
    required: ['caseId', 'kind', 'startDate', 'reason'],
    statuses: caseStatusFollowupStatuses,
    defaults: { status: 'pending', endDate: '', followUpDate: '', outcome: '', note: '' },
  },
};
export const isCaseStatusFollowupEntity = entity => Object.hasOwn(caseStatusFollowupEntities, entity);

export function guardCaseStatusFollowupAccess(entity, ctx, readOnly, fail) {
  if (!isCaseStatusFollowupEntity(entity)) return;
  const allowed = readOnly ? ['admin', 'supervisor', 'caregiver', 'finance'] : ['admin', 'supervisor'];
  if (!allowed.includes(ctx.role)) fail(403, 'ROLE_FORBIDDEN', '此角色無權變更或讀取個案暫停與結案追蹤');
}

export function normalizeCaseStatusFollowupPayload(entity, payload) {
  if (!isCaseStatusFollowupEntity(entity)) return payload;
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
}

export function validateCaseStatusFollowup(entity, data, old, fail, dateValid) {
  if (!isCaseStatusFollowupEntity(entity)) return;
  if (old && data.caseId !== old.caseId) fail(409, 'CASE_IMMUTABLE', '建立後不可更換追蹤紀錄所屬個案', { caseId: '不可變更' });
  for (const [key, maximum] of Object.entries({ caseId: 500, kind: 500, startDate: 500, endDate: 500, reason: 10000, followUpDate: 500, outcome: 500, note: 10000, status: 500 })) {
    if (data[key] !== undefined && (typeof data[key] !== 'string' || data[key].length > maximum)) fail(422, 'INVALID_FIELD', '追蹤欄位格式或長度不符', { [key]: `文字長度不可超過${maximum}字` });
  }
  if (typeof data.reason === 'string' && !data.reason.trim()) fail(422, 'REQUIRED', '請填寫必要原因', { reason: '必填且不能只有空白' });
  if (!caseStatusFollowupKinds.includes(data.kind)) fail(422, 'INVALID_KIND', '追蹤類型只允許暫停或結案', { kind: '類型不合法' });
  for (const key of ['startDate', 'endDate', 'followUpDate']) {
    if ((key === 'startDate' || data[key]) && !dateValid(data[key])) fail(422, 'INVALID_DATE', '日期必須為有效YYYY-MM-DD', { [key]: '日期格式錯誤' });
  }
  if (data.endDate && data.endDate < data.startDate) fail(422, 'DATE_RANGE', '結束日期不可早於開始日期', { endDate: '請核對區間' });
}

/** This entity has a closed query contract; other entities retain their queries. */
export function caseStatusFollowupQuery(entity, searchParams, fail) {
  if (!isCaseStatusFollowupEntity(entity)) return {};
  const allowed = new Set(['page', 'pageSize', 'q', 'caseId', 'status', 'kind']);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1) fail(422, 'INVALID_QUERY', '查詢欄位不合法或重複', { [key]: '請使用單一合法查詢欄位' });
  }
  if (searchParams.has('q') && searchParams.get('q').length > 200) fail(422, 'INVALID_QUERY', '搜尋文字最多200字', { q: '搜尋文字過長' });
  if (searchParams.has('caseId') && (!searchParams.get('caseId').trim() || searchParams.get('caseId').length > 500)) fail(422, 'INVALID_QUERY', 'caseId須為非空有限文字', { caseId: '個案查詢格式不符' });
  if (searchParams.has('status') && !caseStatusFollowupStatuses.includes(searchParams.get('status'))) fail(422, 'INVALID_STATUS', '追蹤狀態不合法', { status: '狀態不合法' });
  if (searchParams.has('kind') && !caseStatusFollowupKinds.includes(searchParams.get('kind'))) fail(422, 'INVALID_KIND', '追蹤類型不合法', { kind: '類型不合法' });
  return { kind: searchParams.get('kind') || undefined };
}
