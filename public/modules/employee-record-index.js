import { openRecordIndex } from './record-index.js';
import { EMPLOYEE_RECORD_INDEX_ENTITIES, employeeRecordIndexIdentity, employeeRecordIndexQuery,
  confirmEmployeeRecordIndex, isEmployeeRecordIndexId } from '../data/employee-record-index.js';

const profile = Object.freeze({
  parentEntity: 'employees', parentKey: 'employeeId', defaultEntity: 'employee-certifications',
  title: '員工保存紀錄索引', entities: EMPLOYEE_RECORD_INDEX_ENTITIES,
  identity: employeeRecordIndexIdentity, query: employeeRecordIndexQuery,
  confirm: confirmEmployeeRecordIndex, isParentId: isEmployeeRecordIndexId,
  caption: '員工目前保存紀錄索引', emptyText: '此種類目前沒有同員工保存紀錄。',
  notice: '本索引只列目前同員工的保存紀錄，並非完整異動時間軸。歷程可能包含過去其他目前可讀員工的版本。',
});

export function openEmployeeRecordIndex({ employeeRecord, lookups = {}, isCurrent = () => true }) {
  return openRecordIndex({ parentRecord: employeeRecord, lookups, isCurrent, profile });
}
