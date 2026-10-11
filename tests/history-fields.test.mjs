import test from 'node:test';
import assert from 'node:assert/strict';
import { getHistoryFields, normalizeHistorySnapshot, diffHistorySnapshots, formatTrialPriceCents } from '../public/data/history-fields.js';

const concise = changes => changes.map(({ key, before, after }) => ({ key, before, after })).sort((a, b) => a.key.localeCompare(b.key));
const freezeDeep = value => {
  if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) freezeDeep(item); }
  return value;
};

test('employee history retains ten saved fields and free-form job and qualification text without account or billing internals', () => {
  const keys = ['name', 'employeeNo', 'role', 'phone', 'email', 'status', 'qualification', 'regions', 'note', 'hourlyRateCents'];
  assert.deepEqual(getHistoryFields('employees').map(field => field.key), keys);
  const saved = {
    name: '合成員工', employeeNo: 'SYN-EMP-001', role: ' 行政兼服務協調 ', phone: '合成電話',
    email: 'synthetic@example.test', status: 'active', qualification: '尚待機構核對的資格文字',
    regions: '臺北、臺北,其他', note: '合成備註', hourlyRateCents: 12345,
    id: 'employee-a', orgId: 'org-a', version: 1, actor: { id: 'user-a' },
    loginRole: 'admin', password: 'synthetic-secret', fileId: 'private-file',
    billingSnapshot: { hourlyRateCents: 999 }, qualificationApproved: true, statutoryCredits: 999,
  };
  const metadataOnly = { ...saved, id: 'employee-b', orgId: 'org-b', version: 2, actor: { id: 'user-b' },
    loginRole: 'caregiver', password: 'different', fileId: 'different',
    billingSnapshot: { hourlyRateCents: 0 }, qualificationApproved: false, statutoryCredits: 0,
  };
  const normalized = normalizeHistorySnapshot('employees', saved);
  assert.deepEqual(Object.keys(normalized), keys);
  assert.equal(normalized.role, ' 行政兼服務協調 ');
  assert.equal(normalized.qualification, saved.qualification);
  assert.equal(normalized.regions, '臺北、臺北,其他');
  assert.equal(normalized.hourlyRateCents, 12345);
  assert.deepEqual(diffHistorySnapshots('employees', saved, metadataOnly), []);
});

test('employee regions distinguish saved text, ordered lists, duplicate and empty entries without interpreting invalid nested data', () => {
  const variants = freezeDeep([null, [], [''], ['空字串'], '臺北', ['臺北'], ['臺北', '臺北'], ['臺北', '臺中'], ['臺中', '臺北']]);
  const sourceText = JSON.stringify(variants);
  for (let left = 0; left < variants.length; left++) for (let right = left + 1; right < variants.length; right++) {
    assert.deepEqual(concise(diffHistorySnapshots('employees', { regions: variants[left] }, { regions: variants[right] })), [
      { key: 'regions', before: variants[left], after: variants[right] },
    ]);
  }
  for (const before of [{}, { regions: null }, { regions: '' }]) for (const after of [{}, { regions: null }, { regions: '' }]) {
    assert.deepEqual(diffHistorySnapshots('employees', before, after), []);
  }
  assert.equal(normalizeHistorySnapshot('employees', { regions: ' 臺北 ' }).regions, ' 臺北 ');
  assert.deepEqual(normalizeHistorySnapshot('employees', { regions: [' 臺北 ', '', '臺北'] }).regions, [' 臺北 ', '', '臺北']);
  for (const regions of [{ private: 'must-not-leak' }, ['臺北', { private: 'must-not-leak' }], ['臺北', null], [1], false]) {
    assert.deepEqual(normalizeHistorySnapshot('employees', { regions }).regions, { invalid: true });
  }
  const malformed = freezeDeep({ regions: { private: 'must-not-leak' } });
  const literal = freezeDeep({ regions: '[欄位格式無法判讀]' });
  const invalidSourceText = JSON.stringify([malformed, literal]);
  const invalidChange = diffHistorySnapshots('employees', malformed, literal);
  assert.deepEqual(concise(invalidChange), [
    { key: 'regions', before: { invalid: true }, after: '[欄位格式無法判讀]' },
  ]);
  assert.equal(Object.isFrozen(invalidChange[0].before), true);
  assert.equal(JSON.stringify(invalidChange).includes('must-not-leak'), false);
  assert.equal(JSON.stringify([malformed, literal]), invalidSourceText);
  assert.deepEqual(normalizeHistorySnapshot('employees', { regions: ['0', 'false', '空字串'] }).regions, ['0', 'false', '空字串']);
  assert.equal(JSON.stringify(variants), sourceText);
  assert.equal(normalizeHistorySnapshot('cases', { phone: ['合成電話'] }).phone, '[欄位格式無法判讀]');
});

