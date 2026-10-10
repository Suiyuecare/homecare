import test from 'node:test';
import assert from 'node:assert/strict';
import { createShiftEditor, formatShiftText, formatShiftDate, formatShiftTime, formatShiftStatus, formatShiftServices } from '../public/data/shift-editor.js';

const saved = ['caseId', 'employeeId', 'carePlanId', 'date', 'startTime', 'endTime', 'services', 'status', 'note'];
const controls = ['carePlanId', 'employeeId', 'date', 'startTime', 'endTime', 'services', 'note'];
const cases = [{ id: 'case-a', name: '合成個案甲', status: 'active' }, { id: 'case-b', name: '合成個案乙', status: 'active' }, { id: 'paused', name: '合成暫停', status: 'paused' }];
const employees = [{ id: 'employee-a', name: '合成人員甲', employeeNo: 'TEST-A', status: 'active' }, { id: 'employee-b', name: '合成人員乙', employeeNo: 'TEST-B', status: 'active' }, { id: 'inactive', name: '合成停用', status: 'inactive' }, { id: 'other-inactive', name: '其他停用', status: 'inactive' }];
const serviceItems = [{ id: 's1', code: 'S1', name: '合成服務1', status: 'active' }, { id: 's2', code: 'S2', name: '合成服務2', status: 'active' }, { id: 's3', code: 'S3', name: '合成服務3', status: 'active' }, { id: 'old', code: 'OLD', name: '合成停用服務', status: 'inactive', validTo: '2000-01-01' }, { id: 'outside', code: 'OUT', name: '計畫以外服務', status: 'active' }];
const plan = (id, caseId, services, status = 'active') => ({ id, caseId, services, status, validFrom: '2026-01-01', validTo: '2026-12-31' });
const carePlans = [plan('plan-a', 'case-a', [{ serviceItemId: 's1', quantity: 1 }, { serviceItemId: 's2', quantity: 2 }, { serviceItemId: 'old', quantity: 1 }]), plan('same-case', 'case-a', [{ serviceItemId: 's1', quantity: 1 }]), plan('plan-b', 'case-b', [{ serviceItemId: 's3', quantity: 1 }, { serviceItemId: 's1', quantity: 1 }]), plan('paused-plan', 'paused', [{ serviceItemId: 's1', quantity: 1 }]), plan('ended', 'paused', [{ serviceItemId: 's2', quantity: 1 }], 'ended')];
const row = extra => ({ id: 'shift-a', orgId: 'org-a', version: 4, caseId: 'case-a', employeeId: 'employee-a', carePlanId: 'plan-a', date: '2026-10-09', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: 's2', quantity: 7 }, { serviceItemId: 's1', quantity: 3 }], status: 'scheduled', note: ' 原交班\n尾行\n', ...extra });
const editor = (existing, extra = {}) => createShiftEditor({ existing, cases, employees, carePlans, serviceItems, defaultDate: '2026-10-09', ...extra });
const next = (original, payload = {}) => ({ ...original, ...payload, version: original.version + 1 });
const bad = (fn, field) => assert.throws(fn, error => !!error.fields && Object.hasOwn(error.fields, field));
const unconfirmed = fn => assert.throws(fn, error => error.code === 'SAVE_UNCONFIRMED');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

