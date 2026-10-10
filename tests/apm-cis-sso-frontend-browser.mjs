import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/server/index.mjs';

// Owned loopback / memory DB. Portal presentation tests explicitly intercept
// local test URLs; they do not contact the company Portal or claim real SSO.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/apm-cis-sso-frontend-qa');
assert(!existsSync(path.join(output, 'e2e.json')), 'Preserve a prior attempt before an explicit fresh run');
const { chromium } = createRequire(import.meta.url)('playwright');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), ...installed.filter(value => /^chromium-/.test(value)).sort().reverse().map(value => path.join(cache, value, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(value => value && existsSync(value));
const files = ['public/app.js', 'public/styles.css', 'public/index.html', 'public/favicon.svg', 'public/suiyue-logo-transparent.png', 'public/ui.js', 'tests/apm-cis-sso-frontend-browser.mjs'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = () => Promise.all(files.map(async file => [file, sha(await readFile(path.join(root, file)))])).then(Object.fromEntries);
const checks = [], screenshots = [], pageErrors = [], statusResponses = [], portalRequests = [], drawerFocusSteps = [];
let server, browser, stage = 'initialization', status = 'failed', failure;
const before = await sources();
await mkdir(output, { recursive: true });
const mark = label => { checks.push(label); console.log('PASS ' + label); };
const observe = page => { page.on('pageerror', error => pageErrors.push(error.message)); page.on('response', response => { if (response.status() >= 400) statusResponses.push({ path: new URL(response.url()).pathname, status: response.status() }); }); };
const noOverflow = async page => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'document horizontal overflow');
const shot = async (page, name) => { const file = path.join(output, name); await noOverflow(page); await page.screenshot({ path: file, fullPage: true }); screenshots.push(name); };
const route = async (page, base, value, title) => { await page.goto(`${base}/#${value}`); await page.getByRole('heading', { name: title, level: 1, exact: true }).waitFor(); assert.equal(await page.locator('#main-content .error-state').count(), 0); };
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const watchdog = setTimeout(() => browser?.close().catch(() => {}), 180000);
try {
  server = createApp({ dbPath: ':memory:', port: 0 }); const base = await server.listen();
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const page = await context.newPage(); observe(page);
  stage = 'local setup'; await page.goto(base);
  await page.getByRole('heading', { name: '建立您的測試工作空間', exact: true }).waitFor();
  assert.equal(await page.locator('input[name=password]').getAttribute('type'), 'password');
  await page.getByLabel('管理者姓名', { exact: false }).fill('合成 CIS 管理者');
  await page.getByLabel('機構名稱', { exact: false }).fill('合成甲機構');
  await page.getByLabel('電子信箱', { exact: false }).fill('synthetic-cis-admin@example.test');
  await page.locator('input[name=password]').fill('synthetic-cis-password');
  await page.getByLabel('載入合成示範資料', { exact: false }).uncheck();
  await shot(page, 'local-setup.png');
  const saved = page.waitForResponse(response => response.url() === `${base}/api/setup` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '建立工作空間', exact: true }).click();
  const setup = await saved; assert.equal(setup.status(), 201); const session = await setup.json();
  await page.getByRole('heading', { name: '今日服務工作台', level: 1, exact: true }).waitFor();
  mark('local setup remains functional and masked; synthetic workspace confirmed by real server');
  const headers = { Origin: base, 'X-CSRF-Token': session.csrfToken, 'X-Org-Id': session.organizations[0].id };
  const post = async (entity, data) => { const response = await context.request.post(`${base}/api/${entity}`, { headers, data }); assert.equal(response.status(), 201, 'synthetic fixture create ' + entity); return (await response.json()).item; };
  stage = 'desktop CIS';
  const dimensions = await page.evaluate(() => ({ sidebar: document.querySelector('#sidebar').getBoundingClientRect().width, header: document.querySelector('.topbar').getBoundingClientRect().height, brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(), background: getComputedStyle(document.body).backgroundColor, heading: getComputedStyle(document.querySelector('h1')).fontFamily, logo: document.querySelector('#sidebar .brand img').complete && document.querySelector('#sidebar .brand img').naturalWidth }));
  assert.equal(dimensions.sidebar, 300); assert.equal(dimensions.header, 82); assert.equal(dimensions.brand, '#EA880C'); assert.equal(dimensions.background, 'rgb(247, 243, 236)'); assert(dimensions.heading.includes('Noto Sans TC')); assert.equal(dimensions.logo, 256);
  assert.equal(sha(await readFile(path.join(root, 'public/suiyue-logo-transparent.png'))), '7003462e156b3c32116fc76f6cb91e3b2eb999530942144a186948d110c97d6d');
  assert.equal(await page.getByRole('link', { name: '工作台', exact: true }).getAttribute('aria-current'), 'page');
  assert.equal(await page.getByLabel('目前機構', { exact: true }).inputValue(), session.organizations[0].id);
  await shot(page, 'desktop-workspace.png'); mark('latest APM logo, tokens, black heading, 300px sidebar and 82px desktop header rendered');
  stage = 'responsive boundaries';
  for (const width of [1180, 1100, 1024]) { await page.setViewportSize({ width, height: 850 }); await settle(page); assert.equal(await page.locator('.topbar').evaluate(node => node.getBoundingClientRect().height), 82); assert(await page.locator('#sidebar').isVisible()); await noOverflow(page); }
  await shot(page, 'laptop-workspace.png');
  await page.setViewportSize({ width: 1023, height: 850 }); await settle(page); assert(await page.locator('#sidebar').isHidden()); assert.equal(await page.locator('.topbar').evaluate(node => node.getBoundingClientRect().height), 64);
  await page.setViewportSize({ width: 390, height: 844 }); await settle(page);
  assert.equal(await page.locator('.mobile-navigation > *').count(), 4);
  await shot(page, 'mobile-workspace.png'); mark('1180 / 1100 / 1024 desktop and 1023 / 390 mobile boundaries preserve content without document overflow');
  stage = 'drawer keyboard'; const menu = page.getByRole('button', { name: '選單', exact: true });
  await menu.click(); const drawer = page.getByRole('dialog', { name: '功能選單', exact: true }); await drawer.locator('#sidebar').waitFor();
  assert.equal(await menu.getAttribute('aria-expanded'), 'true'); assert.equal(await page.getByRole('button', { name: '更多功能', exact: true }).getAttribute('aria-expanded'), 'true');
  assert(await page.locator('#sidebar').isVisible());
  const box = await drawer.boundingBox(); assert(box.width <= 360 && box.x > 0 && box.x + box.width <= 390);
  // A native modal permits browser-chrome focus (activeElement is BODY).
  // Its page-level contract is that background controls remain inert.
  for (let count = 0; count < 24; count++) {
    await page.keyboard.press('Tab');
    const focus = await drawer.evaluate(node => ({ tag: document.activeElement?.tagName, inside: node.contains(document.activeElement), background: !!document.activeElement?.closest('.workspace') }));
    drawerFocusSteps.push({ step: count + 1, ...focus });
    assert(!focus.background && (focus.inside || ['BODY', 'HTML'].includes(focus.tag)), 'native modal prevents keyboard focus on background controls');
  }
  const attemptedBackgroundFocus = await drawer.evaluate(node => { const background = document.querySelector('#organization'); background.focus(); return { inside: node.contains(document.activeElement), backgroundFocused: document.activeElement === background }; });
  drawerFocusSteps.push({ step: 'programmatic organization focus', ...attemptedBackgroundFocus });
  assert(attemptedBackgroundFocus.inside && !attemptedBackgroundFocus.backgroundFocused, 'native modal rejects programmatic background-control focus');
  await shot(page, 'mobile-navigation.png'); await page.keyboard.press('Escape'); await page.locator('dialog.navigation-drawer').waitFor({ state: 'detached' });
  assert(await menu.evaluate(node => node === document.activeElement)); assert(await page.locator('#sidebar').isHidden());
  await page.getByRole('button', { name: '更多功能', exact: true }).click(); await drawer.locator('#sidebar').getByRole('link', { name: '機構公告', exact: true }).click();
  await page.getByRole('heading', { name: '內部公告', level: 1, exact: true }).waitFor(); assert(await page.locator('#sidebar').isHidden()); assert.equal(await menu.getAttribute('aria-expanded'), 'false');
  await menu.click(); await drawer.locator('#sidebar').getByRole('link', { name: '機構公告', exact: true }).click(); await page.locator('dialog.navigation-drawer').waitFor({ state: 'detached' });
  await menu.click(); await page.setViewportSize({ width: 1100, height: 850 }); await page.locator('dialog.navigation-drawer').waitFor({ state: 'detached' }); assert(await page.locator('#sidebar').isVisible()); assert(await page.locator('#main-content').evaluate(node => node === document.activeElement));
  mark('shared openDetails right drawer keeps background controls inert, Escape restores menu, same / different route closes and desktop resize restores main focus');
  stage = 'organization context';
  const other = await post('organizations', { name: '合成乙機構與居家照顧作業長名稱'.repeat(3) });
  const reloadSession = await context.request.get(`${base}/api/session`); assert.equal(reloadSession.status(), 200);
  await page.reload(); await page.getByRole('heading', { name: '內部公告', level: 1, exact: true }).waitFor();
  const selectedRead = page.waitForRequest(request => request.method() === 'GET' && new URL(request.url()).pathname === '/api/announcements' && request.headers()['x-org-id'] === other.id);
  await page.getByLabel('目前機構', { exact: true }).selectOption(other.id); await selectedRead;
  assert.equal(await page.getByLabel('目前機構', { exact: true }).inputValue(), other.id); await noOverflow(page);
  await page.getByLabel('目前機構', { exact: true }).selectOption(session.organizations[0].id); await page.getByRole('heading', { name: '內部公告', level: 1, exact: true }).waitFor();
  mark('native institution picker preserves exact IDs and current X-Org-Id; long institution name does not expand document');
  stage = 'role navigation';
  const employee = await post('employees', { name: '合成 CIS 居服員', employeeNo: 'CIS-EMP', role: 'caregiver' });
  for (const role of ['caregiver', 'finance']) {
    await post('users', { name: `合成 CIS ${role}`, email: `synthetic-cis-${role}@example.test`, password: 'synthetic-cis-password', role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
    const actor = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const response = await actor.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: `synthetic-cis-${role}@example.test`, password: 'synthetic-cis-password' } }); assert.equal(response.status(), 200);
    const actorPage = await actor.newPage(); observe(actorPage); await actorPage.goto(`${base}/#/help`); await actorPage.getByRole('heading', { name: '使用說明', level: 1, exact: true }).waitFor();
    const routes = await actorPage.locator('.mobile-nav-link').evaluateAll(nodes => nodes.map(node => node.dataset.route));
    assert.deepEqual(routes, role === 'caregiver' ? ['/', '/my-services', '/cases'] : ['/', '/reports', '/cases']);
    await actorPage.getByRole('button', { name: '選單', exact: true }).click();
    assert.equal(await actorPage.locator('#sidebar [data-route="/settings"]').count(), 0); assert.equal(await actorPage.locator('#sidebar [data-route="/audit"]').count(), 0);
    assert.equal(await actorPage.locator('#sidebar [data-route="/shifts"]').count(), 0);
    if (role === 'caregiver') assert.equal(await actorPage.locator('#sidebar [data-route="/reports"]').count(), 0);
    await actorPage.keyboard.press('Escape'); await actorPage.goto(`${base}/#/settings`); await actorPage.getByRole('heading', { name: '您沒有這項操作權限', exact: true }).waitFor();
    await shot(actorPage, `mobile-${role}-forbidden.png`); await actor.close();
  }
  mark('real synthetic caregiver / finance sessions retain permitted navigation and forbidden-route recovery');
  stage = 'portal authenticated presentation';
  const portalStatus = { needsSetup: true, initialized: true, authMode: 'portal', portalLoginUrl: `${base}/synthetic-portal-entry`, portalHomeUrl: `${base}/synthetic-portal-home` };
  await page.route(`${base}/api/setup/status`, intercepted => intercepted.fulfill({ status: 200, contentType: 'application/json', json: portalStatus }));
  // Changing only a hash is same-document navigation; reload to boot the intercepted auth mode.
  await page.goto(`${base}/#/cases`); await page.reload(); await page.getByRole('heading', { name: '個案', level: 1, exact: true }).waitFor();
  assert.equal(await page.locator('input[type=password]').count(), 0); assert.equal(await page.locator('.topbar-actions').getByRole('link', { name: '回模組頁', exact: true }).getAttribute('href'), portalStatus.portalHomeUrl);
  mark('portal status with existing session opens requested route directly and exposes company module-home link');
  stage = 'portal redirect'; const unauth = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' }); const loginPage = await unauth.newPage(); observe(loginPage);
  await loginPage.route(`${base}/api/setup/status`, intercepted => intercepted.fulfill({ status: 200, contentType: 'application/json', json: portalStatus }));
  // Capture the actual rendered DOM synchronously before location.replace.
  // This test-only observer avoids locator/evaluate actions during navigation.
  let receivedLoading;
  const renderedLoading = new Promise(resolve => { receivedLoading = resolve; });
  loginPage.on('console', message => {
    const prefix = '__SYNTHETIC_LOADING__';
    if (message.text().startsWith(prefix)) receivedLoading(JSON.parse(message.text().slice(prefix.length)));
  });
  await loginPage.addInitScript(() => {
    const replaceChildren = Element.prototype.replaceChildren;
    Element.prototype.replaceChildren = function (...nodes) {
      const result = replaceChildren.apply(this, nodes);
      const card = this.id === 'app' ? this.querySelector('.auth-loading-card') : null;
      if (card) console.debug('__SYNTHETIC_LOADING__' + JSON.stringify({
        inputs: document.querySelectorAll('input,form').length,
        heading: card.querySelector('h1')?.textContent,
        link: card.querySelector('a')?.getAttribute('href'),
        animation: getComputedStyle(card.querySelector('.auth-loading-bar b')).animationName,
        noOverflow: document.documentElement.scrollWidth <= innerWidth,
        logo: card.querySelector('img')?.getAttribute('src')
      }));
      return result;
    };
  });
  let release; const waiting = new Promise(resolve => { release = resolve; });
  await loginPage.route(`${base}/synthetic-portal-entry`, async intercepted => { portalRequests.push(new URL(intercepted.request().url()).pathname); await waiting; await intercepted.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="zh-Hant"><h1>合成公司入口</h1></html>' }); });
  const requestedEntry = loginPage.waitForRequest(`${base}/synthetic-portal-entry`);
  const navigation = loginPage.goto(`${base}/#/cases`).catch(() => {});
  const loading = await renderedLoading;
  await requestedEntry;
  assert.equal(loading.inputs, 0); assert.equal(loading.heading, '正在進入居家照顧作業系統');
  assert.equal(loading.animation, 'none'); assert.equal(loading.link, portalStatus.portalLoginUrl); assert(loading.noOverflow);
  assert.equal(loading.logo, '/suiyue-logo-transparent.png');
  await writeFile(path.join(output, 'portal-loading-dom.json'), JSON.stringify({ syntheticOnly: true, testInitScriptUsed: true, snapshot: loading }, null, 2));
  release(); await navigation; await loginPage.getByRole('heading', { name: '合成公司入口', exact: true }).waitFor();
  assert.deepEqual(portalRequests, ['/synthetic-portal-entry']);
  mark('portal unauthenticated mode ignores local setup, has no second credential form, provides entry link and redirects once; reduced motion honored');
  stage = 'unsafe portal setting'; const invalid = await browser.newContext(); const invalidPage = await invalid.newPage(); observe(invalidPage);
  await invalidPage.route(`${base}/api/setup/status`, intercepted => intercepted.fulfill({ status: 200, contentType: 'application/json', json: { ...portalStatus, portalLoginUrl: 'javascript:void(0)' } }));
  await invalidPage.goto(base); await invalidPage.getByText('公司登入入口設定不合法，請聯絡管理者。', { exact: true }).waitFor(); assert.equal(await invalidPage.locator('input,form').count(), 0);
  mark('unsafe portal target fails closed into shared inline error without exposing local credentials');
  assert.deepEqual(pageErrors, []); assert.deepEqual(await sources(), before); status = 'passed';
} catch (error) { failure = { name: error.name, message: error.message }; console.error(stage + ': ' + error.message); }
finally {
  clearTimeout(watchdog); await browser?.close(); server?.close();
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ status, stage, failure, checks, screenshots, pageErrors, statusResponses, portalRequests, drawerFocusSteps, sourcesBefore: before, sourcesAfter: await sources(), syntheticOnly: true, productionPortalContacted: false }, null, 2));
}
if (status !== 'passed') process.exitCode = 1;
