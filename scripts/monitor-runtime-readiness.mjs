import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { checkRuntimeReadiness, readinessTarget } from './check-runtime-readiness.mjs';
import { READINESS_ISSUES } from '../src/server/readiness.mjs';

const service = 'suiyue-home-care';
const checkNames = ['database', 'schema', 'storage', 'portal'];
const checkStates = ['passed', 'failed', 'not_checked', 'not_required'];
const probeCodes = ['READINESS_TARGET_REFUSED', 'READINESS_RESPONSE_INVALID', 'READINESS_PROBE_UNAVAILABLE'];
const exact = (value, keys) => value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
  });

// The existing target guard runs before this fetcher. It never performs DNS,
// follows a redirect, or adds credentials; its only addition is cancellation.
function abortableFetch(signal) {
  return (url, options) => new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: 'GET', headers: options.headers, agent: false,
      signal: signal ? AbortSignal.any([signal, options.signal]) : options.signal,
    }, response => {
      let length = 0; const chunks = [];
      response.on('data', chunk => {
        length += chunk.length;
        if (length > 4096) request.destroy(new Error());
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (length > 4096) return reject(new Error());
        try { resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })); }
        catch { reject(new Error()); }
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error()));
    request.on('error', reject); request.end();
  });
}

function safeProbe(result) {
  try {
    if (!exact(result, ['exitCode', 'report'])) throw new Error();
    const { exitCode, report } = result;
    if (exitCode === 2 && exact(report, ['ok', 'code']) && report.ok === false && probeCodes.includes(report.code)) {
      return { exitCode: 2, status: 'unavailable', code: report.code, checks: null, issues: [] };
    }
    if (![0, 1].includes(exitCode) || !exact(report, ['ok', 'service', 'checks', 'issues']) || report.service !== service ||
        !exact(report.checks, checkNames) || !Object.values(report.checks).every(value => checkStates.includes(value)) ||
        !Array.isArray(report.issues) || !Array.from({ length: report.issues.length }, (_, index) =>
          Object.hasOwn(report.issues, index) && READINESS_ISSUES.includes(report.issues[index])).every(Boolean)) throw new Error();
    const ready = exitCode === 0 && report.ok === true && report.issues.length === 0 &&
      report.checks.database === 'passed' && report.checks.schema === 'passed' && report.checks.portal === 'passed' && ['passed', 'not_required'].includes(report.checks.storage);
    const unready = exitCode === 1 && report.ok === false && report.issues.length > 0;
    if (!ready && !unready) throw new Error();
    return { exitCode, status: ready ? 'ready' : 'not_ready', code: ready ? 'READY' : 'NOT_READY',
      checks: Object.fromEntries(checkNames.map(key => [key, report.checks[key]])), issues: [...report.issues] };
  } catch { return { exitCode: 2, status: 'unavailable', code: 'READINESS_RESPONSE_INVALID', checks: null, issues: [] }; }
}

export function monitoringConfiguration({ url, publicOrigin, count = 1, intervalMs = 30000 } = {}) {
  readinessTarget(url, publicOrigin);
  if (!Number.isSafeInteger(count) || count < 1 || count > 60 || !Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) throw new Error('MONITOR_CONFIGURATION_INVALID');
  return { url, publicOrigin, count, intervalMs };
}

export async function monitorRuntimeReadiness(options = {}, { probe, wait = (ms, signal) => delay(ms, undefined, { signal }), onSample = () => {} } = {}) {
  let configuration;
  const totals = { samples: 0, ready: 0, notReady: 0, unavailable: 0 };
  const finish = (exitCode, status, code) => ({ exitCode, summary: { schemaVersion: 1, service, kind: 'summary', status, code, ...totals } });
  try { configuration = monitoringConfiguration(options); }
  catch { return finish(2, 'refused', 'MONITOR_CONFIGURATION_INVALID'); }
  const signal = options.signal;
  const aborted = () => finish(signal?.reason === 'SIGTERM' ? 143 : 130, 'aborted', 'MONITOR_ABORTED');
  const runProbe = probe || (input => checkRuntimeReadiness({ ...input, fetcher: abortableFetch(signal) }));
  for (let index = 0; index < configuration.count; index++) {
    if (signal?.aborted) return aborted();
    let result;
    try { result = safeProbe(await runProbe({ url: configuration.url, publicOrigin: configuration.publicOrigin })); }
    catch { result = { exitCode: 2, status: 'unavailable', code: 'READINESS_PROBE_UNAVAILABLE', checks: null, issues: [] }; }
    if (signal?.aborted) return aborted();
    totals.samples++; totals[result.exitCode === 0 ? 'ready' : result.exitCode === 1 ? 'notReady' : 'unavailable']++;
    try { await onSample({ schemaVersion: 1, service, kind: 'probe', sequence: totals.samples,
      status: result.status, code: result.code, checks: result.checks, issues: result.issues }); }
    catch { return finish(2, 'unavailable', 'MONITOR_OUTPUT_UNAVAILABLE'); }
    if (signal?.aborted) return aborted();
    if (index + 1 < configuration.count) {
      try { await wait(configuration.intervalMs, signal); }
      catch { return signal?.aborted ? aborted() : finish(2, 'unavailable', 'MONITOR_WAIT_UNAVAILABLE'); }
    }
  }
  return totals.unavailable ? finish(2, 'unavailable', 'MONITOR_PROBE_UNAVAILABLE') :
    totals.notReady ? finish(1, 'not_ready', 'MONITOR_NOT_READY') : finish(0, 'ready', 'MONITOR_READY');
}

export function parseMonitoringArguments(args) {
  const { values } = parseArgs({ args, options: {
    url: { type: 'string' }, 'public-origin': { type: 'string' },
    count: { type: 'string', default: '1' }, 'interval-ms': { type: 'string', default: '30000' },
  }, strict: true, allowPositionals: false });
  if (![values.count, values['interval-ms']].every(value => /^(0|[1-9]\d*)$/.test(value))) throw new Error('MONITOR_CONFIGURATION_INVALID');
  return monitoringConfiguration({ url: values.url, publicOrigin: values['public-origin'], count: Number(values.count), intervalMs: Number(values['interval-ms']) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const interrupt = () => controller.abort('SIGINT'), terminate = () => controller.abort('SIGTERM');
  let outputFailed = false;
  const outputError = () => { outputFailed = true; controller.abort('OUTPUT_ERROR'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate); process.stdout.on('error', outputError);
  const write = value => new Promise((resolve, reject) => {
    if (outputFailed) return reject(new Error());
    process.stdout.write(JSON.stringify(value) + '\n', error => error ? reject(new Error()) : resolve());
  });
  try {
    let options;
    try { options = parseMonitoringArguments(process.argv.slice(2)); }
    catch { options = {}; }
    const result = await monitorRuntimeReadiness({ ...options, signal: controller.signal }, { onSample: write });
    if (!outputFailed) await write(result.summary);
    process.exitCode = outputFailed ? 2 : result.exitCode;
  } catch { process.exitCode = 2; }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); }
}
