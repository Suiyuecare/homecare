import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server/index.mjs';

// Exercise the actual shared UI/CSS through a synthetic loopback server.
// No account, business write, private environment or persistent database is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'outputs/software/feedback-interaction-qa');
await mkdir(output, { recursive: true });
const { chromium } = createRequire(import.meta.url)('playwright');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = await readdir(cache).catch(() => []);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  ...installed.filter(x => /^chromium-/.test(x)).sort().reverse().map(x => path.join(cache, x, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(x => x && existsSync(x));
const app = createApp({ dbPath: ':memory:', port: 0 });
const base = await app.listen();
const checks = [], screenshots = [], pageErrors = [];
let browser;
const mark = value => { checks.push(value); console.log('PASS ' + value); };
try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  for (const width of [390, 1440]) for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(base);
    await page.waitForLoadState('networkidle');
    // App-owned common controls are exercised independently of business rules.
    await page.evaluate(async () => {
      const ui = await import('/ui.js');
      document.querySelector('#app').replaceChildren(ui.el('main', { id: 'feedback-fixture' }));
      const main = document.querySelector('#feedback-fixture');
      for (const variant of ['primary', 'outline', 'danger']) {
        const control = ui.button('儲存測試內容', () => {}, { variant, id: 'busy-' + variant });
        main.append(control);
      }
      window.feedbackUI = ui;
    });
    for (const variant of ['primary', 'outline', 'danger']) {
      const control = page.locator('#busy-' + variant);
      const observation = await control.evaluate(async node => {
        const before = node.getBoundingClientRect();
        // Let the original hover/colour settle before starting the busy state.
        await new Promise(resolve => setTimeout(resolve, 170));
        node.disabled = true; node.setAttribute('aria-busy', 'true');
        const frames = [];
        for (let i = 0; i < 5; i++) {
          await new Promise(requestAnimationFrame);
          const rect = node.getBoundingClientRect();
          frames.push({ color: getComputedStyle(node).color, width: rect.width, height: rect.height,
            overlay: getComputedStyle(node, '::after').content });
        }
        return { before: { width: before.width, height: before.height }, frames };
      });
      for (const frame of observation.frames) {
        assert.match(frame.color, /rgba\([^)]*,\s*0\)$/u, 'Old label must be invisible from the first painted busy frame');
        assert.equal(frame.overlay, '"處理中"');
        assert.equal(frame.width, observation.before.width);
        assert.equal(frame.height, observation.before.height);
      }
      await control.evaluate(node => { node.disabled = false; node.removeAttribute('aria-busy'); });
      await control.focus();
      await page.keyboard.press('Enter');
      assert.equal(await control.evaluate(node => document.activeElement === node), true);
    }
    mark(`${width}/${reducedMotion}: all three busy variants show one label without changing size`);
    await page.evaluate(() => {
      window.feedbackUI.toast('合成資料已保存');
      const toast = document.querySelector('.toast').getBoundingClientRect();
      const action = window.feedbackUI.button('繼續操作', () => { window.feedbackClicked = (window.feedbackClicked || 0) + 1; },
        { id: 'under-feedback', style: { position: 'fixed', left: toast.left + 'px', top: toast.top + 'px', width: toast.width + 'px', height: toast.height + 'px' } });
      document.querySelector('#feedback-fixture').append(action);
    });
    const action = page.locator('#under-feedback');
    const center = await action.evaluate(node => { const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, center), 'under-feedback', 'Status feedback must not intercept the next action');
    await page.mouse.click(center.x, center.y);
    assert.equal(await page.evaluate(() => window.feedbackClicked), 1);
    await action.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.feedbackClicked), 2);
    assert.equal(await page.locator('#toast-region').getAttribute('aria-live'), 'polite');
    assert.equal(await page.getByRole('status').last().textContent(), '合成資料已保存');
    mark(`${width}/${reducedMotion}: feedback stays announced while pointer and keyboard actions work`);
    const image = path.join(output, `feedback-${width}-${reducedMotion}.png`);
    await page.screenshot({ path: image }); screenshots.push(image);
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), 'rgb(255, 255, 255)', 'The print canvas, including the area after the last report row, must be white');
    mark(`${width}/${reducedMotion}: print canvas is white without changing screen background`);
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), 'rgb(247, 243, 236)');
    await context.close();
  }
  assert.deepEqual(pageErrors, []);
  mark('No browser errors or business records created');
  await writeFile(path.join(output, 'verification.json'), JSON.stringify({ checks, screenshots, pageErrors, actuallyViewedByScript: false }, null, 2));
} finally {
  await browser?.close();
  await app.close();
}