test('employee frozen sources and region arrays remain unchanged while qualification text and one-cent trial pay changes stay exact', () => {
  const previous = freezeDeep({ name: '合成員工', regions: ['臺北', '', '臺中', '臺北'], note: null,
    qualification: '合成待核對摘要', hourlyRateCents: 12345, status: 'active' });
  const current = freezeDeep({ ...previous, regions: ['臺北', '臺中', '', '臺北'], note: '',
    qualification: '合成更新摘要，非資格核定', hourlyRateCents: 12346 });
  const sourceText = JSON.stringify([previous, current]);
  const changes = diffHistorySnapshots('employees', previous, current);
  assert.deepEqual(changes.map(({ key, before, after }) => ({ key, before, after })), [
    { key: 'qualification', before: previous.qualification, after: current.qualification },
    { key: 'regions', before: ['臺北', '', '臺中', '臺北'], after: ['臺北', '臺中', '', '臺北'] },
    { key: 'hourlyRateCents', before: 12345, after: 12346 },
  ]);
  const price = changes.find(change => change.key === 'hourlyRateCents');
  assert.equal(price.type, 'trial-price-cents');
  assert.equal(formatTrialPriceCents(price.before), '新臺幣 123.45 元（保存 12345 分）');
  assert.equal(formatTrialPriceCents(price.after), '新臺幣 123.46 元（保存 12346 分）');
  const normalized = normalizeHistorySnapshot('employees', previous);
  assert.notEqual(normalized.regions, previous.regions);
  normalized.regions.reverse(); normalized.regions.push('合成其他區域');
  changes.find(change => change.key === 'regions').before[0] = '合成修改';
  assert.equal(JSON.stringify([previous, current]), sourceText);
});

test('service item history retains eight saved business fields without exposing billing, credentials or policy internals', () => {
  const keys = ['code', 'name', 'minutes', 'unitPriceCents', 'validFrom', 'validTo', 'status', 'note'];
  assert.deepEqual(getHistoryFields('service-items').map(field => field.key), keys);
  const saved = {
    code: 'SYN-001', name: '合成服務項目', minutes: 47, unitPriceCents: 12345,
    validFrom: '2026-10-08', validTo: '2026-11-08', status: 'active', note: '合成備註',
    id: 'item-a', orgId: 'org-a', version: 1, actor: { id: 'user-a' },
    password: 'synthetic-private', fileId: 'private-file', billingSnapshot: { amountCents: 999 },
    policyVersion: 'unverified', officialPriceCents: 99999, copaymentCents: 999, hourlyRateCents: 999,
  };
  const metadataOnly = { ...saved, id: 'item-b', orgId: 'org-b', version: 2, actor: { id: 'user-b' },
    password: 'different', fileId: 'different', billingSnapshot: { amountCents: 0 },
    policyVersion: 'different', officialPriceCents: 0, copaymentCents: 0, hourlyRateCents: 0,
  };
  const normalized = normalizeHistorySnapshot('service-items', saved);
  assert.deepEqual(Object.keys(normalized), keys);
  assert.equal(normalized.unitPriceCents, 12345);
  assert.equal(normalized.minutes, 47);
  assert.deepEqual(diffHistorySnapshots('service-items', saved, metadataOnly), []);
  assert.deepEqual(diffHistorySnapshots('service-items', { unitPriceCents: { internal: 'do-not-serialize' } }, {} )[0].before, '[欄位格式無法判讀]');
});

