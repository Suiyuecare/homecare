import {
  constants, closeSync, fsyncSync, fstatSync, lstatSync, openSync, realpathSync,
  mkdtempSync, mkdirSync, rmdirSync, unlinkSync, readSync, writeSync, linkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { failProductionBackup as fail } from './production-backup-errors.mjs';

const SIDECARS = ['-wal', '-shm', '-journal'];
const uid = () => process.getuid?.();
export const identity = s => ({ dev: s.dev, ino: s.ino, uid: s.uid });
export const sameIdentity = (s, expected) => s && s.dev === expected.dev && s.ino === expected.ino && s.uid === expected.uid;
const stamp = s => [s.size, s.mtimeMs, s.ctimeMs];
export function statMaybe(path) {
  try { return lstatSync(path); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
export function canonicalPath(path) {
  if (typeof path !== 'string' || !path || !isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f]/.test(path)) fail('UNSAFE_PATH');
  let current = dirname(path);
  while (true) {
    const s = lstatSync(current);
    if (!s.isDirectory() || s.isSymbolicLink()) fail('UNSAFE_PATH');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path;
}
export function privateDirectory(path, expected) {
  canonicalPath(path);
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== uid() || (s.mode & 0o777) !== 0o700 || realpathSync(path) !== path || (expected && !sameIdentity(s, expected))) fail('UNSAFE_PATH');
  return identity(s);
}
export function privateFile(path, { maximum = Number.MAX_SAFE_INTEGER, expected, missing = 'SOURCE_MISSING' } = {}) {
  canonicalPath(path); privateDirectory(dirname(path));
  const s = statMaybe(path);
  if (!s) fail(missing);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== uid() || (s.mode & 0o777) !== 0o600 || (expected && !sameIdentity(s, expected))) fail('UNSAFE_PATH');
  if (s.size > maximum) fail('CAPACITY_EXCEEDED');
  return s;
}
export function sourceLease(path) {
  const s = privateFile(path), parent = privateDirectory(dirname(path));
  const verify = () => {
    privateDirectory(dirname(path), parent); privateFile(path, { expected: identity(s) });
    for (const suffix of SIDECARS) if (statMaybe(path + suffix)) privateFile(path + suffix);
  };
  verify();
  return { path, identity: identity(s), verify };
}
export function openPrivateRead(path, maximum = Number.MAX_SAFE_INTEGER) {
  const parent = privateDirectory(dirname(path)), before = privateFile(path, { maximum });
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!sameIdentity(opened, identity(before)) || !opened.isFile() || opened.nlink !== 1 || stamp(opened).some((x, i) => x !== stamp(before)[i])) fail('BACKUP_CHANGED');
    return { fd, size: before.size, identity: identity(before), verify() {
      privateDirectory(dirname(path), parent);
      const after = privateFile(path, { maximum, expected: identity(before) }), final = fstatSync(fd);
      if (!sameIdentity(final, identity(before)) || final.nlink !== 1 || stamp(after).some((x, i) => x !== stamp(before)[i]) || stamp(final).some((x, i) => x !== stamp(before)[i])) fail('BACKUP_CHANGED');
    } };
  } catch (error) { closeSync(fd); throw error; }
}
export function readExact(fd, length, position) {
  const bytes = Buffer.alloc(length); let done = 0;
  while (done < length) {
    const n = readSync(fd, bytes, done, length - done, position + done);
    if (!n) { bytes.fill(0); fail('ENVELOPE_INVALID'); }
    done += n;
  }
  return bytes;
}
export function writeAll(fd, bytes) {
  let done = 0;
  while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done);
}
export function syncPrivateDirectory(path, expected) {
  const lease = privateDirectory(path, expected);
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { if (!sameIdentity(fstatSync(fd), lease)) fail('UNSAFE_PATH'); fsyncSync(fd); }
  finally { closeSync(fd); }
}
export function makeWorkspace(parent) {
  const parentLease = privateDirectory(parent);
  const root = mkdtempSync(join(parent, '.homecare-backup-'));
  const rootLease = privateDirectory(root);
  const owned = new Map();
  const verify = () => { privateDirectory(parent, parentLease); privateDirectory(root, rootLease); };
  const create = name => {
    verify();
    if (typeof name !== 'string' || !/^[a-z0-9.-]+$/.test(name) || name === '.' || name === '..') fail('INVALID_ARGUMENT');
    const path = join(root, name);
    if (statMaybe(path)) fail('TARGET_EXISTS');
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const lease = identity(fstatSync(fd)); owned.set(path, lease);
    return { path, fd, identity: lease };
  };
  const adoptSidecars = path => {
    verify();
    for (const suffix of SIDECARS) {
      const p = path + suffix;
      if (statMaybe(p)) owned.set(p, identity(privateFile(p)));
    }
  };
  const discardOwned = (path, expected) => {
    verify();
    // An adopted sidecar may be outside this root. Never discard it, or
    // accept a caller's replacement identity in place of our captured lease.
    if (typeof path !== 'string' || dirname(path) !== root || !owned.has(path)) fail('UNSAFE_PATH');
    const lease = owned.get(path);
    if (!sameIdentity(expected, lease)) fail('UNSAFE_PATH');
    privateFile(path, { expected: lease });
    unlinkSync(path);
    syncPrivateDirectory(root, rootLease);
    owned.delete(path);
  };
  const cleanup = () => {
    try {
      verify();
      for (const [path, lease] of owned) {
        if (!statMaybe(path)) continue;
        privateFile(path, { expected: lease }); unlinkSync(path);
      }
      rmdirSync(root); syncPrivateDirectory(parent, parentLease);
    } catch { /* Do not follow replacements or delete another file identity. */ }
  };
  return { root, create, verify, adoptSidecars, discardOwned, cleanup };
}
export function requireNewFile(path) {
  canonicalPath(path); privateDirectory(dirname(path));
  if (statMaybe(path)) fail('TARGET_EXISTS');
  return path;
}
export function createIsolationDirectory(path) {
  canonicalPath(path); const parentLease = privateDirectory(dirname(path));
  if (statMaybe(path)) fail('TARGET_EXISTS');
  mkdirSync(path, { mode: 0o700 });
  const lease = privateDirectory(path);
  privateDirectory(dirname(path), parentLease); syncPrivateDirectory(dirname(path), parentLease);
  return lease;
}
export function publishNewPrivateFile(workspaceFile, destination, expected) {
  const parentLease = privateDirectory(dirname(destination));
  requireNewFile(destination); privateFile(workspaceFile, { expected });
  // link() creates the new destination atomically and never replaces a path.
  linkSync(workspaceFile, destination); unlinkSync(workspaceFile);
  privateDirectory(dirname(destination), parentLease);
  privateFile(destination, { expected }); syncPrivateDirectory(dirname(destination), parentLease);
}
export function readProductionEncryptionKeyFile(path) {
  let handle, key;
  try {
    handle = openPrivateRead(path, 32);
    if (handle.size !== 32) fail('KEY_INVALID');
    key = readExact(handle.fd, 32, 0); handle.verify(); return key;
  } catch (error) { key?.fill(0); throw error; }
  finally { if (handle) closeSync(handle.fd); }
}
