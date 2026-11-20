import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {copyFixture as cpSync,removeFixture as rmSync} from './test-support.mjs';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {main} from './cli.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const plugin = 'hive-swarm@hive-swarm';
const command = 'codex tool & literal.exe';
const baseFiles = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).files;
const files = [...new Set([...baseFiles, 'core.mjs', 'installer.mjs', 'run-store.mjs', 'package.json', 'README.md', 'LICENSE'])].sort();
const list = ['plugin', 'marketplace', 'list', '--json'];
const addMarket = ['plugin', 'marketplace', 'add', '--json'];
const removeMarket = ['plugin', 'marketplace', 'remove', '--json', 'hive-swarm'];
const addPlugin = ['plugin', 'add', '--json', plugin];
const removePlugin = ['plugin', 'remove', '--json', plugin];

function fixture(t) {
  mkdirSync(join(root, '.tmp'), {recursive: true});
  const directory = mkdtempSync(join(root, '.tmp', 'installer có dấu & literal %CD% '));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const home = join(directory, 'user home');
  const codexHome = join(directory, 'codex home');
  const store = join(codexHome, 'hive-swarm');
  const data = join(directory, 'team data');
  const journal = join(data, 'journal.sqlite');
  mkdirSync(data);
  writeFileSync(journal, 'preserve board and journal bytes');
  const release = version => join(store, 'versions', version, 'marketplace');
  const cache = version => join(codexHome, 'plugins', 'cache', 'hive-swarm', 'hive-swarm', version);
  const source = version => {
    const directoryName = join(directory, 'npm-cache', '_npx', version, 'node_modules', 'hive-swarm');
    for (const file of files) {
      const target = join(directoryName, file);
      mkdirSync(dirname(target), {recursive: true});
      if (existsSync(join(root, file))) cpSync(join(root, file), target);
      else writeFileSync(target, '// fixture for a file introduced by this change\n');
    }
    for (const file of ['package.json', '.codex-plugin/plugin.json']) {
      const path = join(directoryName, file);
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      writeFileSync(path, JSON.stringify({...manifest, version,
        ...(file === 'package.json' ? {files: files.filter(file => !['package.json','README.md','LICENSE'].includes(file))} : {})}));
    }
    return directoryName;
  };
  const v1 = '1.8.0';
  const v2 = '1.9.0';
  const old = source(v1);
  const next = source(v2);
  const calls = [];
  const state = {marketplace: null, version: null, hostVersion: '0.169.1', intercept: null};
  const json = value => ({exitCode: 0, stdout: JSON.stringify(value)});
  const runCommand = async (file, args, options) => {
    assert.equal(file, command);
    assert.equal(options.env.CODEX_HOME, codexHome);
    assert.equal(options.cwd, codexHome);
    assert.equal(options.shell, false);
    assert.equal(options.env.CODEX_THREAD_ID, undefined);
    calls.push(args);
    const outcome = await state.intercept?.(args);
    if (outcome) return outcome;
    const key = JSON.stringify(args);
    if (key === JSON.stringify(['--version'])) return {exitCode: 0, stdout: 'codex-cli ' + state.hostVersion};
    if (key === JSON.stringify(list)) return json({marketplaces: state.marketplace ? [{name: 'hive-swarm', root: state.marketplace}] : []});
    if (JSON.stringify(args.slice(0, -1)) === JSON.stringify(addMarket)) {
      const requested = args.at(-1);
      if (state.marketplace && state.marketplace !== requested) return {exitCode: 1, stderr: 'source already exists'};
      state.marketplace = requested;
      return json({marketplaceName: 'hive-swarm', installedRoot: requested});
    }
    if (key === JSON.stringify(removeMarket)) {
      state.marketplace = null;
      return json({marketplaceName: 'hive-swarm', installedRoot: null});
    }
    if (key === JSON.stringify(addPlugin)) {
      const manifest = JSON.parse(readFileSync(join(state.marketplace, '.codex-plugin/plugin.json'), 'utf8'));
      if (state.version) rmSync(cache(state.version), {recursive: true, force: true});
      cpSync(state.marketplace, cache(manifest.version), {recursive: true});
      state.version = manifest.version;
      return json({pluginId: plugin, version: manifest.version, installedPath: cache(manifest.version)});
    }
    if (key === JSON.stringify(removePlugin)) {
      if (state.version) rmSync(cache(state.version), {recursive: true, force: true});
      state.version = null;
      return json({pluginId: plugin});
    }
    assert.fail('Unexpected Codex CLI command ' + JSON.stringify(args));
  };
  async function run(action, packageDirectory = old, args = [], overrides = {}) {
    let stdout = '', stderr = '';
    const code = await main([action, '--host', 'codex', ...args], {
      home, env: {CODEX_HOME: codexHome, HIVE_SWARM_DATA: data, HIVE_SWARM_CODEX: command, CODEX_THREAD_ID: 'ambient'},
      packageDirectory, runCommand, stdout: {write: data => { stdout += data; }}, stderr: {write: data => { stderr += data; }},
      ...overrides,
    });
    return {code, stdout, stderr};
  }
  return {home, codexHome, store, data, journal, release, cache, state, calls, run, old, next, v1, v2};
}