test('saved synthetic cents preserve a one-cent change and render safe integer edges exactly without coercing invalid values', () => {
  assert.deepEqual(concise(diffHistorySnapshots('service-items', { unitPriceCents: 12345 }, { unitPriceCents: 12346 })), [
    { key: 'unitPriceCents', before: 12345, after: 12346 },
  ]);
  const exact = [
    [0, '新臺幣 0.00 元（保存 0 分）'],
    [1, '新臺幣 0.01 元（保存 1 分）'],
    [12345, '新臺幣 123.45 元（保存 12345 分）'],
    [12346, '新臺幣 123.46 元（保存 12346 分）'],
    [Number.MAX_SAFE_INTEGER, '新臺幣 90071992547409.91 元（保存 9007199254740991 分）'],
  ];
  for (const [value, expected] of exact) assert.equal(formatTrialPriceCents(value), expected);
  for (const missing of [undefined, null, '']) assert.equal(formatTrialPriceCents(missing), '未提供');
  const invalid = [
    ['12345', '12345（金額無法判讀）'], ['0', '0（金額無法判讀）'],
    [-1, '-1（金額無法判讀）'], [1.5, '1.5（金額無法判讀）'],
    [Number.MAX_SAFE_INTEGER + 1, '9007199254740992（金額無法判讀）'],
    [false, 'false（金額無法判讀）'],
    [{ amount: 12345, private: 'must-not-leak' }, '[欄位格式無法判讀]（金額無法判讀）'],
  ];
  for (const [value, expected] of invalid) assert.equal(formatTrialPriceCents(value), expected);
  assert.deepEqual(concise(diffHistorySnapshots('service-items', { unitPriceCents: 0 }, {})), [
    { key: 'unitPriceCents', before: 0, after: null },
  ]);
});

test('service item effective dates and inactive state remain saved differences while frozen snapshots and equivalent empty values stay unchanged', () => {
  const previous = freezeDeep({ code: ' SYN-001 ', name: '合成服務項目', minutes: 47, unitPriceCents: 1,
    validFrom: '2020-01-01', validTo: null, status: 'active', note: null, billingSnapshot: { amountCents: 12345 } });
  const current = freezeDeep({ ...previous, validFrom: '2021-02-03', validTo: '2021-03-04', status: 'inactive', note: '' });
  const sourceText = JSON.stringify([previous, current]);
  const changes = diffHistorySnapshots('service-items', previous, current);
  assert.deepEqual(changes.map(({ key, before, after }) => ({ key, before, after })), [
    { key: 'validFrom', before: '2020-01-01', after: '2021-02-03' },
    { key: 'validTo', before: null, after: '2021-03-04' },
    { key: 'status', before: 'active', after: 'inactive' },
  ]);
  const emptySnapshots = [{}, { validFrom: null, validTo: '', note: null, unitPriceCents: null },
    { validFrom: '', validTo: null, note: '', unitPriceCents: '' }];
  for (const before of emptySnapshots) for (const after of emptySnapshots) {
    assert.deepEqual(diffHistorySnapshots('service-items', before, after), []);
  }
  const normalized = normalizeHistorySnapshot('service-items', previous);
  assert.equal(normalized.code, ' SYN-001 ');
  normalized.code = 'changed'; normalized.unitPriceCents = 999; changes[0].before = 'changed';
  assert.equal(JSON.stringify([previous, current]), sourceText);
  assert.equal(formatTrialPriceCents(previous.unitPriceCents), '新臺幣 0.01 元（保存 1 分）');
});

test('certification attachment history exposes nine saved fields and excludes storage, category and audit internals', () => {
  const keys = ['certificationId', 'employeeId', 'title', 'status', 'note', 'fileName', 'mimeType', 'sizeBytes', 'sha256'];
  assert.deepEqual(getHistoryFields('certification-attachments').map(field => field.key), keys);
  const original = {
    certificationId: 'cert-a', employeeId: 'employee-a', title: '合成證照掃描', status: 'active', note: '',
    fileName: '合成證照.pdf', mimeType: 'application/pdf', sizeBytes: 73, sha256: 'a'.repeat(64),
    fileId: 'private-blob-a', contentBase64: 'cHJpdmF0ZQ==', category: 'general', orgId: 'org-a',
    version: 1, actor: { id: 'user-a' }, downloadUrl: '/private/file', employeeQualification: 'unknown',
  };
  const changedInternals = { ...original, fileId: 'private-blob-b', contentBase64: 'bmV3', category: 'other',
    orgId: 'org-b', version: 2, actor: { id: 'user-b' }, downloadUrl: '/other', employeeQualification: 'approved',
  };
  assert.deepEqual(Object.keys(normalizeHistorySnapshot('certification-attachments', original)), keys);
  assert.deepEqual(diffHistorySnapshots('certification-attachments', original, changedInternals), []);
});

