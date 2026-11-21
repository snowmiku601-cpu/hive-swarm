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
  const f=await fixture(t);assert.equal(f.routes.size,4);assert.equal(f.calls.length,0);
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

test('host injects subagents, forwards trusted parentSessionId only from parent owner, and exposes nullable fork schema',async t=>{
  const {createHost,inject}=await import('./host.mjs');
  assert.equal(inject.includes('subagents'),true);
  const root=mkdtempSync(join(tmpdir(),'hive-host-contract-'));
  const seen=[];const tools=new Map();
  const fakeApp={snapshot:async()=>({teams:[],team:null}),close:async()=>({quiescent:true}),
    board:{db:{prepare:()=>({all:()=>[]})},get:()=>({members:[{name:'builder',role:'worker'}]})},
    command:async(action,cmdArgs,context)=>{seen.push({action,cmdArgs,context});return {id:'78963630-4947-4a29-93cb-959632ec9471',host:'deepseek-harness',members:cmdArgs.members??[]};}};
  const native={listModels:async()=>[],create:async()=>'w',prepare:async()=>{},prompt:async()=>{},wait:async()=>({reason:'idle'}),
    currentTurn:()=>({}),events:async()=>[],flush:async()=>{},cancel:async()=>{},dispose:async()=>{},isCurrentAgent:agent=>agent?.current===true};
  const ctx={connection:{fetch:{register:()=>async()=>{}}},workspaceRegistry:{list:()=>[{id:'w',path:root}]},
    skills:{register:()=>()=>{}},tools:{register:(tool,options)=>{tools.set(tool.name,{tool,options});return()=>tools.delete(tool.name)}}};
  const host=await createHost(ctx,{dataDirectory:join(root,'state'),coreFactory:()=>fakeApp,storeFactory:file=>new RunStore(file),nativeFactory:()=>native});
  t.after(async()=>{await host.close();rmSync(root,{recursive:true,force:true});});

  const startTool=tools.get('hive_swarm_start_team').tool;
  const addTool=tools.get('hive_swarm_add_member').tool;
  assert.deepEqual(startTool.parameters.properties.members.items.properties.fork.type,['string','null']);
  assert.deepEqual(addTool.parameters.properties.member.properties.fork.type,['string','null']);
  assert.equal(Object.hasOwn(startTool.parameters.properties,'parentSessionId'),false);

  const exec={signal:new AbortController().signal,agent:{id:'parent-chat-1',current:true,session:{header:{cwd:root}}},callId:'call-1'};
  await assert.rejects(startTool.execute({...args(root),parentSessionId:'spoofed-parent'},exec),/invalid command fields|identity/i);
  await startTool.execute({cwd:root,task:'Fork parent context',members:[
    {name:'lead_check',brief:'Check coordinator context',fork:'coordinator'},
    {name:'fresh',brief:'Fresh worker',fork:null},
    {name:'empty_fork',brief:'Empty fork omitted',fork:''},
  ]},exec);
  assert.equal(seen.length,1);
  assert.equal(seen[0].context.parentSessionId,'parent-chat-1');
  assert.equal(seen[0].cmdArgs.members[0].fork,'coordinator');
  assert.equal(Object.hasOwn(seen[0].cmdArgs.members[1],'fork'),false);
  assert.equal(Object.hasOwn(seen[0].cmdArgs.members[2],'fork'),false);

  await addTool.execute({teamId:'t1',member:{name:'helper',brief:'Check parent',fork:'coordinator'},fork:'coordinator'},exec);
  assert.equal(seen[1].context.parentSessionId,undefined);
  assert.equal(seen[1].cmdArgs.fork,'coordinator');
  assert.equal(seen[1].cmdArgs.member.fork,'coordinator');
});

