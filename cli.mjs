#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CORE_PACKAGE_FILES, installPaths, matchesPackageFiles, runInstaller, semver, supportedNode, validIdentity } from './installer.mjs';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const nodeRange = '^22.19.0 || >=24.2.0';
const usage = `Usage: hive-swarm [--help | --version | doctor | install | update | uninstall]

  hive-swarm install [--host codex]    Install from a persistent marketplace copy.
  hive-swarm update [--host codex]     Verify and stage the npm package.
  hive-swarm uninstall [--host codex]  Remove the managed plugin and marketplace. Keep Swarm data.
  --after-close                      Apply a staged update after Swarm work finishes and Codex exits.
  --bind-node                        Install or update using the current Node executable in Codex.

  --help, -h       Show this help.
  --version, -v    Show the npm package version.
  doctor          Check Node, SQLite, package integrity and the Codex CLI.
  --host codex    Select the Codex host (default).
  --host dsh      Show commands for the DSH plugin manager.

Doctor is read-only. It does not start models, register plugins or change host data.
`;

async function appxPackages(env) {
  const powershell = join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const {stdout} = await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'Get-AppxPackage -Name OpenAI.Codex | Select-Object Name,InstallLocation | ConvertTo-Json -Compress'], {
    env, encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false, maxBuffer: 64 * 1024,
  });
  const packages = JSON.parse(stdout.trim() || '[]');
  return Array.isArray(packages) ? packages : [packages];
}

async function locateCodex({env, platform, queryAppxPackages}) {
  const usable = file => {
    try {
      const info = statSync(file);
      if (!info.isFile() || info.size === 0) return false;
      if (platform !== 'win32') accessSync(file, constants.X_OK);
      return true;
    } catch { return false; }
  };
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  const directories = pathValue.split(platform === 'win32' ? ';' : delimiter).filter(Boolean).map(path => path.replace(/^"(.*)"$/, '$1'));
  const names = name => platform === 'win32' && !/\.(exe|cmd)$/i.test(name) ? [name + '.exe', name + '.cmd'] : [name];
  const override = env.HIVE_SWARM_CODEX || env.TEAM_BOARD_CODEX;
  const candidates = override
    ? (isAbsolute(override) || /[\\/]/.test(override) ? names(resolve(override)) : directories.flatMap(path => names(join(path, override))))
    : directories.flatMap(path => names(join(path, 'codex')));
  const found = candidates.find(usable);
  if (found || override || platform !== 'win32') return found;
  const packages = await queryAppxPackages(env);
  if (!Array.isArray(packages)) return;
  return packages.filter(item => item?.Name === 'OpenAI.Codex' && typeof item.InstallLocation === 'string' && isAbsolute(item.InstallLocation))
    .map(item => join(item.InstallLocation, 'app', 'resources', 'codex.exe')).find(usable);
}

async function doctor(options) {
  const {stdout, packageDirectory, home, env, nodeVersion, runCommand, platform, queryAppxPackages} = options;
  let failed = false;
  const check = (ok, message) => {
    stdout.write(`${ok ? 'PASS' : 'FAIL'} ${message}\n`);
    if (!ok) failed = true;
  };
  stdout.write(`Hive Swarm doctor (${runCommand ? 'explicit diagnostic runner' : 'read-only'})\n`);
  stdout.write(`Package directory: ${packageDirectory}\n`);
  const {codexHome, store, data} = installPaths(home, env);
  stdout.write(`Codex home: ${codexHome}\nPersistent marketplace store: ${store}\nSwarm data directory: ${data}\n`);
  check(supportedNode(nodeVersion), `Node.js ${nodeVersion}; required ${nodeRange}`);
  try {
    const {DatabaseSync} = await import('node:sqlite');
    const database = new DatabaseSync(':memory:');
    try {
      check(database.prepare('SELECT 1 AS ready').get().ready === 1, 'SQLite in-memory query');
    } finally {
      database.close();
    }
  } catch {
    check(false, 'SQLite unavailable; use a supported Node.js build with node:sqlite');
  }
  try {
    const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
    const plugin = JSON.parse(readFileSync(join(packageDirectory, '.codex-plugin', 'plugin.json'), 'utf8'));
    check(validIdentity(manifest) && validIdentity(plugin) && manifest.version === plugin.version,
      `Version integrity: npm ${manifest.version}; Codex runtime ${plugin.version}`);
    if (!matchesPackageFiles(manifest.files)) throw Error('Invalid mandatory file metadata');
    const missing = CORE_PACKAGE_FILES.filter(file => {
      try { return !statSync(join(packageDirectory, file)).isFile(); } catch { return true; }
    });
    check(missing.length === 0, missing.length ? `Package files missing: ${missing.join(', ')}` : 'Required package files present');
  } catch {
    check(false, 'Package metadata missing or invalid; obtain a verified Hive Swarm package');
  }
  try {
    if (runCommand) {
      const command = env.HIVE_SWARM_CODEX || env.TEAM_BOARD_CODEX || (platform === 'win32' ? 'codex.exe' : 'codex');
      const result = await runCommand(command, ['--version']);
      const version = typeof result.stdout === 'string' ? result.stdout.trim() : '';
      const ok = result.exitCode === 0 && /^codex-cli \S+$/.test(version) && semver.test(version.slice('codex-cli '.length));
      check(ok, ok ? `Codex CLI: ${version}` : 'Codex CLI version diagnostic failed; expected a codex-cli version signature');
    } else {
      const executable = await locateCodex({env, platform, queryAppxPackages});
      check(Boolean(executable), executable ? `Codex CLI located (not executed): ${executable}`
        : 'Codex CLI unavailable; put Codex on PATH or set HIVE_SWARM_CODEX to its executable path');
    }
  } catch {
    check(false, 'Codex CLI unavailable; put Codex on PATH or set HIVE_SWARM_CODEX to its executable path');
  }
  stdout.write(runCommand ? 'An explicit Codex version diagnostic was requested.\n' : 'Codex was not executed. No model calls, plugin registration or host data changes were requested.\n');
  return failed ? 1 : 0;
}

