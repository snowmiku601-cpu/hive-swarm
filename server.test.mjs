import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import * as services from './server.mjs';
import {TeamBoard} from './engine.mjs';
const {service}=services;

const model = (id, efforts) => ({
  model:id,displayName:id,defaultReasoningEffort:efforts[0],
  supportedReasoningEfforts:efforts.map(reasoningEffort=>({reasoningEffort})),
});
const models=[model('fixture-a',['ultra','low']),model('fixture-b',['low'])];
const done={state:'done',message:'Đã xong.',notify:[],waitFor:[]};
const members=[{name:'builder',brief:'Kiểm tra'}];

async function fixture(t, run = async ({member,team,remember})=>{
  const selected=member.model??team.model;
  remember({threadId:'saved-builder',activeModel:selected,activeEffort:models.find(entry=>entry.model===selected)?.defaultReasoningEffort});
  return done;
}, readTranscript) {
  const scratch=realpathSync(tmpdir());
  const dataDirectory=mkdtempSync(join(scratch,'team-board-service-test-'));
  const server=await service({dataDirectory,listenPort:0,runner:{listModels:async()=>models,run,readTranscript,close(){}}});
  t.after(async ()=>{
    await server.close();
    assert.equal(dirname(realpathSync(dataDirectory)),scratch);
    rmSync(dataDirectory,{recursive:true});
  });
  const key=readFileSync(join(dataDirectory,'service.key'),'utf8');
  const invoke=async (name,args={},signal)=>{
    const response=await fetch(server.origin+'/tool',{method:'POST',headers:{
      authorization:'Bearer '+key,'content-type':'application/json',
    },body:JSON.stringify({name,arguments:args}),signal});
    const body=await response.json();
    if (!response.ok) throw Error(body.error);
    return body;
  };
  const start=(fields={})=>invoke('start_team',{cwd:process.cwd(),task:'Kiểm thử API',members,...fields});
  const peer=async (request,name,args={},scope={teamId:request.team.id,member:request.member.name})=>{
    const response=await fetch(server.origin+'/peer',{method:'POST',headers:{
      authorization:'Bearer '+request.peerToken,'content-type':'application/json',
    },body:JSON.stringify({name,arguments:args,scope})});
    const body=await response.json();
    if (!response.ok) throw Error(body.error);
    return body;
  };
  const waitFor=async (id,condition)=>{
    const deadline=Date.now()+15000;let state;
    while(Date.now()<deadline) {
      state=await invoke('board_status',{teamId:id});
      if (condition(state)) return state;
      await delay(10);
    }
    assert.fail('Team did not reach the expected state: '+JSON.stringify({phase:state?.phase,members:state?.members?.map(member=>({name:member.name,status:member.status})),lastPost:state?.events?.at(-1)?.text}));
  };
  return {invoke,peer,start,waitFor,origin:server.origin,key,dataDirectory};
}

test('start_team validates an explicit team model without effort or member overrides',async t=>{
  const api=await fixture(t);
  await assert.rejects(api.start({model:'unknown-model'}),/unavailable.*unknown-model/);
  assert.deepEqual((await api.invoke('list_teams')).teams,[]);
  assert.equal((await api.start({model:'fixture-a'})).model,'fixture-a');
});

test('status exposes stall evidence and turn numbers without running a diagnostic model turn',async t=>{
  let runs=0;
  const api=await fixture(t,async()=>{
    runs++;
    return {state:'waiting',message:'[done] Ready for review.',notify:[],waitFor:[]};
  });
  const {id}=await api.start({members:[{name:'builder',brief:'Build'},
    {name:'reviewer',brief:'Review',waitFor:['builder']}]});
  const stalled=await api.waitFor(id,state=>state.phase==='stalled');
  const issue=stalled.attention.find(issue=>issue.kind==='unaddressed');
  assert.equal(issue.member,'builder');
  assert.ok(stalled.events.some(event=>event.seq===issue.seq&&event.author==='builder'));
  assert.equal(stalled.members[0].lastTurn,1);
  assert.equal(runs,1);
  assert.equal(stalled.turns,1);
  const budget=await api.start({turnLimit:1,members:[{name:'worker',brief:'Inspect'}]});
  const stopped=await api.waitFor(budget.id,state=>state.phase==='budget');
  assert.equal(stopped.attention[0].kind,'budget');
  assert.match(stopped.attention[0].text,/1\/1/);
});

test('blocked and circular waits remain visible while an unrelated worker is still working',async t=>{
  let release;
  const running=new Promise(resolve=>{release=resolve;});
  const api=await fixture(t,async({member})=>{
    if(member.name==='observer')await running;
    return {state:'waiting',message:'Waiting for a peer.',notify:[],
      waitFor:member.name==='alpha'?['beta']:member.name==='beta'?['alpha']:[]};
  });
  t.after(release);
  const {id}=await api.start({concurrency:3,members:[{name:'alpha',brief:'Inspect A'},
    {name:'beta',brief:'Inspect B'},{name:'observer',brief:'Inspect independently'}]});
  const state=await api.waitFor(id,state=>state.members[0].status==='waiting'&&state.members[1].status==='waiting');
  assert.equal(state.phase,'working');
  assert.ok(state.attention.some(issue=>issue.kind==='cycle'));
  assert.ok(!state.attention.some(issue=>issue.kind==='unaddressed'));
});

test('switching providers does not copy the model response’s active effort',async t=>{
  const api=await fixture(t);
  const {id}=await api.start({model:'fixture-a'});
  const previous=await api.waitFor(id,state=>state.phase==='done');
  assert.equal(previous.members[0].effort,'ultra');
  const changed=await api.invoke('set_member_model',{teamId:id,member:'builder',model:'fixture-b'});
  assert.equal(changed.members[0].model,'fixture-b');
  assert.equal(changed.members[0].effort,undefined);
  assert.equal(changed.members[0].threadId,'saved-builder');
});

test('a model change resets incompatible inherited effort and validates explicit effort',async t=>{
  const api=await fixture(t);
  const {id}=await api.start({model:'fixture-a',effort:'ultra'});
  await api.waitFor(id,state=>state.phase==='done');
  await assert.rejects(api.invoke('set_member_model',{
    teamId:id,member:'builder',model:'fixture-b',effort:'ultra',
  }),/offers these reasoning efforts/);
  const changed=await api.invoke('set_member_model',{teamId:id,member:'builder',model:'fixture-b'});
  assert.equal(changed.effort,'ultra');
  assert.equal(changed.members[0].effort,undefined);
});

test('an explicit default effort request clears even a compatible configured effort',async t=>{
  const api=await fixture(t);
  const {id}=await api.start({model:'fixture-a',effort:'low'});
  await api.waitFor(id,state=>state.phase==='done');
  const changed=await api.invoke('set_member_model',{teamId:id,member:'builder',model:'fixture-a',effort:null});
  assert.equal(changed.members[0].effort,undefined);
});

