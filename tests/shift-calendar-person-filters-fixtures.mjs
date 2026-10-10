import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createShiftCalendarFixture } from './shift-calendar-fixtures.mjs';

// Importing this helper performs no I/O. Every factory owns the old fixture's
// synthetic temporary workspace; no default database or fixed port is selected.
export async function createShiftCalendarPersonFiltersFixture({ workspace } = {}) {
  const f = await createShiftCalendarFixture({ workspace });
  try {
    const cases = [], employees = [];
    for (let index = 0; index < 101; index++) {
      cases.push(await f.create('cases', {
        caseNo: 'PF-C-' + String(index).padStart(3, '0'),
        name: index < 2 ? '  同名個案 <script>literal</script>\n🙂  ' : '合成篩選個案 ' + index,
        status: index === 0 ? 'closed' : index === 1 ? 'paused' : 'active',
      }));
      employees.push(await f.create('employees', {
        employeeNo: 'PF-E-' + String(index).padStart(3, '0'),
        name: index < 2 ? '  同名人員 <img>literal</img>\n🙂  ' : '合成篩選人員 ' + index,
        status: index === 0 ? 'inactive' : 'active',
      }));
    }
    function importMasters(entity, values, label = 'person-filter-explicit-complete-master-import') {
      assert(['cases', 'employees'].includes(entity));
      assert(Array.isArray(values) && values.length <= 101);
      return f.recordOwnedMutation(label, () => {
        const result = [], time = '2026-10-09T00:00:00.000Z';
        f.app.db.exec('BEGIN IMMEDIATE');
        try {
          for (const data of values) {
            const item = { ...data, id: randomUUID(), orgId: f.orgIds.own, version: 1, createdAt: time, updatedAt: time };
            f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(item.id, item.orgId, entity, JSON.stringify(data), 1, time, time);
            f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(item.orgId, entity, item.id, 1, JSON.stringify(item), time, 'baseline');
            result.push(item);
          }
          f.app.db.exec('COMMIT'); return result;
        } catch (error) { f.app.db.exec('ROLLBACK'); throw error; }
      });
    }
    const [missingCase, typedCase] = importMasters('cases', [
      { caseNo: 'PF-C-MISSING', status: 'closed' },
      { caseNo: { synthetic: true }, name: { synthetic: true }, status: null },
    ], 'person-filter-missing-and-nontext-case-labels-complete-import');
    const [missingEmployee, typedEmployee] = importMasters('employees', [
      { employeeNo: 'PF-E-MISSING', status: 'inactive' },
      { employeeNo: ['synthetic'], name: 42, status: false },
    ], 'person-filter-missing-and-nontext-employee-labels-complete-import');
    const shiftData = (caseItem, employee, changes = {}) => f.dataset.shiftData({
      caseId: caseItem.id, employeeId: employee.id, status: 'cancelled', ...changes,
    });
    const seededShifts = f.importShifts([
      shiftData(cases[0], employees[0], { note: 'PF-SAME-A', startTime: '10:00', endTime: '11:00' }),
      shiftData(cases[1], employees[1], { note: 'PF-SAME-B', startTime: '10:00', endTime: '11:00' }),
      shiftData(cases[0], employees[1], { note: 'PF-CROSS-PAIR', startTime: '12:00', endTime: '13:00' }),
      shiftData(missingCase, missingEmployee, { note: 'PF-MISSING-LABELS' }),
      shiftData(typedCase, typedEmployee, { note: 'PF-TYPED-LABELS' }),
      shiftData(cases[0], f.dataset.employees.own, { note: 'PF-CAREGIVER-ASSIGNED' }),
    ], { label: 'person-filter-literal-current-ID-oracle-complete-shift-imports' });
    const uniqueCaregiverCase = await f.create('cases', { name: '合成當期外唯一居服個案', caseNo: 'PF-C-OUTSIDE' });
    const uniqueCaregiverPlan = await f.create('care-plans', { caseId: uniqueCaregiverCase.id,
      validFrom: '2028-01-01', validTo: '2028-12-31', status: 'active',
      services: [{ serviceItemId: f.dataset.service.id, quantity: 10 }] });
    const mutableCaregiverShift = await f.create('shifts', shiftData(uniqueCaregiverCase, f.dataset.employees.own, {
      carePlanId: uniqueCaregiverPlan.id, date: '2028-01-10', startTime: '17:00', endTime: '18:00', status: 'scheduled', note: 'PF-OUTSIDE-MUTABLE',
    }));
    const personDataset = { cases, employees, caseA: cases[0], caseB: cases[1], employeeA: employees[0], employeeB: employees[1],
      missingCase, missingEmployee, typedCase, typedEmployee, seededShifts, uniqueCaregiverCase, uniqueCaregiverPlan,
      mutableCaregiverShift, outsidePeriodCaregiverShift: mutableCaregiverShift, shiftData };

    // Independent oracle consumes the fixture's byte-preserving persisted-column
    // tags. It never infers authorization or foreign keys from visible names.
    function expectedShiftIds(filters, role = 'admin') {
      const table = f.rawState().typedTables.records;
      const column = name => table.columns.indexOf(name);
      const text = value => value[0] === 'text-bytes' ? Buffer.from(value[1], 'hex').toString('utf8')
        : value[0] === 'text' ? value[1] : null;
      const employeeId = role === 'caregiver' ? f.dataset.employees.own.id : role === 'caregiver2' ? f.dataset.employees.other.id : null;
      const ids = [];
      for (const row of table.rows) {
        if (text(row[column('org_id')]) !== f.orgIds.own || text(row[column('entity')]) !== 'shifts') continue;
        const saved = JSON.parse(text(row[column('data')]));
        if (saved.date < filters.startDate || saved.date > filters.endDate
          || (filters.caseId && saved.caseId !== filters.caseId) || (filters.employeeId && saved.employeeId !== filters.employeeId)
          || (filters.status && saved.status !== filters.status) || (employeeId && saved.employeeId !== employeeId)) continue;
        ids.push(text(row[column('id')]));
      }
      return ids.sort();
    }
    assert.equal(f.counts().tableCount, 11); assert.equal(f.counts().triggerCount, 6);
    assert.equal(f.counts().totalChanges, f.ledger.reduce((sum, entry) => sum + entry.changes, 0));
    return Object.defineProperties({ ...f, personDataset, importMasters, expectedShiftIds }, {
      toJSON: { value() { throw new Error('Synthetic person-filter fixture secrets are memory-only'); } },
      [Symbol.for('nodejs.util.inspect.custom')]: { value() { return '[Synthetic person-filter fixture: secrets redacted]'; } },
    });
  } catch (error) { await f.close(); throw error; }
}