test('host executes native subagent activation end-to-end when ctx.subagents is provided',async t=>{
  const {createHost}=await import('./host.mjs');
  const root=mkdtempSync(join(tmpdir(),'hive-host-subagent-'));
  const tools=new Map(),listeners=new Map(),events=[];
  let mode='read-only',seq=1,childAgent,childSession,restrictions=[],guards=[],subagentPrompt,releaseIdle;
  const parentSession={id:'parent-chat',header:{cwd:root,delegationDepth:0},append:()=>{}};
  const parentAgent={id:'parent-chat',current:true,session:parentSession,options:{subagentDepth:0}};
  const agents=new Map([['parent-chat',parentAgent]]);
  const sessions=new Map([['parent-chat',parentSession]]);
  const emit=(topic,info)=>{for(const fn of listeners.get(topic)??[])fn(info);};
  const ctx={
    connection:{createPeer:()=>({principal:{kind:'owner'},dispose:async()=>{}}),fetch:{register:()=>async()=>{}}},
    typertGateway:{invoke:async({namespace,method,args:req})=>{
      if(method==='modelCatalog')return {default:{provider:'p',model:'m'},groups:[{id:'p',models:[{id:'m',name:'M',reasoning:{efforts:[{id:'max'}],defaultEffort:'max'}}]}]};
      if(namespace==='session'&&method==='events'){
        assert.deepEqual(req.request.address,{kind:'subagent',parentSessionId:'parent-chat',childSessionId:childAgent.id,mode:'continuable'});
        return {cursor:seq,records:events.map(event=>({type:'event',event})),hasMore:false};
      }
      if(namespace==='session'&&method==='state')return {active:false,running:false,queue:[],pendingInput:[]};
      if(namespace==='session'&&method==='wait'){await new Promise(resolve=>{releaseIdle=resolve;});return {reason:'idle',state:{running:false,active:true,queue:[],pendingInput:[]}};}
      return {accepted:true};
    }},
    sessions:{get:id=>sessions.get(id),flush:async()=>true},
    agents:{get:id=>agents.get(id),turnBoundaryOf:()=>({lastTurn:2,openTurnStartSeq:2})},
    sandboxPolicy:{resolve:()=>({mode,workspaceRoot:root})},
    fs:{sandboxMode:'read-only'},shell:{sandboxMode:'read-only'},
    workspaceRegistry:{list:()=>[{id:'w',path:root}]},
    skills:{register:()=>()=>{}},
    tools:{
      definitions:()=>['read','write','bash','subagent','hive_swarm_post_message','hive_swarm_set_turn_outcome','hive_swarm_start_team'].map(name=>({name})),
      register:(tool,options)=>{tools.set(tool.name,{tool,options});return()=>tools.delete(tool.name);},
    },
    on:(topic,fn)=>{const set=listeners.get(topic)??new Set();set.add(fn);listeners.set(topic,set);return()=>set.delete(fn);},
    subagents:{
      startActivation:async spec=>{
        assert.equal(spec.provider,'spawn');assert.equal(spec.delivery,'caller');assert.equal(spec.maxDepth,1);
        subagentPrompt=spec.prompt[0].text;
        childSession={id:spec.childId,header:{cwd:root,origin:'subagent',parentSession:'parent-chat'},append:(type,data)=>{if(type==='sandbox/mode')mode=data.mode;}};
        childAgent={id:spec.childId,current:true,session:childSession,
          ctx:{tools:{definitions:()=>ctx.tools.definitions(),restrict:f=>{restrictions.push(f);return()=>{};},guard:fn=>{guards.push(fn);return()=>{};}}},
          model:{select:()=>{}},whenIdle:async()=>{}};
        agents.set(spec.childId,childAgent);sessions.set(spec.childId,childSession);
        emit('subagent/start',{id:spec.childId,parentSessionId:'parent-chat',provider:'spawn'});
        events.push(
          {seq:seq++,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[{id:'msg-1',source:{kind:'user'}}]}},
          {seq:seq++,type:'turn/start',data:{turn:2}},
          {seq:seq++,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}},
          {seq:seq++,type:'request/header',data:{header:{config:{provider:'p',model:'m',reasoningEffort:'max'}}}},
        );
        return {childId:spec.childId,name:spec.name,messageId:'msg-1',result:Promise.resolve({status:'completed'}),dispose:async()=>{}};
      },
    },
  };
  const compatCoreFactory=options=>{
    const app=createSwarmApplication(options);
    const origCreate=app.board.create.bind(app.board);
    let nextParentId;
    app.board.create=(input,wsSource,opts)=>{
      const p=opts?.parentSessionId??nextParentId;
      const team=origCreate(input,wsSource,opts);
      if(p&&!team.parentSessionId){team.parentSessionId=p;app.board.save(team);}
      return team;
    };
    const origCmd=app.command.bind(app);
    return {...app,command:async(action,cmdArgs,context={})=>{
      nextParentId=action==='start_team'?context.parentSessionId:undefined;
      try{return await origCmd(action,cmdArgs,context);}finally{nextParentId=undefined;}
    }};
  };
  const host=await createHost(ctx,{dataDirectory:join(root,'state'),coreFactory:compatCoreFactory,storeFactory:file=>new RunStore(file)});
  t.after(async()=>{await host.close();rmSync(root,{recursive:true,force:true});});

  const parentExec={signal:new AbortController().signal,agent:parentAgent};
  const team=await tools.get('hive_swarm_start_team').tool.execute(args(root),parentExec);
  for(let i=0;i<200&&!host.runner.actorForSession(childAgent?.id);i++)await delay(5);
  assert.ok(childAgent,'subagent activation should have started');
  assert.match(subagentPrompt,/Goal: Owned native smoke/);
  assert.equal(tools.get('hive_swarm_start_team').options.when({agent:childAgent}),false);
  assert.equal(tools.get('hive_swarm_set_turn_outcome').options.when({agent:childAgent}),true);
  assert.equal(restrictions[0].allow.includes('subagent'),false);
  assert.equal(restrictions[0].allow.includes('write'),false);

  const workerExec={signal:new AbortController().signal,agent:childAgent,concludeTurn:()=>{workerExec.concluded=true;}};
  const res=await tools.get('hive_swarm_set_turn_outcome').tool.execute({turn:1,state:'done',message:'[done] Subagent finished',notify:[],waitFor:[]},workerExec);
  assert.equal(res.accepted,true);assert.equal(workerExec.concluded,true);
  events.push({seq:seq++,type:'turn/end',data:{turn:2,reason:{kind:'completed'}}});
  for(let i=0;i<200&&!releaseIdle;i++)await delay(5);
  releaseIdle();
  for(let i=0;i<200&&host.application.board.get(team.id).members[0].status==='working';i++)await delay(5);
  const finalMember=host.application.board.get(team.id).members[0];
  assert.equal(finalMember.status,'done');
  assert.equal(finalMember.executionMode,'subagent');
  assert.match(finalMember.subagentName,/^builder-/);
});

