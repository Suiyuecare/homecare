// Operator errors are a closed vocabulary. Never reflect SQLite errors, paths,
// identity rows, keys, SQL, or a caller's supplied text in a diagnostic.
const messages = Object.freeze({
  INVALID_ARGUMENT: 'Unsupported production backup argument.',
  UNSUPPORTED_RUNTIME: 'Production backup requires the supported SQLite backup runtime.',
  UNSAFE_PATH: 'Production backup requires canonical private owned storage.',
  SOURCE_MISSING: 'The required production source is missing.',
  TARGET_EXISTS: 'The production destination must be new.',
  CAPACITY_EXCEEDED: 'Production backup exceeds the declared technical capacity.',
  KEY_INVALID: 'Production backup requires a private 32-byte encryption key.',
  ENVELOPE_INVALID: 'Production encrypted backup format is invalid.',
  AUTHENTICATION_FAILED: 'Production encrypted backup authentication failed.',
  SCHEMA_MISMATCH: 'Production SQLite schema does not match the supported model.',
  INTEGRITY_FAILED: 'Production SQLite integrity verification failed.',
  FOREIGN_KEY_FAILED: 'Production SQLite foreign key verification failed.',
  HISTORY_INCOMPLETE: 'Production SQLite scoped history is incomplete.',
  SNAPSHOT_CHANGED: 'Production SQLite snapshot verification did not match.',
  BACKUP_CHANGED: 'The production backup changed during the operation.',
  RESTORE_CHANGED: 'The isolated recovery candidate changed.',
  RECOVERY_PENDING: 'The isolated recovery remains blocked pending current authority reconciliation.',
  AUTHORITY_UNCONFIRMED: 'Current recovery authority has not been confirmed.',
  OPERATION_FAILED: 'Production backup operation failed; inspect retained private artifacts.',
});

export class ProductionBackupError extends Error {
  constructor(code) {
    super(messages[code] || messages.OPERATION_FAILED);
    this.name = 'ProductionBackupError';
    this.code = Object.hasOwn(messages, code) ? code : 'OPERATION_FAILED';
  }
}

export const failProductionBackup = code => { throw new ProductionBackupError(code); };

export async function guardProductionBackup(operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ProductionBackupError) throw error;
    failProductionBackup('OPERATION_FAILED');
  }
}
