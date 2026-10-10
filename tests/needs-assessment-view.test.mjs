import test from 'node:test';
import assert from 'node:assert/strict';
import { NEEDS_ASSESSMENT_TEMPLATE_ID, NEEDS_ASSESSMENT_QUESTIONS, NEEDS_ASSESSMENT_STATUSES,
  isNeedsAssessmentDate, confirmNeedsAssessmentList, confirmNeedsAssessmentItem,
  needsAssessmentAnswerText, needsAssessmentAnswerSummary, formatNeedsAssessmentStatus, needsAssessmentIdentity } from '../public/data/needs-assessment-view.js';

const keys = Array.from({ length: 9 }, (_, index) => 'q' + String(index + 1).padStart(3, '0'));
const request = (extra = {}) => ({ page: 1, pageSize: 25, orgId: 'org-synthetic', q: '', status: '', date: '', caseId: '', ...extra });
const row = (extra = {}) => ({ id: 'needs-synthetic', orgId: 'org-synthetic', version: 2, templateId: 'assessment-03',
  caseId: 'case-synthetic', caseNo: 'SYN-001', caseName: '合成個案', date: '2026-10-10', status: 'draft',
  answerContainerKind: 'object', hasUnknownAnswerKeys: false,
  answers: Object.fromEntries(keys.map(key => [key, { kind: 'missing' }])), ...extra });
const list = (items, requested = request(), extra = {}) => ({ items, total: items.length, page: requested.page, pageSize: 25,
  filters: Object.fromEntries(['q', 'status', 'date', 'caseId'].map(key => [key, requested[key]])), ...extra });
const confirm = (items, requested = request()) => confirmNeedsAssessmentList(list(items, requested), requested);
const invalid = action => assert.throws(action, error => error.code === 'NEEDS_ASSESSMENT_RESPONSE_UNCONFIRMED'
  && error.message === '需求評估回應無法確認，請重新讀取。');

test('nine question names are fixed and frozen independently of clinical options and scores', () => {
  assert.equal(NEEDS_ASSESSMENT_TEMPLATE_ID, 'assessment-03');
  assert.deepEqual(NEEDS_ASSESSMENT_QUESTIONS.map(item => item.key), keys);
  assert.equal(NEEDS_ASSESSMENT_QUESTIONS[0].label, '個案姓名');
  assert.equal(NEEDS_ASSESSMENT_QUESTIONS[8].label, '填表日期');
  assert(Object.isFrozen(NEEDS_ASSESSMENT_QUESTIONS) && NEEDS_ASSESSMENT_QUESTIONS.every(Object.isFrozen));
  assert.deepEqual(NEEDS_ASSESSMENT_STATUSES, { draft: '草稿', submitted: '已提交' });
  assert(Object.isFrozen(NEEDS_ASSESSMENT_STATUSES));
});

test('list confirmation retains exact strings and never mutates the saved projection', () => {
  const saved = row(); saved.answers.q007 = { kind: 'string', value: ' 合成內容\r\n第二行 ' };
  saved.answers.q008 = { kind: 'string', value: '' }; saved.hasUnknownAnswerKeys = true;
  const result = list([saved]), before = JSON.stringify(result);
  assert.equal(confirmNeedsAssessmentList(result, request()), result);
  assert.equal(JSON.stringify(result), before);
  assert.equal(needsAssessmentAnswerText(saved.answers.q007), ' 合成內容\r\n第二行 ');
  assert.equal(needsAssessmentAnswerText(saved.answers.q008), '已保存空文字');
});

test('query echoes must match all four exact original conditions including blank and whitespace q', () => {
  const requested = request({ q: ' 合成 ', status: 'submitted', date: '2026-10-10', caseId: 'case-synthetic' });
  const saved = row({ status: 'submitted' }); saved.answers.q004 = { kind: 'string', value: '原文 合成 位置' };
  const result = list([saved], requested); assert.equal(confirmNeedsAssessmentList(result, requested), result);
  for (const key of ['q', 'status', 'date', 'caseId']) invalid(() => confirmNeedsAssessmentList({ ...result, filters: { ...result.filters, [key]: '' } }, requested));
  invalid(() => confirmNeedsAssessmentList({ ...result, filters: { ...result.filters, unknown: 'hidden' } }, requested));
  const missing = structuredClone(result); delete missing.filters.caseId; invalid(() => confirmNeedsAssessmentList(missing, requested));
});