/** Run the CLI without process exits; paths, IO and host execution are injectable. */
export async function main(argv, options = {}) {
  const {
    stdout = process.stdout, stderr = process.stderr, packageDirectory = packageRoot,
    home = homedir(), env = process.env, nodeVersion = process.versions.node, runCommand,
    platform = process.platform, queryAppxPackages = appxPackages,
  } = options;
  const fail = message => {
    stderr.write(`hive-swarm: ${message}\nRun hive-swarm --help for usage.\n`);
    return 2;
  };
  if (argv.length === 0 || argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    stdout.write(usage);
    return 0;
  }
  if (argv.length === 1 && ['--version', '-v'].includes(argv[0])) {
    try {
      const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
      if (!validIdentity(manifest)) throw Error('Invalid package identity');
      stdout.write(manifest.version + '\n');
      return 0;
    } catch {
      stderr.write('hive-swarm: package metadata missing or invalid.\n');
      return 1;
    }
  }
  const [action, ...flags] = argv;
  if (!['doctor', 'install', 'update', 'uninstall'].includes(action)) return fail('Unknown command: ' + action);
  let host = 'codex';
  let hostSpecified = false;
  let afterClose = false;
  let bindNode = false;
  const allowsBinding = action === 'install' || action === 'update';
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--host' && !hostSpecified && i + 1 < flags.length) {
      host = flags[++i];
      hostSpecified = true;
    } else if (flags[i] === '--after-close' && action === 'update' && !afterClose) {
      afterClose = true;
    } else if (flags[i] === '--bind-node' && allowsBinding && !bindNode) {
      bindNode = true;
    } else {
      return fail('Expected ' + action + ' [--host codex|dsh]' + (action === 'update' ? ' [--after-close]' : '') +
        (allowsBinding ? ' [--bind-node]' : '') + '.');
    }
  }
  if (host === 'dsh') {
    if (action === 'doctor') return fail('DSH uses the dsh-hive-swarm native bundle. Use the DSH plugin manager for your profile.');
    const dshCommand = action === 'uninstall' ? 'remove dsh-hive-swarm' : 'add dsh-hive-swarm@<version>';
    return fail('Manage the dsh-hive-swarm bundle through DSH. With Desktop closed, run dsh plugin --profile desktop ' + dshCommand + '.');
  }
  if (host !== 'codex') return fail('Unsupported host: ' + host + '. Expected codex or dsh.');
  if (action === 'doctor') return doctor({stdout, packageDirectory, home, env, nodeVersion, runCommand, platform, queryAppxPackages});
  try {
    if (action !== 'uninstall' && !supportedNode(nodeVersion)) throw Error('Node.js ' + nodeRange + ' is required.');
    const result = await runInstaller(action, {home, env, packageDirectory, afterClose, bindNode, runCommand,
      resolveCommand: () => runCommand
        ? env.HIVE_SWARM_CODEX || env.TEAM_BOARD_CODEX || (platform === 'win32' ? 'codex.exe' : 'codex')
        : locateCodex({env, platform, queryAppxPackages}),
    });
    if (result.status === 'absent') stdout.write('No managed Hive Swarm installation found.\n');
    else if (result.status === 'uninstalled') stdout.write('Removed the managed Codex plugin and marketplace. Swarm data and verified release copies retained.\n');
    else {
      const actionLabel = {installed: 'Installed', updated: 'Updated to', unchanged: 'Already installed'}[result.status];
      stdout.write(actionLabel + ' Hive Swarm ' + result.version + ' from ' + result.path + '.\n');
      if (result.status !== 'unchanged') stdout.write('Open a new Codex session when ready to load the plugin. ' +
        (result.nodePath ? 'Codex will use Node.js at ' + result.nodePath + '.\n' : 'Codex needs Node.js on its PATH.\n'));
    }
    return 0;
  } catch (error) {
    stderr.write('hive-swarm: ' + error.message + '\n');
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
