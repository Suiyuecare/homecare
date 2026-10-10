import { openSavedRecordDetails } from './saved-record-details.js';
import { isInterviewRecordDetailsId, interviewRecordDetailsIdentity,
  confirmInterviewRecordDetails } from '../data/interview-record-details.js';

const statusLabels = new Map([['active', '啟用'], ['inactive', '停用']]);
const fieldText = field => field.key === 'status' && field.kind === 'text'
  ? statusLabels.has(field.text)
    ? `${statusLabels.get(field.text)}（保存碼：${field.text}）`
    : `未辨識狀態（保存原文）：${field.text}`
  : field.text;

const profile = Object.freeze({
  entity: 'interview-applicants', roles: Object.freeze(['admin', 'supervisor']),
  isId: isInterviewRecordDetailsId, identity: interviewRecordDetailsIdentity, confirm: confirmInterviewRecordDetails,
  title: '面試者保存紀錄', loadingText: '正在讀取面試者保存紀錄…', cancelMessage: '面試紀錄讀取已取消',
  regionLabel: '面試者完整保存內容', fieldAttribute: 'data-interview-field',
  fullWidthKeys: Object.freeze(['interviewContent', 'note']), formatField: fieldText,
  notice: '此處顯示目前保存的完整面試紀錄。啟用或停用只代表名單狀態，不代表錄取、到職或薪資核定。',
});

/** Fresh read-only content; shared openDetails owns all async and dialog state. */
export function openInterviewRecordDetails({ id, isCurrent = () => true }) {
  return openSavedRecordDetails({ id, isCurrent, profile });
}
