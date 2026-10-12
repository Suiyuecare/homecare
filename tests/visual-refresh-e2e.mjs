import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Public default: current source, synthetic API fixtures, memory DB, random loopback.
// Optional baseline/fixture arguments bind private before/after evidence to equal rows.
const ownRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const mode = option('--mode') || 'after';
assert(['before', 'after'].includes(mode));
const sourceRoot = path.resolve(option('--baseline-root') || option('--source-root') || ownRoot);
const qa = path.resolve(option('--output-root') || path.join(ownRoot, 'outputs/software/visual-refresh-qa/browser'));
await mkdir(qa, { recursive: true });
const output = await mkdtemp(path.join(qa, mode + '-attempt-'));
console.log('EVIDENCE ' + output);
const { createApp } = await import(pathToFileURL(path.join(sourceRoot, 'src/server/index.mjs')));
const { PDF_BYTES, PNG_BYTES, filePayload } = await import(pathToFileURL(path.join(sourceRoot, 'tests/attachment-fixtures.mjs')));
const { chromium } = createRequire(import.meta.url)('playwright');
const app = createApp({ dbPath: ':memory:', port: 0 });
const password = 'synthetic-visual-refresh-password';
const roles = ['admin', 'supervisor', 'finance', 'caregiver'];
const widths = [375, 390, 760, 1023, 1024, 1440];
const desktop = { width: 1440, height: 1000 }, mobile = { width: 390, height: 844 };
const routeDefinitions = [
  ['/account-administration', '帳號與權限', '帳號與權限'],
  ['/calculations', '計價與薪資試算', '計價與薪資試算'],
  ['/ltc-codes', 'BA／AA 清冊與試算', 'BA／AA 清冊與試算'],
  ['/financial-adjustments', '財務更正調整單', '財務更正調整單'],
  ['/surveys', '本機匿名填答與QR', '問卷與 QR 填答'],
  ['/group-overview', '群組營運總覽', '群組營運總覽'],
  ['/service-payroll','服務轉薪資','服務轉薪資'],
  ['/employee-payroll','員工薪資規則與月試算','員工薪資規則與月試算'],
  ['/service-billing','服務轉帳單','服務轉帳單'],
  ['/shift-substitution','人工代班申請','人工代班申請'], ['/contract-deadlines','契約期限提醒','契約期限提醒'], ['/internal-notifications','內部通知與本人回執','站內通知與回覆'],
  ['/institution-holidays','機構人工假日','機構人工假日'],
  ['/training-credits','人工年度訓練積分','年度人工積分'],
  ['/shift-series','永久週期排班','永久週期排班'],
  ['/case-contracts','個案契約與期限','契約與期限'],
  ['/internal-tasks','內部待辦','內部待辦'],
  ['/local-imports','本機資料匯入','本機資料匯入'], ['/attendance-exceptions','人工出勤例外','人工出勤例外'],
  ['/custom-forms','自訂表單','自訂表單'],
  ['/claim-batches', '離線核銷與人工對帳', '離線核銷與人工對帳'],
  ['/billing-documents', '人工帳單與收款', '人工帳單與收款'], ['/payroll-statements', '人工薪資結算', '人工薪資結算'],
  ['/institution-calendar', '機構行事曆', '機構行事曆'], ['/complaints', '申訴案件管理', '申訴案件'], ['/business-rules', '業務規則設定', '業務規則設定'],
  ['/', '今日服務工作台', '工作台'], ['/personal-calendar', '個人行事曆', '個人行事曆'],
  ['/cases', '個案', '個案管理'], ['/case-followup-worklist', '人工追蹤查詢', '人工追蹤查詢'],
  ['/plans', '照顧計畫', '照顧計畫'], ['/shifts', '班表', '排班調度'],
  ['/records', '服務紀錄與核閱', '服務核閱'], ['/my-services', '我的服務', '我的服務'],
  ['/employees', '員工管理', '員工管理'], ['/interviews', '面試者登錄', '面試者登錄'],
  ['/certifications', '員工證照', '證照與期限'], ['/training', '教育訓練', '訓練紀錄'],
  ['/service-items', '服務項目', '服務項目'], ['/leave', '請假管理', '請假與差勤'],
  ['/assessments', '個案評鑑表', '評估表單'], ['/supervisory-visits', '督導訪視查詢', '督導訪視查詢'],
  ['/needs-assessments', '需求評估查詢', '需求評估查詢'], ['/announcements', '內部公告', '機構公告'],
  ['/reports', '報表中心', '報表中心'], ['/settings', '機構與帳號設定', '機構設定'],
  ['/audit', '操作紀錄', '異動紀錄'], ['/help', '使用說明', '使用說明'],
];
const permitted = (role, route) => {
  if (route === '/account-administration') return role === 'admin';
  if (route === '/employee-payroll') return ['admin', 'finance'].includes(role);
  if (['/calculations', '/ltc-codes', '/financial-adjustments'].includes(route)) return ['admin', 'finance'].includes(role);
  if (route === '/surveys') return ['admin', 'supervisor'].includes(role);
  if (route === '/group-overview') return role === 'admin';
  if(route==='/shift-substitution')return ['admin','supervisor','caregiver'].includes(role);
  if(route==='/contract-deadlines')return ['admin','supervisor'].includes(role);
  if(route==='/internal-notifications')return true;
  if(route==='/local-imports')return role==='admin';
  if(route==='/attendance-exceptions')return ['admin','supervisor','caregiver'].includes(role);
  if(route==='/institution-holidays')return ['admin','supervisor'].includes(role);
  if(route==='/training-credits')return ['admin','supervisor','caregiver'].includes(role);
  if(['/shift-series','/case-contracts','/custom-forms'].includes(route))return ['admin','supervisor'].includes(role);
  if(route==='/internal-tasks')return true;
  if (['/service-payroll', '/service-billing', '/claim-batches', '/billing-documents', '/payroll-statements'].includes(route)) return ['admin', 'finance'].includes(role);
  if (route === '/institution-calendar') return true;
  if (route === '/business-rules') return ['admin', 'supervisor', 'finance'].includes(role);
  if (route === '/complaints') return ['admin', 'supervisor'].includes(role);
  if (route === '/personal-calendar') return true;
  if (['/interviews', '/supervisory-visits', '/needs-assessments', '/case-followup-worklist'].includes(route)) return ['admin', 'supervisor'].includes(role);
  if (role === 'caregiver') return ['/', '/my-services', '/cases', '/certifications', '/training', '/announcements', '/help'].includes(route);
  if (['/audit', '/settings'].includes(route)) return role === 'admin';
  if (role === 'finance') return ['/', '/cases', '/employees', '/service-items', '/reports', '/announcements', '/help'].includes(route);
  return true;
};
const json = value => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? { sqliteInteger: String(v) } : v);
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : json(value)).digest('hex');
const checks = [], screenshots = [], readSegments = [], fixtureWrites = [], stateLedger = [];
const routeChecks = [], layoutChecks = [], touchChecks = [], inputChecks = [], navigationChecks = [], interactionChecks = [];
const requests = [], responses = [], failedRequests = [], consoleErrors = [], pageErrors = [], expectedFailures = [], externalRequests = [];
let stage = 'initialization', browser, base, lastPage, fixture, fixturePath, sourceHashesBefore, savedRowsBefore;
const actors = {};
const mark = name => { checks.push(name); console.log('PASS ' + name); };
const sourceMap = async root => {
  const files = ['BUILD_STATE.md', 'PRODUCT.md', 'README.md', 'DESIGN.md', 'UX-CONTRACT.md', 'package.json', 'premium-ui.json', '.env.portal.example', '.gitignore', 'pnpm-lock.yaml'].filter(file => existsSync(path.join(root, file)));
  const extensions = new Set(['.mjs', '.js', '.json', '.md', '.html', '.css', '.svg', '.png', '.yml', '.yaml']);
  const walk = async directory => { for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) { const rel = path.join(directory, entry.name); if (entry.isDirectory()) await walk(rel); else if (entry.isFile() && extensions.has(path.extname(rel))) files.push(rel); } };
  for (const directory of ['public', 'src', 'tests', 'scripts', 'docs', '.github']) if (existsSync(path.join(root, directory))) await walk(directory);
  return Object.fromEntries(await Promise.all([...new Set(files)].sort().map(async file => [file, sha(await readFile(path.join(root, file)))])));
};
const raw = () => {
  const schema = app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const names = schema.filter(row => row.type === 'table').map(row => row.name);
  assert.equal(names.length, 11); assert.equal(schema.filter(row => row.type === 'trigger').length, 6);
  const tables = Object.fromEntries(names.map(name => { const statement = app.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid'); statement.setReadBigInts(true); return [name, statement.all()]; }));
  return { schema, tables };
};
const counts = () => ({ totalChanges: app.db.prepare('SELECT total_changes() n').get().n, records: app.db.prepare('SELECT COUNT(*) n FROM records').get().n, versions: app.db.prepare('SELECT COUNT(*) n FROM record_versions').get().n, audit: app.db.prepare('SELECT COUNT(*) n FROM audit').get().n });
const readOnly = async (label, action) => {
  stage = label; const before = raw(), beforeCounts = counts(); const result = await action(); const after = raw(), afterCounts = counts();
  assert.deepEqual(after, before, label + ': all eleven tables, BLOBs, schema and six triggers unchanged');
  assert.deepEqual(afterCounts, beforeCounts, label + ': total_changes zero');
  const segment = { sequence: stateLedger.length + 1, label, tableCount: 11, triggerCount: 6, beforeSha256: sha(before), afterSha256: sha(after), beforeCounts, afterCounts, zeroWrites: true };
  readSegments.push(segment); stateLedger.push({ kind: 'read', ...segment }); return result;
};
const fixtureWrite = async (label, action) => {
  stage = label; const before = raw(), beforeCounts = counts(); const result = await action(); const after = raw(), afterCounts = counts();
  assert.deepEqual(after.schema, before.schema);
  const segment = { sequence: stateLedger.length + 1, label, syntheticOnly: true, beforeSha256: sha(before), afterSha256: sha(after), beforeCounts, afterCounts, totalChangesDelta: afterCounts.totalChanges - beforeCounts.totalChanges, changedTables: Object.keys(before.tables).filter(name => sha(before.tables[name]) !== sha(after.tables[name])) };
  fixtureWrites.push(segment); stateLedger.push({ kind: 'fixture', ...segment }); return result;
};
const encode = value => value instanceof Uint8Array ? { syntheticBytesBase64: Buffer.from(value).toString('base64') } : value;
const decode = value => value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.syntheticBytesBase64 === 'string' ? Buffer.from(value.syntheticBytesBase64, 'base64') : value;
const portableRows = () => Object.fromEntries(Object.keys(raw().tables).filter(name => name !== 'sessions').map(name => [name, app.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all().map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, encode(value)])))]));
const observe = page => {
  page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000);
  page.on('request', request => { const entry = { phase: stage, url: request.url(), method: request.method() }; requests.push(entry); if (new URL(entry.url).origin !== base) externalRequests.push(entry); });
  page.on('pageerror', error => pageErrors.push({ phase: stage, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ phase: stage, text: message.text(), location: message.location() }); });
  page.on('response', response => { if (response.status() >= 400) { const rule = expectedFailures.find(rule => rule.phase === stage && rule.url === response.url() && rule.method === response.request().method() && rule.status === response.status()); responses.push({ phase: stage, url: response.url(), method: response.request().method(), status: response.status(), expectedRuleId: rule?.id || null }); } });
  page.on('requestfailed', request => failedRequests.push({ phase: stage, url: request.url(), method: request.method(), errorText: request.failure()?.errorText }));
};
const settle = async page => { await page.waitForLoadState('networkidle'); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); };
const resize = async (page, viewport) => {
  await page.setViewportSize(viewport);
  // Allow Chrome's resized compositor to settle before viewport evidence.
  await page.waitForTimeout(150);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};
