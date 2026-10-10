import test from 'node:test';
import assert from 'node:assert/strict';
import { SUPERVISORY_VISIT_TEMPLATE_ID, SUPERVISORY_VISIT_QUESTIONS, SUPERVISORY_VISIT_STATUSES,
  isSupervisoryVisitDate, confirmSupervisoryVisitList, confirmSupervisoryVisitItem,
  supervisoryVisitAnswerText, supervisoryVisitAnswerSummary, formatSupervisoryVisitStatus } from '../public/data/supervisory-visit-view.js';

const keys = Array.from({ length: 10 }, (_, index) => 'q' + String(index + 1).padStart(3, '0'));
const request = (extra = {}) => ({ page: 1, pageSize: 25, orgId: 'org-synthetic', q: '', status: '', date: '', caseId: '', ...extra });
const row = (extra = {}) => ({ id: 'visit-synthetic', orgId: 'org-synthetic', version: 2, templateId: 'assessment-04',
  caseId: 'case-synthetic', caseNo: 'SYN-001', caseName: '合成個案', date: '2026-10-10', status: 'draft',
  answerContainerKind: 'object', hasUnknownAnswerKeys: false,
  answers: Object.fromEntries(keys.map(key => [key, { kind: 'missing' }])), ...extra });
const list = (items, requested = request(), extra = {}) => ({ items, total: items.length, page: requested.page, pageSize: 25,
  filters: Object.fromEntries(['q', 'status', 'date', 'caseId'].map(key => [key, requested[key]])), ...extra });
const confirm = (items, requested = request()) => confirmSupervisoryVisitList(list(items, requested), requested);
const invalid = action => assert.throws(action, error => error.code === 'VISIT_RESPONSE_UNCONFIRMED'
  && error.message === '督導訪視回應無法確認，請重新讀取。');

test('ten question names are fixed and frozen independently of clinical options and scores', () => {
  assert.equal(SUPERVISORY_VISIT_TEMPLATE_ID, 'assessment-04');
  assert.deepEqual(SUPERVISORY_VISIT_QUESTIONS.map(item => item.key), keys);
  assert.equal(SUPERVISORY_VISIT_QUESTIONS[0].label, '訪視日期');
  assert.equal(SUPERVISORY_VISIT_QUESTIONS[9].label, '下次評估日期');
  assert(Object.isFrozen(SUPERVISORY_VISIT_QUESTIONS) && SUPERVISORY_VISIT_QUESTIONS.every(Object.isFrozen));
  assert.deepEqual(SUPERVISORY_VISIT_STATUSES, { draft: '草稿', submitted: '已提交' });
  assert(Object.isFrozen(SUPERVISORY_VISIT_STATUSES));
});

test('list confirmation retains exact strings and never mutates the saved projection', () => {
  const saved = row(); saved.answers.q007 = { kind: 'string', value: ' 合成內容\r\n第二行 ' };
  saved.answers.q008 = { kind: 'string', value: '' }; saved.hasUnknownAnswerKeys = true;
  const result = list([saved]), before = JSON.stringify(result);
  assert.equal(confirmSupervisoryVisitList(result, request()), result);
  assert.equal(JSON.stringify(result), before);
  assert.equal(supervisoryVisitAnswerText(saved.answers.q007), ' 合成內容\r\n第二行 ');
  assert.equal(supervisoryVisitAnswerText(saved.answers.q008), '已保存空文字');
});

test('query echoes must match all four exact original conditions including blank and whitespace q', () => {
  const requested = request({ q: ' 合成 ', status: 'submitted', date: '2026-10-10', caseId: 'case-synthetic' });
  const saved = row({ status: 'submitted' }); saved.answers.q004 = { kind: 'string', value: '原文 合成 位置' };
  const result = list([saved], requested); assert.equal(confirmSupervisoryVisitList(result, requested), result);
  for (const key of ['q', 'status', 'date', 'caseId']) invalid(() => confirmSupervisoryVisitList({ ...result, filters: { ...result.filters, [key]: '' } }, requested));
  invalid(() => confirmSupervisoryVisitList({ ...result, filters: { ...result.filters, unknown: 'hidden' } }, requested));
  const missing = structuredClone(result); delete missing.filters.caseId; invalid(() => confirmSupervisoryVisitList(missing, requested));
});

test('search matches one own string at a time without metadata or cross-answer joins', () => {
  const saved = row({ caseName: 'metadata-only', caseNo: 'SECRET' });
  saved.answers.q007 = { kind: 'string', value: '前端 aBcDe 後段' };
  confirm([saved], request({ q: 'ABCDE' }));
  for (const q of ['metadata-only', 'SECRET', 'case-synthetic', 'assessment-04', 'missing']) invalid(() => confirm([saved], request({ q })));
  saved.answers.q007 = { kind: 'string', value: '前半' }; saved.answers.q008 = { kind: 'string', value: '後半' };
  invalid(() => confirm([saved], request({ q: '前半後半' })));
});

