import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceRecordEditor, createServiceRecordReview } from '../public/data/service-record-editor.js';

const saved = ['shiftId', 'caseId', 'employeeId', 'date', 'actualStart', 'actualEnd', 'services', 'status', 'note', 'reviewNote'];
const controls = ['actualStart', 'actualEnd', 'services', 'note', 'status'];
const createKeys = saved.filter(name => name !== 'reviewNote');
const serviceItems = [
  { id: 's1', code: 'S1', name: '合成服務甲', status: 'active' },
  { id: 's2', code: 'S2', name: '合成服務乙', status: 'active' },
  { id: 'old', code: 'OLD', name: '合成停用服務', status: 'inactive', validTo: '2000-01-01' },
  { id: 'outside', code: 'OUT', name: '班次以外服務', status: 'active' },
];
const shift = {
  id: 'shift-a', orgId: 'org-a', version: 9, caseId: 'case-a', employeeId: 'employee-a', date: '2026-10-09',
  startTime: '09:00', endTime: '10:00', status: 'scheduled',
  services: [{ serviceItemId: 's1', quantity: 1 }, { serviceItemId: 's2', quantity: 2 }, { serviceItemId: 'old', quantity: 1 }],
};
const row = extra => ({
  id: 'record-a', orgId: 'org-a', version: 4, shiftId: shift.id, caseId: shift.caseId, employeeId: shift.employeeId, date: shift.date,
  actualStart: '09:05', actualEnd: '09:50', services: [{ serviceItemId: 's2', quantity: 7 }, { serviceItemId: 's1', quantity: 3 }],
  status: 'draft', note: ' 原觀察\n尾行\n', reviewNote: ' 原退回說明\n', ...extra,
});
const editor = (existing, extra = {}) => createServiceRecordEditor({ existing, shift, serviceItems, ...extra });
const review = existing => createServiceRecordReview({ existing });
const next = (original, payload = {}) => ({ ...original, ...payload, version: original.version + 1 });
const createValues = extra => ({ actualStart: '08:00', actualEnd: '11:30', services: [{ serviceItemId: 's1', quantity: 10000 }], note: ' 原新紀錄\n ', status: 'draft', ...extra });
const bad = (fn, field) => assert.throws(fn, error => !!error.fields && (!field || Object.hasOwn(error.fields, field)));
const unconfirmed = fn => assert.throws(fn, error => error.code === 'SAVE_UNCONFIRMED');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const privateJson = () => JSON.parse('{"__proto__":{"secret":"NEVER_RENDER"},"constructor":[0,false],"prototype":null}');

test('create adds explicit-date and planned-span controls with unchanged legacy nine-field payload', () => {
  const source = structuredClone(shift), e = editor(undefined, { shift: source });
  assert.deepEqual(e.fields.map(field => field.name), ['spanMode', 'plannedSpan', ...controls.slice(0, 2), 'actualEndDate', ...controls.slice(2)]);
  assert.deepEqual(e.initial, { actualStart: '', actualEnd: '', services: [], note: '', status: 'draft', spanMode: 'legacy', actualEndDate: '', plannedSpan: '2026-10-09 09:00 至 10:00（舊同日格式）' });
  assert.deepEqual(e.fields.find(field => field.name === 'status').options.map(option => option.value), ['draft', 'submitted']);
  source.id = 'changed'; source.caseId = 'changed'; source.employeeId = 'changed'; source.date = '2027-01-01';
  const payload = e.buildPayload(createValues());
  assert.deepEqual(Object.keys(payload).sort(), createKeys.slice().sort());
  assert.deepEqual(Object.fromEntries(['shiftId', 'caseId', 'employeeId', 'date'].map(name => [name, payload[name]])),
    { shiftId: shift.id, caseId: shift.caseId, employeeId: shift.employeeId, date: shift.date });
  assert.equal(payload.actualStart, '08:00'); assert.equal(payload.actualEnd, '11:30');
  assert.equal(payload.services[0].quantity, 10000); assert.equal(payload.note, ' 原新紀錄\n ');
  assert(!Object.hasOwn(payload, 'reviewNote'));
  for (const name of ['shiftId', 'caseId', 'employeeId', 'date', 'reviewNote', 'id', 'orgId', 'version', 'billingSnapshot'])
    bad(() => e.buildPayload({ ...createValues(), [name]: 'injected' }), name);
  for (const name of ['id', 'caseId', 'employeeId', 'date']) {
    const missing = structuredClone(shift); delete missing[name];
    assert.throws(() => editor(undefined, { shift: missing }).buildPayload(createValues()));
  }
  const zero = editor(undefined, { shift: { ...shift, date: '0000-02-29' } });
  assert.equal(zero.buildPayload(createValues()).date, '0000-02-29');
});

