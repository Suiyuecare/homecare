import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEmployeePayrollPayload, employeePayrollQuery } from '../src/server/employee-payroll.mjs';

const draft = () => ({ employeeId: 'synthetic-employee', validFrom: '2026-10-01', validTo: '2026-10-31', payrollMode: 'hourly', hourlyRateCents: 1, shareBasisPoints: null, splitBasis: null, aaTreatment: 'not-applicable', rounding: 'half-even', approvalReference: '', note: '', status: 'draft' });
const rejected = action => assert.throws(action, error => error.status === 422 && error.code === 'EMPLOYEE_PAYROLL_INVALID');
test('profile validator rejects accessor, prototype, symbol, missing and unknown fields without invoking getters', () => {
  let invoked = false; const getter = draft(); Object.defineProperty(getter, 'hourlyRateCents', { get() { invoked = true; return 1; }, enumerable: true }); rejected(() => validateEmployeePayrollPayload(getter)); assert.equal(invoked, false);
  for (const payload of [Object.assign(Object.create({ inherited: true }), draft()), { ...draft(), [Symbol('unexpected')]: 1 }, { ...draft(), unknown: 1 }, Object.fromEntries(Object.entries(draft()).filter(([key]) => key !== 'rounding'))]) rejected(() => validateEmployeePayrollPayload(payload));
});
test('profile validator uses explicit integer cents and basis points with no mixed制度 or missing AA/rounding policy', () => {
  for (const extra of [{ hourlyRateCents: -0 }, { hourlyRateCents: NaN }, { hourlyRateCents: Infinity }, { hourlyRateCents: 1.1 }, { hourlyRateCents: 1000000001 }, { hourlyRateCents: null }, { aaTreatment: '' }, { splitBasis: 'approved-service-snapshot' }, { shareBasisPoints: 1 }, { rounding: 'ceil' }, { validFrom: '0000-10-01' }, { validFrom: '2026-02-30' }]) rejected(() => validateEmployeePayrollPayload({ ...draft(), ...extra }));
  const split = { ...draft(), payrollMode: 'split', hourlyRateCents: null, shareBasisPoints: 1, splitBasis: 'collected-receipts', aaTreatment: 'exclude' }; assert.deepEqual(validateEmployeePayrollPayload(split), split);
  for (const extra of [{ shareBasisPoints: 0 }, { shareBasisPoints: 10001 }, { shareBasisPoints: 1.5 }, { aaTreatment: 'not-applicable' }, { splitBasis: null }, { hourlyRateCents: 1 }]) rejected(() => validateEmployeePayrollPayload({ ...split, ...extra }));
});
test('profile validator accepts only explicit CAS and approved reference; draft does not invent reference', () => {
  const original = draft(); assert.equal(validateEmployeePayrollPayload(original), original); assert.equal(original.approvalReference, '');
  for (const approvalReference of ['', ' ', 'SYN\nREFERENCE', ' SYN', 'SYN\0REFERENCE']) rejected(() => validateEmployeePayrollPayload({ ...draft(), status: 'approved', approvalReference }));
  for (const version of [0, -0, 1.2, NaN, Number.MAX_SAFE_INTEGER + 1]) rejected(() => validateEmployeePayrollPayload({ ...draft(), version }, true));
  assert.equal(validateEmployeePayrollPayload({ ...draft(), version: 1 }, true).version, 1);
});
test('query validator rejects duplicate, unknown, wrong month, newline and overflowing pagination', () => {
  for (const query of ['employeeId=synthetic&month=2026-10&month=2026-10', 'employeeId=synthetic&month=2026-13', 'employeeId=synthetic&month=2026-10%0A', 'employeeId=synthetic&month=2026-10&orgId=secret', 'employeeId=synthetic&month=2026-10&page=01', 'employeeId=synthetic&month=2026-10&page=1%0A', 'employeeId=synthetic&month=2026-10&pageSize=101', 'employeeId=synthetic&month=2026-10&page=9007199254740991&pageSize=100']) rejected(() => employeePayrollQuery(new URLSearchParams(query), 'candidates'));
  assert.deepEqual(employeePayrollQuery(new URLSearchParams('employeeId=synthetic&month=2026-10'), 'candidates'), { employeeId: 'synthetic', month: '2026-10', q: '', page: 1, pageSize: 25 });
});
