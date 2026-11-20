import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync,
} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, isAbsolute, join, parse, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';

const name = 'hive-swarm';
const pluginId = name + '@' + name;
const owner = {schema: 1, pluginId};
const markerName = 'owner.json';
const qualifiedUpdateVersion = 'codex-cli 0.169.1';
const packageRoot = dirname(fileURLToPath(import.meta.url));
export const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const standardFiles = ['LICENSE', 'README.md', 'package.json'];
export const CORE_PACKAGE_FILES = Object.freeze([
  '.agents/plugins/marketplace.json', '.codex-plugin/plugin.json', '.mcp.json',
  'assets/hive-swarm-banner.svg', 'assets/hive-swarm-flow.svg', 'assets/hive-swarm-icon.png', 'assets/hive-swarm-icon.svg',
  'board.css', 'board.html', 'board.js', 'cli.mjs', 'codex.mjs', 'core.mjs', 'engine.mjs', 'hive-bees.js', 'hive-graph.js',
  'installer.mjs', 'run-store.mjs', 'server.mjs', 'skills/swarm/SKILL.md', 'skills/swarm/agents/openai.yaml', 'worktrees.mjs',
  ...standardFiles,
].sort());

const json = contents => JSON.parse(contents.toString('utf8'));
const sameList = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const validVersion = value => typeof value === 'string' && value.length <= 128 && semver.test(value);
export const validIdentity = manifest => manifest?.name === name && validVersion(manifest.version);
export const matchesPackageFiles = files => Array.isArray(files) && files.every(file => typeof file === 'string') &&
  sameList([...files, ...standardFiles].sort(), CORE_PACKAGE_FILES);
export function supportedNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [, major, minor] = match.map(Number);
  return major === 22 && minor >= 19 || major === 24 && minor >= 2 || major > 24;
}

export function installPaths(home, env) {
  const codexHome = resolve(env.CODEX_HOME || join(home, '.codex'));
  return {
    codexHome,
    store: join(codexHome, name),
    cache: join(codexHome, 'plugins', 'cache', name, name),
    data: resolve(env.HIVE_SWARM_DATA || env.TEAM_BOARD_DATA || join(env.LOCALAPPDATA || home, 'CodexTeamBoard')),
  };
}

function entry(path) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink()) throw Error('Refusing a symlink or junction: ' + path);
  return stat;
}

