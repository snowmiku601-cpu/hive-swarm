import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import {removeFixture as rmSync} from './test-support.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(fileURLToPath(import.meta.url));
const cliPath = join(root, 'cli.mjs');

async function cli() {
  assert.ok(existsSync(cliPath), 'The npm CLI entry point must exist');
  return import('./cli.mjs');
}

function capture(options = {}) {
  let stdout = '', stderr = '';
  return {
    options: {stdout: {write: text => { stdout += text; }}, stderr: {write: text => { stderr += text; }}, ...options},
    output: () => ({stdout, stderr}),
  };
}

function fixture(t) {
  mkdirSync(join(root, '.tmp'), {recursive: true});
  const directory = mkdtempSync(join(root, '.tmp', 'cli path có dấu '));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const packageDirectory = join(directory, 'core package');
  mkdirSync(packageDirectory);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const file of [...manifest.files, 'package.json', 'README.md', 'LICENSE']) {
    const destination = join(packageDirectory, file);
    mkdirSync(dirname(destination), {recursive: true});
    cpSync(join(root, file), destination);
  }
  const pluginPath = join(packageDirectory, '.codex-plugin', 'plugin.json');
  const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'));
  writeFileSync(pluginPath, JSON.stringify({...plugin, version: manifest.version}));
  const home = join(directory, 'home chưa tạo');
  return {directory, packageDirectory, home, pluginPath};
}

function tree(directory) {
  return readdirSync(directory, {recursive: true}).sort().map(name => {
    const path = join(directory, name);
    return [name, statSync(path).isFile() ? readFileSync(path).toString('base64') : null];
  });
}

test('help and version work without a host command or home directory', async () => {
  const {main} = await cli();
  for (const argv of [[], ['--help'], ['-h'], ['--version'], ['-v']]) {
    const io = capture({home: 'missing home', runCommand: () => { throw Error('must not probe a host'); }});
    assert.equal(await main(argv, io.options), 0);
    assert.equal(io.output().stderr, '');
    if (argv.includes('--version') || argv.includes('-v')) assert.equal(io.output().stdout.trim(), '1.9.0');
    else {
      assert.match(io.output().stdout, /Usage: hive-swarm/);
      assert.match(io.output().stdout, /doctor/);
      assert.match(io.output().stdout, /hive-swarm (install|update|uninstall)/);
    }
  }
});

test('unknown commands and malformed arguments return useful nonzero errors', async () => {
  const {main} = await cli();
  for (const argv of [['wat'], ['install', '--host'], ['doctor', '--host'], ['doctor', '--host', 'other'],
    ['doctor', '--write'], ['--version', 'extra'], ['doctor', '--host', 'codex', '--host', 'codex']]) {
    const io = capture({runCommand: () => { assert.fail('invalid input must not invoke a host'); }});
    assert.equal(await main(argv, io.options), 2, JSON.stringify(argv));
    assert.match(io.output().stderr, /hive-swarm --help/);
    assert.equal(io.output().stdout, '');
  }
});

test('Codex lifecycle commands delegate with injectable host execution', async t => {
  const {main} = await cli();
  const paths = fixture(t);
  const io = capture({...paths, env: {CODEX_HOME: paths.home, HIVE_SWARM_CODEX: 'codex fixture'},
    runCommand: () => { assert.fail('an absent owned store and Codex home need no host command'); }});
  assert.equal(await main(['uninstall', '--host', 'codex'], io.options), 0, io.output().stderr);
  assert.match(io.output().stdout, /no managed.*installation/i);
  assert.equal(existsSync(paths.home), false);
});

test('lifecycle --host dsh explains DSH-owned installation without invoking a command', async () => {
  const {main} = await cli();
  let invoked = false;
  const io = capture({runCommand: () => { invoked = true; }});
  assert.equal(await main(['install', '--host', 'dsh'], io.options), 2);
  assert.equal(invoked, false);
  assert.match(io.output().stderr, /dsh plugin.*dsh-hive-swarm/i);
  assert.match(io.output().stderr, /profile/i);
  assert.equal(await main(['update', '--host', 'dsh'], io.options), 2);
  assert.equal(await main(['uninstall', '--host', 'dsh'], io.options), 2);
  assert.match(io.output().stderr, /dsh plugin.*remove/i);
});

