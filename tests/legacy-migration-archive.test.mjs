import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureLegacyArchive, inspectVerifiedLegacyArchive, readLegacyScopeFile, readVerifiedLegacyFile, verifyLegacyArchive } from '../src/server/legacy-migration-archive.mjs';
import { LEGACY_SCOPE_FORMAT, LegacyArchiveError, legacyHash, normalizeLegacyScope, parseLegacyJson, validateLegacyManifest } from '../src/server/legacy-migration-archive-metadata.mjs';

function scope(datasets = []) {
  return { format: LEGACY_SCOPE_FORMAT, provider: 'synthetic-provider', tenant: 'synthetic-tenant-01', exportedAt: '2026-10-12T01:00:00.000Z', datasets, missingDatasets: [], unresolved: [] };
}
const dataset = (id, sourceFiles, extra = {}) => ({ id, sourceFiles, reportedCoverage: 'unknown', range: { kind: 'unknown' }, ...extra });
function fixture() {
  // Keep a real Unix socket fixture beneath the macOS sockaddr path limit.
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'lma-')); fs.chmodSync(root, 0o700);
  const inputPath = join(root, 'incoming'), outputParent = join(root, 'archives'), metadataPath = join(root, 'scope.json');
  fs.mkdirSync(inputPath, { mode: 0o700 }); fs.mkdirSync(outputParent, { mode: 0o700 });
  const put = (relativePath, bytes) => { const path = join(inputPath, relativePath), parents = relativePath.split('/').slice(0, -1); let current = inputPath;
    for (const parent of parents) { current = join(current, parent); if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 }); }
    fs.writeFileSync(path, bytes, { mode: 0o600 }); return path;
  };
  return { root, inputPath, outputParent, metadataPath, put, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function capture(f, metadata = scope(), more = {}) { return captureLegacyArchive({ inputPath: f.inputPath, outputParent: f.outputParent, scope: metadata, ...more }); }
const archive = (f, result) => join(f.outputParent, result.archiveId);
const manifest = (f, result) => JSON.parse(fs.readFileSync(join(archive(f, result), 'manifest.json'), 'utf8'));
const verify = (f, result, source = false) => verifyLegacyArchive({ archivePath: archive(f, result), expectedManifestSha256: result.manifestSha256, ...(source ? { inputPath: f.inputPath } : {}) });
function fails(operation, codes) {
  assert.throws(operation, error => error instanceof LegacyArchiveError && (codes === undefined || [].concat(codes).includes(error.code)) && !error.message.includes('/Users/') && !error.message.includes('SENTINEL'));
}
function noPublishedManifest(f) {
  for (const name of fs.readdirSync(f.outputParent)) assert(!fs.existsSync(join(f.outputParent, name, 'manifest.json')), 'Failed capture cannot be published as verified');
}
function patched(name, replacement, operation) {
  const original = fs[name]; fs[name] = (...args) => replacement(original, ...args);
  try { return operation(); } finally { fs[name] = original; }
}

test('capture preserves all opaque bytes and generated stable paths without disclosing private file names or contents', () => {
  const f = fixture();
  try {
    const content = new Map([
      ['個案-SENTINEL-person.csv', Buffer.from('name,note\r\nSENTINEL-private-row,=HYPERLINK("https://invalid.example")\r\n')],
      ['nested/attendance.xlsx', Buffer.from([0x50, 0x4b, 0, 0xff, 0x80, 0x01])],
      ['nested/export.zip', Buffer.from([0x50, 0x4b, 0xff, 0, 0x02])],
      ['record.pdf', Buffer.from('%PDF-SENTINEL-private-pdf')], ['picture.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
      ['not-run.js', Buffer.from('throw new Error("SENTINEL-not-executed")')], ['empty.csv', Buffer.alloc(0)]
    ]);
    for (const [name, bytes] of content) f.put(name, bytes);
    const metadata = scope([dataset('cases', ['個案-SENTINEL-person.csv'], { sourceRowCount: 1, reportedCoverage: 'provider-declared-full', range: { kind: 'all-source-rows' } })]);
    const result = capture(f, metadata), saved = manifest(f, result), savedText = fs.readFileSync(join(archive(f, result), 'manifest.json'), 'utf8');
    assert.equal(result.fileCount, 7); assert.equal(result.sourceCompared, true); assert.equal(result.sourceSystemComplete, false); assert.equal(result.businessImportCompleted, false);
    assert(!savedText.includes('SENTINEL')); assert(!savedText.includes('attendance.xlsx')); assert(!savedText.includes('HYPERLINK')); assert(!savedText.includes(f.root));
    assert.equal(saved.datasets[0].sourceRowCount, 1); assert.equal(saved.datasets[0].rowCountVerified, false); assert.equal(saved.sourceSystemComplete, false);
    for (const row of saved.files) {
      const [name, bytes] = [...content].find(([name]) => legacyHash(Buffer.from(name)) === row.sourceRelativePathSha256);
      assert.deepEqual(fs.readFileSync(join(archive(f, result), row.archivedPath)), bytes); assert.deepEqual(fs.readFileSync(join(f.inputPath, name)), bytes);
      assert.equal(row.bytes, bytes.length); assert.equal(row.sha256, legacyHash(bytes)); assert.equal(fs.lstatSync(join(archive(f, result), row.archivedPath)).mode & 0o777, 0o600);
    }
    assert.equal(fs.lstatSync(archive(f, result)).mode & 0o777, 0o700); assert.equal(fs.lstatSync(join(archive(f, result), 'files')).mode & 0o777, 0o700);
    assert.equal(fs.lstatSync(join(archive(f, result), 'manifest.json')).mode & 0o777, 0o600); assert.equal(fs.lstatSync(join(archive(f, result), 'manifest.json')).nlink, 1);
    assert(saved.files.find(row => row.sourceRelativePathSha256 === legacyHash(Buffer.from('not-run.js'))).archivedPath.endsWith('.bin'));
    assert.deepEqual(verify(f, result, true), result);
  } finally { f.remove(); }
});

test('new packages retain duplicates, have reproducible paths and never overwrite previous archives', () => {
  const f = fixture();
  try {
    f.put('b.csv', 'same bytes'); f.put('a.csv', 'same bytes');
    const one = capture(f), two = capture(f); assert.notEqual(one.archiveId, two.archiveId); assert.equal(fs.readdirSync(f.outputParent).length, 2);
    assert.deepEqual(manifest(f, one).files, manifest(f, two).files); assert.equal(manifest(f, one).files.length, 2);
    assert.equal(manifest(f, one).files[0].sha256, manifest(f, one).files[1].sha256); verify(f, one, true); verify(f, two, true);
  } finally { f.remove(); }
});

test('streaming capture and partial native writes retain exact bytes across more than three read chunks', () => {
  const f = fixture();
  try {
    const source = Buffer.alloc(3 * 1024 * 1024 + 17); for (let index = 0; index < source.length; index++) source[index] = index % 251;
    f.put('large.xlsx', source); let partialWrites = 0;
    const result = patched('writeSync', (call, fd, buffer, offset, length, position) => { partialWrites++; return call(fd, buffer, offset, Math.min(length, 4093), position); }, () => capture(f));
    const row = manifest(f, result).files[0]; assert.equal(row.bytes, source.length); assert.equal(row.sha256, legacyHash(source));
    assert.deepEqual(fs.readFileSync(join(archive(f, result), row.archivedPath)), source); assert(partialWrites > 700); verify(f, result, true); source.fill(0);
  } finally { f.remove(); }
});

test('source path normalization, unsafe names and output symlinks are rejected without changing source contents', () => {
  const f = fixture();
  try {
    const original = f.put('a.csv', 'original');
    fails(() => captureLegacyArchive({ inputPath: f.inputPath + '/.', outputParent: f.outputParent, scope: scope() }), 'INVALID_PATH');
    fails(() => captureLegacyArchive({ inputPath: 'relative-incoming', outputParent: f.outputParent, scope: scope() }), 'INVALID_PATH');
    const link = join(f.root, 'output-link'); fs.symlinkSync(f.outputParent, link);
    fails(() => captureLegacyArchive({ inputPath: f.inputPath, outputParent: link, scope: scope() }), 'UNSAFE_PATH');
    f.put('unsafe\\name.csv', 'opaque'); fails(() => capture(f), 'UNSAFE_PATH'); fs.unlinkSync(join(f.inputPath, 'unsafe\\name.csv'));
    const invalidName = Buffer.concat([Buffer.from(f.inputPath + '/'), Buffer.from([0xff]), Buffer.from('.csv')]);
    let invalidNameCreated = false;
    try { fs.writeFileSync(invalidName, 'opaque', { mode: 0o600 }); invalidNameCreated = true; }
    catch (error) { assert.equal(process.platform, 'darwin'); assert.equal(error.code, 'EILSEQ'); }
    if (invalidNameCreated) { fails(() => capture(f), 'UNSAFE_PATH'); fs.unlinkSync(invalidName); }
    assert.equal(fs.readFileSync(original, 'utf8'), 'original'); noPublishedManifest(f);
  } finally { f.remove(); }
});

test('verified file reader uses opaque ID and bounded bytes; extension is never treated as a format assertion', () => {
  const f = fixture();
  try {
    const original = Buffer.from([0x50, 0x4b, 0, 0xff, 0x80]); f.put('employee-private.zip', original); f.put('empty.csv', Buffer.alloc(0));
    const result = capture(f), inspection = inspectVerifiedLegacyArchive({ archivePath: archive(f, result), expectedManifestSha256: result.manifestSha256 });
    assert(Object.isFrozen(inspection.manifest)); assert(Object.isFrozen(inspection.manifest.files));
    const row = inspection.manifest.files.find(file => file.sourceRelativePathSha256 === legacyHash(Buffer.from('employee-private.zip')));
    const read = readVerifiedLegacyFile({ archivePath: archive(f, result), expectedManifestSha256: result.manifestSha256, fileId: row.id, maxBytes: original.length });
    assert.deepEqual(read.file, row); assert.deepEqual(read.bytes, original); read.bytes.fill(0);
    assert.deepEqual(read.source, inspection.manifest.source); assert.equal(read.archiveId, result.archiveId); assert.equal(read.manifestSha256, result.manifestSha256);
    const empty = inspection.manifest.files.find(file => file.bytes === 0);
    const zero = readVerifiedLegacyFile({ archivePath: archive(f, result), expectedManifestSha256: result.manifestSha256, fileId: empty.id, maxBytes: 0 }); assert.equal(zero.bytes.length, 0);
  } finally { f.remove(); }
});

test('verified reader rejects arbitrary paths, excessive memory bounds, missing IDs, failed digest and changed payload', () => {
  const f = fixture();
  try {
    f.put('a.csv', 'original'); const result = capture(f), base = { archivePath: archive(f, result), expectedManifestSha256: result.manifestSha256, fileId: 'file-00000001', maxBytes: 1024 };
    for (const options of [{ ...base, fileId: '../outside' }, { ...base, path: '/SENTINEL' }, { ...base, maxBytes: 32 * 1024 * 1024 + 1 }, { ...base, maxBytes: -1 }]) fails(() => readVerifiedLegacyFile(options), 'INVALID_ARGUMENT');
    fails(() => readVerifiedLegacyFile({ ...base, fileId: 'file-00000000' }), 'UNKNOWN_ARCHIVE_FILE'); fails(() => readVerifiedLegacyFile({ ...base, maxBytes: 1 }), 'CAPACITY_EXCEEDED');
    fails(() => readVerifiedLegacyFile({ ...base, expectedManifestSha256: '0'.repeat(64) }), 'MANIFEST_HASH_MISMATCH');
    const row = manifest(f, result).files[0]; fs.writeFileSync(join(archive(f, result), row.archivedPath), 'changed!'); fails(() => readVerifiedLegacyFile(base), 'ARCHIVE_CHANGED');
  } finally { f.remove(); }
});

test('missing datasets/files and incomplete operator counts stay explicit and never become source completeness', () => {
  const f = fixture();
  try {
    f.put('present.csv', 'header\n');
    const metadata = scope([dataset('cases', ['present.csv', 'missing.csv'], { sourceRowCount: 500, range: { kind: 'date-window', startDate: '2026-10-01', endDate: '2026-10-12' } })]);
    metadata.missingDatasets = ['attachments']; metadata.unresolved = ['count-not-confirmed'];
    const result = capture(f, metadata), value = manifest(f, result);
    assert.equal(value.datasets[0].sourceRowCount, 500); assert.equal(value.datasets[0].rowCountVerified, false); assert.equal(value.datasets[0].fileIds.length, 1);
    assert.deepEqual(value.datasets[0].missingSourcePathSha256, [legacyHash(Buffer.from('missing.csv'))]); assert.deepEqual(value.missingDatasets, ['attachments']);
    assert(value.unresolved.includes('declared-source-files-missing')); assert(value.unresolved.includes('count-not-confirmed')); assert.equal(value.sourceSystemComplete, false); verify(f, result);
  } finally { f.remove(); }
});

test('empty incoming directory, limits and overlapping input/output fail without publishing a package', () => {
  const f = fixture();
  try {
    fails(() => capture(f), 'NO_SOURCE_FILES'); f.put('a.csv', '123'); f.put('b.csv', '456');
    fails(() => capture(f, scope(), { maxFiles: 1 }), 'CAPACITY_EXCEEDED'); fails(() => capture(f, scope(), { maxTotalBytes: 5 }), 'CAPACITY_EXCEEDED');
    fails(() => capture(f, scope(), { maxFiles: 0 }), 'INVALID_ARGUMENT'); fails(() => capture(f, scope(), { maxTotalBytes: Infinity }), 'INVALID_ARGUMENT');
    fs.mkdirSync(join(f.inputPath, 'out'), { mode: 0o700 });
    fails(() => captureLegacyArchive({ inputPath: f.inputPath, outputParent: join(f.inputPath, 'out'), scope: scope() }), 'UNSAFE_PATH');
    fails(() => captureLegacyArchive({ inputPath: f.inputPath, outputParent: f.root, scope: scope() }), 'UNSAFE_PATH');
    assert.deepEqual(fs.readdirSync(f.outputParent), []);
  } finally { f.remove(); }
});

for (const kind of ['file-symlink', 'directory-symlink', 'root-symlink', 'ancestor-symlink', 'hardlink', 'unix-socket']) test('source rejects ' + kind + ' before any complete publication', async () => {
  const f = fixture(); let socket;
  try {
    const original = f.put('a.csv', 'synthetic'); let input = f.inputPath;
    if (kind === 'file-symlink') fs.symlinkSync(original, join(f.inputPath, 'link.csv'));
    if (kind === 'directory-symlink') fs.symlinkSync(f.outputParent, join(f.inputPath, 'link-directory'));
    if (kind === 'root-symlink') { input = join(f.root, 'linked-incoming'); fs.symlinkSync(f.inputPath, input); }
    if (kind === 'ancestor-symlink') { const alias = join(f.root, 'alias'); fs.symlinkSync(f.root, alias); input = join(alias, 'incoming'); }
    if (kind === 'hardlink') fs.linkSync(original, join(f.inputPath, 'copy.csv'));
    if (kind === 'unix-socket') { socket = net.createServer(); await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(join(f.inputPath, 'socket'), resolve); }); }
    fails(() => captureLegacyArchive({ inputPath: input, outputParent: f.outputParent, scope: scope() }), ['UNSAFE_PATH', 'SOURCE_CHANGED']); noPublishedManifest(f);
  } finally { if (socket) await new Promise(resolve => socket.close(resolve)); f.remove(); }
});

