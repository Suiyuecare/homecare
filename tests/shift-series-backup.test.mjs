import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/server/index.mjs';
import { createSyntheticWorkspace, syntheticDatabasePath, captureSyntheticBackup, restoreSyntheticBackup, inspectSyntheticDatabase, promoteSyntheticRestore, disposeSyntheticWorkspace } from '../src/server/synthetic-backup.mjs';
import { readSyntheticRawState, syntheticClient } from './synthetic-backup-fixtures.mjs';

// Only the branded synthetic workspace can yield a disk path. No real database,
// caller-supplied path, credentials or fixed application port is accepted.
test('eleven-table backup/restore and rollback retain every internal series link, frozen snapshot, immutable version, actor and idempotency response exactly', async () => {
  const workspace = createSyntheticWorkspace(); let source, live;
  try {
    source = createApp({ dbPath: syntheticDatabasePath(workspace, 'source'), port: 0 }); const base = await source.listen(), client = syntheticClient(base, 'synthetic-series-backup');
    const auth = await client.json('POST', 'setup', { name: '合成週期備份管理員', email: 'series-backup@example.test', password: 'synthetic-series-backup-password', organizationName: '合成週期備份機構' }, { status: 201 }); client.bindAuth(auth);
    const orgId = auth.organizations[0].id, options = { orgId }, post = async (entity, data) => (await client.json('POST', entity, data, { ...options, status: 201 })).item;
    const employee = await post('employees', { name: '合成週期備份人員', employeeNo: 'SYNTHETIC-BACKUP-1' }), item = await post('cases', { name: '合成週期備份個案', caseNo: 'SYNTHETIC-BACKUP-C' }), service = await post('service-items', { code: 'SYNTHETIC-BACKUP-S', name: '合成週期備份服務', minutes: 60, unitPriceCents: 10001 }), services = [{ serviceItemId: service.id, quantity: 2 }];
    const plan = await post('care-plans', { caseId: item.id, validFrom: '2026-01-01', validTo: '2027-12-31', status: 'active', services });
    let series = await post('shift-series', { name: '合成永久週期備份', caseId: item.id, carePlanId: plan.id, employeeId: employee.id, startDate: '2026-10-05', intervalWeeks: 2, weekdays: [1, 3, 5], startTime: '09:00', endTime: '10:00', services, note: ' 備份原文\r\n保留邊界 ' });
    const prefix = 'shift-series/' + series.id, range = { version: 1, fromDate: '2026-10-05', toDate: '2026-10-09' }, generationKey = 'synthetic-backup-series-generation';
    const generated = await client.json('POST', prefix + '/generation/commit', range, { ...options, idempotencyKey: generationKey }); assert.equal(generated.createdCount, 3);
    const reschedule = { ...range, action: 'reschedule', items: generated.items.map(row => ({ id: row.occurrence.shiftId, version: 1 })), startTime: '11:00', endTime: '12:00', reason: ' 合成整組調整\r\n備份保留 ' };
    await client.json('POST', prefix + '/adjustments/commit', reschedule, { ...options, idempotencyKey: 'synthetic-backup-series-adjustment' });
    series = (await client.json('PATCH', prefix, { version: 1, name: '合成週期第二版', note: ' 新模板\r\n舊班不變 ' }, options)).item;
    const occurrenceRoute = prefix + '/occurrences?' + new URLSearchParams({ ...range, version: 2 }), occurrences = await client.json('GET', occurrenceRoute, undefined, options);
    assert.ok(occurrences.items.every(row => row.seriesVersion === 1 && row.shift.version === 2 && row.shift.note === generated.items[0].occurrence.shift.note));
    const before = readSyntheticRawState(source.db), changes = source.db.prepare('SELECT total_changes() n').get().n;
    const links = before.tables.records.filter(row => row.entity === 'shift-series-occurrences'), versions = before.tables.record_versions.filter(row => row.entity === 'shift-series-occurrences');
    assert.equal(links.length, 3); assert.equal(versions.length, 3); assert.equal(before.schema.filter(row => row.type === 'table').length, 11); assert.equal(before.schema.filter(row => row.type === 'trigger').length, 6);
    const reference = captureSyntheticBackup(workspace); assert.deepEqual(readSyntheticRawState(source.db), before); assert.equal(source.db.prepare('SELECT total_changes() n').get().n, changes);
    restoreSyntheticBackup(workspace, reference, 'live'); assert.ok(inspectSyntheticDatabase(workspace, 'live'));
    live = createApp({ dbPath: syntheticDatabasePath(workspace, 'live'), port: 0 }); assert.deepEqual(readSyntheticRawState(live.db), before); assert.equal(live.db.prepare('SELECT total_changes() n').get().n, 0);
    let restoredClient = syntheticClient(await live.listen(), 'synthetic-series-restored', { cookie: client.cookie, auth });
    assert.deepEqual(await restoredClient.json('GET', occurrenceRoute, undefined, options), occurrences);
    assert.deepEqual(await restoredClient.json('POST', prefix + '/generation/commit', range, { ...options, idempotencyKey: generationKey }), generated);
    const templateHistory = await restoredClient.json('GET', prefix + '/history?compare=previous', undefined, options); assert.equal(templateHistory.items.length, 2); assert.equal(templateHistory.items[0].actor.id, auth.user.id);
    for (const row of occurrences.items) { const history = await restoredClient.json('GET', 'shifts/' + row.shiftId + '/history?compare=previous', undefined, options); assert.equal(history.items.length, 2); assert.equal(history.items[0].comparison.previousSnapshot.note, generated.items[0].occurrence.shift.note); }
    assert.equal(live.db.prepare('SELECT total_changes() n').get().n, 0, 'Reads and cached pre-edit replay add no writes after restore');
    await restoredClient.json('PATCH', prefix, { version: series.version, status: 'paused' }, options); const liveState = readSyntheticRawState(live.db); await live.close(); live = undefined;
    const digest = bytes => createHash('sha256').update(bytes).digest('hex'), livePath = syntheticDatabasePath(workspace, 'live'), liveHash = digest(readFileSync(livePath));
    restoreSyntheticBackup(workspace, reference, 'staged'); assert.equal(promoteSyntheticRestore(workspace, { forceRollback: true }).status, 'rolled_back'); assert.equal(digest(readFileSync(livePath)), liveHash);
    live = createApp({ dbPath: livePath, port: 0 }); assert.deepEqual(readSyntheticRawState(live.db), liveState); assert.equal(live.db.prepare('SELECT total_changes() n').get().n, 0); await live.close(); live = undefined;
    assert.equal(promoteSyntheticRestore(workspace, { forceRollback: false }).status, 'promoted'); assert.equal(digest(readFileSync(syntheticDatabasePath(workspace, 'previous'))), liveHash);
    live = createApp({ dbPath: livePath, port: 0 }); assert.deepEqual(readSyntheticRawState(live.db), before); assert.equal(live.db.prepare('SELECT total_changes() n').get().n, 0);
    assert.deepEqual(readSyntheticRawState(source.db), before); assert.equal(source.db.prepare('SELECT total_changes() n').get().n, changes);
  } finally { await live?.close(); await source?.close(); disposeSyntheticWorkspace(workspace); }
});
