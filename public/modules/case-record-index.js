import { api, el, button, getContext, openDetails, createForm, table, pagination, errorState } from '../ui.js';
import { openRecordHistory } from './history.js';
import { CASE_RECORD_INDEX_ENTITIES, caseRecordIndexIdentity, caseRecordIndexQuery, confirmCaseRecordIndex,
  isCaseRecordIndexId } from '../data/case-record-index.js';

const cancelled = () => new DOMException('紀錄索引查詢已取消', 'AbortError');
const entityLabel = entity => CASE_RECORD_INDEX_ENTITIES.find(item => item.value === entity).label;
async function assessmentTemplates(signal) {
  const response = await fetch('/data/assessment-templates.json', { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error('無法讀取評鑑表模板，請重新讀取。');
  const templates = await response.json();
  if (!Array.isArray(templates)) throw new Error('無法確認評鑑表模板，請重新讀取。');
  return new Map(templates.map(item => [item.id, item]));
}

function indexContent({ values, query, result, error, helpers, lookups, setDraft, setQuery }) {
  let initializing = true, queryCurrent = Boolean(query);
  const current = () => helpers.isCurrent() && form.isConnected && form.closest('dialog')?.open;
  const indexCurrent = () => current() && queryCurrent;
  const results = el('div', { 'aria-live': 'polite' });
  const reread = button('重新讀取', () => { if (indexCurrent()) helpers.reload(); }, { variant: 'outline', disabled: !queryCurrent });
  const retract = () => {
    queryCurrent = false; reread.disabled = true;
    results.replaceChildren(el('p', { role: 'status' }, '條件已變更，請查詢紀錄。'));
  };
  const form = createForm({
    fields: [{ name: 'entity', label: '紀錄種類', type: 'select', required: true,
      options: CASE_RECORD_INDEX_ENTITIES.map(item => ({ ...item })) }],
    initial: values, submitLabel: '查詢紀錄', lockDuringSubmit: true,
    onChange: draft => {
      if (initializing || !current()) return;
      setDraft({ ...draft }); setQuery(null); retract();
    },
    onSubmit: async draft => {
      if (!current()) return;
      const requested = caseRecordIndexQuery(draft.entity);
      setDraft({ ...draft }); setQuery(requested); await helpers.reload();
    },
  });
  initializing = false;
  if (result) {
    const contents = table([
      { label: '紀錄種類', render: row => entityLabel(row.entity) },
      { key: 'version', label: '目前版次' },
      { label: '原更新時間', render: row => el('span', { class: 'pre-wrap' }, row.updatedAt) },
      { label: '保存識別碼', render: row => el('details', {}, el('summary', {}, '查看識別碼'), el('code', { class: 'pre-wrap' }, row.id)) },
      { label: '操作', render: row => button('此紀錄歷程', () => {
        if (indexCurrent()) openRecordHistory({ entity: row.entity, id: row.id, lookups, isCurrent: indexCurrent });
      }, { variant: 'outline' }) },
    ], result.items, { caption: '個案目前保存紀錄索引', emptyText: '此種類目前沒有同案保存紀錄。' });
    contents.querySelectorAll('tbody tr').forEach((row, index) => { row.dataset.recordId = result.items[index].id; });
    results.append(contents, pagination({ page: result.page, pageSize: result.pageSize, total: result.total,
      onChange: page => { if (indexCurrent()) { setQuery(caseRecordIndexQuery(result.entity, page)); helpers.reload(); } } }));
  } else if (error) results.append(errorState(error, () => { if (indexCurrent()) helpers.reload(); }));
  else results.append(el('p', { role: 'status' }, '請選擇紀錄種類並查詢。'));
  return el('section', { 'aria-label': '保存紀錄索引' },
    el('p', { class: 'notice' }, '本索引只列目前同案的保存紀錄，並非完整異動時間軸。歷程可能包含過去其他目前可讀個案或模板的版本。'),
    form, el('div', { class: 'actions' }, reread), results);
}

/** Shared openDetails owns loading, Abort, cancellation, context observation and focus. */
export function openCaseRecordIndex({ caseRecord, lookups = {}, isCurrent = () => true }) {
  const startedContext = getContext(), identity = caseRecordIndexIdentity(startedContext), hash = window.location.hash;
  const current = () => getContext() === startedContext && caseRecordIndexIdentity(getContext()) === identity
    && window.location.hash === hash && isCurrent();
  const orgId = startedContext.organizationId ?? startedContext.orgId, caseId = caseRecord?.id;
  if (!current() || !['admin', 'supervisor'].includes(startedContext.role)
    || !isCaseRecordIndexId(caseId) || caseRecord.orgId !== orgId) return Promise.resolve();
  let draft = { entity: 'care-plans' }, query = null;
  return openDetails({ title: '保存紀錄索引', wide: true, guardedRead: true,
    loadingText: '正在讀取保存紀錄索引…', isCurrent: current,
    load: async (signal, helpers) => {
      const values = { ...draft }; let captured = query, historyLookups = lookups;
      const content = extras => indexContent({ values, query: captured, helpers, lookups: historyLookups,
        setDraft: value => { draft = value; }, setQuery: value => { query = value; }, ...extras });
      if (!captured) return content({});
      try {
        const read = async () => {
          const response = await api(`/api/cases/${encodeURIComponent(caseId)}/record-index?${new URLSearchParams(captured)}`, { signal });
          if (signal.aborted || !helpers.isCurrent()) throw cancelled();
          return confirmCaseRecordIndex(response, { ...captured, orgId, caseId });
        };
        let result = await read();
        const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
        if (result.page > lastPage) {
          captured = caseRecordIndexQuery(captured.entity, lastPage); query = captured;
          result = await read();
        }
        if (captured.entity === 'assessments' && result.items.length) {
          historyLookups = { ...lookups, 'assessment-templates': await assessmentTemplates(signal) };
          if (signal.aborted || !helpers.isCurrent()) throw cancelled();
        }
        return content({ result });
      } catch (error) {
        if (signal.aborted || !helpers.isCurrent() || error.name === 'AbortError') throw cancelled();
        return content({ error });
      }
    },
  });
}