test('certification attachment history distinguishes metadata and replacement bytes without mutating snapshots', () => {
  const previous = freezeDeep({ certificationId: 'cert-a', employeeId: 'employee-a', title: '合成原標題', status: 'active',
    note: null, fileName: '合成原檔.pdf', mimeType: 'application/pdf', sizeBytes: 73, sha256: 'a'.repeat(64), fileId: 'private-a' });
  const current = freezeDeep({ ...previous, title: '合成新標題', status: 'inactive', note: '',
    fileName: '合成替換.png', mimeType: 'image/png', sizeBytes: 89, sha256: 'b'.repeat(64), fileId: 'private-b' });
  const source = JSON.stringify([previous, current]);
  const changes = diffHistorySnapshots('certification-attachments', previous, current);
  assert.deepEqual(changes.map(change => change.key), ['title', 'status', 'fileName', 'mimeType', 'sizeBytes', 'sha256']);
  assert.deepEqual(changes.find(change => change.key === 'sizeBytes'), {
    key: 'sizeBytes', label: '檔案大小', type: 'bytes', before: 73, after: 89,
  });
  assert.deepEqual(diffHistorySnapshots('certification-attachments', {}, { note: null }), []);
  const normalized = normalizeHistorySnapshot('certification-attachments', previous);
  normalized.title = '不應改寫原快照';
  assert.equal(JSON.stringify([previous, current]), source);
});

test('leave history exposes seven original fields and the explicit end date without actor, balance or billing internals', () => {
  assert.deepEqual(getHistoryFields('leave-requests').map(field => field.key), [
    'employeeId', 'date', 'endDate', 'startTime', 'endTime', 'type', 'reason', 'status',
  ]);
  const saved = {
    employeeId: 'employee-a', date: '2026-10-08', startTime: '09:00', endTime: '10:00',
    type: '合成機構自訂假別／待核對', reason: '合成請假說明', status: 'pending',
    id: 'leave-a', orgId: 'org-a', version: 1, source: 'form', actor: { id: 'user-a' },
    billingSnapshot: { amountCents: 900 }, leaveMinutes: 60, annualBalance: 999, credits: 8,
  };
  const metadataOnly = { ...saved, id: 'leave-b', orgId: 'org-b', version: 2, source: 'review',
    actor: { id: 'user-b' }, billingSnapshot: { amountCents: 999 }, leaveMinutes: 999, annualBalance: 0, credits: 0,
  };
  assert.deepEqual(diffHistorySnapshots('leave-requests', saved, metadataOnly), []);
  const normalized = normalizeHistorySnapshot('leave-requests', saved);
  assert.equal(normalized.type, saved.type);
  for (const key of ['id', 'orgId', 'version', 'source', 'actor', 'billingSnapshot', 'leaveMinutes', 'annualBalance', 'credits']) {
    assert.ok(!Object.hasOwn(normalized, key), key);
  }
});

test('leave history records employee reassignment and original time text without inferring a duration or leave category', () => {
  const previous = {
    employeeId: 'employee-a', date: '2026-10-08', startTime: '2026-10-08T09:00:29+08:00',
    endTime: '2026-10-08T10:00:59+08:00', type: '合成機構自訂假別', reason: '合成原說明', status: 'pending',
  };
  const current = {
    employeeId: 'employee-b', date: '2026-10-09', startTime: '09:00', endTime: '10:30',
    type: '合成另一定義假別', reason: '合成修改說明', status: 'approved',
  };
  assert.deepEqual(concise(diffHistorySnapshots('leave-requests', previous, current)), [
    { key: 'date', before: '2026-10-08', after: '2026-10-09' },
    { key: 'employeeId', before: 'employee-a', after: 'employee-b' },
    { key: 'endTime', before: '2026-10-08T10:00:59+08:00', after: '10:30' },
    { key: 'reason', before: '合成原說明', after: '合成修改說明' },
    { key: 'startTime', before: '2026-10-08T09:00:29+08:00', after: '09:00' },
    { key: 'status', before: 'pending', after: 'approved' },
    { key: 'type', before: '合成機構自訂假別', after: '合成另一定義假別' },
  ]);
  assert.deepEqual(concise(diffHistorySnapshots('leave-requests', { startTime: previous.startTime }, { startTime: '09:00' })), [
    { key: 'startTime', before: previous.startTime, after: '09:00' },
  ]);
});

test('leave snapshots stay unchanged and empty reasons are equivalent while meaningful saved text is preserved', () => {
  const previous = freezeDeep({ employeeId: 'employee-a', type: ' 合成自由假別 ', reason: null, status: 'approved', startTime: '09:00', endTime: '10:00', billingSnapshot: { amountCents: 900 } });
  const current = freezeDeep({ ...previous, reason: '', status: 'cancelled' });
  const sourceText = JSON.stringify([previous, current]);
  assert.deepEqual(concise(diffHistorySnapshots('leave-requests', previous, current)), [
    { key: 'status', before: 'approved', after: 'cancelled' },
  ]);
  assert.deepEqual(diffHistorySnapshots('leave-requests', {}, { reason: null }), []);
  assert.deepEqual(diffHistorySnapshots('leave-requests', { reason: '' }, { reason: undefined }), []);
  const normalized = normalizeHistorySnapshot('leave-requests', previous);
  assert.equal(normalized.type, ' 合成自由假別 ');
  normalized.type = '合成其他文字';
  normalized.employeeId = 'employee-b';
  assert.equal(JSON.stringify([previous, current]), sourceText);
});

