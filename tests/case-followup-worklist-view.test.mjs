import test from 'node:test';
import assert from 'node:assert/strict';
import { CASE_FOLLOWUP_WORKLIST_FIELDS, CASE_FOLLOWUP_WORKLIST_KINDS, CASE_FOLLOWUP_WORKLIST_STATUSES,
  caseFollowupWorklistIdentity, isCaseFollowupWorklistDate, confirmCaseFollowupWorklistList,
  confirmCaseFollowupWorklistItem, caseFollowupWorklistFieldText, caseFollowupWorklistFieldSummary,
  formatCaseFollowupWorklistKind, formatCaseFollowupWorklistStatus } from '../public/data/case-followup-worklist-view.js';

const keys = ['kind', 'startDate', 'endDate', 'reason', 'followUpDate', 'outcome', 'note', 'status'];
const filterKeys = ['q', 'kind', 'status', 'followUpDate', 'caseId'];
const request = (extra = {}) => ({ page: 1, pageSize: 25, orgId: 'org-synthetic', q: '', kind: '', status: '', followUpDate: '', caseId: '', ...extra });
const string = value => ({ kind: 'string', value });
const row = (extra = {}) => ({ id: 'followup-synthetic', orgId: 'org-synthetic', version: 2,
  caseId: 'case-synthetic', caseNo: 'SYN-001', caseName: '合成個案', fields: {
    kind: string('pause'), startDate: string('2026-10-01'), endDate: string(''), reason: string('合成原因'),
    followUpDate: string('2026-10-10'), outcome: string('合成結果'), note: string('合成備註'), status: string('pending'),
  }, ...extra });
const list = (items, requested = request(), extra = {}) => ({ items, total: items.length, page: requested.page, pageSize: 25,
  filters: Object.fromEntries(filterKeys.map(key => [key, requested[key]])), ...extra });
const confirm = (items, requested = request()) => confirmCaseFollowupWorklistList(list(items, requested), requested);
const invalid = action => assert.throws(action, error => error.code === 'FOLLOWUP_RESPONSE_UNCONFIRMED'
  && error.message === '人工追蹤回應無法確認，請重新讀取。');

test('eight field names and original manual kind/status labels are fixed without lifecycle calculations', () => {
  assert.deepEqual(CASE_FOLLOWUP_WORKLIST_FIELDS.map(field => field.key), keys);
  assert.equal(CASE_FOLLOWUP_WORKLIST_FIELDS[4].label, '追蹤日期');
  assert(Object.isFrozen(CASE_FOLLOWUP_WORKLIST_FIELDS) && CASE_FOLLOWUP_WORKLIST_FIELDS.every(Object.isFrozen));
  assert.deepEqual(CASE_FOLLOWUP_WORKLIST_KINDS, { pause: '暫停', closure: '結案' });
  assert.deepEqual(CASE_FOLLOWUP_WORKLIST_STATUSES, { pending: '待追蹤', completed: '已完成追蹤', cancelled: '已取消追蹤' });
  assert(Object.isFrozen(CASE_FOLLOWUP_WORKLIST_KINDS) && Object.isFrozen(CASE_FOLLOWUP_WORKLIST_STATUSES));
});

test('list keeps CR/LF, whitespace, HTML-like strings and overlong saved contents without mutation', () => {
  const saved = row(); saved.fields.reason = string('  合成\r\n原因\n<img src=x> &  ');
  saved.fields.note = string('長'.repeat(11000) + '\n最後一句'); saved.fields.outcome = string('');
  const result = list([saved]), before = JSON.stringify(result);
  assert.equal(confirmCaseFollowupWorklistList(result, request()), result);
  assert.equal(JSON.stringify(result), before);
  assert.equal(caseFollowupWorklistFieldText(saved.fields.reason), saved.fields.reason.value);
  assert.equal(caseFollowupWorklistFieldText(saved.fields.note), saved.fields.note.value);
  assert.equal(caseFollowupWorklistFieldText(saved.fields.outcome), '已保存空文字');
});

test('unknown kind/status and noncalendar saved date strings remain visible without guessing or normalization', () => {
  const saved = row(); saved.fields.kind = string('  legacy\r\n類型  '); saved.fields.status = string('unknown-status');
  saved.fields.startDate = string('0000-02-29'); saved.fields.endDate = string('2026-02-30'); saved.fields.followUpDate = string('date pending');
  confirm([saved]);
  assert.equal(formatCaseFollowupWorklistKind(saved.fields.kind), '保存文字：  legacy\r\n類型  ');
  assert.equal(formatCaseFollowupWorklistStatus(saved.fields.status), '保存文字：unknown-status');
  assert.equal(caseFollowupWorklistFieldText(saved.fields.endDate), '2026-02-30');
  assert.equal(caseFollowupWorklistFieldText(saved.fields.followUpDate), 'date pending');
  assert.equal(formatCaseFollowupWorklistKind(string('pause')), '暫停（pause）');
  assert.equal(formatCaseFollowupWorklistStatus(string('completed')), '已完成追蹤（completed）');
});