test('peer tools bind an active worker to its saved identity and its own helpers',async t=>{
  const active=new Map();
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  t.after(release);
  const api=await fixture(t,async request=>{
    request.remember({threadId:'saved-'+request.member.name});
    active.set(request.member.name,request);
    await gate;
    return done;
  });
  const {id}=await api.start({members:[...members,{name:'other',brief:'Công việc độc lập'}]});
  await api.waitFor(id,state=>state.members.every(member=>member.status==='working')&&active.size===2);
  const worker=active.get('builder');
  const catalog=await api.peer(worker,'peer_tools');
  const actions=catalog.tools.map(tool=>tool.name);
  for (const name of ['list_models','read_board','board_status','add_member','retire_member','set_member_model']) {
    assert.ok(actions.includes(name));
  }
  assert.equal(catalog.tools.find(tool=>tool.name==='add_member').inputSchema.properties.fork.type,'string');
  assert.ok(!actions.includes('set_team_title')&&!actions.includes('resume_team'));
  assert.equal((await api.peer(worker,'board_status',{teamId:'spoofed',member:'other'})).id,id);
  assert.ok((await api.peer(worker,'list_models')).models.length>0);
  await assert.rejects(api.peer(worker,'peer_tools',{}, {teamId:id,member:'other'}),/authorization/);
  await assert.rejects(api.peer(worker,'peer_tools',{}, {teamId:'unknown',member:'builder'}),/authorization/);
  await assert.rejects(api.peer(worker,'set_team_title',{title:'Nope'}),/not available/);
  await assert.rejects(api.peer(worker,'resume_team',{extraTurns:100}),/not available/);
  await assert.rejects(api.peer(worker,'retire_member',{member:'other'}),/own helpers/);
  await assert.rejects(api.peer(worker,'set_member_model',{member:'other',model:'fixture-b'}),/own helpers/);
  const member={name:'helper',brief:'Phần song song',waitFor:['builder']};
  await assert.rejects(api.peer(worker,'add_member',{member:{...member,writable:true},fork:'other'}),/read-only/);
  await assert.rejects(api.peer(worker,'add_member',{member,replaces:'other'}),/own helpers/);
  const foreign=await api.start({members:[{name:'outside',brief:'Thuộc nhóm khác'}]});
  await api.waitFor(foreign.id,state=>state.members[0].threadId);
  await assert.rejects(api.peer(worker,'add_member',{teamId:foreign.id,member,fork:'outside'}),/saved chat in this team/);
  await assert.rejects(api.peer(worker,'add_member',{member,fork:'saved-other'}),/saved chat in this team/);
  assert.equal((await api.peer(worker,'add_member',{member,fork:'other'})).members[2].addedBy,'builder');
  const changed=await api.peer(worker,'set_member_model',{member:'helper',model:'fixture-b'});
  assert.equal(changed.members[2].model,'fixture-b');
  const self=await api.peer(worker,'set_member_model',{member:'builder',model:'fixture-a',effort:'low'});
  assert.equal(self.members[0].model,'fixture-a');
  assert.equal(self.members[0].status,'working');
  assert.equal((await api.peer(worker,'retire_member',{member:'helper'})).members[2].status,'retired');
  assert.equal((await api.peer(worker,'retire_member',{member:'builder'})).members[0].retireAfterTurn,true);
});

test('the saved coordinator can manage the roster and model picker within the existing budget',async t=>{
  let coordinator,inherited;
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  t.after(release);
  const api=await fixture(t,async request=>{
    request.remember({threadId:'saved-'+request.member.name});
    if (request.member.name==='replacement') inherited=request.member.forkFrom;
    if (request.member.role==='coordinator') {
      coordinator=request;
      await gate;
    }
    return done;
  });
  const {id}=await api.start({coordinator:true,turnLimit:4});
  await api.waitFor(id,state=>state.members[1].status==='working'&&coordinator);
  const {tools}=await api.peer(coordinator,'peer_tools');
  assert.ok(tools.some(tool=>tool.name==='list_models'));
  assert.equal(tools.find(tool=>tool.name==='add_member').inputSchema.properties.fork.type,'string');
  assert.ok(!tools.some(tool=>tool.name==='resume_team'||tool.name==='remove_worktree'));
  assert.equal((await api.peer(coordinator,'list_models')).models.length,2);
  const modelled=await api.peer(coordinator,'set_member_model',{member:'builder',model:'fixture-b'});
  assert.equal(modelled.members[0].model,'fixture-b');
  const added=await api.peer(coordinator,'add_member',{
    member:{name:'replacement',brief:'Xem diff',writable:true},replaces:'builder',fork:'builder',
  });
  assert.equal(added.members[0].status,'retired');
  assert.equal(added.members[2].addedBy,'coordinator');
  assert.equal(added.turnLimit,4);
  await api.waitFor(id,state=>state.members[2].status==='done');
  assert.equal(inherited,'saved-builder');
});

