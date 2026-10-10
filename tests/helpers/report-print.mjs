import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/** QA-only native-print interception; product code must authorize each fresh print. */
export async function installReportPrintCapture(context) {
  await context.addInitScript(() => {
    window.__printCalls = [];
    window.print = () => {
      // Native printing dispatches this event synchronously while window.print runs.
      window.dispatchEvent(new Event('beforeprint'));
      try {
        if (document.body.classList.contains('print-suppressed')) {
          throw new Error('QA print capture refused: product beforeprint guard suppressed this request.');
        }
        const dialog = document.querySelector('.app-dialog-printable[open]');
        if (!dialog || !dialog.querySelector('tbody tr')) {
          throw new Error('QA print capture refused: no complete report is ready.');
        }
        window.__printCalls.push({
          at: Date.now(), capturedAt: new Date().toISOString(),
          text: dialog.querySelector('.dialog-body')?.textContent || '',
          html: `<!doctype html>${document.documentElement.outerHTML}`,
          baseURI: document.baseURI,
        });
      } finally {
        window.dispatchEvent(new Event('afterprint'));
      }
    };
  });
}

/**
 * Click the actual product print action (which re-fetches the report), then render
 * its synchronously captured DOM with its original CSS in a separate JS-disabled
 * page. This never bypasses the product's native beforeprint guard, and creates
 * exactly one QA PDF. The snapshot page cannot re-run app code or read live data.
 */
export async function renderCapturedReportPdf({ browser, page, path }) {
  const before = await page.evaluate(() => window.__printCalls.length);
  await page.getByRole('dialog').getByRole('button', { name: '列印／另存 PDF', exact: true }).click();
  await page.waitForFunction(count => window.__printCalls.length === count + 1, before);
  const capture = await page.evaluate(() => window.__printCalls.at(-1));
  assert.ok(capture.html && capture.baseURI && capture.text);
  assert.ok(!capture.html.includes('class="print-suppressed"'), 'Authorized capture cannot contain a suppressed document');
  const escapeAttribute = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const html = capture.html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<head(?:\s[^>]*)?>/i, match => `${match}<base href="${escapeAttribute(capture.baseURI)}">`);
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 1050 } });
  try {
    const snapshot = await context.newPage();
    await snapshot.emulateMedia({ media: 'print' });
    await snapshot.setContent(html, { waitUntil: 'networkidle' });
    await snapshot.evaluate(() => document.fonts.ready);
    assert.equal(await snapshot.locator('.app-dialog-printable[open]').count(), 1);
    assert.equal(await snapshot.locator('script').count(), 0);
    assert.ok(await snapshot.locator('.app-dialog-printable[open]').evaluate(node => getComputedStyle(node).position === 'static'), 'Original report print CSS loaded');
    await snapshot.pdf({ path, preferCSSPageSize: true, printBackground: true });
  } finally {
    await context.close();
  }
  return {
    method: 'authorized fresh product print → synchronous beforeprint-validated DOM capture → original CSS in JavaScript-disabled QA page',
    capturedAt: capture.capturedAt, sourceURL: capture.baseURI, captureIndex: before,
    capturedHTMLSha256: createHash('sha256').update(capture.html).digest('hex'),
    snapshotHTMLSha256: createHash('sha256').update(html).digest('hex'),
    javaScriptEnabled: false, applicationScriptsRemoved: true, baseURI: capture.baseURI,
    physicalPrinting: false, pdfCount: 1,
    note: 'QA PDF from the actual authorized fresh preview. This is synthetic validation evidence, not a formal form or a claim of physical printing.',
  };
}
