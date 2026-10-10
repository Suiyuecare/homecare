import { openSavedRecordDetails } from './saved-record-details.js';
import { isEmployeeRecordDetailsId, employeeRecordDetailsIdentity,
  confirmEmployeeRecordDetails } from '../data/employee-record-details.js';

const statusLabels = new Map([['active', '啟用'], ['inactive', '停用']]);
const fieldText = field => field.key === 'status' && field.kind === 'text'
  ? statusLabels.has(field.text)
    ? `${statusLabels.get(field.text)}（保存碼：${field.text}）`
    : `未辨識狀態（保存原文）：${field.text}`
  : field.text;

const profile = Object.freeze({
  entity: 'employees', roles: Object.freeze(['admin', 'supervisor', 'finance']), requireActorScope: true,
  isId: isEmployeeRecordDetailsId, identity: employeeRecordDetailsIdentity, confirm: confirmEmployeeRecordDetails,
  title: '員工保存資料', loadingText: '正在讀取員工保存資料…', cancelMessage: '員工資料讀取已取消',
  regionLabel: '員工完整保存資料', fieldAttribute: 'data-employee-field',
  fullWidthKeys: Object.freeze(['qualification', 'regions', 'note']), formatField: fieldText,
  notice: '此處顯示目前保存的完整員工資料。職務文字不代表登入權限；資格與證照文字不代表正式資格認定；試算時薪不代表薪資核定，也不重算已核閱快照。',
});

/** One fresh current employee read; no account, qualification or payroll action. */
export function openEmployeeRecordDetails({ id, isCurrent = () => true }) {
  return openSavedRecordDetails({ id, isCurrent, profile });
}