test('create keeps seven original controls and nine saved fields with safe first or fixed plan selection', () => {
  const e = editor();
  assert.deepEqual(e.fields.map(field => field.name), controls);
  assert.deepEqual(e.initial, { carePlanId: 'plan-a', employeeId: '', date: '2026-10-09', startTime: '09:00', endTime: '10:00', services: [], note: '' });
  assert.deepEqual(e.fields.find(field => field.name === 'carePlanId').options.map(option => option.value), ['plan-a', 'same-case', 'plan-b']);
  const p = e.buildPayload({ employeeId: 'employee-a', services: [{ serviceItemId: 's1', quantity: 10000 }] });
  assert.deepEqual(Object.keys(p).sort(), saved.slice().sort());
  assert.equal(p.caseId, 'case-a'); assert.equal(p.status, 'scheduled'); assert.equal(p.note, '');
  assert.equal(editor(undefined, { fixedPlanId: 'plan-b' }).initial.carePlanId, 'plan-b');
  assert.deepEqual(editor(undefined, { fixedPlanId: 'plan-b' }).fields[0].options.map(option => option.value), ['plan-b']);
  for (const fixedPlanId of ['paused-plan', 'ended', 'unknown', null, {}, []]) assert.equal(editor(undefined, { fixedPlanId }).initial.carePlanId, '');
  for (const defaultDate of ['0000-01-01', '2026-02-30', null]) assert.equal(editor(undefined, { defaultDate }).initial.date, '');
  bad(() => e.buildPayload({ employeeId: 'inactive', services: [{ serviceItemId: 's1', quantity: 1 }] }), 'employeeId');
  for (const name of ['caseId', 'status']) bad(() => e.buildPayload({ [name]: 'inject' }), name);
});

test('normal edit omits unchanged and changed-back values and keeps case and status outside controls', () => {
  const original = freeze(row()), e = editor(original);
  assert.deepEqual(e.fields.filter(field => !field.name.endsWith('Intent')).map(field => field.name), controls);
  assert(!Object.hasOwn(e.initial, 'caseId')); assert(!Object.hasOwn(e.initial, 'status'));
  assert.deepEqual(e.buildPayload({}), {}); assert.deepEqual(e.buildPayload(e.initial), {});
  assert.deepEqual(e.buildPayload({ carePlanId: original.carePlanId, employeeId: original.employeeId, note: original.note }), {});
  assert.deepEqual(e.buildPayload({ employeeId: 'employee-b', note: ' 新交班\n' }), { employeeId: 'employee-b', note: ' 新交班\n' });
  assert.deepEqual(e.initial.services, []); assert.equal(e.initial.servicesIntent, 'keep');
  const services = e.fields.find(field => field.name === 'services');
  assert.equal(services.disabled, true); assert.equal(services.preserveWhenDisabled, true); assert.equal(e.enabled('services'), false);
  assert.equal(e.enabled('services', { servicesIntent: 'replace' }), true);
  e.confirm(next(original), original.orgId, {});
  for (const name of ['caseId', 'status', 'version', 'id', 'orgId']) bad(() => e.buildPayload({ [name]: 'x' }), name);
});

test('only a different explicit plan derives captured caseId and same plan never repairs private or mismatched parents', () => {
  const e = editor(row());
  assert.deepEqual(e.buildPayload({ carePlanId: 'plan-b' }), { carePlanId: 'plan-b', caseId: 'case-b' });
  assert.deepEqual(e.buildPayload({ carePlanId: 'same-case' }), { carePlanId: 'same-case' });
  assert.deepEqual(e.buildPayload({ carePlanId: 'plan-a' }), {});
  for (const caseId of ['case-b', null, ['PRIVATE'], { hidden: 'PRIVATE' }]) {
    const original = row({ caseId }), x = editor(original);
    assert.deepEqual(x.buildPayload({ carePlanId: 'plan-a', note: '只改交班' }), { note: '只改交班' });
    x.confirm(next(original, { note: '只改交班' }), original.orgId, { note: '只改交班' });
    assert.deepEqual(x.buildPayload({ carePlanId: 'plan-b' }), caseId === 'case-b' ? { carePlanId: 'plan-b' } : { carePlanId: 'plan-b', caseId: 'case-b' });
  }
  const missing = row(); delete missing.caseId;
  assert.deepEqual(editor(missing).buildPayload({ note: '只改交班' }), { note: '只改交班' });
  assert.deepEqual(editor(missing).buildPayload({ carePlanId: 'same-case' }), { carePlanId: 'same-case', caseId: 'case-a' });
  const unknown = editor(row({ carePlanId: { hidden: 'PRIVATE' } }));
  assert.equal(unknown.initial.carePlanId, ''); assert.equal(unknown.initial.carePlanIdIntent, 'keep'); assert.deepEqual(unknown.serviceOptions(), []);
  assert.deepEqual(unknown.buildPayload({ carePlanId: 'plan-b' }), {});
  assert.deepEqual(unknown.buildPayload({ carePlanIdIntent: 'replace', carePlanId: 'plan-b' }), { carePlanId: 'plan-b', caseId: 'case-b' });
  bad(() => unknown.buildPayload({ carePlanIdIntent: 'clear' }), 'carePlanIdIntent');
});