function directory(path, create = false) {
  const base = parse(path).root;
  let current = base;
  for (const part of relative(base, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat = entry(current);
    if (!stat && create) {
      try { mkdirSync(current, {mode: 0o700}); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = entry(current);
    }
    if (!stat) return false;
    if (!stat.isDirectory()) throw Error('Expected a directory: ' + current);
  }
  return true;
}

function readRegularFile(path) {
  if (!directory(dirname(path)) || !entry(path)?.isFile()) throw Error('Missing regular package file: ' + path);
  return readFileSync(path);
}

function readMarker(path) {
  try {
    const value = json(readRegularFile(join(path, markerName)));
    if (value.schema === owner.schema && value.pluginId === owner.pluginId) return value;
  } catch (error) {
    if (/symlink|junction/.test(error.message)) throw error;
  }
  throw Error('Refusing a foreign path without a Hive Swarm ownership marker: ' + path);
}

function writeMarker(path, value) {
  writeFileSync(join(path, markerName), JSON.stringify(value) + '\n', {flag: 'wx', mode: 0o600});
}

function publishDirectory(target, populate) {
  const parent = dirname(target);
  if (entry(target)) throw Error('Refusing to overwrite an existing path: ' + target);
  const staging = mkdtempSync(join(parent, '.hive-stage-'));
  const original = lstatSync(staging);
  try {
    populate(staging);
    if (entry(target)) throw Error('Refusing to overwrite an existing path: ' + target);
    renameSync(staging, target);
  } catch (error) {
    // This is the unique staging directory we created, directly under the checked parent.
    const current = directory(parent) ? entry(staging) : null;
    if (current?.isDirectory() && current.dev === original.dev && current.ino === original.ino) {
      rmSync(staging, {recursive: true});
    }
    throw error;
  }
}

function checkMetadata(bytes, command) {
  const manifest = json(bytes.get('package.json'));
  const plugin = json(bytes.get('.codex-plugin/plugin.json'));
  if (!validIdentity(manifest) || !validIdentity(plugin) || manifest.version !== plugin.version) {
    throw Error('Hive Swarm package and Codex plugin identities and versions must match.');
  }
  if (!matchesPackageFiles(manifest.files)) throw Error('Unexpected Hive Swarm package allowlist.');
  const market = json(bytes.get('.agents/plugins/marketplace.json'));
  const mcp = json(bytes.get('.mcp.json')).mcpServers;
  const source = market.plugins?.[0]?.source;
  if (market.name !== name || market.plugins?.length !== 1 || market.plugins[0].name !== name ||
    source?.source !== 'local' || source.path !== './' || plugin.mcpServers !== './.mcp.json' ||
    plugin.skills !== './skills/' || Object.keys(mcp ?? {}).length !== 1 ||
    mcp.hive_swarm?.command !== command || mcp.hive_swarm.cwd !== '.' ||
    !Array.isArray(mcp.hive_swarm.args) || !sameList(mcp.hive_swarm.args, ['./server.mjs'])) {
    throw Error('Invalid Hive Swarm marketplace, plugin or MCP metadata.');
  }
  return manifest.version;
}

const packageDigest = bytes => sha256(JSON.stringify([...bytes].map(([file, contents]) => [file, sha256(contents)])));

function readPackage(path, nodePath) {
  const bytes = new Map(CORE_PACKAGE_FILES.map(file => [file, readRegularFile(join(path, file))]));
  const version = checkMetadata(bytes, nodePath ?? 'node');
  return {version, digest: packageDigest(bytes), bytes};
}

const publicDirectories = new Set(CORE_PACKAGE_FILES.flatMap(file => {
  const parts = file.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}));

function verifyTree(path, prefix = '') {
  for (const item of readdirSync(path)) {
    const file = prefix + item;
    const next = join(path, item);
    const stat = entry(next);
    if (stat?.isDirectory() && publicDirectories.has(file)) verifyTree(next, file + '/');
    else if (!stat?.isFile() || !CORE_PACKAGE_FILES.includes(file)) throw Error('Unexpected entry in a Hive Swarm package copy: ' + next);
  }
}

const releaseDirectory = (store, version) => join(store, 'versions', version);
function verifiedRelease(store, version) {
  if (!validVersion(version)) throw Error('Invalid managed Hive Swarm version.');
  const release = releaseDirectory(store, version);
  if (!directory(release)) throw Error('Missing managed Hive Swarm release: ' + release);
  const marker = readMarker(release);
  const bound = Object.hasOwn(marker, 'nodePath');
  const nodePath = bound ? marker.nodePath : undefined;
  if (bound && (!absoluteNodePath(nodePath) || !/^[a-f0-9]{64}$/.test(marker.sourceDigest ?? ''))) {
    throw Error('Invalid Node runtime binding in the Hive Swarm release marker: ' + release);
  }
  const path = join(release, 'marketplace');
  const actual = readPackage(path, nodePath);
  verifyTree(path);
  if (marker.version !== version || actual.version !== version || marker.digest !== actual.digest) {
    throw Error('Hive Swarm release differs from its ownership marker: ' + path);
  }
  return {path, version, digest: actual.digest, sourceDigest: bound ? marker.sourceDigest : actual.digest, nodePath};
}

function installedBytes(candidate, nodePath) {
  if (!nodePath) return candidate.bytes;
  const bytes = new Map(candidate.bytes);
  const config = json(bytes.get('.mcp.json'));
  config.mcpServers.hive_swarm.command = nodePath;
  bytes.set('.mcp.json', Buffer.from(JSON.stringify(config, null, 2) + '\n'));
  return bytes;
}

function stageRelease(store, candidate, nodePath, explicit) {
  const target = releaseDirectory(store, candidate.version);
  if (!directory(target)) {
    publishDirectory(target, staging => {
      const packagePath = join(staging, 'marketplace');
      const bytes = installedBytes(candidate, nodePath);
      for (const [file, contents] of bytes) {
        const path = join(packagePath, file);
        directory(dirname(path), true);
        writeFileSync(path, contents, {flag: 'wx', mode: file === 'cli.mjs' ? 0o755 : 0o644});
      }
      const copy = readPackage(packagePath, nodePath);
      verifyTree(packagePath);
      if (copy.digest !== packageDigest(bytes)) throw Error('Staged copy failed package verification.');
      writeMarker(staging, {...owner, version: copy.version, digest: copy.digest,
        ...(nodePath ? {nodePath, sourceDigest: candidate.digest} : {})});
    });
  }
  const release = verifiedRelease(store, candidate.version);
  if (release.sourceDigest !== candidate.digest || release.digest !== packageDigest(installedBytes(candidate, release.nodePath))) {
    throw Error('An existing release has different bytes for version ' + candidate.version + ': ' + release.path);
  }
  if (explicit && !samePath(release.nodePath, nodePath)) {
    throw Error('This version already has a verified release with a different Node runtime binding. Use a new version to change the binding: ' + release.path);
  }
  return release;
}

function contains(parent, child) {
  const sub = relative(parent, child);
  return sub === '' || !isAbsolute(sub) && sub !== '..' && !sub.startsWith('..' + sep);
}

function absoluteNodePath(path) {
  return typeof path === 'string' && isAbsolute(path) && !/[\0\r\n]/.test(path) &&
    (process.platform !== 'win32' || /(?:^[a-z]:[\\/]|^[\\/]{2}).*\.exe$/i.test(path));
}

async function currentNodePath(packagePath, npmCache) {
  if (process.release.name !== 'node' || !supportedNode(process.versions.node) || !absoluteNodePath(process.execPath)) {
    throw Error('A supported Node.js executable with an absolute path is required for runtime binding.');
  }
  const path = realpathSync(process.execPath);
  if (!absoluteNodePath(path) || contains(packagePath, path) || npmCache && contains(resolve(npmCache), path) ||
    path.split(sep).some(part => part.toLowerCase() === '_npx')) {
    throw Error('Choose a persistent Node.js executable outside the npm package and cache.');
  }
  accessSync(path, constants.X_OK);
  try {
    const {DatabaseSync} = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try { db.prepare('SELECT 1').get(); } finally { db.close(); }
  } catch {
    throw Error('The selected Node.js executable must support node:sqlite.');
  }
  return path;
}

function hostPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/.test(value)) throw Error('Invalid path in Codex CLI receipt.');
  if (process.platform !== 'win32') return resolve(value);
  if (value.startsWith('\\\\?\\UNC\\')) return resolve('\\\\' + value.slice(8));
  return resolve(value.startsWith('\\\\?\\') ? value.slice(4) : value);
}