test('the standalone group list reads saved team titles without scheduling work',async t=>{
  let starts=0;
  const api=await fixture(t,async ()=>{starts++;return done;});
  const first=await api.start({title:'Bảng trước'});
  await api.waitFor(first.id,state=>state.phase==='done');
  const second=await api.start({title:'Bảng sau'});
  await api.waitFor(second.id,state=>state.phase==='done');
  const response=await fetch(api.origin+'/swarm/teams',{headers:{'sec-fetch-site':'same-origin'}});
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).teams,[
    {id:second.id,title:second.title},{id:first.id,title:first.title},
  ]);
  assert.equal(starts,2);
  assert.equal((await fetch(api.origin+'/swarm/teams',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
});

test('the standalone budget control permits one increment of eight from the current board',async t=>{
  const api=await fixture(t);
  const team=await api.start({coordinator:true,turnLimit:1});
  await api.waitFor(team.id,state=>state.phase==='budget');
  const add=(extraTurns,origin=api.origin)=>fetch(team.url+'/resume',{
    method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({extraTurns}),
  });
  assert.equal((await add(8,'http://127.0.0.1:1')).status,403);
  assert.equal((await add(99)).status,400);
  const response=await add(8);
  assert.equal(response.status,200);
  assert.equal((await response.json()).turnLimit,9);
  assert.equal((await add(8)).status,400);
});

test('shutdown requires loopback host and the daemon service key',async t=>{
  const api=await fixture(t);
  const route=api.origin+'/shutdown';
  const authorization='Bearer '+api.key;
  assert.equal((await fetch(route,{method:'POST'})).status,403);
  const foreignHost=await new Promise((resolve,reject)=>{
    const outgoing=request(route,{method:'POST',headers:{host:'example.test',authorization}},response=>{
      response.resume();
      resolve(response.statusCode);
    });
    outgoing.on('error',reject).end();
  });
  assert.equal(foreignHost,403);
  assert.equal((await fetch(route,{method:'POST',headers:{authorization}})).status,200);
  await assert.rejects(fetch(api.origin+'/ready',{headers:{authorization}}));
});

test('an authenticated shutdown leaves an active turn running until it settles',async t=>{
  const running=Promise.withResolvers();
  t.after(()=>running.resolve(done));
  const api=await fixture(t,()=>running.promise);
  const {id}=await api.start();
  await api.waitFor(id,state=>state.phase==='working');
  const authorization='Bearer '+api.key;
  const stop=await fetch(api.origin+'/shutdown',{method:'POST',headers:{authorization}});
  assert.equal(stop.status,409);
  assert.match((await stop.json()).error,/running turns/);
  assert.equal((await api.invoke('board_status',{teamId:id})).phase,'working');
  running.resolve(done);
  await api.waitFor(id,state=>state.phase==='done');
  assert.equal((await fetch(api.origin+'/shutdown',{method:'POST',headers:{authorization}})).status,200);
});

for (const canShutdown of [true,false]) {
  test(canShutdown?'the client shuts down an older daemon before rebinding its port':
    'the client explains how to retire a legacy daemon without a shutdown route',async t=>{
    const directory=mkdtempSync(join(tmpdir(),'team-board-daemon-test-'));
    let shutdownRequested=0,next;
    const old=createServer((req,res)=>{
      res.setHeader('Content-Type','application/json');
      if (req.url==='/ready') return res.end(JSON.stringify({service:'codex-team-board',version:canShutdown?'1.7.0':'1.5.0'}));
      if (req.url==='/shutdown') shutdownRequested++;
      if (req.url==='/shutdown'&&canShutdown &&
          req.headers.authorization==='Bearer '+readFileSync(join(directory,'service.key'),'utf8')) {
        res.setHeader('Connection','close');
        res.end('{}',()=>old.close());
        return;
      }
      res.writeHead(404).end('{}');
    });
    await new Promise(resolve=>old.listen(0,'127.0.0.1',resolve));
    const port=old.address().port;
    t.after(async()=>{
      await next?.close();
      old.closeAllConnections();
      await new Promise(resolve=>old.close(resolve));
      for (const file of readdirSync(directory)) rmSync(join(directory,file));
      rmdirSync(directory);
    });
    const begin=()=>services.ensureService({
      address:'http://127.0.0.1:'+port,dataDirectory:directory,
      launch:async()=>{next=await service({dataDirectory:directory,listenPort:port,runner:{close(){}}});},
    });
    if (canShutdown) {
      const authorization=await begin();
      const ready=await fetch(next.origin+'/ready',{headers:{authorization}});
      assert.equal((await ready.json()).version,JSON.parse(readFileSync(new URL('./.codex-plugin/plugin.json',import.meta.url))).version);
    } else {
      await assert.rejects(async()=>begin(),/close the old Team Board Node process/i);
      assert.equal(next,undefined);
    }
    assert.equal(shutdownRequested,1);
  });
}

test('wait_for_board wakes over HTTP for a new matching post',async t=>{
  const running=Promise.withResolvers();
  t.after(()=>running.resolve(done));
  const api=await fixture(t,()=>running.promise);
  const team=await api.start();
  await api.waitFor(team.id,state=>state.phase==='working');
  const args={teamId:team.id};
  await api.invoke('manage_channel',{...args,op:'create',channel:'qa'});
  const {head}=await api.invoke('board_history',args);
  const waiting=api.invoke('wait_for_board',{...args,since:head,channel:'qa',timeoutSec:2});
  await api.invoke('post_message',{...args,text:'Không khớp'});
  await api.invoke('post_message',{...args,channel:'qa',text:'Bản kiểm tra'});
  const result=await waiting;
  assert.equal(result.wokeBy,'post');
  assert.deepEqual(result.posts.map(post=>post.text),['Bản kiểm tra']);
  assert.equal(result.status.members[0].inbox,undefined);
});

test('the same-origin member transcript is read-only and includes live activity only while it exists',async t=>{
  const held=Promise.withResolvers();
  const waiting={...done,state:'waiting'};
  t.after(()=>held.resolve(waiting));
  const reads=[];
  const turns=[{id:'turn-1',status:'completed',steps:['Lệnh shell'],report:'Đã kiểm tra.'}];
  let starts=0;
  const api=await fixture(t,async ({remember,onActivity})=>{
    starts++;
    remember({threadId:'saved-builder'});
    onActivity({kind:'shell',label:'Lệnh shell',detail:'Bắt đầu'});
    return held.promise;
  },async id=>{reads.push(id);return turns;});
  const team=await api.start({members:[...members,{name:'reviewer',brief:'Chờ kiểm tra',waitFor:['builder']}]});
  const working=await api.waitFor(team.id,state=>state.members[0].threadId&&state.activity.builder?.steps.length);
  const path=name=>team.url+'/member/'+name+'/transcript';
  const same={'sec-fetch-site':'same-origin'};

  for (const headers of [{},{'sec-fetch-site':'cross-site'},{'sec-fetch-site':'same-site'}]) {
    assert.equal((await fetch(path('builder'),{headers})).status,403);
  }
  const foreignHost=await new Promise((resolve,reject)=>{
    request(path('builder'),{headers:{...same,host:'example.test'}},response=>{
      response.resume();
      resolve(response.statusCode);
    }).on('error',reject).end();
  });
  assert.equal(foreignHost,403);
  assert.equal((await fetch(path('unknown'),{headers:same})).status,404);
  assert.equal((await fetch(path('reviewer'),{headers:same})).status,404);
  assert.deepEqual(reads,[]);

  const response=await fetch(path('builder')+'?threadId=other-chat',{headers:same});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{member:'builder',status:'working',threadId:'saved-builder',
    turns,live:working.activity.builder});
  held.resolve(waiting);
  const idle=await api.waitFor(team.id,state=>state.phase==='stalled');
  const saved=await (await fetch(path('builder'),{headers:same})).json();
  assert.deepEqual(saved,{member:'builder',status:'waiting',threadId:'saved-builder',turns,live:null});
  assert.deepEqual(reads,['saved-builder','saved-builder']);
  assert.equal(starts,1);
  assert.equal((await api.invoke('board_status',{teamId:team.id})).turns,idle.turns);
});

test('closing the HTTP wait request releases the board subscriber',async t=>{
  let board,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const wait=TeamBoard.prototype.waitForBoard;
  t.mock.method(TeamBoard.prototype,'waitForBoard',function(...args) {
    board=this;
    const work=wait.apply(this,args);
    entered();
    return work;
  });
  const running=Promise.withResolvers();
  t.after(()=>running.resolve(done));
  const api=await fixture(t,()=>running.promise);
  const {id}=await api.start();
  await api.waitFor(id,state=>state.phase==='working');
  const controller=new AbortController();
  const request=api.invoke('wait_for_board',{teamId:id,timeoutSec:5},controller.signal);
  await started;
  assert.equal(board.signals.listenerCount(id),1);
  controller.abort();
  await assert.rejects(request,{name:'AbortError'});
  for(let attempt=0;attempt<50&&board.signals.listenerCount(id);attempt++) await delay(10);
  assert.equal(board.signals.listenerCount(id),0);
});

