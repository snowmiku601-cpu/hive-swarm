import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function git(cwd, args, timeout = 5000) {
  try {
    const {stdout} = await execute('git', ['-C', cwd, ...args], {windowsHide:true, timeout});
    return stdout.trim();
  } catch (error) {
    const detail = String(error.stderr || error.message).trim().slice(-380);
    throw Error('Git ' + args[0] + ' failed: ' + detail);
  }
}

async function repository(cwd) {
  const [root, directory] = (await git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'])).split(/\r?\n/);
  return {root:await realpath(root), directory:await realpath(directory)};
}

function within(root, target) {
  const offset = relative(root, target);
  return !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep);
}

export async function worktreeSource(cwd) {
  const workspace = await realpath(cwd);
  const repo = await repository(workspace);
  if (!within(repo.root, workspace)) throw Error('Workspace is outside its Git repository.');
  const commit = await git(repo.root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const offset = relative(repo.root, workspace);
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
  const root = await realpath(storage);
  const directory = join(root, 'worktrees', teamId);
  if (create) await mkdir(directory, {recursive:true});
  const resolved = await realpath(directory).catch(error => {
    if (create || error.code !== 'ENOENT') throw error;
    return null;
  });
  if (resolved && relative(directory,resolved)) throw Error('Unexpected worktree storage location.');
  return join(directory, teamId + '-' + member);
}

async function ownedCheckout(destination, source) {
  const previous = await lstat(destination).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!previous) return false;
  if (!previous.isDirectory() || relative(destination, await realpath(destination))) {
    throw Error('Existing worktree path is not an owned checkout: ' + destination);
  }
  const found = await repository(destination);
  if (relative(destination, found.root) || relative(source.directory, found.directory)) {
    throw Error('Existing worktree belongs to a different repository: ' + destination);
  }
  return true;
}

export async function openWorktree(storage, source, teamId, member, {mustExist = false} = {}) {
  const destination = await managedPath(storage, teamId, member, true);
  if (!(await ownedCheckout(destination, source))) {
    if (mustExist) throw Error('Saved worktree is missing: ' + destination);
    await git(source.root, ['worktree', 'add', '--detach', destination, source.commit], 120000);
  }
  const cwd = await realpath(join(destination, source.offset));
  if (!within(destination, cwd)) throw Error('Worktree workspace resolved outside its checkout.');
  return {path:destination, cwd, base:source.commit};
}

export async function removeWorktree(storage, source, teamId, member, workspace, {force = false} = {}) {
  const destination = await managedPath(storage, teamId, member);
  if (!isAbsolute(workspace.path) || relative(destination, workspace.path)) {
    throw Error('The saved path is not the owned checkout for this member.');
  }
  const exists = await ownedCheckout(destination, source);
  if (exists) {
    if (force !== true && await git(destination, ['status','--porcelain','--untracked-files=all'])) {
      throw Error('The worktree has uncommitted changes. Use force only to discard them.');
    }
    const options = force === true ? ['--force'] : [];
    await git(source.root, ['worktree','remove',...options,'--',destination], 120000);
  }
  await git(source.root, ['worktree','prune',...(exists ? [] : ['--expire','now'])]);
}