test('input/output roots must be current-owner private; writable nested source directories are refused', () => {
  const f = fixture();
  try {
    f.put('nested/a.csv', 'private'); fs.chmodSync(f.inputPath, 0o755); fails(() => capture(f), 'UNSAFE_PATH'); fs.chmodSync(f.inputPath, 0o700);
    fs.chmodSync(f.outputParent, 0o755); fails(() => capture(f), 'UNSAFE_PATH'); fs.chmodSync(f.outputParent, 0o700);
    fs.chmodSync(join(f.inputPath, 'nested'), 0o777); fails(() => capture(f), 'UNSAFE_PATH'); noPublishedManifest(f);
  } finally { f.remove(); }
});

test('private scope reader rejects links, non-private files, invalid UTF8 and oversized metadata', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.metadataPath, JSON.stringify(scope()), { mode: 0o600 }); assert.deepEqual(readLegacyScopeFile(f.metadataPath), normalizeLegacyScope(scope()));
    fs.chmodSync(f.metadataPath, 0o644); fails(() => readLegacyScopeFile(f.metadataPath), 'ARCHIVE_CHANGED'); fs.chmodSync(f.metadataPath, 0o600);
    const link = join(f.root, 'scope-link.json'); fs.symlinkSync(f.metadataPath, link); fails(() => readLegacyScopeFile(link), 'ARCHIVE_CHANGED');
    fs.linkSync(f.metadataPath, join(f.root, 'scope-hard.json')); fails(() => readLegacyScopeFile(f.metadataPath), 'ARCHIVE_CHANGED'); fs.unlinkSync(join(f.root, 'scope-hard.json'));
    fs.writeFileSync(f.metadataPath, Buffer.from([0xff, 0xff])); fails(() => readLegacyScopeFile(f.metadataPath), 'INVALID_METADATA');
    fs.writeFileSync(f.metadataPath, Buffer.alloc(1024 * 1024 + 1)); fails(() => readLegacyScopeFile(f.metadataPath), 'CAPACITY_EXCEEDED');
  } finally { f.remove(); }
});

