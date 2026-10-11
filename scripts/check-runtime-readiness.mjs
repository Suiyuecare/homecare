import { parseArgs } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { READINESS_ISSUES } from '../src/server/readiness.mjs';

const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

export function readinessTarget(input, publicOrigin) {
  const url = new URL(input);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.port === '4310' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('READINESS_TARGET_REFUSED');
  let host = url.host;
  if (publicOrigin) {
    const origin = new URL(publicOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('READINESS_TARGET_REFUSED');
    host = origin.host;
  }
  return { url: new URL('/ready', url).href, host };
}

function validReport(body, status) {
  return exact(body, ['ok', 'service', 'checks', 'issues']) && typeof body.ok === 'boolean' && body.service === 'suiyue-home-care' &&
    exact(body.checks, ['database', 'schema', 'storage', 'portal']) && Object.values(body.checks).every(value => ['passed', 'failed', 'not_checked', 'not_required'].includes(value)) &&
    Array.isArray(body.issues) && body.issues.every(value => READINESS_ISSUES.includes(value)) &&
    (status === 200 && body.ok && body.issues.length === 0 && body.checks.database === 'passed' && body.checks.schema === 'passed' && body.checks.portal === 'passed' && ['passed', 'not_required'].includes(body.checks.storage) ||
     status === 503 && !body.ok && body.issues.length > 0);
}

function loopbackFetch(url, options) {
  return new Promise((resolve, reject) => {
    // Native HTTP sends the exact configured Host. The TCP target remains the
    // previously validated loopback URL; no redirects or DNS target are used.
    const request = http.request(url, { method: 'GET', headers: options.headers, agent: false, signal: options.signal }, response => {
      let length = 0; const chunks = [];
      response.on('data', chunk => { length += chunk.length; if (length > 4096) request.destroy(new Error()); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        if (length > 4096) return reject(new Error());
        try { resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })); } catch { reject(new Error()); }
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error()));
    request.on('error', reject); request.end();
  });
}

export async function checkRuntimeReadiness({ url, publicOrigin, fetcher = loopbackFetch } = {}) {
  let target;
  try { target = readinessTarget(url, publicOrigin); } catch { return { exitCode: 2, report: { ok: false, code: 'READINESS_TARGET_REFUSED' } }; }
  try {
    const response = await fetcher(target.url, { method: 'GET', headers: { Host: target.host }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    // Cap untrusted responses before parsing. Never print an unknown body,
    // error message, redirect target, URL, hostname, or environment value.
    if (!response.body) throw new Error();
    const reader = response.body.getReader(); let length = 0, chunks = [];
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 4096) { await reader.cancel(); throw new Error(); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!validReport(body, response.status)) return { exitCode: 2, report: { ok: false, code: 'READINESS_RESPONSE_INVALID' } };
    return { exitCode: body.ok ? 0 : 1, report: body };
  } catch { return { exitCode: 2, report: { ok: false, code: 'READINESS_PROBE_UNAVAILABLE' } }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let values;
  try { ({ values } = parseArgs({ options: { url: { type: 'string' }, 'public-origin': { type: 'string' } }, strict: true, allowPositionals: false })); }
  catch { console.log(JSON.stringify({ ok: false, code: 'READINESS_ARGUMENTS_INVALID' })); process.exitCode = 2; }
  if (values) {
    const result = await checkRuntimeReadiness({ url: values.url, publicOrigin: values['public-origin'] });
    console.log(JSON.stringify(result.report)); process.exitCode = result.exitCode;
  }
}