test('plan and employee membership preserves readable current inactive entries without adding unrelated inactive choices', () => {
  const original = row({ carePlanId: 'ended', caseId: 'paused', employeeId: 'inactive' }), e = editor(original);
  assert.equal(e.initial.carePlanId, 'ended'); assert.equal(e.initial.employeeId, 'inactive');
  assert.deepEqual(e.fields.find(field => field.name === 'carePlanId').options.map(option => option.value), ['plan-a', 'same-case', 'plan-b', 'ended']);
  assert.deepEqual(e.fields.find(field => field.name === 'employeeId').options.map(option => option.value), ['employee-a', 'employee-b', 'inactive']);
  assert.deepEqual(e.buildPayload({}), {}); assert.deepEqual(e.buildPayload({ employeeId: 'employee-b' }), { employeeId: 'employee-b' });
  bad(() => e.buildPayload({ employeeId: 'other-inactive' }), 'employeeId');
  bad(() => e.buildPayload({ carePlanId: 'paused-plan' }), 'carePlanId');
  for (const name of ['carePlanId', 'employeeId']) for (const value of ['missing', null, [], { hidden: 'PRIVATE' }]) {
    const x = editor(row({ [name]: value })); assert(x.needsIntent(name)); assert.equal(x.initial[name], ''); assert.deepEqual(x.buildPayload({}), {});
    assert.equal(x.enabled(name, { [name + 'Intent']: 'replace' }), true); bad(() => x.buildPayload({ [name + 'Intent']: 'clear' }), name + 'Intent');
  }
});

test('whole service keep preserves every JSON representation, own absence, order and extra keys privately', () => {
  const special = JSON.parse('{"__proto__":{"secret":"PRIVATE"},"constructor":[0,false]}');
  for (const services of [null, 'PRIVATE', false, 0, [], special, [null], [{ serviceItemId: ['PRIVATE'], quantity: 1 }], [{ serviceItemId: 'missing', quantity: 1 }], [{ serviceItemId: 's1', quantity: 2, extra: special }], [{ serviceItemId: 's1', quantity: 2 }, { serviceItemId: 's1', quantity: 3 }]]) {
    const original = freeze(row({ services })), e = editor(original);
    assert.deepEqual(e.initial.services, []); assert.equal(e.initial.servicesIntent, 'keep'); assert.deepEqual(e.buildPayload(e.initial), {});
    assert(!JSON.stringify({ initial: e.initial, fields: e.fields }).includes('PRIVATE'));
    e.confirm(next(original), original.orgId, {}); assert.deepEqual(e.buildPayload({ carePlanId: 'plan-b' }), { carePlanId: 'plan-b', caseId: 'case-b' });
  }
  const original = row(); delete original.services; const e = editor(original);
  e.confirm(next(original), original.orgId, {}); unconfirmed(() => e.confirm(next(original, { services: [] }), original.orgId, {}));
  assert.equal({}.secret, undefined);
});

