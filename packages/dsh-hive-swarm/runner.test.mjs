import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {RunStore} from '../../run-store.mjs';

async function fixture(t,{promptError,prepareError}={}) {
  const {NativeRunner}=await import('./runner.mjs');const store=new RunStore();t.after(()=>store.close());
  const events=[];let release;const calls=[];let cursor=1;
  const event=(type,data)=>{const e={type,seq:cursor++,data};events.push(e);return e};
  const native={listModels:async()=>[{id:'provider/model',provider:'provider',model:'model',efforts:['max']}],
    create:async()=>{calls.push('create');return 'owned-session'},
    fork:async()=>{calls.push('fork');return 'owned-session'},
    prepare:async()=>{calls.push('prepare');if(prepareError)throw Error(prepareError)},
    prompt:async({requestId})=>{calls.push('prompt');event('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[{id:'input',source:{kind:'user',rpcId:requestId}}]});if(promptError)throw Error(promptError);return {accepted:true}},
    wait:async()=>{calls.push('wait');await new Promise(r=>{release=r});return {reason:'idle',state:{running:false,active:true,queue:[],pendingInput:[]}}},
    events:async()=>events,
    currentTurn:()=>({lastTurn:4,openTurnStartSeq:2}),
    state:async()=>({running:false,queue:[],pendingInput:[]}),
    flush:async()=>{calls.push('flush')},cancel:async()=>{calls.push('cancel');release?.()},dispose:async()=>{},
  };
  const runner=new NativeRunner({native,store});const member={name:'builder',lastTurn:1,writable:false,model:'provider/model',effort:'max'};
  const request={team:{id:'team',cwd:process.cwd(),task:'Fixture task'},member,remember:patch=>Object.assign(member,patch),
    signal:new AbortController().signal,onActivity:()=>{}};
  const claim=()=>{event('turn/start',{turn:4});event('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]});};
  return {runner,store,events,event,claim,calls,request,member,release:()=>release?.(),native};
}
const until=async fn=>{for(let i=0;i<1500;i++){if(fn())return;await delay(2)}throw Error('Expected fixture state not reached')};
const outcome={state:'done',message:'Verified owned result.',notify:[],waitFor:[]};

test('acceptance and a pending result wait for the matching durable turn end and host idle',async t=>{
  const f=await fixture(t);let finished=false;
  const result=f.runner.run(f.request).then(value=>{finished=true;return value});
  await until(()=>f.calls.includes('wait'));
  const run=f.store.findSession('owned-session');assert.ok(run);assert.equal(run.settled,false);
  f.claim();await f.runner.setOutcome('owned-session',1,outcome);await delay(5);assert.equal(finished,false);
  f.event('user/message',{source:{kind:'user',rpcId:run.requestId}});f.event('turn/end',{turn:4,reason:{kind:'completed'}});
  f.release();assert.deepEqual(await result,outcome);
  assert.equal(f.store.findSession('owned-session').settled,true);assert.equal(f.calls.filter(x=>x==='prompt').length,1);
  assert.ok(f.member.pendingRun?.requestId,'Preserve the identity until TeamBoard atomically settles it');
  assert.deepEqual(f.runner.actorForSession('owned-session'),null);
});

test('a host becoming busy during the durable flush cannot settle the prior idle observation',async t=>{
  const f=await fixture(t);const abort=new AbortController();f.request.signal=abort.signal;
  const result=f.runner.run(f.request);await until(()=>f.calls.includes('wait'));
  f.claim();await f.runner.setOutcome('owned-session',1,outcome);f.event('turn/end',{turn:4,reason:{kind:'completed'}});
  f.native.state=async()=>({running:true,queue:[],pendingInput:[]});f.release();await delay(8);
  assert.equal(f.store.findSession('owned-session').settled,false);
  abort.abort();await assert.rejects(result);
});

test('foreign user admission is not accepted as this worker result and leaves a recoverable run',async t=>{
  const f=await fixture(t);const result=f.runner.run(f.request);await until(()=>f.calls.includes('wait'));
  f.claim();await f.runner.setOutcome('owned-session',1,outcome);
  f.event('user/message',{source:{kind:'user',rpcId:'foreign'}});f.event('turn/end',{turn:4,reason:{kind:'completed'}});
  f.release();await assert.rejects(result,/unconfirmed|foreign|identity/i);
  assert.equal(f.member.recoveryRequired,true);assert.equal(f.store.findSession('owned-session').settled,false);
});

test('a failed acceptance response never retries a potentially accepted prompt',async t=>{
  const f=await fixture(t,{promptError:'transport lost after acceptance'});
  await assert.rejects(f.runner.run(f.request),/unconfirmed/i);
  assert.equal(f.member.recoveryRequired,true);
  await assert.rejects(f.runner.run(f.request),/unconfirmed|pending/i);
  assert.equal(f.calls.filter(x=>x==='prompt').length,1);
});

test('only an owned active session may declare an outcome, and cancellation cannot settle it',async t=>{
  const f=await fixture(t);const abort=new AbortController();f.request.signal=abort.signal;
  const result=f.runner.run(f.request);await until(()=>f.calls.includes('wait'));
  await assert.rejects(f.runner.setOutcome('foreign-session',1,outcome),/owned|active/i);
  await assert.rejects(f.runner.setOutcome('owned-session',2,outcome),/turn|identity/i);
  f.claim();await f.runner.setOutcome('owned-session',1,outcome);abort.abort(Error('cancel fixture'));
  await assert.rejects(result,/cancel|unconfirmed/i);
  assert.equal(f.calls.filter(x=>x==='cancel').length,1);assert.equal(f.store.findSession('owned-session').settled,false);
});

test('outcome admission requires this prompt durable claim and the same live Host turn',async t=>{
  const f=await fixture(t);const abort=new AbortController();f.request.signal=abort.signal;
  const result=f.runner.run(f.request);await until(()=>f.calls.includes('wait'));
  await assert.rejects(f.runner.setOutcome('owned-session',1,outcome),/claim|turn/i);
  f.claim();f.native.currentTurn=()=>({lastTurn:5,openTurnStartSeq:10});
  await assert.rejects(f.runner.setOutcome('owned-session',1,outcome),/claim|turn/i);
  abort.abort();await assert.rejects(result);
});

test('native permission rejection occurs before prompt admission',async t=>{
  const f=await fixture(t,{prepareError:'workspace sandbox unavailable'});
  await assert.rejects(f.runner.run(f.request),/sandbox/);
  assert.equal(f.calls.includes('prompt'),false);
});

test('a requested member fork uses its owned native history rather than starting a fresh session',async t=>{
  const f=await fixture(t);f.store.begin({teamId:'team',member:'source',turn:1,requestId:'source-run',sessionId:'source-session',workspace:process.cwd()});
  f.member.forkFrom='source-session';const abort=new AbortController();f.request.signal=abort.signal;
  const result=f.runner.run(f.request);await until(()=>f.calls.includes('wait'));
  try{assert.equal(f.calls.includes('fork'),true);assert.equal(f.calls.includes('create'),false);}
  finally{abort.abort();await assert.rejects(result)}
});

test('Host close waits for an aborted turn cancellation before releasing native guards',async t=>{
  const f=await fixture(t);const abort=new AbortController();f.request.signal=abort.signal;let finishCancel;
  f.native.wait=async(_id,signal)=>{f.calls.push('wait');await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  f.native.cancel=async()=>{f.calls.push('cancel');await new Promise(resolve=>{finishCancel=resolve});f.calls.push('cancel finished')};
  f.native.dispose=async()=>{f.calls.push('disposed')};
  const running=f.runner.run(f.request);running.catch(()=>{});await until(()=>f.calls.includes('wait'));abort.abort();
  await until(()=>finishCancel);await delay(10);let closed=false;const closing=f.runner.close().then(()=>{closed=true});
  try{await delay(10);assert.equal(closed,false);assert.equal(f.calls.includes('disposed'),false);}
  finally{finishCancel();await assert.rejects(running);await closing;}
  assert.ok(f.calls.indexOf('cancel finished')<f.calls.indexOf('disposed'));
});

test('a permission pause retains the scoped worker identity until approval completes the same prompt',async t=>{
  const f=await fixture(t);let waits=0;let approved;
  f.native.wait=async()=>{f.calls.push('wait');if(++waits===1)return {reason:'input-required'};
    await new Promise(resolve=>{approved=resolve});return {reason:'idle',state:{running:false,queue:[],pendingInput:[]}};};
  const running=f.runner.run(f.request);running.catch(()=>{});await until(()=>waits>0);await delay(5);
  assert.deepEqual(f.runner.actorForSession('owned-session'),{teamId:'team',member:'builder',turn:1});
  assert.equal(f.member.inputRequired,true);f.claim();await f.runner.setOutcome('owned-session',1,outcome);
  f.event('turn/end',{turn:4,reason:{kind:'completed'}});await until(()=>approved);approved();
  assert.deepEqual(await running,outcome);assert.equal(f.member.inputRequired,false);
  assert.equal(f.calls.filter(call=>call==='prompt').length,1);
});

test('a rejected worker outcome cannot poison the immutable durable result',async t=>{
  const f=await fixture(t);const abort=new AbortController();f.request.signal=abort.signal;
  const running=f.runner.run(f.request);running.catch(()=>{});await until(()=>f.calls.includes('wait'));f.claim();
  try{
    for(const state of ['failed','quota','arbitrary']){
      await assert.rejects(f.runner.setOutcome('owned-session',1,{...outcome,state}),/outcome|state/i);
      assert.equal(f.store.findSession('owned-session').outcome,null);
    }
    assert.deepEqual(await f.runner.setOutcome('owned-session',1,outcome),outcome);
  }finally{abort.abort();await assert.rejects(running);}
});

test('member effort null uses the selected model default rather than team effort, and worker prompt carries team context',async t=>{
  const f=await fixture(t);
  let prepared,promptText;
  f.native.listModels=async()=>[{id:'provider/model',provider:'provider',model:'model',efforts:['low','max'],defaultEffort:'low'}];
  f.native.prepare=async(_id,opts)=>{prepared=opts;};
  const origPrompt=f.native.prompt;
  f.native.prompt=async req=>{promptText=req.content[0].text;return origPrompt(req);};
  f.request.team={id:'team-42',cwd:process.cwd(),task:'Fixture task',model:'provider/model',effort:'max',
    members:[{name:'builder',status:'working'},{name:'verifier',status:'waiting',channels:['qa']}]};
  f.member.effort=null;
  const running=f.runner.run(f.request);
  await until(()=>f.calls.includes('wait'));
  f.claim();await f.runner.setOutcome('owned-session',1,outcome);
  f.event('turn/end',{turn:4,reason:{kind:'completed'}});
  f.release();
  await running;
  assert.equal(prepared.effort,'low');
  assert.match(promptText,/team-42/);
  assert.match(promptText,/@verifier/);
  assert.match(promptText,/do not.*duplicate|double-post/i);
});

test('correlateRun preserves turn/end failure detail so rate limits and errors remain visible',async()=>{
  const {correlateRun}=await import('./runner.mjs');
  const records=[
    {seq:1,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[{source:{kind:'user',rpcId:'req-1'}}]}},
    {seq:2,type:'turn/start',data:{turn:1}},
    {seq:3,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}},
    {seq:4,type:'turn/end',data:{turn:1,reason:{kind:'error',message:'HTTP 429 quota exceeded'}}},
  ];
  assert.throws(()=>correlateRun({requestId:'req-1'},records),/429.*quota exceeded/i);
});

test('runner records deduplicated host-verified request/header route proof in the worker journal',async t=>{
  const f=await fixture(t);
  const running=f.runner.run(f.request);
  await until(()=>f.calls.includes('wait'));
  f.claim();
  f.event('request/header',{header:{config:{provider:'xingchiapi',model:'gpt-6.1-sol',reasoningEffort:'max'}}});
  f.event('request/header',{header:{config:{provider:'xingchiapi',model:'gpt-6.1-sol',reasoningEffort:'max'}}});
  await f.runner.setOutcome('owned-session',1,outcome);
  f.event('turn/end',{turn:4,reason:{kind:'completed'}});
  f.release();
  await running;
  const journal=f.runner.readTranscript('owned-session');
  const routeSteps=journal[0].items.filter(item=>item.kind==='route');
  assert.deepEqual(routeSteps.map(item=>item.label),['Verified route: xingchiapi/gpt-6.1-sol · max']);
});

test('runner preserves Verified route across reused multi-turn sessions, clears inputRequired on timeout, and deduplicates timeout heartbeats',async t=>{
  const f=await fixture(t);
  let waits=0,releaseIdle;
  f.native.wait=async()=>{
    waits++;
    if(waits===1)return {reason:'input-required'};
    if(waits===2||waits===3)return {reason:'timeout'};
    await new Promise(resolve=>{releaseIdle=resolve;});
    return {reason:'idle',state:{running:false,queue:[],pendingInput:[]}};
  };
  // Simulate earlier session turn's request/header before this prompt was admitted
  f.event('request/header',{header:{config:{provider:'xingchiapi',model:'gpt-6.1-sol',reasoningEffort:'max'}}});
  const running=f.runner.run(f.request);
  await until(()=>waits>=2&&f.member.inputRequired===false);
  assert.equal(f.member.inputRequired,false,'inputRequired must clear as soon as wait returns timeout after approval');
  await until(()=>waits>=4&&releaseIdle);
  f.claim();
  await f.runner.setOutcome('owned-session',1,outcome);
  f.event('turn/end',{turn:4,reason:{kind:'completed'}});
  releaseIdle();
  await running;
  const journal=f.runner.readTranscript('owned-session');
  const labels=journal[0].items.filter(item=>item.type==='activity').map(item=>item.label);
  assert.ok(labels.includes('Verified route: xingchiapi/gpt-6.1-sol · max'),'subsequent turns without a new request/header must keep verified route');
  assert.equal(labels.filter(l=>l==='Native worker remains active').length,1,'consecutive timeout heartbeats must not spam the durable journal');
});
