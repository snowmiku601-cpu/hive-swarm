import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
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

async function managedPath(storage, teamId, member, create = false) {
  if (!/^[a-f0-9-]{36}$/.test(teamId) || !/^[a-z][a-z0-9_-]{0,29}$/.test(member)) {
    throw Error('Invalid team or member workspace name.');
  }
  if (create) await mkdir(storage, {recursive:true});
  const root = realPathSync(storage);
  const directory = join(root, 'worktrees', teamId);
  if (create) await mkdir(directory, {recursive:true});
  let resolved = null;
  try { resolved = realPathSync(directory); }
  catch (error) {
    if (create || error.code !== 'ENOENT') throw error;
  }
  if (resolved && !samePath(directory, resolved)) throw Error('Unexpected worktree storage location.');
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

export async function openWorktree(storage, source, teamId, member, {mustExist = false, exec, retryDelayMs = 120} = {}) {
  const gitOpts = {exec, retryDelayMs};
  return withRepoLock(source.directory, async () => {
    const destination = await managedPath(storage, teamId, member, true);
    if (!(await ownedCheckout(destination, source, gitOpts))) {
      if (mustExist) throw Error('Saved worktree is missing: ' + destination);
      await git(source.root, ['worktree', 'add', '--detach', destination, source.commit], 120000, gitOpts);
    }
    const cwd = realPathSync(join(destination, source.offset));
    if (!within(destination, cwd)) throw Error('Worktree workspace resolved outside its checkout.');
    return {path:destination, cwd, base:source.commit};
  });
}

export async function removeWorktree(storage, source, teamId, member, workspace, {force = false, exec, retryDelayMs = 120} = {}) {
  const gitOpts = {exec, retryDelayMs};
  return withRepoLock(source.directory, async () => {
    const destination = await managedPath(storage, teamId, member);
    if (!isAbsolute(workspace.path) || !samePath(destination, workspace.path)) {
      throw Error('The saved path is not the owned checkout for this member.');
    }
    const exists = await ownedCheckout(destination, source, gitOpts);
    if (exists) {
      if (force !== true && await git(destination, ['status','--porcelain','--untracked-files=all'], 5000, gitOpts)) {
        throw Error('The worktree has uncommitted changes. Use force only to discard them.');
      }
      const options = force === true ? ['--force'] : [];
      await git(source.root, ['worktree','remove',...options,'--',destination], 120000, gitOpts);
    }
    await git(source.root, ['worktree','prune',...(exists ? [] : ['--expire','now'])], 5000, gitOpts);
  });
}
