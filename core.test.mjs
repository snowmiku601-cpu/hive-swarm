import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createSwarmApplication} from './core.mjs';

const workspace=process.cwd();
function fixture(t,options={}) {
  const directory=options.dataDirectory??mkdtempSync(join(tmpdir(),'hive-core-'));
  const calls=[];
  const runner={listModels:async()=>[{id:'fixture/model',label:'Fixture model',efforts:['max'],defaultEffort:'max'}],
    readTranscript:async()=>[{status:'completed',steps:['Verified the fixture'],report:'Safe result.'}],
    run:request=>{calls.push(request);return new Promise((resolve,reject)=>{
      if(request.signal.aborted)return reject(request.signal.reason);
      request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});
    });},close:async()=>{}};
  const app=createSwarmApplication({dataDirectory:directory,host:'deepseek-harness',runner,
    workspaceAllowed:async cwd=>cwd===workspace,shutdownTimeoutMs:100,...options});
  t.after(async()=>{await app.close();if(!options.dataDirectory)rmSync(directory,{recursive:true,force:true});});
  return {app,calls,directory};
}
const startArgs=()=>({cwd:workspace,task:'Controlled native application task',members:[{name:'builder',brief:'Inspect fixture only.'}]});

test('the host application dispatches a worktree worker using its member name and persisted owned checkout',async t=>{
  const {mkdirSync,writeFileSync,readFileSync}=await import('node:fs');const {execFileSync}=await import('node:child_process');
  const root=mkdtempSync(join(tmpdir(),'hive-core-worktree-'));const repo=join(root,'repo');mkdirSync(repo);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe',windowsHide:true});
  git('init','-q');writeFileSync(join(repo,'value.txt'),'committed fixture');git('add','.');
  git('-c','user.name=Hive tests','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-qm','base');
  const calls=[];const app=createSwarmApplication({dataDirectory:join(root,'state'),host:'deepseek-harness',
    workspaceAllowed:()=>true,runner:{run:async request=>{calls.push(request);return {state:'done',message:'Checkout verified.',notify:[],waitFor:[]}},close:async()=>{}}});
  try{const team=await app.command('start_team',{cwd:repo,task:'Owned worktree',members:[{name:'builder',brief:'Inspect checkout',worktree:true}]});
    for(let i=0;i<500&&!calls.length;i++){if(app.board.get(team.id).members[0].status==='failed')break;await delay(10)}
    assert.equal(calls.length,1,app.board.get(team.id).events.at(-1).text);
    assert.equal(readFileSync(join(calls[0].member.workspace.cwd,'value.txt'),'utf8'),'committed fixture');
    assert.notEqual(calls[0].member.workspace.cwd,repo);
  }finally{await app.close();rmSync(root,{recursive:true,force:true})}
});

test('application reads never start models and workspace denial happens before admission',async t=>{
  const {app,calls}=fixture(t);
  assert.deepEqual(await app.snapshot(),{teams:[],team:null});
  assert.deepEqual((await app.command('list_models')).models.map(m=>m.id),['fixture/model']);
  await assert.rejects(app.command('start_team',{...startArgs(),cwd:tmpdir()}),/workspace|scope/i);
  assert.equal(calls.length,0);
});

test('one idempotent start creates one native team and one worker turn',async t=>{
  const {app,calls}=fixture(t);const args=startArgs();
  const [first,second]=await Promise.all([app.command('start_team',args,{requestId:'start-once'}),app.command('start_team',args,{requestId:'start-once'})]);
  assert.equal(first.id,second.id);await delay(5);
  assert.equal(calls.length,1);assert.equal(first.host,'deepseek-harness');
  assert.equal((await app.snapshot({teamId:first.id})).team.id,first.id);
  await assert.rejects(app.command('start_team',{...args,task:'A different task'},{requestId:'start-once'}),/identity|different|reuse/i);
});

test('worker commands are bound to their current team/member/turn and cannot read journals',async t=>{
  const {app}=fixture(t);
  const first=await app.command('start_team',startArgs());
  const second=await app.command('start_team',startArgs());await delay(5);
  const actor={teamId:first.id,member:'builder',turn:1};
  await assert.rejects(app.command('post_to_board',{teamId:second.id,text:'Cross-team spoof'},{actor}),/team|scope/i);
  await assert.rejects(app.command('read_journal',{teamId:first.id,member:'builder'},{actor}),/available|permission|journal/i);
  await assert.rejects(app.command('set_turn_outcome',{teamId:first.id,turn:2,state:'done',message:'Wrong turn'},{actor}),/turn/i);
  assert.deepEqual(await app.command('set_turn_outcome',{teamId:first.id,turn:1,state:'done',message:'Verified result',notify:[],waitFor:[]},{actor}),{accepted:true,turn:1});
  await app.command('post_to_board',{teamId:first.id,text:'Owned public update'},{actor});
  const snapshot=await app.snapshot({teamId:first.id});
  assert.equal(snapshot.team.events.at(-1).author,'builder');
});

