/** Manual institution administration. No attendance, billing or external dispatch. */
export const institutionEventEntity = 'institution-events';
export const complaintEntity = 'complaints';
export const institutionEventCategories = ['meeting', 'training', 'administration', 'other'];
export const complaintCategories = ['service_quality', 'personnel', 'safety', 'fees', 'other'];
export const complaintStatuses = ['received', 'in_progress', 'closed', 'cancelled'];
export const institutionAdminEntities = {
  [institutionEventEntity]: {
    fields: 'title date startTime endTime category location note status',
    required: ['title', 'date', 'startTime', 'endTime', 'category'],
    statuses: ['active', 'cancelled'],
    defaults: { status: 'active', category: 'other', location: '', note: '' },
    maxLengths: { title: 200, date: 10, startTime: 5, endTime: 5, category: 30, location: 300, note: 10000, status: 30 },
  },
  [complaintEntity]: {
    fields: 'title receivedDate category content receiverEmployeeId responsibleEmployeeId caseId employeeId handlingLog resolution closedDate status',
    required: ['title', 'receivedDate', 'category', 'content', 'receiverEmployeeId', 'responsibleEmployeeId'],
    statuses: complaintStatuses,
    defaults: { status: 'received', caseId: '', employeeId: '', handlingLog: '', resolution: '', closedDate: '' },
    maxLengths: { title: 200, receivedDate: 10, category: 30, content: 10000, receiverEmployeeId: 100,
      responsibleEmployeeId: 100, caseId: 100, employeeId: 100, handlingLog: 10000, resolution: 10000, closedDate: 10, status: 30 },
  },
};
export const isInstitutionAdminEntity = entity => Object.hasOwn(institutionAdminEntities, entity);

export function guardInstitutionAdminAccess(entity, ctx, readOnly, fail) {
  if (!isInstitutionAdminEntity(entity)) return;
  const allowed = entity === institutionEventEntity && readOnly
    ? ['admin', 'supervisor', 'finance', 'caregiver'] : ['admin', 'supervisor'];
  if (!allowed.includes(ctx.role) || typeof ctx.user?.id !== 'string' || !ctx.user.id)
    fail(403, 'ROLE_FORBIDDEN', entity === complaintEntity
      ? '僅管理者或督導可讀取及維護申訴案件' : '僅管理者或督導可維護機構行事曆');
}

/** Normalize only supplied scalar text; never rewrite an omitted saved field. */
export function normalizeInstitutionAdminPayload(entity, payload) {
  if (!isInstitutionAdminEntity(entity)) return payload;
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
}

export function validateInstitutionAdmin(db, ctx, entity, data, old, fail, dateValid, get) {
  if (!isInstitutionAdminEntity(entity)) return;
  guardInstitutionAdminAccess(entity, ctx, false, fail);
  const spec = institutionAdminEntities[entity];
  for (const [key, maximum] of Object.entries(spec.maxLengths)) {
    if (data[key] !== undefined && (typeof data[key] !== 'string' || data[key].length > maximum))
      fail(422, 'INVALID_FIELD', '機構行政欄位格式或長度不符', { [key]: `請提供最多${maximum}字元的文字` });
  }
  for (const key of spec.required) {
    if (typeof data[key] !== 'string' || !data[key].trim())
      fail(422, 'REQUIRED', '請填寫必要欄位', { [key]: '必填且不能只有空白' });
  }
  if (/\r|\n/.test(data.title)) fail(422, 'INVALID_FIELD', '標題只允許單行文字', { title: '不可包含換行' });
  if (!spec.statuses.includes(data.status)) fail(422, 'INVALID_STATUS', '機構行政狀態不合法', { status: '請選擇合法狀態' });
  const validDate = value => typeof value === 'string' && value.slice(0, 4) !== '0000' && dateValid(value);
  const dateKey = entity === institutionEventEntity ? 'date' : 'receivedDate';
  if (!validDate(data[dateKey])) fail(422, 'INVALID_DATE', '日期須為0001至9999的有效YYYY-MM-DD', { [dateKey]: '日期格式錯誤' });
  if (entity === institutionEventEntity) {
    if (!institutionEventCategories.includes(data.category)) fail(422, 'INVALID_CATEGORY', '行事分類不合法', { category: '請選擇合法分類' });
    for (const key of ['startTime', 'endTime']) if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(data[key]))
      fail(422, 'TIME_RANGE', '請提供同日有效HH:mm時間', { [key]: '時間格式錯誤' });
    if (data.endTime <= data.startTime) fail(422, 'TIME_RANGE', '結束時間必須晚於開始時間', { endTime: '請核對同日起訖' });
    if (typeof data.location === 'string' && /\r|\n/.test(data.location))
      fail(422, 'INVALID_FIELD', '地點只允許單行文字', { location: '不可包含換行' });
    return;
  }
  if (!complaintCategories.includes(data.category)) fail(422, 'INVALID_CATEGORY', '申訴分類不合法', { category: '請選擇合法分類' });
  for (const key of ['receiverEmployeeId', 'responsibleEmployeeId', 'employeeId', 'caseId']) {
    if (!data[key]) continue;
    const kind = key === 'caseId' ? 'cases' : 'employees';
    if (!get(db, ctx.orgId, kind, data[key])) fail(422, 'INVALID_REFERENCE', '關聯資料不存在或不屬於本機構', { [key]: '請選擇同機構資料' });
  }
  if (!old && data.status !== 'received')
    fail(422, 'COMPLAINT_STATE', '新增申訴須從已受理開始', { status: '請先受理，再記錄處理進度' });
  const transitions = { received: ['received', 'in_progress', 'cancelled'], in_progress: ['in_progress', 'closed', 'cancelled'], closed: ['closed'], cancelled: ['cancelled'] };
  if (old && !transitions[old.status]?.includes(data.status))
    fail(409, 'COMPLAINT_STATE', '此申訴狀態無法轉移；結案或取消後只可更正同狀態內容', { status: '請重新讀取目前狀態' });
  if (['closed', 'cancelled'].includes(data.status) && !data.resolution?.trim())
    fail(422, 'REQUIRED', '結案或取消須記錄處理結果或取消原因', { resolution: '請填寫結果或原因' });
  if (data.status === 'closed') {
    if (!validDate(data.closedDate)) fail(422, 'INVALID_DATE', '結案須填寫有效結案日期', { closedDate: '請填寫結案日期' });
    if (data.closedDate < data.receivedDate) fail(422, 'DATE_RANGE', '結案日期不可早於受理日期', { closedDate: '請核對受理與結案日期' });
  } else if (data.closedDate) fail(422, 'COMPLAINT_STATE', '只有已結案案件可填結案日期', { closedDate: '請清空結案日期' });
}