test('DSH doctor directs users to the native bundle without probing or changing a profile', async () => {
  const {main} = await cli();
  const io = capture({runCommand: () => { assert.fail('DSH must own its profile'); }});
  assert.equal(await main(['doctor', '--host', 'dsh'], io.options), 2);
  assert.match(io.output().stderr, /dsh-hive-swarm/);
});

test('explicit doctor diagnostics read an injected package and report paths without creating home or data', async t => {
  const {main} = await cli();
  const paths = fixture(t);
  const before = tree(paths.directory);
  const calls = [];
  const executable = join(paths.directory, 'Codex tools', 'codex executable');
  const io = capture({...paths, env: {HIVE_SWARM_CODEX: executable}, runCommand: async (command, args) => {
    calls.push({command, args});
    return {exitCode: 0, stdout: 'codex-cli 0.169.1\n', stderr: ''};
  }});
  assert.equal(await main(['doctor', '--host', 'codex'], io.options), 0, JSON.stringify(io.output()));
  const {stdout, stderr} = io.output();
  assert.equal(stderr, '');
  assert.match(stdout, /PASS.*Node\.js/);
  assert.match(stdout, /PASS.*SQLite/);
  assert.match(stdout, /PASS.*1\.9\.0/);
  assert.match(stdout, /codex-cli 0\.169\.1/);
  assert.ok(stdout.includes(paths.packageDirectory));
  assert.ok(stdout.includes(join(paths.home, '.codex')));
  assert.ok(stdout.includes(join(paths.home, 'CodexTeamBoard')));
  assert.match(stdout, /explicit diagnostic runner/);
  assert.deepEqual(calls, [{command: executable, args: ['--version']}]);
  assert.deepEqual(tree(paths.directory), before);
  assert.equal(existsSync(paths.home), false);
});

test('doctor respects injected home and data overrides without reading profile contents', async t => {
  const {main} = await cli();
  const paths = fixture(t);
  const codexHome = join(paths.directory, 'private codex home');
  const data = join(paths.directory, 'saved board data');
  const io = capture({...paths, env: {CODEX_HOME: codexHome, HIVE_SWARM_DATA: data},
    runCommand: async () => ({exitCode: 0, stdout: 'codex-cli 0.169.1'})});
  assert.equal(await main(['doctor'], io.options), 0);
  assert.ok(io.output().stdout.includes(codexHome));
  assert.ok(io.output().stdout.includes(data));
  assert.equal(existsSync(codexHome), false);
  assert.equal(existsSync(data), false);
});

test('doctor fails clearly when Codex cannot be executed or exits unsuccessfully', async t => {
  const {main} = await cli();
  const paths = fixture(t);
  for (const runCommand of [async () => { throw Object.assign(Error('not found'), {code: 'ENOENT'}); },
    async () => ({exitCode: 7, stdout: '', stderr: 'unavailable'})]) {
    const io = capture({...paths, env: {}, runCommand});
    assert.equal(await main(['doctor'], io.options), 1);
    assert.match(io.output().stdout, /FAIL.*Codex CLI/);
  }
});

test('doctor rejects unsupported Node releases at the advertised boundaries', async t => {
  const {main} = await cli();
  const paths = fixture(t);
  for (const [nodeVersion, expected] of [['22.18.0', 1], ['22.19.0', 0], ['22.20.0', 0],
    ['23.9.0', 1], ['24.1.9', 1], ['24.2.0', 0], ['25.0.0', 0], ['24.2.0-rc.1', 1]]) {
    const io = capture({...paths, nodeVersion, env: {}, runCommand: async () => ({exitCode: 0, stdout: 'codex-cli 0.169.1'})});
    assert.equal(await main(['doctor'], io.options), expected, nodeVersion);
    assert.match(io.output().stdout, /\^22\.19\.0 \|\| >=24\.2\.0/);
  }
});

test('doctor detects a missing runtime asset and leaves the package unchanged', async t => {
  const {main} = await cli();
  const paths = fixture(t);
  rmSync(join(paths.packageDirectory, 'board.js'));
  const before = tree(paths.directory);
  const io = capture({...paths, env: {}, runCommand: async () => ({exitCode: 0, stdout: 'codex-cli 0.169.1'})});
  assert.equal(await main(['doctor'], io.options), 1);
  assert.match(io.output().stdout, /FAIL.*board\.js/);
  assert.deepEqual(tree(paths.directory), before);
});

