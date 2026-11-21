import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

const root = dirname(fileURLToPath(import.meta.url));
const expectedFiles = [
  '.agents/plugins/marketplace.json', '.codex-plugin/plugin.json', '.mcp.json', 'LICENSE', 'README.md',
  'assets/hive-swarm-banner.svg', 'assets/hive-swarm-flow.svg', 'assets/hive-swarm-icon.png', 'assets/hive-swarm-icon.svg',
  'board.css', 'board.html', 'board.js', 'cli.mjs', 'codex.mjs', 'core.mjs', 'engine.mjs', 'hive-bees.js', 'hive-gif.js', 'hive-graph.js',
  'installer.mjs', 'package.json', 'run-store.mjs', 'server.mjs', 'skills/swarm/SKILL.md', 'skills/swarm/agents/openai.yaml', 'worktrees.mjs',
].sort();

// File descriptors also work in Windows shells where creating subprocess pipes is unavailable.
function runCaptured(directory, command, args, options = {}) {
  const {input, ...spawnOptions} = options;
  writeFileSync(join(directory, 'child.stdin'), input ?? '');
  const fds = [openSync(join(directory, 'child.stdin'), 'r'), openSync(join(directory, 'child.stdout'), 'w'),
    openSync(join(directory, 'child.stderr'), 'w')];
  let result;
  try { result = spawnSync(command, args, {...spawnOptions, stdio: fds}); }
  finally { for (const fd of fds) closeSync(fd); }
  return {...result, stdout: readFileSync(join(directory, 'child.stdout'), 'utf8'),
    stderr: readFileSync(join(directory, 'child.stderr'), 'utf8')};
}

function packageFixture(t) {
  mkdirSync(join(root, '.tmp'), {recursive: true});
  const directory = mkdtempSync(join(root, '.tmp', 'npm verifier '));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const source = join(directory, 'package source');
  mkdirSync(source);
  for (const file of expectedFiles) {
    mkdirSync(dirname(join(source, file)), {recursive: true});
    cpSync(join(root, file), join(source, file));
  }
  return {directory, source};
}

function tarEntry(name, contents, mode = 0o644) {
  const header = Buffer.alloc(512);
  header.write(name);
  const octal = (value, offset, width) => header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width);
  octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
  octal(contents.length, 124, 12); octal(0, 136, 12);
  header.fill(32, 148, 156);
  header.write('0', 156);
  header.write('ustar\0', 257, 6);
  header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, contents, Buffer.alloc((512 - contents.length % 512) % 512)]);
}

function fixtureTar(source) {
  return Buffer.concat([...expectedFiles.map(file => tarEntry('package/' + file, readFileSync(join(source, file)), file === 'cli.mjs' ? 0o755 : 0o644)), Buffer.alloc(1024)]);
}

