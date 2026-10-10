import { HttpError, fail, dateValid, interval, validatePayload, validate, insert, audit, id, publicRecord } from './model.mjs';

export const MAX_RECURRING_DAYS = 93;
const DAY_MS = 24 * 60 * 60 * 1000;
const definitionFields = ['caseId', 'employeeId', 'carePlanId', 'startDate', 'endDate', 'intervalWeeks', 'weekdays', 'startTime', 'endTime', 'services', 'note'];
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

export function guardRecurringShiftAccess(ctx) {
  if (!['admin', 'supervisor'].includes(ctx.role)) fail(403, 'ROLE_FORBIDDEN', '只有管理者或督導可預覽及建立週期排班');
}

/** Validate request syntax without reading or changing the database. */
export function recurringDefinition(payload) {
  if (!plainObject(payload)) fail(400, 'INVALID_BODY', '請提供JSON物件');
  for (const key of Object.keys(payload)) {
    if (!definitionFields.includes(key)) fail(422, 'UNKNOWN_FIELD', '不允許的欄位：' + key, { [key]: '未知欄位' });
  }
  for (const key of ['caseId', 'employeeId', 'carePlanId']) {
    if (typeof payload[key] !== 'string' || !payload[key].trim() || payload[key].length > 500) {
      fail(422, 'REQUIRED', '請選擇個案、員工與照顧計畫', { [key]: '必填識別碼' });
    }
  }
  for (const key of ['startDate', 'endDate']) {
    if (!dateValid(payload[key])) fail(422, 'INVALID_DATE', '日期須為有效YYYY-MM-DD', { [key]: '日期格式錯誤' });
  }
  const start = Date.parse(payload.startDate + 'T00:00:00Z'), end = Date.parse(payload.endDate + 'T00:00:00Z');
  if (end < start) fail(422, 'DATE_RANGE', '結束日期不可早於開始日期', { endDate: '須不早於開始日期' });
  if ((end - start) / DAY_MS + 1 > MAX_RECURRING_DAYS) {
    fail(422, 'DATE_RANGE', '週期排班區間含起訖日最多93天', { endDate: '區間最多93天' });
  }
  const intervalWeeks = payload.intervalWeeks === undefined ? 1 : payload.intervalWeeks;
  if (!Number.isSafeInteger(intervalWeeks) || intervalWeeks < 1 || intervalWeeks > 4) {
    fail(422, 'INVALID_INTERVAL', '週期間隔須為1至4的整數', { intervalWeeks: '整數1至4' });
  }
  if (!Array.isArray(payload.weekdays) || !payload.weekdays.length || payload.weekdays.length > 7 ||
      payload.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7) ||
      new Set(payload.weekdays).size !== payload.weekdays.length) {
    fail(422, 'INVALID_WEEKDAYS', '請選擇不重複的服務星期1至7', { weekdays: '至少一項且不可重複' });
  }
  for (const key of ['startTime', 'endTime']) {
    if (typeof payload[key] !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(payload[key])) {
      fail(422, 'INVALID_TIME', '時間須為同日有效HH:mm', { [key]: '時間格式錯誤' });
    }
  }
  interval(payload.startTime, payload.endTime, payload.startDate);
  if (!Array.isArray(payload.services) || !payload.services.length || payload.services.length > 100) {
    fail(422, 'INVALID_SERVICES', '請設定1至100個服務項目', { services: '須設定服務項目與數量' });
  }
  const serviceIds = new Set();
  for (const service of payload.services) {
    if (!plainObject(service) || Object.keys(service).some(key => !['serviceItemId', 'quantity'].includes(key)) ||
        typeof service.serviceItemId !== 'string' || !service.serviceItemId || service.serviceItemId.length > 500 ||
        !Number.isSafeInteger(service.quantity) || service.quantity < 1 || service.quantity > 10000 || serviceIds.has(service.serviceItemId)) {
      fail(422, 'INVALID_SERVICES', '服務識別、整數數量或重複服務不合法', { services: '每項服務須不重複且數量為1至10000的整數' });
    }
    serviceIds.add(service.serviceItemId);
  }
  if (payload.note !== undefined && (typeof payload.note !== 'string' || payload.note.trim().length > 10000)) {
    fail(422, 'INVALID_FIELD', '交班備註須為最多10000字的文字', { note: '最多10000字' });
  }
  return {
    caseId: payload.caseId, employeeId: payload.employeeId, carePlanId: payload.carePlanId,
    startDate: payload.startDate, endDate: payload.endDate, intervalWeeks,
    weekdays: [...payload.weekdays].sort((a, b) => a - b),
    startTime: payload.startTime, endTime: payload.endTime,
    services: payload.services.map(service => ({ serviceItemId: service.serviceItemId, quantity: service.quantity })),
    note: payload.note?.trim() || '',
  };
}

