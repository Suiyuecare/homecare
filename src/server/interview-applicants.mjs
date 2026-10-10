/** Administrative interview records do not create employment or login grants. */
export const interviewApplicantStatuses = ['active', 'inactive'];
export const interviewApplicantEntities = {
  'interview-applicants': {
    fields: 'name phone interviewDate city district interviewContent note status',
    required: ['name', 'phone', 'interviewDate', 'interviewContent'],
    statuses: interviewApplicantStatuses,
    defaults: { status: 'active', city: '', district: '', note: '' },
  },
};
export const isInterviewApplicantEntity = entity => Object.hasOwn(interviewApplicantEntities, entity);

export function guardInterviewApplicantAccess(entity, ctx, _readOnly, fail) {
  if (isInterviewApplicantEntity(entity) && !['admin', 'supervisor'].includes(ctx.role))
    fail(403, 'ROLE_FORBIDDEN', '僅管理者或督導可讀取及維護面試者紀錄');
}

export function normalizeInterviewApplicantPayload(entity, payload) {
  if (!isInterviewApplicantEntity(entity)) return payload;
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
}

export function validateInterviewApplicant(entity, data, fail, dateValid) {
  if (!isInterviewApplicantEntity(entity)) return;
  for (const [key, maximum] of Object.entries({ name: 200, phone: 64, interviewDate: 500, city: 100, district: 100, interviewContent: 10000, note: 10000, status: 500 })) {
    if (data[key] !== undefined && (typeof data[key] !== 'string' || data[key].length > maximum))
      fail(422, 'INVALID_FIELD', '面試欄位格式或長度不符', { [key]: `請提供最多${maximum}字元的文字` });
  }
  for (const key of ['name', 'phone', 'interviewDate', 'interviewContent']) {
    if (typeof data[key] !== 'string' || !data[key].trim())
      fail(422, 'REQUIRED', '請填寫必要面試欄位', { [key]: '必填且不能只有空白' });
  }
  for (const key of ['name', 'phone', 'city', 'district']) {
    if (typeof data[key] === 'string' && /[\r\n]/.test(data[key]))
      fail(422, 'INVALID_FIELD', '此欄只允許單行文字', { [key]: '不可包含換行' });
  }
  if (!dateValid(data.interviewDate)) fail(422, 'INVALID_DATE', '面試日期必須為有效YYYY-MM-DD', { interviewDate: '日期格式錯誤' });
}

/** Query keys are closed for this entity; no existing caller is changed. */
export function interviewApplicantQuery(entity, searchParams, fail, dateValid) {
  if (!isInterviewApplicantEntity(entity)) return {};
  const allowed = new Set(['page', 'pageSize', 'q', 'status', 'interviewDate']);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1)
      fail(422, 'INVALID_QUERY', '面試查詢欄位不合法或重複', { [key]: '請使用單一合法查詢欄位' });
  }
  if (searchParams.has('q') && searchParams.get('q').length > 200) fail(422, 'INVALID_QUERY', '搜尋文字最多200字', { q: '搜尋文字過長' });
  if (searchParams.has('status') && !interviewApplicantStatuses.includes(searchParams.get('status')))
    fail(422, 'INVALID_STATUS', '面試名單狀態不合法', { status: '狀態不合法' });
  if (searchParams.has('interviewDate') && !dateValid(searchParams.get('interviewDate')))
    fail(422, 'INVALID_DATE', '面試查詢日期須為有效YYYY-MM-DD', { interviewDate: '日期格式錯誤' });
  return { interviewDate: searchParams.get('interviewDate') || undefined };
}
