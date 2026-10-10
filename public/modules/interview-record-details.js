import { api, el, getContext, openDetails } from '../ui.js';
import { isInterviewRecordDetailsId, interviewRecordDetailsIdentity,
  confirmInterviewRecordDetails } from '../data/interview-record-details.js';

const statusLabels = new Map([['active', '啟用'], ['inactive', '停用']]);
const fieldText = field => field.key === 'status' && field.kind === 'text'
  ? statusLabels.has(field.text)
    ? `${statusLabels.get(field.text)}（保存碼：${field.text}）`
    : `未辨識狀態（保存原文）：${field.text}`
  : field.text;

/** Fresh read-only content; shared openDetails owns all async and dialog state. */
export function openInterviewRecordDetails({ id, isCurrent = () => true }) {
  const startedContext = getContext(), identity = interviewRecordDetailsIdentity(startedContext), hash = window.location.hash;
  const current = () => getContext() === startedContext && interviewRecordDetailsIdentity(getContext()) === identity
    && window.location.hash === hash && isCurrent();
  const orgId = startedContext.organizationId ?? startedContext.orgId;
  if (!current() || !['admin', 'supervisor'].includes(startedContext.role) || !isInterviewRecordDetailsId(id)) return Promise.resolve();
  return openDetails({
    title: '面試者保存紀錄', wide: true, guardedRead: true, isCurrent: current,
    loadingText: '正在讀取面試者保存紀錄…',
    load: async (signal, helpers) => {
      const response = await api(`/api/interview-applicants/${encodeURIComponent(id)}`, { signal });
      if (signal.aborted || !helpers.isCurrent()) throw new DOMException('面試紀錄讀取已取消', 'AbortError');
      const item = confirmInterviewRecordDetails(response, { id, orgId });
      const metadata = el('dl', { class: 'detail-grid', 'aria-label': '保存紀錄資訊' }, [
        ['版次', String(item.version)], ['保存更新文字', item.updatedAt],
        ['保存建立文字', item.createdAt], ['識別碼', item.id],
      ].map(([label, text]) => el('div', {}, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, text))));
      const fields = el('dl', { class: 'detail-grid' }, item.fields.map(field =>
        el('div', { class: ['interviewContent', 'note'].includes(field.key) ? 'field-wide' : '',
          'data-interview-field': field.key, 'data-saved-kind': field.kind },
          el('dt', {}, field.label), el('dd', { class: 'pre-wrap' }, fieldText(field)))));
      return el('section', { 'aria-label': '面試者完整保存內容' },
        el('p', { class: 'notice' }, '此處顯示目前保存的完整面試紀錄。啟用或停用只代表名單狀態，不代表錄取、到職或薪資核定。'),
        metadata, fields);
    },
  });
}
