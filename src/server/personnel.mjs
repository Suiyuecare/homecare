/** Personnel records carry no statutory credit, scheduling or payment rules. */
export const personnelEntities = {
  'employee-certifications': {
    fields: 'employeeId name certificateNo issuer issuedOn expiresOn status note',
    required: ['employeeId', 'name', 'issuedOn'],
    statuses: ['active', 'revoked'],
    defaults: { status: 'active', expiresOn: '' },
  },
  'employee-training': {
    fields: 'employeeId name category provider date trainingMinutes status note',
    required: ['employeeId', 'name', 'category', 'date', 'trainingMinutes'],
    statuses: ['completed', 'cancelled'],
    defaults: { status: 'completed' },
  },
};

export const trainingCategories = ['pre_service', 'in_service', 'other'];
export const expiryStates = ['expired', 'due_soon', 'valid', 'no_expiry', 'revoked'];
export const isPersonnelEntity = entity => Object.hasOwn(personnelEntities, entity);

export function guardPersonnelAccess(entity, ctx, readOnly, fail) {
  if (!isPersonnelEntity(entity)) return;
  const allowed = readOnly ? ['admin', 'supervisor', 'caregiver'] : ['admin', 'supervisor'];
  if (!allowed.includes(ctx.role)) {
    fail(403, 'ROLE_FORBIDDEN', '此角色無權存取或變更員工證照及訓練紀錄');
  }
}

export function normalizePersonnelPayload(entity, payload) {
  if (!isPersonnelEntity(entity) || typeof payload.name !== 'string') return payload;
  return { ...payload, name: payload.name.trim() };
}

// Shared primitives are passed in to avoid a circular dependency on model.mjs.
export function validatePersonnel(entity, data, old, fail, dateValid) {
  if (!isPersonnelEntity(entity)) return;
  if (old && data.employeeId !== old.employeeId) {
    fail(409, 'EMPLOYEE_IMMUTABLE', '建立後不可更換紀錄所屬員工', { employeeId: '不可變更' });
  }
  if (typeof data.name !== 'string' || !data.name.trim()) {
    fail(422, 'REQUIRED', '名稱不可空白', { name: '必填' });
  }
  if (entity === 'employee-certifications') {
    if (!dateValid(data.issuedOn)) {
      fail(422, 'INVALID_DATE', '發證日期必須為有效YYYY-MM-DD', { issuedOn: '日期格式錯誤' });
    }
    if (data.expiresOn !== '' && data.expiresOn !== undefined && !dateValid(data.expiresOn)) {
      fail(422, 'INVALID_DATE', '到期日期須為有效YYYY-MM-DD或空白', { expiresOn: '日期格式錯誤' });
    }
    if (data.expiresOn && data.expiresOn < data.issuedOn) {
      fail(422, 'DATE_RANGE', '到期日期不可早於發證日期', { expiresOn: '須不早於發證日期' });
    }
  } else {
    if (!dateValid(data.date)) {
      fail(422, 'INVALID_DATE', '訓練日期必須為有效YYYY-MM-DD', { date: '日期格式錯誤' });
    }
    if (!trainingCategories.includes(data.category)) {
      fail(422, 'INVALID_CATEGORY', '訓練類別須為職前、在職或其他', { category: '類別不合法' });
    }
    if (!Number.isSafeInteger(data.trainingMinutes) || data.trainingMinutes < 1 || data.trainingMinutes > 60000) {
      fail(422, 'INVALID_NUMBER', '訓練分鐘數須為1至60000的整數', { trainingMinutes: '正整數1至60000' });
    }
  }
}

export function taipeiToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export function personnelQuery(entity, searchParams, fail, dateValid) {
  if (entity === 'employee-certifications') {
    const asOf = searchParams.has('asOf') ? searchParams.get('asOf') : taipeiToday();
    if (!dateValid(asOf)) fail(422, 'INVALID_DATE', 'asOf須為有效YYYY-MM-DD', { asOf: '日期格式錯誤' });
    const expiry = searchParams.has('expiry') ? searchParams.get('expiry') : null;
    if (expiry !== null && !expiryStates.includes(expiry)) {
      fail(422, 'INVALID_EXPIRY', '不支援的證照到期篩選', { expiry: '篩選值不合法' });
    }
    return { asOf, expiry };
  }
  if (entity === 'employee-training') {
    if (searchParams.has('date') && !dateValid(searchParams.get('date'))) {
      fail(422, 'INVALID_DATE', 'date須為有效YYYY-MM-DD', { date: '日期格式錯誤' });
    }
    const category = searchParams.has('category') ? searchParams.get('category') : null;
    if (category !== null && !trainingCategories.includes(category)) {
      fail(422, 'INVALID_CATEGORY', '不支援的訓練類別篩選', { category: '類別不合法' });
    }
    return { category };
  }
  return {};
}

/** Only call for validated dates, at read time; never persist these fields. */
export function certificationView(item, asOf) {
  const daysToExpiry = item.expiresOn
    ? Math.round((Date.parse(item.expiresOn + 'T00:00:00Z') - Date.parse(asOf + 'T00:00:00Z')) / 86400000)
    : null;
  let expiryState;
  if (item.status === 'revoked') expiryState = 'revoked';
  else if (daysToExpiry === null) expiryState = 'no_expiry';
  else if (daysToExpiry < 0) expiryState = 'expired';
  else if (daysToExpiry <= 30) expiryState = 'due_soon';
  else expiryState = 'valid';
  return { ...item, expiryState, daysToExpiry, asOf };
}
