import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import * as worktrees from './worktrees.mjs';
const {openWorktree,worktreeSource}=worktrees;

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
  assert.equal(target,join(realpathSync(state),'worktrees',id));
  rmSync(target,{recursive:true});
  await worktrees.removeWorktree(state,source,id,'missing',checkout);
  assert.ok(!git('worktree','list','--porcelain').toString().includes(id));
});
