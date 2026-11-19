#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const nodeRange = '^22.19.0 || >=24.2.0';
const usage = `Usage: hive-swarm [--help | --version | doctor [--host codex]]

  --help, -h       Show this help.
  --version, -v    Show the npm package version.
  doctor          Check Node, SQLite, package integrity and the Codex CLI.
  --host codex    Select the Codex host (the default for doctor).

Doctor is read-only. It does not start models, register plugins or change host data.
`;

async function commandRunner(command, args) {
  const result = await promisify(execFile)(command, args, {
    encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false, maxBuffer: 64 * 1024,
  });
  return {...result, exitCode: 0};
}

function supportedNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [, major, minor] = match.map(Number);
  return major === 22 && minor >= 19 || major === 24 && minor >= 2 || major > 24;
}

async function doctor(options) {
  const {stdout, packageDirectory, home, env, nodeVersion, runCommand} = options;
  let failed = false;
  const check = (ok, message) => {
    stdout.write(`${ok ? 'PASS' : 'FAIL'} ${message}\n`);
    if (!ok) failed = true;
  };
  stdout.write('Hive Swarm doctor (read-only)\n');
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
    check(manifest.name === 'hive-swarm' && plugin.name === 'hive-swarm' && manifest.version === plugin.version,
      `Version integrity: npm ${manifest.version}; Codex runtime ${plugin.version}`);
    const missing = [...new Set([...manifest.files, 'package.json', 'README.md', 'LICENSE'])].filter(file => {
      try { return !statSync(join(packageDirectory, file)).isFile(); } catch { return true; }
    });
    check(missing.length === 0, missing.length ? `Package files missing: ${missing.join(', ')}` : 'Required package files present');
  } catch {
    check(false, 'Package metadata missing or invalid; obtain a verified Hive Swarm package');
  }
  try {
    const command = env.HIVE_SWARM_CODEX || env.TEAM_BOARD_CODEX || (process.platform === 'win32' ? 'codex.exe' : 'codex');
    const result = await runCommand(command, ['--version']);
    const ok = result.exitCode === 0 && Boolean(result.stdout?.trim());
    check(ok, ok ? `Codex CLI: ${result.stdout.trim()}` : 'Codex CLI version check failed; verify Codex is installed and on PATH');
  } catch {
    check(false, 'Codex CLI unavailable; put Codex on PATH or set HIVE_SWARM_CODEX to its executable path');
  }
  stdout.write('No model calls, plugin registration or host data changes were requested.\n');
  return failed ? 1 : 0;
}

/** Run the CLI without process exits; paths, IO and host execution are injectable. */
export async function main(argv, options = {}) {
  const {
    stdout = process.stdout, stderr = process.stderr, packageDirectory = packageRoot,
    home = homedir(), env = process.env, nodeVersion = process.versions.node, runCommand = commandRunner,
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
      stdout.write(JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')).version + '\n');
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
  return doctor({stdout, packageDirectory, home, env, nodeVersion, runCommand});
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