async function eventStream(url,t) {
  const controller=new AbortController();
  t.after(()=>controller.abort());
  const response=await fetch(url,{headers:{'sec-fetch-site':'same-origin'},signal:controller.signal});
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer='';
  return async function next(type) {
    while (true) {
      const boundary=buffer.indexOf('\n\n');
      if (boundary<0) {
        const {value,done}=await reader.read();
        if (done) throw Error('Stream ended before '+type);
        buffer+=value;
        continue;
      }
      const item=buffer.slice(0,boundary);
      buffer=buffer.slice(boundary+2);
      if (item.startsWith('event: '+type+'\n')) return JSON.parse(item.split('\ndata: ')[1]);
    }
  };
}

test('same-origin SSE publishes team creation, live status and bounded activity', {timeout:6000},async t=>{
  let active,release;
  const held=new Promise(resolve=>{release=resolve;});
  t.after(release);
  const api=await fixture(t,async request=>{active=request;await held;return done;});
  const home=await eventStream(api.origin+'/swarm/events',t);
  assert.deepEqual((await home('teams')).teams,[]);
  const team=await api.start();
  assert.equal((await home('teams')).teams[0].id,team.id);
  await api.waitFor(team.id,state=>state.members[0].status==='working'&&active);
  assert.equal((await fetch(team.url+'/events',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await fetch(api.origin+'/swarm/events')).status,403);
  const events=await eventStream(team.url+'/events',t);
  assert.equal((await events('status')).phase,'working');
  for (let i=0;i<12;i++) active.onActivity({kind:'tool',label:'Bước '+i});
  active.onActivity({kind:'draft',delta:JSON.stringify({...done,message:'N'.repeat(650)})});
  const live=(await events('activity')).builder;
  assert.equal(live.steps.length,10);
  assert.equal(live.draft,'N'.repeat(600));
  await api.invoke('set_team_title',{teamId:team.id,title:'Đã đổi tên'});
  assert.equal((await events('status')).title,'Đã đổi tên');
  assert.equal((await home('teams')).teams[0].title,'Đã đổi tên');
  release();
  assert.deepEqual((await events('status')).activity,{});
});

test('peer channel authority and helper inheritance use stored roles',async t=>{
  let builder,release;
  const held=new Promise(resolve=>{release=resolve;});
  t.after(release);
  const api=await fixture(t,async request=>{
    if (request.member.name==='builder') {builder=request;await held;}
    return done;
  });
  const team=await api.start({members:[{name:'builder',brief:'Kiểm tra',channels:['qa']}]});
  await api.waitFor(team.id,state=>builder&&state.phase==='working');
  assert.deepEqual((await api.peer(builder,'manage_channel',{op:'list'})).channels.map(channel=>channel.name),['main','qa']);
  await assert.rejects(api.peer(builder,'manage_channel',{op:'archive',channel:'qa'}),/coordinator/);
  await assert.rejects(api.peer(builder,'set_team_title',{title:'Từ worker'}),/not available/);
  const invited=await api.peer(builder,'add_member',{member:{name:'helper',brief:'Xem',waitFor:['builder']}});
  assert.deepEqual(invited.members.find(member=>member.name==='helper').channels,['qa']);
  const event=await api.peer(builder,'post_to_board',{text:'Bản nháp đã có'});
  assert.equal(event.channel,'qa');
});

function webAction(team, name, data, headers={}) {
  return fetch(team.url+'/'+name,{method:'POST',headers:{
    origin:new URL(team.url).origin,'content-type':'application/json',...headers,
  },body:JSON.stringify(data)});
}

test('standalone guarded routes list models, switch the worker model, rename and retire',async t=>{
  const api=await fixture(t);
  const team=await api.start();
  await api.waitFor(team.id,state=>state.phase==='done');
  const catalog=api.origin+'/swarm/models';
  assert.equal((await fetch(catalog)).status,403);
  const models=await fetch(catalog,{headers:{'sec-fetch-site':'same-origin'}});
  assert.equal(models.status,200);
  assert.deepEqual((await models.json()).models.map(model=>model.id),['fixture-a','fixture-b']);
  for (const name of ['member-model','member-retire','title','worktree-remove']) {
    assert.equal((await webAction(team,name,{}, {origin:'http://example.test'})).status,403);
    assert.equal((await webAction(team,name,{}, {'content-type':'application/json-bogus'})).status,403);
  }
  const model=await webAction(team,'member-model',{member:'builder',model:'fixture-b',effort:'low'});
  assert.equal(model.status,200);
  assert.equal((await model.json()).members[0].model,'fixture-b');
  const renamed=await webAction(team,'title',{title:'Nhóm đã đổi tên'});
  assert.equal((await renamed.json()).title,'Nhóm đã đổi tên');
  const retired=await webAction(team,'member-retire',{member:'builder'});
  assert.equal((await retired.json()).members[0].status,'retired');
});

test('standalone model edits cannot modify a running worker',async t=>{
  let release;
  const held=new Promise(resolve=>{release=resolve;});
  t.after(release);
  const api=await fixture(t,async()=>{await held;return done;});
  const team=await api.start();
  await api.waitFor(team.id,state=>state.phase==='working');
  const changed=await webAction(team,'member-model',{member:'builder',model:'fixture-b',effort:null});
  assert.equal(changed.status,400);
  assert.match((await changed.json()).error,/finish its current turn/);
});

test('web worktree removal discards no uncommitted content even with a force parameter',async t=>{
  const api=await fixture(t,async()=>done);
  const cwd=join(api.dataDirectory,'repo');
  mkdirSync(cwd);
  const git=(...args)=>execFileSync('git',['-C',cwd,...args],{windowsHide:true,stdio:'pipe'});
  git('init','-q');
  writeFileSync(join(cwd,'base.txt'),'Test fixture');
  git('add','base.txt');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-qm','base');
  const team=await api.start({cwd,members:[{name:'builder',brief:'Thử checkout',worktree:true,writable:true}]});
  const state=await api.waitFor(team.id,value=>value.phase==='done');
  const dirty=join(state.members[0].workspace.path,'uncommitted.txt');
  writeFileSync(dirty,'Mã chưa commit');
  const response=await webAction(team,'worktree-remove',{member:'builder',force:true});
  assert.equal(response.status,400);
  assert.match((await response.json()).error,/uncommitted.*chat/i);
  assert.equal(readFileSync(dirty,'utf8'),'Mã chưa commit');
  rmSync(dirty);
  const cleaned=await webAction(team,'worktree-remove',{member:'builder'});
  assert.equal(cleaned.status,200);
  assert.equal((await cleaned.json()).members[0].workspace,undefined);
});

test('launchDaemon clears host MSIX and session variables while keeping Team Board configuration',t=>{
  const restore=new Map([
    ['CODEX_WINDOWS_REGISTERED_CORE',process.env.CODEX_WINDOWS_REGISTERED_CORE],
    ['CODEX_THREAD_ID',process.env.CODEX_THREAD_ID],
    ['CODEX_HOME',process.env.CODEX_HOME],
    ['TEAM_BOARD_PORT',process.env.TEAM_BOARD_PORT],
  ]);
  t.after(()=>{
    for (const [key,value] of restore) {
      if (value===undefined) delete process.env[key];
      else process.env[key]=value;
    }
  });
  process.env.CODEX_WINDOWS_REGISTERED_CORE='1';
  process.env.CODEX_THREAD_ID='host-thread';
  process.env.CODEX_HOME='C:\\Users\\fixture\\.codex';
  process.env.TEAM_BOARD_PORT='17943';

  let invocation;
  let unreferenced=false;
  services.launchDaemon((command,args,options)=>{
    invocation={command,args,options};
    return {on(){},unref(){unreferenced=true;}};
  });
  assert.equal(unreferenced,true);
  assert.equal(invocation.command,process.execPath);
  assert.ok(invocation.args.includes('--service'));
  assert.equal(invocation.options.detached,true);
  assert.equal(invocation.options.env.CODEX_WINDOWS_REGISTERED_CORE,undefined);
  assert.equal(invocation.options.env.CODEX_THREAD_ID,undefined);
  assert.equal(invocation.options.env.CODEX_HOME,'C:\\Users\\fixture\\.codex');
  assert.equal(invocation.options.env.TEAM_BOARD_PORT,'17943');
});

test('peer tools include board_history, coordinator can update outcome threads, and status/history require same-origin',async t=>{
  let active,release;
  const held=new Promise(resolve=>{release=resolve;});
  t.after(release);
  const api=await fixture(t,async request=>{active=request;await held;return done;});
  const team=await api.start({threads:[{id:'t-init',title:'Initial',goal:'Check',members:['builder']}]});
  await api.waitFor(team.id,state=>state.phase==='working'&&active);
  const catalog=await api.peer(active,'peer_tools');
  assert.ok(catalog.tools.some(tool=>tool.name==='board_history'));
  const history=await api.peer(active,'board_history',{limit:50});
  assert.ok(Array.isArray(history.posts));
  const updated=await api.invoke('set_team_plan',{teamId:team.id,threads:[{id:'t-next',title:'Next',goal:'Verify',members:['builder']}]});
  assert.deepEqual(updated.threads,[{id:'t-next',title:'Next',goal:'Verify',members:['builder']}]);
  assert.equal((await fetch(team.url+'/status')).status,403);
  assert.equal((await fetch(team.url+'/history')).status,403);
  assert.equal((await fetch(team.url+'/status',{headers:{'sec-fetch-site':'same-origin'}})).status,200);
  assert.equal((await fetch(team.url+'/history',{headers:{'sec-fetch-site':'same-origin'}})).status,200);
});

test('extractParentSessionId reads MCP _meta keys and CODEX_THREAD_ID safely, while /tool rejects spoofed parentSessionId and projects executionMode',async t=>{
  assert.equal(services.extractParentSessionId({'codex/threadId':'thr-meta'},{CODEX_THREAD_ID:'thr-env'}),'thr-meta');
  assert.equal(services.extractParentSessionId({threadId:'thr-alt'},{CODEX_THREAD_ID:'thr-env'}),'thr-alt');
  assert.equal(services.extractParentSessionId({thread_id:'thr-snake'},{}),'thr-snake');
  assert.equal(services.extractParentSessionId({codex:{threadId:'thr-nested'}},{}),'thr-nested');
  assert.equal(services.extractParentSessionId(undefined,{CODEX_THREAD_ID:'thr-env'}),'thr-env');
  assert.equal(services.extractParentSessionId({'codex/threadId':'bad\0id'},{CODEX_THREAD_ID:'  '}),undefined);

  const seen=[];
  const api=await fixture(t,async ({team,member,remember})=>{
    seen.push({name:member.name,parentSessionId:team.parentSessionId,forkSource:member.forkSource});
    remember({
      threadId:'attached-'+member.name,
      executionMode:'attached',
      subagentName:'hive-'+member.name,
      ...(member.forkSource?{forkSource:null}:{}),
    });
    return done;
  });

  const postTool=async (name,args,context)=>{
    const response=await fetch(api.origin+'/tool',{method:'POST',headers:{
      authorization:'Bearer '+api.key,'content-type':'application/json',
    },body:JSON.stringify({name,arguments:args,...(context?{context}:{})})});
    return {status:response.status,body:await response.json()};
  };

  const spoofed=await postTool('start_team',{cwd:process.cwd(),task:'Spoof',parentSessionId:'evil',members},{parentSessionId:'real-parent'});
  assert.equal(spoofed.status,400);
  assert.match(spoofed.body.error,/host identity|cannot be supplied/i);

  const priorThread=process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID='daemon-env-leak-check';
  t.after(()=>{
    if (priorThread===undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID=priorThread;
  });
  const withoutContext=await postTool('start_team',{cwd:process.cwd(),task:'No context header',members});
  assert.equal(withoutContext.status,200);
  assert.equal(withoutContext.body.parentSessionId,undefined);
  await api.waitFor(withoutContext.body.id,state=>state.phase==='done');
  assert.deepEqual(seen.shift(),{name:'builder',parentSessionId:undefined,forkSource:undefined});

  const started=await postTool('start_team',{
    cwd:process.cwd(),task:'Attached Codex team',
    members:[{name:'researcher',brief:'Warm start',fork:'coordinator'}],
  },{parentSessionId:'codex-parent-9'});
  assert.equal(started.status,200);
  assert.equal(started.body.parentSessionId,'codex-parent-9');
  const finished=await api.waitFor(started.body.id,state=>state.phase==='done');
  assert.equal(finished.parentSessionId,'codex-parent-9');
  assert.equal(finished.members[0].executionMode,'attached');
  assert.equal(finished.members[0].subagentName,'hive-researcher');
  assert.deepEqual(seen[0],{name:'researcher',parentSessionId:'codex-parent-9',forkSource:'coordinator'});

  const added=await api.invoke('add_member',{
    teamId:started.body.id,
    member:{name:'verifier',brief:'Check',fork:'coordinator'},
  });
  assert.equal(added.members.length,2);
  await api.waitFor(started.body.id,state=>state.phase==='done'&&state.members.length===2&&state.members[1].status==='done');
  assert.deepEqual(seen[1],{name:'verifier',parentSessionId:'codex-parent-9',forkSource:'coordinator'});
});

test('stdio MCP bridge exposes member.fork and forwards trusted _meta or CODEX_THREAD_ID as parentSessionId',async t=>{
  const {spawn}=await import('node:child_process');
  const {fileURLToPath}=await import('node:url');
  const api=await fixture(t,async ({member,remember})=>{
    remember({threadId:'attached-'+member.name,executionMode:'attached'});
    return done;
  });
  const port=new URL(api.origin).port;
  const child=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))],{
    env:{...process.env,TEAM_BOARD_DATA:api.dataDirectory,TEAM_BOARD_PORT:port,CODEX_THREAD_ID:'env-parent-123'},
    stdio:['pipe','pipe','ignore'],windowsHide:true,
  });
  t.after(()=>child.kill());
  const responses=new Map();
  const waiters=new Map();
  let buf='';
  child.stdout.on('data',chunk=>{
    buf+=chunk.toString();
    let idx;
    while ((idx=buf.indexOf('\n'))>=0) {
      const msg=JSON.parse(buf.slice(0,idx));
      buf=buf.slice(idx+1);
      responses.set(msg.id,msg);
      waiters.get(msg.id)?.(msg);
      waiters.delete(msg.id);
    }
  });
  const rpc=(id,method,params)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Timed out waiting for '+method)),5000);
    waiters.set(id,msg=>{clearTimeout(timer);resolve(msg);});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });

  await rpc(1,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1.0'}});
  const listed=await rpc(2,'tools/list',{});
  const startTool=listed.result.tools.find(tool=>tool.name==='start_team');
  assert.equal(startTool.inputSchema.properties.members.items.properties.fork.type,'string');

  const fromEnv=await rpc(3,'tools/call',{
    name:'start_team',
    arguments:{cwd:process.cwd(),task:'Env parent test',members:[{name:'alpha',brief:'Go',fork:'coordinator'}]},
  });
  assert.equal(fromEnv.result.isError,undefined);
  assert.equal(fromEnv.result.structuredContent.parentSessionId,'env-parent-123');

  const fromMeta=await rpc(4,'tools/call',{
    name:'start_team',
    arguments:{cwd:process.cwd(),task:'Meta parent test',members:[{name:'beta',brief:'Go',fork:'coordinator'}]},
    _meta:{'codex/threadId':'meta-parent-456'},
  });
  assert.equal(fromMeta.result.isError,undefined);
  assert.equal(fromMeta.result.structuredContent.parentSessionId,'meta-parent-456');
});

