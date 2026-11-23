import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import * as worktrees from './worktrees.mjs';
const {openWorktree,samePath,within,worktreeSource}=worktrees;
const execFileAsync = promisify(execFile);

async function repoFixture(t) {
  const scratch = realpathSync(tmpdir());
  const root = mkdtempSync(join(scratch, 'team-board-git-test-'));
  t.after(() => {
    assert.equal(dirname(realpathSync(root)),scratch);
    rmSync(root,{recursive:true,force:true});
  });
  const repository = join(root,'project');
  const subdir = join(repository,'package');
  mkdirSync(subdir,{recursive:true});
  const git = (...args) => execFileSync('git',['-C',repository,...args],{stdio:'pipe',windowsHide:true});
  git('init','-q');
  git('config','core.autocrlf','false');
  writeFileSync(join(subdir,'value.txt'),'base\n');
  git('add','package/value.txt');
  git('-c','user.name=Team Board tests','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-qm','base');
  const source = await worktreeSource(subdir);
  const state = join(root,'board');
  const id = '8a22965a-cc6d-4d77-aa3a-a5c61481d70c';
  return {source,state,id,git,subdir};
}

test('worktrees use one committed base, preserve the original checkout, and retain worker changes on resume', async t => {
  const {source,state,id,subdir}=await repoFixture(t);
  writeFileSync(join(subdir,'value.txt'),'dirty primary\n');
  const [a,b] = await Promise.all([
    openWorktree(state,source,id,'writer-a'),
    openWorktree(state,source,id,'writer-b'),
  ]);
  assert.notEqual(a.path,b.path);
  assert.equal(a.cwd,join(a.path,'package'));
  assert.equal(a.base,source.commit);
  assert.equal(readFileSync(join(a.cwd,'value.txt'),'utf8'),'base\n');
  assert.equal(readFileSync(join(b.cwd,'value.txt'),'utf8'),'base\n');
  writeFileSync(join(a.cwd,'value.txt'),'worker changes\n');
  assert.equal(readFileSync(join(subdir,'value.txt'),'utf8'),'dirty primary\n');
  assert.deepEqual(await openWorktree(state,source,id,'writer-a'),a);
  assert.equal(readFileSync(join(a.cwd,'value.txt'),'utf8'),'worker changes\n');
});

test('cleanup refuses changes and foreign paths, and force removes only the selected owned worktree',async t=>{
  const {source,state,id,subdir,git}=await repoFixture(t);
  const a=await openWorktree(state,source,id,'writer-a');
  const b=await openWorktree(state,source,id,'writer-b');
  writeFileSync(join(a.cwd,'dirty.txt'),'untracked\n');
  const remove=(workspace,options)=>worktrees.removeWorktree(state,source,id,'writer-a',workspace,options);
  await assert.rejects(async()=>remove(a),/uncommitted/);
  await assert.rejects(async()=>remove(b,{force:true}),/owned checkout/);
  assert.equal(readFileSync(join(a.cwd,'dirty.txt'),'utf8'),'untracked\n');
  await remove(a,{force:true});
  assert.equal(existsSync(a.path),false);
  assert.ok(existsSync(b.path));
  assert.equal(readFileSync(join(subdir,'value.txt'),'utf8'),'base\n');
  assert.ok(!git('worktree','list','--porcelain').toString().includes('writer-a'));
  await remove(a);
});

test('a clean owned worktree can be removed without force',async t=>{
  const {source,state,id,git}=await repoFixture(t);
  const checkout=await openWorktree(state,source,id,'clean');
  await worktrees.removeWorktree(state,source,id,'clean',checkout);
  assert.ok(!existsSync(checkout.path));
  assert.ok(!git('worktree','list','--porcelain').toString().includes(id));
});

test('cleanup prunes the checkout registration after its managed parent was removed',async t=>{
  const {source,state,id,git}=await repoFixture(t);
  const checkout=await openWorktree(state,source,id,'missing');
  const target=realpathSync(dirname(checkout.path));
  assert.equal(realpathSync.native(target),realpathSync.native(join(state,'worktrees',id)));
  rmSync(target,{recursive:true});
  await worktrees.removeWorktree(state,source,id,'missing',checkout);
  assert.ok(!git('worktree','list','--porcelain').toString().includes(id));
});

test('B2: Windows drive-letter and path case mismatches resolve cleanly across within, samePath, openWorktree and removeWorktree', async t => {
  assert.equal(samePath('d:\\repo\\sub', 'D:\\Repo\\Sub', 'win32'), true);
  assert.equal(samePath('d:\\repo\\sub', 'D:\\repo\\other', 'win32'), false);
  assert.equal(within('d:\\repo', 'D:\\Repo\\package', 'win32'), true);
  assert.equal(within('d:\\repo', 'D:\\repo-other\\package', 'win32'), false);

  if (process.platform === 'win32') {
    const {source,state,id,subdir}=await repoFixture(t);
    const flipDrive = value => value.replace(/^[A-Za-z]:/, drive => drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase());
    const lowerSource = await worktreeSource(flipDrive(subdir));
    assert.equal(lowerSource.offset, 'package');
    const checkout = await openWorktree(flipDrive(state), lowerSource, id, 'case-worker');
    await worktrees.removeWorktree(flipDrive(state), lowerSource, id, 'case-worker', {
      ...checkout,
      path: flipDrive(checkout.path),
    });
    assert.equal(existsSync(checkout.path), false);
  }
});