function tree(path) {
  return readdirSync(path, {recursive: true, withFileTypes: true}).filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(path.length + 1).replaceAll('\\', '/')).sort();
}

function success(result) {
  assert.equal(result.code, 0, result.stderr);
}

function spawnCaptured(directory, file, args, env, cwd = directory) {
  const stdout = join(directory, 'child.stdout');
  const stderr = join(directory, 'child.stderr');
  const out = openSync(stdout, 'w');
  const err = openSync(stderr, 'w');
  let result;
  try {
    result = spawnSync(file, args, {cwd, env, stdio: ['ignore', out, err], windowsHide: true, timeout: 20000});
  } finally { closeSync(out); closeSync(err); }
  return {...result, stdout: readFileSync(stdout, 'utf8'), stderr: readFileSync(stderr, 'utf8')};
}

test('install registers an exact persistent copy and repeating it is idempotent', async t => {
  const f = fixture(t);
  writeFileSync(join(f.old, 'unlisted-secret'), 'exclude this');
  success(await f.run('install'));
  const destination = f.release(f.v1);
  assert.deepEqual(f.calls.find(args => args[2] === 'add'), [...addMarket, destination]);
  assert.equal(f.state.marketplace, destination);
  assert.deepEqual(tree(destination), files);
  for (const file of files) assert.deepEqual(readFileSync(join(destination, file)), readFileSync(join(f.old, file)), file);
  const start = f.calls.length;
  success(await f.run('install'));
  assert.ok(f.calls.slice(start).every(args => JSON.stringify(args) === JSON.stringify(list)));
  rmSync(f.old, {recursive: true});
  assert.ok(existsSync(join(destination, 'server.mjs')));
});