test('normal edits and reversions omit unchanged values and preserve captured parent date and review fields', () => {
  const original = freeze(row()), e = editor(original);
  assert.deepEqual(e.fields.filter(field => !field.name.endsWith('Intent')).map(field => field.name), ['spanMode', 'plannedSpan', ...controls.slice(0, 2), 'actualEndDate', ...controls.slice(2)]);
  assert.deepEqual(e.buildPayload({}), {}); assert.deepEqual(e.buildPayload(e.initial), {});
  assert.deepEqual(e.buildPayload({ actualStart: original.actualStart, actualEnd: original.actualEnd, note: original.note, status: original.status }), {});
  assert.deepEqual(e.buildPayload({ note: ' 新觀察\n' }), { note: ' 新觀察\n' });
  assert.deepEqual(e.buildPayload({ actualEnd: '09:52' }), { actualEnd: '09:52' });
  e.confirm(next(original), original.orgId, {});
  for (const name of ['shiftId', 'caseId', 'employeeId', 'date', 'reviewNote', 'id', 'orgId', 'version', 'billingSnapshot', 'unknown', 'constructor'])
    bad(() => e.buildPayload({ [name]: 'injected' }), name);
  for (const name of ['shiftId', 'caseId', 'employeeId', 'date', 'reviewNote']) assert(!Object.hasOwn(e.initial, name));
});

test('returned stays returned until an explicit draft or submitted choice and never exposes approval choices', () => {
  const original = row({ status: 'returned' }), e = editor(original);
  assert.equal(e.initial.status, 'returned');
  assert.deepEqual(e.fields.find(field => field.name === 'status').options.map(option => option.value), ['draft', 'submitted', 'returned']);
  assert.deepEqual(e.buildPayload(e.initial), {}); assert.deepEqual(e.buildPayload({ status: 'returned', note: '僅補記' }), { note: '僅補記' });
  for (const status of ['draft', 'submitted']) {
    const payload = e.buildPayload({ status }); assert.deepEqual(payload, { status }); e.confirm(next(original, payload), original.orgId, payload);
  }
  for (const status of ['approved', 'constructor', '__proto__', '', null, false, [], {}]) bad(() => e.buildPayload({ status }), 'status');
  bad(() => editor(row()).buildPayload({ status: 'returned' }), 'status');
  for (const status of ['returned', 'approved']) bad(() => editor().buildPayload(createValues({ status })), 'status');
});

test('every saved services representation is private and whole under keep including own absence and unknown lookups', () => {
  const values = [null, false, 0, 'NEVER_RENDER', [], privateJson(), [null],
    [{ serviceItemId: ['NEVER_RENDER'], quantity: 1 }], [{ serviceItemId: 'missing', quantity: 9 }],
    [{ serviceItemId: 's1', quantity: 2, extra: privateJson() }],
    [{ serviceItemId: 's1', quantity: 2 }, { serviceItemId: 's1', quantity: 3 }]];
  for (const services of values) {
    const original = freeze(row({ services })), e = editor(original, { serviceItems: [] });
    assert.equal(e.initial.servicesIntent, 'keep'); assert.deepEqual(e.initial.services, []);
    assert(e.needsIntent('services')); assert.equal(e.enabled('services'), false); assert.equal(e.enabled('services', { servicesIntent: 'replace' }), true);
    const field = e.fields.find(field => field.name === 'services'); assert.equal(field.disabled, true); assert.equal(field.preserveWhenDisabled, true);
    assert(!JSON.stringify({ initial: e.initial, fields: e.fields }).includes('NEVER_RENDER'));
    assert.deepEqual(e.buildPayload(e.initial), {}); assert.deepEqual(e.buildPayload({ services: [{ serviceItemId: 'outside', quantity: 1 }] }), {});
    e.confirm(next(original, { note: '只改觀察' }), original.orgId, { note: '只改觀察' });
  }
  const missing = row(); delete missing.services; const e = editor(missing);
  assert.deepEqual(e.buildPayload({}), {}); e.confirm(next(missing), missing.orgId, {});
  unconfirmed(() => e.confirm(next(missing, { services: [] }), missing.orgId, {}));
});

