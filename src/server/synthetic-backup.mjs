import { legacySyntheticBackup } from './synthetic-backup-core.mjs';

// The original eleven-table facade keeps its seven exports, exact arities and
// v1 format. Its workspace profile is fixed inside the shared private core.
export const {
  createSyntheticWorkspace, syntheticDatabasePath, inspectSyntheticDatabase,
  captureSyntheticBackup, restoreSyntheticBackup, promoteSyntheticRestore,
  disposeSyntheticWorkspace
} = legacySyntheticBackup;
