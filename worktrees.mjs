import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import path, { isAbsolute, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repoQueues = new Map();
const pathOps = (platform = process.platform) => platform === 'win32' ? path.win32 : path.posix;

function realPathSync(target) {
  return (realpathSync.native ?? realpathSync)(target);
}

function canonicalCase(target, platform = process.platform) {
  return platform === 'win32' ? target.toLowerCase() : target;
}

export function samePath(left, right, platform = process.platform) {
  return pathOps(platform).relative(canonicalCase(left, platform), canonicalCase(right, platform)) === '';
}

export function within(root, target, platform = process.platform) {
  const ops = pathOps(platform);
  const offset = ops.relative(canonicalCase(root, platform), canonicalCase(target, platform));
  return !ops.isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + ops.sep);
}

function relativeOffset(root, target, platform = process.platform) {
  const ops = pathOps(platform);
  if (platform !== 'win32') return ops.relative(root, target);
  const rel = ops.relative(root.toLowerCase(), target.toLowerCase());
  if (!rel || ops.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + ops.sep)) return rel;
  const cleanRoot = ops.resolve(root);
  const cleanTarget = ops.resolve(target);
  if (cleanTarget.toLowerCase().startsWith(cleanRoot.toLowerCase())) {
    const rest = cleanTarget.slice(cleanRoot.length).replace(/^[\\/]+/, '');
    if (rest.toLowerCase() === rel.toLowerCase()) return rest;
  }
  return rel;
}

function isTransientLockError(error) {
  if (!error) return false;
  if (['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) return true;
  const text = String(error.stderr || error.message || error);
  return /\.git[\\/]worktrees[\\/]|commondir|index\.lock|\bEPERM\b|\bEBUSY\b|unable to create .*\.lock|cannot lock|permission denied/i.test(text);
}

function lockKey(directory) {
  try { return canonicalCase(realPathSync(directory)); }
  catch { return canonicalCase(resolve(directory)); }
}

async function withRepoLock(directory, task) {
  const key = lockKey(directory);
  const previous = repoQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const tail = run.catch(() => {});
  repoQueues.set(key, tail);
  try {
    return await run;
  } finally {
    if (repoQueues.get(key) === tail) repoQueues.delete(key);
  }
}

async function git(cwd, args, timeout = 5000, {exec = execute, retryDelayMs = 120} = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const {stdout} = await exec('git', ['-C', cwd, ...args], {windowsHide:true, timeout});
      return stdout.trim();
    } catch (error) {
      if (attempt === 0 && isTransientLockError(error)) {
        await delay(retryDelayMs);
        continue;
      }
      const detail = String(error.stderr || error.message).trim().slice(-380);
      throw Error('Git ' + args[0] + ' failed: ' + detail);
    }
  }
}

async function repository(cwd, gitOpts) {
  const [root, directory] = (await git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], 5000, gitOpts)).split(/\r?\n/);
  return {root: realPathSync(root), directory: realPathSync(directory)};
}

