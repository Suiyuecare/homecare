import {
  api, el, button, table, pagination, errorState, toast, today, formatDate,
  getContext, openDetails, downloadCsv,
} from '../ui.js';
import { formatEmployeeRegions, isNormalizedEmployeeRegions } from '../data/employee-regions.js';

const PAGE_SIZE = 25;
const DEFAULT_PERSON_FILTER = Object.freeze({ key: 'employeeId', selectionKey: 'employee', label: '服務人員', emptyLabel: '全部可讀人員', options: (_cases, employees) => employees });
const DEFAULT_DATE = Object.freeze({ rowKey: 'date', startLabel: '開始日期', endLabel: '結束日期', rangeLabel: '日期範圍' });
const settings = config => ({
  person: { ...DEFAULT_PERSON_FILTER, ...config.personFilter },
  date: config.date === false ? false : { ...DEFAULT_DATE, ...config.date },
  caseFilter: config.caseFilter !== false, search: config.search || false,
  asOf: config.asOf || false, expiry: config.expiry || false,
});
const filterKeys = ({ person, date, caseFilter, search, asOf, expiry }) => [
  ...(date ? ['startDate', 'endDate'] : []), ...(search ? [search.key] : []),
  ...(caseFilter ? ['caseId'] : []), person.key, 'status', ...(asOf ? ['asOf'] : []), ...(expiry ? ['expiry'] : []),
];
const identity = () => {
  const context = getContext();
  return `${context.user?.id || ''}:${context.organizationId || context.orgId || ''}:${context.role || ''}:${context.user?.employeeId || ''}`;
};
const filterSignature = (keys, filters) => JSON.stringify(keys.map(key => filters[key]));
const abortError = () => new DOMException('操作已取消', 'AbortError');
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const timestamp = value => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value));
const defaultFilters = options => {
  const filters = Object.fromEntries(filterKeys(options).map(key => [key, '']));
  if (options.asOf) filters.asOf = today();
  if (!options.date) return filters;
  const month = today().slice(0, 7), [year, number] = month.split('-').map(Number);
  return { ...filters, startDate: `${month}-01`, endDate: new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10) };
};
const filterQuery = (keys, filters) => new URLSearchParams(keys.filter(key => filters[key] !== '').map(key => [key, filters[key]]));

// Pure response confirmation shared by all reports; adapters cannot replace async guards.
export function confirmReport(config, result, filters, { page = 1, complete = false } = {}) {
  const options = settings(config), { person, date, caseFilter, asOf, expiry } = options, keys = filterKeys(options);
  const selectionKeys = [...(caseFilter ? ['case'] : []), person.selectionKey, 'status', ...(expiry ? [expiry.selectionKey] : [])];
  const invalid = () => { throw new Error('未取得與查詢條件一致的完整報表確認，請重新查詢。'); };
  if (!result || typeof result !== 'object' || result.title !== config.title
    || typeof result.organization?.name !== 'string' || !result.organization.name.trim()
    || !result.filters || Object.keys(result.filters).length !== keys.length
    || keys.some(key => result.filters[key] !== filters[key])
    || !result.selection || Object.keys(result.selection).length !== selectionKeys.length
    || selectionKeys.some(key => typeof result.selection[key] !== 'string' || !result.selection[key].trim())
    || result.selection.status !== (config.statuses[filters.status] || '全部狀態')
    || (caseFilter && !filters.caseId && result.selection.case !== '全部可讀個案')
    || (!filters[person.key] && result.selection[person.selectionKey] !== person.emptyLabel)
    || (asOf && (typeof filters.asOf !== 'string' || !validDate(filters.asOf)))
    || (expiry && (typeof filters.expiry !== 'string' || (filters.expiry && !Object.hasOwn(expiry.labels, filters.expiry)) || result.selection[expiry.selectionKey] !== (expiry.labels[filters.expiry] || expiry.emptyLabel)))
    || typeof result.generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+Z$/.test(result.generatedAt) || !Number.isFinite(Date.parse(result.generatedAt))
    || !Array.isArray(result.columns) || result.columns.length !== config.columns.length
    || config.columns.some((column, index) => result.columns[index]?.key !== column.key || result.columns[index]?.label !== column.label || result.columns[index]?.type !== column.type)
    || !Number.isSafeInteger(result.total) || result.total < 0 || result.totals?.count !== result.total
    || !Array.isArray(result.rows) || typeof result.note !== 'string' || !result.note.trim()) invalid();
  const expectedRows = complete ? result.total : Math.min(PAGE_SIZE, Math.max(0, result.total - (page - 1) * PAGE_SIZE));
  if (result.page !== page || result.pageSize !== (complete ? result.total : PAGE_SIZE) || result.rows.length !== expectedRows) invalid();
  const ids = new Set();
  const rowKeys = new Set(Object.keys(config.rowFields));
  for (const row of result.rows) {
    if (!row || typeof row !== 'object' || Object.keys(row).length !== rowKeys.size || Object.keys(row).some(key => !rowKeys.has(key))
      || Object.entries(config.rowFields).some(([key, type]) => type === 'positiveInteger'
        ? !Number.isSafeInteger(row[key]) || row[key] < 1
        : type === 'employee-regions' ? !isNormalizedEmployeeRegions(row[key]) : typeof row[key] !== 'string')
      || !row[config.idKey] || ids.has(row[config.idKey])
      || (date && (!validDate(row[date.rowKey]) || row[date.rowKey] < filters.startDate || row[date.rowKey] > filters.endDate))
      || !Object.hasOwn(config.statuses, row.status) || row.statusLabel !== config.statuses[row.status]
      || (filters.status && row.status !== filters.status)
      || (config.validateRow && !config.validateRow(row, { filters }))) invalid();
    ids.add(row[config.idKey]);
  }
  if (config.validateTotals && !config.validateTotals(result, { complete })) invalid();
  return result;
}