test('explicit service replacement is a complete canonical intersection with no quantity quota or item-status filter', () => {
  const original = row(), e = editor(original);
  assert.deepEqual(e.serviceOptions().map(option => option.value), ['s1', 's2', 'old']);
  assert.deepEqual(e.serviceOptions({ carePlanId: 'plan-b' }).map(option => option.value), ['s1', 's3']);
  assert.deepEqual(e.buildPayload({ servicesIntent: 'replace', services: structuredClone(original.services) }), {});
  const reversed = original.services.toReversed(); assert.deepEqual(e.buildPayload({ servicesIntent: 'replace', services: reversed }), { services: reversed });
  assert.deepEqual(e.buildPayload({ servicesIntent: 'replace', services: [{ serviceItemId: 'old', quantity: 10000 }] }), { services: [{ serviceItemId: 'old', quantity: 10000 }] });
  assert.deepEqual(e.buildPayload({ carePlanId: 'plan-b', servicesIntent: 'replace', services: [{ serviceItemId: 's3', quantity: 99 }] }), { carePlanId: 'plan-b', services: [{ serviceItemId: 's3', quantity: 99 }], caseId: 'case-b' });
  for (const services of [[], null, {}, [{ serviceItemId: 's1', quantity: 0 }], [{ serviceItemId: 's1', quantity: -1 }], [{ serviceItemId: 's1', quantity: 1.5 }], [{ serviceItemId: 's1', quantity: '2' }], [{ serviceItemId: 's1', quantity: 10001 }], [{ serviceItemId: 's1', quantity: NaN }], [{ serviceItemId: 's1', quantity: 1, extra: true }], [{ serviceItemId: 's1', quantity: 1 }, { serviceItemId: 's1', quantity: 2 }], [{ serviceItemId: 'outside', quantity: 1 }], [{ serviceItemId: ['s1'], quantity: 1 }]]) bad(() => e.buildPayload({ servicesIntent: 'replace', services }), 'services');
  bad(() => e.buildPayload({ carePlanId: 'plan-b', servicesIntent: 'replace', services: [{ serviceItemId: 's2', quantity: 1 }] }), 'services');
  bad(() => e.buildPayload({ servicesIntent: 'clear' }), 'servicesIntent');
  const many = Array.from({ length: 101 }, (_, index) => ({ id: 'many-' + index, name: '合成服務' + index }));
  const fullPlan = plan('full', 'case-a', many.map(item => ({ serviceItemId: item.id, quantity: 1 })));
  const x = editor(undefined, { carePlans: [fullPlan], serviceItems: many }), values = { employeeId: 'employee-a', services: many.slice(0, 100).map(item => ({ serviceItemId: item.id, quantity: 1 })) };
  assert.equal(x.buildPayload(values).services.length, 100); bad(() => x.buildPayload({ ...values, services: many.map(item => ({ serviceItemId: item.id, quantity: 1 })) }), 'services');
});

test('dynamic plan membership and captured derivation cannot be expanded by caller, descriptors or returned options', () => {
  const plans = structuredClone(carePlans), people = structuredClone(employees), items = structuredClone(serviceItems), caseList = structuredClone(cases);
  const e = editor(row(), { carePlans: plans, employees: people, serviceItems: items, cases: caseList });
  plans[2].caseId = 'injected-case'; plans[2].services.push({ serviceItemId: 'outside', quantity: 1 }); people.push({ id: 'injected', status: 'active' }); items.push({ id: 'injected-service' }); caseList[1].id = 'injected-case';
  e.fields.find(field => field.name === 'carePlanId').options.push({ value: 'injected', label: 'x' }); e.fields.find(field => field.name === 'employeeId').options.push({ value: 'injected', label: 'x' });
  e.fields.find(field => field.name === 'services').options.push({ value: 'outside', label: 'x' }); e.serviceOptions({ carePlanId: 'plan-b' }).push({ value: 'outside', label: 'x' });
  assert.deepEqual(e.buildPayload({ carePlanId: 'plan-b' }), { carePlanId: 'plan-b', caseId: 'case-b' });
  bad(() => e.buildPayload({ carePlanId: 'injected' }), 'carePlanId'); bad(() => e.buildPayload({ employeeId: 'injected' }), 'employeeId');
  bad(() => e.buildPayload({ carePlanId: 'plan-b', servicesIntent: 'replace', services: [{ serviceItemId: 'outside', quantity: 1 }] }), 'services');
  const unknown = editor(row({ carePlanId: 'missing' })); assert.deepEqual(unknown.serviceOptions({ carePlanId: 'plan-b' }), []); assert.deepEqual(unknown.serviceOptions({ carePlanIdIntent: 'replace', carePlanId: 'plan-b' }).map(option => option.value), ['s1', 's3']);
  assert.deepEqual(e.serviceOptions(null), []); assert.deepEqual(e.serviceOptions({ carePlanId: {} }), []);
});