test('the bound runtime starts the installed MCP without PATH and survives repeat and update rollback', async t => {
  const f = fixture(t);
  const env = {CODEX_HOME: f.codexHome, HIVE_SWARM_DATA: f.data, HIVE_SWARM_CODEX: command, PATH: ''};
  const rawMcp = readFileSync(join(f.old, '.mcp.json'));
  const config = path => JSON.parse(readFileSync(join(path, '.mcp.json'))).mcpServers.hive_swarm;
  const args = ['--bind-node'];
  success(await f.run('install', f.old, args, {env}));
  const installed = f.cache(f.v1);
  assert.equal(config(installed).command, realpathSync(process.execPath));
  assert.deepEqual(config(installed), config(f.release(f.v1)));
  assert.deepEqual(readFileSync(join(f.old, '.mcp.json')), rawMcp);
  const mcp = config(installed);
  const child = spawnCaptured(f.data, mcp.command, mcp.args, {...process.env, ...env}, join(installed, mcp.cwd));
  assert.equal(child.status, 0, child.error?.message || child.stderr);
  const start = f.calls.length;
  success(await f.run('install', f.old, args, {env}));
  assert.deepEqual(f.calls.slice(start), [list]);

  // A failed candidate activation can displace the previous Codex cache.
  // Recovery must copy the previous bound configuration back from the durable release.
  f.state.intercept = call => {
    if (JSON.stringify(call) !== JSON.stringify(addPlugin) || f.state.marketplace !== f.release(f.v2)) return;
    rmSync(installed, {recursive: true});
    return {exitCode: 19};
  };
  const failed = await f.run('update', f.next, ['--after-close'], {env});
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /exit 19.*restored/i);
  assert.equal(f.state.marketplace, f.release(f.v1));
  assert.deepEqual(config(installed), mcp);
  assert.equal(config(f.release(f.v2)).command, mcp.command);
  f.state.intercept = null;
  success(await f.run('update', f.next, ['--after-close'], {env}));
  assert.deepEqual(config(f.cache(f.v2)), mcp);

  const cachedConfig = join(f.cache(f.v2), '.mcp.json');
  const altered = JSON.parse(readFileSync(cachedConfig));
  altered.mcpServers.hive_swarm.command = join(f.home, 'different-node.exe');
  writeFileSync(cachedConfig, JSON.stringify(altered));
  assert.match((await f.run('install', f.next, args, {env})).stderr, /invalid.*MCP metadata|cache differs/i);

  const original = JSON.parse(rawMcp);
  original.mcpServers.hive_swarm.command = realpathSync(process.execPath);
  writeFileSync(join(f.old, '.mcp.json'), JSON.stringify(original));
  assert.match((await f.run('install', f.old, args, {env})).stderr, /invalid.*MCP metadata/i);
});

test('the Windows wrapper asks the installer to bind its explicit NodePath when PATH has no Node',
  {skip: process.platform !== 'win32'}, t => {
    mkdirSync(join(root, '.tmp'), {recursive: true});
    const directory = mkdtempSync(join(root, '.tmp', 'installer wrapper '));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    cpSync(join(root, 'install.ps1'), join(directory, 'install.ps1'));
    mkdirSync(join(directory, '.codex-plugin'));
    writeFileSync(join(directory, '.codex-plugin', 'plugin.json'), '{"version":"1.8.0"}');
    writeFileSync(join(directory, 'cli.mjs'), `import {writeFileSync} from 'node:fs';
writeFileSync('received.json', JSON.stringify({node: process.execPath, args: process.argv.slice(2), path: process.env.PATH}));\n`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    env.PATH = directory;
    const powershell = join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnCaptured(directory, powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', join(directory, 'install.ps1'), '-NodePath', process.execPath], env);
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    const received = JSON.parse(readFileSync(join(directory, 'received.json')));
    assert.equal(received.node, process.execPath);
    assert.deepEqual(received.args, ['install', '--host', 'codex', '--bind-node']);
    assert.equal(received.path, directory);
  });

test('uninstall preserves board data, journals, and both release copies', async t => {
  const f = fixture(t);
  success(await f.run('install'));
  success(await f.run('update', f.next, ['--after-close']));
  const before = readFileSync(f.journal);
  success(await f.run('uninstall', join(f.home, 'not a package')));
  assert.equal(f.state.marketplace, null);
  assert.equal(f.state.version, null);
  assert.deepEqual(readFileSync(f.journal), before);
  assert.ok(existsSync(f.release(f.v1)));
  assert.ok(existsSync(f.release(f.v2)));
  const start = f.calls.length;
  success(await f.run('uninstall'));
  assert.ok(f.calls.slice(start).every(args => JSON.stringify(args) === JSON.stringify(list)));
});

test('refuses a foreign store, registered marketplace, or release directory', async t => {
  const f = fixture(t);
  mkdirSync(f.store, {recursive: true});
  writeFileSync(join(f.store, 'user-file'), 'foreign');
  let result = await f.run('install');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ownership|foreign|managed/i);
  assert.equal(f.calls.length, 0);
  assert.equal(readFileSync(join(f.store, 'user-file'), 'utf8'), 'foreign');
  rmSync(f.store, {recursive: true});
  f.state.marketplace = f.old;
  for (const action of ['install', 'update', 'uninstall']) {
    result = await f.run(action);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /foreign|managed/i);
  }
  assert.ok(f.calls.every(args => JSON.stringify(args) === JSON.stringify(list)));
  f.state.marketplace = null;
  success(await f.run('install'));
  mkdirSync(f.release(f.v2), {recursive: true});
  writeFileSync(join(f.release(f.v2), 'sentinel'), 'foreign');
  result = await f.run('update', f.next, ['--after-close']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ownership|foreign|managed/i);
  assert.equal(f.state.version, f.v1);
  assert.equal(readFileSync(join(f.release(f.v2), 'sentinel'), 'utf8'), 'foreign');
});

