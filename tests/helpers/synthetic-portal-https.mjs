import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PORTAL_ORIGIN } from '../../src/server/portal-handoff.mjs';

// Test-only real TLS gateway. Actual browser Host/Origin are forwarded unchanged.
// The certificate, signing material, envelopes and cookies never enter receipts.
export async function createSyntheticPortalHttpsGateway() {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'suiyue-portal-backup-tls-'));
  await chmod(folder, 0o700);
  let server, backend;
  const handoffRequests = [], errors = [];
  try {
    const keyFile = path.join(folder, 'key.pem'), certFile = path.join(folder, 'cert.pem');
    const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-keyout', keyFile, '-out', certFile], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, 'Only a fresh synthetic loopback certificate is generated');
    await chmod(keyFile, 0o600);
    server = https.createServer({ key: await readFile(keyFile), cert: await readFile(certFile) }, (request, response) => {
      if (request.method === 'POST' && request.url === '/api/auth/handoff') handoffRequests.push({ host: request.headers.host, origin: request.headers.origin, encrypted: request.socket.encrypted === true });
      if (!backend) { response.writeHead(503); response.end(); return; }
      const upstream = http.request(new URL(request.url, backend), { method: request.method, headers: request.headers, agent: false }, result => {
        response.writeHead(result.statusCode, result.headers); result.pipe(response);
      });
      upstream.on('error', error => { errors.push(error.code || 'UPSTREAM_FAILURE'); if (!response.headersSent) response.writeHead(502); response.end(); });
      request.pipe(upstream);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `https://127.0.0.1:${server.address().port}`;
    assert.notEqual(new URL(origin).port, '4310');
    return {
      origin, handoffRequests, errors,
      setBackend(base) {
        const url = new URL(base);
        assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
        assert(url.port && url.port !== '4310'); assert.equal(url.pathname, '/');
        assert(!url.username && !url.password && !url.search && !url.hash);
        backend = url.origin;
      },
      async close() {
        if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        await rm(folder, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(folder, { recursive: true, force: true }); throw error;
  }
}

export async function installSyntheticPortalForm(context, { destinationOrigin, mintHandoff }) {
  const origin = new URL(destinationOrigin);
  assert.equal(origin.protocol, 'https:'); assert.equal(origin.hostname, '127.0.0.1'); assert(origin.port && origin.port !== '4310');
  const visits = [];
  let envelope;
  await context.addCookies([{ name: 'synthetic_portal_login', value: 'active-fixture', url: PORTAL_ORIGIN, secure: true, httpOnly: true, sameSite: 'Lax' }]);
  await context.route(PORTAL_ORIGIN + '/**', async route => {
    assert((route.request().headers().cookie || '').includes('synthetic_portal_login=active-fixture'));
    visits.push(new URL(route.request().url()).pathname);
    envelope = mintHandoff();
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>合成已登入 Portal</title><h1>合成已登入模組入口</h1><form method="post" action="${origin.origin}/api/auth/handoff"><input type="hidden" name="payload" value="${envelope.payload}"><input type="hidden" name="signature" value="${envelope.signature}"><button type="submit">開啟居家照顧模組</button></form></html>` });
  });
  return {
    visits,
    get envelope() { return envelope; },
    async submit(page) {
      await page.goto(PORTAL_ORIGIN + '/portal/');
      await page.getByRole('heading', { name: '合成已登入模組入口', exact: true }).waitFor();
      assert.equal(await page.locator('input[type=password]').count(), 0);
      const waiting = page.waitForResponse(response => response.url() === origin.origin + '/api/auth/handoff' && response.request().method() === 'POST');
      await page.getByRole('button', { name: '開啟居家照顧模組', exact: true }).click();
      const response = await waiting;
      assert.equal(response.status(), 303); assert.equal(response.headers().location, '/#/');
      return response;
    },
    toJSON() { throw new Error('Synthetic Portal envelope is memory-only'); },
  };
}
