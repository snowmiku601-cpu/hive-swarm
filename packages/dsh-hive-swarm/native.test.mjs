import test from 'node:test';
import assert from 'node:assert/strict';

async function fixture() {
  const {createNativeAccess}=await import('./native.mjs');let mode='read-only';const calls=[],restrictions=[],guards=[];
  const session={id:'owned',header:{cwd:process.cwd()},append:(type,data)=>{calls.push({type,data});if(type==='sandbox/mode')mode=data.mode}};
  const agent={id:'owned',session,ctx:{tools:{restrict:filter=>{restrictions.push(filter);return()=>{}},
    definitions:()=>ctx.tools.definitions(),guard:fn=>{guards.push(fn);return()=>{}}}},
    model:{select:value=>calls.push({kind:'selection',value})},whenIdle:async()=>{},cancel:async()=>{}};
  const peer={principal:{kind:'owner'},dispose:async()=>{}};
  const ctx={connection:{createPeer:()=>peer},typertGateway:{invoke:async request=>{calls.push(request);
    if(request.method==='create')return {sessionId:'owned'};
    if(request.method==='modelCatalog')return {default:{provider:'p',model:'m'},groups:[{id:'p',models:[{id:'m',name:'Model',reasoning:{efforts:[{id:'max'}]}}]}]};
    if(request.method==='events')return {cursor:2,records:[{type:'event',event:{seq:1,type:'turn/end',data:{turn:1}}}],hasMore:false};
    return {accepted:true};}},agents:{get:id=>id==='owned'?agent:undefined},sessions:{get:()=>session,flush:async()=>true},
    sandboxPolicy:{resolve:()=>({mode,workspaceRoot:process.cwd()})},fs:{sandboxMode:'read-only'},shell:{sandboxMode:'read-only'},
    tools:{definitions:()=>['read','write','apply_patch','bash','pwsh','unrelated_admin'].map(name=>({name}))}};
  const native=createNativeAccess(ctx,{ownsSession:id=>id==='owned'});return {ctx,native,calls,restrictions,guards,agent,session,peer};
}
test('native Gateway calls carry a host-minted Peer and catalog retains exact provider/model identities',async()=>{
  const f=await fixture();const models=await f.native.listModels();assert.equal(models[0].id,'p/m');
  assert.deepEqual(models[0].efforts,['max']);assert.equal(models[0].default,true);
  assert.equal(await f.native.create({cwd:process.cwd()}),'owned');
  const call=f.calls.find(x=>x.method==='create');assert.equal(call.namespace,'session');assert.equal(call.peer,f.peer);
  assert.deepEqual(call.args,{request:{cwd:process.cwd()}});
});
test('permission and model preparation are session-local and restrict unrelated host capabilities',async()=>{
  const f=await fixture();await f.native.prepare('owned',{cwd:process.cwd(),writable:false,model:{provider:'p',model:'m'},effort:'max'});
  assert.equal(f.calls.some(x=>x.method==='selectModel'),false);
  assert.deepEqual(f.calls.find(x=>x.kind==='selection').value,{provider:'p',model:'m',reasoningEffort:'max'});
  assert.ok(f.restrictions[0].allow.includes('read'));assert.equal(f.restrictions[0].allow.includes('write'),false);
  assert.equal(f.restrictions[0].allow.includes('unrelated_admin'),false);
  f.ctx.fs.sandboxMode=undefined;await assert.rejects(f.native.prepare('owned',{cwd:process.cwd(),model:{},writable:true}),/sandbox/);
});
test('foreign sessions and broadened writable roots are refused before session control',async()=>{
  const f=await fixture();await assert.rejects(f.native.cancel('foreign'),/owned/);
  f.ctx.sandboxPolicy.resolve=()=>({mode:'workspace-write',workspaceRoot:process.cwd(),additionalWritableRoots:['C:/outside']});
  await assert.rejects(f.native.prepare('owned',{cwd:process.cwd(),writable:true,model:{}}),/scope|root/i);
  assert.equal(f.calls.some(x=>x.kind==='selection'),false);
});
test('native event reads are passive and missing durability participation cannot prove completion',async()=>{
  const f=await fixture();assert.equal((await f.native.events('owned'))[0].seq,1);
  assert.equal(f.calls.at(-1).method,'events');assert.equal(f.calls.at(-1).args.request.address.kind,'session');
  f.ctx.sessions.flush=async()=>false;await assert.rejects(f.native.flush('owned'),/durab|persist/i);
});

