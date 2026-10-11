import test from 'node:test';
import assert from 'node:assert/strict';
import { seriesMoveFixture } from './helpers/shift-series-move-fixture.mjs';
import { get, business, validate, replace, saveVersion, id } from '../src/server/model.mjs';
import { previewShiftSeriesAdjustment, commitShiftSeriesAdjustment, readShiftSeriesOccurrences, excludeShiftSeriesMoveOldPosition, preflightShiftSeriesAdjustmentReplay, SHIFT_SERIES_OCCURRENCE_ENTITY, shiftSeriesOccurrenceId } from '../src/server/shift-series.mjs';

const errorCode = code => error => error.code === code;
test('memory preflight excludes only exact selected old positions, leaves all rows/history/audit/idem unchanged, and generic edit stays locked', async t => {
  const f = await seriesMoveFixture(t, { roles: false }); await f.generate(); const occurrences = await f.occurrences(), body = f.payload(occurrences.items), before = f.state();
  const prepared = previewShiftSeriesAdjustment(f.app.db, f.ctx, f.series.id, body); assert.equal(prepared.preview.canCommit, true); assert.equal(prepared.preview.readyCount, 3); assert.deepEqual(f.state(), before);
  const old = occurrences.items[0].shift, data = { ...business(old), date: '2026-10-06' };
  assert.equal(excludeShiftSeriesMoveOldPosition(f.app.db, { ...f.ctx, move: true, selectedIds: body.items }, old, data, occurrences.items[1].shift), false);
  assert.throws(() => validate(f.app.db, f.ctx, 'shifts', data, old), errorCode('SERIES_SHIFT_IMMUTABLE'));
  assert.throws(() => commitShiftSeriesAdjustment(f.app.db, f.ctx, f.series.id, body), errorCode('SERIES_TRANSACTION_REQUIRED')); assert.deepEqual(f.state(), before);
});
test('move saves preserved raw services/note exactly; origin link SQLversion1 stays immutable and generation never refills original slots', async t => {
  const f = await seriesMoveFixture(t, { roles: false }), originals = await f.generate(), body = f.payload((await f.occurrences()).items), links = f.state().records.filter(row => row.entity === SHIFT_SERIES_OCCURRENCE_ENTITY);
  const saved = f.tx(() => commitShiftSeriesAdjustment(f.app.db, f.ctx, f.series.id, body)); assert.equal(saved.result.total, 3);
  saved.result.items.forEach((item, index) => { assert.equal(item.id, originals[index].id); assert.equal(item.version, 2); assert.equal(item.date, ['2026-10-06', '2026-10-07', '2026-10-08'][index]); assert.deepEqual(business(item), { ...business(originals[index]), date: item.date }); });
  assert.deepEqual(f.state().records.filter(row => row.entity === SHIFT_SERIES_OCCURRENCE_ENTITY), links); assert.deepEqual(get(f.app.db, f.admin.org, 'shift-series', f.series.id), f.series);
  const trace = readShiftSeriesOccurrences(f.app.db, f.ctx, f.series.id, f.range); assert.deepEqual(trace.items.map(item => [item.date, item.shift.date, item.movedDate]), [['2026-10-05', '2026-10-06', '2026-10-06'], ['2026-10-06', '2026-10-07', '2026-10-07'], ['2026-10-07', '2026-10-08', '2026-10-08']]);
  const before = f.state(); preflightShiftSeriesAdjustmentReplay(f.app.db, f.ctx, f.series.id, body); assert.deepEqual(f.state(), before);
  const again = await f.generate(); assert.equal(again.length, 3); assert.deepEqual(again, saved.result.items);
});
test('critical bad JSON/null/metadata injection/unsafe SQL version/current head date mismatch always closes preflight without repairs', async t => {
  const f = await seriesMoveFixture(t, { roles: false }), shifts = await f.generate(), body = f.payload((await f.occurrences()).items), raw = f.app.db.prepare('SELECT * FROM records WHERE id=?').get(shifts[0].id);
  for (const change of [{ data: '{' }, { data: 'null' }, { data: JSON.stringify({ ...business(shifts[0]), id: 'injected' }) }, { version: 9007199254740993n }, { data: JSON.stringify({ ...business(shifts[0]), date: '2026-10-09' }) }]) {
    f.app.db.prepare('UPDATE records SET data=?,version=? WHERE id=?').run(change.data ?? raw.data, change.version ?? raw.version, raw.id); const before = f.state();
    assert.throws(() => previewShiftSeriesAdjustment(f.app.db, f.ctx, f.series.id, body), errorCode('BROKEN_OCCURRENCE')); assert.deepEqual(f.state(), before);
    f.app.db.prepare('UPDATE records SET data=?,version=? WHERE id=?').run(raw.data, raw.version, raw.id);
  }
  const employee = f.app.db.prepare('SELECT data FROM records WHERE id=?').get(f.secondEmployee.id); f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run('{', f.secondEmployee.id); const before = f.state();
  assert.throws(() => previewShiftSeriesAdjustment(f.app.db, f.ctx, f.series.id, body), errorCode('BROKEN_OCCURRENCE')); assert.deepEqual(f.state(), before); f.app.db.prepare('UPDATE records SET data=? WHERE id=?').run(employee.data, f.secondEmployee.id);
});
test('safe current head cannot substitute for a missing, malformed or mismatched immutable origin version1', async t => {
  const f = await seriesMoveFixture(t, { roles: false }), shiftId = id(), date = '2026-10-05', stamp = '2026-10-01T00:00:00.000Z';
  const data = { caseId: f.caseItem.id, employeeId: f.employee.id, carePlanId: f.plan.id, date, startTime: '09:00', endTime: '10:00', services: f.services, status: 'scheduled', note: f.series.note };
  const current = { ...data, id: shiftId, orgId: f.admin.org, version: 2, createdAt: stamp, updatedAt: stamp };
  f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(shiftId, f.admin.org, 'shifts', JSON.stringify(data), 2, stamp, stamp); saveVersion(f.app.db, current);
  const linkData = { seriesId: f.series.id, date, shiftId, seriesVersion: 1, seriesSnapshot: f.series }, linkId = shiftSeriesOccurrenceId(f.admin.org, f.series.id, date), link = { ...linkData, id: linkId, orgId: f.admin.org, version: 1, createdAt: stamp, updatedAt: stamp };
  f.app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(linkId, f.admin.org, SHIFT_SERIES_OCCURRENCE_ENTITY, JSON.stringify(linkData), 1, stamp, stamp); saveVersion(f.app.db, link, 'create');
  const before = f.state(); assert.throws(() => readShiftSeriesOccurrences(f.app.db, f.ctx, f.series.id, f.range), errorCode('BROKEN_OCCURRENCE')); assert.deepEqual(f.state(), before);
  f.app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(f.admin.org, 'shifts', shiftId, 1, JSON.stringify({ ...current, version: 1, date: '2026-10-04' }), stamp, 'create');
  const mismatch = f.state(); assert.throws(() => readShiftSeriesOccurrences(f.app.db, f.ctx, f.series.id, f.range), errorCode('BROKEN_OCCURRENCE')); assert.deepEqual(f.state(), mismatch);
});
test('preflight catches selected final-target collisions even if an imported current head is internally consistent', async t => {
  const f = await seriesMoveFixture(t, { roles: false }), originals = await f.generate();
  // Simulate a malformed legacy import without disabling history triggers.
  replace(f.app.db, f.admin.org, 'shifts', originals[1], { ...business(originals[1]), date: originals[0].date });
  const body = f.payload((await f.occurrences()).items), before = f.state(), prepared = previewShiftSeriesAdjustment(f.app.db, f.ctx, f.series.id, body);
  assert.equal(prepared.preview.canCommit, false); assert.ok(prepared.preview.items.slice(0, 2).every(row => row.conflicts.some(problem => problem.code === 'BATCH_SHIFT_CONFLICT'))); assert.deepEqual(f.state(), before);
  assert.throws(() => f.tx(() => commitShiftSeriesAdjustment(f.app.db, f.ctx, f.series.id, body)), errorCode('BATCH_CONFLICT')); assert.deepEqual(f.state(), before);
});
test('second-save audit failure rolls back every shift/version/audit; scope closes after failure and retry is complete', async t => {
  const f = await seriesMoveFixture(t, { roles: false }), shifts = await f.generate(), body = f.payload((await f.occurrences()).items), before = f.state();
  f.app.db.exec(`CREATE TEMP TRIGGER fail_second_move_audit BEFORE INSERT ON audit WHEN NEW.record_id='${shifts[1].id}' AND json_extract(NEW.detail,'$.action')='move' BEGIN SELECT RAISE(ABORT,'synthetic second move audit failure'); END;`);
  assert.throws(() => f.tx(() => commitShiftSeriesAdjustment(f.app.db, f.ctx, f.series.id, body)), /synthetic second move audit failure/); assert.deepEqual(f.state(), before);
  assert.equal(excludeShiftSeriesMoveOldPosition(f.app.db, f.ctx, shifts[0], business(shifts[0]), shifts[1]), false);
  f.app.db.exec('DROP TRIGGER fail_second_move_audit'); assert.equal(f.tx(() => commitShiftSeriesAdjustment(f.app.db, f.ctx, f.series.id, body)).result.total, 3);
});
test('ISO source stays literal with actionable conflict; explicit same-day reschedule enables subsequent move', async t => {
  const f = await seriesMoveFixture(t, { roles: false }), shifts = await f.generate(); await f.patch('shifts', shifts[0], { startTime: '2026-10-05T09:00:33+08:00', endTime: '2026-10-05T10:00:59+08:00' });
  const body = f.payload((await f.occurrences()).items), before = f.state(), prepared = previewShiftSeriesAdjustment(f.app.db, f.ctx, f.series.id, body);
  assert.equal(prepared.preview.canCommit, false); assert.equal(prepared.preview.items[0].conflicts[0].code, 'MOVE_CLOCK_REPLACEMENT_REQUIRED'); assert.deepEqual(f.state(), before);
  const reschedule = { ...body, action: 'reschedule', startTime: '11:00', endTime: '12:00' }; delete reschedule.daysOffset;
  f.tx(() => commitShiftSeriesAdjustment(f.app.db, f.ctx, f.series.id, reschedule)); const fresh = f.payload((await f.occurrences()).items); assert.equal(f.tx(() => commitShiftSeriesAdjustment(f.app.db, f.ctx, f.series.id, fresh)).result.total, 3);
});
test('closed syntax rejects accessors without execution and all noninteger/zero/unknown/CRLF selections', async t => {
  const f = await seriesMoveFixture(t, { roles: false }); await f.generate(); const body = f.payload((await f.occurrences()).items), before = f.state(); let getters = 0;
  const unsafe = { ...body }; Object.defineProperty(unsafe, 'daysOffset', { enumerable: true, get() { getters++; return 1; } }); assert.throws(() => previewShiftSeriesAdjustment(f.app.db, f.ctx, f.series.id, unsafe)); assert.equal(getters, 0);
  for (const altered of [{ ...body, daysOffset: '1' }, { ...body, daysOffset: 0 }, { ...body, daysOffset: 1.5 }, { ...body, employeeId: f.secondEmployee.id }, { ...body, skipConflict: true }, { ...body, items: [{ ...body.items[0], id: body.items[0].id + '\n' }, ...body.items.slice(1)] }]) assert.throws(() => previewShiftSeriesAdjustment(f.app.db, f.ctx, f.series.id, altered));
  assert.deepEqual(f.state(), before);
});