/** Closed query contract; no accidental broad generic search of reference IDs. */
export function institutionAdminQuery(entity, params, fail, dateValid, mode = 'list') {
  if (!isInstitutionAdminEntity(entity)) return {};
  const dateKey = entity === institutionEventEntity ? 'date' : 'receivedDate';
  const allowed = mode === 'history' ? ['page', 'pageSize', 'compare'] : ['page', 'pageSize', 'q', 'status', 'category', dateKey];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1)
    fail(422, 'INVALID_QUERY', '機構行政查詢欄位不合法或重複', { [key]: '請使用單一合法查詢欄位' });
  const integer = (key, fallback, maximum) => {
    const raw = params.has(key) ? params.get(key) : String(fallback), value = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value > maximum)
      fail(422, 'PAGINATION', '分頁參數不合法', { [key]: '請提供範圍內的正整數' });
    return value;
  };
  const page = integer('page', 1, Math.floor(Number.MAX_SAFE_INTEGER / 100)), pageSize = integer('pageSize', 25, 100);
  const q = params.get('q') || '', status = params.get('status') || '', category = params.get('category') || '', date = params.get(dateKey) || '';
  if (q.length > 200) fail(422, 'INVALID_QUERY', '搜尋文字最多200字元', { q: '搜尋文字過長' });
  if (params.has('status') && !institutionAdminEntities[entity].statuses.includes(status)) fail(422, 'INVALID_STATUS', '查詢狀態不合法', { status: '請選擇合法狀態' });
  if (params.has('category') && !(entity === institutionEventEntity ? institutionEventCategories : complaintCategories).includes(category))
    fail(422, 'INVALID_CATEGORY', '查詢分類不合法', { category: '請選擇合法分類' });
  if (params.has(dateKey) && (date.slice(0, 4) === '0000' || !dateValid(date))) fail(422, 'INVALID_DATE', '查詢日期不合法', { [dateKey]: '請提供有效YYYY-MM-DD' });
  const compare = params.has('compare') ? params.get('compare') : undefined;
  if (compare !== undefined && compare !== 'previous') fail(422, 'INVALID_COMPARE', '只支援compare=previous', { compare: '比較方式不合法' });
  return { page, pageSize, q, status, category, date, dateKey, compare };
}

export function filterInstitutionAdmin(entity, items, query) {
  if (!isInstitutionAdminEntity(entity)) return items;
  const searchFields = entity === institutionEventEntity ? ['title', 'location', 'note'] : ['title', 'content', 'handlingLog', 'resolution'];
  const q = (query.q || '').toLowerCase();
  return items.filter(item => (!query.status || item.status === query.status) && (!query.category || item.category === query.category)
    && (!query.date || item[query.dateKey] === query.date)
    && (!q || searchFields.some(key => typeof item[key] === 'string' && item[key].toLowerCase().includes(q))));
}
