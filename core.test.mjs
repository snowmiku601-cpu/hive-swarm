import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createSwarmApplication,createUpdateChecker,isNewerVersion,parseSemver} from './core.mjs';

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

test('the host application dispatches a worktree worker using its member name and persisted owned checkout',async t=>{
  const {mkdirSync,writeFileSync,readFileSync}=await import('node:fs');const {execFileSync}=await import('node:child_process');
  const root=mkdtempSync(join(tmpdir(),'hive-core-worktree-'));const repo=join(root,'repo');mkdirSync(repo);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe',windowsHide:true});
  git('init','-q');writeFileSync(join(repo,'value.txt'),'committed fixture');git('add','.');
  git('-c','user.name=Hive tests','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-qm','base');
  const calls=[];const app=createSwarmApplication({dataDirectory:join(root,'state'),host:'deepseek-harness',
    workspaceAllowed:()=>true,runner:{run:async request=>{calls.push(request);return {state:'done',message:'Checkout verified.',notify:[],waitFor:[]}},close:async()=>{}}});
  try{const team=await app.command('start_team',{cwd:repo,task:'Owned worktree',members:[{name:'builder',brief:'Inspect checkout',worktree:true}]});
    for(let i=0;i<500&&!calls.length;i++){if(app.board.get(team.id).members[0].status==='failed')break;await delay(10)}
    assert.equal(calls.length,1,app.board.get(team.id).events.at(-1).text);
    assert.equal(readFileSync(join(calls[0].member.workspace.cwd,'value.txt'),'utf8'),'committed fixture');
    assert.notEqual(calls[0].member.workspace.cwd,repo);
  }finally{await app.close();rmSync(root,{recursive:true,force:true})}
});

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

test('native view waits receive live activity without a new post or model turn',async t=>{
  const {app,calls}=fixture(t);
  const team=await app.command('start_team',startArgs());await delay(5);
  const initial=(await app.snapshot({teamId:team.id})).team;
  const head=initial.events.at(-1).seq;
  const update=app.waitForUpdate({teamId:team.id,since:head,revision:initial.revision,timeoutSec:1});
  await delay(5);
  calls[0].onActivity({kind:'tool',label:'Inspect fixture',detail:'Started',time:new Date().toISOString()});
  const value=await update;
  assert.equal(value.head,head);
  assert.notEqual(value.revision,initial.revision);
  assert.equal(value.status.activity.builder.steps.at(-1).label,'Inspect fixture');
  assert.equal(calls.length,1);
});

test('start_team, add_member and set_member_model validate inherited effort and reset incompatible effort on model switch',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'hive-core-models-'));
  const runner={
    listModels:async()=>[
      {id:'fixture/heavy',label:'Heavy',efforts:['low','max'],defaultEffort:'max'},
      {id:'fixture/lite',label:'Lite',efforts:['low'],defaultEffort:'low'},
    ],
    run:async()=>({state:'done',message:'[done] Verified.',notify:[],waitFor:[]}),
    close:async()=>{},
  };
  const app=createSwarmApplication({dataDirectory:directory,host:'deepseek-harness',runner,workspaceAllowed:async cwd=>cwd===workspace});
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  await assert.rejects(app.command('start_team',{cwd:workspace,task:'Check effort validation',model:'fixture/heavy',effort:'max',
    members:[{name:'builder',brief:'Inspect',model:'fixture/lite'}]}),/effort/i);
  const created=await app.command('start_team',{cwd:workspace,task:'Check effort switch',model:'fixture/heavy',effort:'max',
    members:[{name:'builder',brief:'Inspect'}]});
  await delay(20);
  await assert.rejects(app.command('add_member',{teamId:created.id,member:{name:'helper',brief:'Check',model:'fixture/lite'}}),/effort/i);
  const switched=await app.command('set_member_model',{teamId:created.id,member:'builder',model:'fixture/lite'});
  assert.equal(switched.members[0].model,'fixture/lite');
  assert.equal(switched.members[0].effort,undefined);
});