test('history diff exposes the case business whitelist and excludes identity, credentials and financial internals', () => {
  const keys = getHistoryFields('cases').map(field => field.key);
  for (const key of ['name', 'caseNo', 'phone', 'contactName', 'contactPhone', 'supervisorId', 'note']) assert.ok(keys.includes(key), key);
  for (const key of ['id', 'orgId', 'version', 'password', 'billingSnapshot', 'unitPriceCents', 'createdAt']) assert.ok(!keys.includes(key), key);
  const changes = diffHistorySnapshots('cases',
    { phone: '合成舊電話', contactName: '合成舊聯絡人', id: 'old', password: 'old', billingSnapshot: { total: 1 } },
    { phone: '合成新電話', contactName: '合成新聯絡人', id: 'new', password: 'new', billingSnapshot: { total: 2 } });
  assert.deepEqual(concise(changes), [
    { key: 'contactName', before: '合成舊聯絡人', after: '合成新聯絡人' },
    { key: 'phone', before: '合成舊電話', after: '合成新電話' },
  ]);
  assert.ok(changes.every(change => typeof change.label === 'string' && change.label.length > 0));
});

test('missing, null and empty strings are equivalent while meaningful values remain distinguishable', () => {
  for (const left of [{}, { phone: null, contactPhone: null }, { phone: '', contactPhone: '' }]) {
    for (const right of [{}, { phone: null, contactPhone: '' }, { phone: '', contactPhone: null }]) {
      assert.deepEqual(diffHistorySnapshots('cases', left, right), []);
    }
  }
  assert.deepEqual(concise(diffHistorySnapshots('cases', { cmsLevel: 0 }, { cmsLevel: '' })), [{ key: 'cmsLevel', before: 0, after: null }]);
  assert.deepEqual(concise(diffHistorySnapshots('cases', {}, { phone: '合成電話' })), [{ key: 'phone', before: null, after: '合成電話' }]);
});

test('plan services compare by ID and quantity, ignore order and remove non-whitelisted item data', () => {
  const previous = { services: [{ serviceItemId: 'service-b', quantity: 2, unitPriceCents: 100 }, { serviceItemId: 'service-a', quantity: 1 }] };
  const current = { services: [{ serviceItemId: 'service-a', quantity: 1, secret: 'ignored' }, { serviceItemId: 'service-b', quantity: 2, unitPriceCents: 999 }] };
  assert.deepEqual(diffHistorySnapshots('care-plans', previous, current), []);
  const normalized = normalizeHistorySnapshot('care-plans', previous);
  assert.deepEqual(normalized.services, [{ serviceItemId: 'service-a', quantity: 1 }, { serviceItemId: 'service-b', quantity: 2 }]);
});

test('plan quantity changes and added or removed services remain visible with before and after values', () => {
  const previous = { services: [{ serviceItemId: 'service-a', quantity: 1 }, { serviceItemId: 'service-b', quantity: 2 }], goals: '合成原目標' };
  const current = { services: [{ serviceItemId: 'service-c', quantity: 1 }, { serviceItemId: 'service-a', quantity: 3 }], goals: '合成新目標' };
  const changes = diffHistorySnapshots('care-plans', previous, current);
  assert.deepEqual(changes.map(change => change.key).sort(), ['goals', 'services']);
  const services = changes.find(change => change.key === 'services');
  assert.deepEqual(services.before, previous.services);
  assert.deepEqual(services.after, [{ serviceItemId: 'service-a', quantity: 3 }, { serviceItemId: 'service-c', quantity: 1 }]);
  assert.ok(!getHistoryFields('care-plans').some(field => ['unitPriceCents', 'billingSnapshot', 'version', 'id'].includes(field.key)));
});

test('normalization and diff never mutate source snapshots or share mutable service objects', () => {
  const previous = freezeDeep({ caseId: 'case-a', services: [{ serviceItemId: 'service-b', quantity: 2 }, { serviceItemId: 'service-a', quantity: 1 }], note: null });
  const current = freezeDeep({ caseId: 'case-a', services: [{ serviceItemId: 'service-a', quantity: 4 }, { serviceItemId: 'service-b', quantity: 2 }], note: '' });
  const before = JSON.stringify([previous, current]);
  const normalized = normalizeHistorySnapshot('care-plans', previous);
  const changes = diffHistorySnapshots('care-plans', previous, current);
  assert.equal(JSON.stringify([previous, current]), before);
  assert.notEqual(normalized.services, previous.services);
  assert.ok(normalized.services.every(item => !previous.services.includes(item)));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].key, 'services');
});