test('metadata is closed, getter-free and refuses duplicate/escaped keys, sparse arrays, nonopaque labels and path escapes', () => {
  const invalidScopes = [
    { ...scope(), email: 'SENTINEL@example.invalid' }, { ...scope(), tenant: 'SENTINEL@example.invalid' }, { ...scope(), provider: '姓名' },
    { ...scope(), exportedAt: '2026-02-30T00:00:00.000Z' }, scope([dataset('cases', ['../private.csv'])]), scope([dataset('cases', ['/private.csv'])]),
    scope([dataset('cases', ['C:\\private.csv'])]), scope([dataset('cases', ['a/../b.csv'])]), scope([dataset('cases', ['a.csv', 'a.csv'])]),
    scope([dataset('cases', ['a.csv']), dataset('cases', ['b.csv'])]), scope([dataset('cases', ['a.csv']), dataset('other', ['a.csv'])]),
    scope([dataset('cases', ['a.csv'], { sourceRowCount: -1 })]), scope([dataset('cases', ['a.csv'], { sourceRowCount: 0.5 })]),
    scope([dataset('cases', ['a.csv'], { range: { kind: 'date-window', startDate: '2026-13-01', endDate: '2026-13-02' } })]),
    scope([dataset('cases', ['a.csv'], { range: { kind: 'date-window', startDate: '2026-10-02', endDate: '2026-10-01' } })]),
    scope([dataset('cases', ['a.csv'], { range: { kind: 'unknown', startDate: '2026-01-01' } })]), { ...scope(), datasets: Array(1) }
  ];
  for (const value of invalidScopes) fails(() => normalizeLegacyScope(value), 'INVALID_METADATA');
  let executed = false; const getter = scope(); Object.defineProperty(getter, 'provider', { enumerable: true, get() { executed = true; return 'synthetic'; } });
  fails(() => normalizeLegacyScope(getter), 'INVALID_METADATA'); assert.equal(executed, false);
  const symbol = scope(); symbol[Symbol('hidden')] = 'private'; fails(() => normalizeLegacyScope(symbol), 'INVALID_METADATA');
  const hidden = scope(); Object.defineProperty(hidden, 'hidden', { value: true }); fails(() => normalizeLegacyScope(hidden), 'INVALID_METADATA');
  for (const text of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"x":01}', '{"x":1} trailing', '['.repeat(20) + '0' + ']'.repeat(20), '\ufeff{}']) fails(() => parseLegacyJson(Buffer.from(text)), 'INVALID_METADATA');
});