/** UTC calendar arithmetic: week zero starts on the start date's Monday. */
export function recurringDates(definition) {
  const start = Date.parse(definition.startDate + 'T00:00:00Z'), end = Date.parse(definition.endDate + 'T00:00:00Z');
  const monday = start - ((new Date(start).getUTCDay() + 6) % 7) * DAY_MS;
  const selected = new Set(definition.weekdays), dates = [];
  for (let date = start; date <= end; date += DAY_MS) {
    const week = Math.floor((date - monday) / (7 * DAY_MS));
    const weekday = ((new Date(date).getUTCDay() + 6) % 7) + 1;
    if (week % definition.intervalWeeks === 0 && selected.has(weekday)) dates.push(new Date(date).toISOString().slice(0, 10));
  }
  if (!dates.length) fail(422, 'NO_OCCURRENCES', '此日期區間沒有符合條件的服務日', { weekdays: '請調整日期或服務星期' });
  return dates;
}

function candidate(definition, date) {
  return validatePayload('shifts', {
    caseId: definition.caseId, employeeId: definition.employeeId, carePlanId: definition.carePlanId,
    date, startTime: definition.startTime, endTime: definition.endTime,
    services: definition.services.map(service => ({ ...service })), note: definition.note, status: 'scheduled',
  });
}

export function previewRecurringShifts(db, ctx, payload) {
  guardRecurringShiftAccess(ctx);
  const definition = recurringDefinition(payload);
  const items = recurringDates(definition).map(date => {
    const conflicts = [];
    try { validate(db, ctx, 'shifts', candidate(definition, date)); }
    catch (error) {
      if (!(error instanceof HttpError)) throw error;
      conflicts.push({ code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) });
    }
    return { date, startTime: definition.startTime, endTime: definition.endTime, status: conflicts.length ? 'conflict' : 'ready', conflicts };
  });
  const conflictCount = items.filter(item => item.status === 'conflict').length;
  return { definition, items, total: items.length, readyCount: items.length - conflictCount, conflictCount, canCommit: items.length > 0 && conflictCount === 0 };
}

/** Must run inside the caller's single idempotency/BEGIN IMMEDIATE transaction. */
export function commitRecurringShifts(db, ctx, payload) {
  const preview = previewRecurringShifts(db, ctx, payload);
  if (!preview.canCommit) {
    const error = new HttpError(409, 'BATCH_CONFLICT', '排班條件已重新檢查，請處理所有衝突後再預覽');
    error.details = { preview };
    throw error;
  }
  const batchId = id(), items = [];
  for (const occurrence of preview.items) {
    const data = candidate(preview.definition, occurrence.date);
    validate(db, ctx, 'shifts', data);
    const item = insert(db, ctx.orgId, 'shifts', data);
    audit(db, ctx, 'record.create', 'shifts', item.id, { status: item.status, version: 1, operation: 'recurring-shifts', batchId });
    items.push(publicRecord(ctx, item));
  }
  return { batchId, items, total: items.length };
}