test('search matches one own string at a time without metadata or cross-answer joins', () => {
  const saved = row({ caseName: 'metadata-only', caseNo: 'SECRET' });
  saved.answers.q007 = { kind: 'string', value: '前端 aBcDe 後段' };
  confirm([saved], request({ q: 'ABCDE' }));
  for (const q of ['metadata-only', 'SECRET', 'case-synthetic', 'assessment-03', 'missing']) invalid(() => confirm([saved], request({ q })));
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
    assert(isNeedsAssessmentDate(value)); confirm([row({ date: value })]);
  }
  for (const value of ['', null, {}, '1900-02-29', '2026-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '2026-01-00', '10000-01-01', '2026-1-1', ' 2026-01-01 ']) {
    assert.equal(isNeedsAssessmentDate(value), false); invalid(() => confirm([row({ date: value })]));
  }
});

test('nontext answers have kind only and cannot return scalar or nested saved values', () => {
  const saved = row();
  for (const kind of ['missing', 'null', 'array', 'object', 'number', 'boolean']) {
    saved.answers.q007 = { kind }; confirm([saved]);
    assert.equal(typeof needsAssessmentAnswerText(saved.answers.q007), 'string');
    invalid(() => confirm([row({ answers: { ...saved.answers, q007: { kind, value: 'hidden-synthetic' } } })]));
  }
  for (const answer of [{ kind: 'unsupported' }, { kind: 'string' }, { kind: 'string', value: null }, { kind: 'string', value: 'visible', nested: { secret: true } }]) {
    invalid(() => confirm([row({ answers: { ...saved.answers, q007: answer } })]));
    assert.equal(needsAssessmentAnswerText(answer), '保存內容未確認');
  }
});

test('missing, empty and hidden-type markers remain distinct without clinical interpretation', () => {
  const answers = ['missing', 'null', 'array', 'object', 'number', 'boolean'].map(kind => ({ kind }));
  const labels = answers.map(needsAssessmentAnswerText);
  assert.equal(new Set(labels).size, answers.length);
  assert.equal(labels[0], '未保存'); assert.equal(labels[1], '保存空值');
  assert.equal(needsAssessmentAnswerText({ kind: 'string', value: '' }), '已保存空文字');
  assert.equal(needsAssessmentAnswerText({ kind: 'string', value: '  ' }), '  ');
  assert.equal(formatNeedsAssessmentStatus('submitted'), '已提交');
  assert.equal(formatNeedsAssessmentStatus('toString'), '狀態未確認');
});

test('answer whitelist refuses missing or extra keys and inherited containers without coercion', () => {
  const saved = row();
  const missing = { ...saved.answers }; delete missing.q009;
  invalid(() => confirm([row({ answers: missing })]));
  invalid(() => confirm([row({ answers: { ...saved.answers, unknownPrivateName: { kind: 'string', value: 'hidden' } } })]));
  invalid(() => confirm([row({ answers: Object.create(saved.answers) })]));
  let accesses = 0;
  const getters = { ...saved.answers }; Object.defineProperty(getters, 'q001', { enumerable: true, get() { accesses++; return { kind: 'string', value: 'hidden' }; } });
  invalid(() => confirm([row({ answers: getters })])); assert.equal(accesses, 0);
});

test('nonobject answer containers return nine missing tags and cannot claim hidden keys or text', () => {
  for (const answerContainerKind of ['missing', 'null', 'array', 'string', 'number', 'boolean']) {
    const saved = row({ answerContainerKind }); confirm([saved]);
    invalid(() => confirm([row({ answerContainerKind, hasUnknownAnswerKeys: true })]));
    invalid(() => confirm([row({ answerContainerKind, answers: { ...saved.answers, q007: { kind: 'string', value: 'hidden' } } })]));
  }
  invalid(() => confirm([row({ answerContainerKind: 'unsupported' })]));
});

