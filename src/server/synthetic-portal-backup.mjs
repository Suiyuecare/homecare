import { portalSyntheticBackup } from './synthetic-backup-core.mjs';

// Explicit opt-in to thirteen-table synthetic scratch storage. This unmounted
// facade cannot open an existing operator database or import a manifest/path.
export function createSyntheticPortalWorkspace() {
  return portalSyntheticBackup.createSyntheticWorkspace(...arguments);
}
export const {
  syntheticDatabasePath, inspectSyntheticDatabase, captureSyntheticBackup,
  restoreSyntheticBackup, promoteSyntheticRestore, disposeSyntheticWorkspace
} = portalSyntheticBackup;
