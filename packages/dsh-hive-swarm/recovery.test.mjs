import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{setTimeout as delay}from'node:timers/promises';
import{TeamBoard}from'../../engine.mjs';import{RunStore}from'../../run-store.mjs';
import{createSwarmApplication}from'../../core.mjs';

const until=async fn=>{for(let i=0;i<1500;i++){if(fn())return;await delay(2)}throw Error('Recovery fixture did not reach the expected state')};
async function crashFixture(t,{storeFinished=true,running=false,inputPaused=false,pendingTurn=1}={}) {
  const root=mkdtempSync(join(tmpdir(),'hive-native-recovery-'));let board=new TeamBoard(join(root,'teams.sqlite'),()=>new Promise(()=>{}),{host:'deepseek-harness'});
  const team=board.create({cwd:root,task:'Crash gap fixture',members:[{name:'builder',brief:'Controlled work'},{name:'reviewer',brief:'Wait',waitFor:['builder']}]});
  await until(()=>board.get(team.id).members[0].status==='working');
  const pending=board.get(team.id);pending.members[0].threadId='owned';pending.members[0].pendingRun={turn:pendingTurn,requestId:'one'};board.save(pending);
  const store=new RunStore(join(root,'runs.sqlite'));const run=store.begin({teamId:team.id,member:'builder',turn:1,requestId:'one',sessionId:'owned',workspace:root});
  if(!inputPaused)store.setOutcome(run,{state:'done',message:'Durably completed fixture.',notify:[],waitFor:[]});
  if(storeFinished){store.patch(run,{acceptedSeq:1,claimSeq:3,turnEndSeq:4,hostIdle:true});store.finish(run)}
  board.close();store.close();let release;const calls=[];
  const records=[{seq:1,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[{id:'one',source:{kind:'user',rpcId:'one'}}]}},
    {seq:2,type:'turn/start',data:{turn:4}},{seq:3,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}},
    {seq:4,type:'turn/end',data:{turn:4,reason:{kind:'completed'}}}];
  if(inputPaused)records.pop();let active=running,blocked=inputPaused,inputSeen=false;
  const native={listModels:async()=>[],isCurrentAgent:agent=>agent?.current===true,create:async()=>{calls.push('create');throw Error('No re-prompt allowed')},
    prompt:async()=>{calls.push('prompt');throw Error('No re-prompt allowed')},
    state:async()=>({active,running:active,queue:[],pendingInput:blocked?[{kind:'permission'}]:[]}),
    currentTurn:()=>({lastTurn:4,openTurnStartSeq:2}),
    wait:async()=>{calls.push('wait');if(blocked&&!inputSeen){inputSeen=true;calls.push('input');return {reason:'input-required'}}
      await new Promise(r=>{release=r});active=false;blocked=false;
      if(inputPaused)records.push({seq:4,type:'turn/end',data:{turn:4,reason:{kind:'completed'}}});
      return {reason:'idle',state:{active:true,running:false,queue:[]}}},
    events:async()=>records,flush:async()=>{},cancel:async()=>{calls.push('cancel');release?.()},dispose:async()=>{}};
  const {createHost}=await import('./host.mjs');
  const tools=new Map();const ctx={connection:{fetch:{register:()=>async()=>{}}},workspaceRegistry:{list:()=>[{path:root}]},
    tools:{register:tool=>{tools.set(tool.name,tool);return()=>tools.delete(tool.name)}},skills:{register:()=>()=>{}}};
  const host=await createHost(ctx,{dataDirectory:root,coreFactory:createSwarmApplication,storeFactory:file=>new RunStore(file),nativeFactory:()=>native});
  t.after(async()=>{await host.close();rmSync(root,{recursive:true,force:true})});
  return {root,host,teamId:team.id,calls,tools,isWaiting:()=>Boolean(release),release:()=>release?.()};
}

test('restart closes the store-finished/scheduler-unfinished gap exactly once without a model call',async t=>{
  const f=await crashFixture(t);const team=f.host.application.board.get(f.teamId);
  assert.equal(team.paused,true);assert.equal(team.members[0].completed,1);
  assert.equal(team.members[1].status,'queued');assert.equal(team.events.filter(e=>e.text==='Durably completed fixture.').length,1);
  await f.host.runner.reconcile(f.host.application.board);
  assert.equal(f.host.application.board.get(f.teamId).members[0].completed,1);assert.deepEqual(f.calls,[]);
});

test('a live recovered prompt is observed to its terminal evidence without being sent again',async t=>{
  const f=await crashFixture(t,{storeFinished:false,running:true});
  await until(()=>f.calls.includes('wait'));assert.equal(f.host.application.board.get(f.teamId).members[0].recoveryRequired,true);
  f.release();await until(()=>f.host.application.board.get(f.teamId).members[0].completed===1);
  assert.equal(f.calls.includes('prompt'),false);assert.equal(f.calls.includes('create'),false);
});

test('a recovered permission pause can report and settle its original turn after approval',async t=>{
  const f=await crashFixture(t,{storeFinished:false,running:true,inputPaused:true});await until(()=>f.calls.includes('input'));
  assert.ok(f.host.runner.actorForSession('owned'),'A live recovery must retain its trusted actor');
  const exec={signal:new AbortController().signal,agent:{id:'owned',current:true},concludeTurn:()=>{exec.concluded=true}};
  const status=await f.tools.get('hive_swarm_board_status').execute({teamId:f.teamId},exec);assert.equal(status.id,f.teamId);
  await f.tools.get('hive_swarm_read_board').execute({teamId:f.teamId},exec);
  const post=await f.tools.get('hive_swarm_post_message').execute({teamId:f.teamId,text:'Recovered worker is checking its current instructions.'},exec);
  assert.equal(post.author,'builder');
  await assert.rejects(f.host.application.command('board_status',{teamId:f.teamId},
    {actor:{...f.host.runner.actorForSession('owned'),turn:99}}),/turn/i);
  const result=await f.tools.get('hive_swarm_set_turn_outcome').execute({turn:1,state:'done',message:'Approved original turn.',notify:[],waitFor:[]},exec);
  assert.equal(result.accepted,true);assert.equal(exec.concluded,true);
  await until(f.isWaiting);f.release();await until(()=>f.host.application.board.get(f.teamId).members[0].completed===1);
  const team=f.host.application.board.get(f.teamId);assert.equal(team.events.filter(event=>event.text==='Approved original turn.').length,1);
  assert.equal(f.calls.includes('prompt'),false);assert.equal(f.calls.includes('create'),false);
});

test('recovery refuses a pending turn identity that differs from its durable run',async t=>{
  const f=await crashFixture(t,{storeFinished:false,running:true,inputPaused:true,pendingTurn:2});
  assert.equal(f.host.runner.actorForSession('owned'),null);assert.deepEqual(f.calls,[]);
});
