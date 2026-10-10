const MAX_ITEMS = 10000;
const PAGE_SIZE = 100;
const MAX_BYTES = 2 * 1024 * 1024;
const pageKeys = ['items', 'total', 'page', 'pageSize'];
const personKeys = ['caseId', 'employeeId'];
const projectionKeys = ['id', 'orgId', 'version', 'number', 'name', 'status', 'selectionName', 'label'];
const definitions = {
  cases: { number: 'caseNo', fallback: '未取得個案名稱', all: '全部可讀個案', field: 'caseId', statuses: { active: '服務中', paused: '暫停', closed: '已結案' } },
  employees: { number: 'employeeNo', fallback: '未取得服務人員名稱', all: '全部可讀人員', field: 'employeeId', statuses: { active: '在職', inactive: '停用' } },
};
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const dataObject = value => plain(value) && Reflect.ownKeys(value).every(key => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return typeof key === 'string' && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value');
});
const exact = (value, keys) => dataObject(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const dense = value => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  && Reflect.ownKeys(value).length === value.length + 1 && Reflect.ownKeys(value).every((key, index) => {
    if (index === value.length) return key === 'length';
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return key === String(index) && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value');
  });
const nonempty = value => typeof value === 'string' && value !== '';
const fieldError = field => Object.assign(new Error('原選項目前不可用，請重新選擇或明確選擇全部。'), { fields: { [field]: '原選項目前不可用，請重新選擇或明確選擇全部。' }, code: 'CALENDAR_PERSON_UNAVAILABLE' });
const lookupError = () => Object.assign(new Error('未取得完整且一致的個案與人員名單，請重新讀取。'), { code: 'CALENDAR_LOOKUP_UNCONFIRMED' });
const resultError = () => Object.assign(new Error('班表條件或名稱回顯未確認，請重新讀取。'), { code: 'CALENDAR_PERSON_UNCONFIRMED' });
const withinBytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_BYTES;
const optionLabel = (row, definition) => `${row.number || '未填編號'} · ${row.selectionName}（${Object.hasOwn(definition.statuses, row.status) ? definition.statuses[row.status] : '狀態未確認'}） · ${row.id}`;

export function calendarPersonFilters(person = { caseId: '', employeeId: '' }) {
  if (!exact(person, personKeys) || personKeys.some(key => typeof person[key] !== 'string')) {
    throw Object.assign(new Error('請選擇有效的個案與服務人員條件。'), { code: 'CALENDAR_PERSON_UNCONFIRMED', fields: { caseId: '請選擇有效的個案條件。', employeeId: '請選擇有效的服務人員條件。' } });
  }
  return Object.freeze({ caseId: person.caseId, employeeId: person.employeeId });
}

function project(row, definition, orgId) {
  if (!dataObject(row) || !['id', 'orgId', 'version'].every(key => Object.hasOwn(row, key))
    || !nonempty(row.id) || row.orgId !== orgId || !Number.isSafeInteger(row.version) || row.version < 1) throw lookupError();
  const value = {
    id: row.id, orgId: row.orgId, version: row.version,
    number: Object.hasOwn(row, definition.number) && typeof row[definition.number] === 'string' ? row[definition.number] : '',
    name: Object.hasOwn(row, 'name') && typeof row.name === 'string' ? row.name : '',
    status: Object.hasOwn(row, 'status') && typeof row.status === 'string' ? row.status : '',
  };
  value.selectionName = value.name || definition.fallback;
  value.label = optionLabel(value, definition);
  return Object.freeze(value);
}

export function confirmCalendarLookupPage(response, entity, orgId, page, expectedTotal) {
  try {
    if (typeof entity !== 'string' || !Object.hasOwn(definitions, entity) || !nonempty(orgId) || !Number.isSafeInteger(page) || page < 1 || page > 100
      || !exact(response, pageKeys) || !Number.isSafeInteger(response.total) || response.total < 0 || response.total > MAX_ITEMS
      || response.page !== page || response.pageSize !== PAGE_SIZE || (expectedTotal !== undefined && response.total !== expectedTotal)
      || !dense(response.items) || response.items.length !== Math.min(PAGE_SIZE, Math.max(0, response.total - (page - 1) * PAGE_SIZE))
      || page > Math.max(1, Math.ceil(response.total / PAGE_SIZE))) throw lookupError();
    const seen = new Set();
    const items = response.items.map(row => {
      const value = project(row, definitions[entity], orgId);
      if (seen.has(value.id)) throw lookupError();
      seen.add(value.id); return value;
    });
    if (!withinBytes(items)) throw lookupError();
    return Object.freeze({ items: Object.freeze(items), total: response.total, page, pageSize: PAGE_SIZE });
  } catch { throw lookupError(); }
}

/** Complete confirmation consumes raw API pages, not already projected pages. */
export function confirmCalendarLookups(pages, entity, orgId) {
  try {
    if (!dense(pages) || pages.length < 1 || pages.length > 100) throw lookupError();
    const rows = [], seen = new Set(); let total;
    for (let index = 0; index < pages.length; index++) {
      const page = confirmCalendarLookupPage(pages[index], entity, orgId, index + 1, total);
      total = page.total;
      for (const row of page.items) {
        if (seen.has(row.id)) throw lookupError();
        seen.add(row.id); rows.push(row);
      }
    }
    if (pages.length !== Math.max(1, Math.ceil(total / PAGE_SIZE)) || rows.length !== total || !withinBytes(rows)) throw lookupError();
    return Object.freeze(rows);
  } catch { throw lookupError(); }
}

function checkedLookups(lookups) {
  if (!exact(lookups, ['cases', 'employees'])) throw lookupError();
  const organizations = new Set();
  for (const entity of ['cases', 'employees']) {
    const rows = lookups[entity], seen = new Set(), definition = definitions[entity];
    if (!dense(rows) || rows.length > MAX_ITEMS) throw lookupError();
    for (const row of rows) {
      if (!exact(row, projectionKeys) || !nonempty(row.id) || !nonempty(row.orgId) || !Number.isSafeInteger(row.version) || row.version < 1
        || ['number', 'name', 'status', 'selectionName', 'label'].some(key => typeof row[key] !== 'string')
        || row.selectionName !== (row.name || definition.fallback) || row.label !== optionLabel(row, definition) || seen.has(row.id)) throw lookupError();
      seen.add(row.id); organizations.add(row.orgId);
    }
    if (!withinBytes(rows)) throw lookupError();
  }
  if (organizations.size > 1) throw lookupError();
  return lookups;
}

/** IDs select records; names only confirm the existing server selection echo. */
export function calendarPersonSelection(person, lookups) {
  const filters = calendarPersonFilters(person), confirmed = checkedLookups(lookups), selection = {};
  for (const [entity, key] of [['cases', 'case'], ['employees', 'employee']]) {
    const definition = definitions[entity], id = filters[definition.field];
    const row = id === '' ? null : confirmed[entity].find(value => value.id === id);
    if (id !== '' && !row) throw fieldError(definition.field);
    selection[key] = row ? row.selectionName : definition.all;
  }
  return Object.freeze(selection);
}

export function confirmCalendarPersonSelection(result, person, lookups) {
  const filters = calendarPersonFilters(person), expected = calendarPersonSelection(filters, lookups);
  if (!dataObject(result) || !Object.hasOwn(result, 'filters') || !Object.hasOwn(result, 'selection')
    || !exact(result.filters, ['startDate', 'endDate', 'caseId', 'employeeId', 'status'])
    || !exact(result.selection, ['case', 'employee', 'status'])
    || personKeys.some(key => result.filters[key] !== filters[key])
    || result.selection.case !== expected.case || result.selection.employee !== expected.employee) throw resultError();
  return result;
}