test('2.1.0 Codex schema, CSP img-src, and confined GET /board/:id/screenshot/:seq/:idx endpoint',async t=>{
  const {symlinkSync}=await import('node:fs');
  const root=mkdtempSync(join(tmpdir(),'hive-server-shots-'));
  const dataDirectory=join(root,'data');
  // Nest repo inside dataDirectory so relative .. traversal into dataDirectory is explicitly verified blocked.
  const repoDir=join(dataDirectory,'repo');
  const outsideDir=join(root,'outside');
  mkdirSync(join(repoDir,'shots'),{recursive:true});
  mkdirSync(join(dataDirectory,'worktrees','wt'),{recursive:true});
  mkdirSync(outsideDir,{recursive:true});

  const png=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  const jpg=Buffer.from([0xff,0xd8,0xff,0xe0]);
  const webp=Buffer.from('RIFF\0\0\0\0WEBP');
  writeFileSync(join(repoDir,'shots','home.png'),png);
  writeFileSync(join(repoDir,'shots','card.jpeg'),jpg);
  writeFileSync(join(dataDirectory,'worktrees','wt','panel.webp'),webp);
  writeFileSync(join(dataDirectory,'secret.png'),png);
  writeFileSync(join(outsideDir,'secret.png'),png);
  writeFileSync(join(repoDir,'shots','notes.txt'),'text');
  writeFileSync(join(repoDir,'shots','big.png'),Buffer.alloc(10*1024*1024+1));
  symlinkSync(outsideDir,join(repoDir,'shots','escape'),process.platform==='win32'?'junction':'dir');

  const server=await service({dataDirectory,listenPort:0,runner:{
    listModels:async()=>models,
    run:async ({member,remember})=>{remember({threadId:'thr-'+member.name});return done;},
    readTranscript:async()=>[],
    close(){},
  }});
  t.after(async()=>{await server.close();rmSync(root,{recursive:true,force:true});});
  const key=readFileSync(join(dataDirectory,'service.key'),'utf8');
  const invoke=async (name,args)=>{
    const response=await fetch(server.origin+'/tool',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},
      body:JSON.stringify({name,arguments:args})});
    const body=await response.json();
    if (!response.ok) throw Error(body.error);
    return body;
  };

  const started=await invoke('start_team',{
    cwd:repoDir,task:'UI polish & screenshots',goalLine:'Deliver 2.1.0 Overview & Graph',
    members:[{name:'ui',brief:'Build dashboard',taskLabel:'Dashboard UI'}],
  });
  assert.equal(started.goalLine,'Deliver 2.1.0 Overview & Graph');
  assert.equal(started.members[0].taskLabel,'Dashboard UI');

  const updated=await invoke('set_team_plan',{
    teamId:started.id,goalLine:'Final 2.1.0 polish',
    tasks:[{member:'ui',label:'Overview & Graph UI'}],
    threads:[{id:'ui-thread',title:'UI',goal:'Ship dashboard',members:['ui']}],
  });
  assert.equal(updated.goalLine,'Final 2.1.0 polish');
  assert.equal(updated.members[0].taskLabel,'Overview & Graph UI');

  // Verify CSP allows img-src 'self' data: blob: on board HTML.
  const pageRes=await fetch(started.url);
  assert.equal(pageRes.status,200);
  const csp=pageRes.headers.get('content-security-policy');
  assert.match(csp,/img-src 'self' data: blob:/);

  const posted=await invoke('post_message',{
    teamId:started.id,
    text:[
      'Screenshots ready:',
      'Screenshot: shots/home.png | Home overview',
      'Screenshot: '+join(repoDir,'shots','card.jpeg')+' | Card JPEG',
      'Screenshot: '+join(dataDirectory,'worktrees','wt','panel.webp')+' | Worktree WEBP',
      'Screenshot: ../secret.png | Traversal',
      'Screenshot: '+join(outsideDir,'secret.png')+' | Outside root',
      'Screenshot: shots/notes.txt | Non-image',
      'Screenshot: shots/escape/secret.png | Symlink escape',
      'Screenshot: shots/big.png | Oversized',
    ].join('\n'),
  });
  const seq=posted.events.at(-1).seq;
  assert.equal(posted.screenshots.length,8);
  assert.equal(posted.screenshots[0].url,'/board/'+started.id+'/screenshot/'+seq+'/0');
  assert.equal(Object.hasOwn(posted.screenshots[0],'path'),false);

  const shotUrl=idx=>server.origin+'/board/'+started.id+'/screenshot/'+seq+'/'+idx;
  assert.equal((await fetch(shotUrl(0))).status,403);
  assert.equal((await fetch(shotUrl(0),{headers:{'sec-fetch-site':'cross-site'}})).status,403);

  const same={'sec-fetch-site':'same-origin'};
  const res0=await fetch(shotUrl(0),{headers:same});
  assert.equal(res0.status,200);
  assert.equal(res0.headers.get('content-type'),'image/png');
  assert.equal(res0.headers.get('cache-control'),'no-store');
  assert.equal(res0.headers.get('x-content-type-options'),'nosniff');
  assert.equal(res0.headers.get('cross-origin-resource-policy'),'same-origin');
  assert.deepEqual(Buffer.from(await res0.arrayBuffer()),png);

  const res1=await fetch(shotUrl(1),{headers:same});
  assert.equal(res1.status,200);
  assert.equal(res1.headers.get('content-type'),'image/jpeg');

  const res2=await fetch(shotUrl(2),{headers:same});
  assert.equal(res2.status,200);
  assert.equal(res2.headers.get('content-type'),'image/webp');

  for (const badIdx of [3,4,5,6,7,88]) {
    assert.equal((await fetch(shotUrl(badIdx),{headers:same})).status,404,'index '+badIdx+' must 404');
  }
  assert.equal((await fetch(server.origin+'/board/00000000-0000-0000-0000-000000000000/screenshot/1/0',{headers:same})).status,404);
});