test('explicit services replacement is canonical whole JSON with exact order and positive safe integers without quota', () => {
  const original = row(), e = editor(original);
  assert.deepEqual(e.buildPayload({ servicesIntent: 'replace', services: structuredClone(original.services) }), {});
  const reversed = original.services.toReversed(); assert.deepEqual(e.buildPayload({ servicesIntent: 'replace', services: reversed }), { services: reversed });
  assert.deepEqual(e.buildPayload({ servicesIntent: 'replace', services: [{ serviceItemId: 's1', quantity: 10000 }] }), { services: [{ serviceItemId: 's1', quantity: 10000 }] });
  assert.deepEqual(e.buildPayload({ servicesIntent: 'replace', services: [{ serviceItemId: 'old', quantity: 7 }] }), { services: [{ serviceItemId: 'old', quantity: 7 }] });
  for (const services of [[], null, {}, [null], [{ serviceItemId: 's1', quantity: 0 }], [{ serviceItemId: 's1', quantity: -1 }],
    [{ serviceItemId: 's1', quantity: 1.5 }], [{ serviceItemId: 's1', quantity: '2' }], [{ serviceItemId: 's1', quantity: 10001 }],
    [{ serviceItemId: 's1', quantity: NaN }], [{ serviceItemId: 's1', quantity: 1, extra: true }],
    [{ serviceItemId: 's1', quantity: 1 }, { serviceItemId: 's1', quantity: 2 }],
    [{ serviceItemId: 'outside', quantity: 1 }], [{ serviceItemId: 'missing', quantity: 1 }], [{ serviceItemId: ['s1'], quantity: 1 }]])
    bad(() => e.buildPayload({ servicesIntent: 'replace', services }), 'services');
  bad(() => e.buildPayload({ servicesIntent: 'clear' }), 'servicesIntent');
  const many = Array.from({ length: 101 }, (_, index) => ({ id: 'many-' + index, code: 'M' + index, name: '合成' + index }));
  const large = editor(undefined, { serviceItems: many, shift: { ...shift, services: many.map(item => ({ serviceItemId: item.id, quantity: 1 })) } });
  const values = createValues({ services: many.slice(0, 100).map(item => ({ serviceItemId: item.id, quantity: 1 })) });
  assert.equal(large.buildPayload(values).services.length, 100);
  bad(() => large.buildPayload({ ...values, services: many.map(item => ({ serviceItemId: item.id, quantity: 1 })) }), 'services');
});

test('captured service membership and safe option labels cannot be expanded by mutable callers or descriptors', () => {
  const sourceShift = structuredClone(shift), sourceItems = structuredClone(serviceItems), e = editor(row(), { shift: sourceShift, serviceItems: sourceItems });
  const options = e.fields.find(field => field.name === 'services').options;
  assert.deepEqual(options.map(option => option.value), ['s1', 's2', 'old']);
  sourceShift.services.push({ serviceItemId: 'outside', quantity: 1 }); sourceItems.push({ id: 'forged', name: '合成' });
  options.push({ value: 'forged', label: '合成' });
  for (const serviceItemId of ['outside', 'forged']) bad(() => e.buildPayload({ servicesIntent: 'replace', services: [{ serviceItemId, quantity: 1 }] }), 'services');
  const hostile = { toString() { throw Error('must not coerce'); } };
  const safe = editor(row(), { serviceItems: [...serviceItems, { id: ['NEVER_RENDER'], code: 'X', name: 'X' },
    { id: 'safe', code: hostile, name: ['NEVER_RENDER'] }], shift: { ...shift, services: [...shift.services, { serviceItemId: 'safe', quantity: 1 }] } });
  assert(!JSON.stringify(safe.fields).includes('NEVER_RENDER'));
  assert(safe.fields.find(field => field.name === 'services').options.some(option => option.value === 'safe'));
  const empty = editor(row(), { serviceItems: [] }); assert.deepEqual(empty.buildPayload({ note: '無主檔仍保持' }), { note: '無主檔仍保持' });
  bad(() => empty.buildPayload({ servicesIntent: 'replace', services: [{ serviceItemId: 's1', quantity: 1 }] }), 'services');
});

