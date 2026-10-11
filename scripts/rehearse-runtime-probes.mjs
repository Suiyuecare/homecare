import { randomBytes, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

if (process.argv.length !== 2) {
  console.log(JSON.stringify({ ok: false, code: 'SYNTHETIC_PROBE_ARGUMENTS_REFUSED' })); process.exitCode = 2;
} else {
  let app;
  try {
    const { createApp } = await import('../src/server/index.mjs');
    const { PORTAL_ORIGIN } = await import('../src/server/portal-handoff.mjs');
    app = createApp({ dbPath: ':memory:', port: 0, portalConfig: { mode: 'portal', publicOrigin: 'http://127.0.0.1:0', portalOrigin: PORTAL_ORIGIN, signingSecret: randomBytes(32).toString('hex') }, readinessOptions: { requirePersistent: false } });
    const base = await app.listen(), address = new URL(base);
    if (address.hostname !== '127.0.0.1' || !address.port || address.port === '4310') throw new Error();
    const fingerprint = () => createHash('sha256').update(JSON.stringify({ schema: app.db.prepare('SELECT * FROM sqlite_schema ORDER BY type,name').all(), changes: app.db.prepare('SELECT total_changes() AS changes').get(), counts: app.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, app.db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count]) })).digest('hex');
    const before = fingerprint(), durations = []; let issued = 0;
    const started = performance.now();
    const worker = async () => {
      for (;;) {
        const number = issued++; if (number >= 100) return;
        const tick = performance.now(), response = await fetch(base + (number % 2 ? '/health' : '/ready'), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        const body = await response.json();
        if (response.status !== 200 || body.ok !== true || number % 2 === 0 && body.service !== 'suiyue-home-care') throw new Error();
        durations.push(performance.now() - tick);
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (durations.length !== 100 || fingerprint() !== before) throw new Error();
    const elapsed = performance.now() - started, sorted = [...durations].sort((a, b) => a - b), round = value => Number(value.toFixed(3));
    console.log(JSON.stringify({ ok: true, syntheticOnly: true, workload: 'owned-memory-portal-readiness-and-liveness', requests: 100, concurrency: 4, tableCount: 13, logicalWrites: 0, elapsedMs: round(elapsed), medianMs: round(sorted[49]), p95Ms: round(sorted[94]), maxMs: round(sorted.at(-1)), productionCapacityAccepted: false }));
  } catch { console.log(JSON.stringify({ ok: false, syntheticOnly: true, code: 'SYNTHETIC_PROBE_REHEARSAL_FAILED' })); process.exitCode = 1; }
  finally { if (app) await app.close().catch(() => { process.exitCode = 1; }); }
}