test('doctor detects npm and Codex runtime version drift without repairing metadata', async t => {
  const {main} = await cli();
  const paths = fixture(t);
  writeFileSync(paths.pluginPath, JSON.stringify({name: 'hive-swarm', version: '1.7.4'}));
  const before = tree(paths.directory);
  const io = capture({...paths, env: {}, runCommand: async () => ({exitCode: 0, stdout: 'codex-cli 0.169.1'})});
  assert.equal(await main(['doctor'], io.options), 1);
  assert.match(io.output().stdout, /FAIL.*1\.9\.0.*1\.7\.4/);
  assert.deepEqual(tree(paths.directory), before);
});

test('the executable CLI handles help, version and unknown commands from another working directory', async t => {
  assert.ok(existsSync(cliPath), 'The executable CLI must exist');
  mkdirSync(join(root, '.tmp'), {recursive: true});
  const directory = mkdtempSync(join(root, '.tmp', 'cli-executable-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  for (const [args, expected] of [[['--help'], 0], [['--version'], 0], [['unknown'], 2]]) {
    const out = openSync(join(directory, 'stdout'), 'w');
    const err = openSync(join(directory, 'stderr'), 'w');
    let result;
    try {
      result = spawnSync(process.execPath, [cliPath, ...args], {cwd: dirname(root), stdio: ['ignore', out, err], timeout: 10000});
    } finally { closeSync(out); closeSync(err); }
    const stdout = readFileSync(join(directory, 'stdout'), 'utf8');
    const stderr = readFileSync(join(directory, 'stderr'), 'utf8');
    assert.equal(result.status, expected, stderr || result.error?.message);
    assert.equal(result.error, undefined);
    assert.ok((expected ? stderr : stdout).trim());
  }
});

test('default doctor locates an executable sentinel without launching it', async t => {
  const {main} = await cli();
  const paths = fixture(t);
  const marker = join(paths.directory, 'sentinel launched');
  const executable = join(paths.directory, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  writeFileSync(executable, process.platform === 'win32'
    ? `@echo off\r\necho launched>"${marker}"\r\necho codex-cli 0.169.1\r\n`
    : `#!/bin/sh\nprintf launched > '${marker.replaceAll("'", "'\\''")}'\nprintf 'codex-cli 0.169.1\\n'\n`);
  chmodSync(executable, 0o755);
  const out = openSync(join(paths.directory, 'sentinel.stdout'), 'w');
  const err = openSync(join(paths.directory, 'sentinel.stderr'), 'w');
  let armed;
  try {
    armed = process.platform === 'win32'
      ? spawnSync(`"${executable}" --version`, {shell: process.env.ComSpec || 'cmd.exe', stdio: ['ignore', out, err]})
      : spawnSync(executable, ['--version'], {stdio: ['ignore', out, err]});
  } finally { closeSync(out); closeSync(err); }
  assert.equal(armed.status, 0, armed.error?.message);
  assert.equal(readFileSync(marker, 'utf8').trim(), 'launched', 'sentinel must write if launched');
  rmSync(marker);
  const before = tree(paths.directory);
  const io = capture({...paths, env: {HIVE_SWARM_CODEX: executable}});
  assert.equal(await main(['doctor'], io.options), 0, JSON.stringify(io.output()));
  assert.ok(io.output().stdout.includes(executable));
  assert.match(io.output().stdout, /located.*not executed/i);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(tree(paths.directory), before);
});

test('Windows doctor discovers overrides, PATH exe and npm cmd shims, and Appx package metadata', async t => {
  const {main} = await cli();
  const paths = fixture(t);
  const bin = join(paths.directory, 'tools with spaces');
  const appx = join(paths.directory, 'OpenAI.Codex_1.0_x64');
  mkdirSync(bin);
  mkdirSync(join(appx, 'app', 'resources'), {recursive: true});
  const exe = join(bin, 'codex.exe');
  const shim = join(bin, 'codex.cmd');
  const desktop = join(appx, 'app', 'resources', 'codex.exe');
  writeFileSync(exe, 'MZ fixture executable');
  writeFileSync(shim, '@echo off\r\nnode "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  writeFileSync(desktop, 'MZ fixture Desktop executable');
  const metadata = [{Name: 'Other.App', InstallLocation: bin}, {Name: 'OpenAI.Codex', InstallLocation: appx}];
  for (const [env, expected] of [
    [{HIVE_SWARM_CODEX: shim, TEAM_BOARD_CODEX: exe, Path: bin}, shim],
    [{TEAM_BOARD_CODEX: exe, Path: bin}, exe],
    [{Path: bin}, exe],
    [{Path: ''}, desktop],
  ]) {
    const io = capture({...paths, env, platform: 'win32', queryAppxPackages: async () => metadata});
    assert.equal(await main(['doctor'], io.options), 0, JSON.stringify(io.output()));
    assert.ok(io.output().stdout.includes(expected), io.output().stdout);
  }
  rmSync(exe);
  const io = capture({...paths, env: {PATH: bin}, platform: 'win32', queryAppxPackages: async () => []});
  assert.equal(await main(['doctor'], io.options), 0, JSON.stringify(io.output()));
  assert.ok(io.output().stdout.includes(shim));
  const missing = capture({...paths, env: {HIVE_SWARM_CODEX: join(bin, 'missing.exe'), PATH: bin},
    platform: 'win32', queryAppxPackages: async () => metadata});
  assert.equal(await main(['doctor'], missing.options), 1, 'an invalid explicit override must not silently choose another host');
});

test('doctor and version fail closed on invalid identities, semver or mandatory file metadata', async t => {
  const {main} = await cli();
  const paths = fixture(t);
  const manifestPath = join(paths.packageDirectory, 'package.json');
  const original = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const plugin = JSON.parse(readFileSync(paths.pluginPath, 'utf8'));
  const runner = async () => ({exitCode: 0, stdout: 'codex-cli 0.169.1'});
  for (const [manifest, runtime] of [
    [{...original, version: undefined, files: []}, {...plugin, version: undefined}],
    [{...original, version: '01.8.0'}, {...plugin, version: '01.8.0'}],
    [{...original, version: '1.8.0-01'}, {...plugin, version: '1.8.0-01'}],
    [{...original, version: '1.8.0\n'}, {...plugin, version: '1.8.0\n'}],
    [{...original, version: ''}, {...plugin, version: ''}],
    [{...original, name: 'other-package'}, plugin],
    [original, {...plugin, name: 'other-plugin'}],
    [{...original, files: []}, plugin],
    [{...original, files: ['LICENSE']}, plugin],
  ]) {
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(paths.pluginPath, JSON.stringify(runtime));
    const io = capture({...paths, env: {}, runCommand: runner});
    assert.equal(await main(['doctor'], io.options), 1, JSON.stringify({manifest, runtime, ...io.output()}));
    if (manifest.version !== original.version || manifest.name !== original.name) {
      const version = capture({...paths});
      assert.equal(await main(['--version'], version.options), 1);
      assert.equal(version.output().stdout, '');
      assert.match(version.output().stderr, /metadata.*invalid/i);
    }
  }
});

test('version and doctor accept complete semver prerelease and build identities', async t => {
  const {main} = await cli();
  const paths = fixture(t);
  const manifestPath = join(paths.packageDirectory, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const plugin = JSON.parse(readFileSync(paths.pluginPath, 'utf8'));
  for (const value of ['1.8.0-rc.1', '1.8.0+build.01', '1.8.0-rc.1+sha.a12']) {
    writeFileSync(manifestPath, JSON.stringify({...manifest, version: value}));
    writeFileSync(paths.pluginPath, JSON.stringify({...plugin, version: value}));
    const version = capture({...paths});
    assert.equal(await main(['--version'], version.options), 0);
    assert.equal(version.output().stdout, value + '\n');
    const doctor = capture({...paths, env: {}, runCommand: async () => ({exitCode: 0, stdout: 'codex-cli 0.169.1'})});
    assert.equal(await main(['doctor'], doctor.options), 0, JSON.stringify(doctor.output()));
  }
});

test('explicit Codex version diagnostics reject unrelated stdout', async t => {
  const {main} = await cli();
  const paths = fixture(t);
  for (const stdout of ['node v24.2.0', 'hello world', '0.169.1', 'codex-cli undefined']) {
    const io = capture({...paths, env: {}, runCommand: async () => ({exitCode: 0, stdout})});
    assert.equal(await main(['doctor'], io.options), 1, stdout);
    assert.match(io.output().stdout, /FAIL.*Codex CLI/);
  }
});
