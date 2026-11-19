import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = dirname(fileURLToPath(import.meta.url));
const expectedFiles = [
  '.agents/plugins/marketplace.json', '.codex-plugin/plugin.json', '.mcp.json', 'LICENSE', 'README.md',
  'assets/hive-swarm-banner.svg', 'assets/hive-swarm-flow.svg', 'assets/hive-swarm-icon.png', 'assets/hive-swarm-icon.svg',
  'board.css', 'board.html', 'board.js', 'cli.mjs', 'codex.mjs', 'engine.mjs', 'hive-bees.js', 'hive-graph.js',
  'package.json', 'server.mjs', 'skills/swarm/SKILL.md', 'skills/swarm/agents/openai.yaml', 'worktrees.mjs',
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

test('the package exposes an ESM CLI and library without install side effects or runtime dependencies', () => {
  assert.ok(existsSync(join(root, 'package.json')), 'An npm package manifest must exist');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'hive-swarm');
  assert.equal(manifest.version, '1.8.0');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.bin['hive-swarm'], './cli.mjs');
  assert.equal(manifest.exports['./engine'], './engine.mjs');
  assert.equal(manifest.exports['./worktrees'], './worktrees.mjs');
  assert.equal(manifest.engines.node, '^22.19.0 || >=24.2.0');
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.optionalDependencies ?? {}, {});
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly']) {
    assert.equal(manifest.scripts?.[hook], undefined, hook);
  }
  assert.deepEqual([...manifest.files, 'package.json', 'README.md', 'LICENSE'].sort(), expectedFiles);
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
  const env = {...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home,
    CODEX_HOME: join(home, '.codex'), HIVE_SWARM_DATA: join(home, 'data')};
  const version = runCaptured(directory, process.execPath, [join(packageDirectory, manifest.bin['hive-swarm']), '--version'],
    {cwd: directory, env, encoding: 'utf8', timeout: 10000});
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), '1.8.0');
  const help = runCaptured(directory, process.execPath, [join(packageDirectory, 'cli.mjs'), '--help'],
    {cwd: directory, env, encoding: 'utf8', timeout: 10000});
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: hive-swarm/);
  const module = await import(pathToFileURL(join(packageDirectory, 'cli.mjs')));
  let output = '';
  const doctorCode = await module.main(['doctor'], {packageDirectory, home, env,
    stdout: {write: value => { output += value; }}, stderr: {write: value => { output += value; }},
    runCommand: async () => ({exitCode: 0, stdout: 'codex-cli 0.169.1'})});
  // Runtime identity is intentionally still owned by the coordinator in this slice.
  const runtimeVersion = JSON.parse(readFileSync(join(packageDirectory, '.codex-plugin/plugin.json'), 'utf8')).version;
  assert.equal(doctorCode, runtimeVersion === manifest.version ? 0 : 1, output);
  assert.match(output, /SQLite/);
  assert.match(output, /read-only/);
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
