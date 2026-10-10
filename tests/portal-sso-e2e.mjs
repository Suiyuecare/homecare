import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHmac, randomUUID, randomBytes } from 'node:crypto';
import { mkdir, writeFile, readdir, mkdtemp, readFile, chmod, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server/index.mjs';
import { provisionPortalAccount, PORTAL_ORIGIN } from '../src/server/portal-handoff.mjs';

// The external Portal/APM pages below are intercepted synthetic fixtures.
// The HTTPS gateway, form POST, receiver, cookie, SQLite membership, API and
// care UI are real. Only the ephemeral local certificate is self-signed.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/apm-cis-sso-qa/sso-browser');
assert(!existsSync(path.join(output, 'e2e.json')), 'Retain each previous attempt');
await mkdir(output, { recursive: true });
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
].find(candidate => candidate && existsSync(candidate));
const secret = randomBytes(48).toString('base64url');
const identity = { organizationName: '合成 Portal 居家機構', name: '合成 Portal 管理者', email: 'synthetic-portal-owner@example.test', issuer: PORTAL_ORIGIN, googleSubject: '12345678901234567890', authUserId: randomUUID(), role: 'admin' };
const checks = [], screenshots = [], errors = [], portalVisits = [], handoffRequests = [], gatewayErrors = [];
let app, base, backendBase, tlsGateway, tlsFolder, browser, context, page, lastEnvelope;
function envelope() {
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ aud: 'home-care', moduleId: 'home-care', iss: PORTAL_ORIGIN, googleSubject: identity.googleSubject, authUserId: identity.authUserId, email: identity.email, iat, exp: iat + 120, jti: randomUUID() })).toString('base64url');
  return { payload, signature: createHmac('sha256', secret).update(payload).digest('base64url') };
}
const mark = label => { checks.push(label); console.log('PASS ' + label); };
const screenshot = async name => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No document overflow');
  await page.screenshot({ path: path.join(output, name), fullPage: true }); screenshots.push(name);
};
try {
  tlsFolder = await mkdtemp(path.join(os.tmpdir(), 'suiyue-sso-tls-'));
  const keyPath = path.join(tlsFolder, 'key.pem'), certPath = path.join(tlsFolder, 'cert.pem');
  const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-keyout', keyPath, '-out', certPath], { encoding: 'utf8', timeout: 30000 });
  assert.equal(certificate.status, 0, 'Generate only a fresh synthetic local TLS certificate');
  await chmod(keyPath, 0o600);
  tlsGateway = https.createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (request, response) => {
    // Preserve the browser's actual Host and Origin; never inject an approved
    // Origin to bypass receiver validation. The receiver remains HTTP behind TLS.
    if (request.method === 'POST' && request.url === '/api/auth/handoff') handoffRequests.push({ host: request.headers.host, origin: request.headers.origin, encrypted: request.socket.encrypted === true });
    const target = new URL(request.url, backendBase);
    const upstream = http.request(target, { method: request.method, headers: request.headers, agent: false }, result => {
      response.writeHead(result.statusCode, result.headers); result.pipe(response);
    });
    upstream.on('error', error => { gatewayErrors.push(error.code || error.message); if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  await new Promise((resolve, reject) => { tlsGateway.once('error', reject); tlsGateway.listen(0, '127.0.0.1', resolve); });
  base = `https://127.0.0.1:${tlsGateway.address().port}`;
  app = createApp({ dbPath: ':memory:', port: 0, portalConfig: { mode: 'portal', publicOrigin: base, portalOrigin: PORTAL_ORIGIN, signingSecret: secret } });
  provisionPortalAccount(app.db, identity); backendBase = await app.listen();
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true });
  await context.addCookies([{ name: 'synthetic_portal_login', value: 'active-fixture', url: PORTAL_ORIGIN, httpOnly: true, secure: true, sameSite: 'Lax' }]);
  await context.route('https://apm.suiyuecare.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>合成 APM 入口</title><a href="https://login.suiyuecare.com/portal/">回模組頁</a>' }));
  await context.route(PORTAL_ORIGIN + '/**', async route => {
    assert((route.request().headers().cookie || '').includes('synthetic_portal_login=active-fixture'), 'The same Portal browser identity remains present');
    portalVisits.push(new URL(route.request().url()).pathname);
    lastEnvelope = envelope();
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="zh-Hant"><title>合成已登入 Portal</title><h1>合成已登入模組入口</h1><form method="post" action="${base}/api/auth/handoff"><input type="hidden" name="payload" value="${lastEnvelope.payload}"><input type="hidden" name="signature" value="${lastEnvelope.signature}"><button type="submit">開啟居家照顧模組</button></form></html>` });
  });
  page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://apm.suiyuecare.com/tasks');
  await page.getByRole('link', { name: '回模組頁', exact: true }).click();
  assert.equal(await page.locator('input[type=password]').count(), 0);
  const responsePromise = page.waitForResponse(response => response.url() === base + '/api/auth/handoff' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '開啟居家照顧模組' }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 303); assert.equal(response.headers().location, '/#/');
  assert.deepEqual(handoffRequests, [{ host: new URL(base).host, origin: PORTAL_ORIGIN, encrypted: true }]);
  mark('真正 HTTPS 表單與 TLS gateway 保留 Portal Origin／正式 Host 規則，收件端固定 303，不降低 Origin 守門');
  await page.getByRole('heading', { level: 1, name: '今日服務工作台', exact: true }).waitFor();
  assert.equal(page.url(), base + '/#/'); assert.equal(await page.locator('input[type=password]').count(), 0);
  assert(!page.url().includes('payload=') && !page.url().includes('signature=') && !page.url().includes('token='));
  const session = await (await context.request.get(base + '/api/session')).json();
  assert.equal(session.user.email, identity.email); assert.equal(session.user.role, 'admin'); assert.equal(session.organizations.length, 1);
  const cookie = (await context.cookies(base)).find(value => value.name === 'suiyue_session');
  assert(cookie?.httpOnly && cookie.secure && cookie.sameSite === 'Lax');
  mark('同一合成 Portal 身分從 APM 入口 POST 登入；真 receiver、cookie、機構與首頁，無第二次密碼或 URL 憑證');
  await screenshot('desktop-portal-workspace.png');
  await page.reload(); await page.getByRole('heading', { level: 1, name: '今日服務工作台', exact: true }).waitFor();
  assert.equal(portalVisits.length, 1); mark('重新整理沿本模組有效 session，不重新導轉或要求密碼');
  const counts = () => ({ sessions: app.db.prepare('SELECT count(*) n FROM sessions').get().n, nonces: app.db.prepare('SELECT count(*) n FROM portal_handoff_nonces').get().n });
  const before = counts();
  const replay = await context.request.post(base + '/api/auth/handoff', { headers: { Origin: PORTAL_ORIGIN }, form: lastEnvelope });
  assert(replay.status() >= 400); assert.deepEqual(counts(), before);
  assert.equal((await (await context.request.get(base + '/api/session')).json()).user.id, session.user.id);
  mark('已消費憑證重放拒絕，原有效 session 及 nonce 不變');
  await page.goto(base + '/#/settings');
  await page.getByRole('heading', { level: 1, name: '機構與帳號設定', exact: true }).waitFor();
  await page.getByText('公司帳號與機構由統一入口管理者開通。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '新增帳號', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '新增機構', exact: true }).count(), 0);
  mark('公司模式機構設定沿唯讀帳號清單，不提供無綁定密碼帳號或額外機構入口');
  await page.goto(base + '/#/'); await page.getByRole('heading', { level: 1, name: '今日服務工作台', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 }); await screenshot('mobile-portal-workspace.png');
  await page.getByRole('button', { name: '選單', exact: true }).click();
  await page.getByRole('dialog', { name: '功能選單' }).waitFor(); await screenshot('mobile-portal-menu.png');
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert(await page.getByRole('button', { name: '選單', exact: true }).evaluate(node => node === document.activeElement));
  mark('390px 品牌外框、共同選單、Escape 回焦點與無整頁橫捲');
  await page.getByRole('button', { name: '選單', exact: true }).click();
  await page.getByRole('dialog', { name: '功能選單' }).getByRole('link', { name: '回模組頁', exact: true }).click();
  await page.getByRole('heading', { name: '合成已登入模組入口' }).waitFor(); assert.equal(portalVisits.length, 2);
  assert.equal(await page.locator('input[type=password]').count(), 0);
  mark('回模組頁保留同一合成 Portal cookie');
  app.db.prepare('UPDATE portal_identity_bindings SET active=0').run();
  const revoked = await (await context.request.get(base + '/api/session')).json(); assert.equal(revoked.user, null);
  const denied = await context.request.get(base + '/api/dashboard', { headers: { 'X-Org-Id': session.organizations[0].id } }); assert.equal(denied.status(), 401);
  await page.goto(base + '/#/'); await page.getByRole('heading', { name: '合成已登入模組入口' }).waitFor();
  assert.equal(await page.locator('input[type=password]').count(), 0);
  mark('本模組 binding 撤權立即拒絕既有 session，回 Portal 而不退回密碼表單');
  assert.deepEqual(errors, []);
  assert.deepEqual(gatewayErrors, []);
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, checks, screenshots, portalVisits: portalVisits.length, pageErrors: errors, gatewayErrors, tlsGatewayReal: true, ephemeralCertificateSelfSigned: true, originalBrowserOriginPreserved: true, secureCookieVerified: true, syntheticOnly: true, externalPagesIntercepted: true, receiverAndBrowserReal: true, actualPortalOrApmLoginPerformed: false, realAccountUsed: false, productionVerified: false }, null, 2) + '\n', { flag: 'wx' });
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, checks, screenshots, error: { name: error.name, message: error.message }, pageErrors: errors, syntheticOnly: true }, null, 2) + '\n', { flag: 'wx' });
  throw error;
} finally {
  await context?.close(); await browser?.close();
  if (tlsGateway?.listening) { tlsGateway.closeAllConnections(); await new Promise(resolve => tlsGateway.close(resolve)); }
  await app?.close(); if (tlsFolder) await rm(tlsFolder, { recursive: true, force: true });
}
