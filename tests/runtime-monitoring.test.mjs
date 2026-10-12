import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { monitoringConfiguration, monitorRuntimeReadiness, parseMonitoringArguments } from '../scripts/monitor-runtime-readiness.mjs';

const url = 'http://127.0.0.1:8080', publicOrigin = 'https://monitor.example.test';
const readyReport = () => ({ ok: true, service: 'suiyue-home-care', checks: { database: 'passed', schema: 'passed', storage: 'passed', portal: 'passed' }, issues: [] });
const unreadyReport = () => ({ ok: false, service: 'suiyue-home-care', checks: { database: 'passed', schema: 'passed', storage: 'failed', portal: 'passed' }, issues: ['STORAGE_UNAVAILABLE'] });
const ready = () => ({ exitCode: 0, report: readyReport() });
const marker = 'private-monitor-marker@example.test /private/synthetic-path signed-secret-marker';
const script = fileURLToPath(new URL('../scripts/monitor-runtime-readiness.mjs', import.meta.url));

async function server(handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  const port = instance.address().port; assert.notEqual(port, 4310);
  return { url: `http://127.0.0.1:${port}`, async close() {
    instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve));
  } };
}
async function child(args, onLine = () => {}) {
  const process = spawn(globalThis.process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], { env: { ...globalThis.process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', pending = '';
  process.stdout.on('data', chunk => {
    stdout += chunk; pending += chunk;
    for (;;) { const end = pending.indexOf('\n'); if (end < 0) break; const line = pending.slice(0, end); pending = pending.slice(end + 1); if (line) onLine(JSON.parse(line), process); }
  });
  process.stderr.on('data', chunk => { stderr += chunk; });
  const timeout = setTimeout(() => process.kill('SIGKILL'), 12000);
  try {
    const { code, signal } = await new Promise((resolve, reject) => { process.on('error', reject); process.on('close', (code, signal) => resolve({ code, signal })); });
    return { code, signal, stdout, stderr, lines: stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
  } finally { clearTimeout(timeout); }
}

test('monitoring is finite by default and accepts only bounded explicit counts and intervals', () => {
  assert.deepEqual(monitoringConfiguration({ url }), { url, publicOrigin: undefined, count: 1, intervalMs: 30000 });
  assert.equal(monitoringConfiguration({ url, count: 60, intervalMs: 60000 }).count, 60);
  for (const count of [0, -1, 61, 1.5, NaN, Infinity, '1', null]) assert.throws(() => monitoringConfiguration({ url, count }));
  for (const intervalMs of [0, 999, 60001, 1000.1, NaN, Infinity, '1000', null]) assert.throws(() => monitoringConfiguration({ url, intervalMs }));
});

test('invalid target or configuration never calls a probe or waits and never echoes its inputs', async () => {
  const forbidden = ['https://monitor.example.test', 'http://localhost:8080', 'http://127.0.0.1:4310', 'http://127.0.0.1',
    'http://user:private-marker@127.0.0.1:8080', 'http://127.0.0.1:8080/ready', 'http://127.0.0.1:8080/?secret=1', 'http://127.0.0.1:8080/#secret'];
  for (const configuration of [...forbidden.map(url => ({ url })), { url, count: 0 }, { url, intervalMs: 999 },
    { url, publicOrigin: 'http://monitor.example.test' }, { url, publicOrigin: 'https://user:secret@monitor.example.test' }, { url, publicOrigin: 'https://monitor.example.test/path' }]) {
    let calls = 0;
    const result = await monitorRuntimeReadiness(configuration, { probe: () => { calls++; }, wait: () => { calls++; } });
    assert.equal(calls, 0); assert.equal(result.exitCode, 2); assert.equal(result.summary.code, 'MONITOR_CONFIGURATION_INVALID');
    assert.equal(result.summary.samples, 0); assert(!JSON.stringify(result).includes('example.test')); assert(!JSON.stringify(result).includes('secret'));
  }
});

test('CLI parsing refuses unknown arguments, malformed numbers and unbounded watch', () => {
  assert.deepEqual(parseMonitoringArguments(['--url', url]), monitoringConfiguration({ url }));
  for (const args of [['--url', url, '--count', '01'], ['--url', url, '--count', '1e1'], ['--url', url, '--count', '0'],
    ['--url', url, '--interval-ms', '1.0'], ['--url', url, '--interval-ms', '999'], ['--url', url, '--watch'], ['--url', url, 'position'], []]) assert.throws(() => parseMonitoringArguments(args));
});

test('sequential ready samples preserve fixed contract and do not overlap or wait after the final sample', async () => {
  let active = false, calls = 0; const samples = [], waits = [];
  const result = await monitorRuntimeReadiness({ url, publicOrigin, count: 3, intervalMs: 1000 }, {
    probe: async input => { assert.equal(active, false); active = true; assert.deepEqual(input, { url, publicOrigin }); calls++; await Promise.resolve(); active = false; return ready(); },
    wait: async ms => { assert.equal(active, false); waits.push(ms); }, onSample: sample => samples.push(sample),
  });
  assert.equal(calls, 3); assert.deepEqual(waits, [1000, 1000]); assert.deepEqual(samples.map(sample => sample.sequence), [1, 2, 3]);
  assert.deepEqual(Object.keys(samples[0]), ['schemaVersion', 'service', 'kind', 'sequence', 'status', 'code', 'checks', 'issues']);
  assert.deepEqual(result, { exitCode: 0, summary: { schemaVersion: 1, service: 'suiyue-home-care', kind: 'summary', status: 'ready', code: 'MONITOR_READY', samples: 3, ready: 3, notReady: 0, unavailable: 0 } });
  assert(!JSON.stringify(samples).includes(publicOrigin)); assert(!JSON.stringify(result).includes(url));
});

test('recovery never erases an earlier confirmed unready sample', async () => {
  let index = 0; const samples = [];
  const result = await monitorRuntimeReadiness({ url, count: 3, intervalMs: 1000 }, {
    probe: () => index++ === 1 ? { exitCode: 1, report: unreadyReport() } : ready(), wait: async () => {}, onSample: sample => samples.push(sample),
  });
  assert.deepEqual(samples.map(sample => sample.status), ['ready', 'not_ready', 'ready']);
  assert.equal(result.exitCode, 1); assert.equal(result.summary.notReady, 1); assert.equal(result.summary.code, 'MONITOR_NOT_READY');
});

test('unavailable takes precedence over unready and retains exact completed counts', async () => {
  let index = 0;
  const outcomes = [{ exitCode: 1, report: unreadyReport() }, { exitCode: 2, report: { ok: false, code: 'READINESS_PROBE_UNAVAILABLE' } }, ready()];
  const result = await monitorRuntimeReadiness({ url, count: 3, intervalMs: 1000 }, { probe: () => outcomes[index++], wait: async () => {} });
  assert.equal(result.exitCode, 2); assert.equal(result.summary.samples, 3); assert.equal(result.summary.ready, 1); assert.equal(result.summary.notReady, 1); assert.equal(result.summary.unavailable, 1);
});

test('unknown bodies, codes, properties, throwing getters and exceptions are sanitized', async () => {
  const hostile = Object.defineProperty({}, 'exitCode', { enumerable: true, get() { throw new Error(marker); } });
  const changingChecks = readyReport();
  Object.defineProperty(changingChecks.checks, 'database', { enumerable: true, get() { return marker; } });
  const outcomes = [undefined, { exitCode: 0, report: { ...readyReport(), account: marker } }, { exitCode: 2, report: { ok: false, code: marker } },
    { exitCode: 0, report: { ...readyReport(), issues: [marker] } }, { exitCode: 0, report: unreadyReport() },
    { exitCode: 1, report: readyReport() }, { exitCode: 0, report: { ...readyReport(), checks: { ...readyReport().checks, path: marker } } },
    { exitCode: 0, report: changingChecks }, { exitCode: 1, report: { ...unreadyReport(), issues: Array(1) } }, hostile];
  for (const outcome of outcomes) {
    const samples = []; const result = await monitorRuntimeReadiness({ url }, { probe: () => outcome, onSample: value => samples.push(value) });
    assert.equal(result.exitCode, 2); assert.equal(samples[0].code, 'READINESS_RESPONSE_INVALID'); assert(!JSON.stringify({ result, samples }).includes(marker));
  }
  const samples = [];
  const thrown = await monitorRuntimeReadiness({ url }, { probe: () => { throw new Error(marker); }, onSample: value => samples.push(value) });
  assert.equal(thrown.exitCode, 2); assert.equal(samples[0].code, 'READINESS_PROBE_UNAVAILABLE'); assert(!JSON.stringify({ thrown, samples }).includes(marker));
});

test('output and wait failures emit fixed failures rather than successful summaries', async () => {
  const output = await monitorRuntimeReadiness({ url }, { probe: ready, onSample: () => { throw new Error(marker); } });
  assert.equal(output.exitCode, 2); assert.equal(output.summary.code, 'MONITOR_OUTPUT_UNAVAILABLE'); assert(!JSON.stringify(output).includes(marker));
  let calls = 0;
  const wait = await monitorRuntimeReadiness({ url, count: 2, intervalMs: 1000 }, { probe: () => { calls++; return ready(); }, wait: () => { throw new Error(marker); } });
  assert.equal(calls, 1); assert.equal(wait.exitCode, 2); assert.equal(wait.summary.code, 'MONITOR_WAIT_UNAVAILABLE'); assert(!JSON.stringify(wait).includes(marker));
});

test('pre-abort and abort after the final sample never report completed ready monitoring', async () => {
  for (const reason of ['SIGINT', 'SIGTERM']) {
    const controller = new AbortController(); controller.abort(reason); let calls = 0;
    const result = await monitorRuntimeReadiness({ url, signal: controller.signal }, { probe: () => { calls++; return ready(); } });
    assert.equal(calls, 0); assert.equal(result.exitCode, reason === 'SIGTERM' ? 143 : 130); assert.equal(result.summary.samples, 0);
  }
  const controller = new AbortController();
  const result = await monitorRuntimeReadiness({ url, signal: controller.signal }, { probe: ready, onSample: () => controller.abort('SIGINT') });
  assert.equal(result.exitCode, 130); assert.equal(result.summary.samples, 1); assert.equal(result.summary.status, 'aborted');
});

test('native HTTP uses exact loopback GET and configured Host without credentials or retries', async () => {
  const requests = [];
  const endpoint = await server((req, res) => {
    requests.push({ method: req.method, url: req.url, host: req.headers.host, cookie: req.headers.cookie, authorization: req.headers.authorization });
    const body = requests.length === 2 ? unreadyReport() : readyReport(); res.writeHead(body.ok ? 200 : 503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
  });
  try {
    const result = await monitorRuntimeReadiness({ url: endpoint.url, publicOrigin, count: 3, intervalMs: 1000 }, { wait: async () => {} });
    assert.equal(result.exitCode, 1); assert.equal(requests.length, 3);
    for (const request of requests) assert.deepEqual(request, { method: 'GET', url: '/ready', host: 'monitor.example.test', cookie: undefined, authorization: undefined });
  } finally { await endpoint.close(); }
});

test('native redirect and oversized response are refused without following or echoing raw content', async () => {
  for (const oversized of [false, true]) {
    let requests = 0; const samples = [];
    const endpoint = await server((_req, res) => { requests++; if (oversized) res.end(marker + 'x'.repeat(4097)); else { res.writeHead(302, { Location: 'https://private.example.test/secret' }); res.end(marker); } });
    try {
      const result = await monitorRuntimeReadiness({ url: endpoint.url }, { onSample: sample => samples.push(sample) });
      assert.equal(result.exitCode, 2); assert.equal(requests, 1); assert(!JSON.stringify({ result, samples }).includes(marker)); assert(!JSON.stringify({ result, samples }).includes('private.example.test'));
    } finally { await endpoint.close(); }
  }
});

test('native stalled HTTP is bounded by the existing five-second timeout', { timeout: 10000 }, async () => {
  const endpoint = await server((_req, res) => { res.writeHead(200); res.write('{'); });
  try {
    const start = Date.now(), samples = [];
    const result = await monitorRuntimeReadiness({ url: endpoint.url }, { onSample: value => samples.push(value) });
    assert.equal(result.exitCode, 2); assert.equal(samples[0].code, 'READINESS_PROBE_UNAVAILABLE'); assert(Date.now() - start < 9000);
  } finally { await endpoint.close(); }
});

test('abort cancels the native in-flight request promptly without claiming a completed sample', async () => {
  const controller = new AbortController(); let requests = 0, socketClosed;
  const closed = new Promise(resolve => { socketClosed = resolve; });
  const endpoint = await server((req, res) => { requests++; req.socket.once('close', socketClosed); res.writeHead(200); res.write('{'); setTimeout(() => controller.abort('SIGINT'), 20); });
  try {
    const start = Date.now(); const result = await monitorRuntimeReadiness({ url: endpoint.url, signal: controller.signal });
    assert.equal(result.exitCode, 130); assert.equal(result.summary.samples, 0); assert.equal(requests, 1); assert(Date.now() - start < 1500);
    await closed;
  } finally { await endpoint.close(); }
});

test('abort cancels the actual interval and makes no second request', async () => {
  const controller = new AbortController(); let requests = 0;
  const endpoint = await server((_req, res) => { requests++; res.end(JSON.stringify(readyReport())); });
  try {
    const start = Date.now(); const result = await monitorRuntimeReadiness({ url: endpoint.url, count: 3, intervalMs: 1000, signal: controller.signal },
      { onSample: () => setTimeout(() => controller.abort('SIGTERM'), 20) });
    assert.equal(result.exitCode, 143); assert.equal(result.summary.samples, 1); assert.equal(requests, 1); assert(Date.now() - start < 1000);
  } finally { await endpoint.close(); }
});

test('actual CLI produces only sanitized NDJSON and rejects invalid arguments without a network call', async () => {
  for (const args of [[], ['--url', 'http://user:private-marker@127.0.0.1:8080'], ['--url', url, '--count', '0'], ['--url', url, '--watch']]) {
    const result = await child(args);
    assert.equal(result.code, 2); assert.equal(result.signal, null); assert.equal(result.stderr, ''); assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].code, 'MONITOR_CONFIGURATION_INVALID'); assert(!result.stdout.includes('private-marker')); assert(!result.stdout.includes(url));
  }
  const endpoint = await server((_req, res) => res.end(JSON.stringify(readyReport())));
  try {
    const result = await child(['--url', endpoint.url, '--public-origin', publicOrigin]);
    assert.equal(result.code, 0); assert.equal(result.stderr, ''); assert.equal(result.lines.length, 2); assert.equal(result.lines[0].status, 'ready'); assert.equal(result.lines[1].code, 'MONITOR_READY');
    assert(!result.stdout.includes(endpoint.url)); assert(!result.stdout.includes(publicOrigin));
  } finally { await endpoint.close(); }
});

test('actual CLI handles SIGINT and SIGTERM during the interval and exits with a sanitized aborted summary', async () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    let requests = 0, killed = false;
    const endpoint = await server((_req, res) => { requests++; res.end(JSON.stringify(readyReport())); });
    try {
      const result = await child(['--url', endpoint.url, '--count', '3', '--interval-ms', '1000'], (line, process) => {
        if (line.kind === 'probe' && !killed) { killed = true; process.kill(signal); }
      });
      assert.equal(killed, true); assert.equal(result.signal, null); assert.equal(result.code, signal === 'SIGTERM' ? 143 : 130); assert.equal(result.stderr, ''); assert.equal(requests, 1);
      assert.equal(result.lines.at(-1).code, 'MONITOR_ABORTED'); assert.equal(result.lines.at(-1).samples, 1);
    } finally { await endpoint.close(); }
  }
});
