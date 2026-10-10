import { api, el, button, getContext, openDetails, createForm, table, pagination, errorState } from '../ui.js';
import { openRecordHistory } from './history.js';

const cancelled = () => new DOMException('紀錄索引查詢已取消', 'AbortError');
function indexContent({ values, query, result, error, helpers, lookups, setDraft, setQuery, profile }) {
  const entityLabel = entity => profile.entities.find(item => item.value === entity).label;
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
      options: profile.entities.map(item => ({ ...item })) }],
    initial: values, submitLabel: '查詢紀錄', lockDuringSubmit: true,
    onChange: draft => {
      if (initializing || !current()) return;
      setDraft({ ...draft }); setQuery(null); retract();
    },
    onSubmit: async draft => {
      if (!current()) return;
      const requested = profile.query(draft.entity);
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
    ], result.items, { caption: profile.caption, emptyText: profile.emptyText });
    contents.querySelectorAll('tbody tr').forEach((row, index) => { row.dataset.recordId = result.items[index].id; });
    results.append(contents, pagination({ page: result.page, pageSize: result.pageSize, total: result.total,
      onChange: page => { if (indexCurrent()) { setQuery(profile.query(result.entity, page)); helpers.reload(); } } }));
  } else if (error) results.append(errorState(error, () => { if (indexCurrent()) helpers.reload(); }));
  else results.append(el('p', { role: 'status' }, '請選擇紀錄種類並查詢。'));
  return el('section', { 'aria-label': '保存紀錄索引' },
    el('p', { class: 'notice' }, profile.notice),
    form, el('div', { class: 'actions' }, reread), results);
}

/** Shared openDetails owns loading, Abort, cancellation, context observation and focus. */
export function openRecordIndex({ parentRecord, lookups = {}, isCurrent = () => true, profile }) {
  const startedContext = getContext(), identity = profile.identity(startedContext), hash = window.location.hash;
  const current = () => getContext() === startedContext && profile.identity(getContext()) === identity
    && window.location.hash === hash && isCurrent();
  const orgId = startedContext.organizationId ?? startedContext.orgId, parentId = parentRecord?.id;
  if (!current() || !['admin', 'supervisor'].includes(startedContext.role)
    || !profile.isParentId(parentId) || parentRecord.orgId !== orgId) return Promise.resolve();
  let draft = { entity: profile.defaultEntity }, query = null;
  return openDetails({ title: profile.title, wide: true, guardedRead: true,
    loadingText: '正在讀取保存紀錄索引…', isCurrent: current,
    load: async (signal, helpers) => {
      const values = { ...draft }; let captured = query, historyLookups = lookups;
      const content = extras => indexContent({ values, query: captured, helpers, lookups: historyLookups,
        setDraft: value => { draft = value; }, setQuery: value => { query = value; }, profile, ...extras });
      if (!captured) return content({});
      try {
        const read = async () => {
          const response = await api(`/api/${profile.parentEntity}/${encodeURIComponent(parentId)}/record-index?${new URLSearchParams(captured)}`, { signal });
          if (signal.aborted || !helpers.isCurrent()) throw cancelled();
          return profile.confirm(response, { ...captured, orgId, [profile.parentKey]: parentId });
        };
        let result = await read();
        const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
        if (result.page > lastPage) {
          captured = profile.query(captured.entity, lastPage); query = captured;
          result = await read();
        }
        if (captured.entity === profile.historyLookupEntity && result.items.length) {
          historyLookups = await profile.loadHistoryLookups(lookups, signal);
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
