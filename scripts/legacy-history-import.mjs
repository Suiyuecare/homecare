import { closeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { sourceLease, openPrivateRead, readExact } from '../src/server/production-backup-storage.mjs';
import { parseLegacyJson } from '../src/server/legacy-migration-archive-metadata.mjs';
import { LEGACY_HISTORY_MAX_BYTES, createVerifiedLegacyHistorySource, previewLegacyHistoryImport, commitLegacyHistoryImport } from '../src/server/legacy-history-import.mjs';
import { legacyUuid, legacyDigest } from '../src/server/legacy-history-format.mjs';

const codes = new Set(['ROLE_FORBIDDEN', 'ACCOUNT_STATE_INVALID', 'LEGACY_HISTORY_INVALID', 'LEGACY_HISTORY_DUPLICATE', 'LEGACY_HISTORY_ARCHIVE_INVALID',
  'LEGACY_HISTORY_STATE_INVALID', 'LEGACY_HISTORY_SOURCE_CONFLICT', 'LEGACY_HISTORY_EXISTING',
  'LEGACY_HISTORY_PREVIEW_REQUIRED', 'LEGACY_HISTORY_PREVIEW_STALE', 'LEGACY_HISTORY_TRANSACTION_ACTIVE', 'LEGACY_HISTORY_FAILED']);
function argumentError() { const error = new Error(); error.code = 'LEGACY_HISTORY_ARGUMENTS_INVALID'; throw error; }
export function parseLegacyHistoryArguments(args) {
  const [operation, ...values] = args;
  if (!['preview', 'commit'].includes(operation) || values.length % 2) argumentError();
  const required = ['--source', '--db', '--org-id', '--actor-id', '--archive', '--expected-manifest-sha256', ...(operation === 'commit' ? ['--preview-hash'] : [])];
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index], value = values[index + 1];
    if (!required.includes(key) || Object.hasOwn(result, key) || typeof value !== 'string' || !value || value.startsWith('--')) argumentError(); result[key] = value;
  }
  if (required.some(key => !Object.hasOwn(result, key)) || !legacyUuid(result['--org-id']) || !legacyUuid(result['--actor-id']) || !legacyDigest(result['--expected-manifest-sha256']) ||
      operation === 'commit' && !legacyDigest(result['--preview-hash'])) argumentError();
  return { operation, values: result };
}
export function executeLegacyHistoryImport(args) {
  const { operation, values } = parseLegacyHistoryArguments(args);
  let database, input;
  try {
    const read = openPrivateRead(values['--source'], LEGACY_HISTORY_MAX_BYTES);
    try { input = readExact(read.fd, read.size, 0); read.verify(); } finally { closeSync(read.fd); }
    const payload = parseLegacyJson(input, LEGACY_HISTORY_MAX_BYTES);
    const lease = sourceLease(values['--db']);
    const capability = createVerifiedLegacyHistorySource({ archivePath: values['--archive'], expectedManifestSha256: values['--expected-manifest-sha256'] });
    database = new DatabaseSync(lease.path, { readOnly: operation === 'preview', enableForeignKeyConstraints: true, allowExtension: false });
    lease.verify();
    // No initDb, schema repair, baseline history, journal-mode change, account
    // creation or rate defaults. Both operations require an existing actor.
    const ctx = { orgId: values['--org-id'], user: { id: values['--actor-id'] }, role: 'admin' };
    return operation === 'preview' ? previewLegacyHistoryImport(database, ctx, payload, capability) :
      commitLegacyHistoryImport(database, ctx, payload, capability, values['--preview-hash']);
  } finally { if (input) input.fill(0); if (database) database.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify({ status: 'confirmed', ...executeLegacyHistoryImport(process.argv.slice(2)) }) + '\n'); }
  catch (error) {
    const code = error?.code === 'LEGACY_HISTORY_ARGUMENTS_INVALID' ? error.code : codes.has(error?.code) ? error.code : 'LEGACY_HISTORY_OPERATOR_FAILED';
    const recordIndex = Number.isSafeInteger(error?.fields?.recordIndex) && error.fields.recordIndex > 0 && error.fields.recordIndex <= 1000 ? error.fields.recordIndex : undefined;
    process.stderr.write(JSON.stringify({ status: 'failed', code, ...(recordIndex ? { recordIndex } : {}) }) + '\n'); process.exitCode = 1;
  }
}