test('shift history exposes its nine original fields and explicit end date and records reassignment, scheduling and state changes', () => {
  assert.deepEqual(getHistoryFields('shifts').map(field => field.key), [
    'caseId', 'employeeId', 'carePlanId', 'date', 'endDate', 'startTime', 'endTime', 'services', 'status', 'note',
  ]);
  const previous = {
    caseId: 'case-a', employeeId: 'employee-a', carePlanId: 'plan-a', date: '2026-10-28',
    startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: 'service-a', quantity: 1 }],
    status: 'scheduled', note: '合成交班事項', orgId: 'org-a', version: 1, source: 'recurring',
    billingSnapshot: { totalCents: 100 }, payrollSnapshot: { totalCents: 100 }, batchId: 'batch-a',
  };
  const current = { ...previous,
    caseId: 'case-b', employeeId: 'employee-b', carePlanId: 'plan-b', date: '2026-10-29',
    startTime: '10:00', endTime: '11:00', status: 'cancelled', note: '合成取消說明',
    orgId: 'org-b', version: 2, source: 'manual', billingSnapshot: { totalCents: 999 },
    payrollSnapshot: { totalCents: 999 }, batchId: 'batch-b',
  };
  assert.deepEqual(concise(diffHistorySnapshots('shifts', previous, current)), [
    { key: 'carePlanId', before: 'plan-a', after: 'plan-b' },
    { key: 'caseId', before: 'case-a', after: 'case-b' },
    { key: 'date', before: '2026-10-28', after: '2026-10-29' },
    { key: 'employeeId', before: 'employee-a', after: 'employee-b' },
    { key: 'endTime', before: '10:00', after: '11:00' },
    { key: 'note', before: '合成交班事項', after: '合成取消說明' },
    { key: 'startTime', before: '09:00', after: '10:00' },
    { key: 'status', before: 'scheduled', after: 'cancelled' },
  ]);
  const normalized = normalizeHistorySnapshot('shifts', current);
  for (const key of ['orgId', 'version', 'source', 'billingSnapshot', 'payrollSnapshot', 'batchId']) assert.ok(!Object.hasOwn(normalized, key), key);
});

test('shift services ignore ordering and price metadata, but preserve quantity and membership changes', () => {
  const previous = { services: [{ serviceItemId: 'service-b', quantity: 2, unitPriceCents: 100 }, { serviceItemId: 'service-a', quantity: 1 }] };
  const reordered = { services: [{ serviceItemId: 'service-a', quantity: 1 }, { serviceItemId: 'service-b', quantity: 2, unitPriceCents: 999, billingSnapshot: { amount: 999 } }] };
  assert.deepEqual(diffHistorySnapshots('shifts', previous, reordered), []);
  const current = { services: [{ serviceItemId: 'service-c', quantity: 4 }, { serviceItemId: 'service-a', quantity: 3 }] };
  const [change] = diffHistorySnapshots('shifts', previous, current);
  assert.equal(change.key, 'services');
  assert.equal(change.quantityLabel, '排班數量');
  assert.equal(getHistoryFields('care-plans').find(field => field.key === 'services').quantityLabel, '計畫數量');
  assert.deepEqual(change.before, [{ serviceItemId: 'service-a', quantity: 1 }, { serviceItemId: 'service-b', quantity: 2 }]);
  assert.deepEqual(change.after, [{ serviceItemId: 'service-a', quantity: 3 }, { serviceItemId: 'service-c', quantity: 4 }]);
});

test('shift normalization leaves frozen sources untouched and treats omitted notes as unprovided', () => {
  const previous = freezeDeep({ employeeId: 'employee-a', note: null, services: [{ serviceItemId: 'service-b', quantity: 2 }, { serviceItemId: 'service-a', quantity: 1 }] });
  const current = freezeDeep({ employeeId: 'employee-a', note: '', services: [{ serviceItemId: 'service-a', quantity: 1 }, { serviceItemId: 'service-b', quantity: 2 }] });
  const sourceText = JSON.stringify([previous, current]);
  const normalized = normalizeHistorySnapshot('shifts', previous);
  assert.deepEqual(diffHistorySnapshots('shifts', previous, current), []);
  assert.deepEqual(diffHistorySnapshots('shifts', { note: undefined }, { note: '' }), []);
  assert.equal(JSON.stringify([previous, current]), sourceText);
  assert.notEqual(normalized.services, previous.services);
  assert.ok(normalized.services.every(item => !previous.services.includes(item)));
  normalized.services[0].quantity = 999;
  assert.equal(previous.services[1].quantity, 1);
});

