import { isSavedRecordDetailsId, savedRecordDetailsIdentity, confirmSavedRecordDetails } from './saved-record-details.js';
import { formatEmployeeRegions } from './employee-regions.js';
import { formatTrialPriceCents } from './history-fields.js';

export const EMPLOYEE_RECORD_FIELDS = Object.freeze([
  { key: 'name', label: '姓名' },
  { key: 'employeeNo', label: '員工編號' },
  { key: 'role', label: '職務' },
  { key: 'phone', label: '聯絡電話' },
  { key: 'email', label: '電子郵件' },
  { key: 'status', label: '員工狀態' },
  { key: 'qualification', label: '資格與證照' },
  { key: 'regions', label: '服務區域' },
  { key: 'note', label: '備註' },
  { key: 'hourlyRateCents', label: '試算時薪（新臺幣元）' },
].map(Object.freeze));

export const isEmployeeRecordDetailsId = isSavedRecordDetailsId;
export const employeeRecordDetailsIdentity = savedRecordDetailsIdentity;

function unconfirmed() {
  throw Object.assign(new Error('員工紀錄回應無法確認；請重新讀取。'), { code: 'EMPLOYEE_RECORD_DETAILS_UNCONFIRMED' });
}

function detachedStringList(value, reject) {
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < 0) reject();
  const ownKeys = Reflect.ownKeys(value);
  const entries = [];
  let extra = false, invalid = false;
  for (const key of ownKeys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length.value) {
      extra = true;
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) reject();
    if (typeof descriptor.value !== 'string') invalid = true;
    entries.push([Number(key), descriptor.value]);
  }
  if (extra || invalid || entries.length !== length.value) return null;
  const detached = [];
  for (const [index, text] of entries) detached[index] = text;
  return detached;
}

function projectField(field, saved, fallback, reject) {
  if (!saved.present || saved.value === null || saved.value === '') return fallback;
  if (field.key === 'regions') {
    if (typeof saved.value === 'string') return { kind: 'text', text: formatEmployeeRegions(saved.value) };
    if (Array.isArray(saved.value)) {
      const detached = detachedStringList(saved.value, reject);
      return detached === null ? fallback : { kind: 'text', text: formatEmployeeRegions(detached) };
    }
  } else if (field.key === 'hourlyRateCents'
    && ['number', 'string', 'boolean'].includes(typeof saved.value)) {
    return { kind: 'text', text: formatTrialPriceCents(saved.value) };
  }
  return fallback;
}

export function confirmEmployeeRecordDetails(response, requested) {
  return confirmSavedRecordDetails(response, requested, { fields: EMPLOYEE_RECORD_FIELDS, projectField, unconfirmed });
}
