#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
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
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    const prefix = field(345, 500);
    const name = (prefix ? prefix + '/' : '') + field(0, 100);
    const size = Number.parseInt(field(124, 136).trim(), 8);
    const type = field(156, 157);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, 'Invalid tar entry size');
    assert.ok(name.startsWith('package/') && !name.includes('..') && !name.includes('\\'), `Unsafe tar entry: ${name}`);
    if (type === '0' || type === '') {
      const relative = name.slice('package/'.length);
      assert.ok(!files.has(relative), `Duplicate tar entry: ${name}`);
      files.set(relative, tar.subarray(offset + 512, offset + 512 + size));
    } else {
      assert.equal(type, '5', `Unsupported tar entry type for ${name}`);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Pack with npm itself, then verify the actual compressed archive against source bytes. */
export async function packCore({packageDirectory = root, outputDirectory = join(root, '.tmp', 'npm-core')} = {}) {
  packageDirectory = resolve(packageDirectory);
  outputDirectory = resolve(outputDirectory);
  const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
  assert.deepEqual([...manifest.files, 'package.json', 'README.md', 'LICENSE'].sort(), coreFiles, 'Core npm allowlist drift');
  for (const file of coreFiles) assert.ok(lstatSync(join(packageDirectory, file)).isFile(), `Required public source file: ${file}`);
  mkdirSync(outputDirectory, {recursive: true});
  const out = openSync(join(outputDirectory, 'npm-pack.stdout.log'), 'w');
  const err = openSync(join(outputDirectory, 'npm-pack.stderr.log'), 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [npmCli(), 'pack', '--offline', '--ignore-scripts', '--json',
      '--pack-destination', outputDirectory, '--userconfig', join(outputDirectory, 'empty-user.npmrc'),
      '--globalconfig', join(outputDirectory, 'empty-global.npmrc')], {
      cwd: packageDirectory, windowsHide: true, stdio: ['ignore', out, err], timeout: 30000,
      env: {...process.env, npm_config_cache: join(outputDirectory, '.npm-cache'), npm_config_update_notifier: 'false'},
    });
  } finally { closeSync(out); closeSync(err); }
  if (result.error) throw result.error;
  assert.equal(result.status, 0, readFileSync(join(outputDirectory, 'npm-pack.stderr.log'), 'utf8'));
  const stdout = readFileSync(join(outputDirectory, 'npm-pack.stdout.log'), 'utf8');
  const [metadata] = JSON.parse(stdout);
  assert.equal(metadata.filename, `hive-swarm-${manifest.version}.tgz`);
  const tarball = join(outputDirectory, metadata.filename);
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
}

if (import.meta.main) {
  if (process.argv.length > 3) throw Error('Usage: node scripts/pack-core.mjs [output-directory]');
  console.log(JSON.stringify(await packCore({outputDirectory: process.argv[2] || undefined}), null, 2));
}