test('native dates and minute times keep original ISO and year0000 private without string time ordering or redating', () => {
  const original = row({ date: '0000-02-29', startTime: '0000-02-29T09:30:51+08:00', endTime: '0000-02-29T10:15:20+08:00' }), e = editor(original);
  for (const name of ['date', 'startTime', 'endTime']) { assert(e.needsIntent(name)); assert.equal(e.initial[name], ''); assert.equal(e.initial[name + 'Intent'], 'keep'); assert.equal(e.enabled(name), false); }
  assert(!JSON.stringify({ fields: e.fields, initial: e.initial }).includes('0000-02-29T'));
  assert.deepEqual(e.buildPayload({ note: '只改交班' }), { note: '只改交班' }); e.confirm(next(original, { note: '只改交班' }), original.orgId, { note: '只改交班' });
  assert.deepEqual(e.buildPayload({ dateIntent: 'replace', date: '2026-10-10' }), { date: '2026-10-10' });
  assert.deepEqual(e.buildPayload({ startTimeIntent: 'replace', startTime: '09:30', endTimeIntent: 'replace', endTime: '10:15' }), { startTime: '09:30', endTime: '10:15' });
  assert.deepEqual(editor(row()).buildPayload({ startTime: '11:00', endTime: '09:00' }), { startTime: '11:00', endTime: '09:00' }, 'cross-field interval remains the original API rule');
  for (const date of ['0001-01-01', '2000-02-29', '2024-02-29', '9999-12-31']) assert.deepEqual(editor(row()).buildPayload({ date }), { date });
  for (const date of ['', '0000-01-01', '1900-02-29', '2026-02-30', '2026-13-01', '10000-01-01', '2026-10-09\n', null, []]) bad(() => editor(row()).buildPayload({ date }), 'date');
  for (const name of ['startTime', 'endTime']) for (const value of ['', '9:00', '24:00', '09:60', '09:00:00', '09:00\n', ' 09:00', '2026-10-09T09:00:00Z', 900, null, {}, []]) bad(() => editor(row()).buildPayload({ [name]: value }), name);
});

test('missing and typed saved JSON preserves all own fields and accepts only note clear without leaking values', () => {
  const originals = [{ id: 'shift-a', orgId: 'org-a', version: 1 }, row(Object.fromEntries(saved.map(name => [name, null]))), row({ caseId: ['PRIVATE'], employeeId: { hidden: 'PRIVATE' }, carePlanId: 2, date: false, startTime: {}, endTime: 42, services: ['PRIVATE'], status: { hidden: 'PRIVATE' }, note: ['PRIVATE'] })];
  for (const original of originals) {
    const e = editor(freeze(original)); assert.deepEqual(e.buildPayload(e.initial), {}); e.confirm(next(original), original.orgId, {});
    for (const name of controls) { assert(e.needsIntent(name)); assert.equal(e.enabled(name), false); assert.equal(e.initial[name + 'Intent'], 'keep'); }
    assert(!JSON.stringify({ fields: e.fields, initial: e.initial }).includes('PRIVATE'));
    assert.deepEqual(e.buildPayload({ noteIntent: 'clear', note: { ignored: true } }), { note: '' });
    for (const name of controls.filter(name => name !== 'note')) bad(() => e.buildPayload({ [name + 'Intent']: 'clear' }), name + 'Intent');
    assert.deepEqual(e.buildPayload({ employeeId: 'injected', date: NaN, startTime: {}, services: null, note: false }), {});
    for (const name of saved) { const response = next(original); if (Object.hasOwn(original, name)) delete response[name]; else response[name] = ''; unconfirmed(() => e.confirm(response, original.orgId, {})); }
  }
});

