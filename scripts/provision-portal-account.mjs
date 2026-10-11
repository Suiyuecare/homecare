import { DatabaseSync } from 'node:sqlite';
import { chmodSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { provisionPortalAccount } from '../src/server/portal-handoff.mjs';

const fields = Object.freeze({
  '--db-path': 'dbPath',
  '--organization-name': 'organizationName',
  '--name': 'name',
  '--email': 'email',
  '--issuer': 'issuer',
  '--google-subject': 'googleSubject',
  '--portal-auth-user-id': 'authUserId',
  '--role': 'role',
  '--employee-id': 'employeeId',
});

export function parseProvisionArguments(args) {
  if (!Array.isArray(args) || ![16, 18].includes(args.length)) throw new Error('PORTAL_PROVISION_ARGUMENTS_INVALID');
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const field = fields[args[i]], value = args[i + 1];
    if (!field || Object.hasOwn(result, field) || typeof value !== 'string' || !value || value.startsWith('--')) throw new Error('PORTAL_PROVISION_ARGUMENTS_INVALID');
    result[field] = value;
  }
  const required = Object.values(fields).filter(field => field !== 'employeeId');
  if (!required.every(field => Object.hasOwn(result, field)) || (result.role !== 'caregiver' && Object.hasOwn(result, 'employeeId')) || !path.isAbsolute(result.dbPath) || result.dbPath === ':memory:') throw new Error('PORTAL_PROVISION_ARGUMENTS_INVALID');
  return result;
}

// No default database, environment loading, password, email, network call or
// auto-detected organization. Operators supply the exact verified binding.
export function runProvision(args) {
  const { dbPath, ...input } = parseProvisionArguments(args);
  const stat = lstatSync(dbPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('PORTAL_PROVISION_DATABASE_INVALID');
  const db = new DatabaseSync(dbPath);
  try {
    // Connection-local settings precede BEGIN. Schema, baseline versions and
    // account changes then commit together; a rejection preserves journal mode.
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const result = provisionPortalAccount(db, input, { initializeSchema: true });
    chmodSync(dbPath, 0o600);
    return result;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(runProvision(process.argv.slice(2)))); }
  catch (error) {
    // Error messages from SQLite or files can contain private paths; arguments,
    // subjects, email and provider identity never enter the CLI result or log.
    const known = new Set(['PORTAL_PROVISION_ARGUMENTS_INVALID', 'PORTAL_PROVISION_DATABASE_INVALID', 'PORTAL_PROVISION_INVALID', 'PORTAL_PROVISION_CONFLICT']);
    const code = known.has(error?.code) ? error.code : known.has(error?.message) ? error.message : 'PORTAL_PROVISION_FAILED';
    console.error(JSON.stringify({ status: 'failed', code }));
    process.exitCode = 2;
  }
}
