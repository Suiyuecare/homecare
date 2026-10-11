import { lstatSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { portalConfigFromEnv } from '../src/server/portal-handoff.mjs';
import { readinessOptionsFromEnv } from '../src/server/readiness.mjs';

export function containerConfiguration(environment, { uid = process.getuid?.() } = {}) {
  const portalConfig = portalConfigFromEnv(environment);
  const readinessOptions = readinessOptionsFromEnv(environment);
  const dataDir = environment.DATA_DIR, port = Number(environment.PORT || '8080');
  if (environment.NODE_ENV !== 'production' || portalConfig.mode !== 'portal' || portalConfig.dynamicLoopbackPort || !portalConfig.secureCookie ||
      !readinessOptions.requirePersistent || !readinessOptions.storageConfirmed || !readinessOptions.policyValid || !Number.isSafeInteger(readinessOptions.minFreeBytes) || readinessOptions.minFreeBytes < 0 ||
      typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || !Number.isInteger(port) || port < 1024 || port > 65535 || port === 4310 || uid === 0 || uid === undefined) throw new Error('HOME_CARE_CONTAINER_CONFIGURATION_INVALID');
  const directory = lstatSync(dataDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid || (directory.mode & 0o077) !== 0 || (directory.mode & 0o700) !== 0o700) throw new Error('HOME_CARE_CONTAINER_STORAGE_INVALID');
  accessSync(dataDir, constants.R_OK | constants.W_OK | constants.X_OK);
  // Refuse unsafe pre-existing files before createApp can initialize or open
  // them. A later /ready rejection cannot undo opening a symlink destination.
  for (const name of ['care.sqlite', 'care.sqlite-wal', 'care.sqlite-shm', 'care.sqlite-journal']) {
    let file;
    try { file = lstatSync(path.join(dataDir, name)); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.uid !== uid || (file.mode & 0o777) !== 0o600) throw new Error('HOME_CARE_CONTAINER_STORAGE_INVALID');
  }
  return { portalConfig, readinessOptions, host: '0.0.0.0', port, dbPath: path.join(dataDir, 'care.sqlite') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let app;
  try {
    const configuration = containerConfiguration(process.env);
    const { createApp } = await import('../src/server/index.mjs');
    app = createApp(configuration);
    await app.listen();
    if (app.readiness?.().status !== 200) throw new Error();
    console.log('HOME_CARE_CONTAINER_LISTENING');
    let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; app.close().then(() => process.exit(0), () => process.exit(1)); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch {
    if (app) await app.close().catch(() => {});
    console.error('HOME_CARE_CONTAINER_STARTUP_REFUSED'); process.exitCode = 1;
  }
}