const samePath = (a, b) => a && b && relative(a, b) === '';

function cacheVersions(paths, owned) {
  if (!directory(paths.cache)) return [];
  return readdirSync(paths.cache).map(version => {
    const path = join(paths.cache, version);
    if (!owned || !validVersion(version) || !directory(path)) throw Error('Refusing foreign Codex plugin cache: ' + path);
    const release = verifiedRelease(paths.store, version);
    verifyTree(path);
    if (readPackage(path, release.nodePath).digest !== release.digest) throw Error('Codex plugin cache differs from the managed release: ' + path);
    return version;
  });
}

const exec = promisify(execFile);

/** Run a native executable or the official Windows npm entry using argv without cmd.exe. */
export async function runCodexCommand(command, args, options) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const npmPackage = join(dirname(command), 'node_modules', '@openai', 'codex');
    const script = join(npmPackage, 'bin', 'codex.js');
    try {
      const manifest = json(readRegularFile(join(npmPackage, 'package.json')));
      if (manifest.name !== '@openai/codex' || manifest.bin?.codex?.replace(/^\.\//, '') !== 'bin/codex.js' ||
        !directory(dirname(script)) || !entry(script)?.isFile()) throw Error('Not a supported npm shim');
    } catch {
      throw Error('Set HIVE_SWARM_CODEX to codex.exe or install the official @openai/codex npm package.');
    }
    args = [script, ...args];
    command = process.execPath;
  }
  try {
    const {stdout} = await exec(command, args, {...options, shell: false, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024});
    return {exitCode: 0, stdout};
  } catch (error) {
    if (Number.isInteger(error.code)) return {exitCode: error.code};
    throw error;
  }
}