test('saved ISO times and year zero metadata keep exact seconds offsets and dates outside native inputs', () => {
  const original = row({ date: '0000-02-29', actualStart: '0000-02-29T09:05:51+08:00', actualEnd: '0000-02-29T09:50:20-04:00' }), e = editor(original);
  for (const name of ['actualStart', 'actualEnd']) {
    assert(e.needsIntent(name)); assert.equal(e.initial[name], ''); assert.equal(e.initial[name + 'Intent'], 'keep'); assert.equal(e.enabled(name), false);
  }
  assert(!JSON.stringify({ initial: e.initial, fields: e.fields }).includes('0000-02-29T'));
  const payload = e.buildPayload({ note: '只改觀察' }); assert.deepEqual(payload, { note: '只改觀察' }); e.confirm(next(original, payload), original.orgId, payload);
  assert.deepEqual(e.buildPayload({ actualStartIntent: 'replace', actualStart: '09:06', actualEndIntent: 'replace', actualEnd: '09:52' }),
    { actualStart: '09:06', actualEnd: '09:52' });
  for (const name of ['actualStart', 'actualEnd']) {
    for (const value of ['', '9:00', '24:00', '09:60', '09:00:00', '09:00\n', ' 09:00', '2026-10-09T09:00:00Z', 900, null, {}, []])
      bad(() => editor(row()).buildPayload({ [name]: value }), name);
    bad(() => e.buildPayload({ [name + 'Intent']: 'clear' }), name + 'Intent');
  }
  assert.deepEqual(editor(row()).buildPayload({ actualStart: '00:00', actualEnd: '23:59' }), { actualStart: '00:00', actualEnd: '23:59' });
});

test('missing null typed and CR control values remain private until explicit replacement and only note supports clear', () => {
  for (const name of ['actualStart', 'actualEnd', 'note']) {
    for (const value of [null, false, 0, [], privateJson(), 'NEVER_RENDER\r\n原文']) {
      const original = row({ [name]: value }), e = editor(original);
      assert(e.needsIntent(name)); assert.equal(e.initial[name], ''); assert.equal(e.initial[name + 'Intent'], 'keep'); assert.equal(e.enabled(name), false);
      assert(!JSON.stringify({ initial: e.initial, fields: e.fields }).includes('NEVER_RENDER'));
      assert.deepEqual(e.buildPayload({}), {}); e.confirm(next(original), original.orgId, {});
      const replacement = name === 'note' ? ' 原文\n末行 ' : '09:20';
      assert.deepEqual(e.buildPayload({ [name + 'Intent']: 'replace', [name]: replacement }), { [name]: replacement });
      if (name === 'note') assert.deepEqual(e.buildPayload({ noteIntent: 'clear', note: { ignored: true } }), { note: '' });
      else bad(() => e.buildPayload({ [name + 'Intent']: 'clear' }), name + 'Intent');
    }
    const missing = row(); delete missing[name]; const e = editor(missing);
    assert(e.needsIntent(name)); assert.deepEqual(e.buildPayload({}), {}); e.confirm(next(missing), missing.orgId, {});
    unconfirmed(() => e.confirm(next(missing, { [name]: null }), missing.orgId, {}));
  }
});

test('note text remains untrimmed and LF exact while explicit replacements enforce UTF16 limits without truncating originals', () => {
  const e = editor(row()), note = '  \n首行🙂\n末行\n  ';
  assert.deepEqual(e.buildPayload({ note }), { note }); assert.deepEqual(e.buildPayload({ note: '' }), { note: '' });
  for (const value of ['a\rb', 'a\r\nb', null, false, [], {}]) bad(() => e.buildPayload({ note: value }), 'note');
  const boundary = '🙂'.repeat(5000); assert.deepEqual(e.buildPayload({ note: boundary }), { note: boundary });
  bad(() => e.buildPayload({ note: boundary + 'x' }), 'note');
  const overlong = row({ note: boundary + 'x' }), original = editor(overlong);
  assert.deepEqual(original.buildPayload({}), {}); assert.deepEqual(original.buildPayload(original.initial), {}); original.confirm(next(overlong), overlong.orgId, {});
});

test('baseline identities and all saved JSON are isolated from caller mutation and prototype keys never alter prototypes', () => {
  const original = row({ shiftId: privateJson(), reviewNote: { nested: privateJson() }, services: [{ serviceItemId: 's1', quantity: 2, extra: privateJson() }] });
  const captured = structuredClone(original), e = editor(original);
  original.id = 'changed'; original.orgId = 'other'; original.version = 99;
  original.reviewNote.nested.constructor[0] = 9; original.services[0].quantity = 99; original.shiftId.__proto__.secret = 'changed';
  e.initial.note = 'mutated'; e.initial.servicesIntent = 'replace'; e.initial.services.push({ serviceItemId: 'outside', quantity: 1 });
  assert.deepEqual(e.buildPayload({}), {}); e.confirm(next(captured), captured.orgId, {});
  assert(!JSON.stringify(e.fields).includes('NEVER_RENDER')); assert.equal({}.secret, undefined);
  bad(() => e.buildPayload(JSON.parse('{"__proto__":{}}')), '__proto__');
  const nullObject = Object.create(null); nullObject['__proto__'] = privateJson(); nullObject.constructor = [null, false];
  const nullOriginal = row({ reviewNote: nullObject }); editor(nullOriginal).confirm(next(nullOriginal), nullOriginal.orgId, {});
  const values = Object.create(null); values.note = '明確 null-prototype 輸入'; assert.deepEqual(editor(row()).buildPayload(values), { note: values.note });
});

