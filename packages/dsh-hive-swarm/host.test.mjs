import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
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

test('stale missing workspace entries do not block valid registered workspaces',async t=>{
  const f=await fixture(t);
  const {createHost}=await import('./host.mjs');
  const root=f.root;
  const routes=new Map();
  const host=await createHost({
    connection:{fetch:{register:r=>{routes.set(r.path,r);return async()=>routes.delete(r.path)}}},
    workspaceRegistry:{list:()=>[{id:'missing',path:join(root,'deleted-workspace-does-not-exist')},{id:'valid',path:root}]},
    skills:{register:()=>()=>{}},tools:{register:()=>()=>{}},
  },{dataDirectory:join(root,'state-stale'),coreFactory:createSwarmApplication,storeFactory:file=>new RunStore(file),nativeFactory:()=>f.native});
  try{
    const created=await host.application.command('start_team',args(root));
    assert.equal(created.cwd,realpathSync(root));
  }finally{await host.close();}
});

test('worker tool visibility hides owner-only tools and effort schema accepts null',async t=>{
  const f=await fixture(t);
  await f.host.application.command('start_team',args(f.root));await delay(10);
  const workerAgent={id:'worker-session',current:true};
  const ownerAgent={id:'parent-session',current:true};
  assert.equal(f.tools.get('hive_swarm_start_team').options.when({agent:ownerAgent}),true);
  assert.equal(f.tools.get('hive_swarm_start_team').options.when({agent:workerAgent}),false);
  assert.equal(f.tools.get('hive_swarm_pause_team').options.when({agent:workerAgent}),false);
  assert.equal(f.tools.get('hive_swarm_resolve_recovery').options.when({agent:workerAgent}),false);
  assert.equal(f.tools.get('hive_swarm_post_message').options.when({agent:workerAgent}),true);
  assert.equal(f.tools.get('hive_swarm_list_models').options.when({agent:workerAgent}),true);
  assert.equal(f.tools.get('hive_swarm_set_turn_outcome').options.when({agent:workerAgent}),true);
  assert.deepEqual(f.tools.get('hive_swarm_set_member_model').tool.parameters.properties.effort,{type:['string','null']});
  assert.ok(f.tools.get('hive_swarm_start_team').tool.parameters.properties.members.items.properties?.name);
  assert.match(f.tools.get('hive_swarm_start_team').tool.parameters.properties.members.items.properties.tasks.description,/sharding|parallel worker/i);
  assert.deepEqual(f.tools.get('hive_swarm_read_board').tool.parameters.properties.limit,{type:['integer','null'],minimum:1,maximum:20});
  assert.deepEqual(f.tools.get('hive_swarm_board_history').tool.parameters.properties.limit,{type:['integer','null'],minimum:1,maximum:200});
  assert.deepEqual(f.tools.get('hive_swarm_wait_for_board').tool.parameters.properties.timeoutSec,{type:['integer','null'],minimum:1,maximum:55});
  for(const [toolName,{tool}] of f.tools) {
    const schema=tool.parameters;
    assert.equal(schema.type,'object',toolName+' parameters must be a JSON Schema object');
    assert.equal(typeof schema.properties,'object',toolName+' parameters must declare properties');
    assert.equal(schema.additionalProperties,false,toolName+' parameters should forbid unknown fields');
    assert.equal(schema.title,undefined,toolName+' must not put parameter fields at top-level JSON Schema root');
    for(const req of schema.required??[])assert.ok(Object.hasOwn(schema.properties,req),toolName+' required key '+req+' must exist in properties');
    for(const [prop,def] of Object.entries(schema.properties)) {
      assert.ok(typeof def.type==='string'||Array.isArray(def.type),toolName+'.'+prop+' must have a valid JSON Schema type');
      if(def.type==='array'||(Array.isArray(def.type)&&def.type.includes('array')))assert.ok(def.items&&typeof def.items==='object',toolName+'.'+prop+' array must declare items');
    }
  }
  assert.deepEqual(f.tools.get('hive_swarm_set_team_title').tool.parameters,{
    type:'object',properties:{teamId:{type:['string','null']},title:{type:'string'}},required:['title'],additionalProperties:false,
  });
});

test('strict-mode null and empty optional fields normalize cleanly without breaking sharding or model lock',async t=>{
  const f=await fixture(t);
  const exec={signal:new AbortController().signal,agent:{id:'parent',current:true,session:{header:{cwd:f.root}}}};
  const created=await f.tools.get('hive_swarm_start_team').tool.execute({
    cwd:f.root,task:'Strict schema check',title:'Strict test',coordinator:false,model:'p/m',effort:'max',
    fallbackModel:null,fallbackEffort:null,concurrency:2,turnLimit:12,threads:null,
    members:[{
      name:'design',brief:'Inspect layout',group:null,model:'p/m',effort:'max',fallbackModel:'',fallbackEffort:null,
      writable:false,worktree:false,waitFor:[],channels:[],n:null,tasks:null,
    }],
  },exec);
  assert.equal(created.members.length,1);
  assert.equal(created.members[0].name,'design');
  assert.equal(created.fallbackModel,undefined);
  assert.equal(created.members[0].fallbackModel,undefined);
  assert.equal(created.members[0].fallbackEffort,undefined);
  const posts=await f.tools.get('hive_swarm_read_board').tool.execute({teamId:created.id,after:null,limit:null,channel:null,mentionsOnly:null},exec);
  assert.ok(Array.isArray(posts.posts));
});

test('all native tool outputs are strictly lossless JSON with no undefined properties',async t=>{
  const f=await fixture(t);
  f.native.listModels=async()=>[{id:'p/m',provider:'p',model:'m',label:'P · M',efforts:['max'],defaultEffort:undefined,default:true}];
  const exec={signal:new AbortController().signal,agent:{id:'parent',current:true,session:{header:{cwd:f.root}}}};
  const assertLossless=(value,path='root')=>{
    assert.notEqual(value,undefined,path+' must not be undefined');
    if(typeof value==='number')assert.ok(Number.isFinite(value)&&!Object.is(value,-0),path+' must be lossless number');
    if(Array.isArray(value)){value.forEach((item,i)=>assertLossless(item,`${path}[${i}]`));return;}
    if(value&&typeof value==='object'){
      for(const [k,v] of Object.entries(value)){
        assert.notEqual(v,undefined,`${path}.${k} must not have undefined value`);
        assertLossless(v,`${path}.${k}`);
      }
    }
  };
  const models=await f.tools.get('hive_swarm_list_models').tool.execute({},exec);
  assertLossless(models,'list_models');
  assert.equal(Object.hasOwn(models.models[0],'defaultEffort'),false);
  f.native.sessionRoute=async agent=>({sessionId:agent.id,cwd:agent.session?.header?.cwd,model:'p/m',effort:undefined});
  const modelsWithRoute=await f.tools.get('hive_swarm_list_models').tool.execute({},exec);
  assertLossless(modelsWithRoute,'list_models_route');
  assert.deepEqual(modelsWithRoute.currentSession,{sessionId:'parent',cwd:f.root,model:'p/m'});
  const team=await f.tools.get('hive_swarm_start_team').tool.execute(args(f.root),exec);
  assertLossless(team,'start_team');
  const status=await f.tools.get('hive_swarm_board_status').tool.execute({teamId:team.id},exec);
  assertLossless(status,'board_status');
  const panel=await f.tools.get('hive_swarm_open_swarm_panel').tool.execute({teamId:team.id},exec);
  assertLossless(panel,'open_swarm_panel');
});
