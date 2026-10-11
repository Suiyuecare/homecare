import { openSavedRecordDetails } from './saved-record-details.js';
import { isInterviewRecordDetailsId, interviewRecordDetailsIdentity,
  confirmInterviewRecordDetails } from '../data/interview-record-details.js';
import { INTERVIEW_DECISIONS } from '../data/interview-extension-editor.js';
import { api, el } from '../ui.js';

const statusLabels = new Map([['active', '啟用'], ['inactive', '停用']]);
const fieldText = (field,lookups) => field.key === 'status' && field.kind === 'text'
  ? statusLabels.has(field.text)
    ? `${statusLabels.get(field.text)}（保存碼：${field.text}）`
    : `未辨識狀態（保存原文）：${field.text}`
  : field.key === 'decision' && field.kind === 'text' ? INTERVIEW_DECISIONS[field.text] || field.text
  : field.key === 'interviewerEmployeeId' && field.kind === 'text' ? el('div',{},el('span',{},lookups?.interviewerName ? `目前名稱：${lookups.interviewerName}` : '目前面試員工名稱無法取得'),el('details',{},el('summary',{},'查看保存的識別碼'),el('code',{class:'pre-wrap'},field.text))) : field.text;

const profile = Object.freeze({
  entity: 'interview-applicants', roles: Object.freeze(['admin', 'supervisor']),
  isId: isInterviewRecordDetailsId, identity: interviewRecordDetailsIdentity, confirm: confirmInterviewRecordDetails,
  title: '面試者保存紀錄', loadingText: '正在讀取面試者保存紀錄…', cancelMessage: '面試紀錄讀取已取消',
  regionLabel: '面試者完整保存內容', fieldAttribute: 'data-interview-field',
  fullWidthKeys: Object.freeze(['interviewContent', 'note', 'workExperience', 'availableHours', 'certificateNotes', 'interviewQuestions', 'decisionReason']), formatField: fieldText,
  async loadLookups(item,signal) {
    const field=item.fields.find(field=>field.key==='interviewerEmployeeId');
    if(field?.kind!=='text')return {};
    let response;
    try{response=await api('/api/employees/'+encodeURIComponent(field.text),{signal});}catch(error){if(error.status===404)return {};throw error;}
    const employee=response?.item;
    if(!employee||employee.id!==field.text||employee.orgId!==item.orgId||!Number.isSafeInteger(employee.version)||employee.version<1||typeof employee.name!=='string'||!employee.name.trim()||!['active','inactive'].includes(employee.status))throw new Error('面試員工名稱回應無法確認，請重新讀取。');
    return {interviewerName:employee.name};
  },
  notice: '此處顯示目前保存的完整面試紀錄。啟用或停用只代表名單狀態，不代表錄取、到職或薪資核定。',
});

/** Fresh read-only content; shared openDetails owns all async and dialog state. */
export function openInterviewRecordDetails({ id, isCurrent = () => true }) {
  return openSavedRecordDetails({ id, isCurrent, profile });
}
