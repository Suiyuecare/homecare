/** Independent contacts do not migrate or synchronize legacy case fields. */
export const contactCategories = ['general', 'primary_caregiver', 'secondary_caregiver', 'case_manager', 'other'];
export const contactEntities = {
  'case-contacts': {
    fields: 'caseId name category relationship phone alternatePhone email organization status note',
    required: ['caseId', 'name'],
    statuses: ['active', 'inactive'],
    defaults: { category: 'general', status: 'active' },
  },
};

export const isContactEntity = entity => Object.hasOwn(contactEntities, entity);

export function guardContactAccess(entity, ctx, readOnly, fail) {
  if (!isContactEntity(entity)) return;
  const allowed = readOnly ? ['admin', 'supervisor', 'caregiver', 'finance'] : ['admin', 'supervisor'];
  if (!allowed.includes(ctx.role)) fail(403, 'ROLE_FORBIDDEN', '此角色無權變更或讀取個案聯絡人');
}

export function normalizeContactPayload(entity, payload) {
  if (!isContactEntity(entity)) return payload;
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
}

export function validateContact(entity, data, old, fail) {
  if (!isContactEntity(entity)) return;
  if (old && data.caseId !== old.caseId) {
    fail(409, 'CASE_IMMUTABLE', '建立後不可更換聯絡人所屬個案', { caseId: '不可變更' });
  }
  const limits = { name: 100, relationship: 100, phone: 100, alternatePhone: 100, email: 254, organization: 200, note: 10000 };
  for (const [key, max] of Object.entries(limits)) {
    if (data[key] !== undefined && (typeof data[key] !== 'string' || data[key].length > max)) {
      fail(422, 'INVALID_FIELD', '聯絡欄位格式或長度不符', { [key]: `文字長度不可超過${max}字` });
    }
  }
  if (!contactCategories.includes(data.category)) {
    fail(422, 'INVALID_CATEGORY', '聯絡人分類不合法', { category: '分類不合法' });
  }
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    fail(422, 'INVALID_EMAIL', '請填寫有效電子信箱或留白', { email: '電子信箱格式錯誤' });
  }
}

export function contactQuery(entity, searchParams, fail) {
  if (!isContactEntity(entity)) return {};
  const categories = searchParams.getAll('category');
  if (categories.length > 1 || (categories.length === 1 && !contactCategories.includes(categories[0]))) {
    fail(422, 'INVALID_CATEGORY', 'category須為單一有效聯絡人分類', { category: '分類不合法或重複' });
  }
  return { category: categories[0] };
}