test('resolve_recovery is owner-only and unblocks a member with an unconfirmed run',async t=>{
  const {app}=fixture(t);
  const team=await app.command('start_team',startArgs());await delay(10);
  const saved=app.board.get(team.id);
  saved.members[0].status='failed';
  saved.members[0].recoveryRequired=true;
  saved.members[0].pendingRun={turn:1,requestId:'stuck-1'};
  app.board.save(saved);
  await assert.rejects(app.command('resolve_recovery',{teamId:team.id,member:'builder',action:'dismiss'},
    {actor:{teamId:team.id,member:'builder',turn:1}}),/not available|running turn/i);
  const resolved=await app.command('resolve_recovery',{teamId:team.id,member:'builder',action:'dismiss'});
  assert.equal(resolved.members[0].recoveryRequired,false);
  assert.equal(resolved.members[0].status,'failed');
});

test('active workers can call list_models to verify host models without coordinator privileges',async t=>{
  const {app}=fixture(t);
  const team=await app.command('start_team',startArgs());await delay(10);
  const models=await app.command('list_models',{},{actor:{teamId:team.id,member:'builder',turn:1}});
  assert.equal(models.models[0].id,'fixture/model');
});

test('trusted context.parentSessionId, fork: coordinator, executionMode and subagentName project cleanly and reject spoofed args',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'hive-core-v2-'));
  const seen=[];
  const runner={
    listModels:async()=>[{id:'fixture/model',label:'Fixture',efforts:['low'],defaultEffort:'low'}],
    run:async request=>{
      seen.push({name:request.member.name,parentSessionId:request.team.parentSessionId,forkSource:request.member.forkSource});
      request.remember({
        threadId:'child-'+request.member.name,
        executionMode:'subagent',
        subagentName:'hive-'+request.member.name,
        ...(request.member.forkSource?{forkSource:null}:{}),
      });
      return {state:'done',message:'[done] Checked.',notify:[],waitFor:[]};
    },
    close:async()=>{},
  };
  const app=createSwarmApplication({dataDirectory:directory,host:'deepseek-harness',runner,workspaceAllowed:async cwd=>cwd===workspace});
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});

  await assert.rejects(
    app.command('start_team',{...startArgs(),parentSessionId:'spoofed-parent'},{parentSessionId:'trusted-parent'}),
    /host identity|cannot be supplied/i,
  );

  const started=await app.command('start_team',{
    cwd:workspace,task:'Native subagent team',
    members:[{name:'researcher',brief:'Warm start',fork:'coordinator'}],
  },{parentSessionId:'parent-chat-1'});
  assert.equal(started.parentSessionId,'parent-chat-1');
  assert.equal(started.members[0].executionMode,undefined);
  assert.equal(Object.hasOwn(started.members[0],'forkSource'),false);

  for(let i=0;i<100&&seen.length<1;i++) await delay(10);
  assert.deepEqual(seen[0],{name:'researcher',parentSessionId:'parent-chat-1',forkSource:'coordinator'});

  const added=await app.command('add_member',{
    teamId:started.id,member:{name:'reviewer',brief:'Check diff',fork:'coordinator'},
  });
  for(let i=0;i<100&&(await app.snapshot({teamId:started.id})).team.phase!=='done';i++) await delay(10);
  const final=(await app.snapshot({teamId:started.id})).team;
  assert.equal(final.parentSessionId,'parent-chat-1');
  assert.equal(final.members[0].executionMode,'subagent');
  assert.equal(final.members[0].subagentName,'hive-researcher');
  assert.deepEqual(final.members[0].session,{host:'deepseek-harness',id:'child-researcher'});
  assert.equal(final.members[1].executionMode,'subagent');
  assert.equal(final.members[1].subagentName,'hive-reviewer');
  assert.equal(added.members.length,2);

  // Legacy team without executionMode defaults to 'session' when threadId is present.
  const raw=app.board.get(started.id);
  delete raw.members[0].executionMode;
  app.board.save(raw);
  const restored=(await app.snapshot({teamId:started.id})).team;
  assert.equal(restored.members[0].executionMode,'session');
});