// A controlled external npm process emits real archive bytes and matching digests.
// Verification and filesystem writes still run through the public packCore API.
function fixtureNpm(t, directory, bytes) {
  const payload = join(directory, 'npm-payload.tgz');
  writeFileSync(payload, bytes);
  const script = join(directory, 'npm-cli.js');
  writeFileSync(script, `import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
const bytes = fs.readFileSync(${JSON.stringify(payload)});
const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
const filename = 'hive-swarm-' + manifest.version + '.tgz';
fs.writeFileSync(path.join(process.argv[process.argv.indexOf('--pack-destination') + 1], filename), bytes);
process.stdout.write(JSON.stringify([{filename, integrity: 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64'),
shasum: crypto.createHash('sha1').update(bytes).digest('hex'), unpackedSize: 1,
files: [{path: 'cli.mjs', mode: 493}]}]));\n`);
  const previous = process.env.npm_execpath;
  process.env.npm_execpath = script;
  t.after(() => { if (previous === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = previous; });
}

test('archive verification requires two zero blocks and rejects hidden or concatenated trailing entries', async t => {
  const {packCore} = await import('./scripts/pack-core.mjs');
  const {directory, source} = packageFixture(t);
  const tar = fixtureTar(source);
  const extra = tarEntry('package/hidden-secret', Buffer.from('must never extract'));
  const variants = [
    ['missing terminator', gzipSync(tar.subarray(0, -1024))],
    ['single zero block', gzipSync(tar.subarray(0, -512))],
    ['entry after one zero block', gzipSync(Buffer.concat([tar.subarray(0, -512), extra, Buffer.alloc(1024)]))],
    ['entry after two zero blocks', gzipSync(Buffer.concat([tar, extra, Buffer.alloc(1024)]))],
    ['concatenated gzip archives', Buffer.concat([gzipSync(tar), gzipSync(Buffer.concat([extra, Buffer.alloc(1024)]))])],
    ['partial padding block', gzipSync(Buffer.concat([tar, Buffer.alloc(1)]))],
  ];
  for (const [label, bytes] of variants) {
    await t.test(label, async t => {
      fixtureNpm(t, directory, bytes);
      await assert.rejects(packCore({packageDirectory: source, outputDirectory: join(directory, label)}), /tar.*(terminat|trailing|padding|block)/i);
    });
  }
});

test('archive verification rejects changed tar headers despite matching npm archive digests', async t => {
  const {packCore} = await import('./scripts/pack-core.mjs');
  const {directory, source} = packageFixture(t);
  const tar = fixtureTar(source);
  tar[100] ^= 1;
  fixtureNpm(t, directory, gzipSync(tar));
  await assert.rejects(packCore({packageDirectory: source, outputDirectory: join(directory, 'output')}), /tar.*checksum/i);
});

test('pack uses a fresh private stage and preserves existing archive and log link targets', async t => {
  const {packCore} = await import('./scripts/pack-core.mjs');
  const {directory, source} = packageFixture(t);
  fixtureNpm(t, directory, gzipSync(fixtureTar(source)));
  const outputDirectory = join(directory, 'output');
  mkdirSync(outputDirectory);
  const names = ['hive-swarm-2.1.0.tgz', 'npm-pack.stdout.log', 'npm-pack.stderr.log'];
  for (const name of names) {
    const target = join(directory, 'retained ' + name);
    writeFileSync(target, 'retained unverified candidate');
    if (process.platform === 'win32') linkSync(target, join(outputDirectory, name));
    else symlinkSync(target, join(outputDirectory, name));
  }
  const first = await packCore({packageDirectory: source, outputDirectory});
  for (const name of names) assert.equal(readFileSync(join(directory, 'retained ' + name), 'utf8'), 'retained unverified candidate', name);
  assert.notEqual(dirname(first.tarball), outputDirectory);
  assert.equal(dirname(dirname(first.tarball)), outputDirectory);
  assert.equal(lstatSync(dirname(first.tarball)).isSymbolicLink(), false);
  if (process.platform !== 'win32') assert.equal(lstatSync(dirname(first.tarball)).mode & 0o777, 0o700);
  const second = await packCore({packageDirectory: source, outputDirectory});
  assert.notEqual(first.tarball, second.tarball, 'a later pack must never reuse a candidate path');
  assert.ok(existsSync(first.tarball));
});

test('pack refuses a pre-existing output directory symlink or Windows junction', async t => {
  const {packCore} = await import('./scripts/pack-core.mjs');
  const {directory, source} = packageFixture(t);
  fixtureNpm(t, directory, gzipSync(fixtureTar(source)));
  const target = join(directory, 'foreign output');
  const link = join(directory, 'linked output');
  mkdirSync(target);
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(packCore({packageDirectory: source, outputDirectory: link}), /symlink|symbolic|junction/i);
  assert.deepEqual(readdirSync(target), []);
});

test('failed verification removes only its owned candidate stage', async t => {
  const {packCore} = await import('./scripts/pack-core.mjs');
  const {directory, source} = packageFixture(t);
  fixtureNpm(t, directory, gzipSync(Buffer.concat([tarEntry('package/unlisted', Buffer.from('bad')), Buffer.alloc(1024)])));
  const outputDirectory = join(directory, 'output');
  mkdirSync(outputDirectory);
  writeFileSync(join(outputDirectory, 'hive-swarm-2.1.0.tgz'), 'retain original');
  await assert.rejects(packCore({packageDirectory: source, outputDirectory}), /allowlist/);
  assert.equal(readFileSync(join(outputDirectory, 'hive-swarm-2.1.0.tgz'), 'utf8'), 'retain original');
  assert.deepEqual(readdirSync(outputDirectory), ['hive-swarm-2.1.0.tgz']);
});

test('the package exposes an ESM CLI and library without install side effects or runtime dependencies', () => {
  assert.ok(existsSync(join(root, 'package.json')), 'An npm package manifest must exist');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'hive-swarm');
  assert.equal(manifest.version, '2.1.0');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.bin['hive-swarm'], './cli.mjs');
  assert.equal(manifest.exports['./engine'], './engine.mjs');
  assert.equal(manifest.exports['./worktrees'], './worktrees.mjs');
  assert.equal(manifest.exports['./core'], './core.mjs');
  assert.equal(manifest.exports['./run-store'], './run-store.mjs');
  assert.equal(manifest.engines.node, '^22.19.0 || >=24.2.0');
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.optionalDependencies ?? {}, {});
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly']) {
    assert.equal(manifest.scripts?.[hook], undefined, hook);
  }
  assert.deepEqual([...manifest.files, 'package.json', 'README.md', 'LICENSE'].sort(), expectedFiles);
});