function hostCommands(paths, command, runCommand, env) {
  const childEnv = {...env, CODEX_HOME: paths.codexHome};
  const stripped = new Set([
    'CODEX_WINDOWS_REGISTERED_CORE', 'CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY', 'CODEX_WINDOWS_SANDBOX_PROXY_PORTS',
    'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID',
  ]);
  for (const key of Object.keys(childEnv)) {
    if (stripped.has(key.toUpperCase()) || key !== 'CODEX_HOME' && key.toUpperCase() === 'CODEX_HOME') delete childEnv[key];
  }
  const run = async args => {
    let result;
    const label = 'Codex ' + args.slice(0, args[1] === 'marketplace' ? 3 : 2).join(' ');
    try {
      result = await runCommand(command, args, {env: childEnv, cwd: paths.codexHome, shell: false, windowsHide: true});
    } catch (error) {
      const detail = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? ' (' + error.code + ')' : '';
      throw Error(label + ' could not run' + detail + '. Check the Codex CLI executable and permissions.', {cause: error});
    }
    if (result?.exitCode !== 0) throw Error(label + ' failed (exit ' + (result?.exitCode ?? 'unknown') + ').');
    return result.stdout;
  };
  const receipt = async args => {
    const raw = await run(args);
    try { return json(Buffer.from(raw)); }
    catch { throw Error('Codex returned an invalid JSON receipt for ' + args.slice(0, args[1] === 'marketplace' ? 3 : 2).join(' ') + '.'); }
  };
  const marketRoot = async () => {
    const result = await receipt(['plugin', 'marketplace', 'list', '--json']);
    if (!Array.isArray(result?.marketplaces) || result.marketplaces.some(item => typeof item?.name !== 'string')) {
      throw Error('Invalid Codex marketplace list.');
    }
    const matches = result.marketplaces.filter(item => item.name.toLowerCase() === name);
    if (matches.length > 1) throw Error('Codex reported multiple Hive Swarm marketplaces. Resolve the conflict in Codex.');
    return matches.length ? hostPath(matches[0].root) : null;
  };
  return {
    marketRoot,
    async addMarketplace(release) {
      const result = await receipt(['plugin', 'marketplace', 'add', '--json', release.path]);
      if (result?.marketplaceName !== name || !samePath(hostPath(result.installedRoot), release.path) ||
        !samePath(await marketRoot(), release.path)) throw Error('Codex did not confirm the requested marketplace path.');
    },
    async removeMarketplace(expected) {
      if (!samePath(await marketRoot(), expected)) throw Error('The Codex marketplace changed during the operation.');
      const result = await receipt(['plugin', 'marketplace', 'remove', '--json', name]);
      if (result?.marketplaceName !== name || await marketRoot()) throw Error('Codex did not confirm marketplace removal.');
    },
    async addPlugin(release) {
      const result = await receipt(['plugin', 'add', '--json', pluginId]);
      if (result?.pluginId !== pluginId || result.version !== release.version ||
        !samePath(hostPath(result.installedPath), join(paths.cache, release.version)) ||
        !cacheVersions(paths, true).includes(release.version)) throw Error('Codex did not confirm the verified Hive Swarm version.');
    },
    async removePlugin() {
      const result = await receipt(['plugin', 'remove', '--json', pluginId]);
      if (result?.pluginId !== pluginId || cacheVersions(paths, true).length) throw Error('Codex did not confirm Hive Swarm removal.');
    },
    async canSwitchVersion() {
      const version = await run(['--version']);
      return version?.trim() === qualifiedUpdateVersion;
    },
  };
}

