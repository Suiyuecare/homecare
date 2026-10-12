import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureLegacyArchive } from '../../src/server/legacy-migration-archive.mjs';
import { LEGACY_HISTORY_FORMAT, createVerifiedLegacyHistorySource, legacyHistorySourceHash, previewLegacyHistoryImport, commitLegacyHistoryImport } from '../../src/server/legacy-history-import.mjs';

// Synthetic JSON source only. Locators refer to the actual original rows array.
// This helper never initializes a DB or grants an account/membership.
export function createSyntheticLegacyHistoryFixture(db, ctx, { count = 2, columnCount = 2, commit = false, caseId = null, employeeId = null } = {}) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000 || !Number.isSafeInteger(columnCount) || columnCount < 1 || columnCount > 500) throw new Error('SYNTHETIC_HISTORY_FIXTURE_INVALID');
  const rootPath = mkdtempSync(path.join(realpathSync(tmpdir()), 'homecare-synthetic-history-'));
  const incomingPath = path.join(rootPath, 'incoming'), outputParent = path.join(rootPath, 'archives');
  mkdirSync(incomingPath, { mode: 0o700 }); mkdirSync(outputParent, { mode: 0o700 });
  const records = Array.from({ length: count }, (_, index) => ({
    category: index % 2 === 0 ? 'service-export' : 'employee-profile', reportingPeriod: index % 3 === 2 ? null : '2020-0' + (index % 2 + 1),
    sourceNativeId: index % 2 === 0 ? null : '合成原始識別-' + index, sourceCreatedAt: index % 2 === 0 ? '' : '原文109年2月3日', caseId, employeeId,
    sourceFileId: 'file-00000001', locator: { kind: 'json-pointer', pointer: '/rows/' + index },
    columns: Array.from({ length: columnCount }, (_, column) => ({ columnIndex: column + 1, label: column < 2 ? '重複欄名' : '合成欄位-' + (column + 1),
      raw: column % 6 === 0 ? '  合成原文\r\n單獨\r尾端\u0000之後 ' + index : column % 6 === 1 ? '' : column % 6 === 2 ? null : column % 6 === 3 ? false : column % 6 === 4 ? 1.25 : index,
      formula: column === 0 ? '=HYPERLINK("https://synthetic.example.test","僅留原文")' : null,
      cached: column % 4 === 0 ? null : column % 4 === 1 ? true : column % 4 === 2 ? 2.5 : ' 合成快取 ' })),
  }));
  const original = Buffer.from(JSON.stringify({ rows: records }));
  writeFileSync(path.join(incomingPath, 'synthetic.json'), original, { mode: 0o600 });
  const capture = captureLegacyArchive({ inputPath: incomingPath, outputParent, scope: {
    format: 'suiyue-legacy-export-scope-v1', provider: 'synthetic', tenant: 'synthetic-tenant', exportedAt: '2020-01-02T03:04:05.000Z',
    datasets: [{ id: 'synthetic-history', sourceFiles: ['synthetic.json'], sourceRowCount: count, reportedCoverage: 'partial', range: { kind: 'unknown' } }],
    missingDatasets: ['synthetic-attachments'], unresolved: ['synthetic-no-business-conversion'],
  } });
  const archivePath = path.join(outputParent, capture.archiveId), capability = createVerifiedLegacyHistorySource({ archivePath, expectedManifestSha256: capture.manifestSha256 });
  const sourceFiles = [{ fileId: 'file-00000001', sha256: createHash('sha256').update(original).digest('hex') }];
  const payload = { format: LEGACY_HISTORY_FORMAT, provider: 'synthetic', tenant: 'synthetic-tenant', archiveManifestSha256: capture.manifestSha256, sourceFiles,
    sourceHash: legacyHistorySourceHash({ provider: 'synthetic', tenant: 'synthetic-tenant', sourceFiles, records }), records };
  const sourcePath = path.join(rootPath, 'source.json'); writeFileSync(sourcePath, JSON.stringify(payload), { mode: 0o600 }); original.fill(0);
  const result = { rootPath, incomingPath, archivePath, sourcePath, capture, capability, payload, cleanup: () => rmSync(rootPath, { recursive: true }) };
  if (commit) { const preview = previewLegacyHistoryImport(db, ctx, payload, capability); result.receipt = commitLegacyHistoryImport(db, ctx, payload, capability, preview.previewHash); }
  return result;
}