test('B4: presentTeam aligns attention with server.mjs (stallIssues only when stalled; hard blockers & budget always preserved)',async t=>{
  const {presentTeam}=await import('./core.mjs');
  const baseTeam={
    id:'team-b4',host:'deepseek-harness',title:'B4',cwd:workspace,task:'Check attention',
    paused:false,turns:1,turnLimit:8,channels:[{name:'main',archived:false}],
    members:[
      {name:'alpha',role:'worker',status:'working',writable:false,waitFor:[],channels:[]},
      {name:'beta',role:'worker',status:'failed',writable:false,waitFor:[],channels:[],recoveryRequired:true,inputRequired:true},
    ],
    events:[
      {seq:1,kind:'message',author:'alpha',text:'Unaddressed message while working',targets:[]},
    ],
    lastDispatchSeq:0,
  };
  const working=presentTeam(baseTeam);
  assert.equal(working.phase,'working');
  assert.equal(working.attention.some(i=>i.kind==='unaddressed'),false);
  assert.equal(working.attention.some(i=>i.kind==='input'),true);
  assert.equal(working.attention.some(i=>i.kind==='recovery'),true);
  assert.equal(working.attention.some(i=>i.kind==='failed'),true);

  const doneTeam={
    ...baseTeam,
    members:[{name:'alpha',role:'worker',status:'done',writable:false,waitFor:[],channels:[]}],
  };
  const doneView=presentTeam(doneTeam);
  assert.equal(doneView.phase,'done');
  assert.deepEqual(doneView.attention,[]);

  const budgetTeam={
    ...baseTeam,turns:8,turnLimit:8,
    members:[{name:'alpha',role:'worker',status:'waiting',writable:false,waitFor:[],channels:[]}],
  };
  const budgetView=presentTeam(budgetTeam);
  assert.equal(budgetView.phase,'budget');
  assert.equal(budgetView.attention[0].kind,'budget');
  assert.equal(budgetView.attention.some(i=>i.kind==='unaddressed'),false);

  const stalledTeam={
    ...baseTeam,
    members:[{name:'alpha',role:'worker',status:'waiting',writable:false,waitFor:[],channels:[]}],
  };
  const stalledView=presentTeam(stalledTeam);
  assert.equal(stalledView.phase,'stalled');
  assert.equal(stalledView.attention.some(i=>i.kind==='unaddressed'),true);
});