test('each of five exact filter echoes is required including whitespace q and blank conditions', () => {
  const requested = request({ q: ' 合成 ', kind: 'closure', status: 'completed', followUpDate: '2026-10-10', caseId: 'case-synthetic' });
  const saved = row(); saved.fields.kind = string('closure'); saved.fields.status = string('completed'); saved.fields.note = string('原文 合成 後段');
  const result = list([saved], requested); assert.equal(confirmCaseFollowupWorklistList(result, requested), result);
  for (const key of filterKeys) invalid(() => confirmCaseFollowupWorklistList({ ...result, filters: { ...result.filters, [key]: '' } }, requested));
  const missing = structuredClone(result); delete missing.filters.kind; invalid(() => confirmCaseFollowupWorklistList(missing, requested));
  invalid(() => confirmCaseFollowupWorklistList({ ...result, filters: { ...result.filters, date: requested.followUpDate } }, requested));
  invalid(() => confirmCaseFollowupWorklistList({ ...result, filters: Object.create(result.filters) }, requested));
});

test('q matches a single own string in reason/outcome/note without metadata, date, kind, typed values or cross-field joins', () => {
  const saved = row({ caseName: 'metadata-only', caseNo: 'secret-number' }); saved.fields.note = string('前段 aBcDe 後段');
  confirm([saved], request({ q: 'ABCDE' }));
  for (const q of ['metadata-only', 'secret-number', 'case-synthetic', 'pause', 'pending', '2026-10-10', 'string']) invalid(() => confirm([saved], request({ q })));
  saved.fields.reason = string('前半'); saved.fields.outcome = string('後半'); saved.fields.note = { kind: 'object' };
  invalid(() => confirm([saved], request({ q: '前半後半' })));
  invalid(() => confirm([saved], request({ q: 'object' })));
});

test('kind/status/date filters verify their exact saved string tags and exact parent ID rather than names', () => {
  const saved = row({ caseName: '同名合成個案' }); confirm([saved], request({ kind: 'pause', status: 'pending', followUpDate: '2026-10-10', caseId: saved.caseId }));
  for (const extra of [{ kind: 'closure' }, { status: 'completed' }, { followUpDate: '2026-10-01' }, { caseId: saved.caseName }]) invalid(() => confirm([saved], request(extra)));
  for (const key of ['kind', 'status', 'followUpDate']) {
    const changed = structuredClone(saved); changed.fields[key] = { kind: 'null' };
    invalid(() => confirm([changed], request({ [key]: saved.fields[key].value })));
  }
});

test('all seven row keys and eight tag keys require own presence, data shape, exact organization and safe positive version', () => {
  const saved = row();
  for (const key of Object.keys(saved)) { const changed = { ...saved }; delete changed[key]; invalid(() => confirm([changed])); }
  for (const key of keys) { const fields = { ...saved.fields }; delete fields[key]; invalid(() => confirm([row({ fields })])); }
  for (const change of [{ id: '' }, { id: ' ' }, { orgId: 'other-org' }, { version: 0 }, { version: 1.5 },
    { version: Number.MAX_SAFE_INTEGER + 1 }, { caseId: '' }, { caseId: '\r\n' }, { caseName: {} }, { caseNo: 7 }, { unknown: 'hidden' }]) invalid(() => confirm([row(change)]));
  invalid(() => confirm([row({ fields: { ...saved.fields, unknown: string('private') } })]));
  invalid(() => confirm([row({ fields: Object.create(saved.fields) })]));
  confirm([row({ id: ' raw-id ', caseId: ' raw-parent ' })]);
});

