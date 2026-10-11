import { INTERVIEW_EXTENSION_FIELDS, INTERVIEW_EXTENSION_LABELS } from './interview-extension-editor.js';
export const INTERVIEW_RECORD_FIELDS = Object.freeze([
  { key: 'name', label: '姓名' },
  { key: 'phone', label: '電話' },
  { key: 'interviewDate', label: '面試日期' },
  { key: 'city', label: '縣市' },
  { key: 'district', label: '鄉鎮區' },
  { key: 'interviewContent', label: '面試內容' },
  { key: 'note', label: '備註' },
  { key: 'status', label: '名單狀態' },
  ...INTERVIEW_EXTENSION_FIELDS.map(key => ({key,label:INTERVIEW_EXTENSION_LABELS[key]})),
].map(Object.freeze));

export const isInterviewRecordDetailsId = isSavedRecordDetailsId;
export const interviewRecordDetailsIdentity = savedRecordDetailsIdentity;

function unconfirmed() {
  throw Object.assign(new Error('面試紀錄回應無法確認；請重新讀取。'), { code: 'INTERVIEW_RECORD_DETAILS_UNCONFIRMED' });
}

/** Fresh, descriptor-confirmed projection. Unknown item fields and nested values are never read. */
export function confirmInterviewRecordDetails(response, requested) {
  return confirmSavedRecordDetails(response, requested, { fields: INTERVIEW_RECORD_FIELDS, unconfirmed });
}
import { isSavedRecordDetailsId, savedRecordDetailsIdentity, confirmSavedRecordDetails } from './saved-record-details.js';
