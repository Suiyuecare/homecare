import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LegacyArchiveError, LEGACY_MAX_FILES, LEGACY_MAX_TOTAL_BYTES, LEGACY_SCOPE_MAX_BYTES, LEGACY_MANIFEST_MAX_BYTES, LEGACY_FILE_READ_MAX_BYTES,
  legacyClosed, legacyFail, legacyHash, legacyRelativePath, normalizeLegacyScope, parseLegacyJson, createLegacyManifest, validateLegacyManifest } from './legacy-migration-archive-metadata.mjs';

const chunkSize = 1024 * 1024;
const extensions = new Set(['csv', 'xlsx', 'xls', 'zip', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff', 'svg', 'json', 'txt', 'xml', 'html', 'htm', 'doc', 'docx', 'ppt', 'pptx']);
const uid = () => typeof process.getuid === 'function' ? BigInt(process.getuid()) : legacyFail('UNSUPPORTED_FILESYSTEM');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;
const stamp = (a, b) => same(a, b) && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const mode = stat => Number(stat.mode & 0o777n);
const stat = path => fs.lstatSync(path, { bigint: true });
const fstat = fd => fs.fstatSync(fd, { bigint: true });
const fixedError = error => error instanceof LegacyArchiveError ? error : new LegacyArchiveError('ARCHIVE_IO_FAILED');
function guarded(operation) { try { return operation(); } catch (error) { throw fixedError(error); } }
function absolute(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path !== resolve(path)) legacyFail('INVALID_PATH');
  return path;
}
function ancestors(path) {
  absolute(path);
  let current = path;
  for (;;) {
    const value = stat(current);
    if (value.isSymbolicLink() || !value.isDirectory()) legacyFail('UNSAFE_PATH');
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  if (fs.realpathSync(path) !== path) legacyFail('UNSAFE_PATH');
}
function privateDirectory(path, expected) {
  ancestors(path); const value = stat(path);
  if (value.uid !== uid() || mode(value) !== 0o700 || (expected && !same(value, expected))) legacyFail('UNSAFE_PATH');
  return value;
}
const inside = (parent, child) => { const value = relative(parent, child); return value === '' || (!value.startsWith('..' + sep) && value !== '..' && !isAbsolute(value)); };
function directoryNames(path, maximum) {
  const directory = fs.opendirSync(path, { encoding: 'buffer', bufferSize: 32 }), names = [];
  try {
    for (;;) {
      const entry = directory.readSync(); if (!entry) break;
      let name; try { name = new TextDecoder('utf-8', { fatal: true }).decode(entry.name); } catch { legacyFail('UNSAFE_PATH'); }
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name)) legacyFail('UNSAFE_PATH');
      names.push(name); if (names.length > maximum) legacyFail('CAPACITY_EXCEEDED');
    }
  } finally { directory.closeSync(); }
  return names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}