test('every saved metadata field has exact presence, type, template, organization and safe version', () => {
  const saved = row(); confirm([saved]);
  for (const key of Object.keys(saved)) { const changed = { ...saved }; delete changed[key]; invalid(() => confirm([changed])); }
  for (const change of [{ id: '' }, { id: ' ' }, { orgId: 'other-synthetic' }, { version: 0 }, { version: 1.5 },
    { version: Number.MAX_SAFE_INTEGER + 1 }, { templateId: 'assessment-06' }, { caseId: '' }, { caseName: {} }, { caseNo: 7 },
    { date: null }, { status: 'toString' }, { hasUnknownAnswerKeys: 'true' }, { unexpected: 'hidden' }]) invalid(() => confirm([row(change)]));
});

test('saved calendar dates accept year zero but reject normalized and noncalendar values', () => {
  for (const value of ['0000-01-01', '0000-02-29', '0001-01-01', '2000-02-29', '9999-12-31']) {
    assert(isSupervisoryVisitDate(value)); confirm([row({ date: value })]);
  }
  for (const value of ['', null, {}, '1900-02-29', '2026-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '2026-01-00', '10000-01-01', '2026-1-1', ' 2026-01-01 ']) {
    assert.equal(isSupervisoryVisitDate(value), false); invalid(() => confirm([row({ date: value })]));
  }
});

test('nontext answers have kind only and cannot return scalar or nested saved values', () => {
  const saved = row();
  for (const kind of ['missing', 'null', 'array', 'object', 'number', 'boolean']) {
    saved.answers.q007 = { kind }; confirm([saved]);
    assert.equal(typeof supervisoryVisitAnswerText(saved.answers.q007), 'string');
    invalid(() => confirm([row({ answers: { ...saved.answers, q007: { kind, value: 'hidden-synthetic' } } })]));
  }
  for (const answer of [{ kind: 'unsupported' }, { kind: 'string' }, { kind: 'string', value: null }, { kind: 'string', value: 'visible', nested: { secret: true } }]) {
    invalid(() => confirm([row({ answers: { ...saved.answers, q007: answer } })]));
    assert.equal(supervisoryVisitAnswerText(answer), '保存內容未確認');
  }
});

test('missing, empty and hidden-type markers remain distinct without clinical interpretation', () => {
  const answers = ['missing', 'null', 'array', 'object', 'number', 'boolean'].map(kind => ({ kind }));
  const labels = answers.map(supervisoryVisitAnswerText);
  assert.equal(new Set(labels).size, answers.length);
  assert.equal(labels[0], '未保存'); assert.equal(labels[1], '保存空值');
  assert.equal(supervisoryVisitAnswerText({ kind: 'string', value: '' }), '已保存空文字');
  assert.equal(supervisoryVisitAnswerText({ kind: 'string', value: '  ' }), '  ');
  assert.equal(formatSupervisoryVisitStatus('submitted'), '已提交');
  assert.equal(formatSupervisoryVisitStatus('toString'), '狀態未確認');
});

test('answer whitelist refuses missing or extra keys and inherited containers without coercion', () => {
  const saved = row();
  const missing = { ...saved.answers }; delete missing.q010;
  invalid(() => confirm([row({ answers: missing })]));
  invalid(() => confirm([row({ answers: { ...saved.answers, unknownPrivateName: { kind: 'string', value: 'hidden' } } })]));
  invalid(() => confirm([row({ answers: Object.create(saved.answers) })]));
  let accesses = 0;
  const getters = { ...saved.answers }; Object.defineProperty(getters, 'q001', { enumerable: true, get() { accesses++; return { kind: 'string', value: 'hidden' }; } });
  invalid(() => confirm([row({ answers: getters })])); assert.equal(accesses, 0);
});

test('nonobject answer containers return ten missing tags and cannot claim hidden keys or text', () => {
  for (const answerContainerKind of ['missing', 'null', 'array', 'string', 'number', 'boolean']) {
    const saved = row({ answerContainerKind }); confirm([saved]);
    invalid(() => confirm([row({ answerContainerKind, hasUnknownAnswerKeys: true })]));
    invalid(() => confirm([row({ answerContainerKind, answers: { ...saved.answers, q007: { kind: 'string', value: 'hidden' } } })]));
  }
  invalid(() => confirm([row({ answerContainerKind: 'unsupported' })]));
});

test('pagination confirms exact page lengths, unique IDs and valid out-of-range empty pages', () => {
  const items = Array.from({ length: 25 }, (_, i) => row({ id: `visit-synthetic-${i}` }));
  confirmSupervisoryVisitList(list(items, request(), { total: 26 }), request());
  const second = request({ page: 2 }); confirmSupervisoryVisitList(list([row()], second, { total: 26 }), second);
  const out = request({ page: 3 }); confirmSupervisoryVisitList(list([], out, { total: 26 }), out);
  for (const result of [list(items.slice(1), request(), { total: 26 }), list([...items, row()], request(), { total: 26 }),
    list([row(), row()]), list([row()], request(), { total: Number.MAX_SAFE_INTEGER + 1 }),
    list([row()], request(), { total: -1 }), list([row()], request(), { page: 2 }), list([row()], request(), { pageSize: 100 })]) invalid(() => confirmSupervisoryVisitList(result, request()));
  const sparse = new Array(1); invalid(() => confirmSupervisoryVisitList(list(sparse), request()));
  const extras = [row()]; extras.secret = 'hidden'; invalid(() => confirmSupervisoryVisitList(list(extras), request()));
});

test('malformed envelopes and accessor or symbol properties reject without reading hidden values', () => {
  const result = list([row()]);
  for (const key of Object.keys(result)) { const missing = { ...result }; delete missing[key]; invalid(() => confirmSupervisoryVisitList(missing, request())); }
  invalid(() => confirmSupervisoryVisitList({ ...result, hidden: true }, request()));
  invalid(() => confirmSupervisoryVisitList({ ...result, [Symbol('hidden')]: true }, request()));
  let accesses = 0; const getter = { ...result };
  Object.defineProperty(getter, 'items', { enumerable: true, get() { accesses++; return result.items; } });
  invalid(() => confirmSupervisoryVisitList(getter, request())); assert.equal(accesses, 0);
  const inherited = Object.create(result); invalid(() => confirmSupervisoryVisitList(inherited, request()));
});

test('request confirmation rejects unsupported query states and bounds caseId at 500 without trim', () => {
  for (const extra of [{ page: 0 }, { page: 1.5 }, { pageSize: 100 }, { orgId: '' }, { q: 7 }, { q: 'x'.repeat(201) },
    { date: '2026-02-30' }, { status: 'approved' }, { caseId: ' ' }, { caseId: 'x'.repeat(501) }, { caseId: null }, { unexpected: 'hidden' }]) {
    const requested = request(extra); invalid(() => confirmSupervisoryVisitList(list([], requested), requested));
  }
  const requested = request({ caseId: ' ' + 'x'.repeat(498) + ' ' });
  confirm([row({ caseId: requested.caseId })], requested);
  const longQ = request({ q: 'x'.repeat(200) }), saved = row(); saved.answers.q007 = { kind: 'string', value: longQ.q };
  confirm([saved], longQ);
});

test('filters confirm saved fill date and exact parent ID rather than clinical date or names', () => {
  const saved = row({ caseName: '同名合成個案' }); saved.answers.q001 = { kind: 'string', value: '2026-10-01' };
  confirm([saved], request({ date: '2026-10-10', caseId: saved.caseId, status: 'draft' }));
  for (const extra of [{ date: '2026-10-01' }, { caseId: saved.caseName }, { status: 'submitted' }]) invalid(() => confirm([saved], request(extra)));
});

test('fresh single confirmation permits a later version but keeps exact ID org and template', () => {
  const requested = { id: 'visit-synthetic', orgId: 'org-synthetic' }, saved = row({ version: 7 });
  assert.equal(confirmSupervisoryVisitItem({ item: saved }, requested), saved);
  for (const result of [{}, { item: null }, { item: row({ id: 'wrong-id' }) }, { item: row({ orgId: 'other-org' }) },
    { item: row({ templateId: 'assessment-06' }) }, { item: saved, raw: 'hidden' }]) invalid(() => confirmSupervisoryVisitItem(result, requested));
  for (const bad of [{ ...requested, id: '' }, { ...requested, orgId: '' }, { ...requested, version: 7 }]) invalid(() => confirmSupervisoryVisitItem({ item: saved }, bad));
});

test('summaries preserve complete saved text separately and never split astral characters', () => {
  const value = '🙂'.repeat(161) + '\r\n最後一行 <script>合成</script>', answer = { kind: 'string', value };
  assert.equal(supervisoryVisitAnswerSummary(answer), '🙂'.repeat(160) + '…');
  assert.equal(supervisoryVisitAnswerText(answer), value);
  assert.equal(supervisoryVisitAnswerSummary({ kind: 'string', value: '<img src=x> & 合成' }), '<img src=x> & 合成');
  assert.equal(answer.value, value);
});

test('frozen DTO and null-prototype data are accepted without mutation or creating write payloads', () => {
  const saved = row(), result = list([saved]);
  for (const answer of Object.values(saved.answers)) Object.freeze(answer);
  Object.freeze(saved.answers); Object.freeze(saved); Object.freeze(result.items); Object.freeze(result.filters); Object.freeze(result);
  assert.equal(confirmSupervisoryVisitList(result, request()), result);
  const nullRow = Object.assign(Object.create(null), row());
  nullRow.answers = Object.assign(Object.create(null), nullRow.answers);
  confirm([nullRow]);
  assert.deepEqual(Object.keys(saved), ['id', 'orgId', 'version', 'templateId', 'caseId', 'caseNo', 'caseName', 'date', 'status', 'answerContainerKind', 'hasUnknownAnswerKeys', 'answers']);
});