function managedMarketplace(paths, root, owned) {
  if (!root) return null;
  const parts = relative(paths.store, root).split(sep);
  if (!owned || parts.length !== 3 || parts[0] !== 'versions' || parts[2] !== 'marketplace' || !validVersion(parts[1])) {
    throw Error('Refusing a foreign Hive Swarm marketplace at ' + root + '. Manage the existing registration in Codex before using this installer.');
  }
  const release = verifiedRelease(paths.store, parts[1]);
  if (!samePath(root, release.path)) throw Error('Refusing an unexpected Hive Swarm marketplace path: ' + root);
  return release;
}

async function activate(host, paths, previous, candidate) {
  try {
    if (previous && !samePath(previous.path, candidate.path)) await host.removeMarketplace(previous.path);
    if (!previous || !samePath(previous.path, candidate.path)) await host.addMarketplace(candidate);
    await host.addPlugin(candidate);
  } catch (error) {
    let recovery;
    try {
      let current = await host.marketRoot();
      if (current && !samePath(current, candidate.path) && !samePath(current, previous?.path)) {
        throw Error('The marketplace now points to an unexpected path: ' + current);
      }
      const cached = cacheVersions(paths, true);
      if (!previous && cached.includes(candidate.version)) await host.removePlugin();
      if (samePath(current, candidate.path) && !samePath(current, previous?.path)) {
        await host.removeMarketplace(candidate.path);
        current = null;
      }
      if (previous && !current) await host.addMarketplace(previous);
      if (previous && !cached.includes(previous.version)) await host.addPlugin(previous);
      recovery = previous ? ' Previous Codex marketplace and cached release restored.' : ' Initial registration cleared.';
    } catch (failure) {
      recovery = ' Rollback failed: ' + failure.message + ' Inspect Codex’s plugin marketplace before retrying.';
    }
    const retained = ' Staged candidate: ' + candidate.path + '.' +
      (previous ? ' Previous verified copy: ' + previous.path + '.' : '');
    throw Error(error.message + recovery + retained, {cause: error});
  }
}