test('an isolated Agent preset cannot borrow enforcement facts from the secure Host realm',async()=>{
  const f=await fixture();f.ctx.agentPresets={composedPreset:()=> 'unconfined-preset',serviceFor:()=>undefined};
  await assert.rejects(f.native.prepare('owned',{cwd:process.cwd(),writable:false,model:{provider:'p',model:'m'}}),/preset|sandbox/i);
  assert.equal(f.calls.some(x=>x.kind==='selection'),false);
});

test('a last-mile worker guard denies unreviewed scope-local capabilities exempt from inherited restrictions',async()=>{
  const f=await fixture();await f.native.prepare('owned',{cwd:process.cwd(),writable:false,model:{provider:'p',model:'m'}});
  assert.equal(f.guards.length,1);assert.ok(f.guards[0]({name:'unrelated_admin'}));
  assert.equal(f.guards[0]({name:'read'}),undefined);
});

test('recovery may verify a cold stored session without resuming its Agent or requiring a live flush',async()=>{
  const f=await fixture();f.ctx.sessions.get=()=>undefined;
  f.ctx.typertGateway.invoke=async request=>{f.calls.push(request);assert.equal(request.method,'state');return {active:false,running:false,queue:null}};
  await f.native.flush('owned');assert.equal(f.calls.at(-1).method,'state');
  assert.equal(f.calls.some(call=>call.method==='prompt'||call.method==='create'),false);
});

test('the Host declares every service used to prepare a worker in an injection-enforcing Context',async()=>{
  const f=await fixture();const {inject}=await import('./host.mjs');const {createNativeAccess}=await import('./native.mjs');
  const declared=new Set(inject);
  const ctx=new Proxy(f.ctx,{get(target,key){
    if(typeof key==='string'&&!declared.has(key))throw Error('cannot get property '+key+' without inject');
    return Reflect.get(target,key);
  }});
  const native=createNativeAccess(ctx,{ownsSession:id=>id==='owned'});
  await native.prepare('owned',{cwd:process.cwd(),writable:false,model:{provider:'p',model:'m'}});
  assert.equal(f.calls.some(call=>call.kind==='selection'),true);
  await native.dispose();
});

test('a preset may use an enforcing service inherited by its actual Agent context',async()=>{
  const f=await fixture();f.ctx.agentPresets={composedPreset:()=> 'standard',serviceFor:()=>undefined};
  f.agent.ctx.get=name=>f.ctx[name];
  await f.native.prepare('owned',{cwd:process.cwd(),writable:false,model:{provider:'p',model:'m'}});
  assert.equal(f.calls.some(call=>call.kind==='selection'),true);
});

test('a preset-local unconfined service cannot be replaced with a secure inherited service',async()=>{
  const f=await fixture();f.ctx.agentPresets={composedPreset:()=> 'private-unconfined',
    serviceFor:(_agent,name)=>name==='fs'?{sandboxMode:undefined}:undefined};
  f.agent.ctx.get=name=>f.ctx[name];
  await assert.rejects(f.native.prepare('owned',{cwd:process.cwd(),writable:false,model:{provider:'p',model:'m'}}),/sandbox/);
  assert.equal(f.calls.some(call=>call.kind==='selection'),false);
});

