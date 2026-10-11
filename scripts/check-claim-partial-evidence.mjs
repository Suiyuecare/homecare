import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// Emit a closed success receipt, never the browser request body or private log.
const root = 'outputs/software/claim-partial-reconciliation-qa';
const expectedGates = [
  '原生結果選單可鍵盤聚焦，明確選項與原額／差額唯讀、累計可編輯',
  '部分核付缺說明／零額拒絕、聚焦修正欄、輸入保留且零寫入',
  'malformed 2xx／錯機構 ACK 均不顯保存成功，改輸入旋轉鍵且保留金額',
  '同 payload 原鍵重送取得精確原 ACK，零重複寫入／不累加；差額未確認不可結案',
  'v2 CSV 含精確原额／累計／差額與非付款說明、匯出零寫入',
  '390px 累計修改取代單筆 4001→5001，不當成新增收款，欄位／動作不溢出',
  '部分核付版本有原額／累計／差額與前版歷程，型別化唯讀零寫入',
  '多人 CAS 衝突保留輸入且不覆寫他人累計核付',
  '只有明確全額回應才能確認結案，取消確認零寫入，舊 v1 匯出與原帳單保持',
  '切離頁面中止舊表單 owner，晚回應不開 dialog／顯成功且零寫入',
  '四角色入口/API一致；財務停用後保存拒絕並保留输入，重讀真 denied，切身份清空舊 owner',
];
const expectedImages = [
  'partial-editor-1440.png', 'unknown-ack-preserves-1440.png', 'partial-details-1440.png',
  'partial-editor-390.png', 'partial-details-390.png', 'partial-history-390.png',
  'partial-history-1440.png', 'conflict-preserves-1440.png', 'explicit-full-closed-1440.png',
];
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
assert.equal((await lstat(root)).isDirectory(), true);
const attempts = await readdir(root);
assert.equal(attempts.length, 1, 'CI requires exactly one fresh partial reconciliation attempt');
assert.match(attempts[0], /^attempt-[A-Za-z0-9]+$/);
const directory = path.join(root, attempts[0]);
assert.equal((await lstat(directory)).isDirectory(), true);
assert.deepEqual((await readdir(directory)).sort(), ['result.json', ...expectedImages].sort());
const report = path.join(directory, 'result.json').split(path.sep).join('/');
const stat = await lstat(report);
assert.equal(stat.isFile(), true); assert(stat.size > 0 && stat.size < 1024 * 1024);
const bytes = await readFile(report), result = JSON.parse(bytes);
keys(result, ['outcome', 'syntheticOnly', 'gates', 'screenshots', 'errors', 'trace']);
assert.equal(result.outcome, 'passed'); assert.equal(result.syntheticOnly, true);
assert.deepEqual(result.errors, []); assert.deepEqual(result.gates, expectedGates);
assert.deepEqual(result.screenshots, expectedImages);
assert(Array.isArray(result.trace) && result.trace.length > 0 && result.trace.length < 100);
for (const item of result.trace) {
  keys(item, ['stage', 'url', 'method']);
  assert(['setup', 'partial editable and readonly preview', 'validation',
    'malformed success and key rotation', 'same key retry', 'export',
    'mobile cumulative edit', 'history', 'CAS conflict',
    'explicit full and closure', 'late navigation', 'four roles and revocation'].includes(item.stage));
  assert.equal(item.method, 'PATCH');
  assert.match(item.url, /^\/api\/claim-batches\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
}
for (const filename of expectedImages) {
  const imagePath = path.join(directory, filename), imageStat = await lstat(imagePath);
  assert.equal(imageStat.isFile(), true); assert(imageStat.size > 24 && imageStat.size < 10 * 1024 * 1024);
  const png = await readFile(imagePath);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.subarray(12, 16).toString(), 'IHDR');
  assert.equal(png.readUInt32BE(16), filename.includes('390') ? 390 : 1440);
  assert(png.readUInt32BE(20) > 0 && png.readUInt32BE(20) < 20000);
}
console.log('CLAIM_PARTIAL_EVIDENCE ' + JSON.stringify({ report,
  sha256: createHash('sha256').update(bytes).digest('hex'), gates: result.gates,
  screenshots: result.screenshots, outcome: result.outcome }));
