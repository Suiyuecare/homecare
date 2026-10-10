import { openRecordIndex } from './record-index.js';
import { CASE_RECORD_INDEX_ENTITIES, caseRecordIndexIdentity, caseRecordIndexQuery, confirmCaseRecordIndex,
  isCaseRecordIndexId } from '../data/case-record-index.js';

async function assessmentTemplates(signal) {
  const response = await fetch('/data/assessment-templates.json', { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error('無法讀取評鑑表模板，請重新讀取。');
  const templates = await response.json();
  if (!Array.isArray(templates)) throw new Error('無法確認評鑑表模板，請重新讀取。');
  return new Map(templates.map(item => [item.id, item]));
}

const profile = Object.freeze({
  parentEntity: 'cases', parentKey: 'caseId', defaultEntity: 'care-plans', title: '保存紀錄索引',
  entities: CASE_RECORD_INDEX_ENTITIES, identity: caseRecordIndexIdentity, query: caseRecordIndexQuery,
  confirm: confirmCaseRecordIndex, isParentId: isCaseRecordIndexId,
  caption: '個案目前保存紀錄索引', emptyText: '此種類目前沒有同案保存紀錄。',
  notice: '本索引只列目前同案的保存紀錄，並非完整異動時間軸。歷程可能包含過去其他目前可讀個案或模板的版本。',
  historyLookupEntity: 'assessments',
  loadHistoryLookups: async (lookups, signal) => ({ ...lookups, 'assessment-templates': await assessmentTemplates(signal) }),
});

export function openCaseRecordIndex({ caseRecord, lookups = {}, isCurrent = () => true }) {
  return openRecordIndex({ parentRecord: caseRecord, lookups, isCurrent, profile });
}