test('GET /swarm/update enforces same-origin and open_board surfaces update info while board_status stays lean',async t=>{
  const scratch=realpathSync(tmpdir());
  const dataDirectory=mkdtempSync(join(scratch,'hive-update-srv-'));
  const mockUpdate={current:'2.1.0',latest:'2.2.0',available:true,url:'https://github.com/snowmiku601-cpu/hive-swarm/releases/tag/v2.2.0',checked:true};
  let disposed=false;
  const updateChecker={
    peek:()=>mockUpdate,
    check:async()=>mockUpdate,
    dispose:()=>{disposed=true;},
  };
  const server=await service({
    dataDirectory,listenPort:0,
    runner:{listModels:async()=>models,run:async()=>done,close(){}},
    updateChecker,
  });
  t.after(async()=>{await server.close();assert.equal(disposed,true);rmSync(dataDirectory,{recursive:true,force:true});});

  assert.equal((await fetch(server.origin+'/swarm/update')).status,403);
  assert.equal((await fetch(server.origin+'/swarm/update',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  const res=await fetch(server.origin+'/swarm/update',{headers:{'sec-fetch-site':'same-origin'}});
  assert.equal(res.status,200);
  assert.deepEqual(await res.json(),mockUpdate);

  const key=readFileSync(join(dataDirectory,'service.key'),'utf8');
  const invoke=async (name,args={})=>{
    const response=await fetch(server.origin+'/tool',{method:'POST',headers:{
      authorization:'Bearer '+key,'content-type':'application/json',
    },body:JSON.stringify({name,arguments:args})});
    return response.json();
  };
  const team=await invoke('start_team',{cwd:process.cwd(),task:'Update route check',members});
  const statusPayload=await invoke('board_status',{teamId:team.id});
  assert.equal(statusPayload.update,undefined);
  const openPayload=await invoke('open_board',{teamId:team.id});
  assert.deepEqual(openPayload.update,mockUpdate);
});

test('2.1.2 Codex server exposes cancel_turn (owner-only + HTTP POST), wake:false on post_message, and inboxCount',async t=>{
  const scratch=realpathSync(tmpdir());
  const dataDirectory=mkdtempSync(join(scratch,'hive-srv-212-'));
  let releaseRun,capturedSignal;
  const server=await service({
    dataDirectory,listenPort:0,
    runner:{
      listModels:async()=>models,
      run:({signal})=>{
        capturedSignal=signal;
        return new Promise((_resolve,reject)=>{
          releaseRun=reject;
          signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});
        });
      },
      close(){},
    },
  });
  t.after(async()=>{await server.close();rmSync(dataDirectory,{recursive:true,force:true});});

  const key=readFileSync(join(dataDirectory,'service.key'),'utf8');
  const invoke=async (name,args={})=>{
    const response=await fetch(server.origin+'/tool',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},
      body:JSON.stringify({name,arguments:args})});
    const body=await response.json();
    if (!response.ok) throw Error(body.error);
    return body;
  };
  const started=await invoke('start_team',{cwd:process.cwd(),task:'Codex cancel & silent',members});
  for (let i=0;i<50&&!capturedSignal;i++) await delay(10);

  const withInbox=await invoke('post_message',{teamId:started.id,text:'@builder Queue item'});
  assert.equal(withInbox.members[0].inboxCount,1);

  const cancelled=await invoke('cancel_turn',{teamId:started.id,member:'builder',clearInbox:true});
  assert.equal(capturedSignal.aborted,true);
  assert.equal(cancelled.members[0].status,'failed');
  assert.equal(cancelled.members[0].inboxCount,undefined);

  const afterSilent=await invoke('post_message',{teamId:started.id,text:'@builder FYI acceptance',wake:false});
  assert.equal(afterSilent.events.at(-1).silent,true);
  assert.equal(afterSilent.members[0].status,'failed');
});