for (const kind of ['tampered-bytes', 'missing-file', 'unexpected-file', 'payload-symlink', 'payload-hardlink', 'manifest-hardlink', 'public-file', 'public-directory']) test('archive verify rejects ' + kind, () => {
  const f = fixture();
  try {
    f.put('a.csv', 'original'); const result = capture(f), saved = manifest(f, result), path = join(archive(f, result), saved.files[0].archivedPath);
    if (kind === 'tampered-bytes') fs.writeFileSync(path, 'changed!');
    if (kind === 'missing-file') fs.unlinkSync(path);
    if (kind === 'unexpected-file') fs.writeFileSync(join(archive(f, result), 'files', 'extra.csv'), 'extra', { mode: 0o600 });
    if (kind === 'payload-symlink') { fs.unlinkSync(path); fs.symlinkSync(join(f.inputPath, 'a.csv'), path); }
    if (kind === 'payload-hardlink') fs.linkSync(path, join(f.root, 'payload-hardlink'));
    if (kind === 'manifest-hardlink') fs.linkSync(join(archive(f, result), 'manifest.json'), join(f.root, 'manifest-hardlink'));
    if (kind === 'public-file') fs.chmodSync(path, 0o644);
    if (kind === 'public-directory') fs.chmodSync(join(archive(f, result), 'files'), 0o755);
    fails(() => verify(f, result), ['ARCHIVE_CHANGED', 'UNSAFE_PATH']);
  } finally { f.remove(); }
});

