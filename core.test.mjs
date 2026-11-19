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