test('B2 & 2.1.0 strict schema: drive-letter case match, goalLine, taskLabel, and strict-mode tasks [{member,label}]',async t=>{
  const {same}=await import('./host.mjs');
  const existingPath=process.cwd();
  const flipDrive=value=>value.replace(/^[A-Za-z]:/,d=>d===d.toUpperCase()?d.toLowerCase():d.toUpperCase());
  if(process.platform==='win32') {
    assert.equal(same(existingPath,flipDrive(existingPath),'win32'),true);
  }

  const f=await fixture(t);
  const startTool=f.tools.get('hive_swarm_start_team').tool;
  const planTool=f.tools.get('hive_swarm_set_team_plan').tool;
  const addTool=f.tools.get('hive_swarm_add_member').tool;

  // Strict schema verification for 2.1.0 fields
  assert.deepEqual(startTool.parameters.properties.goalLine,{type:['string','null']});
  assert.deepEqual(startTool.parameters.properties.members.items.properties.taskLabel.type,['string','null']);
  assert.deepEqual(addTool.parameters.properties.member.properties.taskLabel.type,['string','null']);
  assert.deepEqual(planTool.parameters.properties.goalLine,{type:['string','null']});
  assert.equal(planTool.parameters.properties.tasks.items.additionalProperties,false);
  assert.deepEqual(planTool.parameters.properties.tasks.items.required,['member','label']);
  assert.equal(planTool.parameters.required,undefined);

  const cwdInput=process.platform==='win32'?flipDrive(f.root):f.root;
  const exec={signal:new AbortController().signal,agent:{id:'parent',current:true,session:{header:{cwd:cwdInput}}}};
  const created=await startTool.execute({
    cwd:f.root,task:'2.1.0 strict test',title:'Strict 2.1.0',goalLine:'Ship DSH 2.1.0 cleanly',
    coordinator:false,model:'p/m',effort:'max',fallbackModel:null,fallbackEffort:null,
    concurrency:2,turnLimit:12,threads:null,
    members:[{
      name:'builder',brief:'Build backend',taskLabel:'Backend fixes',group:null,model:'p/m',effort:'max',
      fallbackModel:null,fallbackEffort:null,writable:true,worktree:false,waitFor:[],channels:[],n:null,tasks:null,fork:null,
    }],
  },exec);
  assert.equal(created.goalLine,'Ship DSH 2.1.0 cleanly');
  assert.equal(created.members[0].taskLabel,'Backend fixes');

  // Strict-mode nulls preserve existing goalLine & taskLabel when updating only threads.
  const threadsOnly=await planTool.execute({
    teamId:created.id,goalLine:null,tasks:null,
    threads:[{id:'core',title:'Core',goal:'Fix bugs',members:['builder']}],
  },exec);
  assert.equal(threadsOnly.goalLine,'Ship DSH 2.1.0 cleanly');
  assert.equal(threadsOnly.members[0].taskLabel,'Backend fixes');
  assert.equal(threadsOnly.threads.length,1);

  // Update via strict-mode tasks array [{member, label}] and clear via label: null / goalLine: ''.
  const renamedTasks=await planTool.execute({
    teamId:created.id,goalLine:'Updated goal line',
    tasks:[{member:'builder',label:'Updated task label'}],threads:null,
  },exec);
  assert.equal(renamedTasks.goalLine,'Updated goal line');
  assert.equal(renamedTasks.members[0].taskLabel,'Updated task label');

  const cleared=await planTool.execute({
    teamId:created.id,goalLine:'',
    tasks:[{member:'builder',label:null}],threads:null,
  },exec);
  assert.equal(Object.hasOwn(cleared,'goalLine'),false);
  assert.equal(Object.hasOwn(cleared.members[0],'taskLabel'),false);
});