test('2.1.0 core projections: goalLine, taskLabel, dual tasks, safe screenshot URLs and workspace-scoped screenshot reader',async t=>{
  const {mkdirSync,writeFileSync}=await import('node:fs');
  const root=mkdtempSync(join(tmpdir(),'hive-core-210-'));
  const cwd=join(root,'repo');
  const dataDir=join(root,'state');
  mkdirSync(join(cwd,'shots'),{recursive:true});
  const png=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  writeFileSync(join(cwd,'shots','view.png'),png);
  writeFileSync(join(root,'outside.png'),png);

  const app=createSwarmApplication({
    dataDirectory:dataDir,host:'deepseek-harness',
    runner:{listModels:async()=>[{id:'fixture/model',label:'Fixture',efforts:['max'],defaultEffort:'max'}],run:async()=>new Promise(()=>{}),close:async()=>{}},
    workspaceAllowed:async dir=>dir===realpathSync(cwd),
  });
  t.after(async()=>{await app.close();rmSync(root,{recursive:true,force:true});});

  const started=await app.command('start_team',{
    cwd,task:'Project 2.1.0 fields',goalLine:'Polish 2.1.0 schema',
    members:[{name:'builder',brief:'Implement 2.1.0',taskLabel:'Schema & endpoints'}],
  });
  assert.equal(started.goalLine,'Polish 2.1.0 schema');
  assert.equal(started.members[0].taskLabel,'Schema & endpoints');

  const updated=await app.command('set_team_plan',{
    teamId:started.id,
    goalLine:'Updated 2.1.0 goal',
    tasks:[{member:'builder',label:'Updated via array'}],
    threads:[{id:'t1',title:'Schema',goal:'Ship 2.1.0',members:['builder']}],
  });
  assert.equal(updated.goalLine,'Updated 2.1.0 goal');
  assert.equal(updated.members[0].taskLabel,'Updated via array');
  assert.equal(updated.threads.length,1);

  const mapUpdated=await app.command('set_team_plan',{
    teamId:started.id,
    tasks:{builder:'Updated via object map'},
  });
  assert.equal(mapUpdated.members[0].taskLabel,'Updated via object map');

  const posted=await app.command('post_message',{
    teamId:started.id,
    text:'Check image:\nScreenshot: shots/view.png | Overview preview\nScreenshot: ../outside.png | Blocked traversal',
  });
  const seq=posted.events.at(-1).seq;
  assert.equal(posted.screenshots.length,2);
  assert.deepEqual(posted.screenshots[0],{
    id:seq+':0',seq,index:0,author:'user',caption:'Overview preview',time:posted.events.at(-1).time,
    url:'/api/hive-swarm/v1/screenshot?teamId='+encodeURIComponent(started.id)+'&seq='+seq+'&index=0',
  });
  assert.equal(Object.hasOwn(posted.screenshots[0],'path'),false);

  const file=await app.screenshot({teamId:started.id,seq,index:0});
  assert.equal(file.contentType,'image/png');
  assert.deepEqual(file.body,png);
  assert.equal(await app.screenshot({teamId:started.id,seq,index:1}),null);
});

test('parseSemver, isNewerVersion, and createUpdateChecker compare tags, cache results, deduplicate fetches, and fail silently offline',async()=>{
  assert.equal(isNewerVersion('2.1.0','2.1.1'),true);
  assert.equal(isNewerVersion('2.1.0','2.2.0'),true);
  assert.equal(isNewerVersion('2.1.0','3.0.0'),true);
  assert.equal(isNewerVersion('2.1.0','2.1.0'),false);
  assert.equal(isNewerVersion('2.1.1','2.1.0'),false);
  assert.equal(isNewerVersion('2.1.0-rc.1','2.1.0'),true);
  assert.equal(isNewerVersion('2.1.0','2.1.0-rc.1'),false);
  assert.equal(isNewerVersion('2.1.0','2.2.0-rc.1'),true);
  assert.equal(isNewerVersion('2.1.0','javascript:alert(1)'),false);
  assert.equal(parseSemver('invalid'),null);

  // Disabled automatically in test context unless enabled: true
  const disabledChecker=createUpdateChecker({packageName:'hive-swarm',currentVersion:'2.1.0',fetchImpl:async()=>{throw Error('Must not fetch');}});
  const disabledStatus=disabledChecker.peek({start:true});
  assert.equal(disabledStatus.available,false);
  assert.equal(disabledStatus.checked,true);

  // Multi-tag dist-tags check (pick highest of latest & next), caching & singleflight dedupe
  let clock=1000,calls=0,tagPayload={latest:'1.8.0',next:'2.2.0'};
  const checker=createUpdateChecker({
    packageName:'dsh-hive-swarm',currentVersion:'2.1.0',tags:['latest','next'],
    enabled:true,ttlMs:1000,errorTtlMs:300,now:()=>clock,
    fetchImpl:async url=>{
      calls++;
      assert.equal(url,'https://registry.npmjs.org/-/package/dsh-hive-swarm/dist-tags');
      await delay(15);
      return {ok:true,json:async()=>tagPayload};
    },
  });
  const pendingPeek=checker.peek({start:true});
  assert.equal(pendingPeek.checked,false);
  const [first,second]=await Promise.all([checker.check(),checker.check()]);
  assert.equal(calls,1,'concurrent checks share one inflight fetch');
  assert.equal(first.available,true);
  assert.equal(first.latest,'2.2.0');
  assert.equal(first.url,'https://github.com/snowmiku601-cpu/hive-swarm/releases/tag/v2.2.0');
  assert.equal(second.latest,'2.2.0');

  // Cached within TTL
  await checker.check();
  assert.equal(calls,1);

  // Rejects malformed tags without throwing, and fails silently offline while preserving last known tag
  clock+=1500;
  tagPayload={latest:'not-a-semver',next:'https://evil.test/1.2.3'};
  const invalidRes=await checker.check();
  assert.equal(calls,2);
  assert.equal(invalidRes.available,false);
  assert.equal(invalidRes.latest,null);

  clock+=1500;
  const offlineChecker=createUpdateChecker({
    packageName:'hive-swarm',currentVersion:'2.1.0',tags:['latest'],
    enabled:true,ttlMs:1000,errorTtlMs:400,now:()=>clock,
    fetchImpl:async()=>{calls++;throw Error('ECONNREFUSED');},
  });
  const offline=await offlineChecker.check();
  assert.equal(offline.available,false);
  assert.equal(offline.checked,true);
  assert.equal(offline.url,null);
  await offlineChecker.check();
  assert.equal(calls,3,'backs off within errorTtlMs');
  checker.dispose();
  offlineChecker.dispose();
});