test('service history retains its ten original fields plus explicit actual end date and saved time text while excluding billing and metadata', () => {
  assert.deepEqual(getHistoryFields('service-records').map(field => field.key), [
    'shiftId', 'caseId', 'employeeId', 'date', 'actualEndDate', 'actualStart', 'actualEnd', 'services', 'status', 'note', 'reviewNote',
  ]);
  const previous = {
    shiftId: 'shift-a', caseId: 'case-a', employeeId: 'employee-a', date: '2026-10-08',
    actualStart: '2026-10-08T09:05:29+08:00', actualEnd: '09:50', status: 'submitted',
    services: [{ serviceItemId: 'service-a', quantity: 3 }], note: '合成服務觀察', reviewNote: '',
    billingSnapshot: { serviceMinutes: 45, items: [{ unitPriceCents: 900 }] }, version: 2, orgId: 'org-a', source: 'form',
  };
  const current = { ...previous, actualStart: '09:05', status: 'returned', reviewNote: '合成督導請補服務情形',
    billingSnapshot: { serviceMinutes: 999, items: [{ unitPriceCents: 999 }] }, version: 3, orgId: 'org-b', source: 'review',
    hourlyRateCents: 999, actor: { id: 'not-a-business-field' },
  };
  assert.deepEqual(concise(diffHistorySnapshots('service-records', previous, current)), [
    { key: 'actualStart', before: '2026-10-08T09:05:29+08:00', after: '09:05' },
    { key: 'reviewNote', before: null, after: '合成督導請補服務情形' },
    { key: 'status', before: 'submitted', after: 'returned' },
  ]);
  const normalized = normalizeHistorySnapshot('service-records', previous);
  assert.equal(normalized.actualStart, previous.actualStart);
  assert.equal(normalized.actualEnd, '09:50');
  for (const key of ['billingSnapshot', 'serviceMinutes', 'hourlyRateCents', 'version', 'orgId', 'source', 'actor']) assert.ok(!Object.hasOwn(normalized, key), key);
});

test('service history compares actual service membership and quantity, ignoring order and embedded prices', () => {
  const previous = { services: [{ serviceItemId: 'service-b', quantity: 1, unitPriceCents: 200 }, { serviceItemId: 'service-a', quantity: 3 }] };
  const reordered = { services: [{ serviceItemId: 'service-a', quantity: 3, amountCents: 800 }, { serviceItemId: 'service-b', quantity: 1, unitPriceCents: 999 }] };
  assert.deepEqual(diffHistorySnapshots('service-records', previous, reordered), []);
  const [change] = diffHistorySnapshots('service-records', previous, { services: [{ serviceItemId: 'service-a', quantity: 4 }, { serviceItemId: 'service-c', quantity: 2 }] });
  assert.equal(change.label, '服務項目與實際數量');
  assert.equal(change.quantityLabel, '實際數量');
  assert.deepEqual(change.before, [{ serviceItemId: 'service-a', quantity: 3 }, { serviceItemId: 'service-b', quantity: 1 }]);
  assert.deepEqual(change.after, [{ serviceItemId: 'service-a', quantity: 4 }, { serviceItemId: 'service-c', quantity: 2 }]);
  assert.equal(getHistoryFields('shifts').find(field => field.key === 'services').quantityLabel, '排班數量');
});

test('service history keeps frozen snapshots unchanged and treats missing observations as unprovided', () => {
  const previous = freezeDeep({ note: null, reviewNote: '', services: [{ serviceItemId: 'service-b', quantity: 1 }, { serviceItemId: 'service-a', quantity: 3 }] });
  const current = freezeDeep({ note: '', services: [{ serviceItemId: 'service-a', quantity: 3 }, { serviceItemId: 'service-b', quantity: 1 }] });
  const original = JSON.stringify([previous, current]);
  assert.deepEqual(diffHistorySnapshots('service-records', previous, current), []);
  const normalized = normalizeHistorySnapshot('service-records', previous);
  normalized.services[0].quantity = 999;
  assert.equal(previous.services[1].quantity, 3);
  assert.equal(JSON.stringify([previous, current]), original);
  assert.deepEqual(concise(diffHistorySnapshots('service-records', {}, { note: '合成補充觀察' })), [
    { key: 'note', before: null, after: '合成補充觀察' },
  ]);
});

