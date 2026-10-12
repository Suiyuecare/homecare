#!/usr/bin/env node
import { readSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createProductionBackup, verifyProductionBackup, restoreProductionBackupIsolated,
  prepareProductionRecoveryReconciliation, readProductionEncryptionKeyFile,
  ProductionBackupError,
} from '../src/server/production-backup.mjs';

const OPERATIONS = Object.freeze({
  backup: { required: ['database', 'output'], optional: ['max-bytes'], key: true },
  verify: { required: ['backup'], optional: ['max-bytes'], key: true },
  'restore-isolated': { required: ['backup', 'destination'], optional: ['max-bytes'], key: true },
  'prepare-reconcile': { required: ['destination'], optional: ['authority-database', 'max-bytes'], key: false },
});
const USAGE = 'Use backup, verify, restore-isolated, or prepare-reconcile with explicit private paths. Encryption keys are read only from --key-file or piped --key-stdin; live replacement and activation are unsupported.';
function parse(args) {
  const [operation, ...tokens] = args, spec = OPERATIONS[operation];
  if (!spec) throw new ProductionBackupError('INVALID_ARGUMENT');
  const allowed = [...spec.required, ...spec.optional, ...(spec.key ? ['key-file', 'key-stdin'] : [])], values = {};
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (!token.startsWith('--') || token.includes('=') || !allowed.includes(token.slice(2)) || Object.hasOwn(values, token.slice(2))) throw new ProductionBackupError('INVALID_ARGUMENT');
    const name = token.slice(2);
    if (name === 'key-stdin') values[name] = true;
    else {
      const value = tokens[++at];
      if (!value || value.startsWith('--')) throw new ProductionBackupError('INVALID_ARGUMENT');
      values[name] = value;
    }
  }
  if (spec.required.some(k => !Object.hasOwn(values, k)) || (spec.key && Number(Object.hasOwn(values, 'key-file')) + Number(Object.hasOwn(values, 'key-stdin')) !== 1)) throw new ProductionBackupError('INVALID_ARGUMENT');
  if (Object.hasOwn(values, 'max-bytes')) {
    if (!/^[1-9][0-9]*$/.test(values['max-bytes'])) throw new ProductionBackupError('INVALID_ARGUMENT');
    values['max-bytes'] = Number(values['max-bytes']);
  }
  return { operation, values };
}
function stdinKey(input) {
  if (input.isTTY || typeof input.fd !== 'number') throw new ProductionBackupError('KEY_INVALID');
  const bytes = Buffer.alloc(33); let count = 0;
  try {
    while (count < bytes.length) {
      const n = readSync(input.fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count !== 32) throw new ProductionBackupError('KEY_INVALID');
    return Buffer.from(bytes.subarray(0, 32));
  } finally { bytes.fill(0); }
}

export async function productionBackupCli(args, { input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
  let key;
  try {
    const { operation, values: v } = parse(args);
    if (v['key-file']) key = readProductionEncryptionKeyFile(v['key-file']);
    else if (v['key-stdin']) key = stdinKey(input);
    const maxBytes = v['max-bytes']; let result;
    if (operation === 'backup') result = await createProductionBackup({ databasePath: v.database, outputPath: v.output, key, ...(maxBytes === undefined ? {} : { maxBytes }) });
    else if (operation === 'verify') result = await verifyProductionBackup({ backupPath: v.backup, key, ...(maxBytes === undefined ? {} : { maxBytes }) });
    else if (operation === 'restore-isolated') result = await restoreProductionBackupIsolated({ backupPath: v.backup, destinationDirectory: v.destination, key, ...(maxBytes === undefined ? {} : { maxBytes }) });
    else result = await prepareProductionRecoveryReconciliation({ destinationDirectory: v.destination, ...(v['authority-database'] === undefined ? {} : { authorityDatabasePath: v['authority-database'] }), ...(maxBytes === undefined ? {} : { maxBytes }) });
    // Fixed, bounded result fields: no paths, plaintext keys, rows, identities,
    // passwords, signing configuration, SQL or exception details are reflected.
    output.write(JSON.stringify(result) + '\n'); return 0;
  } catch (error) {
    const code = error instanceof ProductionBackupError ? error.code : 'OPERATION_FAILED';
    errorOutput.write(JSON.stringify({ ok: false, code, message: error instanceof ProductionBackupError ? error.message : 'Production backup operation failed.' }) + '\n');
    if (code === 'INVALID_ARGUMENT') errorOutput.write(USAGE + '\n');
    return code === 'INVALID_ARGUMENT' ? 2 : 1;
  } finally { key?.fill(0); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await productionBackupCli(process.argv.slice(2));
}