test('nontext field tags show only distinct kinds and cannot include hidden scalar or nested contents', () => {
  const saved = row(), markers = [];
  for (const kind of ['missing', 'null', 'array', 'object', 'number', 'boolean']) {
    saved.fields.reason = { kind }; confirm([saved]); markers.push(caseFollowupWorklistFieldText(saved.fields.reason));
    invalid(() => confirm([row({ fields: { ...saved.fields, reason: { kind, value: 'private-synthetic' } } })]));
    invalid(() => confirm([row({ fields: { ...saved.fields, reason: { kind, extra: { private: true } } } })]));
  }
  assert.equal(new Set(markers).size, 6); assert.equal(markers[0], '未保存'); assert.equal(markers[1], '保存空值');
  for (const tag of [{ kind: 'string' }, { kind: 'string', value: null }, { kind: 'unsupported' }, { kind: 'string', value: 'raw', extra: true }]) {
    invalid(() => confirm([row({ fields: { ...saved.fields, reason: tag } })])); assert.equal(caseFollowupWorklistFieldText(tag), '保存內容未確認');
  }
  assert.equal(caseFollowupWorklistFieldText(string(' ')), ' ');
  assert.equal(formatCaseFollowupWorklistKind({ kind: 'missing' }), '未保存');
  assert.equal(formatCaseFollowupWorklistStatus({ kind: 'object' }), '已保存物件（內容不展示）');
});

test('pagination confirms exact25 bounds, remainder, unique identifiers and valid out-of-range empty pages', () => {
  const items = Array.from({ length: 25 }, (_, i) => row({ id: `followup-${i}` }));
  confirmCaseFollowupWorklistList(list(items, request(), { total: 26 }), request());
  const second = request({ page: 2 }); confirmCaseFollowupWorklistList(list([row()], second, { total: 26 }), second);
  const out = request({ page: 3 }); confirmCaseFollowupWorklistList(list([], out, { total: 26 }), out);
  confirmCaseFollowupWorklistList(list([], request(), { total: 0 }), request());
  for (const response of [list(items.slice(1), request(), { total: 26 }), list([...items, row()], request(), { total: 26 }),
    list([row(), row()]), list([row()], request(), { total: -1 }), list([row()], request(), { total: Number.MAX_SAFE_INTEGER + 1 }),
    list([row()], request(), { page: 2 }), list([row()], request(), { pageSize: 100 })]) invalid(() => confirmCaseFollowupWorklistList(response, request()));
});

test('array shape refuses holes, accessor items, side properties and inherited replacements without getter execution', () => {
  const sparse = new Array(1); invalid(() => confirmCaseFollowupWorklistList(list(sparse), request()));
  const extra = [row()]; extra.private = 'hidden'; invalid(() => confirmCaseFollowupWorklistList(list(extra), request()));
  const custom = [row()]; Object.setPrototypeOf(custom, {}); invalid(() => confirmCaseFollowupWorklistList(list(custom), request()));
  let reads = 0; const getter = [row()]; Object.defineProperty(getter, '0', { enumerable: true, get() { reads++; return row(); } });
  invalid(() => confirmCaseFollowupWorklistList(list(getter), request())); assert.equal(reads, 0);
});

test('malformed envelopes, symbols and accessors reject before reading data or coercing contents', () => {
  const result = list([row()]);
  for (const key of Object.keys(result)) { const missing = { ...result }; delete missing[key]; invalid(() => confirmCaseFollowupWorklistList(missing, request())); }
  invalid(() => confirmCaseFollowupWorklistList({ ...result, private: true }, request()));
  invalid(() => confirmCaseFollowupWorklistList({ ...result, [Symbol('private')]: true }, request()));
  invalid(() => confirmCaseFollowupWorklistList(Object.create(result), request()));
  let reads = 0; const getter = { ...result }; Object.defineProperty(getter, 'items', { enumerable: true, get() { reads++; return result.items; } });
  invalid(() => confirmCaseFollowupWorklistList(getter, request()));
  const tag = {}; Object.defineProperty(tag, 'kind', { enumerable: true, get() { reads++; return 'object'; } });
  invalid(() => confirm([row({ fields: { ...row().fields, reason: tag } })]));
  assert.equal(caseFollowupWorklistFieldText(tag), '保存內容未確認'); assert.equal(reads, 0);
});

test('closed request contract rejects unsupported state and bounds exact q and parent values without trim', () => {
  for (const extra of [{ page: 0 }, { page: 1.5 }, { pageSize: 100 }, { orgId: '' }, { q: 7 }, { q: 'x'.repeat(201) },
    { kind: 'other' }, { status: 'draft' }, { followUpDate: '2026-02-30' }, { caseId: ' ' }, { caseId: 'x'.repeat(501) },
    { caseId: null }, { date: '' }]) { const requested = request(extra); invalid(() => confirmCaseFollowupWorklistList(list([], requested), requested)); }
  const parent = ' ' + 'x'.repeat(498) + ' '; confirm([row({ caseId: parent })], request({ caseId: parent }));
  const saved = row(); saved.fields.reason = string('x'.repeat(200)); confirm([saved], request({ q: 'x'.repeat(200) }));
  const getter = request(); Object.defineProperty(getter, 'q', { enumerable: true, get() { throw new Error('must not read'); } });
  invalid(() => confirmCaseFollowupWorklistList(list([]), getter));
});