test('pagination confirms exact page lengths, unique IDs and valid out-of-range empty pages', () => {
  const items = Array.from({ length: 25 }, (_, i) => row({ id: `needs-synthetic-${i}` }));
  confirmNeedsAssessmentList(list(items, request(), { total: 26 }), request());
  const second = request({ page: 2 }); confirmNeedsAssessmentList(list([row()], second, { total: 26 }), second);
  const out = request({ page: 3 }); confirmNeedsAssessmentList(list([], out, { total: 26 }), out);
  for (const result of [list(items.slice(1), request(), { total: 26 }), list([...items, row()], request(), { total: 26 }),
    list([row(), row()]), list([row()], request(), { total: Number.MAX_SAFE_INTEGER + 1 }),
    list([row()], request(), { total: -1 }), list([row()], request(), { page: 2 }), list([row()], request(), { pageSize: 100 })]) invalid(() => confirmNeedsAssessmentList(result, request()));
  const sparse = new Array(1); invalid(() => confirmNeedsAssessmentList(list(sparse), request()));
  const extras = [row()]; extras.secret = 'hidden'; invalid(() => confirmNeedsAssessmentList(list(extras), request()));
});

test('malformed envelopes and accessor or symbol properties reject without reading hidden values', () => {
  const result = list([row()]);
  for (const key of Object.keys(result)) { const missing = { ...result }; delete missing[key]; invalid(() => confirmNeedsAssessmentList(missing, request())); }
  invalid(() => confirmNeedsAssessmentList({ ...result, hidden: true }, request()));
  invalid(() => confirmNeedsAssessmentList({ ...result, [Symbol('hidden')]: true }, request()));
  let accesses = 0; const getter = { ...result };
  Object.defineProperty(getter, 'items', { enumerable: true, get() { accesses++; return result.items; } });
  invalid(() => confirmNeedsAssessmentList(getter, request())); assert.equal(accesses, 0);
  const inherited = Object.create(result); invalid(() => confirmNeedsAssessmentList(inherited, request()));
});

test('request confirmation rejects unsupported query states and bounds caseId at 500 without trim', () => {
  for (const extra of [{ page: 0 }, { page: 1.5 }, { pageSize: 100 }, { orgId: '' }, { q: 7 }, { q: 'x'.repeat(201) },
    { date: '2026-02-30' }, { status: 'approved' }, { caseId: ' ' }, { caseId: 'x'.repeat(501) }, { caseId: null }, { unexpected: 'hidden' }]) {
    const requested = request(extra); invalid(() => confirmNeedsAssessmentList(list([], requested), requested));
  }
  const requested = request({ caseId: ' ' + 'x'.repeat(498) + ' ' });
  confirm([row({ caseId: requested.caseId })], requested);
  const longQ = request({ q: 'x'.repeat(200) }), saved = row(); saved.answers.q007 = { kind: 'string', value: longQ.q };
  confirm([saved], longQ);
});

test('filters confirm saved fill date and exact parent ID rather than clinical date or names', () => {
  const saved = row({ caseName: '同名合成個案' }); saved.answers.q003 = { kind: 'string', value: '2026-10-01' };
  confirm([saved], request({ date: '2026-10-10', caseId: saved.caseId, status: 'draft' }));
  for (const extra of [{ date: '2026-10-01' }, { caseId: saved.caseName }, { status: 'submitted' }]) invalid(() => confirm([saved], request(extra)));
});

test('fresh single confirmation permits a later version but keeps exact ID org and template', () => {
  const requested = { id: 'needs-synthetic', orgId: 'org-synthetic' }, saved = row({ version: 7 });
  assert.equal(confirmNeedsAssessmentItem({ item: saved }, requested), saved);
  for (const result of [{}, { item: null }, { item: row({ id: 'wrong-id' }) }, { item: row({ orgId: 'other-org' }) },
    { item: row({ templateId: 'assessment-06' }) }, { item: saved, raw: 'hidden' }]) invalid(() => confirmNeedsAssessmentItem(result, requested));
  for (const bad of [{ ...requested, id: '' }, { ...requested, orgId: '' }, { ...requested, version: 7 }]) invalid(() => confirmNeedsAssessmentItem({ item: saved }, bad));
});

test('summaries preserve complete saved text separately and never split astral characters', () => {
  const value = '🙂'.repeat(161) + '\r\n最後一行 <script>合成</script>', answer = { kind: 'string', value };
  assert.equal(needsAssessmentAnswerSummary(answer), '🙂'.repeat(160) + '…');
  assert.equal(needsAssessmentAnswerText(answer), value);
  assert.equal(needsAssessmentAnswerSummary({ kind: 'string', value: '<img src=x> & 合成' }), '<img src=x> & 合成');
  assert.equal(answer.value, value);
});