test('persisted command replay cannot launch a duplicate after application restart',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'hive-command-'));
  let first,next;
  t.after(async()=>{await first?.app.close();await next?.app.close();rmSync(directory,{recursive:true,force:true});});
  first=fixture(t,{dataDirectory:directory});
  const created=await first.app.command('start_team',startArgs(),{requestId:'persisted-start'});await delay(5);
  await first.app.close();
  next=fixture(t,{dataDirectory:directory});
  const replay=await next.app.command('start_team',startArgs(),{requestId:'persisted-start'});await delay(5);
  assert.equal(replay.id,created.id);assert.equal(next.calls.length,0);
  assert.equal((await next.app.snapshot()).teams.length,1);
});

test('a worker cannot retire a peer it did not invite through the host command adapter',async t=>{
  const {app}=fixture(t);
  const team=await app.command('start_team',{...startArgs(),concurrency:2,members:[...startArgs().members,{name:'peer',brief:'Independent peer.'}]});
  await delay(5);
  await assert.rejects(app.command('retire_member',{teamId:team.id,member:'peer'},
    {actor:{teamId:team.id,member:'builder',turn:1}}),/invited|permission|helper|retire/i);
  const state=await app.snapshot({teamId:team.id});
  assert.notEqual(state.team.members.find(m=>m.name==='peer').status,'retired');
  assert.equal(state.team.members.find(m=>m.name==='peer').retireAfterTurn,undefined);
});

test('shutdown suspends dispatch beyond the forty-team catalog window',async t=>{
  const {app,calls}=fixture(t);
  for(let i=0;i<42;i++)await app.command('start_team',{...startArgs(),concurrency:1,
    members:[...startArgs().members,{name:'peer',brief:'Queued peer must not start during shutdown.'}]});
  await delay(5);assert.equal(calls.length,42);
  await app.close();await delay(5);
  assert.equal(calls.length,42);
});

test('native view waits receive live activity without a new post or model turn',async t=>{
  const {app,calls}=fixture(t);
  const team=await app.command('start_team',startArgs());await delay(5);
  const initial=(await app.snapshot({teamId:team.id})).team;
  const head=initial.events.at(-1).seq;
  const update=app.waitForUpdate({teamId:team.id,since:head,revision:initial.revision,timeoutSec:1});
  await delay(5);
  calls[0].onActivity({kind:'tool',label:'Inspect fixture',detail:'Started',time:new Date().toISOString()});
  const value=await update;
  assert.equal(value.head,head);
  assert.notEqual(value.revision,initial.revision);
  assert.equal(value.status.activity.builder.steps.at(-1).label,'Inspect fixture');
  assert.equal(calls.length,1);
});

test('start_team, add_member and set_member_model validate inherited effort and reset incompatible effort on model switch',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'hive-core-models-'));
  const runner={
    listModels:async()=>[
      {id:'fixture/heavy',label:'Heavy',efforts:['low','max'],defaultEffort:'max'},
      {id:'fixture/lite',label:'Lite',efforts:['low'],defaultEffort:'low'},
    ],
    run:async()=>({state:'done',message:'[done] Verified.',notify:[],waitFor:[]}),
    close:async()=>{},
  };
  const app=createSwarmApplication({dataDirectory:directory,host:'deepseek-harness',runner,workspaceAllowed:async cwd=>cwd===workspace});
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  await assert.rejects(app.command('start_team',{cwd:workspace,task:'Check effort validation',model:'fixture/heavy',effort:'max',
    members:[{name:'builder',brief:'Inspect',model:'fixture/lite'}]}),/effort/i);
  const created=await app.command('start_team',{cwd:workspace,task:'Check effort switch',model:'fixture/heavy',effort:'max',
    members:[{name:'builder',brief:'Inspect'}]});
  await delay(20);
  await assert.rejects(app.command('add_member',{teamId:created.id,member:{name:'helper',brief:'Check',model:'fixture/lite'}}),/effort/i);
  const switched=await app.command('set_member_model',{teamId:created.id,member:'builder',model:'fixture/lite'});
  assert.equal(switched.members[0].model,'fixture/lite');
  assert.equal(switched.members[0].effort,undefined);
});

test('resolve_recovery is owner-only and unblocks a member with an unconfirmed run',async t=>{
  const {app}=fixture(t);
  const team=await app.command('start_team',startArgs());await delay(10);
  const saved=app.board.get(team.id);
  saved.members[0].status='failed';
  saved.members[0].recoveryRequired=true;
  saved.members[0].pendingRun={turn:1,requestId:'stuck-1'};
  app.board.save(saved);
  await assert.rejects(app.command('resolve_recovery',{teamId:team.id,member:'builder',action:'dismiss'},
    {actor:{teamId:team.id,member:'builder',turn:1}}),/not available|running turn/i);
  const resolved=await app.command('resolve_recovery',{teamId:team.id,member:'builder',action:'dismiss'});
  assert.equal(resolved.members[0].recoveryRequired,false);
  assert.equal(resolved.members[0].status,'failed');
});

test('active workers can call list_models to verify host models without coordinator privileges',async t=>{
  const {app}=fixture(t);
  const team=await app.command('start_team',startArgs());await delay(10);
  const models=await app.command('list_models',{},{actor:{teamId:team.id,member:'builder',turn:1}});
  assert.equal(models.models[0].id,'fixture/model');
});