test('sessionRoute reports host-verified workspace and active model from request/header fallback',async()=>{
  const f=await fixture();
  f.ctx.typertGateway.invoke=async request=>{
    if(request.method==='state')return {active:true};
    if(request.method==='events')return {records:[{event:{seq:24,type:'request/header',data:{header:{config:{provider:'xingchiapi',model:'gpt-6.1-sol',reasoningEffort:'max'}}}}}]};
    return {};
  };
  const route=await f.native.sessionRoute({id:'parent',session:{header:{cwd:process.cwd()}},model:{}});
  assert.deepEqual(route,{sessionId:'parent',cwd:process.cwd(),model:'xingchiapi/gpt-6.1-sol',provider:'xingchiapi',modelId:'gpt-6.1-sol',effort:'max'});
});

test('read-only workers receive skill and web research tools while strictly denying write, subagent, and admin tools',async()=>{
  const f=await fixture();
  f.ctx.tools.definitions=()=>['read','read_image','glob','grep','skill','web_search','web_fetch','todo_write','working_directory','job_list','job_output','write','edit','apply_patch','job_kill','pwsh','subagent','create_goal','plugin_manager','schedule_create','workflow','unrelated_admin'].map(name=>({name}));
  await f.native.prepare('owned',{cwd:process.cwd(),writable:false,model:{provider:'p',model:'m'},effort:'max'});
  const roAllow=new Set(f.restrictions.at(-1).allow);
  for(const ok of ['read','read_image','glob','grep','skill','web_search','web_fetch','todo_write','working_directory','job_list','job_output','pwsh'])assert.equal(roAllow.has(ok),true,ok+' should be allowed for read-only workers');
  for(const denied of ['write','edit','apply_patch','job_kill','subagent','create_goal','plugin_manager','schedule_create','workflow','unrelated_admin'])assert.equal(roAllow.has(denied),false,denied+' must be denied for read-only workers');
  await f.native.prepare('owned',{cwd:process.cwd(),writable:true,model:{provider:'p',model:'m'},effort:'max'});
  const rwAllow=new Set(f.restrictions.at(-1).allow);
  for(const ok of ['write','edit','apply_patch','job_kill','skill','web_search','web_fetch'])assert.equal(rwAllow.has(ok),true,ok+' should be allowed for writable workers');
  for(const denied of ['subagent','create_goal','plugin_manager','schedule_create','workflow','unrelated_admin'])assert.equal(rwAllow.has(denied),false,denied+' must stay denied for writable workers');
  const roGuard=f.guards.at(-2),rwGuard=f.guards.at(-1);
  assert.equal(roGuard({name:'pwsh',args:{command:'pwd'}}),undefined);
  assert.match(roGuard({name:'pwsh',args:{command:'pwd',sandbox_permissions:'workspace-write'}}),/read-only.*escalate/i);
  assert.equal(rwGuard({name:'pwsh',args:{command:'pwd',sandbox_permissions:'workspace-write'}}),undefined);
});