const load = async (page, route, heading) => {
  lastPage = page; const target = base + '/#' + route; if (page.url() === target) await page.reload(); else await page.goto(target); await page.locator('#main-content').waitFor();
  await settle(page); if (heading) await page.getByRole('heading', { level: 1, name: heading, exact: true }).waitFor();
};
const geometry = async (page, label, strict = mode === 'after') => {
  const result = await page.evaluate(() => {
    const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
    return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, scrollX,
      dialogs: [...document.querySelectorAll('dialog[open]')].map(node => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth })),
      tables: [...document.querySelectorAll('.table-scroll')].filter(visible).map(node => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, overflowX: getComputedStyle(node).overflowX })),
      inputs: [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]),select,textarea')].filter(visible).map(node => ({ name: node.name || node.getAttribute('aria-label') || node.id, fontSize: parseFloat(getComputedStyle(node).fontSize), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, labelled: Boolean(node.labels?.length || node.getAttribute('aria-label') || node.getAttribute('aria-labelledby')) })),
      targets: [...document.querySelectorAll('button,a.btn,.nav-link,.mobile-nav-link,.next-action,.dashboard-shortcut,.notification-link')].filter(visible).map(node => { const r = node.getBoundingClientRect(); return { text: (node.getAttribute('aria-label') || node.textContent).trim(), width: r.width, height: r.height }; }),
    };
  });
  const overflow = result.documentWidth > result.width + 1 || result.scrollX !== 0 || result.dialogs.some(item => item.scrollWidth > item.clientWidth + 1);
  const small = result.targets.filter(target => target.width < 43.5 || target.height < 43.5);
  const smallNative = result.inputs.filter(input => input.width < 43.5 || input.height < 43.5);
  const smallFont = result.width < 1024 ? result.inputs.filter(input => input.fontSize < 16) : [];
  if (strict) {
    assert(!overflow, label + ': document/dialog overflow: ' + json(result));
    assert.deepEqual(small, [], label + ': primary touch target below 44px');
    assert.deepEqual(smallNative, [], label + ': native input/select/textarea touch target below 44px');
    assert.deepEqual(smallFont, [], label + ': mobile input text below 16px');
    assert.deepEqual(result.inputs.filter(input => !input.labelled), [], label + ': unlabelled visible input');
    for (const table of result.tables) if (table.scrollWidth > table.clientWidth + 1) assert(['auto', 'scroll'].includes(table.overflowX), 'Wide table owns its horizontal scroll');
  }
  layoutChecks.push({ label, ...result, overflow }); touchChecks.push({ label, checked: result.targets.length, below44: small }); inputChecks.push({ label, checked: result.inputs.length, below44: smallNative, below16: smallFont }); return result;
};
const shot = async (page, name) => {
  await geometry(page, name); const file = path.join(output, name); await page.screenshot({ path: file, fullPage: false });
  screenshots.push({ name, path: file, sha256: sha(await readFile(file)), viewport: page.viewportSize(), actuallyViewed: false, visualReviewPending: true });
};
const closeDialog = async (page, modal, trigger) => {
  const element = await modal.elementHandle(); assert(element); const focusTarget = trigger ? await trigger.elementHandle() : null;
  await page.keyboard.press('Escape'); await page.waitForFunction(node => !node.isConnected, element);
  if (focusTarget) await page.waitForFunction(node => node === document.activeElement, focusTarget);
  await element.dispose(); await focusTarget?.dispose();
};
const apiRequest = async (context, route, { method = 'GET', body, auth, status = 200 } = {}) => {
  const response = await context.request.fetch(base + route, { method, headers: { Origin: base, ...(auth ? { 'X-CSRF-Token': auth.csrfToken, 'X-Org-Id': auth.organizations[0].id } : {}) }, ...(body ? { data: body } : {}) });
  assert.equal(response.status(), status, await response.text()); return response.json();
};
try {
  sourceHashesBefore = await sourceMap(sourceRoot);
  base = await app.listen(); assert.notEqual(new URL(base).port, '4310');
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  for (const role of roles) { const context = await browser.newContext({ viewport: desktop, reducedMotion: 'reduce' }); const page = await context.newPage(); observe(page); actors[role] = { context, page }; }
  fixturePath = option('--fixture');
  await fixtureWrite('synthetic fixture initialization and explicit four-role authentication', async () => {
    if (fixturePath) {
      fixturePath = path.resolve(fixturePath); fixture = JSON.parse(await readFile(fixturePath, 'utf8')); assert.equal(fixture.syntheticOnly, true); assert.equal(fixture.format, 1);
      const order = ['organizations', 'users', 'memberships', 'records', 'record_versions', 'audit', 'idempotency', 'demo_seeds', 'attachment_files', 'certification_attachment_files'];
      assert.deepEqual(Object.keys(fixture.tables).sort(), order.slice().sort());
      for (const name of order) for (const row of fixture.tables[name]) { const keys = Object.keys(row); const placeholders = keys.map(() => '?').join(','); app.db.prepare('INSERT INTO "' + name + '" (' + keys.map(key => '"' + key + '"').join(',') + ') VALUES(' + placeholders + ')').run(...keys.map(key => decode(row[key]))); }
      assert.deepEqual(portableRows(), fixture.tables, 'Exact same IDs/dates/metadata/BLOBs across before and after');
    } else {
      const admin = actors.admin;
      admin.auth = await apiRequest(admin.context, '/api/setup', { method: 'POST', status: 201, body: { name: '合成視覺管理者', email: 'visual-admin@example.test', password, organizationName: '合成視覺驗收機構', seedDemo: true } });
      const orgId = admin.auth.organizations[0].id;
      const list = async entity => (await apiRequest(admin.context, '/api/' + entity + '?pageSize=100', { auth: admin.auth })).items;
      const employees = await list('employees'), cases = await list('cases'), certificates = await list('employee-certifications');
      const caregiver = employees.find(employee => employee.employeeNo === 'TEST-E002'), supervisor = employees.find(employee => employee.employeeNo === 'TEST-E001');
      const mainCase = cases.find(item => item.caseNo === 'TEST-C001'); assert(mainCase && caregiver && supervisor);
      for (const role of roles.filter(role => role !== 'admin')) await apiRequest(admin.context, '/api/users', { method: 'POST', auth: admin.auth, status: 201, body: { name: { supervisor: '合成視覺督導', finance: '合成視覺財務', caregiver: '合成視覺居服員' }[role], email: 'visual-' + role + '@example.test', password, role, ...(role === 'caregiver' ? { employeeId: caregiver.id } : role === 'supervisor' ? { employeeId: supervisor.id } : {}) } });
      await apiRequest(admin.context, '/api/case-attachments/upload', { method: 'POST', auth: admin.auth, status: 201, body: { caseId: mainCase.id, title: '合成照顧說明', category: 'general', note: '完全合成附件', ...filePayload(PDF_BYTES, 'synthetic-visual.pdf', 'application/pdf') } });
      await apiRequest(admin.context, '/api/certification-attachments/upload', { method: 'POST', auth: admin.auth, status: 201, body: { certificationId: certificates.find(item => item.employeeId === caregiver.id).id, title: '合成訓練附件', note: '完全合成附件', ...filePayload(PNG_BYTES, 'synthetic-visual.png', 'image/png') } });
      const foreign = await apiRequest(admin.context, '/api/organizations', { method: 'POST', auth: admin.auth, status: 201, body: { name: '合成空白驗收機構' } });
      fixture = { format: 1, syntheticOnly: true, serviceDate: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date()), mainCase, orgId, emptyOrgId: foreign.item.id, caregiverId: caregiver.id, tables: portableRows() };
      fixturePath = path.join(output, 'fixture.json'); await writeFile(fixturePath, json(fixture) + '\n', { flag: 'wx', mode: 0o600 });
    }
    for (const role of roles) actors[role].auth = await apiRequest(actors[role].context, '/api/login', { method: 'POST', body: { email: 'visual-' + role + '@example.test', password } });
  });
  savedRowsBefore = raw();
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM attachment_files WHERE length(content)>0').get().n, 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM certification_attachment_files WHERE length(content)>0').get().n, 1);
  assert(app.db.prepare("SELECT data FROM records WHERE entity='service-records'").all().some(row => Object.hasOwn(JSON.parse(row.data), 'billingSnapshot')));
  routeDefinitions.push(['/cases/' + fixture.mainCase.id, fixture.mainCase.name, '個案管理']);
  assert.equal(routeDefinitions.length, 49);
  mark('G1 owned memory/random loopback with reusable identical synthetic rows, four real auth roles, BLOBs and approved snapshot');

  await readOnly('G2 paired eight-state desktop/mobile capture', async () => {
    const page = actors.admin.page;
    const states = [['homepage', '/', '今日服務工作台'], ['cases', '/cases', '個案'], ['case-detail', '/cases/' + fixture.mainCase.id, fixture.mainCase.name], ['case-form', '/cases', '個案'], ['shifts', '/shifts', '班表'], ['service-review', '/records', '服務紀錄與核閱'], ['employees', '/employees', '員工管理'], ['reports', '/reports', '報表中心']];
    for (const [device, viewport] of [['desktop', desktop], ['mobile', mobile]]) {
      await resize(page, viewport);
      for (const [name, route, heading] of states) {
        await load(page, route, heading); assert.equal(await page.locator('.error-state').count(), 0, name + ': no route error');
        if (name === 'case-form') {
          const trigger = page.getByRole('button', { name: '新增個案', exact: true }); await trigger.click(); const modal = page.getByRole('dialog', { name: '新增個案', exact: true }); await modal.getByLabel(/^案號/).waitFor();
          await shot(page, name + '-' + device + '.png'); await closeDialog(page, modal, trigger);
        } else await shot(page, name + '-' + device + '.png');
      }
    }
  });
  assert.equal(screenshots.length, 16);
  mark('G2 sixteen before/after-comparable viewport screenshots with the same case/shift/personnel/report data and no writes');

  if (mode === 'after') {
    await readOnly('G3 all 48 routes and four role permission boundaries', async () => {
      for (const role of roles) {
        const page = actors[role].page; await resize(page, mobile);
        for (const [route, heading, navigationName] of routeDefinitions) {
          const baseRoute = route.startsWith('/cases/') ? '/cases' : route; const allowed = permitted(role, baseRoute);
          await load(page, route, allowed ? heading : null);
          if (allowed) assert.equal(await page.locator('.error-state').count(), 0, role + route + ': permitted page must read');
          else await page.getByRole('heading', { name: '您沒有這項操作權限', exact: true }).waitFor();
          const nav = page.locator('#sidebar .nav-link[data-route="' + baseRoute + '"]');
          assert.equal(await nav.count(), allowed ? 1 : 0); if (allowed) { assert.equal((await nav.textContent()).trim(), navigationName); assert.equal(await nav.getAttribute('aria-current'), 'page'); }
          routeChecks.push({ role, route, allowed, heading: allowed ? heading : '您沒有這項操作權限', navigationName });
          await geometry(page, role + ':' + route);
        }
      }
    }); mark(`G3 all ${routeChecks.length} role/route combinations preserve permitted page headings, names, metadata access and forbidden boundaries`);

    await readOnly('G4 six-width admin complete-route layout and native control sizing', async () => {
      const page = actors.admin.page;
      for (const width of widths) {
        await resize(page, { width, height: width < 1024 ? 844 : 1000 });
        for (const [route, heading] of routeDefinitions) { await load(page, route, heading); await geometry(page, 'admin:' + width + ':' + route); }
      }
    }); mark('G4 all 48 routes at 375/390/760/1023/1024/1440 stay within the document, retain table scrolling, 44px controls and labelled mobile 16px inputs');

    await readOnly('G5 role-aware finance homepage CTA', async () => {
      const page = actors.finance.page; await resize(page, mobile); await load(page, '/', '今日服務工作台');
      assert.equal(await page.getByRole('button', { name: '查看總班表', exact: true }).count(), 0);
      const trigger = page.getByRole('button', { name: '查看作業報表', exact: true }); await trigger.click(); await page.getByRole('heading', { name: '報表中心', exact: true, level: 1 }).waitFor(); await settle(page);
      assert.equal(new URL(page.url()).hash, '#/reports'); assert.equal(await page.locator('.error-state').count(), 0);
      interactionChecks.push({ kind: 'finance-primary-CTA', route: '/reports', forbiddenShiftsAvoided: true });
    }); mark('G5 finance homepage primary action reaches its permitted reports without forbidden shifts');

    await readOnly('G6 local decorative SVG nav names and unique current route', async () => {
      for (const role of roles) {
        const page = actors[role].page; await resize(page, desktop); await load(page, '/', '今日服務工作台');
        const nav = await page.locator('.nav-link,.mobile-nav-link').evaluateAll(nodes => nodes.map(node => ({ route: node.dataset.route, name: node.querySelector('.nav-text')?.textContent.trim(), icons: [...node.querySelectorAll('svg')].map(icon => ({ hidden: icon.getAttribute('aria-hidden'), focusable: icon.getAttribute('focusable') })), current: node.getAttribute('aria-current') })));
        assert(nav.length > 0); for (const item of nav) { const definition = routeDefinitions.find(row => row[0] === item.route); assert(definition && permitted(role, item.route)); assert.equal(item.name, definition[2]); assert.equal(item.icons.length, 1); assert.deepEqual(item.icons[0], { hidden: 'true', focusable: 'false' }); }
        assert.equal(nav.filter(item => item.current === 'page' && item.route === '/').length, 2);
        navigationChecks.push({ role, links: nav });
      }
    }); mark('G6 local decorative nav SVGs are hidden from assistive names; permitted text and current-route markers retained');

    await readOnly('G7 modal menu keyboard, inert background, Escape and trigger focus', async () => {
      const page = actors.admin.page; await resize(page, mobile); await load(page, '/cases', '個案');
      const trigger = page.getByRole('button', { name: '選單', exact: true }); await trigger.focus(); await page.keyboard.press('Enter');
      const modal = page.getByRole('dialog', { name: '功能選單', exact: true }); await modal.locator('#sidebar .nav-link').first().waitFor();
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true'); assert.equal(await page.locator('#sidebar').count(), 1);
      await page.locator('#organization').evaluate(node => node.focus()); assert.equal(await page.locator('#organization').evaluate(node => document.activeElement === node), false, 'Background is inert');
      const focusPath = [];
      for (let i = 0; i < 24; i++) { await page.keyboard.press('Tab'); const result = await page.evaluate(() => ({ name: document.activeElement?.textContent.trim().slice(0, 80), inDialog: Boolean(document.activeElement?.closest('dialog[open]')), inBackground: Boolean(document.activeElement?.closest('.workspace')) })); assert.equal(result.inBackground, false); focusPath.push(result); }
      await geometry(page, 'menu-mobile');
      const printElement = await modal.elementHandle(); assert(printElement); await page.emulateMedia({ media: 'print' });
      const printDisplay = await printElement.evaluate(node => getComputedStyle(node).display); assert.equal(printDisplay, 'none', 'Native navigation drawer must be absent from print');
      await page.emulateMedia({ media: 'screen' }); await settle(page); assert.equal(await printElement.evaluate(node => node.open), true); await printElement.dispose();
      await closeDialog(page, modal, trigger);
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false'); assert.equal(await page.locator('.layout > #sidebar').count(), 1);
      await page.getByRole('button', { name: '更多功能', exact: true }).click(); const moreModal = page.getByRole('dialog', { name: '功能選單', exact: true }); const element = await moreModal.elementHandle(); assert(element); await moreModal.getByRole('link', { name: '員工管理', exact: true }).click();
      await page.waitForFunction(node => !node.isConnected, element); await element.dispose();
      await page.getByRole('heading', { name: '員工管理', exact: true, level: 1 }).waitFor(); await settle(page);
      interactionChecks.push({ kind: 'menu-keyboard-inert-Escape-focus-navigation', focusPath, printDisplay, route: '/employees' });
    }); mark('G7 canonical menu and more navigation keep background inert, keyboard focus enclosed, Escape restoration and same-owner route close');

    await readOnly('G8 native form invalid input and dirty-preserve cancellation', async () => {
      const page = actors.admin.page; await resize(page, mobile); await load(page, '/cases', '個案');
      const trigger = page.getByRole('button', { name: '新增個案', exact: true }); await trigger.click();
      const modal = page.getByRole('dialog', { name: '新增個案', exact: true }); await modal.getByLabel(/^案號/).waitFor();
      await modal.getByLabel(/^姓名/).first().fill('合成未儲存輸入');
      const writesBefore = requests.filter(item => new URL(item.url).pathname === '/api/cases' && item.method === 'POST').length;
      await modal.getByRole('button', { name: '儲存', exact: true }).click();
      assert.equal(await modal.locator('form').evaluate(node => node.checkValidity()), false);
      assert.equal(requests.filter(item => new URL(item.url).pathname === '/api/cases' && item.method === 'POST').length, writesBefore);
      assert.equal(await modal.getByLabel(/^姓名/).first().inputValue(), '合成未儲存輸入'); await geometry(page, 'new-case-mobile-invalid');
      await page.keyboard.press('Escape'); const confirm = page.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true }); await confirm.getByRole('button', { name: '取消', exact: true }).click();
      await page.waitForFunction(() => ![...document.querySelectorAll('dialog')].some(node => node.querySelector('h2')?.textContent === '放棄未儲存的內容？'));
      assert.equal(await modal.getByLabel(/^姓名/).first().inputValue(), '合成未儲存輸入');
      await page.keyboard.press('Escape'); const confirmAgain = page.getByRole('dialog', { name: '放棄未儲存的內容？', exact: true }); const element = await modal.elementHandle(); const triggerElement = await trigger.elementHandle();
      await confirmAgain.getByRole('button', { name: '放棄修改', exact: true }).click(); await page.waitForFunction(node => !node.isConnected, element); await page.waitForFunction(node => document.activeElement === node, triggerElement); await element.dispose(); await triggerElement.dispose();
      interactionChecks.push({ kind: 'invalid-no-POST-dirty-preserved-discard-focus', input: '合成未儲存輸入' });
    }); mark('G8 invalid form cannot write; Escape cancel retains draft and explicit discard restores trigger focus');

    await readOnly('G9 real search, no-results and explicit clear', async () => {
      const page = actors.admin.page; await resize(page, mobile); await load(page, '/cases', '個案');
      const search = page.getByRole('searchbox', { name: '個案搜尋', exact: true }); await search.fill('合成不存在的姓名 VISUAL-NO-MATCH'); await search.press('Enter');
      await page.getByText('找不到符合條件的資料，請調整搜尋或篩選。', { exact: true }).waitFor(); await settle(page); assert.equal(await page.getByRole('link', { name: '查看個案', exact: true }).count(), 0);
      await page.getByRole('button', { name: '清除個案搜尋', exact: true }).click(); await page.getByRole('link', { name: '查看個案', exact: true }).first().waitFor(); await settle(page);
      assert.equal(await search.inputValue(), ''); assert.equal(await search.evaluate(node => document.activeElement === node), true); assert.equal(await page.getByRole('button', { name: '清除個案搜尋', exact: true }).isVisible(), false);
      interactionChecks.push({ kind: 'search-no-results-clear', count: await page.getByRole('link', { name: '查看個案', exact: true }).count() });
    }); mark('G9 search/no-results/clear keeps data and accessible focus intact');

    await readOnly('G10 true empty organization page', async () => {
      const page = actors.admin.page; await load(page, '/cases', '個案'); await page.getByLabel('目前機構', { exact: true }).selectOption(fixture.emptyOrgId);
      await page.getByText('目前沒有資料。', { exact: true }).waitFor(); await settle(page); await geometry(page, 'empty-case-mobile');
      assert.equal(await page.getByRole('link', { name: '查看個案', exact: true }).count(), 0);
      await page.getByLabel('目前機構', { exact: true }).selectOption(fixture.orgId); await page.getByRole('link', { name: '查看個案', exact: true }).first().waitFor(); await settle(page);
      interactionChecks.push({ kind: 'empty-org-switch-and-recover', emptyOrgId: fixture.emptyOrgId });
    }); mark('G10 actual empty organization and restored populated list remain operable without writes');

    await readOnly('G11 one exact 503 and manual retry without data loss', async () => {
      const page = actors.admin.page; let used = false, capturedUrl;
      const pattern = base + '/api/cases?*';
      const handler = async route => {
        if (used || route.request().method() !== 'GET') return route.continue();
        const url = new URL(route.request().url()); assert.equal(url.pathname, '/api/cases'); assert.equal(url.searchParams.get('page'), '1'); assert.equal(url.searchParams.get('pageSize'), '25'); assert.equal(url.searchParams.get('q'), null);
        used = true; capturedUrl = url.href; expectedFailures.push({ id: 'G11-exact-case-list-503', phase: stage, url: capturedUrl, method: 'GET', status: 503, count: 1, maxConsoleCount: 1 });
        await route.fulfill({ status: 503, contentType: 'application/json', body: json({ error: { code: 'SYNTHETIC_TEMPORARY', message: '合成測試暫時無法讀取，請重新讀取。' } }) });
      };
      await page.route(pattern, handler); await load(page, '/cases'); await page.getByRole('heading', { name: '資料暫時無法取得', exact: true }).waitFor(); await page.getByText('合成測試暫時無法讀取，請重新讀取。', { exact: true }).waitFor(); await geometry(page, 'case-error-mobile');
      await page.unroute(pattern, handler); const retry = page.getByRole('button', { name: '重新讀取', exact: true }); await retry.click(); await page.getByRole('link', { name: '查看個案', exact: true }).first().waitFor(); await settle(page);
      assert(used && capturedUrl); interactionChecks.push({ kind: 'exact-503-manual-retry', url: capturedUrl });
    }); mark('G11 controlled one-case-list 503 displays usable error and manual retry restores original data');

    await readOnly('G12 reduced-motion keyboard skip target and shell contracts', async () => {
      const page = actors.admin.page; await resize(page, desktop); await load(page, '/', '今日服務工作台');
      await page.getByRole('link', { name: '跳至主要內容', exact: true }).focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('#main-content').evaluate(node => document.activeElement === node), true);
      await settle(page); await page.getByRole('heading', { name: '今日服務工作台', exact: true, level: 1 }).waitFor();
      const result = await page.evaluate(() => ({ reduced: matchMedia('(prefers-reduced-motion:reduce)').matches, bodyBackground: getComputedStyle(document.body).backgroundColor, brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(), sidebarWidth: document.querySelector('#sidebar').getBoundingClientRect().width, topbarHeight: document.querySelector('.topbar').getBoundingClientRect().height, activeOutline: getComputedStyle(document.activeElement).outlineStyle, fonts: getComputedStyle(document.querySelector('h1')).fontFamily, runningAnimations: document.getAnimations().filter(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().duration > 1).length }));
      assert.equal(result.reduced, true); assert.equal(result.brand, '#EA880C'); assert.equal(result.bodyBackground, 'rgb(247, 243, 236)'); assert.equal(result.sidebarWidth, 300); assert.equal(result.topbarHeight, 82); assert(result.fonts.includes('Noto Sans TC')); assert.equal(result.runningAnimations, 0);
      interactionChecks.push({ kind: 'reduced-motion-keyboard-skip-shell', ...result });
    }); mark('G12 keyboard skip and reduced motion keep APM brand, desktop shell and original focus owner');
  }

  stage = 'final exact verification';
  assert.deepEqual(raw(), savedRowsBefore, 'All business records, full version/audit tables, sessions, BLOBs and approved snapshots unchanged by reads');
  assert.deepEqual(portableRows(), fixture.tables, 'Same synthetic rows as the before fixture');
  for (let i = 0; i < stateLedger.length; i++) { assert.equal(stateLedger[i].sequence, i + 1); if (i) assert.equal(stateLedger[i].beforeSha256, stateLedger[i - 1].afterSha256); }
  assert.deepEqual(externalRequests, []); assert.deepEqual(pageErrors, []); assert.deepEqual(failedRequests, []);
  assert.equal(responses.length, expectedFailures.length);
  for (const rule of expectedFailures) { const failures = responses.filter(response => response.expectedRuleId === rule.id); assert.equal(failures.length, rule.count); rule.actualFailureCount = failures.length; rule.actualConsoleCount = 0; }
  for (const message of consoleErrors) {
    const rule = expectedFailures.find(rule => rule.phase === message.phase && rule.url === message.location.url && new RegExp('status of ' + rule.status).test(message.text) && rule.actualConsoleCount < rule.maxConsoleCount);
    assert(rule, 'Unassigned console error: ' + json(message)); rule.actualConsoleCount++;
  }
  const sourceHashesAfter = await sourceMap(sourceRoot); assert.deepEqual(sourceHashesAfter, sourceHashesBefore);
  const testSha256 = sha(await readFile(fileURLToPath(import.meta.url)));
  const report = { passed: true, mode, syntheticOnly: true, database: ':memory:', randomLoopback: true, base, fixture: { path: fixturePath, sha256: sha(await readFile(fixturePath)), exactRowsSha256: sha(fixture.tables), serviceDate: fixture.serviceDate }, sourceRoot, consumedTest: { path: fileURLToPath(import.meta.url), sha256: testSha256 }, sourceHashesBefore, sourceHashesAfter, sourceCount: Object.keys(sourceHashesBefore).length, runtimeSourceCount: Object.keys(sourceHashesBefore).filter(file => /^(public|src)\//.test(file)).length, checks, routeChecks, layoutChecks, touchChecks, inputChecks, navigationChecks, interactionChecks, readSegments, fixtureWrites, stateLedger, screenshots, requests, responses, failedRequests, consoleErrors, pageErrors, expectedFailures, externalRequests, protectedRowsAndBlobsUnchanged: true, snapshotUnchanged: true, expectedConsoleErrorsOnly: true, actuallyViewedByScript: false, visualReviewPending: true, limitation: mode === 'before' ? 'Baseline capture records old geometry; it does not apply refreshed visual acceptance to old source.' : 'Screenshots require external actual pixel review; geometry and interactions independently verified.' };
  const reportPath = path.join(output, 'e2e.json'); await writeFile(reportPath, json(report) + '\n', { flag: 'wx' }); console.log('RESULT ' + reportPath);
} catch (error) {
  console.error(error.stack || error.message);
  const failurePath = path.join(output, 'failure.png'); if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: failurePath, fullPage: false }).catch(() => {});
  const sourceHashesAfter = await sourceMap(sourceRoot).catch(() => null);
  await writeFile(path.join(output, 'failure.json'), json({ passed: false, mode, phase: stage, error: error.stack || String(error), checks, routeChecks, layoutChecks, touchChecks, inputChecks, navigationChecks, interactionChecks, fixturePath, fixtureWrites, readSegments, stateLedger, screenshots, requests, responses, failedRequests, consoleErrors, pageErrors, expectedFailures, externalRequests, sourceHashesBefore, sourceHashesAfter, consumedTest: { path: fileURLToPath(import.meta.url), sha256: sha(await readFile(fileURLToPath(import.meta.url))) }, actuallyViewedByScript: false, visualReviewPending: true }) + '\n', { flag: 'wx' });
  process.exitCode = 1;
} finally { await browser?.close(); await app.close(); }
