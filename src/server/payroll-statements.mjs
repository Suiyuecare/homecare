/** Manual payroll statements are documentary settlements, never bank payments or automatic tax calculations. */
export const payrollStatementEntities = {
  'payroll-statements': {
    fields: 'employeeId month number lineItems sourceReference status note',
    jsonFields: ['lineItems'],
    required: ['employeeId', 'month', 'number', 'lineItems'],
    statuses: ['draft', 'reviewed', 'closed', 'voided'],
    defaults: { status: 'draft', sourceReference: '', note: '' },
  },
};
export const isPayrollStatementEntity = entity => Object.hasOwn(payrollStatementEntities, entity);
export function guardPayrollStatementAccess(entity, ctx, _readOnly, fail) {
  if (isPayrollStatementEntity(entity) && !['admin', 'finance'].includes(ctx.role))
    fail(403, 'ROLE_FORBIDDEN', '僅管理者或財務可讀取與維護人工薪資結算');
}
export function normalizePayrollStatementPayload(entity, payload) {
  if (!isPayrollStatementEntity(entity)) return payload;
  // A supplied array is an explicit complete replacement. Preserve label text
  // exactly so editing one amount cannot silently normalize untouched labels.
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === 'string' && key !== 'note' ? value.trim() : value]));
}
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const monthValid = value => typeof value === 'string' && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value);
/** Authorize both the saved parent and its closed identity snapshot before projection. */
export function payrollStatementVisible(db, ctx, entity, item, get) {
  if (!isPayrollStatementEntity(entity)) return true;
  if (!plain(item) || item.orgId !== ctx.orgId || typeof item.id !== 'string' || !item.id.trim() || item.id !== item.id.trim()
    || !Number.isSafeInteger(item.version) || item.version < 1 || typeof item.employeeId !== 'string' || !item.employeeId.trim()) return false;
  const employee = get(db, ctx.orgId, 'employees', item.employeeId), snapshot = item.employeeSnapshot;
  return !!employee && employee.orgId === ctx.orgId && plain(snapshot) && Object.keys(snapshot).sort().join(',') === 'employeeNo,id,name'
    && snapshot.id === item.employeeId && typeof snapshot.name === 'string' && typeof snapshot.employeeNo === 'string';
}
export function payrollStatementHistoryVisible(db, ctx, entity, snapshot, current, get) {
  if (!isPayrollStatementEntity(entity)) return true;
  return payrollStatementVisible(db, ctx, entity, current, get) && payrollStatementVisible(db, ctx, entity, snapshot, get)
    && snapshot.id === current.id && ['employeeId', 'month', 'number'].every(key => snapshot[key] === current[key]);
}
export function assertPayrollStatementTransitionPayload(entity, payload, fail) {
  if (isPayrollStatementEntity(entity) && payload.status === 'voided' && (!Object.hasOwn(payload, 'note') || typeof payload.note !== 'string' || !payload.note.trim()))
    fail(422, 'VOID_REASON_REQUIRED', '取消薪資結算必須在本次請求明確填寫原因', { note: '本次取消原因必填' });
}
function totals(items, fail) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) fail(422, 'INVALID_LINES', '薪資明細須為1至100筆', { lineItems: '請提供至少1筆且最多100筆明細' });
  let earning = 0n, deduction = 0n;
  for (const item of items) {
    if (!plain(item) || Object.keys(item).length !== 3 || Object.keys(item).some(key => !['label', 'kind', 'amountCents'].includes(key))
      || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 100 || !['earning', 'deduction'].includes(item.kind)
      || !Number.isSafeInteger(item.amountCents) || item.amountCents < 0 || item.amountCents > 1e9)
      fail(422, 'INVALID_LINES', '明細須包含有效名稱、加項／減項及整數分金額', { lineItems: '名稱最多100字，金額須為0至1000000000分的整數' });
    if (item.kind === 'earning') earning += BigInt(item.amountCents); else deduction += BigInt(item.amountCents);
  }
  if (deduction > earning) fail(422, 'NEGATIVE_NET', '減項合計不可超過加項合計', { lineItems: '請核對加項與減項' });
  if (earning > BigInt(Number.MAX_SAFE_INTEGER) || deduction > BigInt(Number.MAX_SAFE_INTEGER)) fail(422, 'UNSAFE_TOTAL', '薪資合計超出可保存的整數範圍');
  return { earningCents: Number(earning), deductionCents: Number(deduction), netCents: Number(earning - deduction) };
}
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export function validatePayrollStatement(db, ctx, entity, data, old, fail, _dateValid, rows, get) {
  if (!isPayrollStatementEntity(entity)) return;
  guardPayrollStatementAccess(entity, ctx, false, fail);
  if (old && !payrollStatementVisible(db, ctx, entity, old, get)) fail(404, 'NOT_FOUND', '找不到可操作薪資結算');
  for (const key of ['employeeId', 'month', 'number', 'sourceReference', 'status', 'note']) {
    const limit = key === 'note' ? 10000 : key === 'number' ? 100 : 500;
    if (typeof data[key] !== 'string' || data[key].length > limit) fail(422, 'INVALID_FIELD', '薪資欄位格式或長度不符', { [key]: `請提供最多${limit}字的文字` });
  }
  for (const key of ['employeeId', 'month', 'number']) if (!data[key].trim()) fail(422, 'REQUIRED', '請填寫必要欄位', { [key]: '必填' });
  if (!monthValid(data.month)) fail(422, 'INVALID_MONTH', '薪資月份須為0001至9999年的YYYY-MM', { month: '請核對月份' });
  if (!payrollStatementEntities[entity].statuses.includes(data.status)) fail(422, 'INVALID_STATUS', '薪資結算狀態不合法', { status: '狀態不合法' });
  if (old) {
    for (const key of ['employeeId', 'month', 'number']) if (data[key] !== old[key]) fail(409, 'IDENTITY_IMMUTABLE', '建立後不可更換員工、月份或結算編號', { [key]: '不可變更' });
    if (['closed', 'voided'].includes(old.status)) fail(409, 'STATEMENT_LOCKED', '已關帳或已取消的薪資結算不能再修改');
    if (old.status === 'reviewed') {
      if (!['closed', 'voided'].includes(data.status) || ['employeeId', 'month', 'number', 'lineItems', 'sourceReference'].some(key => !same(data[key], old[key])))
        fail(409, 'STATEMENT_LOCKED', '已覆核的薪資內容已鎖定，只能關帳或取消');
      if (data.status === 'closed' && data.note !== old.note) fail(409, 'STATEMENT_LOCKED', '已覆核的備註不可於關帳時改寫');
    } else if (old.status !== 'draft' || !['draft', 'reviewed', 'voided'].includes(data.status)) fail(409, 'INVALID_TRANSITION', '不允許此薪資結算狀態轉換');
  } else if (data.status !== 'draft') fail(422, 'DRAFT_REQUIRED', '新增薪資結算必須先建立草稿');
  if (data.status === 'reviewed' && !data.sourceReference.trim()) fail(422, 'SOURCE_REQUIRED', '覆核前必須填寫人工核定依據', { sourceReference: '請記錄核定依據' });
  if (data.status === 'voided' && !data.note.trim()) fail(422, 'VOID_REASON_REQUIRED', '取消薪資結算必須填寫原因', { note: '取消原因必填' });
  if (rows(db, ctx.orgId, entity).some(item => item.id !== old?.id && item.number === data.number)) fail(409, 'DUPLICATE_NUMBER', '本機構薪資結算編號已存在', { number: '編號不可重複' });
  const employee = get(db, ctx.orgId, 'employees', data.employeeId);
  if (!employee) fail(422, 'INVALID_REFERENCE', '員工不存在或不屬於本機構', { employeeId: '同機構員工必要' });
  data.summary = totals(data.lineItems, fail);
  if (old) {
    const snapshot = old.employeeSnapshot;
    if (!plain(snapshot) || Object.keys(snapshot).length !== 3 || snapshot.id !== old.employeeId || typeof snapshot.name !== 'string' || typeof snapshot.employeeNo !== 'string')
      fail(409, 'STATEMENT_DATA_INVALID', '無法確認原薪資員工快照，請人工核對');
    data.employeeSnapshot = { ...snapshot };
  } else {
    if (typeof employee.name !== 'string' || typeof employee.employeeNo !== 'string') fail(409, 'EMPLOYEE_DATA_INVALID', '無法確認員工姓名或編號');
    data.employeeSnapshot = { id: employee.id, name: employee.name, employeeNo: employee.employeeNo };
  }
}
export function payrollStatementQuery(entity, params, fail) {
  if (!isPayrollStatementEntity(entity)) return {};
  const allowed = new Set(['page', 'pageSize', 'q', 'employeeId', 'month', 'status']);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) fail(422, 'INVALID_QUERY', '查詢欄位不合法或重複', { [key]: '請使用單一合法欄位' });
  if (params.has('q') && params.get('q').length > 200) fail(422, 'INVALID_QUERY', '搜尋文字最多200字', { q: '文字過長' });
  if (params.has('employeeId') && (!params.get('employeeId').trim() || params.get('employeeId').length > 500)) fail(422, 'INVALID_QUERY', '員工查詢格式不符', { employeeId: '請使用有效識別碼' });
  if (params.has('month') && !monthValid(params.get('month'))) fail(422, 'INVALID_MONTH', '月份格式不符', { month: '請使用有效YYYY-MM' });
  if (params.has('status') && !payrollStatementEntities[entity].statuses.includes(params.get('status'))) fail(422, 'INVALID_STATUS', '薪資結算狀態不合法', { status: '狀態不合法' });
  return {};
}
