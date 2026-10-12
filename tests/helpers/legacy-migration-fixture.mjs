import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureLegacyArchive } from '../../src/server/legacy-migration-archive.mjs';
import { createVerifiedLegacyImportSource, legacyOperationalSourceHash, legacyOperationalId, legacyDerivedBusinessNo, previewLegacyOperationalImport, commitLegacyOperationalImport } from '../../src/server/legacy-operational-import.mjs';

// Synthetic data only. No real source, account binding, credentials or grants.
export function createSyntheticLegacyMigrationFixture(db, ctx, { count = 2, commit = false } = {}) {
  const rootPath = mkdtempSync(path.join(realpathSync(tmpdir()), 'homecare-synthetic-operational-'));
  const incomingPath = path.join(rootPath, 'incoming'), outputParent = path.join(rootPath, 'archives');
  mkdirSync(incomingPath, { mode: 0o700 }); mkdirSync(outputParent, { mode: 0o700 });
  const original = Buffer.from('source,synthetic-only\r\n000000000000000000000001,合成封存原文\r\n');
  writeFileSync(path.join(incomingPath, 'synthetic.csv'), original, { mode: 0o600 });
  const capture = captureLegacyArchive({ inputPath: incomingPath, outputParent, scope: {
    format: 'suiyue-legacy-export-scope-v1', provider: 'synthetic', tenant: 'synthetic-tenant', exportedAt: '2020-01-02T03:04:05.000Z',
    datasets: [{ id: 'synthetic-operational', sourceFiles: ['synthetic.csv'], sourceRowCount: count, reportedCoverage: 'partial', range: { kind: 'unknown' } }],
    missingDatasets: ['synthetic-history'], unresolved: ['synthetic-no-attachments'],
  } });
  const archivePath = path.join(outputParent, capture.archiveId), capability = createVerifiedLegacyImportSource({ archivePath, expectedManifestSha256: capture.manifestSha256 });
  const sourceFiles = [{ fileId: 'file-00000001', sha256: createHash('sha256').update(original).digest('hex') }];
  const payload = { format: 'suiyue-legacy-operational-import-v1', provider: 'synthetic', tenant: 'synthetic-tenant', archiveManifestSha256: capture.manifestSha256, sourceFiles,
    sourceHash: legacyOperationalSourceHash({ provider: 'synthetic', tenant: 'synthetic-tenant', sourceFiles }), records: [] };
  for (let index = 0; index < count; index++) {
    const sourceId = (index + 1).toString(16).padStart(24, '0'), entity = index % 2 === 0 ? 'employees' : 'cases';
    const data = entity === 'employees' ? { name: '合成員工' + (index + 1), employeeNo: index === 0 ? legacyDerivedBusinessNo(payload.provider, sourceId) : 'SYN-MIG-E-' + (index + 1), status: 'active', role: '來源職稱僅供記錄' } :
      { name: '合成個案' + (index + 1), caseNo: 'SYN-MIG-C-' + (index + 1), status: 'active', birthDate: '1950-01-02', note: ' 原始操作備註\r\n留存 ', supervisorId: legacyOperationalId(ctx.orgId, payload.provider, payload.tenant, 'employees', '000000000000000000000001') };
    payload.records.push({ entity, sourceId, sourceCreatedAt: index === 0 ? '' : '民國109年1月2日原文', businessNoOrigin: index === 0 ? 'derived' : 'source', data,
      sourceFileId: 'file-00000001', rowNumber: index + 2, columns: [
        { columnIndex: 1, label: '重複欄名', raw: '  首行\r\n單獨\r尾端\u0000之後 ', formula: '=HYPERLINK("https://synthetic.example.test","合成公式")', cached: ' 合成快取 ' },
        { columnIndex: 2, label: '重複欄名', raw: index === 0 ? '' : null, formula: null, cached: false },
      ] });
  }
  const sourcePath = path.join(rootPath, 'source.json'); writeFileSync(sourcePath, JSON.stringify(payload), { mode: 0o600 });
  const result = { rootPath, incomingPath, archivePath, sourcePath, capture, capability, payload, cleanup: () => rmSync(rootPath, { recursive: true }) };
  if (commit) { const preview = previewLegacyOperationalImport(db, ctx, payload, capability); result.receipt = commitLegacyOperationalImport(db, ctx, payload, capability, preview.previewHash); }
  return result;
}