async function stopOwnedService(paths, env) {
  const keyPath = join(paths.data, 'service.key');
  if (!entry(keyPath)) return;
  const key = readRegularFile(keyPath).toString('utf8').trim();
  if (!/^[a-f0-9]{64}$/i.test(key)) throw Error('The owned Swarm service key is invalid; inspect the data directory.');
  const port = Number(env.HIVE_SWARM_PORT || env.TEAM_BOARD_PORT || 17943);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid Swarm service port.');
  const address = 'http://127.0.0.1:' + port;
  const headers = {authorization: 'Bearer ' + key};
  const ready = async (stopping = false) => {
    let response, value;
    try {
      response = await fetch(address + '/ready', {headers, redirect: 'error', signal: AbortSignal.timeout(1000)});
      if (response.ok) value = await response.json();
    } catch (error) {
      const code = error.cause?.code;
      if (!response && code === 'ECONNREFUSED') return null;
      if (stopping && (['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code) || error.name === 'TimeoutError')) return undefined;
      throw Error('Could not verify that the owned Swarm service has stopped.');
    }
    if (!response.ok) throw Error('The local service did not confirm Hive ownership; no plugin files were changed.');
    if (value?.service !== 'codex-team-board' || !validVersion(value.version)) throw Error('The local service is not a verified Hive Swarm daemon.');
    return value;
  };
  const running = await ready();
  if (running === null) return;
  const response = await fetch(address + '/shutdown', {method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(3000)});
  if (response.status === 409) throw Error('Swarm still has running turns. Wait for them to finish before updating or uninstalling.');
  if (!response.ok) throw Error('The owned Swarm service cannot shut down safely. Keep the staged copy and stop that daemon before retrying.');
  const value = await response.json();
  if (value?.service !== running.service || value.version !== running.version || value.stopping !== true) {
    throw Error('Swarm did not confirm graceful shutdown.');
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await ready(true) === null) return;
    await delay(100);
  }
  throw Error('The owned Swarm service is still listening; plugin files were retained.');
}

/**
 * Apply an explicit Codex lifecycle action. Installed copies and ownership markers are
 * independent of the npm cache. Host writes are delegated to the supported CLI.
 */
export async function runInstaller(action, {
  home = homedir(), env = process.env, packageDirectory = packageRoot, command, resolveCommand,
  runCommand = runCodexCommand, afterClose = false, bindNode = false,
} = {}) {
  if (!['install', 'update', 'uninstall'].includes(action)) throw Error('Unknown installer action: ' + action);
  const paths = installPaths(home, env);
  const packagePath = resolve(packageDirectory);
  const npmCache = Object.entries(env).find(([key]) => key.toLowerCase() === 'npm_config_cache')?.[1];
  for (const path of [paths.store, paths.cache]) {
    if (contains(path, paths.data) || contains(paths.data, path)) throw Error('Swarm data overlaps an installer or Codex cache path: ' + paths.data);
  }
  if (paths.store.split(sep).some(part => ['_npx', 'node_modules', 'npm-cache', '.npm'].includes(part.toLowerCase())) ||
    npmCache && contains(resolve(npmCache), paths.store) || contains(packagePath, paths.store)) {
    throw Error('Choose a persistent Codex home outside the npm package and cache.');
  }
  const hasHome = directory(paths.codexHome);
  const owned = directory(paths.store);
  if (owned) readMarker(paths.store);
  if (!hasHome && action === 'uninstall') return {status: 'absent', ...paths};
  const source = action === 'uninstall' ? null : readPackage(packagePath);
  const explicitNodePath = source && bindNode ? await currentNodePath(packagePath, npmCache) : undefined;
  const executable = command || await resolveCommand?.();
  if (!executable) throw Error('Codex CLI unavailable. Put Codex on PATH or set HIVE_SWARM_CODEX to its executable path.');
  directory(paths.codexHome, true);
  const host = hostCommands(paths, executable, runCommand, env);
  if (!owned) {
    managedMarketplace(paths, await host.marketRoot(), false);
    cacheVersions(paths, false);
    if (action === 'uninstall') return {status: 'absent', ...paths};
    publishDirectory(paths.store, staging => {
      mkdirSync(join(staging, 'versions'), {mode: 0o700});
      writeMarker(staging, owner);
    });
  }
  const lock = join(paths.store, 'operation.lock');
  try { mkdirSync(lock, {mode: 0o700}); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw Error('An installer operation is active or interrupted. Inspect the managed store before clearing ' + lock + '.');
  }
  try {
    const previous = managedMarketplace(paths, await host.marketRoot(), true);
    const cached = cacheVersions(paths, true);
    if (action === 'uninstall') {
      if (!previous && !cached.length) return {status: 'absent', ...paths};
      await stopOwnedService(paths, env);
      await host.removePlugin();
      if (previous) await host.removeMarketplace(previous.path);
      return {status: 'uninstalled', ...paths};
    }
    const nodePath = explicitNodePath || (previous?.nodePath && await currentNodePath(packagePath, npmCache));
    const candidate = stageRelease(paths.store, source, nodePath, bindNode);
    if (!previous && cached.length) {
      throw Error('A managed Codex cache remains without its marketplace. Restore its registration in Codex before retrying. Candidate: ' + candidate.path);
    }
    const switching = previous && !samePath(previous.path, candidate.path);
    if (switching) {
      const staged = 'Verified candidate staged at ' + candidate.path + '. ';
      if (action === 'install') throw Error(staged + 'Run hive-swarm update --host codex to update the existing installation.');
      if (!afterClose) {
        throw Error(staged + 'Finish Swarm turns and exit Codex, then rerun hive-swarm update --host codex --after-close.');
      }
      try {
        if (!await host.canSwitchVersion()) throw Error('Local marketplace switching is qualified for ' + qualifiedUpdateVersion + '.');
      } catch (error) {
        throw Error(staged + error.message + ' Use the qualified Codex CLI for the switch. The previous version is still registered.', {cause: error});
      }
    }
    if (!switching && previous && cached.includes(candidate.version)) return {status: 'unchanged', ...paths, ...candidate};
    await stopOwnedService(paths, env);
    await activate(host, paths, previous, candidate);
    return {status: switching ? 'updated' : 'installed', ...paths, ...candidate};
  } finally {
    rmdirSync(lock);
  }
}