test('2.1.2 cancel_turn is owner-only, exposes inboxCount while working, and post_message supports wake:false',async t=>{
  let releaseWorker,workerSignal;
  const dir=mkdtempSync(join(tmpdir(),'hive-core-212-'));
  const app=createSwarmApplication({
    dataDirectory:dir,host:'deepseek-harness',
    runner:{
      listModels:async()=>[{id:'fixture/model',label:'Fixture',efforts:['low'],defaultEffort:'low'}],
      run:({signal})=>{
        workerSignal=signal;
        return new Promise((_res,rej)=>{releaseWorker=()=>rej(Error('aborted'));signal.addEventListener('abort',releaseWorker,{once:true});});
      },
    },
    workspaceAllowed:async()=>true,
  });
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});

  const created=await app.command('start_team',{cwd:process.cwd(),task:'Cancel & silent test',members:[{name:'builder',brief:'Work'}]});
  await delay(10);
  assert.equal(Object.hasOwn(created.members[0],'inboxCount'),false);

  const afterQueued=await app.command('post_message',{teamId:created.id,text:'@builder Queued msg'});
  assert.equal(afterQueued.members[0].inboxCount,1);

  await assert.rejects(
    app.command('cancel_turn',{teamId:created.id,member:'builder'},{actor:{teamId:created.id,member:'builder',turn:1}}),
    /not available|running turn/i,
  );

  const cancelled=await app.command('cancel_turn',{teamId:created.id,member:'builder',clearInbox:true});
  assert.equal(workerSignal.aborted,true);
  assert.equal(cancelled.members[0].status,'failed');
  assert.equal(Object.hasOwn(cancelled.members[0],'inboxCount'),false);

  // Silent post_message (wake:false) never re-queues or sets inboxCount
  const afterSilent=await app.command('post_message',{teamId:created.id,text:'@builder FYI only',wake:false});
  assert.equal(afterSilent.events.at(-1).silent,true);
  assert.equal(Object.hasOwn(afterSilent.members[0],'inboxCount'),false);
  assert.equal(afterSilent.members[0].status,'failed');
});