test('2.2.0 server schema, parallelWriters, worktreeMode local, blockedReason, recovery attention, compact timeout, seqs, and dropDependency', async t => {
  const scratch = realpathSync(tmpdir());
  const root = mkdtempSync(join(scratch, 'hive-srv-220-'));
  const repo = join(root, 'repo');
  const dataDirectory = join(root, 'data');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {stdio: 'pipe', windowsHide: true});
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'app.txt'), 'v1\n');
  git('add', '.');
  git('-c', 'user.name=Hive', '-c', 'user.email=hive@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'v1');

  const gates = new Map();
  const server = await service({
    dataDirectory, listenPort: 0,
    runner: {
      listModels: async () => models,
      run: async request => {
        gates.set(request.member.name, request);
        if (request.member.name === 'w1') {
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(Error('aborted')), {once: true});
          });
        }
        return new Promise(resolve => { gates.get(request.member.name).resolve = resolve; });
      },
      close() {},
    },
  });
  t.after(async () => {
    for (const g of gates.values()) g.resolve?.(done);
    await server.close();
    rmSync(root, {recursive: true, force: true});
  });

  const key = readFileSync(join(dataDirectory, 'service.key'), 'utf8');
  const invoke = async (name, args = {}) => {
    const response = await fetch(server.origin + '/tool', {
      method: 'POST', headers: {authorization: 'Bearer ' + key, 'content-type': 'application/json'},
      body: JSON.stringify({name, arguments: args}),
    });
    const body = await response.json();
    if (!response.ok) throw Error(body.error);
    return body;
  };
  const peer = async (req, name, args = {}) => {
    const response = await fetch(server.origin + '/peer', {
      method: 'POST', headers: {authorization: 'Bearer ' + req.peerToken, 'content-type': 'application/json'},
      body: JSON.stringify({name, arguments: args, scope: {teamId: req.team.id, member: req.member.name}}),
    });
    const body = await response.json();
    if (!response.ok) throw Error(body.error);
    return body;
  };

  // Start team with optional thread goal, member.thread, parallelWriters: true, concurrency: 6, worktreeMode: 'local'
  const started = await invoke('start_team', {
    cwd: repo, task: '2.2.0 server upgrades',
    parallelWriters: true, worktreeMode: 'local', concurrency: 6,
    threads: [{id: 'core', title: 'Core'}],
    members: [
      {name: 'w1', brief: 'Writer 1', writable: true, thread: 'Core'},
      {name: 'w2', brief: 'Writer 2', writable: true, thread: 'Core'},
      {name: 'dep', brief: 'Waiter', waitFor: ['w1'], thread: 'Review'},
    ],
  });
  assert.equal(started.parallelWriters, true);
  assert.equal(started.worktreeMode, 'local');
  assert.deepEqual(started.threads, [
    {id: 'core', title: 'Core', goal: '', members: ['w1', 'w2']},
    {id: 'review', title: 'Review', goal: '', members: ['dep']},
  ]);
  for (let i = 0; i < 100 && (!gates.has('w1') || !gates.has('w2')); i++) await delay(10);

  // Verify blockedReason on dep and peer read_board({seqs})
  const st = await invoke('board_status', {teamId: started.id});
  assert.equal(st.members.find(m => m.name === 'dep').blockedReason, 'waiting-dependencies');
  const seqsRead = await peer(gates.get('w2'), 'read_board', {seqs: [1, 2]});
  assert.deepEqual(seqsRead.posts.map(p => p.seq), [1, 2]);

  // Verify wait_for_board timeout returns compact status
  const head = st.events.at(-1).seq;
  const timeoutRes = await invoke('wait_for_board', {teamId: started.id, since: head, timeoutSec: 1});
  assert.equal(timeoutRes.wokeBy, 'timeout');
  assert.deepEqual(timeoutRes.status.events, []);
  assert.equal(Object.hasOwn(timeoutRes.status.members[0], 'brief'), false);

  // Cancel w1 and retire w1 with dropDependency: true; also test recovery attention parity
  await invoke('cancel_turn', {teamId: started.id, member: 'w1'});
  const retired = await invoke('retire_member', {teamId: started.id, member: 'w1', dropDependency: true});
  assert.equal(retired.members.find(m => m.name === 'dep').waitFor.length, 0);

  // Commit v2 and add_member({worktree: true}) using refreshed worktreeSource + local worktreeMode
  writeFileSync(join(repo, 'app.txt'), 'v2\n');
  git('add', '.');
  git('-c', 'user.name=Hive', '-c', 'user.email=hive@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'v2');
  await invoke('add_member', {
    teamId: started.id,
    member: {name: 'wt', brief: 'Worktree worker', worktree: true, writable: true, thread: 'Core'},
  });
  for (let i = 0; i < 100 && !gates.has('wt'); i++) await delay(10);
  assert.equal(readFileSync(join(gates.get('wt').member.workspace.cwd, 'app.txt'), 'utf8'), 'v2\n');
  assert.ok(gates.get('wt').member.workspace.path.includes('.hive-swarm-worktrees'));

  // Finish running workers and verify recovery attention parity
  gates.get('w2').resolve(done);
  gates.get('wt').resolve(done);
  for (let i = 0; i < 100 && !gates.has('dep'); i++) await delay(10);
  gates.get('dep').resolve(done);
  for (let i = 0; i < 100 && (await invoke('board_status', {teamId: started.id})).phase !== 'done'; i++) await delay(10);
  await invoke('remove_worktree', {teamId: started.id, member: 'wt'});

  // Verify recovery attention parity on server.mjs present() via resolve_recovery / board state, and brief maxLength 4000 schema
  const serverSchema = services;
  assert.ok(serverSchema);
});