export async function worktreeSource(cwd) {
  const workspace = realPathSync(cwd);
  const repo = await repository(workspace);
  if (!within(repo.root, workspace)) throw Error('Workspace is outside its Git repository.');
  const commit = await git(repo.root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const offset = relativeOffset(repo.root, workspace);
  if (offset) {
    const objectType = await git(repo.root, ['cat-file', '-t', commit + ':' + offset.split(sep).join('/')]);
    if (objectType !== 'tree') throw Error('Workspace must be a directory in the selected commit.');
  }
  return {...repo, commit, offset};
}

function validateWorktreeMode(mode = 'external') {
  if (mode !== 'external' && mode !== 'local') throw Error('Worktree mode must be external or local.');
  return mode;
}

function localBranchName(teamId, member) {
  return 'hive-swarm/' + teamId.slice(0, 8) + '/' + member;
}

async function ensureLocalExclude(gitDir) {
  const infoDir = join(gitDir, 'info');
  const excludeFile = join(infoDir, 'exclude');
  await mkdir(infoDir, {recursive: true});
  let current = '';
  try { current = await readFile(excludeFile, 'utf8'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const lines = current.split(/\r?\n/).map(line => line.trim());
  if (lines.some(line => ['.hive-swarm-worktrees/', '.hive-swarm-worktrees', '/.hive-swarm-worktrees/'].includes(line))) {
    return;
  }
  const prefix = current.length && !current.endsWith('\n') ? '\n' : '';
  await writeFile(excludeFile, current + prefix + '.hive-swarm-worktrees/\n', 'utf8');
}

async function pruneEmptyLocalDirs(repoRoot, teamId) {
  const base = join(realPathSync(repoRoot), '.hive-swarm-worktrees');
  for (const dir of [join(base, teamId), base]) {
    try { await rmdir(dir); }
    catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
    }
  }
}

function assertResolvedDirectory(directory, create) {
  let resolved = null;
  try { resolved = realPathSync(directory); }
  catch (error) {
    if (create || error.code !== 'ENOENT') throw error;
  }
  if (resolved && !samePath(directory, resolved)) throw Error('Unexpected worktree storage location.');
}

async function managedPath(storage, teamId, member, create = false, {worktreeMode = 'external', source} = {}) {
  if (!/^[a-f0-9-]{36}$/.test(teamId) || !/^[a-z][a-z0-9_-]{0,29}$/.test(member)) {
    throw Error('Invalid team or member workspace name.');
  }
  const mode = validateWorktreeMode(worktreeMode);
  if (mode === 'local') {
    if (!source?.root || !source?.directory) throw Error('Repository source is required for local worktrees.');
    const repoRoot = realPathSync(source.root);
    const base = join(repoRoot, '.hive-swarm-worktrees');
    const directory = join(base, teamId);
    if (create) {
      await ensureLocalExclude(source.directory);
      await mkdir(directory, {recursive: true});
    }
    assertResolvedDirectory(base, create);
    assertResolvedDirectory(directory, create);
    return join(directory, member);
  }
  if (create) await mkdir(storage, {recursive:true});
  const root = realPathSync(storage);
  const directory = join(root, 'worktrees', teamId);
  if (create) await mkdir(directory, {recursive:true});
  assertResolvedDirectory(directory, create);
  return join(directory, teamId + '-' + member);
}

async function ownedCheckout(destination, source, gitOpts) {
  const previous = await lstat(destination).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!previous) return false;
  if (!previous.isDirectory() || !samePath(destination, realPathSync(destination))) {
    throw Error('Existing worktree path is not an owned checkout: ' + destination);
  }
  const found = await repository(destination, gitOpts);
  if (!samePath(destination, found.root) || !samePath(source.directory, found.directory)) {
    throw Error('Existing worktree belongs to a different repository: ' + destination);
  }
  return true;
}

export async function openWorktree(storage, source, teamId, member, {mustExist = false, worktreeMode = 'external', exec, retryDelayMs = 120} = {}) {
  const mode = validateWorktreeMode(worktreeMode);
  const gitOpts = {exec, retryDelayMs};
  return withRepoLock(source.directory, async () => {
    const destination = await managedPath(storage, teamId, member, true, {worktreeMode: mode, source});
    const branch = mode === 'local' ? localBranchName(teamId, member) : undefined;
    if (!(await ownedCheckout(destination, source, gitOpts))) {
      if (mustExist) throw Error('Saved worktree is missing: ' + destination);
      const args = branch
        ? ['worktree', 'add', '-B', branch, destination, source.commit]
        : ['worktree', 'add', '--detach', destination, source.commit];
      await git(source.root, args, 120000, gitOpts);
    }
    const cwd = realPathSync(join(destination, source.offset));
    if (!within(destination, cwd)) throw Error('Worktree workspace resolved outside its checkout.');
    return {path:destination, cwd, base:source.commit, ...(branch ? {branch} : {})};
  });
}

export async function removeWorktree(storage, source, teamId, member, workspace, {force = false, worktreeMode, exec, retryDelayMs = 120} = {}) {
  const mode = validateWorktreeMode(worktreeMode ?? (workspace?.branch ? 'local' : 'external'));
  const gitOpts = {exec, retryDelayMs};
  return withRepoLock(source.directory, async () => {
    const destination = await managedPath(storage, teamId, member, false, {worktreeMode: mode, source});
    if (!isAbsolute(workspace.path) || !samePath(destination, workspace.path)) {
      throw Error('The saved path is not the owned checkout for this member.');
    }
    const exists = await ownedCheckout(destination, source, gitOpts);
    if (exists) {
      if (force !== true && await git(destination, ['status','--porcelain','--untracked-files=all'], 20000, gitOpts)) {
        throw Error('The worktree has uncommitted changes. Use force only to discard them.');
      }
      const options = force === true ? ['--force'] : [];
      await git(source.root, ['worktree','remove',...options,'--',destination], 120000, gitOpts);
    }
    await git(source.root, ['worktree','prune',...(exists ? [] : ['--expire','now'])], 5000, gitOpts);
    if (mode === 'local') {
      const branch = localBranchName(teamId, member);
      if (await git(source.root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/' + branch], 5000, gitOpts)) {
        await git(source.root, ['branch', '-D', branch], 5000, gitOpts);
      }
      await pruneEmptyLocalDirs(source.root, teamId);
    }
  });
}