test('external manifest digest is required and detects metadata substitution before trusting any rows', () => {
  const f = fixture();
  try {
    f.put('a.csv', 'original'); const result = capture(f);
    fails(() => verifyLegacyArchive({ archivePath: archive(f, result) }), 'INVALID_ARGUMENT');
    fails(() => verifyLegacyArchive({ archivePath: archive(f, result), expectedManifestSha256: '0'.repeat(64) }), 'MANIFEST_HASH_MISMATCH');
    const value = manifest(f, result); value.source.tenant = 'changed-tenant'; fs.writeFileSync(join(archive(f, result), 'manifest.json'), JSON.stringify(value));
    fails(() => verify(f, result), 'MANIFEST_HASH_MISMATCH');
  } finally { f.remove(); }
});

test('source comparisons detect a later changed or extra export while the existing snapshot remains valid', () => {
  const f = fixture();
  try {
    f.put('a.csv', 'original'); const result = capture(f); f.put('a.csv', 'changed!');
    assert.equal(verify(f, result).sourceCompared, false); fails(() => verify(f, result, true), 'SOURCE_CHANGED');
    f.put('a.csv', 'original'); f.put('new.csv', 'new'); fails(() => verify(f, result, true), 'SOURCE_CHANGED'); assert.equal(verify(f, result).status, 'verified');
  } finally { f.remove(); }
});

