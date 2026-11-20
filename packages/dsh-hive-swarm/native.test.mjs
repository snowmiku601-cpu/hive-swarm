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
