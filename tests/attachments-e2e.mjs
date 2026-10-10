import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { id, now, initDb } from '../src/server/model.mjs';

// Synthetic data, actual browser/API and a random port. Never opens the disk database.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/attachments-qa');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(name => /^chromium-/.test(name)).sort().reverse().map(name => path.join(cache, name, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
const app = createApp({ dbPath: ':memory:', port: 0 });
const checks = [], pageErrors = [], consoleErrors = [], failedResponses = [], screenshots = [], contexts = [];
const password = 'synthetic-attachments-password';
let browser, base, lastPage;
const mark = label => { checks.push(label); console.log(`PASS ${label}`); };
const observe = page => {
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status(), expected: [409, 413, 422, 503].includes(response.status()) && /\/api\/case-attachments/.test(response.url()) });
  });
};
const load = async (page, route, heading) => {
  lastPage = page;
  const target = `${base}/#${route}`;
  if (page.url() === target) await page.reload(); else await page.goto(target);
  await page.getByRole('heading', { name: heading, level: 1, exact: true }).waitFor();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('.error-state').count(), 0, `route ${route}`);
};
const inspectLayout = async page => {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No full-page horizontal overflow');
  const unlabelled = await page.locator('input,select,textarea').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.labels?.length && !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby')).map(node => node.name));
  assert.deepEqual(unlabelled, [], 'Visible controls have semantic labels');
  if (await page.getByRole('dialog').count()) {
    const geometry = await page.getByRole('dialog').evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: innerWidth, scroll: node.scrollWidth, client: node.clientWidth }));
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.width, 'Dialog is inside the viewport');
    assert.ok(geometry.scroll <= geometry.client + 1, 'Only nested table regions may scroll horizontally');
    for (const region of await page.getByRole('dialog').locator('.table-scroll').all()) {
      if (!await region.isVisible()) continue;
      const data = await region.evaluate(node => ({ overflow: getComputedStyle(node).overflowX, width: node.clientWidth, scroll: node.scrollWidth }));
      assert.equal(data.overflow, 'auto');
      if (data.scroll > data.width) {
        await region.evaluate(node => { node.scrollLeft = node.scrollWidth; });
        assert.ok(await region.evaluate(node => node.scrollLeft > 0), 'Wide comparison table scrolls within its container');
        await region.evaluate(node => { node.scrollLeft = 0; });
      }
    }
  }
};
const screenshot = async (page, name) => {
  assert.ok(await page.locator('.toast:visible').count() <= 2);
  if (await page.locator('.toast').count()) await page.locator('.toast').last().waitFor({ state: 'detached', timeout: 10000 });
  await page.screenshot({ path: path.join(output, name), fullPage: false }); screenshots.push(name);
};
const section = page => page.getByRole('region', { name: '個案附件', exact: true });
const attachmentCard = (page, name) => section(page).locator('.attachment-card').filter({ hasText: name });
const versionCard = (dialog, version) => dialog.locator('.history-version').filter({ has: dialog.page().getByText(`第 ${version} 版`, { exact: true }) });
const openHistory = async (page, trigger, title, version = 2) => {
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await dialog.getByText(`第 ${version} 版`, { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: /儲存|編輯|刪除|還原/ }).count(), 0, 'History is read-only');
  return dialog;
};
const closeHistory = async (page, trigger) => {
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  if (trigger) assert.ok(await trigger.evaluate(node => node === document.activeElement), 'Escape restores trigger focus');
};
const saveDialog = async page => {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '儲存', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
};
const counts = () => ({
  changes: app.db.prepare('SELECT total_changes() AS n').get().n,
  audit: app.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n,
  records: app.db.prepare('SELECT COUNT(*) AS n FROM records').get().n,
  versions: app.db.prepare('SELECT COUNT(*) AS n FROM record_versions').get().n,
  files: app.db.prepare('SELECT COUNT(*) AS n FROM attachment_files').get().n,
});
await mkdir(output, { recursive: true });

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function pdf(message) {
  const stream = `BT /F1 12 Tf 30 70 Td (${message}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let source = '%PDF-1.4\n', offsets = [0];
  objects.forEach((value, index) => { offsets.push(Buffer.byteLength(source)); source += `${index + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}
const fixtures = {
  first: { name: '合成初版照顧文件.pdf', mimeType: 'application/pdf', buffer: pdf('SYNTHETIC ATTACHMENT VERSION ONE') },
  second: { name: '合成更新照顧文件.pdf', mimeType: 'application/pdf', buffer: pdf('SYNTHETIC ATTACHMENT VERSION TWO') },
  png: { name: '合成圖像.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP48OEDAAWkAtFabOJuAAAAAElFTkSuQmCC', 'base64') },
  jpeg: { name: '合成照片.jpeg', mimeType: 'image/jpeg', buffer: Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3CiiigD//2Q==', 'base64') },
};
const payload = file => ({ fileName: file.name, mimeType: file.mimeType, contentBase64: file.buffer.toString('base64') });
const uploadInput = (page, replace = false) => page.getByRole('dialog').getByLabel(replace ? /^替換檔案/ : /^附件檔案/);
const fillMetadata = async (page, values) => {
  const labels = { title: '附件標題', category: '附件分類', note: '備註' }, dialog = page.getByRole('dialog');
  for (const [key, value] of Object.entries(values)) {
    const field = dialog.getByLabel(labels[key], { exact: false });
    if (key === 'category') await field.selectOption(value); else await field.fill(value);
  }
};
const search = async (page, value) => { const input = section(page).getByLabel('附件搜尋', { exact: true }); await input.fill(value); await input.press('Enter'); };
const abandon = async page => { await page.keyboard.press('Escape'); await page.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true }).getByRole('button', { name: '放棄修改', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' }); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const selectedFile = input => input.evaluate(async node => { const file = node.files[0]; return file ? { name: file.name, size: file.size, sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('') } : null; });
const downloads = [];
async function browserDownload(page, trigger, file, evidenceName) {
  const waiting = page.waitForEvent('download'); await trigger.click(); const download = await waiting;
  const stream = await download.createReadStream(), chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks); assert.equal(await download.failure(), null); assert.deepEqual(bytes, file.buffer); assert.equal(download.suggestedFilename(), file.name);
  downloads.push({ evidence: evidenceName, fileName: download.suggestedFilename(), sizeBytes: bytes.length, sha256: sha256(bytes) });
  await writeFile(path.join(output, evidenceName), bytes);
}

try {
  base = await app.listen(); browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(context);
  const setup = await context.request.post(`${base}/api/setup`, { headers: { Origin: base }, data: { name: '合成附件管理員', email: 'attachments-admin@example.test', password, organizationName: '合成附件測試機構' } });
  assert.equal(setup.status(), 201, await setup.text());
  const admin = await setup.json(), orgId = admin.organizations[0].id;
  const headers = (auth, org = orgId) => ({ Origin: base, 'X-Org-Id': org, 'X-CSRF-Token': auth.csrfToken });
  const request = async (method, route, data, expected = 200, client = context, auth = admin, org = orgId) => {
    const response = await client.request.fetch(`${base}/api/${route}`, { method, headers: headers(auth, org), ...(data === undefined ? {} : { data }) });
    const value = await response.json(); assert.equal(response.status(), expected, `${method} ${route}: ${JSON.stringify(value)}`); return value;
  };
  const post = async (entity, data) => (await request('POST', entity, data, 201)).item;
  const patch = async (entity, item, data) => (await request('PATCH', `${entity}/${item.id}`, { version: item.version, ...data })).item;
  const binary = async (item, version, file, client = context, auth = admin, expected = 200) => {
    const response = await client.request.get(`${base}/api/case-attachments/${item.id}/download${version === undefined ? '' : `?recordVersion=${version}`}`, { headers: headers(auth) });
    assert.equal(response.status(), expected);
    if (expected !== 200) return;
    const bytes = await response.body(); assert.deepEqual(bytes, file.buffer); const h = response.headers();
    assert.equal(h['content-type'], file.mimeType); assert.equal(Number(h['content-length']), bytes.length); assert.equal(h['x-content-type-options'], 'nosniff'); assert.equal(h['cache-control'], 'no-store');
    assert.match(h['content-disposition'], /^attachment;/); assert.ok(h['content-disposition'].includes("filename*=UTF-8''")); assert.ok(h['content-disposition'].includes(encodeURIComponent(file.name)));
  };
  const employee = await post('employees', { name: '合成附件居服員', employeeNo: 'ATTACH-E01', role: 'caregiver' });
  const actors = {};
  for (const role of ['supervisor', 'caregiver', 'finance']) actors[role] = await post('users', { name: `合成附件${role}`, email: `attachments-${role}@example.test`, password, role, ...(role === 'caregiver' ? { employeeId: employee.id } : {}) });
  const loginAs = async role => {
    const client = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); contexts.push(client);
    const response = await client.request.post(`${base}/api/login`, { headers: { Origin: base }, data: { email: `attachments-${role}@example.test`, password } });
    assert.equal(response.status(), 200); const auth = await response.json(), page = await client.newPage(); observe(page); return { client, auth, page };
  };
  const supervisor = await loginAs('supervisor'), caregiver = await loginAs('caregiver'), finance = await loginAs('finance'), page = supervisor.page;
  const caseA = await post('cases', { name: '合成附件個案甲', caseNo: 'ATTACH-C01', primaryCarer: '合成原主要照顧者', contactName: '合成原聯絡人', contactPhone: '合成原電話' });
  const caseB = await post('cases', { name: '合成附件個案乙', caseNo: 'ATTACH-C02', status: 'closed' });
  const historyCase = await post('cases', { name: '合成附件歷史個案', caseNo: 'ATTACH-C03' });
  const oldCase = (await request('GET', `cases/${caseA.id}`)).item, oldCaseHistory = await request('GET', `cases/${caseA.id}/history?compare=previous`);
  const service = await post('service-items', { code: 'ATTACH-TEST', name: '合成附件驗證服務', minutes: 60, unitPriceCents: 10000 });
  for (const [item, startTime, endTime] of [[caseA, '09:00', '10:00'], [historyCase, '11:00', '12:00']]) {
    const plan = await post('care-plans', { caseId: item.id, validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active', services: [{ serviceItemId: service.id, quantity: 2 }] });
    await post('shifts', { caseId: item.id, employeeId: employee.id, carePlanId: plan.id, date: '2026-10-08', startTime, endTime, services: [{ serviceItemId: service.id, quantity: 1 }] });
  }
  const upload = async (caseId, title, file, more = {}) => post('case-attachments/upload', { caseId, title, ...payload(file), ...more });
  const other = await upload(caseB.id, '合成乙案附件', fixtures.png);
  const otherOrg = (await request('POST', 'organizations', { name: '合成另一附件機構' }, 201)).item;
  const foreignCase = (await request('POST', 'cases', { name: '合成跨機構附件個案', caseNo: 'ATTACH-FOREIGN' }, 201, context, admin, otherOrg.id)).item;
  const foreign = (await request('POST', 'case-attachments/upload', { caseId: foreignCase.id, title: '合成跨機構附件', ...payload(fixtures.jpeg) }, 201, context, admin, otherOrg.id)).item;

  const keys = [];
  page.on('request', req => { if (req.method() === 'POST' && /\/api\/case-attachments(?:\/upload|\/[^/]+\/replace-file)$/.test(new URL(req.url()).pathname)) keys.push({ path: new URL(req.url()).pathname, key: req.headers()['idempotency-key'] }); });
  await load(page, `/cases/${caseA.id}`, caseA.name); await section(page).getByText('共 0 筆', { exact: false }).waitFor();
  let trigger = section(page).getByRole('button', { name: '新增附件', exact: true }); await trigger.click();
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' }); assert.ok(await trigger.evaluate(node => node === document.activeElement));
  await trigger.press('Enter'); let dialog = page.getByRole('dialog', { name: '新增附件', exact: true });
  await fillMetadata(page, { title: '合成核心附件', category: 'care', note: '合成附件第一版備註' });
  for (const file of [null, { name: '空檔.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) }, { name: '超大.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 32) }, { name: '未支援.txt', mimeType: 'text/plain', buffer: Buffer.from('SYNTHETIC') }]) {
    await uploadInput(page).setInputFiles(file || []); await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await dialog.locator('[aria-invalid="true"]').waitFor();
    assert.equal(await dialog.getByLabel('附件標題', { exact: false }).inputValue(), '合成核心附件');
  }
  assert.equal((await request('GET', `case-attachments?caseId=${caseA.id}`)).total, 0);
  await uploadInput(page).setInputFiles(fixtures.first); await dialog.getByRole('button', { name: /^移除選檔/ }).click(); assert.equal(await uploadInput(page).evaluate(node => node.files.length), 0);
  await uploadInput(page).setInputFiles({ name: '合成偽檔型.pdf', mimeType: 'application/pdf', buffer: Buffer.from('SYNTHETIC INVALID PDF SIGNATURE') });
  const invalid = page.waitForResponse(response => response.url().endsWith('/api/case-attachments/upload'));
  await dialog.getByRole('button', { name: '儲存', exact: true }).click(); assert.equal((await invalid).status(), 422); await dialog.locator('[aria-invalid="true"]').waitFor();
  assert.equal((await selectedFile(uploadInput(page))).name, '合成偽檔型.pdf');
  await uploadInput(page).setInputFiles(fixtures.first);
  let uploadAttempts = 0;
  await page.route('**/api/case-attachments/upload', async route => {
    uploadAttempts++;
    if (uploadAttempts === 1) { const response = await route.fetch(); assert.equal(response.status(), 201); return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_COMMITTED_RESPONSE_LOST', message: '合成上傳回應中斷，請保留選檔重試' } }) }); }
    return route.continue();
  });
  await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await dialog.getByRole('alert').waitFor();
  assert.deepEqual(await selectedFile(uploadInput(page)), { name: fixtures.first.name, size: fixtures.first.buffer.length, sha256: sha256(fixtures.first.buffer) });
  const committed = (await request('GET', `case-attachments?caseId=${caseA.id}`)).items[0]; const committedCounts = counts();
  await screenshot(page, 'upload-retry-retained-desktop.png'); await saveDialog(page); await page.unroute('**/api/case-attachments/upload');
  let core = (await request('GET', `case-attachments/${committed.id}`)).item;
  assert.equal(core.version, 1); assert.equal(core.sha256, sha256(fixtures.first.buffer)); assert.equal(core.sizeBytes, fixtures.first.buffer.length); assert.deepEqual(counts(), committedCounts);
  assert.equal(keys.length, 3); assert.ok(keys.every(entry => entry.key === keys[0].key && entry.key));
  mark('真PDF File上傳；空檔/超5MiB/副檔名/偽簽章拒絕，移除選檔可用；提交後503同key重試只保存一份且File/metadata保留');

  for (const [title, file] of [['合成PNG附件', fixtures.png], ['合成JPEG附件', fixtures.jpeg]]) {
    await trigger.click(); await fillMetadata(page, { title, category: 'general' }); await uploadInput(page).setInputFiles(file); await saveDialog(page);
    const item = (await request('GET', `case-attachments?caseId=${caseA.id}&q=${encodeURIComponent(title)}`)).items[0];
    assert.equal(item.sha256, sha256(file.buffer)); assert.equal(item.mimeType, file.mimeType);
    await browserDownload(page, attachmentCard(page, title).getByRole('button', { name: '下載目前版本', exact: true }), file, title === '合成PNG附件' ? 'download-synthetic.png' : 'download-synthetic.jpeg');
    await binary(item, undefined, file);
  }
  assert.notEqual(keys[3].key, keys[4].key); assert.notEqual(keys[0].key, keys[3].key);
  await binary(core, undefined, fixtures.first); assert.ok(!Object.hasOwn(core, 'fileId'));
  mark('有效PNG/JPEG真File可上傳及瀏覽器下載，實際bytes/SHA/檔名一致，binary header與內部fileId遮罩正確');

  await attachmentCard(page, core.title).getByRole('button', { name: '編輯資料', exact: true }).click();
  await fillMetadata(page, { title: '合成核心附件第二版', category: 'care', note: '合成描述第二版，未更換檔案。' }); const filesBeforeMetadata = counts().files; await saveDialog(page);
  core = (await request('GET', `case-attachments/${core.id}`)).item; assert.equal(core.version, 2); assert.equal(counts().files, filesBeforeMetadata); assert.equal(core.sha256, sha256(fixtures.first.buffer));
  await attachmentCard(page, core.title).getByRole('button', { name: '更換檔案', exact: true }).click(); await uploadInput(page, true).setInputFiles(fixtures.second);
  let replaceAttempts = 0;
  const replacePattern = `**/api/case-attachments/${core.id}/replace-file`;
  await page.route(replacePattern, async route => {
    replaceAttempts++;
    if (replaceAttempts === 1) { const response = await route.fetch(); assert.equal(response.status(), 200); return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_REPLACE_RESPONSE_LOST', message: '合成替換回應中斷，請保留選檔重試' } }) }); }
    return route.continue();
  });
  dialog = page.getByRole('dialog', { name: '更換檔案', exact: true }); await dialog.getByRole('button', { name: '儲存', exact: true }).click(); await dialog.getByRole('alert').waitFor();
  assert.equal((await selectedFile(uploadInput(page, true))).sha256, sha256(fixtures.second.buffer)); const replacedCounts = counts();
  await saveDialog(page); await page.unroute(replacePattern); assert.deepEqual(counts(), replacedCounts);
  core = (await request('GET', `case-attachments/${core.id}`)).item; assert.equal(core.version, 3); assert.equal(counts().files, filesBeforeMetadata + 1); assert.equal(core.sha256, sha256(fixtures.second.buffer));
  const replacementKeys = keys.filter(entry => entry.path.endsWith('/replace-file')); assert.equal(replacementKeys.length, 2); assert.equal(replacementKeys[0].key, replacementKeys[1].key);
  await binary(core, 1, fixtures.first); await binary(core, 2, fixtures.first); await binary(core, 3, fixtures.second);
  mark('metadata-only沿用同BLOB；更換檔案建立新版，同key重送不重複，v1/v2仍為原bytes、v3為新bytes');

  let beforeCancel = counts(); trigger = attachmentCard(page, core.title).getByRole('button', { name: '停用', exact: true });
  await trigger.click(); dialog = page.getByRole('dialog', { name: '停用附件？', exact: true }); await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'detached' }); assert.deepEqual(counts(), beforeCancel); assert.ok(await trigger.evaluate(node => node === document.activeElement));
  await trigger.click(); await page.getByRole('dialog').getByRole('button', { name: '確認停用', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' });
  core = (await request('GET', `case-attachments/${core.id}`)).item; assert.equal(core.status, 'inactive'); assert.equal(core.version, 4); await binary(core, undefined, fixtures.second);
  await attachmentCard(page, core.title).getByRole('button', { name: '恢復使用', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '確認恢復使用', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' });
  core = (await request('GET', `case-attachments/${core.id}`)).item; assert.equal(core.status, 'active'); assert.equal(core.version, 5);
  await attachmentCard(page, core.title).getByRole('button', { name: '編輯資料', exact: true }).click(); await fillMetadata(page, { title: '合成本機未儲存標題', note: '合成本機未儲存備註' });
  core = await patch('case-attachments', core, { note: '合成管理員已保存備註' }); let durable = counts();
  const metadataConflict = page.waitForResponse(response => response.url().endsWith(`/case-attachments/${core.id}`) && response.request().method() === 'PATCH');
  dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: '儲存', exact: true }).click(); assert.equal((await metadataConflict).status(), 409); await dialog.getByRole('alert').waitFor();
  assert.equal(await dialog.getByLabel('附件標題', { exact: false }).inputValue(), '合成本機未儲存標題'); assert.equal(await dialog.getByLabel('備註', { exact: true }).inputValue(), '合成本機未儲存備註'); assert.deepEqual(counts(), durable); await abandon(page);
  await section(page).getByRole('button', { name: '重新讀取附件', exact: true }).click(); await attachmentCard(page, core.title).getByText('合成管理員已保存備註', { exact: true }).waitFor();
  await attachmentCard(page, core.title).getByRole('button', { name: '更換檔案', exact: true }).click(); await uploadInput(page, true).setInputFiles(fixtures.jpeg);
  core = await patch('case-attachments', core, { note: '合成管理員再次保存備註' }); durable = counts();
  const replaceConflict = page.waitForResponse(response => response.url().endsWith(`/case-attachments/${core.id}/replace-file`));
  dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: '儲存', exact: true }).click(); assert.equal((await replaceConflict).status(), 409); await dialog.getByRole('alert').waitFor();
  assert.deepEqual(await selectedFile(uploadInput(page, true)), { name: fixtures.jpeg.name, size: fixtures.jpeg.buffer.length, sha256: sha256(fixtures.jpeg.buffer) });
  for (const key of ['records', 'versions', 'files', 'audit']) assert.equal(counts()[key], durable[key], 'Conflict cannot leave durable blobs or partial records');
  await screenshot(page, 'replace-real-conflict-desktop.png'); await abandon(page);
  await section(page).getByRole('button', { name: '重新讀取附件', exact: true }).click(); await attachmentCard(page, core.title).getByText('合成管理員再次保存備註', { exact: true }).waitFor();
  assert.equal(core.version, 7); assert.equal(core.sha256, sha256(fixtures.second.buffer));
  mark('停用/恢復留版、取消零寫入；真metadata409保留輸入，真replace409保留FileList及bytes、不留孤兒BLOB/版本');

  // The real API commits first; only the browser's successful response body is interrupted.
  // This must not close the form or rotate its idempotency key on the retry.
  await load(page, `/cases/${caseB.id}`, caseB.name);
  for (const [mode, title, message, evidence] of [
    ['abort', '合成成功回應讀取中斷', '連線逾時，請保留輸入內容並重試。', 'upload-body-abort-retained-desktop.png'],
    ['empty', '合成成功回應缺少確認', '未取得附件儲存確認，請保留輸入與選檔後重試。', 'upload-empty-body-retained-desktop.png'],
  ]) {
    await section(page).getByRole('button', { name: '新增附件', exact: true }).click();
    await fillMetadata(page, { title, category: 'administrative', note: '合成已提交但成功回應無法確認，原輸入與選檔必須保留。' });
    await uploadInput(page).setInputFiles(fixtures.first);
    const keyStart = keys.length;
    await page.evaluate(mode => {
      const originalFetch = window.fetch;
      window.__attachmentBodyFault = null;
      window.fetch = async function(input, options) {
        const response = await originalFetch.call(this, input, options);
        const target = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (target.pathname === '/api/case-attachments/upload' && options?.method === 'POST' && response.status === 201) {
          window.fetch = originalFetch;
          window.__attachmentBodyFault = { mode, status: response.status };
          if (mode === 'empty') return new Response('{}', { status: 201, headers: { 'Content-Type': 'application/json' } });
          Object.defineProperty(response, 'json', { value: async () => { throw new DOMException('Synthetic response body interrupted after commit', 'AbortError'); } });
        }
        return response;
      };
    }, mode);
    dialog = page.getByRole('dialog', { name: '新增附件', exact: true });
    await dialog.getByRole('button', { name: '儲存', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: message }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__attachmentBodyFault), { mode, status: 201 });
    assert.equal(await dialog.getByLabel('附件標題', { exact: false }).inputValue(), title);
    assert.equal(await dialog.getByLabel('附件分類', { exact: false }).inputValue(), 'administrative');
    assert.equal(await dialog.getByLabel('備註', { exact: true }).inputValue(), '合成已提交但成功回應無法確認，原輸入與選檔必須保留。');
    assert.deepEqual(await selectedFile(uploadInput(page)), { name: fixtures.first.name, size: fixtures.first.buffer.length, sha256: sha256(fixtures.first.buffer) });
    const saved = await request('GET', `case-attachments?caseId=${caseB.id}&q=${encodeURIComponent(title)}`);
    assert.equal(saved.total, 1); assert.equal(saved.items[0].version, 1); assert.equal(saved.items[0].sha256, sha256(fixtures.first.buffer));
    const afterCommit = counts();
    await inspectLayout(page); await screenshot(page, evidence); await saveDialog(page);
    assert.deepEqual(counts(), afterCommit, 'Retry after a successful response body failure cannot add writes, BLOBs or versions');
    const attempts = keys.slice(keyStart); assert.equal(attempts.length, 2); assert.ok(attempts[0].key); assert.equal(attempts[0].key, attempts[1].key);
    await attachmentCard(page, title).waitFor();
  }
  mark('真API已提交201後JSON body AbortError及有效空body均保留表單、metadata與FileList；同鍵重試無新增寫入/BLOB/版本');

  for (let i = 1; i <= 25; i++) await upload(caseA.id, `合成批次附件${String(i).padStart(2, '0')}`, fixtures.png, { category: i % 2 ? 'administrative' : 'other', status: i === 25 ? 'inactive' : 'active' });
  // Imported-history fixture uses two immutable, correctly scoped files. v1 belongs to another case.
  const historyId = id(), time = now(), currentFileId = id(), oldFileId = id();
  const fileMeta = file => ({ fileName: file.name, mimeType: file.mimeType, sizeBytes: file.buffer.length, sha256: sha256(file.buffer) });
  const imported = { caseId: historyCase.id, title: '合成附件歷史範圍', category: 'other', status: 'active', note: '', fileId: currentFileId, ...fileMeta(fixtures.png) };
  app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(historyId, orgId, 'case-attachments', JSON.stringify(imported), 2, time, time);
  for (const [fileId, caseId, file] of [[currentFileId, historyCase.id, fixtures.png], [oldFileId, caseB.id, fixtures.first]]) app.db.prepare('INSERT INTO attachment_files VALUES(?,?,?,?,?,?,?,?,?,?)').run(fileId, orgId, historyId, caseId, file.name, file.mimeType, file.buffer.length, sha256(file.buffer), file.buffer, time);
  initDb(app.db);
  app.db.prepare('INSERT INTO record_versions VALUES(?,?,?,?,?,?,?)').run(orgId, 'case-attachments', historyId, 1, JSON.stringify({ ...imported, id: historyId, orgId, caseId: caseB.id, title: 'HIDDEN-ATTACHMENT-HISTORY', fileId: oldFileId, ...fileMeta(fixtures.first), version: 1, createdAt: time, updatedAt: time }), time, 'baseline');
  // References to another attachment's valid blob must fail the full tuple check.
  const wrongTupleId = id(); app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(wrongTupleId, orgId, 'case-attachments', JSON.stringify({ ...imported, title: '合成不可串檔測試' }), 1, time, time); initDb(app.db);
  const beforeReads = counts();
  await load(page, `/cases/${caseA.id}`, caseA.name); await section(page).getByText('共 28 筆', { exact: false }).waitFor(); assert.equal(await section(page).locator('.attachment-card').count(), 25);
  await section(page).getByRole('button', { name: '下一頁', exact: true }).click(); await section(page).getByText('第 2 / 2 頁', { exact: false }).waitFor(); assert.equal(await section(page).locator('.attachment-card').count(), 3);
  await section(page).getByRole('button', { name: '上一頁', exact: true }).click(); await section(page).getByText('第 1 / 2 頁', { exact: false }).waitFor();
  await section(page).getByLabel('附件分類篩選', { exact: true }).selectOption('administrative'); await section(page).getByText('共 13 筆', { exact: false }).waitFor(); assert.equal(await section(page).locator('.attachment-card').count(), 13);
  await section(page).getByLabel('附件分類篩選', { exact: true }).selectOption(''); await section(page).getByText('共 28 筆', { exact: false }).waitFor();
  await section(page).getByLabel('附件狀態篩選', { exact: true }).selectOption('inactive'); await section(page).getByText('共 1 筆', { exact: false }).waitFor(); await attachmentCard(page, '合成批次附件25').waitFor();
  await section(page).getByLabel('附件狀態篩選', { exact: true }).selectOption(''); await search(page, '沒有這份合成附件'); await section(page).getByText('共 0 筆', { exact: false }).waitFor(); assert.equal(await section(page).locator('.attachment-card').count(), 0);
  await section(page).getByRole('button', { name: '清除附件搜尋', exact: true }).click(); await section(page).getByText('共 28 筆', { exact: false }).waitFor();
  await search(page, core.title); await attachmentCard(page, core.title).waitFor(); await section(page).getByText('共 1 筆', { exact: false }).waitFor();
  assert.ok(!page.url().includes(encodeURIComponent(core.title))); assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(core.title));
  await section(page).scrollIntoViewIfNeeded(); await inspectLayout(page); await screenshot(page, 'attachment-card-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 }); await attachmentCard(page, core.title).scrollIntoViewIfNeeded(); await inspectLayout(page); await screenshot(page, 'attachment-card-mobile.png');
  await attachmentCard(page, core.title).getByRole('button', { name: '更換檔案', exact: true }).click(); await uploadInput(page, true).setInputFiles({ ...fixtures.jpeg, name: '合成照片_這是用來確認手機換行及選檔提示完整可讀的較長檔案名稱.jpeg' });
  await inspectLayout(page); await screenshot(page, 'attachment-file-picker-mobile.png'); await abandon(page); await page.setViewportSize({ width: 1440, height: 1050 });
  mark('28筆25+3分頁、分類13/停用1/搜尋清除無結果正確；1440/390卡片與長檔名選檔單欄可讀、敏感條件不入URL/storage');

  let history = await request('GET', `case-attachments/${core.id}/history?compare=previous`);
  assert.equal(history.total, 7); assert.ok(!JSON.stringify(history).includes('fileId')); assert.deepEqual(history.items[0].actor, { id: admin.user.id, name: admin.user.name });
  const replaced = history.items.find(item => item.version === 3); assert.deepEqual(replaced.actor, { id: actors.supervisor.id, name: actors.supervisor.name }); assert.equal(replaced.snapshot.sha256, sha256(fixtures.second.buffer)); assert.equal(replaced.comparison.previousSnapshot.sha256, sha256(fixtures.first.buffer));
  await browserDownload(page, attachmentCard(page, core.title).getByRole('button', { name: '下載目前版本', exact: true }), fixtures.second, 'download-current.pdf');
  trigger = attachmentCard(page, core.title).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(page, trigger, '附件版本歷程', 7);
  let card = versionCard(dialog, 3); await card.locator(':scope > summary').click(); await card.getByText('完整保存欄位', { exact: true }).click(); await card.evaluate(node => node.scrollIntoView({ block: 'start' }));
  await card.getByRole('row').filter({ hasText: 'SHA-256' }).waitFor(); await inspectLayout(page); await screenshot(page, 'attachment-history-replaced-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 }); await card.locator('.table-scroll').evaluate(node => { node.scrollLeft = node.scrollWidth; }); await inspectLayout(page); await card.locator('.table-scroll').evaluate(node => { node.scrollLeft = node.scrollWidth; }); await screenshot(page, 'attachment-history-mobile-after.png');
  await card.locator('.history-snapshot').evaluate(node => node.scrollIntoView({ block: 'start' })); await screenshot(page, 'attachment-history-snapshot-mobile.png');
  await page.setViewportSize({ width: 1440, height: 1050 }); card = versionCard(dialog, 2); await card.locator(':scope > summary').click();
  await browserDownload(page, card.getByRole('button', { name: '下載此版本', exact: true }), fixtures.first, 'download-history-v2.pdf');
  await closeHistory(page, trigger); await binary(core, undefined, fixtures.second); await binary(core, 999, undefined, context, admin, 404);
  mark('7版歷程保留替換前後metadata/SHA及真actor；目前版下載新bytes、描述版v2下載舊bytes，缺版404不回退且fileId不外露');

  const listPattern = '**/api/case-attachments?*'; let listAttempts = 0;
  await page.route(listPattern, async route => {
    if (new URL(route.request().url()).searchParams.get('caseId') !== caseA.id) return route.continue(); listAttempts++;
    if (listAttempts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_LIST_FAILURE', message: '合成附件列表讀取失敗' } }) }); return route.continue();
  });
  await page.reload(); await page.getByRole('heading', { name: caseA.name, exact: true }).waitFor(); await section(page).getByRole('button', { name: '重新讀取', exact: true }).waitFor();
  await page.getByText('合成原主要照顧者', { exact: true }).waitFor(); await page.getByRole('heading', { name: '多組聯絡人', exact: true }).waitFor();
  await section(page).scrollIntoViewIfNeeded(); await screenshot(page, 'attachment-list-retry-error.png');
  await section(page).getByRole('button', { name: '重新讀取', exact: true }).click(); await section(page).getByText('共 28 筆', { exact: false }).waitFor(); assert.equal(listAttempts, 2); await page.unroute(listPattern);
  const slowArrived = deferred(), releaseSlow = deferred(), slowHandled = deferred();
  await page.route(listPattern, async route => {
    if (new URL(route.request().url()).searchParams.get('q') !== '合成批次附件01') return route.continue();
    try { const response = await route.fetch(); slowArrived.resolve(); await releaseSlow.promise; await route.fulfill({ response }); } catch (error) { if (!/closed|cancel|abort|disposed/i.test(error.message)) throw error; } finally { slowHandled.resolve(); }
  });
  await search(page, '合成批次附件01'); await slowArrived.promise; await search(page, core.title); await attachmentCard(page, core.title).waitFor(); releaseSlow.resolve(); await slowHandled.promise; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await attachmentCard(page, '合成批次附件01').count(), 0); await page.unroute(listPattern);
  const caseArrived = deferred(), releaseCase = deferred(), caseHandled = deferred();
  await page.route(listPattern, async route => {
    if (new URL(route.request().url()).searchParams.get('caseId') !== caseA.id) return route.continue();
    try { const response = await route.fetch(); caseArrived.resolve(); await releaseCase.promise; await route.fulfill({ response }); } catch (error) { if (!/closed|cancel|abort|disposed/i.test(error.message)) throw error; } finally { caseHandled.resolve(); }
  });
  await page.reload(); await caseArrived.promise; await section(page).getByText('正在讀取附件…', { exact: true }).waitFor();
  await page.evaluate(caseId => { location.hash = `/cases/${caseId}`; }, caseB.id); await page.getByRole('heading', { name: caseB.name, exact: true }).waitFor(); await attachmentCard(page, other.title).waitFor();
  releaseCase.resolve(); await caseHandled.promise; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); assert.equal(await attachmentCard(page, core.title).count(), 0); await page.unroute(listPattern);
  mark('附件列表503可獨立重試、不阻斷個案/聯絡人；慢搜尋與切案回應不能覆蓋最新條件或串案');

  await load(page, `/cases/${caseA.id}`, caseA.name); await search(page, core.title); await attachmentCard(page, core.title).waitFor();
  const historyPattern = `**/api/case-attachments/${core.id}/history?*`; let historyAttempts = 0;
  await page.route(historyPattern, async route => { historyAttempts++; if (historyAttempts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_HISTORY_FAILURE', message: '合成附件歷程讀取失敗' } }) }); return route.continue(); });
  trigger = attachmentCard(page, core.title).getByRole('button', { name: '版本歷程', exact: true }); await trigger.click(); dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: '重新讀取', exact: true }).click(); await dialog.getByText('第 7 版', { exact: true }).waitFor(); assert.equal(historyAttempts, 2); await closeHistory(page, trigger); await page.unroute(historyPattern);
  const downloadPattern = `**/api/case-attachments/${core.id}/download*`; let downloadAttempts = 0;
  await page.route(downloadPattern, async route => { downloadAttempts++; if (downloadAttempts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_DOWNLOAD_FAILURE', message: '合成附件下載失敗，請重試' } }) }); return route.continue(); });
  await attachmentCard(page, core.title).getByRole('button', { name: '下載目前版本', exact: true }).click(); await attachmentCard(page, core.title).getByRole('alert').waitFor(); await screenshot(page, 'attachment-download-retry-error.png');
  await browserDownload(page, attachmentCard(page, core.title).getByRole('button', { name: '下載目前版本', exact: true }), fixtures.second, 'download-after-retry.pdf'); assert.equal(downloadAttempts, 2); await page.unroute(downloadPattern);
  dialog = await openHistory(page, trigger, '附件版本歷程', 7); card = versionCard(dialog, 7);
  const fileArrived = deferred(), releaseFile = deferred(), fileHandled = deferred(); let lateDownloads = 0; const countLate = () => { lateDownloads++; }; page.on('download', countLate);
  const aborted = page.waitForEvent('requestfailed', { predicate: req => req.url().includes(`/case-attachments/${core.id}/download`), timeout: 10000 });
  await page.route(downloadPattern, async route => { try { const response = await route.fetch(); fileArrived.resolve(); await releaseFile.promise; await route.fulfill({ response }); } catch (error) { if (!/closed|cancel|abort|disposed/i.test(error.message)) throw error; } finally { fileHandled.resolve(); } });
  await card.getByRole('button', { name: '下載此版本', exact: true }).click(); await fileArrived.promise; await closeHistory(page, trigger); releaseFile.resolve(); await fileHandled.promise; assert.match((await aborted).failure()?.errorText || '', /abort|cancel/i);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); assert.equal(lateDownloads, 0); await page.unroute(downloadPattern); page.off('download', countLate);
  mark('歷程與binary下載503均可重試；下載失敗留原卡片，關閉歷程取消慢下載且不觸發檔案或復活視窗');

  // A slow current-file response is also discarded after switching cases, even without a history dialog signal.
  const switchArrived = deferred(), releaseSwitch = deferred(), switchHandled = deferred(); lateDownloads = 0; page.on('download', countLate);
  await page.route(downloadPattern, async route => { try { const response = await route.fetch(); switchArrived.resolve(); await releaseSwitch.promise; await route.fulfill({ response }); } catch (error) { if (!/closed|cancel|abort|disposed/i.test(error.message)) throw error; } finally { switchHandled.resolve(); } });
  await attachmentCard(page, core.title).getByRole('button', { name: '下載目前版本', exact: true }).click(); await switchArrived.promise;
  await page.evaluate(caseId => { location.hash = `/cases/${caseId}`; }, caseB.id); await attachmentCard(page, other.title).waitFor(); releaseSwitch.resolve(); await switchHandled.promise;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); assert.equal(lateDownloads, 0); await page.unroute(downloadPattern); page.off('download', countLate);
  mark('切換個案後晚到的目前版binary回應不自動下載，也不更新新個案畫面');

  for (const actor of [{ client: context, auth: admin }, caregiver, finance]) {
    history = await request('GET', `case-attachments/${historyId}/history?compare=previous`, undefined, 200, actor.client, actor.auth); assert.equal(history.total, 1); assert.equal(history.items[0].version, 2); assert.equal(history.items[0].actor, null);
    assert.deepEqual(history.items[0].comparison, { status: 'unavailable', previousVersion: null, previousSnapshot: null }); assert.ok(!JSON.stringify(history).includes('HIDDEN-ATTACHMENT-HISTORY')); assert.ok(!JSON.stringify(history).includes('fileId'));
    await binary({ id: historyId }, 1, undefined, actor.client, actor.auth, 404); await binary({ id: historyId }, 2, fixtures.png, actor.client, actor.auth); await binary({ id: wrongTupleId }, undefined, undefined, actor.client, actor.auth, 404);
  }
  await load(caregiver.page, `/cases/${historyCase.id}`, historyCase.name); trigger = attachmentCard(caregiver.page, imported.title).getByRole('button', { name: '版本歷程', exact: true }); dialog = await openHistory(caregiver.page, trigger, '附件版本歷程', 2);
  await dialog.getByText('上一版本不可取得，只顯示本版保存資料。', { exact: true }).waitFor(); await dialog.getByText('未記錄操作者', { exact: true }).waitFor(); assert.equal(await dialog.getByText('第 1 版', { exact: true }).count(), 0); await screenshot(caregiver.page, 'attachment-history-scope-gap.png'); await closeHistory(caregiver.page, trigger);
  mark('所有角色不可讀他案歷史版或下載其BLOB；缺前版不回退，錯attachment tuple即使fileId存在也404');

  assert.equal((await request('GET', `case-attachments?caseId=${caseB.id}`, undefined, 200, caregiver.client, caregiver.auth)).total, 0);
  for (const suffix of ['', '/history?compare=previous']) {
    await request('GET', `case-attachments/${other.id}${suffix}`, undefined, 404, caregiver.client, caregiver.auth); await request('GET', `case-attachments/${foreign.id}${suffix}`, undefined, 404, caregiver.client, caregiver.auth);
  }
  await binary(other, undefined, undefined, caregiver.client, caregiver.auth, 404); await binary(foreign, 1, undefined, caregiver.client, caregiver.auth, 404);
  for (const actor of [caregiver, finance]) {
    await request('POST', 'case-attachments/upload', { caseId: caseA.id, title: '不可上傳', ...payload(fixtures.png) }, 403, actor.client, actor.auth);
    await request('POST', `case-attachments/${core.id}/replace-file`, { version: core.version, ...payload(fixtures.jpeg) }, 403, actor.client, actor.auth);
    await request('PATCH', `case-attachments/${core.id}`, { version: core.version, note: '不可修改' }, 403, actor.client, actor.auth);
    await binary(core, 1, fixtures.first, actor.client, actor.auth); await binary(core, undefined, fixtures.second, actor.client, actor.auth);
    await load(actor.page, `/cases/${caseA.id}`, caseA.name); await section(actor.page).getByText('共 28 筆', { exact: false }).waitFor(); assert.equal(await section(actor.page).getByRole('button', { name: /新增附件|編輯資料|更換檔案|停用|恢復使用/ }).count(), 0);
    await search(actor.page, core.title); await attachmentCard(actor.page, core.title).waitFor(); await browserDownload(actor.page, attachmentCard(actor.page, core.title).getByRole('button', { name: '下載目前版本', exact: true }), fixtures.second, actor === caregiver ? 'download-caregiver.pdf' : 'download-finance.pdf');
  }
  await section(caregiver.page).getByRole('button', { name: '清除附件搜尋', exact: true }).click(); await section(caregiver.page).getByLabel('附件狀態篩選', { exact: true }).selectOption('inactive'); await attachmentCard(caregiver.page, '合成批次附件25').waitFor();
  await caregiver.page.setViewportSize({ width: 390, height: 844 }); await attachmentCard(caregiver.page, '合成批次附件25').scrollIntoViewIfNeeded(); await inspectLayout(caregiver.page); await screenshot(caregiver.page, 'caregiver-inactive-attachment-mobile.png');
  await browserDownload(caregiver.page, attachmentCard(caregiver.page, '合成批次附件25').getByRole('button', { name: '下載目前版本', exact: true }), fixtures.png, 'download-inactive.png');
  mark('caregiver本案及停用附件/舊版可下載、finance沿個案唯讀；他案跨機構byte端點404，所有写入403且無維護按鈕');

  assert.deepEqual((await request('GET', `cases/${caseA.id}`)).item, oldCase); assert.deepEqual(await request('GET', `cases/${caseA.id}/history?compare=previous`), oldCaseHistory); assert.deepEqual(counts(), beforeReads);
  assert.deepEqual(pageErrors, []); assert.deepEqual(failedResponses.filter(item => !item.expected), []); assert.equal(failedResponses.filter(item => item.status === 409).length, 2); assert.equal(failedResponses.filter(item => item.status === 422).length, 1); assert.equal(failedResponses.filter(item => item.status === 503).length, 5);
  assert.ok(consoleErrors.every(message => /409|422|503/.test(message)), JSON.stringify(consoleErrors));
  mark('舊case完整item/version/history不變，列表/歷程/byte下載全唯讀；0pageerror且僅預期409/422/503');
  await rm(path.join(output, 'failure.png'), { force: true });
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), scope: 'memory SQLite / random localhost port / synthetic valid files / real Chromium', checks, pageErrors, consoleErrors, failedResponses, readonlyCounts: { before: beforeReads, after: counts() }, legacyCaseUnchanged: true, downloads, screenshots }, null, 2));
  console.log(`Attachments E2E passed: ${checks.length} checks, ${screenshots.length} screenshots, ${downloads.length} verified downloads`);
} catch (error) {
  if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  await writeFile(path.join(output, 'e2e.json'), JSON.stringify({ passed: false, completedAt: new Date().toISOString(), checks, pageErrors, consoleErrors, failedResponses, downloads, screenshots, error: error.stack }, null, 2)); throw error;
} finally {
  for (const context of contexts) await context.close(); await browser?.close(); await app.close();
}
