/** Personal manual events never assign staff, alter shifts or send notifications. */
export const personalCalendarEntity = 'personal-calendar-events';
export const personalCalendarFields = ['title', 'date', 'startTime', 'endTime', 'note', 'status'];
export const personalCalendarEntities = {
  [personalCalendarEntity]: {
    fields: personalCalendarFields.join(' '),
    required: ['title', 'date', 'startTime', 'endTime'],
    statuses: ['active', 'cancelled'],
    defaults: { status: 'active', note: '' },
  },
};
export const isPersonalCalendarEntity = entity => entity === personalCalendarEntity;
const identifier = value => typeof value === 'string' && !!value.trim();

export function guardPersonalCalendarAccess(entity, ctx, fail) {
  if (isPersonalCalendarEntity(entity) && (!['admin', 'supervisor', 'caregiver', 'finance'].includes(ctx.role) || !identifier(ctx.user?.id)))
    fail(403, 'ROLE_FORBIDDEN', '此角色無權使用個人行事曆');
}

export function personalCalendarOwned(item, ctx) {
  return item !== null && typeof item === 'object' && !Array.isArray(item)
    && item.orgId === ctx.orgId && typeof item.ownerUserId === 'string' && item.ownerUserId === ctx.user.id;
}

export function assertPersonalCalendarItem(item, ctx, fail, { nextVersion = false } = {}) {
  if (!personalCalendarOwned(item, ctx)) fail(404, 'NOT_FOUND', '找不到本人行事事件');
  if (!identifier(item.id) || !identifier(item.orgId) || !Number.isSafeInteger(item.version) || item.version < 1
      || (nextVersion && item.version === Number.MAX_SAFE_INTEGER))
    fail(409, 'CALENDAR_DATA_INVALID', '無法確認保存的行事事件識別或版次');
  return item;
}

export function validatePersonalCalendar(entity, data, old, ctx, fail, dateValid) {
  if (!isPersonalCalendarEntity(entity)) return;
  guardPersonalCalendarAccess(entity, ctx, fail);
  if (data.ownerUserId !== ctx.user.id || (old && (!personalCalendarOwned(old, ctx) || data.ownerUserId !== old.ownerUserId)))
    fail(404, 'NOT_FOUND', '找不到本人行事事件');
  for (const [key, maximum] of Object.entries({ title: 200, date: 10, startTime: 5, endTime: 5, note: 10000, status: 500 })) {
    if (data[key] !== undefined && (typeof data[key] !== 'string' || data[key].length > maximum))
      fail(422, 'INVALID_FIELD', '行事事件欄位格式或長度不符', { [key]: '請提供最多' + maximum + '字元的文字' });
  }
  for (const key of ['title', 'date', 'startTime', 'endTime']) {
    if (typeof data[key] !== 'string' || !data[key].trim())
      fail(422, 'REQUIRED', '請填寫必要行事事件欄位', { [key]: '必填且不能只有空白' });
  }
  if (/[\r\n]/.test(data.title)) fail(422, 'INVALID_FIELD', '標題只允許單行文字', { title: '不可包含換行' });
  if (!personalCalendarDate(data.date, dateValid)) fail(422, 'INVALID_DATE', '日期須為0001至9999的有效YYYY-MM-DD', { date: '日期格式錯誤' });
  for (const key of ['startTime', 'endTime']) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(data[key]))
      fail(422, 'TIME_RANGE', '請提供同日有效HH:mm時間', { [key]: '時間格式錯誤' });
  }
  if (data.endTime <= data.startTime) fail(422, 'TIME_RANGE', '結束時間必須晚於開始時間', { endTime: '請核對同日起訖' });
}

export function personalCalendarDate(value, dateValid) {
  return typeof value === 'string' && value.slice(0, 4) !== '0000' && dateValid(value);
}

/** Read SQL integers before scoping; an invisible import cannot cause an unsafe-number error. */
export function personalCalendarReader(db) {
  return { prepare(sql) {
    const statement = db.prepare(sql);
    if (sql !== 'SELECT * FROM records WHERE org_id=? AND entity=? ORDER BY created_at DESC,id') return statement;
    statement.setReadBigInts(true);
    return { all(...bindings) {
      return statement.all(...bindings).filter(row => {
        // No parseable data means ownership cannot be established. This read
        // adapter is used only for personal events; generic decoding is intact.
        try { JSON.parse(row.data); return true; } catch { return false; }
      }).map(row => ({ ...row, version: personalCalendarSqlVersion(row.version) }));
    } };
  } };
}

export function personalCalendarSqlVersion(value) {
  return typeof value === 'bigint' && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

export function personalCalendarQuery(params, mode, fail, dateValid) {
  const allowed = mode === 'list' ? ['page', 'pageSize', 'q', 'status', 'date'] : mode === 'history' ? ['page', 'pageSize', 'compare'] : [];
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1)
      fail(422, 'INVALID_QUERY', '行事曆查詢欄位不合法或重複', { [key]: '請使用單一合法查詢欄位' });
  }
  const integer = (key, fallback, maximum) => {
    const raw = params.has(key) ? params.get(key) : String(fallback), value = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value > maximum)
      fail(422, 'PAGINATION', 'page須為正安全整數，pageSize介於1至100', { [key]: '分頁不合法' });
    return value;
  };
  const page = integer('page', 1, Number.MAX_SAFE_INTEGER), pageSize = integer('pageSize', 25, 100);
  const q = params.get('q') || '', status = params.get('status') || '', date = params.get('date') || '';
  if (q.length > 200) fail(422, 'INVALID_QUERY', '搜尋文字最多200字元', { q: '搜尋文字過長' });
  if (status && !['active', 'cancelled'].includes(status)) fail(422, 'INVALID_STATUS', '行事事件狀態不合法', { status: '狀態不合法' });
  if (date && !personalCalendarDate(date, dateValid)) fail(422, 'INVALID_DATE', '查詢日期須為有效YYYY-MM-DD', { date: '日期格式錯誤' });
  const compare = params.has('compare') ? params.get('compare') : undefined;
  if (compare !== undefined && compare !== 'previous') fail(422, 'INVALID_COMPARE', '只支援compare=previous', { compare: '比較方式不合法' });
  return { page, pageSize, q, status, date, compare };
}

export function filterPersonalCalendar(items, query) {
  const q = query.q.toLowerCase();
  return items.filter(item => (!query.status || item.status === query.status) && (!query.date || item.date === query.date)
    && (!q || ['title', 'note'].some(key => Object.hasOwn(item, key) && typeof item[key] === 'string' && item[key].toLowerCase().includes(q))));
}