test('refuses symlink or junction targets and linked source components', async t => {
  const f = fixture(t);
  mkdirSync(f.codexHome, {recursive: true});
  symlinkSync(f.data, f.store, process.platform === 'win32' ? 'junction' : 'dir');
  const refused = await f.run('install');
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /symlink|junction/i);
  assert.equal(f.calls.length, 0);
  rmSync(f.store);
  const moved = join(dirname(f.old), 'assets original');
  cpSync(join(f.old, 'assets'), moved, {recursive: true});
  rmSync(join(f.old, 'assets'), {recursive: true});
  symlinkSync(moved, join(f.old, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.match((await f.run('install')).stderr, /symlink|junction/i);
  assert.equal(existsSync(f.release(f.v1)), false);
});

test('a staged update does not change host state without a close assertion and qualified CLI', async t => {
  const f = fixture(t);
  success(await f.run('install'));
  let start = f.calls.length;
  let result = await f.run('update', f.next);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes(f.release(f.v2)));
  assert.match(result.stderr, /--after-close/);
  assert.ok(f.calls.slice(start).every(args => JSON.stringify(args) === JSON.stringify(list)));
  f.state.hostVersion = '0.180.0';
  start = f.calls.length;
  result = await f.run('update', f.next, ['--after-close']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /qualif/i);
  assert.ok(f.calls.slice(start).every(args => args[0] === '--version' || JSON.stringify(args) === JSON.stringify(list)));
  assert.equal(f.state.marketplace, f.release(f.v1));
  assert.equal(f.state.version, f.v1);
});