function reportTable(config, result) {
  const { date } = settings(config);
  const node = table(config.columns.map(column => ({ ...column, render: row => date && (column.key === date.rowKey || date.displayRowKeys?.includes(column.key)) && row[column.key] !== '' ? formatDate(row[column.key]) : el('span', { class: 'pre-wrap' }, column.type === 'employee-regions' ? formatEmployeeRegions(row[column.key]) : row[column.key] === '' ? '—' : String(row[column.key])) })), result.rows,
    { emptyText: config.copy.emptyTable, caption: config.title });
  node.classList.add('report-table', `${config.key}-table`);
  return node;
}

function reportContent(config, result, complete = false) {
  const { person, date, caseFilter, search, asOf, expiry } = settings(config);
  const fields = [
    ['機構', result.organization.name],
    ...(date ? [[date.rangeLabel, `${formatDate(result.filters.startDate)} 至 ${formatDate(result.filters.endDate)}`]] : []),
    ...(search ? [[search.label, result.filters[search.key] || '未指定關鍵字']] : []),
    ...(caseFilter ? [['個案', result.selection.case]] : []),
    [person.label, result.selection[person.selectionKey]], [config.statusLabel, result.selection.status],
    ...(asOf ? [[asOf.label, formatDate(result.filters.asOf)]] : []),
    ...(expiry ? [[expiry.label, result.selection[expiry.selectionKey]]] : []),
    ['產生時間（臺北）', timestamp(result.generatedAt)],
  ];
  return el('section', { class: complete ? `report-print ${config.key}-print` : `report-results ${config.key}-results`, 'aria-label': complete ? config.copy.completeLabel : config.copy.resultLabel },
    el('h2', {}, result.title),
    el('dl', { class: 'detail-grid' }, fields.map(([label, value]) => el('div', {}, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value)))),
    el('p', { class: 'report-total' }, config.summary(result, { complete })),
    el('p', { class: 'notice' }, result.note), reportTable(config, result),
  );
}

/** One fresh complete response; business adapters may add stricter confirmation. */
export async function readCompleteReport(config, filters, { signal, isCurrent, confirmComplete } = {}) {
  if (signal.aborted || !isCurrent()) throw abortError();
  const query = filterQuery(filterKeys(settings(config)), filters);
  const result = await api(`${config.path}/export?${query}`, { signal });
  if (signal.aborted || !isCurrent()) throw abortError();
  confirmReport(config, result, filters, { complete: true });
  confirmComplete?.(result);
  if (signal.aborted || !isCurrent()) throw abortError();
  if (!result.total) throw new Error(config.copy.emptyExport);
  return result;
}

