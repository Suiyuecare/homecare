import { isSavedRecordDetailsId, savedRecordDetailsIdentity, confirmSavedRecordDetails } from './saved-record-details.js';
import { formatTrialPriceCents } from './history-fields.js';

export const SERVICE_ITEM_RECORD_FIELDS = Object.freeze([
  { key: 'code', label: '服務代碼' },
  { key: 'name', label: '服務名稱' },
  { key: 'minutes', label: '預設服務分鐘' },
  { key: 'unitPriceCents', label: '測試單價（新臺幣元）' },
  { key: 'validFrom', label: '有效起日' },
  { key: 'validTo', label: '有效迄日' },
  { key: 'status', label: '服務項目狀態' },
  { key: 'note', label: '備註' },
].map(Object.freeze));

export const isServiceItemRecordDetailsId = isSavedRecordDetailsId;
export const serviceItemRecordDetailsIdentity = savedRecordDetailsIdentity;

function unconfirmed() {
  throw Object.assign(new Error('服務項目紀錄回應無法確認；請重新讀取。'), { code: 'SERVICE_ITEM_RECORD_DETAILS_UNCONFIRMED' });
}

function projectField(field, saved, fallback) {
  if (!saved.present || saved.value === null || saved.value === '') return fallback;
  if (field.key === 'minutes' && typeof saved.value === 'number' && Number.isFinite(saved.value)) {
    return { kind: 'text', text: String(saved.value) };
  }
  if (field.key === 'unitPriceCents' && ['number', 'string', 'boolean'].includes(typeof saved.value)) {
    return { kind: 'text', text: formatTrialPriceCents(saved.value) };
  }
  return fallback;
}

/** Read saved primitives without validating or changing normal write rules. */
export function confirmServiceItemRecordDetails(response, requested) {
  return confirmSavedRecordDetails(response, requested, { fields: SERVICE_ITEM_RECORD_FIELDS, projectField, unconfirmed });
}
