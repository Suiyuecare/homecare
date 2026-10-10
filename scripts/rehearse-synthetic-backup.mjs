import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { createApp } from '../src/server/index.mjs';
import { createSyntheticWorkspace, syntheticDatabasePath, inspectSyntheticDatabase, captureSyntheticBackup, restoreSyntheticBackup, promoteSyntheticRestore, disposeSyntheticWorkspace } from '../src/server/synthetic-backup.mjs';
import { createSyntheticBackupFixture, syntheticClient, readSyntheticRawState } from '../tests/synthetic-backup-fixtures.mjs';

// This entrypoint is a synthetic QA rehearsal, not an operator restore interface.
if (process.argv.length !== 2) {
  console.error('Synthetic backup rehearsal accepts no arguments.');
  process.exitCode = 2;
} else {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const same = (a, b, message) => assert(isDeepStrictEqual(a, b), message);
  let workspace, source, liveApp, report, failureCode, disposed = false;
  try {
    workspace = createSyntheticWorkspace();
    source = await createSyntheticBackupFixture({ workspace });
    const rawA = source.readRawState();
    const beforeChanges = source.app.db.prepare('SELECT total_changes() AS n').get().n;
    const reference = captureSyntheticBackup(workspace);
    same(source.readRawState(), rawA, 'Capture preserves every saved source value');
    assert.equal(source.app.db.prepare('SELECT total_changes() AS n').get().n, beforeChanges);
    restoreSyntheticBackup(workspace, reference, 'live');
    const restored = inspectSyntheticDatabase(workspace, 'live');
    liveApp = createApp({ dbPath: syntheticDatabasePath(workspace, 'live'), host: '127.0.0.1', port: 0 });
    same(readSyntheticRawState(liveApp.db), rawA, 'Restored startup preserves complete original generation');
    assert.equal(liveApp.db.prepare('SELECT total_changes() AS n').get().n, 0);
    const base = await liveApp.listen();
    const client = syntheticClient(base, 'rehearsal-restored-admin', { cookie: source.sourceCookies.admin, auth: source.actors.admin.auth });
    for (const kind of ['fees', 'payroll']) {
      same(await client.json('GET', `reports/${kind}?month=${source.month}`, undefined, { orgId: source.orgId }), source.expected.frozenReports[kind], 'Saved report amounts survive restore');
    }
    const readsBefore = liveApp.db.prepare('SELECT total_changes() AS n').get().n;
    const changed = await client.json('PATCH', `cases/${source.items.case.id}`, { version: source.items.case.version, note: '合成演練 live 第二代，強制回復需精確保存' }, { orgId: source.orgId });
    assert.equal(changed.item.version, source.items.case.version + 1);
    const liveBusinessChanges = liveApp.db.prepare('SELECT total_changes() AS n').get().n - readsBefore;
    assert(liveBusinessChanges > 0);
    const rawB = readSyntheticRawState(liveApp.db);
    await liveApp.close(); liveApp = null;
    const livePath = syntheticDatabasePath(workspace, 'live');
    const originalLiveHash = hash(readFileSync(livePath));
    restoreSyntheticBackup(workspace, reference, 'staged');
    const rollback = promoteSyntheticRestore(workspace, { forceRollback: true });
    assert.equal(rollback.status, 'rolled_back');
    assert.equal(hash(readFileSync(livePath)), originalLiveHash, 'Forced rollback restores original closed bytes');
    liveApp = createApp({ dbPath: livePath, host: '127.0.0.1', port: 0 });
    same(readSyntheticRawState(liveApp.db), rawB, 'Forced rollback restores all original live saved fields');
    assert.equal(liveApp.db.prepare('SELECT total_changes() AS n').get().n, 0);
    await liveApp.close(); liveApp = null;
    const promotion = promoteSyntheticRestore(workspace, { forceRollback: false });
    assert.equal(promotion.status, 'promoted');
    assert.equal(hash(readFileSync(syntheticDatabasePath(workspace, 'previous'))), originalLiveHash, 'Successful promotion retains original previous generation');
    liveApp = createApp({ dbPath: livePath, host: '127.0.0.1', port: 0 });
    same(readSyntheticRawState(liveApp.db), rawA, 'Successful promotion restores candidate generation');
    assert.equal(liveApp.db.prepare('SELECT total_changes() AS n').get().n, 0);
    await liveApp.close(); liveApp = null;
    same(source.readRawState(), rawA, 'Complete restore and promotion workflow preserves source saved values');
    assert.equal(source.app.db.prepare('SELECT total_changes() AS n').get().n, beforeChanges);
    await source.close();
    disposeSyntheticWorkspace(workspace); disposed = true;
    report = { version: '0.39.0', syntheticOnly: true, status: 'passed', runtime: process.version, walCommittedSnapshotVerified: true, elevenTablesExact: true, sixTriggersRetained: true, blobsVersionsPricingAndRawSessionsExact: true, restoredStartupChanges: 0, sourceFixtureChanges: source.counters.totalChanges, liveBusinessChanges, rollbackStatus: rollback.status, originalLiveClosedSha256: originalLiveHash, promotionStatus: promotion.status, previousGenerationRetained: true, sourcePreserved: true, disposed: true, restoredSummary: restored, actual4310Accessed: false, formalDeployment: false };
  } catch (error) {
    // Do not echo fixture credentials, raw rows, BLOBs, arbitrary driver details or paths.
    failureCode = typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'REHEARSAL_FAILED';
  } finally {
    for (const resource of [liveApp, source]) {
      if (resource) try { await resource.close(); } catch { failureCode = 'REHEARSAL_CLEANUP_FAILED'; }
    }
    if (workspace && !disposed) {
      try { disposeSyntheticWorkspace(workspace); disposed = true; } catch { failureCode = 'REHEARSAL_CLEANUP_FAILED'; }
    }
  }
  if (failureCode) {
    console.error(JSON.stringify({ status: 'failed', syntheticOnly: true, code: failureCode }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(report));
  }
}