/** Fixed confirmed filters; openDetails remains the serial load/print/focus owner. */
export async function openReportPreview({ config, filters, isCurrent, confirmComplete, downloadable = false }) {
  const captured = Object.freeze({ ...filters });
  const query = filterQuery(filterKeys(settings(config)), captured);
  let downloadController;
  try {
    await openDetails({
      title: config.copy.previewTitle, wide: true, printable: true, guardedRead: true,
      isCurrent, loadingText: config.copy.previewLoading,
      load: async (signal, helpers) => {
        downloadController?.abort(); downloadController = null;
        const result = await readCompleteReport(config, captured, { signal, isCurrent: helpers.isCurrent, confirmComplete });
        const content = reportContent(config, result, true);
        if (!downloadable) return content;
        const current = () => !signal.aborted && helpers.isCurrent() && content.isConnected;
        const status = el('div', { 'aria-live': 'polite', 'data-no-print': true });
        const csv = button('下載 CSV', () => download(), { variant: 'outline' });
        const cancel = button('取消下載', () => {
          if (!current() || !downloadController) return;
          downloadController.abort(); status.replaceChildren(el('p', { role: 'status' }, '已取消下載。'));
        }, { variant: 'outline', hidden: true });
        async function download() {
          if (!current() || downloadController) return;
          const active = new AbortController(); downloadController = active;
          const abort = () => active.abort();
          signal.addEventListener('abort', abort, { once: true });
          const outputCurrent = () => !active.signal.aborted && current();
          csv.disabled = true; csv.setAttribute('aria-busy', 'true'); cancel.hidden = false;
          status.replaceChildren(el('p', { role: 'status' }, '正在重新確認完整報表並準備下載…'));
          try {
            await readCompleteReport(config, captured, { signal: active.signal, isCurrent: outputCurrent, confirmComplete });
            if (!outputCurrent()) throw abortError();
            await downloadCsv(`${config.path}.csv?${query}`, { filename: `${config.key}.csv`, signal: active.signal, isCurrent: outputCurrent });
            if (outputCurrent()) { status.replaceChildren(); toast(config.copy.downloadSuccess, 'success'); }
          } catch (error) {
            if (outputCurrent() && error.name !== 'AbortError') status.replaceChildren(errorState(error, download));
          } finally {
            signal.removeEventListener('abort', abort);
            if (downloadController === active) {
              downloadController = null;
              if (current()) { csv.disabled = false; csv.removeAttribute('aria-busy'); cancel.hidden = true; }
            }
          }
        }
        content.prepend(el('div', { class: 'actions', 'data-no-print': true }, csv, cancel), status);
        return content;
      },
    });
  } finally { downloadController?.abort(); }
}