test('unsupported saved JSON inherited objects cycles and lossy arrays are refused before exposure or replacement', () => {
  for (const value of [undefined, NaN, Infinity, () => {}, new Date(), Object.create({ inherited: 'NEVER_RENDER' })])
    assert.throws(() => editor(row({ reviewNote: value })));
  const cycle = {}; cycle.self = cycle; assert.throws(() => editor(row({ note: cycle })));
  const sparse = Array(1), property = [{ serviceItemId: 's1', quantity: 1 }], noncanonical = [];
  property.extra = 'NEVER_RENDER'; noncanonical['01'] = { serviceItemId: 's1', quantity: 1 };
  for (const services of [sparse, property, noncanonical]) {
    assert.throws(() => editor(row({ services }))); bad(() => editor(row()).buildPayload({ servicesIntent: 'replace', services }), 'services');
  }
  const inherited = Object.create({ quantity: 1 }); inherited.serviceItemId = 's1';
  bad(() => editor(row()).buildPayload({ servicesIntent: 'replace', services: [inherited] }), 'services');
  assert.throws(() => editor(Object.create(row())));
});

test('create acknowledgements require every exact own saved field plus safe identity org and version one', () => {
  const e = editor(), payload = e.buildPayload(createValues()), good = { ...payload, id: 'new-record', orgId: 'org-a', version: 1 };
  e.confirm(good, 'org-a', payload);
  for (const name of ['id', 'orgId', 'version', ...createKeys]) {
    const missing = { ...good }; delete missing[name]; unconfirmed(() => e.confirm(missing, 'org-a', payload));
  }
  for (const name of createKeys) unconfirmed(() => e.confirm({ ...good, [name]: { wrong: true } }, 'org-a', payload));
  for (const response of [null, [], {}, Object.create(good), { ...good, id: '' }, { ...good, orgId: 'other' },
    { ...good, version: 2 }, { ...good, version: '1' }, { ...good, version: NaN }]) unconfirmed(() => e.confirm(response, 'org-a', payload));
  unconfirmed(() => e.confirm(good, '', payload));
  unconfirmed(() => e.confirm({ ...good, reviewNote: '' }, 'org-a', payload));
  unconfirmed(() => e.confirm({ ...good, services: [{ ...payload.services[0], quantity: 9999 }] }, 'org-a', payload));
});

test('edit acknowledgements check all ten own fields exact JSON order and captured safe next version without lookups', () => {
  const original = row({ shiftId: privateJson(), note: null, reviewNote: privateJson(), services: [{ serviceItemId: 's1', quantity: 2, extra: privateJson() }, { serviceItemId: 's1', quantity: 3 }] });
  const e = editor(original, { shift: undefined, serviceItems: [] }), payload = { status: 'submitted' }, good = next(original, payload);
  e.confirm(good, original.orgId, payload);
  for (const name of saved) {
    const missing = { ...good }; delete missing[name]; unconfirmed(() => e.confirm(missing, original.orgId, payload));
    unconfirmed(() => e.confirm({ ...good, [name]: { wrong: true } }, original.orgId, payload));
  }
  unconfirmed(() => e.confirm({ ...good, services: original.services.toReversed() }, original.orgId, payload));
  for (const change of [{ id: 'other' }, { orgId: 'other' }, { version: 4 }, { version: 6 }, { version: '5' }, { note: '' }, { reviewNote: '' }])
    unconfirmed(() => e.confirm({ ...good, ...change }, original.orgId, payload));
  for (const version of [0, 1.5, '4', Number.MAX_SAFE_INTEGER]) unconfirmed(() => editor(row({ version })).confirm(good, original.orgId, payload));
  for (const name of saved) {
    const missing = row(); delete missing[name]; const x = editor(missing);
    x.confirm(next(missing), missing.orgId, {}); unconfirmed(() => x.confirm(next(missing, { [name]: null }), missing.orgId, {}));
  }
});

