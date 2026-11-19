import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    if (argv.includes('--version') || argv.includes('-v')) assert.equal(io.output().stdout.trim(), '1.8.0');
    else {
      assert.match(io.output().stdout, /Usage: hive-swarm/);
      assert.match(io.output().stdout, /doctor/);
      assert.doesNotMatch(io.output().stdout, /hive-swarm (install|update|uninstall)/);
    }
  }
});

test('unknown commands and malformed arguments return useful nonzero errors', async () => {
  const {main} = await cli();
  for (const argv of [['wat'], ['install'], ['doctor', '--host'], ['doctor', '--host', 'other'],
    ['doctor', '--write'], ['--version', 'extra'], ['doctor', '--host', 'codex', '--host', 'codex']]) {
    const io = capture({runCommand: () => { assert.fail('invalid input must not invoke a host'); }});
    assert.equal(await main(argv, io.options), 2, JSON.stringify(argv));
    assert.match(io.output().stderr, /hive-swarm --help/);
    assert.equal(io.output().stdout, '');
  }
});

test('DSH doctor directs users to the native bundle without probing or changing a profile', async () => {
  const {main} = await cli();
  const io = capture({runCommand: () => { assert.fail('DSH must own its profile'); }});
  assert.equal(await main(['doctor', '--host', 'dsh'], io.options), 2);
  assert.match(io.output().stderr, /dsh-hive-swarm/);
});

test('doctor reads an injected package and reports paths without creating home or data', async t => {
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
  assert.match(stdout, /PASS.*1\.8\.0/);
  assert.match(stdout, /codex-cli 0\.169\.1/);
  assert.ok(stdout.includes(paths.packageDirectory));
  assert.ok(stdout.includes(join(paths.home, '.codex')));
  assert.ok(stdout.includes(join(paths.home, 'CodexTeamBoard')));
  assert.match(stdout, /read-only/);
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
  assert.match(io.output().stdout, /FAIL.*1\.8\.0.*1\.7\.4/);
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
