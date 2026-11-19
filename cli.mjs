#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const nodeRange = '^22.19.0 || >=24.2.0';
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const mandatoryFiles = [
  '.agents/plugins/marketplace.json', '.codex-plugin/plugin.json', '.mcp.json',
  'assets/hive-swarm-banner.svg', 'assets/hive-swarm-flow.svg', 'assets/hive-swarm-icon.png', 'assets/hive-swarm-icon.svg',
  'board.css', 'board.html', 'board.js', 'cli.mjs', 'codex.mjs', 'engine.mjs', 'hive-bees.js', 'hive-graph.js',
  'server.mjs', 'skills/swarm/SKILL.md', 'skills/swarm/agents/openai.yaml', 'worktrees.mjs',
];
const usage = `Usage: hive-swarm [--help | --version | doctor [--host codex]]

  --help, -h       Show this help.
  --version, -v    Show the npm package version.
  doctor          Check Node, SQLite, package integrity and the Codex CLI.
  --host codex    Select the Codex host (the default for doctor).

Doctor is read-only. It does not start models, register plugins or change host data.
`;

function validIdentity(manifest) {
  return manifest?.name === 'hive-swarm' && typeof manifest.version === 'string' && semver.test(manifest.version);
}

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

function supportedNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [, major, minor] = match.map(Number);
  return major === 22 && minor >= 19 || major === 24 && minor >= 2 || major > 24;
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
  stdout.write(`Codex home: ${env.CODEX_HOME || join(home, '.codex')}\n`);
  stdout.write(`Swarm data directory: ${env.HIVE_SWARM_DATA || env.TEAM_BOARD_DATA || join(env.LOCALAPPDATA || home, 'CodexTeamBoard')}\n`);
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
    if (!Array.isArray(manifest.files) || manifest.files.length === 0 || new Set(manifest.files).size !== manifest.files.length ||
      !manifest.files.every(file => typeof file === 'string' && file.length > 0 && !/[\\\0:*?\[\]{}]/.test(file) &&
        file.split('/').every(part => part && part !== '.' && part !== '..')) ||
      !mandatoryFiles.every(file => manifest.files.includes(file))) throw Error('Invalid mandatory file metadata');
    const missing = [...new Set([...manifest.files, 'package.json', 'README.md', 'LICENSE'])].filter(file => {
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
  if (argv[0] !== 'doctor') return fail(`Unknown command or arguments: ${argv.join(' ')}`);
  if (!(argv.length === 1 || argv.length === 3 && argv[1] === '--host')) return fail('Expected doctor [--host codex].');
  const host = argv[2] ?? 'codex';
  if (host === 'dsh') return fail('DSH uses the separate dsh-hive-swarm native bundle and DSH plugin manager; core doctor currently supports Codex.');
  if (host !== 'codex') return fail(`Unsupported host: ${host}. Expected codex.`);
  return doctor({stdout, packageDirectory, home, env, nodeVersion, runCommand, platform, queryAppxPackages});
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