test('personnel history exposes only the eight saved fields for each domain, excluding derived expiry and financial data', () => {
  assert.deepEqual(getHistoryFields('employee-certifications').map(field => field.key), [
    'employeeId', 'name', 'certificateNo', 'issuer', 'issuedOn', 'expiresOn', 'status', 'note',
  ]);
  assert.deepEqual(getHistoryFields('employee-training').map(field => field.key), [
    'employeeId', 'name', 'category', 'provider', 'date', 'trainingMinutes', 'status', 'note',
  ]);
  const derived = { id: 'record-a', orgId: 'org-a', version: 1, updatedAt: '2026-10-08T00:00:00Z',
    expiryState: 'expired', daysToExpiry: -1, asOf: '2026-10-08', trainingHours: 1.25,
    statutoryCredits: 75, billingSnapshot: { amountCents: 100 } };
  for (const entity of ['employee-certifications', 'employee-training']) {
    const changes = diffHistorySnapshots(entity, derived, { ...derived, id: 'record-b', orgId: 'org-b', version: 2,
      updatedAt: '2026-10-09T00:00:00Z', expiryState: 'valid', daysToExpiry: 30, asOf: '2026-10-09',
      trainingHours: 2.5, statutoryCredits: 150, billingSnapshot: { amountCents: 999 } });
    assert.deepEqual(changes, []);
    const normalized = normalizeHistorySnapshot(entity, derived);
    for (const key of Object.keys(derived)) assert.ok(!Object.hasOwn(normalized, key), key);
  }
});

test('certificate history compares saved dates and revocation without treating an omitted expiry as a fixed validity period', () => {
  const previous = { issuedOn: '2026-10-08', expiresOn: '', status: 'active', certificateNo: '合成原證號' };
  const current = { issuedOn: '2026-10-09', expiresOn: '2027-10-08', status: 'revoked', certificateNo: '合成新證號' };
  assert.deepEqual(concise(diffHistorySnapshots('employee-certifications', previous, current)), [
    { key: 'certificateNo', before: '合成原證號', after: '合成新證號' },
    { key: 'expiresOn', before: null, after: '2027-10-08' },
    { key: 'issuedOn', before: '2026-10-08', after: '2026-10-09' },
    { key: 'status', before: 'active', after: 'revoked' },
  ]);
  for (const value of [undefined, null, '']) assert.deepEqual(diffHistorySnapshots('employee-certifications', {}, { expiresOn: value }), []);
  assert.equal(getHistoryFields('employee-certifications').find(field => field.key === 'expiresOn').emptyLabel, '未填到期日');
  assert.equal(normalizeHistorySnapshot('employee-certifications', { issuedOn: '舊資料待核對' }).issuedOn, '舊資料待核對');
});

test('training history retains exact minute changes and invalid legacy text, leaving all source snapshots untouched', () => {
  const previous = freezeDeep({ employeeId: 'employee-a', trainingMinutes: 75, category: 'in_service', status: 'completed', note: null });
  const current = freezeDeep({ employeeId: 'employee-a', trainingMinutes: 1, category: 'pre_service', status: 'cancelled', note: '' });
  const saved = JSON.stringify([previous, current]);
  assert.deepEqual(concise(diffHistorySnapshots('employee-training', previous, current)), [
    { key: 'category', before: 'in_service', after: 'pre_service' },
    { key: 'status', before: 'completed', after: 'cancelled' },
    { key: 'trainingMinutes', before: 75, after: 1 },
  ]);
  assert.equal(getHistoryFields('employee-training').find(field => field.key === 'trainingMinutes').label, '實際訓練時間（分鐘）');
  for (const value of [1.5, 0, '舊資料待核對']) assert.equal(normalizeHistorySnapshot('employee-training', { trainingMinutes: value }).trainingMinutes, value);
  assert.equal(normalizeHistorySnapshot('employee-training', {}).trainingMinutes, null);
  const normalized = normalizeHistorySnapshot('employee-training', previous);
  normalized.trainingMinutes = 999;
  assert.equal(JSON.stringify([previous, current]), saved);
  const certificate = freezeDeep({ issuedOn: '2026-10-08', expiresOn: null, note: '合成備註' });
  const certificateSaved = JSON.stringify(certificate);
  diffHistorySnapshots('employee-certifications', certificate, freezeDeep({ ...certificate, note: '合成補充備註' }));
  assert.equal(JSON.stringify(certificate), certificateSaved);
});