test('real npm packaging uses the compact registry README while preserving source documentation',async t=>{
  const {packCore}=await import('./scripts/pack-core.mjs');const {directory,source}=packageFixture(t);
  const sourceText='Source-only gallery documentation '+directory;const compact='# Hive Swarm registry README\nNo unpackaged gallery assets.\n';
  writeFileSync(join(source,'README.md'),sourceText);writeFileSync(join(source,'README.npm.md'),compact);
  const result=await packCore({packageDirectory:source,outputDirectory:join(directory,'packed')});
  const {gunzipSync}=await import('node:zlib');const tar=gunzipSync(readFileSync(result.tarball));
  assert.equal(tar.includes(Buffer.from(compact)),true);assert.equal(tar.includes(Buffer.from(sourceText)),false);
  assert.equal(readFileSync(join(source,'README.md'),'utf8'),sourceText);assert.equal(result.files.includes('README.npm.md'),false);
});

test('a real core tarball contains only exact public files and runs from a path with spaces and Unicode', {timeout: 60000}, async t => {
  const helper = join(root, 'scripts', 'pack-core.mjs');
  assert.ok(existsSync(helper), 'The real npm pack verification helper must exist');
  const {packCore} = await import('./scripts/pack-core.mjs');
  mkdirSync(join(root, '.tmp'), {recursive: true});
  const directory = mkdtempSync(join(root, '.tmp', 'npm archive có dấu '));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const source = join(directory, 'package source');
  mkdirSync(source);
  for (const file of expectedFiles) {
    mkdirSync(dirname(join(source, file)), {recursive: true});
    cpSync(join(root, file), join(source, file));
  }
  for (const file of ['unlisted.mjs', 'assets/gallery.png', 'cli.test.mjs', '.tmp/secret.json',
    '.private/auth.json', 'skills/swarm/private.txt', '.codex-plugin/private.json', 'node_modules/secret/index.js']) {
    mkdirSync(dirname(join(source, file)), {recursive: true});
    writeFileSync(join(source, file), 'DO NOT SHIP');
  }
  const packed = await packCore({packageDirectory: source, outputDirectory: join(directory, 'packed output')});
  assert.ok(existsSync(packed.tarball));
  assert.deepEqual(packed.files, expectedFiles);
  assert.ok(packed.size > 10000 && packed.size < 500000, `core archive bytes: ${packed.size}`);
  assert.equal(packed.verifiedFiles, expectedFiles.length);
  assert.match(packed.integrity, /^sha512-/);
  const extracted = join(directory, 'extracted runtime có dấu');
  mkdirSync(extracted);
  const tar = runCaptured(directory, 'tar', ['-xzf', '-'], {cwd: extracted, input: readFileSync(packed.tarball), timeout: 10000});
  assert.equal(tar.status, 0, tar.stderr);
  const packageDirectory = join(extracted, 'package');
  for (const file of expectedFiles) assert.deepEqual(readFileSync(join(packageDirectory, file)), readFileSync(join(source, file)), file);
  const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
  const home = join(directory, 'isolated home');
  const executable = join(directory, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const marker = join(directory, 'packaged doctor launched Codex');
  writeFileSync(executable, process.platform === 'win32' ? `@echo launched>"${marker}"\r\n` : `#!/bin/sh\necho launched > '${marker}'\n`);
  chmodSync(executable, 0o755);
  const env = {...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home,
    CODEX_HOME: join(home, '.codex'), HIVE_SWARM_DATA: join(home, 'data'), HIVE_SWARM_CODEX: executable};
  const version = runCaptured(directory, process.execPath, [join(packageDirectory, manifest.bin['hive-swarm']), '--version'],
    {cwd: directory, env, encoding: 'utf8', timeout: 10000});
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), '2.1.0');
  const help = runCaptured(directory, process.execPath, [join(packageDirectory, 'cli.mjs'), '--help'],
    {cwd: directory, env, encoding: 'utf8', timeout: 10000});
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: hive-swarm/);
  const module = await import(pathToFileURL(join(packageDirectory, 'cli.mjs')));
  let output = '';
  const doctorCode = await module.main(['doctor'], {packageDirectory, home, env,
    stdout: {write: value => { output += value; }}, stderr: {write: value => { output += value; }}});
  // Runtime identity is intentionally still owned by the coordinator in this slice.
  const runtimeVersion = JSON.parse(readFileSync(join(packageDirectory, '.codex-plugin/plugin.json'), 'utf8')).version;
  assert.equal(doctorCode, runtimeVersion === manifest.version ? 0 : 1, output);
  assert.match(output, /SQLite/);
  assert.match(output, /read-only/);
  assert.match(output, /located.*not executed/i);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(home), false);
  const rpc = [
    {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'pack-check', version: '1'}}},
    {jsonrpc: '2.0', method: 'notifications/initialized'},
    {jsonrpc: '2.0', id: 2, method: 'tools/list'},
    {jsonrpc: '2.0', id: 3, method: 'resources/list'},
    {jsonrpc: '2.0', id: 4, method: 'resources/read', params: {uri: 'ui://hive-swarm/board.html'}},
  ].map(value => JSON.stringify(value)).join('\n') + '\n';
  const server = runCaptured(directory, process.execPath, [join(packageDirectory, 'server.mjs')],
    {cwd: directory, env, input: rpc, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024});
  assert.equal(server.status, 0, server.stderr);
  const responses = new Map(server.stdout.trim().split('\n').map(line => { const value = JSON.parse(line); return [value.id, value]; }));
  assert.equal(responses.size, 4);
  for (const response of responses.values()) assert.equal(response.error, undefined);
  assert.equal(responses.get(1).result.serverInfo.name, 'hive-swarm');
  assert.equal(responses.get(1).result.serverInfo.version, runtimeVersion);
  assert.ok(responses.get(2).result.tools.some(tool => tool.name === 'start_team'));
  assert.equal(responses.get(3).result.resources[0].uri, 'ui://hive-swarm/board.html');
  const html = responses.get(4).result.contents[0].text;
  assert.match(html, /<style>/);
  assert.match(html, /<script>/);
  assert.doesNotMatch(html, /<!-- hive-(style|scripts) -->/);
  assert.equal(existsSync(home), false, 'MCP discovery must not create state or invoke models');
  t.diagnostic(JSON.stringify({files: packed.files.length, size: packed.size, integrity: packed.integrity,
    doctorCode, runtimeVersion, mcpResponses: responses.size}));
});