for (const kind of ['short-write', 'write-failure', 'fsync-failure', 'publish-collision', 'post-publish-failure']) test('partial ' + kind + ' retains private evidence and never a complete marker', () => {
  const f = fixture();
  try {
    f.put('a.csv', 'synthetic-original');
    if (kind === 'short-write') {
      patched('writeSync', (call, ...args) => { if (Buffer.isBuffer(args[1])) return 0; return call(...args); }, () => fails(() => capture(f), 'ARCHIVE_IO_FAILED'));
    } else if (kind === 'write-failure') {
      patched('writeSync', () => { throw Object.assign(new Error('SENTINEL-private-driver-path'), { code: 'ENOSPC' }); }, () => fails(() => capture(f), 'ARCHIVE_IO_FAILED'));
    } else if (kind === 'fsync-failure') {
      patched('fsyncSync', () => { throw Object.assign(new Error('SENTINEL-fsync'), { code: 'EIO' }); }, () => fails(() => capture(f), 'ARCHIVE_IO_FAILED'));
    } else if (kind === 'publish-collision') {
      patched('linkSync', (call, from, to) => { fs.writeFileSync(to, 'SENTINEL-preexisting', { mode: 0o600, flag: 'wx' }); return call(from, to); }, () => fails(() => capture(f), 'ARCHIVE_IO_FAILED'));
      // The collision is never overwritten/deleted. It is not a valid complete marker.
      const names = fs.readdirSync(f.outputParent); assert.equal(names.length, 1); assert.equal(fs.readFileSync(join(f.outputParent, names[0], 'manifest.json'), 'utf8'), 'SENTINEL-preexisting');
      fails(() => verifyLegacyArchive({ archivePath: join(f.outputParent, names[0]), expectedManifestSha256: '0'.repeat(64) }), 'MANIFEST_HASH_MISMATCH'); return;
    } else {
      let linked = false;
      patched('linkSync', (call, ...args) => { const result = call(...args); linked = true; return result; }, () =>
        patched('fsyncSync', (call, fd) => { if (linked) throw new Error('SENTINEL-post-publish'); return call(fd); }, () => fails(() => capture(f), 'ARCHIVE_IO_FAILED')));
    }
    noPublishedManifest(f);
    for (const name of fs.readdirSync(f.outputParent)) { assert.equal(fs.lstatSync(join(f.outputParent, name)).mode & 0o777, 0o700); }
    assert.equal(fs.readFileSync(join(f.inputPath, 'a.csv'), 'utf8'), 'synthetic-original');
    const rerun = capture(f); assert.equal(verify(f, rerun, true).status, 'verified');
  } finally { f.remove(); }
});

