import { captureLegacyArchive, readLegacyScopeFile, verifyLegacyArchive } from '../src/server/legacy-migration-archive.mjs';
import { LegacyArchiveError } from '../src/server/legacy-migration-archive-metadata.mjs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const invalid = () => { throw new LegacyArchiveError('INVALID_ARGUMENT'); };
function options(args, required, optional = []) {
  if (args.length % 2) invalid(); const result = Object.create(null);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (![...required, ...optional].includes(name) || Object.hasOwn(result, name) || typeof value !== 'string' || !value || value.startsWith('--')) invalid();
    result[name] = value;
  }
  if (required.some(name => !Object.hasOwn(result, name))) invalid(); return result;
}
const inside = (parent, child) => { const value = relative(parent, child); return value === '' || (!value.startsWith('..' + sep) && value !== '..' && !isAbsolute(value)); };
let result;
try {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === 'capture') {
    const values = options(args, ['--input', '--output-parent', '--scope']);
    if (!isAbsolute(values['--scope']) || inside(resolve(values['--input']), resolve(values['--scope']))
        || inside(resolve(values['--output-parent']), resolve(values['--scope']))) invalid();
    const scope = readLegacyScopeFile(values['--scope']);
    result = captureLegacyArchive({ inputPath: values['--input'], outputParent: values['--output-parent'], scope });
  } else if (operation === 'verify') {
    const values = options(args, ['--archive', '--expected-manifest-sha256'], ['--input']);
    result = verifyLegacyArchive({ archivePath: values['--archive'], expectedManifestSha256: values['--expected-manifest-sha256'],
      ...(Object.hasOwn(values, '--input') ? { inputPath: values['--input'] } : {}) });
  } else invalid();
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  const code = error instanceof LegacyArchiveError ? error.code : 'ARCHIVE_IO_FAILED';
  const archiveId = typeof error?.archiveId === 'string' && /^archive-[a-f0-9-]+$/.test(error.archiveId) ? error.archiveId : undefined;
  process.stderr.write(JSON.stringify({ status: 'failed', code, ...(archiveId ? { archiveId } : {}) }) + '\n'); process.exitCode = 1;
}