test('frozen DTO and null-prototype data are accepted without mutation or creating write payloads', () => {
  const saved = row(), result = list([saved]);
  for (const answer of Object.values(saved.answers)) Object.freeze(answer);
  Object.freeze(saved.answers); Object.freeze(saved); Object.freeze(result.items); Object.freeze(result.filters); Object.freeze(result);
  assert.equal(confirmNeedsAssessmentList(result, request()), result);
  const nullRow = Object.assign(Object.create(null), row());
  nullRow.answers = Object.assign(Object.create(null), nullRow.answers);
  confirm([nullRow]);
  assert.deepEqual(Object.keys(saved), ['id', 'orgId', 'version', 'templateId', 'caseId', 'caseNo', 'caseName', 'date', 'status', 'answerContainerKind', 'hasUnknownAnswerKeys', 'answers']);
});


test('saved name and three date answers remain literal and independent of current case and fill date', () => {
  const saved = row({ caseName: '目前合成姓名', date: '0000-02-29' });
  const texts = { q001: ' 舊保存姓名\r\n ', q003: '2026-02-30', q008: 'not-a-date <script>合成</script>', q009: '2026-10-10T13:15:00+08:00' };
  for (const [key, value] of Object.entries(texts)) saved.answers[key] = { kind: 'string', value };
  confirm([saved], request({ date: '0000-02-29' }));
  for (const [key, value] of Object.entries(texts)) assert.equal(needsAssessmentAnswerText(saved.answers[key]), value);
  assert.notEqual(saved.caseName, needsAssessmentAnswerText(saved.answers.q001));
  invalid(() => confirm([saved], request({ date: '2026-10-10' })));
});

test('identity compares exact authorization primitives while nested same-value references remain equal', () => {
  const context = { user: { id: 'user:synthetic', employeeId: 'employee:synthetic' }, organizationId: 'org:synthetic', role: 'supervisor', organizations: [{ id: 'org:synthetic' }] };
  const initial = needsAssessmentIdentity(context);
  assert.equal(needsAssessmentIdentity(structuredClone(context)), initial);
  for (const key of ['id', 'employeeId']) { const changed = structuredClone(context); changed.user[key] += ':changed'; assert.notEqual(needsAssessmentIdentity(changed), initial); }
  for (const key of ['organizationId', 'role']) { const changed = structuredClone(context); changed[key] += ':changed'; assert.notEqual(needsAssessmentIdentity(changed), initial); }
  assert.notEqual(needsAssessmentIdentity({ user: { id: 'a:b' }, organizationId: 'c', role: 'supervisor' }), needsAssessmentIdentity({ user: { id: 'a' }, organizationId: 'b:c', role: 'supervisor' }));
  assert.notEqual(needsAssessmentIdentity({ user: { id: '' }, organizationId: 'org-synthetic' }), needsAssessmentIdentity({ user: {}, organizationId: 'org-synthetic' }));
  assert.equal(needsAssessmentIdentity({ user: { id: 'user-synthetic' }, orgId: 'org-synthetic' }), needsAssessmentIdentity({ user: { id: 'user-synthetic' }, organizationId: 'org-synthetic' }));
});

test('confirmation rejects non-enumerable and accessor data at every typed boundary without invoking getters', () => {
  let accesses = 0;
  for (const field of ['kind', 'value']) {
    const answer = { kind: 'string', value: 'visible' }; Object.defineProperty(answer, field, { enumerable: true, get() { accesses++; return 'hidden'; } });
    invalid(() => confirm([row({ answers: { ...row().answers, q005: answer } })]));
    assert.equal(needsAssessmentAnswerText(answer), '保存內容未確認');
  }
  const saved = row(); Object.defineProperty(saved, 'caseName', { enumerable: false, value: 'hidden' }); invalid(() => confirm([saved]));
  const requested = request(); Object.defineProperty(requested, 'q', { enumerable: true, get() { accesses++; return ''; } }); invalid(() => confirmNeedsAssessmentList(list([]), requested));
  const result = list([]); Object.defineProperty(result.filters, 'q', { enumerable: true, get() { accesses++; return ''; } }); invalid(() => confirmNeedsAssessmentList(result, request()));
  assert.equal(accesses, 0);
  const cyclic = { kind: 'object' }; cyclic.value = cyclic; invalid(() => confirm([row({ answers: { ...row().answers, q005: cyclic } })]));
  invalid(() => confirm([row({ answers: { ...row().answers, q005: { kind: 'number', value: Infinity } } })]));
});