test('note preserves LF whitespace, keeps CR and typed values private and validates only explicit new UTF16 limits', () => {
  const original = row({ note: 'PRIVATE\r\n原交班' }), e = editor(original);
  assert(e.needsIntent('note')); assert.equal(e.initial.note, ''); assert.deepEqual(e.buildPayload({}), {});
  assert.deepEqual(e.buildPayload({ noteIntent: 'replace', note: ' 原交班\n\n尾行\n ' }), { note: ' 原交班\n\n尾行\n ' });
  assert.deepEqual(e.buildPayload({ noteIntent: 'clear' }), { note: '' });
  for (const note of ['a\rb', 'a\r\nb', null, []]) bad(() => e.buildPayload({ noteIntent: 'replace', note }), 'note');
  const boundary = '🙂'.repeat(5000); assert.deepEqual(editor(row()).buildPayload({ note: boundary }), { note: boundary }); bad(() => editor(row()).buildPayload({ note: boundary + 'x' }), 'note');
  const long = row({ note: boundary + 'x' }), kept = editor(long); assert.equal(kept.needsIntent('note'), false); assert.deepEqual(kept.buildPayload(kept.initial), {}); kept.confirm(next(long), long.orgId, {});
  assert.deepEqual(editor(row()).buildPayload({ note: '' }), { note: '' });
});

test('captured private JSON and identity are immutable and unsafe arrays, prototypes and unsupported values are refused', () => {
  const special = JSON.parse('{"__proto__":{"secret":"PRIVATE"},"constructor":[0,false],"prototype":null}');
  const original = row({ caseId: special, note: { nested: special } }), captured = structuredClone(original), e = editor(original);
  original.id = 'changed'; original.orgId = 'other'; original.version = 99; original.note.nested.constructor[0] = 9; original.services[0].quantity = 99;
  e.initial.carePlanId = 'plan-b'; e.initial.servicesIntent = 'replace'; e.initial.services.push({ serviceItemId: 'outside', quantity: 1 });
  assert.deepEqual(e.buildPayload({}), {}); e.confirm(next(captured), captured.orgId, {}); assert.equal({}.secret, undefined);
  for (const name of ['caseId', 'status', 'id', 'orgId', 'version', 'billingSnapshot', 'unknown', 'constructor']) bad(() => e.buildPayload({ [name]: 'x' }), name);
  bad(() => e.buildPayload(JSON.parse('{"__proto__":{}}')), '__proto__'); bad(() => e.buildPayload({ servicesIntent: 'delete' }), 'servicesIntent');
  for (const value of [undefined, NaN, Infinity, () => {}]) assert.throws(() => editor(row({ note: value })));
  const cyclic = {}; cyclic.self = cyclic; assert.throws(() => editor(row({ note: cyclic })));
  const sparse = Array(1), extra = [{ serviceItemId: 's1', quantity: 1 }]; extra.extra = 'PRIVATE'; const odd = []; odd['01'] = { serviceItemId: 's1', quantity: 1 };
  for (const services of [sparse, extra, odd]) { assert.throws(() => editor(row({ services }))); bad(() => editor(row()).buildPayload({ servicesIntent: 'replace', services }), 'services'); }
  const inherited = Object.create({ quantity: 1 }); inherited.serviceItemId = 's1'; bad(() => editor(row()).buildPayload({ servicesIntent: 'replace', services: [inherited] }), 'services');
});

test('create acknowledgement needs nine exact own fields and plain identity with version one', () => {
  const e = editor(), p = e.buildPayload({ employeeId: 'employee-a', services: [{ serviceItemId: 's1', quantity: 1 }] }), good = { ...p, id: 'new-shift', orgId: 'org-a', version: 1 };
  e.confirm(good, 'org-a', p);
  for (const name of ['id', 'orgId', 'version', ...saved]) { const response = { ...good }; delete response[name]; unconfirmed(() => e.confirm(response, 'org-a', p)); }
  for (const name of saved) unconfirmed(() => e.confirm({ ...good, [name]: { wrong: true } }, 'org-a', p));
  for (const response of [null, [], {}, Object.create(good), { ...good, id: '' }, { ...good, orgId: 'other' }, { ...good, version: 2 }, { ...good, version: '1' }, { ...good, version: NaN }]) unconfirmed(() => e.confirm(response, 'org-a', p));
  unconfirmed(() => e.confirm(good, 'org-a', { ...p, unknown: true })); unconfirmed(() => e.confirm(good, '', p));
});

