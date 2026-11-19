#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { delimiter, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const coreFiles = [
  '.agents/plugins/marketplace.json', '.codex-plugin/plugin.json', '.mcp.json', 'LICENSE', 'README.md',
  'assets/hive-swarm-banner.svg', 'assets/hive-swarm-flow.svg', 'assets/hive-swarm-icon.png', 'assets/hive-swarm-icon.svg',
  'board.css', 'board.html', 'board.js', 'cli.mjs', 'codex.mjs', 'engine.mjs', 'hive-bees.js', 'hive-graph.js',
  'package.json', 'server.mjs', 'skills/swarm/SKILL.md', 'skills/swarm/agents/openai.yaml', 'worktrees.mjs',
].sort();

function npmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const directory of (process.env.PATH || process.env.Path || '').split(delimiter)) {
    for (const name of ['npm', 'npm.cmd']) {
      const binary = join(directory, name);
      if (!existsSync(binary)) continue;
      candidates.push(realpathSync(binary), join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
  }
  const found = candidates.find(path => path?.endsWith('npm-cli.js') && existsSync(path));
  if (!found) throw Error('Cannot locate npm-cli.js; install npm alongside Node.js.');
  return found;
}

function archiveFiles(bytes) {
  const tar = gunzipSync(bytes, {maxOutputLength: 2 * 1024 * 1024});
  assert.ok(tar.length >= 1024 && tar.length % 512 === 0, 'Invalid tar block padding or missing terminator');
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      assert.ok(offset + 1024 <= tar.length && tar.subarray(offset + 512, offset + 1024).every(byte => byte === 0), 'Incomplete tar terminator: two zero blocks required');
      assert.ok(tar.subarray(offset + 1024).every(byte => byte === 0), 'Nonzero trailing tar entries after terminator');
      return files;
    }
    const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    const checksum = field(148, 156).trim();
    const actualChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    assert.ok(/^[0-7]+$/.test(checksum) && Number.parseInt(checksum, 8) === actualChecksum, 'Invalid tar header checksum');
    const prefix = field(345, 500);
    const name = (prefix ? prefix + '/' : '') + field(0, 100);
    const sizeField = field(124, 136).trim();
    assert.match(sizeField, /^[0-7]+$/, 'Invalid tar entry size');
    const size = Number.parseInt(sizeField, 8);
    const type = field(156, 157);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + Math.ceil(size / 512) * 512 <= tar.length, 'Invalid tar entry size or padding');
    assert.ok(name.startsWith('package/') && !name.includes('..') && !name.includes('\\'), `Unsafe tar entry: ${name}`);
    if (type === '0' || type === '') {
      const relative = name.slice('package/'.length);
      assert.ok(!files.has(relative), `Duplicate tar entry: ${name}`);
      files.set(relative, tar.subarray(offset + 512, offset + 512 + size));
    } else {
      assert.equal(type, '5', `Unsupported tar entry type for ${name}`);
      assert.equal(size, 0, `Invalid tar directory size for ${name}`);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw Error('Missing tar terminator: two zero blocks required');
}

function prepareOutputDirectory(directory) {
  let current = parse(directory).root;
  for (const part of relative(current, directory).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      mkdirSync(current, {mode: 0o700});
      info = lstatSync(current);
    }
    assert.ok(!info.isSymbolicLink(), `Refusing symlink or junction output path: ${current}`);
    assert.ok(info.isDirectory(), `Output path is not a directory: ${current}`);
  }
}

/** Pack with npm itself, then verify the actual compressed archive against source bytes. */
export async function packCore({packageDirectory = root, outputDirectory = join(root, '.tmp', 'npm-core')} = {}) {
  packageDirectory = resolve(packageDirectory);
  outputDirectory = resolve(outputDirectory);
  const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
  assert.deepEqual([...manifest.files, 'package.json', 'README.md', 'LICENSE'].sort(), coreFiles, 'Core npm allowlist drift');
  for (const file of coreFiles) assert.ok(lstatSync(join(packageDirectory, file)).isFile(), `Required public source file: ${file}`);
  prepareOutputDirectory(outputDirectory);
  const staging = mkdtempSync(join(outputDirectory, '.pack-core-'));
  const owned = lstatSync(staging);
  try {
    let out, err;
    let result;
    try {
      out = openSync(join(staging, 'npm-pack.stdout.log'), 'wx', 0o600);
      err = openSync(join(staging, 'npm-pack.stderr.log'), 'wx', 0o600);
      result = spawnSync(process.execPath, [npmCli(), 'pack', '--offline', '--ignore-scripts', '--json',
        '--pack-destination', staging, '--userconfig', join(staging, 'empty-user.npmrc'),
        '--globalconfig', join(staging, 'empty-global.npmrc')], {
        cwd: packageDirectory, windowsHide: true, stdio: ['ignore', out, err], timeout: 30000,
        env: {...process.env, npm_config_cache: join(staging, '.npm-cache'), npm_config_update_notifier: 'false'},
      });
    } finally {
      if (out !== undefined) closeSync(out);
      if (err !== undefined) closeSync(err);
    }
    if (result.error) throw result.error;
    assert.equal(result.status, 0, readFileSync(join(staging, 'npm-pack.stderr.log'), 'utf8'));
    const stdout = readFileSync(join(staging, 'npm-pack.stdout.log'), 'utf8');
    const [metadata] = JSON.parse(stdout);
    assert.equal(metadata.filename, `hive-swarm-${manifest.version}.tgz`);
    assert.match(metadata.filename, /^hive-swarm-[0-9A-Za-z.+-]+\.tgz$/, 'Unsafe npm archive filename');
    const tarball = join(staging, metadata.filename);
    assert.ok(lstatSync(tarball).isFile(), 'Candidate archive must be a regular file');
    const bytes = readFileSync(tarball);
    assert.ok(bytes.length < 500000, `Core archive too large: ${bytes.length} bytes`);
    const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
    assert.equal(integrity, metadata.integrity, 'npm archive integrity mismatch');
    assert.equal(createHash('sha1').update(bytes).digest('hex'), metadata.shasum, 'npm archive shasum mismatch');
    const files = archiveFiles(bytes);
    assert.deepEqual([...files.keys()].sort(), coreFiles, 'Actual tarball differs from the exact public allowlist');
    for (const [file, contents] of files) assert.deepEqual(contents, readFileSync(join(packageDirectory, file)), `Archive/source mismatch: ${file}`);
    assert.ok(metadata.files.find(file => file.path === 'cli.mjs')?.mode & 0o111, 'npm bin must be executable');
    return {tarball, files: [...files.keys()].sort(), size: bytes.length, unpackedSize: metadata.unpackedSize,
      integrity, verifiedFiles: files.size};
  } catch (error) {
    // Only this freshly-created direct child may be removed; never a reusable output path.
    const name = relative(outputDirectory, staging);
    const current = lstatSync(staging);
    if (name.startsWith('.pack-core-') && !name.includes(sep) && !current.isSymbolicLink() &&
      current.isDirectory() && current.dev === owned.dev && current.ino === owned.ino) {
      rmSync(staging, {recursive: true, force: true});
    }
    throw error;
  }
}

if (import.meta.main) {
  if (process.argv.length > 3) throw Error('Usage: node scripts/pack-core.mjs [output-directory]');
  console.log(JSON.stringify(await packCore({outputDirectory: process.argv[2] || undefined}), null, 2));
}