test('review shows immutable actual-span context and keeps the exact original two-field request', () => {
  const e = review(row({ status: 'submitted' }));
  assert.deepEqual(e.fields.map(field => field.name), ['savedActualSpan', 'decision', 'reviewNote']);
  assert.deepEqual(e.initial, { decision: 'approved', reviewNote: '', savedActualSpan: '2026-10-09 09:05 至 09:50（舊同日格式）' });
  e.initial.decision = 'returned'; e.initial.reviewNote = 'caller mutation';
  assert.deepEqual(e.buildPayload({}), { decision: 'approved', reviewNote: '' });
  const reviewNote = '  合成退回\n補記🙂  ';
  assert.deepEqual(e.buildPayload({ decision: 'returned', reviewNote }), { decision: 'returned', reviewNote });
  assert.deepEqual(e.buildPayload({ reviewNote: ' 原核閱\r\n末行 ' }), { decision: 'approved', reviewNote: ' 原核閱\r\n末行 ' });
  for (const decision of ['draft', 'submitted', 'constructor', '', null, []]) bad(() => e.buildPayload({ decision }), 'decision');
  for (const reviewNote of ['', ' ', '\n\t ']) bad(() => e.buildPayload({ decision: 'returned', reviewNote }), 'reviewNote');
  for (const reviewNote of [null, false, 0, [], {}]) bad(() => e.buildPayload({ reviewNote }), 'reviewNote');
  const boundary = '🙂'.repeat(5000); assert.equal(e.buildPayload({ reviewNote: boundary }).reviewNote, boundary);
  bad(() => e.buildPayload({ reviewNote: boundary + 'x' }), 'reviewNote');
  for (const name of ['version', 'status', 'note', 'shiftId', 'billingSnapshot', 'unknown', 'constructor']) bad(() => e.buildPayload({ [name]: 'x' }));
});

test('review acknowledgements require exact status reviewNote and eight preserved own fields while billing stays server derived', () => {
  const original = row({ status: 'submitted', note: privateJson(), services: [{ serviceItemId: 's1', quantity: 2, extra: privateJson() }, { serviceItemId: 's2', quantity: 3 }], billingSnapshot: { secret: 'NEVER_RENDER' } });
  const captured = structuredClone(original), e = review(original), payload = e.buildPayload({ decision: 'approved', reviewNote: ' 原核閱\n ' });
  original.id = 'changed'; original.version = 99; original.services[0].quantity = 99; original.note.constructor[0] = 9;
  const good = next(captured, { status: 'approved', reviewNote: payload.reviewNote, billingSnapshot: { serverOnly: true, serviceMinutes: 45 } });
  e.confirm(good, captured.orgId, payload);
  assert(!JSON.stringify({ initial: e.initial, fields: e.fields }).includes('NEVER_RENDER'));
  for (const name of saved) {
    const missing = { ...good }; delete missing[name]; unconfirmed(() => e.confirm(missing, captured.orgId, payload));
    unconfirmed(() => e.confirm({ ...good, [name]: { wrong: true } }, captured.orgId, payload));
  }
  for (const name of ['id', 'orgId', 'version']) { const missing = { ...good }; delete missing[name]; unconfirmed(() => e.confirm(missing, captured.orgId, payload)); }
  unconfirmed(() => e.confirm({ ...good, services: captured.services.toReversed() }, captured.orgId, payload));
  for (const change of [{ id: 'other' }, { orgId: 'other' }, { version: 4 }, { version: 6 }, { version: '5' }, { status: 'returned' }, { reviewNote: payload.reviewNote.trim() }])
    unconfirmed(() => e.confirm({ ...good, ...change }, captured.orgId, payload));
  for (const name of saved.filter(name => !['status', 'reviewNote'].includes(name))) {
    const missing = row({ status: 'submitted' }); delete missing[name]; const x = review(missing), p = x.buildPayload({ decision: 'returned', reviewNote: '需補記' });
    const returned = next(missing, { status: 'returned', reviewNote: p.reviewNote }); x.confirm(returned, missing.orgId, p);
    unconfirmed(() => x.confirm({ ...returned, [name]: null }, missing.orgId, p));
  }
  const returned = review(row({ status: 'submitted' })), p = returned.buildPayload({ decision: 'returned', reviewNote: '  需補記  ' });
  returned.confirm(next(row({ status: 'submitted' }), { status: 'returned', reviewNote: p.reviewNote }), 'org-a', p);
});
