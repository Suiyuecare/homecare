import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createAnnouncementReadFixture } from './announcement-read-receipts-fixtures.mjs';
import { createSyntheticWorkspace, disposeSyntheticWorkspace } from '../src/server/synthetic-backup.mjs';

// Importing this module opens no database or server. All data below is synthetic.
export const CALENDAR_WEEK_DATES = Object.freeze(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
export const CALENDAR_BOUNDARY_DATES = Object.freeze(['0000-01-01', '0000-01-02', '0000-02-29', '0099-02-28', '0099-12-31', '0100-01-01', '1900-02-28', '2000-02-29', '2100-02-28', '9999-12-27', '9999-12-31']);
const statusLabels = Object.freeze({ scheduled: '已排班', completed: '已完成', cancelled: '已取消' });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const rawDigest = raw => sha(JSON.stringify({ typedSchema: raw.typedSchema, typedTables: raw.typedTables, userVersion: raw.userVersion, applicationId: raw.applicationId }));
const PRIVATE = Symbol.for('nodejs.util.inspect.custom');
const redact = object => Object.defineProperties(object, {
  toJSON: { value() { throw new Error('Synthetic calendar fixture secrets are memory-only'); } },
  [PRIVATE]: { value() { return '[Synthetic calendar fixture: secrets redacted]'; } },
});
const compare = (left, right) => {
  for (const key of ['date', 'startTime', 'caseNo', 'employeeNo', 'shiftId']) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
};

/** Compose unchanged 0.39/0.40 fixtures inside a factory-owned temporary workspace. */
export async function createShiftCalendarFixture({ workspace } = {}) {
  const ownsWorkspace = workspace === undefined;
  const owned = ownsWorkspace ? createSyntheticWorkspace() : workspace;
  let f, closed = false;
  try {
    f = await createAnnouncementReadFixture({ workspace: owned });
    const readSegments = [];
    function recordOwnedMutation(label, work) {
      assert(typeof label === 'string' && label.length > 0, 'Explicit synthetic mutation needs an audit label');
      const before = f.counts();
      const result = work();
      assert(!result || typeof result.then !== 'function', 'Owned SQL fixture mutations are synchronous');
      const after = f.counts();
      assert.equal(after.tableCount, 11); assert.equal(after.triggerCount, 6);
      f.ledger.push({ kind: 'explicit-owned-synthetic-SQL-fixture', label, before, after, changes: after.totalChanges - before.totalChanges });
      return result;
    }
    function importShifts(rows, { label = 'calendar-complete-INSERT-only-imports', orgId = f.orgIds.own } = {}) {
      assert(Array.isArray(rows) && rows.length <= 1001, 'Synthetic row batch is bounded');
      assert([f.orgIds.own, f.orgIds.foreign].includes(orgId), 'Only the two owned fixture organizations are imported');
      return recordOwnedMutation(label, () => {
        const result = [], time = '2026-10-09T00:00:00.000Z';
        f.app.db.exec('BEGIN IMMEDIATE');
        try {
          for (const fields of rows) {
            const { id = randomUUID(), version = 1, ...data } = fields;
            assert(Number.isSafeInteger(version) && version >= 1, 'Synthetic import version is a positive safe integer');
            assert(typeof data.date === 'string' && typeof data.startTime === 'string' && typeof data.endTime === 'string', 'Synthetic dates and times remain literal strings');
            assert(Object.hasOwn(statusLabels, data.status), 'Synthetic status is explicit');
            const item = { ...data, id, orgId, version, createdAt: time, updatedAt: time };
            f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(id, orgId, 'shifts', JSON.stringify(data), version, time, time);
            f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, 'shifts', id, version, JSON.stringify(item), time, 'baseline');
            result.push(item);
          }
          f.app.db.exec('COMMIT');
          return result;
        } catch (error) { f.app.db.exec('ROLLBACK'); throw error; }
      });
    }
    const ownEmployee = f.baseFixture.items.employee, otherEmployee = f.actors.caregiver2.employee;
    const calendarCase = await f.create('cases', { name: '合成行事曆個案 <img src=x onerror=literal>\n完整第二行', caseNo: 'CAL-041' });
    const service = f.baseFixture.items.service;
    const plan = await f.create('care-plans', { caseId: calendarCase.id, validFrom: '0000-01-01', validTo: '9999-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 100 }] });
    const shiftData = (changes = {}) => ({ caseId: calendarCase.id, employeeId: ownEmployee.id, carePlanId: plan.id,
      date: '2026-10-08', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: service.id, quantity: 2 }], status: 'cancelled', note: '合成唯讀班表原文', ...changes });
    const payloads = [];
    for (const [dayIndex, date] of CALENDAR_WEEK_DATES.entries()) for (let n = 0; n < 18; n++) {
      const marker = `CAL-${String(dayIndex * 18 + n + 1).padStart(3, '0')}`;
      const status = ['scheduled', 'completed', 'cancelled'][(n + dayIndex) % 3];
      payloads.push(shiftData({ date, employeeId: n % 3 === 2 ? otherEmployee.id : ownEmployee.id, status,
        startTime: n % 3 === 0 ? `${date}T08:15:00+14:00` : n % 3 === 1 ? `${date}T08:15:00Z` : '08:15',
        endTime: n % 3 === 0 ? `${date}T09:15:00+14:00` : n % 3 === 1 ? `${date}T09:15:00Z` : '09:15',
        note: marker + '\n<script>literal & 完整中文🙂</script>\n' + (n === 0 ? '合成很長交班原文 '.repeat(40) : '  原文尾端  ') }));
    }
    // These synthetic read fixtures may overlap. They do not certify write eligibility,
    // attendance rules or completion by approval; their persisted versions are complete.
    const seededRows = importShifts(payloads, { label: 'calendar-126-literal-read-fixtures-INSERT-only' });
    const boundaryRows = importShifts(CALENDAR_BOUNDARY_DATES.map(date => shiftData({ date, note: 'CAL-BOUNDARY-' + date })), { label: 'calendar-Gregorian-boundary-complete-INSERT-only' });
    const mutableShift = await f.create('shifts', shiftData({ date: '2026-10-12', startTime: '17:00', endTime: '18:00', status: 'scheduled', note: 'CAL-MUTABLE normal API assignment' }));
    const foreignClient = { ...f.clients.admin, org: f.orgIds.foreign };
    const foreignService = await f.create('service-items', { code: 'CAL-F-041', name: '合成乙機構服務', minutes: 60, unitPriceCents: 123 }, foreignClient);
    const foreignCase = f.baseFixture.items.foreignCase, foreignEmployee = f.baseFixture.items.foreignEmployee;
    const foreignPlan = await f.create('care-plans', { caseId: foreignCase.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: foreignService.id, quantity: 10 }] }, foreignClient);
    const foreignShift = await f.create('shifts', { caseId: foreignCase.id, employeeId: foreignEmployee.id, carePlanId: foreignPlan.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00', services: [{ serviceItemId: foreignService.id, quantity: 1 }], status: 'scheduled', note: 'CAL-FOREIGN must never leak' }, foreignClient);
    const receipt = await f.ack(f.announcements.all, f.clients.admin, { key: 'synthetic-calendar-preserved-receipt-041' });
    await f.ack(f.announcements.all, f.clients.caregiver, { key: 'synthetic-calendar-preserved-own-receipt-041' });
    const rows = [f.baseFixture.items.ownShift, f.baseFixture.items.otherShift, ...seededRows, ...boundaryRows, mutableShift];
    const dataset = { weekAnchor: '2026-10-08', monthAnchor: '2026-10-08', emptyAnchor: '2027-03-18',
      rows, seededRows, boundaryRows, mutableShift, foreignShift, foreignClient,
      employees: { own: ownEmployee, other: otherEmployee, foreign: foreignEmployee },
      cases: { calendar: calendarCase, own: f.baseFixture.items.case, other: f.baseFixture.items.otherCase, foreign: foreignCase },
      plans: { calendar: plan, foreign: foreignPlan }, service, receipt, shiftData };
    const cases = new Map([calendarCase, f.baseFixture.items.case, f.baseFixture.items.otherCase].map(item => [item.id, item]));
    const employees = new Map([ownEmployee, otherEmployee, f.baseFixture.items.otherEmployee].map(item => [item.id, item]));
    function golden(filters, role = 'admin') {
      return rows.filter(item => item.date >= filters.startDate && item.date <= filters.endDate
        && (!filters.status || item.status === filters.status)
        && (!filters.caseId || item.caseId === filters.caseId) && (!filters.employeeId || item.employeeId === filters.employeeId)
        && (role !== 'caregiver' || item.employeeId === ownEmployee.id)
        && (role !== 'caregiver2' || item.employeeId === otherEmployee.id)).map(item => {
        const person = employees.get(item.employeeId), caseItem = cases.get(item.caseId);
        return { shiftId: item.id, version: item.version, date: item.date, caseNo: caseItem.caseNo, case: caseItem.name,
          employeeNo: person.employeeNo, employee: person.name, startTime: item.startTime, endTime: item.endTime,
          services: item.services.map(value => service.code + ' ' + service.name + ' × ' + value.quantity).join('；'),
          status: item.status, statusLabel: statusLabels[item.status], note: item.note || '' };
      }).sort(compare);
    }
    const captureRead = () => ({ digest: rawDigest(f.rawState()), counts: f.counts() });
    function assertReadUnchanged(before, label) {
      const after = captureRead();
      assert(isDeepStrictEqual(after, before), 'Full typed state and all counters must remain unchanged during ' + label);
      readSegments.push({ label, before, after, allTypedStateUnchanged: true });
      return after;
    }
    assert.equal(f.counts().totalChanges, f.ledger.reduce((sum, entry) => sum + entry.changes, 0), 'Every synthetic setup, import and login write is separately accounted');
    assert.equal(f.counts().tableCount, 11); assert.equal(f.counts().triggerCount, 6);
    return redact({ ...f, workspace: owned, ownsWorkspace, dataset, golden, importShifts, recordOwnedMutation, captureRead, assertReadUnchanged, readSegments,
      async close() { if (closed) return; closed = true; await f.close(); if (ownsWorkspace) disposeSyntheticWorkspace(owned); } });
  } catch (error) {
    if (f) await f.close();
    if (ownsWorkspace) disposeSyntheticWorkspace(owned);
    throw error;
  }
}