function subagentFixture({failSandbox=false,extraRoots=false,emitStart=true,withResume=true}={}) {
  let disposedCount=0;
  const calls=[],listeners=new Map(),restrictions=[],guards=[],followups=[],selectedModels=[],mounts=[];
  const parentSession={id:'parent-chat',header:{cwd:process.cwd(),delegationDepth:0},append:()=>{}};
  const parentAgent={id:'parent-chat',session:parentSession,options:{subagentDepth:0}};
  const sessions=new Map([['parent-chat',parentSession]]);
  const agents=new Map([['parent-chat',parentAgent]]);
  const modes=new Map([['parent-chat','workspace-write']]);
  let activeTools=['read','write','edit','apply_patch','bash','pwsh','subagent','subagent_fork','send_message','hive_swarm_set_turn_outcome','unrelated_admin'].map(name=>({name}));
  const emit=(topic,info)=>{for(const fn of listeners.get(topic)??[])fn(info);};
  const makeChild=(id,presetId='subagent-preset')=>{
    const session={id,header:{cwd:process.cwd(),origin:'subagent',parentSession:'parent-chat',agentPreset:presetId},
      append:(type,data)=>{calls.push({id,type,data});if(type==='sandbox/mode')modes.set(id,data.mode);}};
    const agent={id,session,
      ctx:{tools:{definitions:()=>activeTools,restrict:f=>{restrictions.push({id,f});return()=>{};},guard:fn=>{guards.push({id,fn});return()=>{};}}},
      model:{select:v=>{selectedModels.push({id,v});}},
      whenIdle:async()=>{calls.push({kind:'whenIdle',id});},
      cancel:reason=>{calls.push({kind:'agent.cancel',id,reason});},
      followup:msg=>{followups.push({id,msg});},
      inbox:{hasPending:false}};
    return {session,agent};
  };
  let activationResultResolve;
  const peer={principal:{kind:'owner'},dispose:async()=>{}};
  const ctx={
    connection:{createPeer:()=>peer},
    typertGateway:{invoke:async request=>{calls.push(request);
      if(request.method==='events')return {cursor:1,records:[{type:'event',event:{seq:1,type:'turn/end',data:{turn:1}}}],hasMore:false};
      return {accepted:true};}},
    sessions:{get:id=>sessions.get(id),flush:async()=>true},
    agents:{
      get:id=>agents.get(id),
      ...withResume?{resume:async({resumeSessionId,agentOptions,setup})=>{
        calls.push({kind:'agents.resume',resumeSessionId,agentOptions});
        const {session,agent}=makeChild(resumeSessionId,'worker-preset');
        sessions.set(resumeSessionId,session);
        await setup(agent.ctx,agent);
        agents.set(resumeSessionId,agent);
        return {agent,dispose:async()=>{disposedCount++;agents.delete(resumeSessionId);sessions.delete(resumeSessionId);calls.push({kind:'handle.dispose',id:resumeSessionId});}};
      }}:{},
    },
    agentPresets:{
      composedPreset:()=>'subagent-preset',
      presetForSession:s=>s?.header?.agentPreset,
      mount:async(_childCtx,presetId)=>{mounts.push(presetId);},
      serviceFor:(agent,name)=>{
        if(name==='fs')return {sandboxMode:failSandbox?undefined:'read-only'};
        if(name==='shell')return {sandboxMode:'read-only'};
        if(name==='sandboxPolicy')return {resolve:({session})=>({mode:modes.get(session.id)??'workspace-write',workspaceRoot:process.cwd(),...extraRoots?{additionalWritableRoots:['C:/outside']}:{}})};
        return undefined;
      },
    },
    llm:{resolveCallConfig:async cfg=>{calls.push({kind:'resolveCallConfig',cfg});}},
    sandboxPolicy:{resolve:({session})=>({mode:modes.get(session.id)??'workspace-write',workspaceRoot:process.cwd(),...extraRoots?{additionalWritableRoots:['C:/outside']}:{}})},
    fs:{sandboxMode:failSandbox?undefined:'read-only'},
    shell:{sandboxMode:'read-only'},
    tools:{definitions:()=>activeTools},
    on:(topic,fn)=>{const set=listeners.get(topic)??new Set();set.add(fn);listeners.set(topic,set);return()=>set.delete(topic);},
    subagents:{
      listDescendants:async()=>[{kind:'child',depth:1,name:'lead'}],
      interrupt:async(id,reason)=>{calls.push({kind:'interrupt',id,reason});activationResultResolve?.();},
      startActivation:async spec=>{
        calls.push({kind:'startActivation',spec});
        const {session,agent}=makeChild(spec.childId);
        modes.set(spec.childId,'workspace-write');
        sessions.set(spec.childId,session);agents.set(spec.childId,agent);
        if(emitStart)emit('subagent/start',{id:spec.childId,parentSessionId:spec.parent.id,provider:spec.provider});
        return {
          childId:spec.childId,name:spec.name??'agent-1',messageId:'m-1',
          result:new Promise(resolve=>{activationResultResolve=resolve;}),
          dispose:async()=>{calls.push({kind:'activation.dispose',id:spec.childId});agents.delete(spec.childId);sessions.delete(spec.childId);activationResultResolve?.();},
        };
      },
    },
  };
  return {ctx,calls,restrictions,guards,followups,selectedModels,mounts,sessions,agents,modes,emit,resolveTurn1:()=>{agents.delete(calls.find(c=>c.kind==='startActivation')?.spec.childId);activationResultResolve?.();},getDisposedCount:()=>disposedCount};
}

