// Narrow payload adapter for the shared native controls; no DOM or network.
// Compare the initial control display before normalizing explicitly changed text.
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function invalid(key, message) {
  const error = new Error(message); error.fields = { [key]: message }; throw error;
}
function savedText(source, key, fallback = '') {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (!descriptor) return fallback;
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string')
    invalid(key, '表單文字無法確認，請重新讀取。');
  return descriptor.value;
}
function displayValue(field, value) {
  if (field.type === 'textarea') return value.replace(/\r\n?/g, '\n');
  if (field.type === 'select') return field.options?.some(option => option.value === value) ? value : '';
  if (field.type === 'time') return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : '';
  if (field.type === 'date') return /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value ? value : '';
  return value.replace(/[\r\n]/g, '');
}

export function createInstitutionAdminPayloadBuilder({ fields, initial = {}, existing } = {}) {
  if (!Array.isArray(fields) || !fields.length || !plain(initial) || (existing !== undefined && !plain(existing)))
    invalid('title', '表單初始資料無法確認，請重新讀取。');
  const baseline = {}, original = {}, names = new Set();
  for (const field of fields) {
    if (!field || typeof field.name !== 'string' || !field.name || names.has(field.name)
        || ['__proto__', 'prototype', 'constructor', 'version', 'id', 'orgId'].includes(field.name))
      invalid('title', '表單欄位無法確認，請重新讀取。');
    names.add(field.name);
    baseline[field.name] = displayValue(field, savedText(initial, field.name));
    if (existing && Object.hasOwn(existing, field.name)) original[field.name] = savedText(existing, field.name);
  }
  return {
    initialDisplay: Object.freeze({ ...baseline }),
    buildPayload(values) {
      if (!plain(values)) invalid('title', '表單資料格式不正確，請保留輸入並重試。');
      const payload = {};
      for (const key of Reflect.ownKeys(values)) {
        if (typeof key !== 'string' || !names.has(key)) invalid('title', '表單包含未知欄位，請重新讀取。');
        const value = savedText(values, key);
        if (existing && value === baseline[key]) continue;
        const normalized = value.trim();
        if (!existing || !Object.hasOwn(original, key) || normalized !== original[key]) payload[key] = normalized;
      }
      return payload;
    },
  };
}