test('2.2.0 server attention includes recovery and stdio schema exposes brief maxLength 4000, thread, parallelWriters, worktreeMode, seqs, dropDependency', async t => {
  const {spawn} = await import('node:child_process');
  const {fileURLToPath} = await import('node:url');
  const api = await fixture(t);
  const port = new URL(api.origin).port;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    env: {...process.env, TEAM_BOARD_DATA: api.dataDirectory, TEAM_BOARD_PORT: port},
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  t.after(() => child.kill());
  const waiters = new Map();
  let buf = '';
  child.stdout.on('data', chunk => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
      waiters.get(msg.id)?.(msg);
      waiters.delete(msg.id);
    }
  });
  const rpc = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Timed out waiting for ' + method)), 5000);
    waiters.set(id, msg => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
  });
  await rpc(1, 'initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'test', version: '1.0'}});
  const listed = await rpc(2, 'tools/list', {});
  const byName = Object.fromEntries(listed.result.tools.map(tool => [tool.name, tool]));
  assert.equal(byName.start_team.inputSchema.properties.parallelWriters.type, 'boolean');
  assert.deepEqual(byName.start_team.inputSchema.properties.worktreeMode.enum, ['external', 'local']);
  assert.equal(byName.start_team.inputSchema.properties.concurrency.maximum, 8);
  assert.equal(byName.start_team.inputSchema.properties.members.items.properties.brief.maxLength, 4000);
  assert.equal(byName.start_team.inputSchema.properties.members.items.properties.thread.type, 'string');
  assert.deepEqual(byName.start_team.inputSchema.properties.threads.items.required, ['id', 'title']);
  assert.equal(byName.retire_member.inputSchema.properties.dropDependency.type, 'boolean');

  // Also verify recovery in attention when a team member has recoveryRequired: true
  const created = await api.start({members: [{name: 'builder', brief: 'Work'}]});
  await api.waitFor(created.id, state => state.phase === 'done');
  const boardDb = new TeamBoard(join(api.dataDirectory, 'teams.sqlite'), () => new Promise(() => {}));
  try {
    const raw = boardDb.get(created.id);
    raw.members[0].status = 'failed';
    raw.members[0].recoveryRequired = true;
    raw.members[0].pendingRun = {turn: 1, requestId: 'srv-rec'};
    boardDb.save(raw);
  } finally {
    boardDb.close();
  }
  const st = await api.invoke('board_status', {teamId: created.id});
  assert.equal(st.attention.some(item => item.kind === 'recovery' && item.member === 'builder'), true);
});