test('subagent startActivation enforces read-only vs write bounds synchronously in subagent/start and supports spawn/fork',async()=>{
  const {createNativeAccess}=await import('./native.mjs');
  const f=subagentFixture();
  const native=createNativeAccess(f.ctx,{ownsSession:()=>false,coordinationTools:['hive_swarm_set_turn_outcome']});
  const started=await native.startSubagent({
    teamId:'team-1234',parentSessionId:'parent-chat',memberName:'lead',label:'🐝 @lead · Task',
    cwd:process.cwd(),writable:false,model:{provider:'p',model:'m'},effort:'max',forkCoordinator:false,prompt:'Do work',
  });
  assert.equal(started.executionMode,'subagent');
  assert.equal(started.messageId,'m-1');
  const startCall=f.calls.find(c=>c.kind==='startActivation').spec;
  assert.equal(startCall.provider,'spawn');
  assert.equal(startCall.delivery,'caller');
  assert.equal(startCall.maxDepth,1);
  assert.deepEqual(startCall.prompt,[{type:'text',text:'Do work'}]);
  assert.equal(startCall.name,'worker-lead-team12');
  assert.equal(f.modes.get(started.sessionId),'read-only');
  assert.equal(f.restrictions[0].f.allow.includes('write'),false);
  assert.equal(f.restrictions[0].f.allow.includes('subagent'),false);
  assert.equal(f.restrictions[0].f.allow.includes('hive_swarm_set_turn_outcome'),true);
  assert.match(f.guards[0].fn({name:'bash',args:{sandbox_permissions:'workspace-write'}}),/read-only/i);

  // Unrelated non-Hive subagents are ignored by our subagent/start listener
  f.emit('subagent/start',{id:'foreign-subagent',parentSessionId:'parent-chat'});
  assert.equal(f.restrictions.length,1);

  // forkCoordinator uses provider: 'fork' without agentPreset
  f.resolveTurn1();await native.settleTurn(started.sessionId);
  const forked=await native.startSubagent({
    teamId:'team-1234',parentSessionId:'parent-chat',memberName:'reviewer_one',label:'🐝 @reviewer_one',
    cwd:process.cwd(),writable:true,model:{provider:'p',model:'m'},effort:undefined,forkCoordinator:true,prompt:'Fork work',
  });
  const forkSpec=f.calls.filter(c=>c.kind==='startActivation').at(-1).spec;
  assert.equal(forkSpec.provider,'fork');
  assert.equal('agentPreset' in forkSpec,false);
  assert.match(forkSpec.name,/^reviewer-one-/);
  assert.equal(f.modes.get(forked.sessionId),'workspace-write');
  assert.equal(f.restrictions.at(-1).f.allow.includes('write'),true);
  await native.dispose();
});

test('subagent security violations fail closed, lock down tools, and dispose activation without falling back',async()=>{
  const {createNativeAccess}=await import('./native.mjs');
  for(const variant of [{failSandbox:true},{extraRoots:true},{emitStart:false,failSandbox:true}]) {
    const f=subagentFixture(variant);
    const native=createNativeAccess(f.ctx,{ownsSession:()=>false});
    await assert.rejects(native.startSubagent({
      teamId:'t1',parentSessionId:'parent-chat',memberName:'builder',label:'@builder',
      cwd:process.cwd(),writable:true,model:{provider:'p',model:'m'},forkCoordinator:false,prompt:'Run',
    }),/sandbox|root/i);
    assert.equal(f.calls.some(c=>c.kind==='activation.dispose'),true,'failed security check must dispose child activation');
    if(variant.emitStart!==false)assert.deepEqual(f.restrictions.at(-1).f.allow,[],'must lock down all tools synchronously when subagent/start rejects');
    await native.dispose();
  }
});

