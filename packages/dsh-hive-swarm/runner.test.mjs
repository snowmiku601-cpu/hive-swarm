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

test('runner executes Turn 1 subagent via messageId, prevents parent fork route leakage, and continues Turn 2 on same childId',async t=>{
  const {NativeRunner,correlateRun}=await import('./runner.mjs');
  const {RunStore}=await import('../../run-store.mjs');
  const store=new RunStore();t.after(()=>store.close());
  const events=[],calls=[];let seq=1,releaseWait;
  const push=(type,data)=>events.push({seq:seq++,type,data});
  // Seeded parent history before fork turn
  push('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[{id:'p-msg',source:{kind:'user',rpcId:'p-rpc'}}]});
  push('turn/start',{turn:1});
  push('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]});
  push('user/message',{id:'p-msg',source:{kind:'user',rpcId:'p-rpc'}});
  push('request/header',{header:{config:{provider:'parentP',model:'parentM',reasoningEffort:'low'}}});
  push('turn/end',{turn:1,reason:{kind:'completed'}});

  const native={
    listModels:async()=>[{id:'p/m',provider:'p',model:'m',efforts:['max'],defaultEffort:'max'}],
    registerSubagent:(id,p)=>calls.push(['registerSubagent',id,p]),
    startSubagent:async spec=>{
      calls.push(['startSubagent',spec.forkCoordinator,spec.parentSessionId]);
      push('model/selection',{provider:'p',model:'m',reasoningEffort:'max'});
      push('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[{id:'msg-sub-1',source:{kind:'user'}}]});
      return {sessionId:'child-1',subagentName:'builder-t1',messageId:'msg-sub-1',executionMode:'subagent'};
    },
    prepareSubagentTurn:async(id,opts)=>{calls.push(['prepareSubagentTurn',id,opts.parentSessionId]);},
    promptSubagentTurn:async req=>{
      calls.push(['promptSubagentTurn',req.sessionId,req.requestId]);
      push('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[{id:'msg-sub-2',source:{kind:'user',rpcId:req.requestId}}]});
      return {accepted:true};
    },
    settleTurn:async id=>calls.push(['settleTurn',id]),
    releaseTurn:async id=>calls.push(['releaseTurn',id]),
    wait:async()=>{await new Promise(r=>{releaseWait=r;});return {reason:'idle',state:{running:false,queue:[],pendingInput:[]}};},
    events:async(_id,_sig,opts)=>{calls.push(['events',opts?.executionMode,opts?.parentSessionId]);return events;},
    currentTurn:()=>({lastTurn:2,openTurnStartSeq:8}),
    state:async()=>({running:false,queue:[],pendingInput:[]}),
    flush:async()=>{},cancel:async()=>releaseWait?.(),dispose:async()=>{},
  };
  const runner=new NativeRunner({native,store});
  const member={name:'builder',lastTurn:1,writable:false,forkSource:'coordinator',model:'p/m',effort:'max'};
  const team={id:'team-1',parentSessionId:'parent-1',cwd:process.cwd(),task:'Subagent task',title:'Team One'};
  const remember=patch=>{Object.assign(member,patch);if(member.forkSource===null)delete member.forkSource;};

  const turn1=runner.run({team,member,remember,signal:new AbortController().signal,onActivity:()=>{}});
  await until(()=>releaseWait);
  assert.equal(member.threadId,'child-1');assert.equal(member.executionMode,'subagent');
  assert.equal(member.subagentName,'builder-t1');assert.equal(member.forkSource,undefined);
  assert.equal(member.pendingRun.messageId,'msg-sub-1');
  push('turn/start',{turn:2});push('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]});
  push('user/message',{id:'msg-sub-1',source:{kind:'user'}});
  push('request/header',{header:{config:{provider:'p',model:'m',reasoningEffort:'max'}}});
  await runner.setOutcome('child-1',1,{state:'waiting',message:'Need turn 2',notify:[],waitFor:[]});
  push('turn/end',{turn:2,reason:{kind:'completed'}});
  releaseWait();releaseWait=null;
  assert.equal((await turn1).state,'waiting');

  const proof1=correlateRun({requestId:member.pendingRun.requestId,messageId:'msg-sub-1'},events);
  assert.deepEqual(proof1.routes,['p/m · max'],'parent route must never leak into worker Verified route');

  // Turn 2 reuses child-1 without creating another subagent
  delete member.pendingRun;member.lastTurn=2;
  native.currentTurn=()=>({lastTurn:3,openTurnStartSeq:14});
  const turn2=runner.run({team,member,remember,signal:new AbortController().signal,onActivity:()=>{}});
  await until(()=>releaseWait);
  assert.equal(calls.filter(c=>c[0]==='startSubagent').length,1);
  assert.equal(calls.some(c=>c[0]==='prepareSubagentTurn'&&c[1]==='child-1'),true);
  push('turn/start',{turn:3});push('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]});
  push('user/message',{id:'msg-sub-2',source:{kind:'user',rpcId:member.pendingRun.requestId}});
  await runner.setOutcome('child-1',2,{state:'done',message:'[done] Complete',notify:[],waitFor:[]});
  push('turn/end',{turn:3,reason:{kind:'completed'}});
  releaseWait();
  assert.equal((await turn2).state,'done');
  const journal=runner.readTranscript('child-1');
  assert.equal(journal.length,2);
  assert.ok(journal[0].items.some(i=>i.label==='Verified route: p/m · max'));
  assert.ok(journal[1].items.some(i=>i.label==='Verified route: p/m · max'));
  assert.equal(calls.filter(c=>c[0]==='settleTurn').length,2);
});

test('runner falls back to create/forkParent with clean title when subagent is unavailable, and fails closed on security denial',async t=>{
  const {NativeRunner}=await import('./runner.mjs');
  const {RunStore}=await import('../../run-store.mjs');
  const store=new RunStore();t.after(()=>store.close());
  const calls=[];let releaseWait;
  const native={
    listModels:async()=>[{id:'p/m',provider:'p',model:'m',efforts:['max']}],
    startSubagent:async()=>{return null;},
    create:async()=>{calls.push('create');return 'fallback-sess';},
    forkParent:async id=>{calls.push(['forkParent',id]);return 'forked-parent-sess';},
    rename:async(id,title)=>{calls.push(['rename',id,title]);},
    prepare:async()=>{calls.push('prepare');},
    prompt:async()=>{calls.push('prompt');},
    wait:async()=>{await new Promise(r=>{releaseWait=r;});return {reason:'idle',state:{running:false,queue:[],pendingInput:[]}};},
    events:async()=>[],currentTurn:()=>({lastTurn:1,openTurnStartSeq:1}),state:async()=>({running:false,queue:[],pendingInput:[]}),
    flush:async()=>{},cancel:async()=>releaseWait?.(),dispose:async()=>{},
  };
  const runner=new NativeRunner({native,store});
  const abort=new AbortController();
  const member={name:'worker',lastTurn:1,writable:false,forkSource:'coordinator',model:'p/m',effort:'max'};
  const team={id:'team-fb',parentSessionId:'parent-1',cwd:process.cwd(),task:'Task',title:'Fallback Team'};
  const runPromise=runner.run({team,member,remember:p=>Object.assign(member,p),signal:abort.signal});
  await until(()=>releaseWait);
  assert.deepEqual(calls[0],['forkParent','parent-1']);
  assert.deepEqual(calls[1],['rename','forked-parent-sess','🐝 @worker · Fallback Team']);
  assert.equal(member.executionMode,'session');
  abort.abort();await assert.rejects(runPromise);

  // Security rejection fails closed before admission with zero fallback to create
  const callsBefore=calls.length;
  native.startSubagent=async()=>{throw Object.assign(Error('Security enforcement rejected preset'),{securityViolation:true});};
  const blockedMember={name:'blocked',lastTurn:1,writable:false,model:'p/m',effort:'max'};
  await assert.rejects(runner.run({team,member:blockedMember,remember:p=>Object.assign(blockedMember,p),signal:new AbortController().signal}),/Security enforcement/);
  assert.equal(calls.length,callsBefore);
  assert.equal(blockedMember.recoveryRequired,undefined);
});

test('Turn 1 sends full onboarding prompt while Turn 2+ sends native-compact wake prompt and omits unchanged roster',async t=>{
  const {NativeRunner}=await import('./runner.mjs');
  const {RunStore}=await import('../../run-store.mjs');
  const store=new RunStore();t.after(()=>store.close());
  const prompts=[];let releaseWait;
  const native={
    listModels:async()=>[{id:'p/m',provider:'p',model:'m',efforts:['max']}],
    create:async()=>'sess-delta',
    prepare:async()=>{},
    prompt:async({content})=>{prompts.push(content[0].text);},
    wait:async()=>{await new Promise(r=>{releaseWait=r;});return {reason:'idle',state:{running:false,queue:[],pendingInput:[]}};},
    events:async()=>[],currentTurn:()=>({lastTurn:1,openTurnStartSeq:1}),state:async()=>({running:false,queue:[],pendingInput:[]}),
    flush:async()=>{},cancel:async()=>releaseWait?.(),dispose:async()=>{},
  };
  const runner=new NativeRunner({native,store});
  const member={
    name:'builder',lastTurn:1,writable:true,model:'p/m',effort:'max',
    brief:'Own Delta Resume Prompt only.',
    inbox:[{seq:12,author:'qa',channel:'implementation',addressed:true,text:'Fix edge #12 cleanly'}],
  };
  const team={
    id:'team-delta',cwd:process.cwd(),task:'Deliver lean resume prompts',
    members:[member,{name:'qa',group:'verify',channels:['implementation'],status:'waiting'}],
  };

  const a1=new AbortController();
  const r1=runner.run({team,member,remember:p=>Object.assign(member,p),signal:a1.signal});
  await until(()=>prompts.length===1&&releaseWait);
  assert.match(prompts[0],/You are Hive Swarm member @builder in team team-delta/);
  assert.match(prompts[0],/Goal: Deliver lean resume prompts/);
  assert.match(prompts[0],/Your assignment: Own Delta Resume Prompt only\./);
  assert.match(prompts[0],/#12 @qa #implementation \(addressed to you\):\nFix edge #12 cleanly/);
  assert.doesNotMatch(prompts[0],/"addressed":true/);
  assert.equal(member.lastPeers,'@qa');
  a1.abort();await assert.rejects(r1);

  // Turn 2 on saved session with unchanged roster: omit Active teammates and repeated boilerplate
  member.threadId='sess-delta';
  member.pendingRun=undefined;
  member.lastTurn=2;
  member.inbox=[{seq:15,author:'qa',channel:'main',addressed:true,text:'Retest #14'}];
  releaseWait=undefined;
  const a2=new AbortController();
  const r2=runner.run({team,member,remember:p=>Object.assign(member,p),signal:a2.signal});
  await until(()=>prompts.length===2&&releaseWait);
  assert.match(prompts[1],/^\[Hive turn 2 · @builder\] Finish with hive_swarm_set_turn_outcome\(turn=2\)\.\n\n#15 @qa \(addressed to you\):\nRetest #14$/);
  assert.doesNotMatch(prompts[1],/Active teammates:/);
  assert.doesNotMatch(prompts[1],/do not call/i);
  assert.doesNotMatch(prompts[1],/Goal:|Your assignment:/);
  a2.abort();await assert.rejects(r2);

  // Turn 3 after roster changes: include Active teammates once and update lastPeers
  team.members.push({name:'verifier',status:'waiting',channels:[]});
  member.pendingRun=undefined;
  member.lastTurn=3;
  member.inbox=[{seq:18,author:'user',channel:'main',addressed:true,text:'Check verifier note'}];
  releaseWait=undefined;
  const a3=new AbortController();
  const r3=runner.run({team,member,remember:p=>Object.assign(member,p),signal:a3.signal});
  await until(()=>prompts.length===3&&releaseWait);
  assert.match(prompts[2],/^\[Hive turn 3 · @builder\] Active teammates: @qa, @verifier\. Finish with hive_swarm_set_turn_outcome\(turn=3\)\./);
  assert.equal(member.lastPeers,'@qa, @verifier');
  a3.abort();await assert.rejects(r3);
});

test('correlateRun formats nested turn/end error and abort objects without [object Object]',async()=>{
  const {correlateRun,formatTurnEndReason}=await import('./runner.mjs');
  const base=[
    {seq:1,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[{source:{kind:'user',rpcId:'req-obj'}}]}},
    {seq:2,type:'turn/start',data:{turn:1}},
    {seq:3,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}},
  ];
  assert.throws(
    ()=>correlateRun({requestId:'req-obj'},[...base,{seq:4,type:'turn/end',data:{turn:1,reason:{kind:'error',error:{message:'Connection error.',code:'TRANSPORT'}}}}]),
    err=>{assert.doesNotMatch(err.message,/\[object Object\]/);assert.match(err.message,/TRANSPORT: Connection error\./);return true;},
  );
  assert.throws(
    ()=>correlateRun({requestId:'req-obj'},[...base,{seq:4,type:'turn/end',data:{turn:1,reason:{kind:'error',error:{message:'Tool call "write": Unterminated string in JSON',code:'MALFORMED_RESPONSE'}}}}]),
    /MALFORMED_RESPONSE: Tool call "write": Unterminated string in JSON/,
  );
  assert.throws(
    ()=>correlateRun({requestId:'req-obj'},[...base,{seq:4,type:'turn/end',data:{turn:1,reason:{kind:'aborted',reason:{kind:'disposed'}}}}]),
    /aborted: disposed/,
  );
  assert.throws(
    ()=>correlateRun({requestId:'req-obj'},[...base,{seq:4,type:'turn/end',data:{turn:1,reason:{kind:'error',error:{message:'Rate limit 429',code:'RATE_LIMITED'}}}}]),
    /RATE_LIMITED: Rate limit 429/,
  );
  assert.equal(formatTurnEndReason(null),'incomplete');
});
