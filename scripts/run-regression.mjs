import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function regressionShard(commands, shard = '1/1') {
  if (!/^[1-9]\d*\/[1-9]\d*$/u.test(shard)) throw new Error('Shard must be index/total.');
  const [index, total] = shard.split('/').map(Number);
  if (total > 32 || index > total) throw new Error('Shard must be within 1..32.');
  const all = Object.entries(commands).filter(([name]) => !['unit', 'check'].includes(name));
  return all.filter((_, offset) => offset % total === index - 1).map(([name, command]) => {
    // No shell, environment file, provisioning command or operator database path.
    if (!/^node (?:tests\/[a-z0-9-]+\.mjs|scripts\/rehearse-synthetic(?:-portal|-encrypted)?-backup\.mjs)$/u.test(command)) {
      throw new Error('Unsupported regression command: ' + name);
    }
    return { name, file: command.slice(5) };
  });
}
async function main() {
  const args = process.argv.slice(2);
  if (args.some(x => x !== '--list' && !x.startsWith('--shard='))) throw new Error('Use --shard=index/total and optional --list.');
  const options = args.filter(x => x.startsWith('--shard='));
  if (options.length > 1 || args.filter(x => x === '--list').length > 1) throw new Error('Duplicate options.');
  const shard = options[0]?.slice(8) || '1/1';
  const config = JSON.parse(await readFile(path.join(root, 'premium-ui.json'), 'utf8'));
  const commands = regressionShard(config.commands, shard);
  if (args.includes('--list')) { console.log(JSON.stringify(commands, null, 2)); return; }
  const output = path.join(root, 'outputs/software/regression', `${shard.replace('/', '-')}-${Date.now()}`);
  await mkdir(output, { recursive: true });
  const results = [];
  for (const { name, file } of commands) {
    const started = Date.now();
    const log = path.join(output, name + '.log');
    const stream = createWriteStream(log, { flags: 'wx' });
    const child = spawn(process.execPath, [file], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
    // A factory-owned encrypted rehearsal receives a throwaway secret only over stdin.
    if (name === 'syntheticEncryptedBackup') {
      const passphrase = Buffer.from(randomBytes(32).toString('hex') + '\n');
      child.stdin.end(passphrase, () => passphrase.fill(0));
    } else child.stdin.end();
    const result = await new Promise(resolve => {
      child.once('error', error => resolve({ exitCode: null, signal: null, error: error.code || 'SPAWN_FAILED' }));
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    await new Promise(resolve => stream.end(resolve));
    results.push({ name, file, ...result, elapsedMs: Date.now() - started, log });
    await writeFile(path.join(output, 'results.json'), JSON.stringify({ shard, results }, null, 2));
    console.log(`${result.exitCode === 0 ? 'PASS' : 'FAIL'} ${name}: exit=${result.exitCode} signal=${result.signal || 'none'}`);
    if (result.exitCode !== 0 && name !== 'syntheticEncryptedBackup') {
      // Closed synthetic tests only; disable workflow commands around failure text.
      const diagnosticToken = randomBytes(12).toString('hex');
      const tail = (await readFile(log, 'utf8')).slice(-12000);
      console.log('::stop-commands::' + diagnosticToken);
      console.error('Synthetic failure output (' + name + ', last 12000 characters):\n' + tail);
      console.log('::' + diagnosticToken + '::');
    }
  }
  console.log('Native regression evidence: ' + output);
  if (results.some(x => x.exitCode !== 0)) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