test('B3: concurrent openWorktree and removeWorktree serialize per repo and retry once on transient lock errors', async t => {
  const {source,state,id}=await repoFixture(t);
  let active = 0;
  let maxActive = 0;
  let transientInjected = false;
  const serializedExec = async (cmd, args, opts) => {
    if (args.includes('worktree') && (args.includes('add') || args.includes('remove'))) {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (!transientInjected && args.includes('add')) {
          transientInjected = true;
          const err = Error('fatal: failed to read .git/worktrees/w/commondir: No error');
          err.stderr = 'fatal: failed to read .git/worktrees/w/commondir: No error';
          throw err;
        }
        return await execFileAsync(cmd, args, opts);
      } finally {
        active--;
      }
    }
    return execFileAsync(cmd, args, opts);
  };

  const created = await Promise.all(['w1', 'w2', 'w3', 'w4'].map(name =>
    openWorktree(state, source, id, name, {exec: serializedExec, retryDelayMs: 5})
  ));
  assert.equal(maxActive, 1, 'concurrent worktree operations on the same repo must serialize');
  assert.equal(transientInjected, true);
  assert.equal(created.length, 4);

  // Also test EPERM / index.lock transient retry on removeWorktree.
  let removeRetry = false;
  await worktrees.removeWorktree(state, source, id, 'w1', created[0], {
    retryDelayMs: 5,
    exec: async (cmd, args, opts) => {
      if (!removeRetry && args.includes('remove')) {
        removeRetry = true;
        throw Object.assign(Error('EPERM: index.lock'), {code: 'EPERM'});
      }
      return execFileAsync(cmd, args, opts);
    },
  });
  assert.equal(removeRetry, true);

  // Stress concurrent real add/remove without artificial mocks.
  await Promise.all(created.slice(1).map((ws, idx) =>
    worktrees.removeWorktree(state, source, id, 'w' + (idx + 2), ws)
  ));
  assert.ok(created.every(ws => !existsSync(ws.path)));
});

test('local worktreeMode places checkouts under .hive-swarm-worktrees with named branch, clean git status, and branch cleanup', async t => {
  const {source, state, id, git, subdir} = await repoFixture(t);
  const checkout = await openWorktree(state, source, id, 'writer-a', {worktreeMode: 'local'});
  const expectedRoot = join(source.root, '.hive-swarm-worktrees', id, 'writer-a');
  const expectedBranch = 'hive-swarm/' + id.slice(0, 8) + '/writer-a';
  assert.equal(worktrees.samePath(checkout.path, expectedRoot), true);
  assert.equal(worktrees.samePath(checkout.cwd, join(expectedRoot, 'package')), true);
  assert.equal(checkout.branch, expectedBranch);
  assert.equal(git('status', '--porcelain', '--untracked-files=all').toString().trim(), '');
  assert.equal(execFileSync('git', ['-C', checkout.path, 'rev-parse', '--abbrev-ref', 'HEAD'], {encoding: 'utf8', windowsHide: true}).trim(), expectedBranch);

  // Committing inside local worktree survives reopening.
  writeFileSync(join(checkout.cwd, 'local.txt'), 'local commit\n');
  execFileSync('git', ['-C', checkout.path, 'add', 'package/local.txt'], {windowsHide: true});
  execFileSync('git', ['-C', checkout.path, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'worker commit'], {windowsHide: true});
  const reopened = await openWorktree(state, source, id, 'writer-a', {worktreeMode: 'local', mustExist: true});
  assert.deepEqual(reopened, checkout);

  // Opening a second local worktree does not duplicate .git/info/exclude lines and still keeps status clean.
  const second = await openWorktree(state, source, id, 'writer-b', {worktreeMode: 'local'});
  const exclude = readFileSync(join(source.directory, 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split(/\r?\n/).filter(line => line.trim() === '.hive-swarm-worktrees/').length, 1);
  assert.equal(git('status', '--porcelain', '--untracked-files=all').toString().trim(), '');

  // Dirty local worktree refuses removal without force, then cleans worktree and branch with force.
  writeFileSync(join(checkout.cwd, 'dirty.txt'), 'dirty\n');
  await assert.rejects(() => worktrees.removeWorktree(state, source, id, 'writer-a', checkout, {worktreeMode: 'local'}), /uncommitted/);
  await worktrees.removeWorktree(state, source, id, 'writer-a', checkout, {worktreeMode: 'local', force: true});
  assert.equal(existsSync(checkout.path), false);
  assert.equal(git('branch', '--list', expectedBranch).toString().trim(), '');

  // Clean second worktree removes cleanly along with its branch and empty container directories.
  await worktrees.removeWorktree(state, source, id, 'writer-b', second, {worktreeMode: 'local'});
  assert.equal(existsSync(join(source.root, '.hive-swarm-worktrees')), false);
  assert.equal(git('branch', '--list', 'hive-swarm/' + id.slice(0, 8) + '/writer-b').toString().trim(), '');
  assert.equal(readFileSync(join(subdir, 'value.txt'), 'utf8'), 'base\n');
});

test('removeWorktree uses 20000ms git status timeout', async t => {
  const {source, state, id} = await repoFixture(t);
  const checkout = await openWorktree(state, source, id, 'timeout-check');
  let statusTimeout;
  await worktrees.removeWorktree(state, source, id, 'timeout-check', checkout, {
    exec: async (cmd, args, opts) => {
      if (args.includes('status')) statusTimeout = opts.timeout;
      return execFileAsync(cmd, args, opts);
    },
  });
  assert.equal(statusTimeout, 20000);
});
