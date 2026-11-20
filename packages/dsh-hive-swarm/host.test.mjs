import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createSwarmApplication} from '../../core.mjs';import {RunStore} from '../../run-store.mjs';
import {setTimeout as delay} from 'node:timers/promises';

async function fixture(t,{shutdownTimeoutMs}={}) {
  const {createHost}=await import('./host.mjs');const root=mkdtempSync(join(tmpdir(),'hive-native-host-'));
  const routes=new Map(),tools=new Map(),skills=new Map();let rpc;const calls=[],events=[];
  const native={listModels:async()=>[{id:'p/m',provider:'p',model:'m',default:true,efforts:['max']}],
    create:async()=>{calls.push('create');return 'worker-session'},prepare:async()=>{},
    prompt:async request=>{calls.push('prompt');events.push(
      {seq:1,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[{source:{kind:'user',rpcId:request.requestId}}]}},
      {seq:2,type:'turn/start',data:{turn:4}},
      {seq:3,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}});return {accepted:true}},
    wait:async(id,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})),
    currentTurn:()=>({lastTurn:4,openTurnStartSeq:2}),
    events:async()=>events,flush:async()=>{},cancel:async()=>{calls.push('cancel')},dispose:async()=>{},isCurrentAgent:agent=>agent?.current===true};
  const ctx={connection:{fetch:{register:r=>{routes.set(r.path,r);return async()=>routes.delete(r.path)}},
    rpc:{handle:(_path,handler)=>{rpc=handler;return async()=>{rpc=null}}}},
    workspaceRegistry:{list:()=>[{id:'workspace',path:root}]},
    skills:{register:skill=>{skills.set(skill.name,skill);return()=>skills.delete(skill.name)}},
    tools:{register:(tool,options)=>{tools.set(tool.name,{tool,options});return()=>tools.delete(tool.name)}}};
  const host=await createHost(ctx,{dataDirectory:join(root,'state'),coreFactory:options=>createSwarmApplication({...options,...shutdownTimeoutMs==null?{}:{shutdownTimeoutMs}}),storeFactory:file=>new RunStore(file),nativeFactory:()=>native});
  t.after(async()=>{await host.close();rmSync(root,{recursive:true,force:true})});
  return {root,host,tools,skills,routes,calls,native,rpc:(...args)=>rpc(...args)};
}
const args=cwd=>({cwd,task:'Owned native smoke',model:'p/m',effort:'max',members:[{name:'builder',brief:'Inspect owned fixture'}]});

test('default native storage belongs to the host-supplied profile and cannot guess a shared home',async()=>{
  const {resolveDataDirectory}=await import('./host.mjs');
  assert.throws(()=>resolveDataDirectory({}),/profile/i);
  const one=resolveDataDirectory({profileContext:{dir:join(tmpdir(),'profile-one')}});
  const two=resolveDataDirectory({profileContext:{dir:join(tmpdir(),'profile-two')}});
  assert.notEqual(one,two);assert.equal(one,join(tmpdir(),'profile-one','.hive-swarm'));
});

test('native Host activation registers routes and prefixed tools without creating sessions',async t=>{
  const f=await fixture(t);assert.equal(f.routes.size,3);assert.equal(f.calls.length,0);
  assert.equal(f.skills.get('hive-swarm')?.invocation.userInvocable,true);
  assert.match(f.skills.get('hive-swarm').content,/hive_swarm_start_team/);
  assert.doesNotMatch(f.skills.get('hive-swarm').content,/open_in_codex|codex:\/\//);
  for(const name of ['hive_swarm_start_team','hive_swarm_board_status','hive_swarm_post_message','hive_swarm_pause_team','hive_swarm_set_turn_outcome'])assert.ok(f.tools.has(name));
  assert.deepEqual(await f.host.application.snapshot(),{teams:[],team:null});assert.equal(f.calls.length,0);
  await f.host.close();assert.equal(f.routes.size,0);assert.equal(f.tools.size,0);assert.equal(f.skills.size,0);
});

test('parent native tool workspace comes from trusted execution, while malformed identities cannot reach core',async t=>{
  const f=await fixture(t);const entry=f.tools.get('hive_swarm_start_team');
  const exec={signal:new AbortController().signal,agent:{id:'parent',current:true,session:{header:{cwd:f.root}}}};
  const team=await entry.tool.execute(args(f.root),exec);assert.equal(team.host,'deepseek-harness');
  await assert.rejects(entry.tool.execute(args(tmpdir()),exec),/workspace|scope/i);
  await assert.rejects(entry.tool.execute({...args(f.root),actor:{member:'owner'}},exec),/identity|fields/i);
  await delay(10);assert.equal(f.calls.filter(x=>x==='prompt').length,1);
});

test('scoped outcome uses the real worker execution and cannot impersonate a different member',async t=>{
  const f=await fixture(t);const team=await f.host.application.command('start_team',args(f.root));await delay(10);
  const entry=f.tools.get('hive_swarm_set_turn_outcome');const exec={signal:new AbortController().signal,agent:{id:'worker-session',current:true},concludeTurn:()=>{exec.concluded=true}};
  const report={turn:1,state:'done',message:'Controlled result',notify:[],waitFor:[]};
  await assert.rejects(entry.tool.execute({...report,member:'foreign'},exec),/fields|identity/i);
  await assert.rejects(entry.tool.execute({...report,state:'failed'},exec),/outcome|state/i);
  assert.equal(f.host.store.findSession('worker-session').outcome,null);assert.equal(exec.concluded,undefined);
  const result=await entry.tool.execute(report,exec);assert.ok(result);assert.equal(exec.concluded,true);
  assert.equal(f.host.store.findSession('worker-session').outcome.message,'Controlled result');
  assert.equal(f.host.application.board.get(team.id).members[0].status,'working');
});

test('only successful owned start/open results project durable exact-team native navigation',async t=>{
  const f=await fixture(t);const exec={signal:new AbortController().signal,agent:{id:'parent',current:true,session:{header:{cwd:f.root}}}};
  const start=f.tools.get('hive_swarm_start_team').tool;const team=await start.execute(args(f.root),exec);
  assert.deepEqual(start.output.presentationMeta({},team),{navigation:{kind:'hive-swarm',teamId:team.id}});
  const open=f.tools.get('hive_swarm_open_swarm_panel').tool;
  const value=await open.execute({teamId:team.id},exec);
  assert.deepEqual(open.output.presentationMeta({},value),{navigation:{kind:'hive-swarm',teamId:team.id}});
  assert.equal(open.output.presentationMeta({},{...value,host:'codex'}),null);
  assert.equal(open.output.presentationMeta({},{host:'deepseek-harness',navigation:{kind:'hive-swarm',teamId:'foreign'}}),null);
});

test('a bounded Host close retains the evidence store until cancellation is quiescent',async t=>{
  const f=await fixture(t,{shutdownTimeoutMs:10});let finishCancel,closed=0,disposed=false;
  const original=f.host.store.close.bind(f.host.store);f.host.store.close=()=>{closed++;original()};
  f.native.cancel=async()=>{await new Promise(resolve=>{finishCancel=resolve})};f.native.dispose=async()=>{disposed=true};
  await f.host.application.command('start_team',args(f.root));await delay(10);
  const result=await f.host.close();assert.equal(result.quiescent,false);
  try{assert.equal(closed,0,'An unresolved cancellation must retain durable evidence handles');assert.equal(disposed,false);}
  finally{finishCancel?.();for(let i=0;i<500&&!disposed;i++)await delay(2);}
  assert.equal(disposed,true);assert.equal(closed,1);
});