/** Mounts one read-only report; caller disposes it before changing report kinds. */
export function mountReportView(container, { config, isCurrent = () => true } = {}) {
  const options = settings(config), { person, date, caseFilter, search, asOf, expiry } = options, keys = filterKeys(options);
  const signature = filters => filterSignature(keys, filters), query = filters => filterQuery(keys, filters);
  const startedIdentity = identity(), startedHash = window.location.hash;
  let disposed = false, lookupReady = false, sequence = 0, lookupSequence = 0, page = 1;
  let controller, lookupController, downloadController, confirmed = null, loading = false, downloading = false, composing = false;
  const controls = new Map(), fieldErrors = new Map();
  const current = () => !disposed && container.isConnected && identity() === startedIdentity && window.location.hash === startedHash && isCurrent();
  const values = () => Object.fromEntries(keys.map(key => [key, controls.get(key).value]));
  const outputCurrent = captured => current() && confirmed === captured && signature(values()) === captured.signature;
  const summary = el('div', { class: 'form-summary', role: 'alert', hidden: true });
  const lookupStatus = el('div', { 'aria-live': 'polite' });
  const stateMessage = el('p', { class: 'muted', role: 'status' }, '正在準備查詢條件…');
  const results = el('div', { 'aria-live': 'polite' }), footer = el('div');
  const outputStatus = el('div', { 'aria-live': 'polite' });
  const queryButton = button(config.copy.queryButton, null, { type: 'submit', disabled: true });
  const clearButton = button('清除條件', () => {
    const defaults = defaultFilters(options);
    for (const key of keys) controls.get(key).value = defaults[key];
    invalidate(); page = 1; void load();
  }, { variant: 'outline' });
  const csvButton = button('下載 CSV', () => download(), { variant: 'outline', disabled: true });
  const previewButton = button('列印預覽', () => preview(), { variant: 'outline', disabled: true });
  const cancelDownload = button('取消下載', () => {
    downloadController?.abort();
    outputStatus.replaceChildren(el('p', { role: 'status' }, '已取消下載。'));
  }, { variant: 'outline', hidden: true });

  const updateButtons = () => {
    queryButton.disabled = !lookupReady || loading || composing;
    clearButton.disabled = !lookupReady;
    const enabled = current() && confirmed && outputCurrent(confirmed) && confirmed.total > 0 && !loading && !downloading;
    csvButton.disabled = !enabled; previewButton.disabled = !enabled;
    cancelDownload.hidden = !downloading;
  };
  const showFieldErrors = (errors = {}) => {
    for (const [key, control] of controls) {
      const error = errors[key] || '';
      control.setAttribute('aria-invalid', error ? 'true' : 'false');
      fieldErrors.get(key).textContent = error; fieldErrors.get(key).hidden = !error;
    }
    summary.hidden = !Object.keys(errors).length;
    summary.textContent = Object.values(errors).join(' ');
    if (!summary.hidden) controls.get(Object.keys(errors)[0])?.focus();
  };
  function invalidate() {
    ++sequence; controller?.abort(); downloadController?.abort();
    confirmed = null; loading = false; page = 1;
    queryButton.removeAttribute('aria-busy');
    showFieldErrors(); results.replaceChildren(); footer.replaceChildren(); outputStatus.replaceChildren();
    stateMessage.textContent = '條件已變更，請重新查詢後再下載或列印。';
    updateButtons();
  }
  function filter(key, label, choices) {
    const id = `${config.key}-${key}-${crypto.randomUUID()}`, errorId = `${id}-error`;
    const control = choices
      ? el('select', { id, 'aria-label': label, 'aria-describedby': errorId }, choices.map(choice => el('option', { value: choice.value }, choice.label)))
      : el('input', { id, ...(search && key === search.key ? { type: 'search', maxLength: search.maxLength, placeholder: search.placeholder } : { type: 'date', required: true }), 'aria-label': label, 'aria-describedby': errorId });
    const error = el('p', { id: errorId, class: 'field-error', hidden: true });
    controls.set(key, control); fieldErrors.set(key, error);
    control.addEventListener('input', invalidate); control.addEventListener('change', invalidate);
    if (search && key === search.key) {
      control.addEventListener('compositionstart', () => { composing = true; invalidate(); });
      control.addEventListener('compositionend', () => { composing = false; invalidate(); });
    }
    return el('div', { class: 'field' }, el('label', { class: 'filter-field', for: id }, el('span', {}, label), control), error);
  }
  const form = el('form', { class: 'toolbar', noValidate: true, 'data-no-print': true },
    ...(date ? [filter('startDate', date.startLabel), filter('endDate', date.endLabel)] : []),
    ...(search ? [filter(search.key, search.label)] : []),
    ...(caseFilter ? [filter('caseId', '個案', [{ value: '', label: '全部可讀個案' }])] : []),
    filter(person.key, person.label, [{ value: '', label: person.emptyLabel }]),
    filter('status', config.statusLabel, [{ value: '', label: '全部狀態' }, ...Object.entries(config.statuses).map(([value, label]) => ({ value, label }))]),
    ...(asOf ? [filter('asOf', asOf.label)] : []),
    ...(expiry ? [filter('expiry', expiry.label, [{ value: '', label: expiry.emptyLabel }, ...Object.entries(expiry.labels).map(([value, label]) => ({ value, label }))])] : []),
    el('div', { class: 'actions' }, queryButton, clearButton),
  );
  const initial = defaultFilters(options);
  for (const key of keys) controls.get(key).value = initial[key];
  if (caseFilter) controls.get('caseId').disabled = true;
  controls.get(person.key).disabled = true;
  form.addEventListener('submit', event => { event.preventDefault(); if (composing) return; page = 1; void load(); });
  const view = el('section', { class: `report-query ${config.key}`, 'aria-label': config.copy.queryTitle },
    el('h2', {}, config.copy.queryTitle), el('p', { class: 'muted' }, config.copy.help),
    lookupStatus, summary, form, stateMessage,
    el('div', { class: 'actions', 'data-no-print': true }, csvButton, previewButton, cancelDownload), outputStatus, results, footer,
  );
  container.replaceChildren(view);

  function validate(filters) {
    const errors = {};
    if (date) for (const key of ['startDate', 'endDate']) if (!validDate(filters[key])) errors[key] = `請填寫有效的${key === 'startDate' ? date.startLabel : date.endLabel}。`;
    if (date && !Object.keys(errors).length) {
      const days = (Date.parse(`${filters.endDate}T00:00:00Z`) - Date.parse(`${filters.startDate}T00:00:00Z`)) / 86400000 + 1;
      if (days < 1) errors.endDate = `${date.endLabel}不能早於${date.startLabel}。`;
      else if (days > 366) errors.endDate = '查詢期間最多 366 日，請縮小日期範圍。';
    }
    if (search && filters[search.key].length > search.maxLength) errors[search.key] = `${search.label}最多 ${search.maxLength} 字，請保留原文並縮短後再查詢。`;
    if (asOf && !validDate(filters.asOf)) errors.asOf = `請填寫有效的${asOf.label}。`;
    if (expiry && filters.expiry && !Object.hasOwn(expiry.labels, filters.expiry)) errors.expiry = '請選擇有效的效期狀態。';
    if (Object.keys(errors).length) { showFieldErrors(errors); return false; }
    showFieldErrors(); return true;
  }

  async function load() {
    if (!current() || !lookupReady || composing) return;
    const filters = values();
    const request = ++sequence; controller?.abort(); downloadController?.abort();
    confirmed = null; loading = false; updateButtons(); outputStatus.replaceChildren(); footer.replaceChildren();
    if (!validate(filters)) { results.replaceChildren(); stateMessage.textContent = '請修正查詢條件。'; return; }
    controller = new AbortController(); const requestController = controller;
    loading = true; queryButton.setAttribute('aria-busy', 'true'); updateButtons();
    stateMessage.textContent = config.copy.queryLoading; results.replaceChildren(el('p', { class: 'loading', role: 'status' }, config.copy.tableLoading));
    const params = query(filters); params.set('page', String(page)); params.set('pageSize', String(PAGE_SIZE));
    try {
      const result = confirmReport(config, await api(`${config.path}?${params}`, { signal: requestController.signal }), filters, { page });
      if (!current() || requestController.signal.aborted || request !== sequence || signature(values()) !== signature(filters)) return;
      const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
      if (page > lastPage) { page = lastPage; return load(); }
      confirmed = { filters: Object.freeze({ ...filters }), signature: signature(filters), total: result.total };
      stateMessage.textContent = result.total ? '查詢已確認，可下載 CSV 或開啟列印預覽。' : config.copy.emptyResult;
      results.replaceChildren(reportContent(config, result));
      footer.replaceChildren(pagination({ page: result.page, pageSize: result.pageSize, total: result.total, onChange: next => { page = next; void load(); } }));
    } catch (error) {
      if (!current() || requestController.signal.aborted || request !== sequence || error.name === 'AbortError') return;
      if (error.fields) showFieldErrors(error.fields);
      stateMessage.textContent = '查詢尚未確認，請修正條件或重新讀取。';
      results.replaceChildren(errorState(error, load));
    } finally {
      if (current() && request === sequence) { loading = false; queryButton.removeAttribute('aria-busy'); updateButtons(); }
    }
  }

  async function completeReport(captured, signal) {
    return readCompleteReport(config, captured.filters, { signal, isCurrent: () => outputCurrent(captured) });
  }

  async function download() {
    const captured = confirmed;
    if (!captured || !outputCurrent(captured) || !captured.total || downloading) return;
    const active = new AbortController(); downloadController = active;
    downloading = true; csvButton.setAttribute('aria-busy', 'true'); updateButtons();
    outputStatus.replaceChildren(el('p', { role: 'status' }, '正在重新確認完整報表並準備下載…'));
    try {
      await completeReport(captured, active.signal);
      await downloadCsv(`${config.path}.csv?${query(captured.filters)}`, { filename: `${config.key}.csv`, signal: active.signal, isCurrent: () => outputCurrent(captured) });
      if (!active.signal.aborted && outputCurrent(captured)) { outputStatus.replaceChildren(); toast(config.copy.downloadSuccess, 'success'); }
    } catch (error) {
      if (!current() || active.signal.aborted || error.name === 'AbortError' || !outputCurrent(captured)) return;
      outputStatus.replaceChildren(errorState(error, download));
    } finally {
      if (downloadController === active) { downloading = false; csvButton.removeAttribute('aria-busy'); if (current()) updateButtons(); }
    }
  }

  function preview() {
    const captured = confirmed;
    if (!captured || !outputCurrent(captured) || !captured.total) return;
    return openReportPreview({ config, filters: captured.filters, isCurrent: () => outputCurrent(captured) });
  }

  async function readLookup(entity, signal) {
    const items = [];
    for (let lookupPage = 1; lookupPage <= 100; lookupPage++) {
      if (signal.aborted || !current()) throw abortError();
      const result = await api(`/api/${entity}?page=${lookupPage}&pageSize=100`, { signal });
      if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0) throw new Error('查詢選項尚未完整載入，請重新讀取。');
      items.push(...result.items);
      if (items.length >= result.total) return items;
      if (!result.items.length) throw new Error('查詢選項尚未完整載入，請重新讀取。');
    }
    throw new Error('可選資料超過目前支援範圍，請聯絡管理者。');
  }

  async function loadLookups() {
    if (!current()) return;
    const request = ++lookupSequence; lookupController?.abort(); lookupController = new AbortController();
    const active = lookupController; lookupReady = false; updateButtons();
    lookupStatus.replaceChildren(el('p', { class: 'loading', role: 'status' }, `正在讀取${caseFilter ? '個案與' : ''}${person.label}選項…`));
    try {
      const [cases, employees] = await Promise.all([caseFilter ? readLookup('cases', active.signal) : Promise.resolve([]), readLookup('employees', active.signal)]);
      if (!current() || active.signal.aborted || request !== lookupSequence) return;
      for (const [key, rows, number, label] of [...(caseFilter ? [['caseId', cases, 'caseNo', '全部可讀個案']] : []), [person.key, person.options(cases, employees), 'employeeNo', person.emptyLabel]]) {
        controls.get(key).replaceChildren(el('option', { value: '' }, label), ...rows.map(row => el('option', { value: row.id }, `${typeof row[number] === 'string' ? row[number] : ''} ${typeof row.name === 'string' && row.name ? row.name : '名稱未取得'}`.trim())));
        controls.get(key).disabled = false;
      }
      lookupReady = true; lookupStatus.replaceChildren(); updateButtons(); await load();
    } catch (error) {
      if (!current() || active.signal.aborted || request !== lookupSequence || error.name === 'AbortError') return;
      stateMessage.textContent = '請先重新讀取查詢選項。'; lookupStatus.replaceChildren(errorState(error, loadLookups));
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true; ++sequence; ++lookupSequence;
    controller?.abort(); lookupController?.abort(); downloadController?.abort();
    observer.disconnect(); window.removeEventListener('hashchange', checkContext); window.removeEventListener('session-updated', checkContext);
    view.remove();
  }
  const checkContext = () => { if (!current()) dispose(); };
  const observer = new MutationObserver(checkContext);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('hashchange', checkContext); window.addEventListener('session-updated', checkContext);
  void loadLookups();
  return { dispose };
}