test('even an asserted closed app cannot replace an owned service with active turns',async t=>{
  const {createServer}=await import('node:http');const f=fixture(t);success(await f.run('install'));
  const key='a'.repeat(64);writeFileSync(join(f.data,'service.key'),key);let busy=true,shutdowns=0;
  const server=createServer((request,response)=>{
    assert.equal(request.headers.authorization,'Bearer '+key);response.setHeader('content-type','application/json');
    if(request.url==='/ready')return response.end(JSON.stringify({service:'codex-team-board',version:f.v1}));
    assert.equal(request.url,'/shutdown');assert.equal(request.method,'POST');shutdowns++;
    if(busy){response.statusCode=409;return response.end(JSON.stringify({error:'Team Board still has running turns.'}))}
    response.once('finish',()=>server.close());response.end(JSON.stringify({service:'codex-team-board',version:f.v1,stopping:true}));
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const env={CODEX_HOME:f.codexHome,HIVE_SWARM_DATA:f.data,HIVE_SWARM_CODEX:command,HIVE_SWARM_PORT:String(server.address().port)};
  const result=await f.run('update',f.next,['--after-close'],{env});assert.equal(result.code,1);assert.match(result.stderr,/running turns|active/i);
  assert.equal(f.state.version,f.v1);assert.equal(shutdowns,1);
  busy=false;success(await f.run('update',f.next,['--after-close'],{env}));assert.equal(f.state.version,f.v2);
  assert.equal(readFileSync(f.journal,'utf8'),'preserve board and journal bytes');
});

test('update retries a reset only after shutdown acknowledgment and requires the listener to close', async t => {
  const f = fixture(t);
  success(await f.run('install'));
  const key = 'a'.repeat(64);
  writeFileSync(join(f.data, 'service.key'), key);
  let initial = 'reset', acknowledged = false, shutdowns = 0, postAckProbes = 0;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer ' + key);
    response.setHeader('Connection', 'close');
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/shutdown') {
      shutdowns++;
      acknowledged = true;
      return response.end(JSON.stringify({service: 'codex-team-board', version: f.v1, stopping: true}));
    }
    assert.equal(request.url, '/ready');
    if (!acknowledged && initial === 'reset') return request.socket.resetAndDestroy();
    if (!acknowledged && initial === 'denied') {
      response.statusCode = 403;
      return response.end('{}');
    }
    if (acknowledged) {
      postAckProbes++;
      assert.equal(f.state.version, f.v1, 'a reset does not prove the listener closed');
      if (postAckProbes === 1) return request.socket.resetAndDestroy();
      response.once('finish', () => server.close());
    }
    response.end(JSON.stringify({service: 'codex-team-board', version: f.v1}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = {CODEX_HOME: f.codexHome, HIVE_SWARM_DATA: f.data, HIVE_SWARM_CODEX: command,
    HIVE_SWARM_PORT: String(server.address().port)};
  const update = () => f.run('update', f.next, ['--after-close'], {env});
  const reset = await update();
  assert.equal(reset.code, 1);
  assert.match(reset.stderr, /could not verify/i);
  initial = 'denied';
  const denied = await update();
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /did not confirm Hive ownership/i);
  assert.equal(shutdowns, 0);
  assert.equal(f.state.version, f.v1);
  initial = 'ready';
  success(await update());
  assert.equal(shutdowns, 1);
  assert.equal(postAckProbes, 2);
  assert.equal(f.state.version, f.v2);
});

test('failed candidate registration rolls the marketplace back and preserves both releases', async t => {
  const f = fixture(t);
  success(await f.run('install'));
  f.state.intercept = args => args.at(-1) === f.release(f.v2) ? {exitCode: 17} : null;
  const result = await f.run('update', f.next, ['--after-close']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /exit 17/);
  assert.match(result.stderr, /restored/i);
  assert.ok(result.stderr.includes(f.release(f.v2)));
  assert.equal(f.state.marketplace, f.release(f.v1));
  assert.equal(f.state.version, f.v1);
  assert.ok(existsSync(f.release(f.v2)));
  assert.equal(f.calls.filter(args => args.at(-1) === f.release(f.v1)).length, 2);
  assert.ok(!f.calls.some(args => JSON.stringify(args) === JSON.stringify(removePlugin)));
});

test('a failed activation restores the previous registration, or reports a failed rollback', async t => {
  for (const rollbackFails of [false, true]) {
    const f = fixture(t);
    success(await f.run('install'));
    f.state.intercept = args => {
      if (args.at(-1) === f.release(f.v1) && rollbackFails) return {exitCode: 19};
      if (JSON.stringify(args) === JSON.stringify(addPlugin) && f.state.marketplace === f.release(f.v2)) return {exitCode: 18};
    };
    const result = await f.run('update', f.next, ['--after-close']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /exit 18/);
    assert.match(result.stderr, rollbackFails ? /rollback failed.*exit 19/i : /restored/i);
    assert.ok(result.stderr.includes(f.release(f.v1)) && result.stderr.includes(f.release(f.v2)));
    assert.equal(f.state.marketplace, rollbackFails ? null : f.release(f.v1));
    assert.equal(f.state.version, f.v1);
    assert.ok(existsSync(f.release(f.v1)) && existsSync(f.release(f.v2)));
  }
});

test('failed first activation, failed removal, and unverified package do not report success', async t => {
  const f = fixture(t);
  f.state.intercept = args => JSON.stringify(args) === JSON.stringify(addPlugin) ? {exitCode: 12} : null;
  const install = await f.run('install');
  assert.equal(install.code, 1);
  assert.match(install.stderr, /exit 12/);
  assert.equal(f.state.marketplace, null);
  assert.ok(existsSync(f.release(f.v1)));
  f.state.intercept = null;
  success(await f.run('install'));
  f.state.intercept = args => JSON.stringify(args) === JSON.stringify(removePlugin) ? {exitCode: 23} : null;
  const uninstall = await f.run('uninstall');
  assert.equal(uninstall.code, 1);
  assert.match(uninstall.stderr, /exit 23/);
  assert.equal(f.state.marketplace, f.release(f.v1));
  const path = join(f.next, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.files.push('unreviewed.txt');
  writeFileSync(path, JSON.stringify(manifest));
  writeFileSync(join(f.next, 'unreviewed.txt'), 'not public');
  assert.match((await f.run('update', f.next, ['--after-close'])).stderr, /allowlist/);
  assert.equal(existsSync(f.release(f.v2)), false);
  assert.equal(f.state.version, f.v1);
});

test('update on a newer Codex CLI succeeds when --allow-unqualified-cli is explicitly passed', async t => {
  const f = fixture(t);
  success(await f.run('install'));
  f.state.hostVersion = '0.180.0';
  const refused = await f.run('update', f.next, ['--after-close']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--allow-unqualified-cli/);
  success(await f.run('update', f.next, ['--after-close', '--allow-unqualified-cli']));
  assert.equal(f.state.version, f.v2);
  assert.equal(f.state.marketplace, f.release(f.v2));
});

test('renameDirectory retries transient Windows EPERM/EBUSY locks while still refusing overwrite and non-retryable errors', async t => {
  const {renameDirectory} = await import('./installer.mjs');
  const f = fixture(t);
  const base = join(f.codexHome, 'rename-test');
  mkdirSync(base, {recursive: true});
  const from = join(base, '.hive-stage-1');
  const to = join(base, '1.8.0');
  mkdirSync(from);
  let calls = 0;
  const delays = [];
  await renameDirectory(from, to, {
    platform: 'win32',
    wait: async ms => { delays.push(ms); },
    rename: (src, dst) => {
      calls++;
      if (calls === 1) throw Object.assign(Error('EPERM: transient scan lock'), {code: 'EPERM'});
      if (calls === 2) throw Object.assign(Error('EBUSY: transient lock'), {code: 'EBUSY'});
      return renameSync(src, dst);
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [25, 50]);
  assert.equal(existsSync(to), true);

  // If the target appears before a retry, refuse overwrite instead of retrying further.
  const from2 = join(base, '.hive-stage-2');
  const to2 = join(base, '1.8.1');
  mkdirSync(from2);
  let calls2 = 0;
  await assert.rejects(renameDirectory(from2, to2, {
    platform: 'win32',
    wait: async () => { mkdirSync(to2); },
    rename: () => {
      calls2++;
      throw Object.assign(Error('EPERM'), {code: 'EPERM'});
    },
  }), /overwrite/i);
  assert.equal(calls2, 1);

  // Non-Windows or non-retryable errors fail immediately without delay.
  const from3 = join(base, '.hive-stage-3');
  const to3 = join(base, '1.8.2');
  mkdirSync(from3);
  let calls3 = 0;
  await assert.rejects(renameDirectory(from3, to3, {
    platform: 'linux',
    wait: async () => { assert.fail('Should not retry on non-Windows'); },
    rename: () => { calls3++; throw Object.assign(Error('EPERM'), {code: 'EPERM'}); },
  }), /EPERM/);
  assert.equal(calls3, 1);
});