test('exact date query allows saved year zero and leap years without parsing business date strings', () => {
  for (const value of ['0000-01-01', '0000-02-29', '0001-01-01', '2000-02-29', '9999-12-31']) {
    assert.equal(isCaseFollowupWorklistDate(value), true); const saved = row(); saved.fields.followUpDate = string(value); confirm([saved], request({ followUpDate: value }));
  }
  for (const value of ['', null, {}, '1900-02-29', '2026-02-29', '2026-13-01', '2026-01-00', '10000-01-01', '2026-1-1', ' 2026-01-01 ']) assert.equal(isCaseFollowupWorklistDate(value), false);
});

test('fresh single confirms exact captured ID, organization and parent while accepting a newer safe version', () => {
  const requested = { id: 'followup-synthetic', orgId: 'org-synthetic', caseId: 'case-synthetic' }, saved = row({ version: 7 });
  assert.equal(confirmCaseFollowupWorklistItem({ item: saved }, requested), saved);
  for (const result of [{}, { item: null }, { item: row({ id: 'wrong-id' }) }, { item: row({ orgId: 'other-org' }) },
    { item: row({ caseId: 'other-parent' }) }, { item: saved, raw: 'hidden' }]) invalid(() => confirmCaseFollowupWorklistItem(result, requested));
  for (const changed of [{ ...requested, id: '' }, { ...requested, orgId: '' }, { ...requested, caseId: ' ' }, { ...requested, version: 2 }]) invalid(() => confirmCaseFollowupWorklistItem({ item: saved }, changed));
});

test('summaries keep full saved contents separately and do not split astral text or execute markup', () => {
  const value = '🙂'.repeat(161) + '\r\n最後一行 <script>合成</script>', tag = string(value);
  assert.equal(caseFollowupWorklistFieldSummary(tag), '🙂'.repeat(160) + '…');
  assert.equal(caseFollowupWorklistFieldText(tag), value); assert.equal(tag.value, value);
  assert.equal(caseFollowupWorklistFieldSummary(string('<img src=x> & 合成')), '<img src=x> & 合成');
});

test('frozen and null-prototype JSON projections are accepted without copying, mutation or write payloads', () => {
  const saved = row(), result = list([saved]); for (const tag of Object.values(saved.fields)) Object.freeze(tag);
  Object.freeze(saved.fields); Object.freeze(saved); Object.freeze(result.items); Object.freeze(result.filters); Object.freeze(result);
  assert.equal(confirmCaseFollowupWorklistList(result, request()), result);
  const nullRow = Object.assign(Object.create(null), row()); nullRow.fields = Object.assign(Object.create(null), nullRow.fields);
  const nullList = Object.assign(Object.create(null), list([nullRow])); nullList.filters = Object.assign(Object.create(null), nullList.filters);
  assert.equal(confirmCaseFollowupWorklistList(nullList, request()), nullList);
});

test('primitive identity normalizes undefined/null, ignores nested references and distinguishes colon collisions or falsy primitives', () => {
  const original = { user: { id: 'user-synthetic', employeeId: null, name: 'old-label' }, organizationId: 'org-synthetic', role: 'admin', organizations: [] };
  const equivalent = { ...original, user: { ...original.user, employeeId: undefined, name: 'new-label' }, organizations: [{ id: 'org-synthetic' }] };
  assert.equal(caseFollowupWorklistIdentity(original), caseFollowupWorklistIdentity(equivalent));
  assert.equal(caseFollowupWorklistIdentity({ user: undefined, role: undefined }), caseFollowupWorklistIdentity({ user: null, orgId: null, role: null }));
  for (const changed of [{ ...original, user: { ...original.user, id: 'other-user' } }, { ...original, organizationId: 'other-org' },
    { ...original, role: 'supervisor' }, { ...original, user: { ...original.user, employeeId: 'other-employee' } }]) assert.notEqual(caseFollowupWorklistIdentity(original), caseFollowupWorklistIdentity(changed));
  assert.notEqual(caseFollowupWorklistIdentity({ user: { id: 'a:b' }, orgId: 'c' }), caseFollowupWorklistIdentity({ user: { id: 'a' }, orgId: 'b:c' }));
  assert.notEqual(caseFollowupWorklistIdentity({ user: { employeeId: '' } }), caseFollowupWorklistIdentity({ user: { employeeId: null } }));
});