for (const kind of ['changed-file', 'added-file', 'linked-file', 'replaced-file']) test('concurrent source ' + kind + ' aborts capture rather than declaring consistent bytes', () => {
  const f = fixture();
  try {
    const sourcePath = f.put('a.csv', 'synthetic-original'); let changed = false;
    patched('writeSync', (call, ...args) => {
      const result = call(...args);
      if (!changed) {
        changed = true;
        if (kind === 'changed-file') fs.writeFileSync(sourcePath, 'synthetic-modified');
        if (kind === 'added-file') f.put('b.csv', 'new source file');
        if (kind === 'linked-file') fs.linkSync(sourcePath, join(f.root, 'external-hardlink'));
        if (kind === 'replaced-file') { fs.unlinkSync(sourcePath); fs.writeFileSync(sourcePath, 'synthetic-original', { mode: 0o600 }); }
      }
      return result;
    }, () => fails(() => capture(f), 'SOURCE_CHANGED'));
    noPublishedManifest(f);
  } finally { f.remove(); }
});

test('partial publication cannot verify until the private temporary link is removed; the final descriptor has one link', () => {
  const f = fixture();
  try {
    f.put('a.csv', 'original'); let checked = false;
    const result = patched('linkSync', (call, pending, marker) => {
      const answer = call(pending, marker), archivePath = marker.slice(0, -'/manifest.json'.length), sha256 = legacyHash(fs.readFileSync(pending));
      fails(() => verifyLegacyArchive({ archivePath, expectedManifestSha256: sha256 }), 'ARCHIVE_CHANGED'); checked = true; return answer;
    }, () => capture(f));
    assert.equal(checked, true); assert.equal(fs.lstatSync(join(archive(f, result), 'manifest.json')).nlink, 1); verify(f, result, true);
  } finally { f.remove(); }
});

test('copied file directory entries are fsynced before the manifest can be published', () => {
  const f = fixture();
  try {
    f.put('a.csv', 'original'); let syncedPayloadDirectory = false, published = false;
    const result = patched('fsyncSync', (call, fd) => {
      const value = fs.fstatSync(fd);
      if (value.isDirectory()) for (const name of fs.readdirSync(f.outputParent)) {
        const path = join(f.outputParent, name, 'files');
        if (fs.existsSync(path) && fs.readdirSync(path).length) { const target = fs.lstatSync(path); if (target.dev === value.dev && target.ino === value.ino) syncedPayloadDirectory = true; }
      }
      return call(fd);
    }, () => patched('linkSync', (call, ...args) => { assert.equal(syncedPayloadDirectory, true); published = true; return call(...args); }, () => capture(f)));
    assert.equal(published, true); verify(f, result, true);
  } finally { f.remove(); }
});

test('manifest validator does not accept invented import/completeness, untracked paths or contradictory source counts', () => {
  const f = fixture();
  try {
    f.put('a.csv', 'original'); const result = capture(f), value = manifest(f, result);
    for (const changed of [{ ...value, sourceSystemComplete: true }, { ...value, businessImportCompleted: true }, { ...value, totalBytes: value.totalBytes + 1 },
      { ...value, files: [{ ...value.files[0], archivedPath: '../outside.csv' }] }, { ...value, files: [{ ...value.files[0], bytes: -1 }] },
      { ...value, unassignedFileIds: [] }, { ...value, unexpected: 'SENTINEL' }]) fails(() => validateLegacyManifest(changed), ['INVALID_MANIFEST', 'INVALID_METADATA']);
  } finally { f.remove(); }
});