test('subagent falls back cleanly on missing service, unloaded parent, or capacity limit, and rejects fork cwd mismatch',async t=>{
  const {mkdtempSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const otherDir=mkdtempSync(join(tmpdir(),'hive-other-cwd-'));
  t.after(()=>rmSync(otherDir,{recursive:true,force:true}));
  const {createNativeAccess}=await import('./native.mjs');
  const f=subagentFixture();
  f.ctx.subagents.startActivation=async()=>{throw Object.assign(Error('limit'),{code:'ACTIVATION_LIMIT_REACHED'});};
  const native=createNativeAccess(f.ctx,{ownsSession:()=>false});
  assert.equal(await native.startSubagent({teamId:'t1',parentSessionId:'parent-chat',memberName:'b',label:'@b',cwd:process.cwd(),writable:false,model:{provider:'p',model:'m'},forkCoordinator:false,prompt:'p'}),null);
  await assert.rejects(native.startSubagent({teamId:'t1',parentSessionId:'parent-chat',memberName:'b',label:'@b',cwd:otherDir,writable:false,model:{provider:'p',model:'m'},forkCoordinator:true,prompt:'p'}),/immutable workspace/i);
  assert.equal(await native.startSubagent({teamId:'t1',parentSessionId:'parent-chat',memberName:'b',label:'@b',cwd:otherDir,writable:false,model:{provider:'p',model:'m'},forkCoordinator:false,prompt:'p'}),null);
  f.agents.delete('parent-chat');
  assert.equal(await native.startSubagent({teamId:'t1',parentSessionId:'parent-chat',memberName:'b',label:'@b',cwd:process.cwd(),writable:false,model:{provider:'p',model:'m'},forkCoordinator:false,prompt:'p'}),null);
  await native.dispose();
});

test('Turn 2+ subagent uses ctx.agents.resume + deep-frozen followup + handle.dispose without waking parent chat',async()=>{
  const {createNativeAccess}=await import('./native.mjs');
  const f=subagentFixture({withResume:true});
  const native=createNativeAccess(f.ctx,{ownsSession:()=>false,coordinationTools:['hive_swarm_set_turn_outcome']});
  const started=await native.startSubagent({
    teamId:'t1',parentSessionId:'parent-chat',memberName:'builder',label:'@builder',
    cwd:process.cwd(),writable:false,model:{provider:'p',model:'m1'},effort:'low',forkCoordinator:false,prompt:'Turn 1',
  });
  f.resolveTurn1();await native.settleTurn(started.sessionId);

  // Turn 2 switches model + effort via prepareSubagentTurn + promptSubagentTurn (resuming cold child)
  await native.prepareSubagentTurn(started.sessionId,{parentSessionId:'parent-chat',cwd:process.cwd(),writable:false,model:{provider:'p',model:'m2'},effort:'max'});
  assert.deepEqual(f.mounts,['worker-preset']);
  assert.equal(f.calls.some(c=>c.kind==='agents.resume'&&c.resumeSessionId===started.sessionId),true);
  await native.promptSubagentTurn({sessionId:started.sessionId,requestId:'req-turn-2',cwd:process.cwd(),writable:false,model:{provider:'p',model:'m2'},effort:'max',prompt:'Turn 2'});
  assert.equal(f.followups.length,1);
  const msg=f.followups[0].msg;
  assert.equal(Object.isFrozen(msg),true);assert.equal(Object.isFrozen(msg.content[0]),true);assert.equal(Object.isFrozen(msg.source),true);
  assert.deepEqual(msg.source,{kind:'user',rpcId:'req-turn-2'});
  assert.deepEqual(f.selectedModels.at(-1).v,{provider:'p',model:'m2',reasoningEffort:'max'});

  await native.settleTurn(started.sessionId);
  assert.equal(f.getDisposedCount(),1);
  assert.equal(f.calls.some(c=>c.namespace==='subagents'&&c.method==='prompt'),false);

  // Events query uses subagent address, even when called after cold restart via executionMode + parentSessionId
  await native.events(started.sessionId,{parentSessionId:'parent-chat',executionMode:'subagent'});
  const evCall=f.calls.findLast(c=>c.method==='events');
  assert.deepEqual(evCall.args.request.address,{kind:'subagent',parentSessionId:'parent-chat',childSessionId:started.sessionId,mode:'continuable'});

  // Turn 3 cancel on a resumed handle cancels, awaits idle, flushes, and disposes handle
  await native.prepareSubagentTurn(started.sessionId,{parentSessionId:'parent-chat',cwd:process.cwd(),writable:false,model:{provider:'p',model:'m2'},effort:'max'});
  await native.cancel(started.sessionId,{executionMode:'subagent'});
  assert.equal(f.calls.some(c=>c.kind==='agent.cancel'&&c.id===started.sessionId),true);
  assert.equal(f.getDisposedCount(),2);
  await native.dispose();
});

test('Turn 2+ subagent falls back to subagents/prompt when ctx.agents.resume is unavailable and cancel cleans up',async()=>{
  const {createNativeAccess}=await import('./native.mjs');
  const f=subagentFixture({withResume:false});
  const native=createNativeAccess(f.ctx,{ownsSession:()=>false});
  const started=await native.startSubagent({
    teamId:'t1',parentSessionId:'parent-chat',memberName:'builder',label:'@builder',
    cwd:process.cwd(),writable:false,model:{provider:'p',model:'m'},forkCoordinator:false,prompt:'Turn 1',
  });
  await native.cancel(started.sessionId);
  assert.equal(f.calls.some(c=>c.kind==='activation.dispose'&&c.id===started.sessionId),true);

  await native.prepareSubagentTurn(started.sessionId,{parentSessionId:'parent-chat',cwd:process.cwd(),writable:false,model:{provider:'p',model:'m'}});
  await native.promptSubagentTurn({sessionId:started.sessionId,requestId:'rpc-2',cwd:process.cwd(),writable:false,model:{provider:'p',model:'m'},prompt:'Turn 2'});
  const promptCall=f.calls.find(c=>c.namespace==='subagents'&&c.method==='prompt');
  assert.deepEqual(promptCall.args.request,{requestId:'rpc-2',childSessionId:started.sessionId,delivery:'queue',content:[{type:'text',text:'Turn 2'}]});
  await native.cancel(started.sessionId,{executionMode:'subagent'});
  assert.equal(f.calls.some(c=>c.kind==='interrupt'&&c.id===started.sessionId),true);
  await native.dispose();
});

test('rename truncates UTF-8 titles below 80 bytes for ordinary sessions and skips subagents',async()=>{
  const {createNativeAccess}=await import('./native.mjs');
  const f=subagentFixture();
  const native=createNativeAccess(f.ctx,{ownsSession:id=>id==='ordinary'||id==='sub-1'});
  await native.rename('ordinary','🐝 @builder · '+'x'.repeat(120));
  const renameCall=f.calls.find(c=>c.method==='rename');
  assert.ok(renameCall);
  assert.ok(Buffer.byteLength(renameCall.args.request.title,'utf8')<=80);
  native.registerSubagent('sub-1','parent-chat');
  const countBefore=f.calls.filter(c=>c.method==='rename').length;
  await native.rename('sub-1','🐝 @sub · ignored');
  assert.equal(f.calls.filter(c=>c.method==='rename').length,countBefore);
  await assert.rejects(native.rename('foreign','Attempt'),/owned/);
  await native.dispose();
});