function safeSourceFile(root, path, expected) {
  if (!inside(root.path, path)) legacyFail('UNSAFE_PATH');
  privateDirectory(root.path, root.identity); ancestors(dirname(path));
  const value = stat(path);
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1n || value.uid !== uid() || (expected && !stamp(value, expected))) legacyFail('SOURCE_CHANGED');
  return value;
}
function inventory(root, limits) {
  privateDirectory(root.path, root.identity);
  const files = [], directories = []; let total = 0, entries = 0;
  const walk = (path, parts) => {
    if (parts.length > 64) legacyFail('CAPACITY_EXCEEDED');
    ancestors(path); const before = stat(path);
    if (!before.isDirectory() || before.uid !== uid() || (mode(before) & 0o022)) legacyFail('UNSAFE_PATH');
    directories.push({ path, identity: before });
    if (directories.length > LEGACY_MAX_FILES) legacyFail('CAPACITY_EXCEEDED');
    const names = directoryNames(path, LEGACY_MAX_FILES * 2); entries += names.length;
    if (entries > LEGACY_MAX_FILES * 2) legacyFail('CAPACITY_EXCEEDED');
    for (const name of names) {
      const child = join(path, name), value = stat(child), childParts = [...parts, name];
      if (value.isSymbolicLink()) legacyFail('UNSAFE_PATH');
      if (value.isDirectory()) walk(child, childParts);
      else if (value.isFile()) {
        const sourceRelativePath = legacyRelativePath(childParts.join('/'));
        safeSourceFile(root, child, value);
        const bytes = Number(value.size);
        if (!Number.isSafeInteger(bytes) || bytes < 0) legacyFail('CAPACITY_EXCEEDED');
        total += bytes; files.push({ path: child, sourceRelativePath, identity: value, bytes });
        if (files.length > limits.maxFiles || total > limits.maxTotalBytes) legacyFail('CAPACITY_EXCEEDED');
      } else legacyFail('UNSAFE_PATH');
    }
    if (!stamp(stat(path), before)) legacyFail('SOURCE_CHANGED');
  };
  walk(root.path, []);
  if (!files.length) legacyFail('NO_SOURCE_FILES');
  files.sort((a, b) => Buffer.compare(Buffer.from(a.sourceRelativePath), Buffer.from(b.sourceRelativePath)));
  return { files, directories, total };
}
function sameInventory(before, after) {
  if (before.files.length !== after.files.length || before.directories.length !== after.directories.length || before.total !== after.total) legacyFail('SOURCE_CHANGED');
  for (let index = 0; index < before.files.length; index++) {
    const a = before.files[index], b = after.files[index];
    if (a.sourceRelativePath !== b.sourceRelativePath || !stamp(a.identity, b.identity)) legacyFail('SOURCE_CHANGED');
  }
  for (let index = 0; index < before.directories.length; index++) {
    const a = before.directories[index], b = after.directories[index];
    if (a.path !== b.path || !stamp(a.identity, b.identity)) legacyFail('SOURCE_CHANGED');
  }
}
function sourceRead(root, file, consume) {
  const before = safeSourceFile(root, file.path, file.identity);
  const fd = fs.openSync(file.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const hash = createHash('sha256'); let count = 0;
  const buffer = Buffer.alloc(chunkSize);
  try {
    if (!stamp(fstat(fd), before)) legacyFail('SOURCE_CHANGED');
    ancestors(dirname(file.path));
    for (;;) {
      const size = fs.readSync(fd, buffer, 0, buffer.length, null); if (!size) break;
      count += size; if (count > file.bytes) legacyFail('SOURCE_CHANGED');
      const bytes = buffer.subarray(0, size); hash.update(bytes); consume?.(bytes);
    }
    if (count !== file.bytes || !stamp(fstat(fd), before)) legacyFail('SOURCE_CHANGED');
    safeSourceFile(root, file.path, before);
    return hash.digest('hex');
  } finally { buffer.fill(0); fs.closeSync(fd); }
}
function privateRegular(root, path, expected) {
  privateDirectory(root.path, root.identity);
  if (!inside(root.path, path)) legacyFail('UNSAFE_PATH');
  let parent = dirname(path);
  for (;;) { privateDirectory(parent, parent === root.path ? root.identity : undefined); if (parent === root.path) break; parent = dirname(parent); }
  const value = stat(path);
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1n || value.uid !== uid() || mode(value) !== 0o600 || (expected && !stamp(value, expected))) legacyFail('ARCHIVE_CHANGED');
  return value;
}
function privateDigest(root, path, expected) {
  const before = privateRegular(root, path, expected), fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const buffer = Buffer.alloc(chunkSize), hash = createHash('sha256'); let count = 0;
  try {
    if (!stamp(fstat(fd), before)) legacyFail('ARCHIVE_CHANGED');
    for (;;) { const size = fs.readSync(fd, buffer, 0, buffer.length, null); if (!size) break; count += size; if (count > Number(before.size)) legacyFail('ARCHIVE_CHANGED'); hash.update(buffer.subarray(0, size)); }
    if (count !== Number(before.size) || !stamp(fstat(fd), before)) legacyFail('ARCHIVE_CHANGED'); privateRegular(root, path, before);
    return { bytes: count, sha256: hash.digest('hex'), identity: before };
  } finally { buffer.fill(0); fs.closeSync(fd); }
}
function writeAll(fd, bytes) { let offset = 0; while (offset < bytes.length) { const size = fs.writeSync(fd, bytes, offset, bytes.length - offset, null); if (!size) legacyFail('ARCHIVE_IO_FAILED'); offset += size; } }
function syncDirectory(root) {
  privateDirectory(root.path, root.identity);
  const fd = fs.openSync(root.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { if (!same(fstat(fd), root.identity)) legacyFail('UNSAFE_PATH'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeNew(root, path, producer) {
  privateDirectory(root.path, root.identity); ancestors(dirname(path)); if (!inside(root.path, path)) legacyFail('UNSAFE_PATH');
  const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let identity;
  try {
    identity = fstat(fd); if (!identity.isFile() || identity.nlink !== 1n || mode(identity) !== 0o600 || identity.uid !== uid()) legacyFail('UNSAFE_PATH');
    // Re-check the parent and the new descriptor before writing any payload.
    privateRegular(root, path, identity);
    producer(fd); fs.fsyncSync(fd);
    const final = fstat(fd); privateRegular(root, path, final); return final;
  } finally { fs.closeSync(fd); }
}
function boundedPrivateRead(root, path, maximum, allowEmpty = false) {
  const before = privateRegular(root, path);
  if ((!allowEmpty && before.size === 0n) || before.size < 0n || before.size > BigInt(maximum)) legacyFail('CAPACITY_EXCEEDED');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    if (!stamp(fstat(fd), before)) legacyFail('ARCHIVE_CHANGED'); bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) { const size = fs.readSync(fd, bytes, offset, bytes.length - offset, null); if (!size) legacyFail('ARCHIVE_CHANGED'); offset += size; }
    const extra = Buffer.alloc(1);
    try { if (fs.readSync(fd, extra, 0, 1, null) !== 0 || !stamp(fstat(fd), before)) legacyFail('ARCHIVE_CHANGED'); } finally { extra.fill(0); }
    privateRegular(root, path, before); return bytes;
  } catch (error) { bytes?.fill(0); throw error; } finally { fs.closeSync(fd); }
}
function limits(options) {
  const maxFiles = options.maxFiles ?? LEGACY_MAX_FILES, maxTotalBytes = options.maxTotalBytes ?? LEGACY_MAX_TOTAL_BYTES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > LEGACY_MAX_FILES || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0 || maxTotalBytes > LEGACY_MAX_TOTAL_BYTES) legacyFail('INVALID_ARGUMENT');
  return { maxFiles, maxTotalBytes };
}
export function readLegacyScopeFile(path) {
  return guarded(() => {
    absolute(path); const rootPath = dirname(path), root = { path: rootPath, identity: privateDirectory(rootPath) };
    const bytes = boundedPrivateRead(root, path, LEGACY_SCOPE_MAX_BYTES);
    try { return normalizeLegacyScope(parseLegacyJson(bytes)); } finally { bytes.fill(0); }
  });
}
function assertPayload(root, manifest, markerExpected) {
  privateDirectory(root.path, root.identity);
  const top = directoryNames(root.path, 3);
  const expected = markerExpected ? ['files', 'manifest.json'] : ['files'];
  if (JSON.stringify(top) !== JSON.stringify(expected)) legacyFail('ARCHIVE_CHANGED');
  const fileRoot = join(root.path, 'files'); privateDirectory(fileRoot);
  const names = directoryNames(fileRoot, LEGACY_MAX_FILES + 1), listed = manifest.files.map(file => file.archivedPath.slice(6)).sort();
  if (JSON.stringify(names) !== JSON.stringify(listed)) legacyFail('ARCHIVE_CHANGED');
  const identities = [];
  for (const file of manifest.files) {
    const proof = privateDigest(root, join(root.path, file.archivedPath));
    if (proof.bytes !== file.bytes || proof.sha256 !== file.sha256) legacyFail('ARCHIVE_CHANGED'); identities.push([file.archivedPath, proof.identity]);
  }
  if (JSON.stringify(directoryNames(fileRoot, LEGACY_MAX_FILES + 1)) !== JSON.stringify(names)) legacyFail('ARCHIVE_CHANGED');
  for (const [path, identity] of identities) privateRegular(root, join(root.path, path), identity);
  if (JSON.stringify(directoryNames(root.path, 3)) !== JSON.stringify(expected)) legacyFail('ARCHIVE_CHANGED');
}
function compareSource(root, manifest) {
  const before = inventory(root, { maxFiles: LEGACY_MAX_FILES, maxTotalBytes: LEGACY_MAX_TOTAL_BYTES });
  const byHash = new Map(manifest.files.map(file => [file.sourceRelativePathSha256, file]));
  if (before.files.length !== byHash.size || before.total !== manifest.totalBytes) legacyFail('SOURCE_CHANGED');
  for (const file of before.files) {
    const row = byHash.get(legacyHash(Buffer.from(file.sourceRelativePath)));
    if (!row || row.bytes !== file.bytes || sourceRead(root, file) !== row.sha256) legacyFail('SOURCE_CHANGED');
  }
  sameInventory(before, inventory(root, { maxFiles: LEGACY_MAX_FILES, maxTotalBytes: LEGACY_MAX_TOTAL_BYTES }));
}
function summary(manifest, sha256, sourceCompared) {
  return { status: 'verified', archiveId: manifest.archiveId, manifestSha256: sha256, fileCount: manifest.files.length, totalBytes: manifest.totalBytes,
    datasetCount: manifest.datasets.length, missingDatasetCount: manifest.missingDatasets.length,
    unresolvedCount: manifest.unresolved.length, sourceCompared, sourceSystemComplete: false, businessImportCompleted: false };
}
export function verifyLegacyArchive(options) {
  return guarded(() => {
    if (!legacyClosed(options, ['archivePath', 'expectedManifestSha256'], ['inputPath']) || !/^[a-f0-9]{64}$/.test(options.expectedManifestSha256)) legacyFail('INVALID_ARGUMENT');
    const archivePath = absolute(options.archivePath), root = { path: archivePath, identity: privateDirectory(archivePath) };
    const bytes = boundedPrivateRead(root, join(archivePath, 'manifest.json'), LEGACY_MANIFEST_MAX_BYTES);
    let manifest;
    try { if (legacyHash(bytes) !== options.expectedManifestSha256) legacyFail('MANIFEST_HASH_MISMATCH'); manifest = validateLegacyManifest(parseLegacyJson(bytes, LEGACY_MANIFEST_MAX_BYTES)); }
    finally { bytes.fill(0); }
    if (archivePath.slice(archivePath.lastIndexOf(sep) + 1) !== manifest.archiveId) legacyFail('INVALID_MANIFEST');
    assertPayload(root, manifest, true);
    if (Object.hasOwn(options, 'inputPath')) {
      const inputPath = absolute(options.inputPath);
      if (inside(inputPath, archivePath) || inside(archivePath, inputPath)) legacyFail('UNSAFE_PATH');
      compareSource({ path: inputPath, identity: privateDirectory(inputPath) }, manifest);
    }
    const final = boundedPrivateRead(root, join(archivePath, 'manifest.json'), LEGACY_MANIFEST_MAX_BYTES);
    try { if (legacyHash(final) !== options.expectedManifestSha256) legacyFail('ARCHIVE_CHANGED'); } finally { final.fill(0); }
    return summary(manifest, options.expectedManifestSha256, Object.hasOwn(options, 'inputPath'));
  });
}
function pinnedManifest(root, expectedHash) {
  const bytes = boundedPrivateRead(root, join(root.path, 'manifest.json'), LEGACY_MANIFEST_MAX_BYTES);
  try {
    if (legacyHash(bytes) !== expectedHash) legacyFail('MANIFEST_HASH_MISMATCH');
    return validateLegacyManifest(parseLegacyJson(bytes, LEGACY_MANIFEST_MAX_BYTES));
  } finally { bytes.fill(0); }
}
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
export function inspectVerifiedLegacyArchive(options) {
  return guarded(() => {
    // The private manifest contains opaque references only. It is never printed by the CLI.
    const proof = verifyLegacyArchive(options), root = { path: options.archivePath, identity: privateDirectory(options.archivePath) };
    const manifest = pinnedManifest(root, options.expectedManifestSha256);
    return freeze({ proof, manifest });
  });
}
export function readVerifiedLegacyFile(options) {
  return guarded(() => {
    if (!legacyClosed(options, ['archivePath', 'expectedManifestSha256', 'fileId', 'maxBytes']) || typeof options.fileId !== 'string' || !/^file-[0-9]{8}$/.test(options.fileId)
        || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || options.maxBytes > LEGACY_FILE_READ_MAX_BYTES) legacyFail('INVALID_ARGUMENT');
    const inspection = inspectVerifiedLegacyArchive({ archivePath: options.archivePath, expectedManifestSha256: options.expectedManifestSha256 });
    const file = inspection.manifest.files.find(file => file.id === options.fileId);
    if (!file) legacyFail('UNKNOWN_ARCHIVE_FILE');
    if (file.bytes > options.maxBytes) legacyFail('CAPACITY_EXCEEDED');
    const root = { path: options.archivePath, identity: privateDirectory(options.archivePath) };
    const bytes = boundedPrivateRead(root, join(root.path, file.archivedPath), options.maxBytes, true);
    try {
      if (bytes.length !== file.bytes || legacyHash(bytes) !== file.sha256) legacyFail('ARCHIVE_CHANGED');
      pinnedManifest(root, options.expectedManifestSha256);
      return { file, bytes, source: inspection.manifest.source, archiveId: inspection.manifest.archiveId, manifestSha256: options.expectedManifestSha256 };
    } catch (error) { bytes.fill(0); throw error; }
  });
}
export function captureLegacyArchive(options) {
  let packageRoot, markerIdentity, packageId;
  try {
    if (!legacyClosed(options, ['inputPath', 'outputParent', 'scope'], ['maxFiles', 'maxTotalBytes'])) legacyFail('INVALID_ARGUMENT');
    const scope = normalizeLegacyScope(options.scope), inputPath = absolute(options.inputPath), outputParent = absolute(options.outputParent);
    if (inside(inputPath, outputParent) || inside(outputParent, inputPath)) legacyFail('UNSAFE_PATH');
    const input = { path: inputPath, identity: privateDirectory(inputPath) }, output = { path: outputParent, identity: privateDirectory(outputParent) };
    const bounds = limits(options), before = inventory(input, bounds);
    packageId = 'archive-' + randomUUID(); const packagePath = join(outputParent, packageId);
    privateDirectory(output.path, output.identity); fs.mkdirSync(packagePath, { mode: 0o700 });
    packageRoot = { path: packagePath, identity: privateDirectory(packagePath) };
    const fileRootPath = join(packagePath, 'files'); fs.mkdirSync(fileRootPath, { mode: 0o700 });
    const fileRoot = { path: fileRootPath, identity: privateDirectory(fileRootPath) };
    syncDirectory(packageRoot); syncDirectory(output);
    const files = [];
    before.files.forEach((file, index) => {
      const number = String(index + 1).padStart(8, '0'), extension = extname(file.sourceRelativePath).slice(1).toLowerCase();
      const archivedPath = `files/${number}.${extensions.has(extension) ? extension : 'bin'}`; let sha256;
      const copiedIdentity = writeNew(packageRoot, join(packagePath, archivedPath), fd => { sha256 = sourceRead(input, file, bytes => writeAll(fd, bytes)); });
      const copy = privateDigest(packageRoot, join(packagePath, archivedPath), copiedIdentity);
      if (copy.bytes !== file.bytes || copy.sha256 !== sha256) legacyFail('ARCHIVE_CHANGED');
      files.push({ id: 'file-' + number, sourceRelativePathSha256: legacyHash(Buffer.from(file.sourceRelativePath)), archivedPath, bytes: file.bytes, sha256 });
    });
    // Each file's data and the directory entries must be durable before marker publication.
    syncDirectory(fileRoot); sameInventory(before, inventory(input, bounds));
    const manifest = createLegacyManifest(scope, files, packageId, new Date().toISOString()); validateLegacyManifest(manifest);
    compareSource(input, manifest); assertPayload(packageRoot, manifest, false);
    const payload = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    if (payload.length > LEGACY_MANIFEST_MAX_BYTES) legacyFail('CAPACITY_EXCEEDED');
    const manifestSha256 = legacyHash(payload), pending = join(packagePath, 'manifest.pending'), marker = join(packagePath, 'manifest.json');
    const pendingIdentity = writeNew(packageRoot, pending, fd => writeAll(fd, payload)); payload.fill(0); syncDirectory(packageRoot);
    privateDirectory(packageRoot.path, packageRoot.identity);
    fs.linkSync(pending, marker); markerIdentity = stat(marker);
    if (!same(markerIdentity, pendingIdentity) || markerIdentity.nlink !== 2n || !same(stat(pending), pendingIdentity)) legacyFail('ARCHIVE_CHANGED');
    fs.unlinkSync(pending); markerIdentity = privateRegular(packageRoot, marker); syncDirectory(packageRoot);
    privateDirectory(output.path, output.identity);
    return verifyLegacyArchive({ archivePath: packagePath, expectedManifestSha256: manifestSha256, inputPath });
  } catch (original) {
    const error = fixedError(original);
    if (packageRoot) {
      try {
        privateDirectory(packageRoot.path, packageRoot.identity);
        const marker = join(packageRoot.path, 'manifest.json');
        if (markerIdentity) { const current = stat(marker); if (same(current, markerIdentity) && current.isFile()) fs.unlinkSync(marker); }
        writeNew(packageRoot, join(packageRoot.path, 'failure.json'), fd => writeAll(fd, Buffer.from(JSON.stringify({ format: 'suiyue-legacy-export-archive-failure-v1', status: 'failed', code: error.code }) + '\n')));
        syncDirectory(packageRoot);
      } catch { /* Uncertain identities are retained, never overwritten or recursively removed. */ }
    }
    if (packageId) error.archiveId = packageId;
    throw error;
  }
}