test('2.2.0 core projections: parallelWriters, worktreeMode, blockedReason, addedBy, waitForBoard 900s + compact timeout, onRunSettled, seqs, dropDependency, and refreshed worktreeSource', async t => {
  const {mkdirSync, writeFileSync, readFileSync, existsSync} = await import('node:fs');
  const {execFileSync} = await import('node:child_process');
  const settledCalls = [];
  const root = mkdtempSync(join(tmpdir(), 'hive-core-220-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {stdio: 'pipe', windowsHide: true});
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'v.txt'), 'v1\n');
  git('add', '.');
  git('-c', 'user.name=Hive', '-c', 'user.email=hive@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'v1');

  const gates = new Map();
  const app = createSwarmApplication({
    dataDirectory: join(root, 'state'),
    host: 'deepseek-harness',
    workspaceAllowed: async () => true,
    runner: {
      listModels: async () => [{id: 'fixture/model', label: 'Fixture', efforts: ['max'], defaultEffort: 'max'}],
      run: request => new Promise((resolve, reject) => {
        gates.set(request.member.name, {request, resolve, reject});
        request.signal.addEventListener('abort', () => reject(request.signal.reason), {once: true});
      }),
      onRunSettled: async payload => { settledCalls.push(payload); },
      close: async () => {},
    },
  });
  t.after(async () => {
    for (const g of gates.values()) g.resolve({state: 'done', message: 'cleanup', notify: [], waitFor: []});
    await app.close();
    rmSync(root, {recursive: true, force: true});
  });

  // 1. blockedReason: shared-writer-active, concurrency-limit, waiting-dependencies, recovery-required + addedBy projection
  const team = await app.command('start_team', {
    cwd: repo,
    task: 'Blocked reasons & worktree refresh',
    worktreeMode: 'local',
    concurrency: 2,
    threads: [{id: 'eng', title: 'Engineering', members: ['w1']}],
    members: [
      {name: 'w1', brief: 'Write 1', writable: true},
      {name: 'w2', brief: 'Write 2', writable: true},
      {name: 'r1', brief: 'Read 1'},
      {name: 'r2', brief: 'Read 2'},
      {name: 'dep', brief: 'Waiter', waitFor: ['w1']},
    ],
  });
  assert.equal(team.parallelWriters, false);
  assert.equal(team.worktreeMode, 'local');
  for (let i = 0; i < 100 && (!gates.has('w1') || !gates.has('r1')); i++) await delay(10);
  const status = await app.command('board_status', {teamId: team.id});
  const byName = Object.fromEntries(status.members.map(m => [m.name, m]));
  assert.equal(byName.w1.blockedReason, undefined);
  assert.equal(byName.r2.blockedReason, 'concurrency-limit');
  assert.equal(byName.dep.blockedReason, 'waiting-dependencies');

  // Finish r1 so concurrency slot frees up; w2 is still blocked by shared-writer-active!
  gates.get('r1').resolve({state: 'done', message: '[done] r1 ok', notify: [], waitFor: []});
  for (let i = 0; i < 100 && !gates.has('r2'); i++) await delay(10);
  const status2 = await app.command('board_status', {teamId: team.id});
  assert.equal(status2.members.find(m => m.name === 'w2').blockedReason, 'shared-writer-active');

  // DSH wait_for_board supports timeoutSec > 55 (up to 900) and emits compact status on timeout
  const head = status2.events.at(-1).seq;
  const waitedTimeout = await app.command('wait_for_board', {teamId: team.id, since: head, timeoutSec: 1});
  assert.equal(waitedTimeout.wokeBy, 'timeout');
  assert.deepEqual(waitedTimeout.status.events, []);
  assert.equal(Object.hasOwn(waitedTimeout.status.members[0], 'brief'), false);
  // Confirm 600s is accepted (abort via signal immediately after starting)
  const ac = new AbortController();
  const longWait = app.command('wait_for_board', {teamId: team.id, since: head, timeoutSec: 600}, {signal: ac.signal});
  ac.abort();
  await assert.rejects(longWait, {name: 'AbortError'});

  // cancel_turn invokes runner.onRunSettled
  await app.command('cancel_turn', {teamId: team.id, member: 'w1', clearInbox: true});
  assert.deepEqual(settledCalls.at(-1), {teamId: team.id, member: 'w1', turn: 1, reason: 'Worker turn cancelled.', state: 'cancelled'});

  // recovery-required blockedReason + resolve_recovery(dismiss) invokes runner.onRunSettled
  const saved = app.board.get(team.id);
  saved.members.find(m => m.name === 'w1').recoveryRequired = true;
  saved.members.find(m => m.name === 'w1').pendingRun = {turn: 1, requestId: 'rec-1'};
  app.board.save(saved);
  assert.equal((await app.command('board_status', {teamId: team.id})).members.find(m => m.name === 'w1').blockedReason, 'recovery-required');
  await app.command('resolve_recovery', {teamId: team.id, member: 'w1', action: 'dismiss'});
  assert.equal(settledCalls.length, 2);
  assert.equal(settledCalls.at(-1).state, 'cancelled');

  // Worker adds helper -> addedBy projected & thread inherited; read_board({seqs}) works
  const r2Turn = gates.get('r2').request.member.lastTurn;
  const helperAdded = await app.command('add_member', {
    teamId: team.id,
    member: {name: 'r2-helper', brief: 'Read helper'},
  }, {actor: {teamId: team.id, member: 'r2', turn: r2Turn}});
  assert.equal(helperAdded.members.find(m => m.name === 'r2-helper').addedBy, 'r2');
  const seqsRes = await app.command('read_board', {teamId: team.id, seqs: [1]}, {actor: {teamId: team.id, member: 'r2', turn: r2Turn}});
  assert.deepEqual(seqsRes.posts.map(p => p.seq), [1]);

  // retire_member({dropDependency: true}) drops w1 from dep.waitFor
  await app.command('retire_member', {teamId: team.id, member: 'w1', dropDependency: true});
  assert.equal(app.board.get(team.id).members.find(m => m.name === 'dep').waitFor.length, 0);

  // Finish w2, r2, r2-helper, and dep so concurrency slots open for late-wt
  gates.get('w2').resolve({state: 'done', message: '[done] w2 ok', notify: [], waitFor: []});
  gates.get('r2').resolve({state: 'done', message: '[done] r2 ok', notify: [], waitFor: []});
  for (let i = 0; i < 100 && (!gates.has('r2-helper') || !gates.has('dep')); i++) await delay(10);
  gates.get('r2-helper').resolve({state: 'done', message: '[done] h ok', notify: [], waitFor: []});
  gates.get('dep').resolve({state: 'done', message: '[done] dep ok', notify: [], waitFor: []});
  for (let i = 0; i < 100 && app.board.get(team.id).members.some(m => m.status === 'working'); i++) await delay(10);

  // Advance repo HEAD to v2, then add_member({worktree: true}) refreshes worktreeSource & uses local mode!
  writeFileSync(join(repo, 'v.txt'), 'v2\n');
  git('add', '.');
  git('-c', 'user.name=Hive', '-c', 'user.email=hive@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'v2');
  await app.command('add_member', {
    teamId: team.id,
    member: {name: 'late-wt', brief: 'Late worktree', worktree: true, writable: true, thread: 'Engineering'},
  });
  for (let i = 0; i < 100 && !gates.has('late-wt'); i++) await delay(10);
  const wtReq = gates.get('late-wt').request;
  assert.equal(readFileSync(join(wtReq.member.workspace.cwd, 'v.txt'), 'utf8'), 'v2\n');
  assert.ok(wtReq.member.workspace.path.includes('.hive-swarm-worktrees'));
  gates.get('late-wt').resolve({state: 'done', message: '[done] late ok', notify: [], waitFor: []});
  for (let i = 0; i < 100 && (await app.command('board_status', {teamId: team.id})).phase !== 'done'; i++) await delay(10);
  await app.command('remove_worktree', {teamId: team.id, member: 'late-wt'});
  assert.equal(existsSync(wtReq.member.workspace.path), false);
});
