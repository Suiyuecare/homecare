import { dateValid, fail } from './model.mjs';

const MAX_EXPORT_ROWS = 1000;
const MAX_EXPORT_BYTES = 2 * 1024 * 1024;

// Imported SQLite integers can exceed JavaScript's safe range. Preserve them until
// after the existing scope and query filters, without changing shared model reads.
export function safeVersionReader(db) {
  return { prepare(sql) {
    const statement = db.prepare(sql);
    if (sql !== 'SELECT * FROM records WHERE org_id=? AND entity=? ORDER BY created_at DESC,id') return statement;
    statement.setReadBigInts(true);
    return { all(...bindings) {
      return statement.all(...bindings).map(row => ({ ...row, version:
        typeof row.version === 'bigint' && row.version >= BigInt(Number.MIN_SAFE_INTEGER) && row.version <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(row.version) : row.version,
      }));
    } };
  } };
}

/** Common strict query contract; the caller supplies its existing status vocabulary. */
export function parseReportQuery(params, { full = false, statusLabels, statusMessage = '不支援的狀態', personKey = 'employeeId', date = true, caseFilter = true, search = false, asOf = false, expiryLabels = null }) {
  const allowed = new Set([...(date ? ['startDate', 'endDate'] : []), ...(caseFilter ? ['caseId'] : []), ...(search ? ['q'] : []), personKey, 'status', ...(asOf ? ['asOf'] : []), ...(expiryLabels ? ['expiry'] : []), ...(full ? [] : ['page', 'pageSize'])]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) {
      fail(422, 'INVALID_QUERY', '不允許未知或重複的查詢參數', { [key]: '查詢參數不合法' });
    }
  }
  const startDate = params.get('startDate'), endDate = params.get('endDate');
  if (date) {
    for (const [key, value] of [['startDate', startDate], ['endDate', endDate]]) {
      if (!dateValid(value)) fail(422, 'INVALID_DATE', '請填寫有效YYYY-MM-DD日期', { [key]: '必須為有效日期' });
    }
    const days = (Date.parse(endDate + 'T00:00:00Z') - Date.parse(startDate + 'T00:00:00Z')) / 86400000 + 1;
    if (days < 1 || days > 366) fail(422, 'DATE_RANGE', '日期區間須依先後排列，含兩端最多366日', { endDate: '日期區間不合法' });
  }
  const q = params.get('q') || '';
  if (search && q.length > 200) fail(422, 'INVALID_QUERY', '關鍵字最多200字元', { q: '關鍵字過長' });
  const status = params.get('status') || '';
  if (status && !Object.hasOwn(statusLabels, status)) fail(422, 'INVALID_STATUS', statusMessage, { status: '狀態不合法' });
  const asOfDate = params.get('asOf'), expiry = params.get('expiry') || '';
  if (asOf && !dateValid(asOfDate)) fail(422, 'INVALID_DATE', '請填寫有效YYYY-MM-DD日期', { asOf: '必須為有效日期' });
  if (expiryLabels && expiry && !Object.hasOwn(expiryLabels, expiry)) fail(422, 'INVALID_EXPIRY', '不支援的效期狀態', { expiry: '效期狀態不合法' });
  const filters = { ...(date ? { startDate, endDate } : {}), ...(caseFilter ? { caseId: params.get('caseId') || '' } : {}), ...(search ? { q } : {}), [personKey]: params.get(personKey) || '', status, ...(asOf ? { asOf: asOfDate } : {}), ...(expiryLabels ? { expiry } : {}) };
  let page = 1, pageSize = 25;
  if (!full) {
    const integer = (key, fallback, max) => {
      const value = params.has(key) ? params.get(key) : String(fallback);
      const number = Number(value);
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number) || number > max) {
        fail(422, 'PAGINATION', 'page須為正整數，pageSize介於1至100', { [key]: '分頁不合法' });
      }
      return number;
    };
    page = integer('page', 1, Number.MAX_SAFE_INTEGER);
    pageSize = integer('pageSize', 25, 100);
  }
  return { filters, page, pageSize };
}

/** Maps must already contain only the caller's currently readable master records. */
export function validateReportReferences(filters, cases, employees, { referenceKey = 'employeeId' } = {}) {
  for (const [key, records] of [['caseId', cases], [referenceKey, employees]]) {
    if (filters[key] && !records.has(filters[key])) fail(404, 'NOT_FOUND', '找不到可讀取的查詢對象');
  }
}

/** Check the entire result, never truncate. Call without value for an early count check. */
export function assertReportExportLimit(total, value) {
  if (total > MAX_EXPORT_ROWS || (value !== undefined && Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_EXPORT_BYTES)) {
    fail(413, 'REPORT_TOO_LARGE', '完整報表最多1000筆或2 MiB，請縮小查詢範圍');
  }
}