test('edit and cancellation acknowledgement checks all nine private fields and exact safe next version without lookup dependencies', () => {
  const original = row({ services: [{ serviceItemId: 's1', quantity: 2, extra: { keep: true } }, { serviceItemId: 's1', quantity: 3 }], note: null }), e = editor(original, { cases: [], employees: [], carePlans: [], serviceItems: [] }), p = { status: 'cancelled' }, good = next(original, p);
  e.confirm(good, original.orgId, p); e.confirm(good, original.orgId, { ...p, version: 4 });
  for (const name of saved) { const response = { ...good }; delete response[name]; unconfirmed(() => e.confirm(response, original.orgId, p)); unconfirmed(() => e.confirm({ ...good, [name]: { wrong: true } }, original.orgId, p)); }
  unconfirmed(() => e.confirm({ ...good, services: original.services.toReversed() }, original.orgId, p));
  for (const change of [{ id: 'other' }, { orgId: 'other' }, { version: 4 }, { version: 6 }, { version: '5' }, { note: '' }]) unconfirmed(() => e.confirm({ ...good, ...change }, original.orgId, p));
  for (const version of [0, 1.5, '4', Number.MAX_SAFE_INTEGER]) unconfirmed(() => editor(row({ version })).confirm(good, original.orgId, p));
  const missing = row(); delete missing.note; const x = editor(missing); x.confirm(next(missing, p), missing.orgId, p); unconfirmed(() => x.confirm(next(missing, { ...p, note: '' }), missing.orgId, p));
});

test('single-shift projections and option labels never coerce typed lookups and retain valid original ISO text', () => {
  const hostile = { toString() { throw Error('must not coerce'); } };
  for (const value of [null, false, 1, [], ['PRIVATE'], hostile]) { assert.equal(formatShiftText(value), '未取得'); assert.equal(formatShiftDate(value), '日期未取得'); assert.equal(formatShiftTime(value), '時間未取得'); assert.equal(formatShiftStatus(value), '狀態未取得'); }
  for (const value of ['constructor', '__proto__', 'unknown']) assert.equal(formatShiftStatus(value), '狀態未取得');
  assert.equal(formatShiftStatus('cancelled'), '已取消'); assert.equal(formatShiftText('原文\n尾行'), '原文\n尾行'); assert.equal(formatShiftDate('0000-02-29'), '0000/02/29'); assert.equal(formatShiftDate('1900-02-29'), '日期未取得');
  assert.equal(formatShiftTime('2026-10-09T09:30:51+08:00'), '2026-10-09T09:30:51+08:00'); assert.equal(formatShiftTime('09:30'), '09:30'); assert.equal(formatShiftTime('24:00'), '時間未取得');
  const map = new Map([['good', { code: 'S', name: '目前名稱' }], ['typed', { code: hostile, name: ['PRIVATE'] }]]);
  assert.equal(formatShiftServices([{ serviceItemId: 'good', quantity: 7 }], map), 'S 目前名稱 × 7'); assert.equal(formatShiftServices([null], map), '服務明細未取得'); assert.equal(formatShiftServices({ hidden: 'PRIVATE' }, map), '服務明細未取得'); assert.equal(formatShiftServices([], map), '尚未設定');
  for (const quantity of ['7', null, 0, 10001, hostile]) assert.equal(formatShiftServices([{ serviceItemId: 'typed', quantity }], map), '服務項目名稱未取得 × 數量未取得');
  const e = editor(row(), { cases: [...cases, { id: 'safe-case', status: 'active', name: ['PRIVATE'] }], employees: [...employees, { id: 'safe-person', status: 'active', name: hostile, employeeNo: ['PRIVATE'] }, { id: ['PRIVATE'], status: 'active', name: 'x' }], carePlans: [...carePlans, { ...plan('safe-plan', 'safe-case', [{ serviceItemId: 'safe-service', quantity: 1 }]), validFrom: hostile, validTo: ['PRIVATE'] }], serviceItems: [...serviceItems, { id: 'safe-service', code: hostile, name: ['PRIVATE'] }, { id: ['PRIVATE'], name: 'x' }] });
  assert(!JSON.stringify(e.fields).includes('PRIVATE')); assert.equal(e.serviceOptions({ carePlanId: 'safe-plan' })[0].value, 'safe-service');
});
