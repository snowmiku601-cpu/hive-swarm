import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';

const tick = () => new Promise(resolve => setImmediate(resolve));
const controllerModule = () => import('./client/controller.mjs');
const team = (id = 'one', seq = 8) => ({id, host:'deepseek-harness', title:'Release qualification', cwd:'D:/fixture project',
  task:'Qualify the native package', paused:false, phase:'working', turns:2, turnLimit:8,
  channels:[{name:'main'}], attention:[], activity:{},
  members:[{name:'alpha', status:'waiting', brief:'Inspect packaging', model:'xingchi/gpt-6.1-sol', effort:'max',
    writable:false, session:{host:'deepseek-harness',id:'owned-alpha'}, threadId:'owned-alpha', pendingWaitFor:['beta']}],
  events:[{seq:seq-1,kind:'brief',author:'coordinator',text:'Inspect packaging',targets:['alpha'],channel:'main'},
    {seq,kind:'message',author:'alpha',text:'Package verified',targets:['coordinator'],channel:'main'}]});

function transport(overrides={}) {
  const calls=[];
  const methods=new Map([['hive-swarm/v1/snapshot','snapshot'],['hive-swarm/v1/command','command'],['hive-swarm/v1/events','wait']]);
  const rpc={call:async (path,endpoint,payload,signal) => {
    assert.equal(path,'/api');
    const method=methods.get(endpoint);assert.ok(method,'Unexpected Connection RPC endpoint: '+endpoint);
    calls.push({path,endpoint,method,payload,signal});
    if(overrides[method]) return {ok:true,value:await overrides[method](payload,signal)};
    if(method==='snapshot')return {ok:true,value:{teams:[team()],team:payload.teamId?team(payload.teamId):null}};
    if(method==='wait')return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    return {ok:true,value:team(payload.args.teamId)};
  }};
  return {connection:{rpc},calls};
}

test('opening reads the scoped catalog without selecting the latest team or starting work',async()=>{
  const {createController}=await controllerModule();const t=transport();
  const c=createController({...t,sessionId:'parent-chat'});const release=c.retain();await tick();
  assert.equal(c.getSnapshot().team,null);assert.equal(c.getSnapshot().teams.length,1);
  assert.equal(c.getSnapshot().sessionId,'parent-chat');assert.deepEqual(t.calls.map(x=>x.method),['snapshot']);
  assert.equal(t.calls[0].endpoint,'hive-swarm/v1/snapshot');assert.deepEqual(t.calls[0].payload,{});
  release();c.dispose();
});

test('linked selection and event waits preserve the server cursor, with one feed for two views',async()=>{
  const {createController}=await controllerModule();let count=0;
  const t=transport({wait:async(_p,signal)=>{
    if(++count===1)return {head:27,posts:[],status:'timeout'};
    return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  const c=createController({...t,teamId:'one',sessionId:'parent-chat'});
  const a=c.retain(),b=c.retain();await tick();await tick();
  assert.deepEqual(t.calls.filter(x=>x.method==='wait').map(x=>x.payload.since),[8,27]);
  assert.ok(t.calls.every(x=>x.method!=='wait'||x.payload.timeoutSec<=55));
  const wait=t.calls.filter(x=>x.method==='wait').at(-1);a();assert.equal(wait.signal.aborted,false);
  b();assert.equal(wait.signal.aborted,true);c.dispose();await tick();
});

test('event waits use the revision for changes without posts and skip redundant snapshots on timeout',async()=>{
  const {createController}=await controllerModule();let current={...team(),revision:'epoch:1'};
  const waits=[];
  const t=transport({snapshot:({teamId})=>({teams:[team()],team:teamId?current:null}),
    wait:(_payload,signal)=>new Promise((resolve,reject)=>{
      waits.push(resolve);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    })});
  const c=createController({...t,teamId:'one'});const off=c.retain();await tick();
  assert.equal(t.calls.at(-1).payload.revision,'epoch:1');
  waits[0]({head:8,posts:[],status:current,revision:'epoch:1',wokeBy:'timeout'});await tick();
  assert.equal(t.calls.filter(x=>x.method==='snapshot').length,1);
  current={...current,paused:true,revision:'epoch:2'};
  waits[1]({head:8,posts:[],status:current,revision:'epoch:2',wokeBy:'update'});await tick();
  assert.equal(t.calls.filter(x=>x.method==='snapshot').length,2);
  assert.equal(c.getSnapshot().team.paused,true);
  assert.deepEqual(t.calls.at(-1).payload,{teamId:'one',since:8,revision:'epoch:2',timeoutSec:50});
  off();c.dispose();
});

test('paged wait events and reconnect gaps enter board history without skipping a page',async()=>{
  const {createController}=await controllerModule();let current=team(),calls=0;
  const firstPage=[{seq:9,kind:'message',author:'alpha',text:'First waiting update'}];
  const secondPage=[{seq:10,kind:'message',author:'alpha',text:'Second waiting update'}];
  const t=transport({snapshot:({teamId})=>({teams:[team()],team:teamId?current:null}),wait:(_p,signal)=>{
    if(++calls===1){current={...team('one',25),revision:'epoch:2'};return {head:25,posts:firstPage,hasMore:true,revision:'epoch:2'};}
    if(calls===2)return {head:25,posts:secondPage,revision:'epoch:2'};
    return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  const c=createController({...t,teamId:'one'});const off=c.retain();await tick();
  assert.deepEqual(t.calls.filter(x=>x.method==='wait').map(x=>x.payload.since),[8,9,25]);
  assert.deepEqual(c.getSnapshot().history.map(event=>event.seq),[7,8,9,10,24,25]);off();c.dispose();
});

test('selection aborts previous reads and stale responses cannot replace the new team',async()=>{
  const {createController}=await controllerModule();let finishOld;
  const t=transport({snapshot:({teamId})=>teamId==='old'?new Promise(r=>{finishOld=r}):{teams:[team('new')],team:teamId?team(teamId):null}});
  const c=createController(t);const off=c.retain();await tick();
  const old=c.selectTeam('old');await tick();const oldRead=t.calls.at(-1);
  await c.selectTeam('new');finishOld({teams:[team('old')],team:team('old')});await old;
  assert.equal(oldRead.signal.aborted,true);assert.equal(c.getSnapshot().team.id,'new');
  off();c.dispose();
});

test('owned actions carry the selected identity and one request id; an uncertain retry reuses it',async()=>{
  const {createController}=await controllerModule();let first=true;
  const t=transport({command:()=>{if(first){first=false;throw Error('Connection lost')}return team()}});
  const c=createController({...t,teamId:'one'});const off=c.retain();await tick();
  await assert.rejects(c.command('pause_team'),/Connection lost/);
  assert.match(c.getSnapshot().error.message,/Connection lost/);
  await c.retryCommand();
  const commands=t.calls.filter(x=>x.method==='command');assert.equal(commands.length,2);
  assert.equal(commands[0].payload.requestId,commands[1].payload.requestId);
  assert.equal(commands[0].payload.args.teamId,'one');assert.equal(commands[0].payload.action,'pause_team');
  assert.ok(commands[0].payload.requestId);off();c.dispose();
});

test('journal and model reads use the owned command bridge, and disposal cancels reads',async()=>{
  const {createController}=await controllerModule();
  const t=transport({command:({action,args},signal)=>{
    if(action==='list_models')return {models:[{id:'xingchi/gpt-6.1-sol',label:'Sol',efforts:['max']}]};
    if(action==='read_journal')return {member:args.member,threadId:'owned-alpha',turns:[{status:'done',steps:['Checked manifest'],report:'Verified'}]};
    return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  const c=createController({...t,teamId:'one'});const off=c.retain();await tick();
  await c.loadModels();assert.equal(c.getSnapshot().models[0].id,'xingchi/gpt-6.1-sol');
  await c.openJournal('alpha');assert.equal(c.getSnapshot().journal.turns[0].report,'Verified');
  assert.equal(t.calls.find(x=>x.payload?.action==='read_journal').payload.args.teamId,'one');
  assert.ok(t.calls.filter(x=>x.method==='command').every(call=>typeof call.payload.requestId==='string'&&call.payload.requestId.length));
  const pending=c.command('resume_team');await tick();off();c.dispose();await assert.rejects(pending);
  assert.ok(t.calls.filter(x=>x.method==='command').at(-1).signal.aborted);
});

test('denied RPC results become persistent actionable errors without a retry loop',async()=>{
  const {createController}=await controllerModule();let calls=0;
  const c=createController({connection:{rpc:{call:async()=>{calls++;return {ok:false,error:{code:'forbidden',message:'Workspace permission denied'}}}}}});
  const off=c.retain();await tick();await tick();assert.equal(calls,1);
  assert.match(c.getSnapshot().error.message,/Workspace permission denied/);assert.equal(c.getSnapshot().loading,false);
  off();c.dispose();
});

test('closing Journal aborts its owned read and late data never reopens it',async()=>{
  const {createController}=await controllerModule();let finish;
  const t=transport({command:()=>new Promise(resolve=>{finish=resolve;})});
  const c=createController({...t,teamId:'one'});const off=c.retain();await tick();
  const request=c.openJournal('alpha');await tick();const read=t.calls.at(-1);
  c.closeJournal();assert.equal(read.signal.aborted,true);
  finish({turns:[{report:'Late data'}]});await request;assert.equal(c.getSnapshot().journal,null);
  off();c.dispose();
});

test('refreshing a read feed never cancels or repeats an in-flight user command',async()=>{
  const {createController}=await controllerModule();let finish;
  const t=transport({command:()=>new Promise(resolve=>{finish=resolve;})});
  const c=createController({...t,teamId:'one'});const off=c.retain();await tick();
  const pending=c.command('pause_team');await tick();const request=t.calls.at(-1);
  c.refresh();await tick();assert.equal(request.signal.aborted,false);
  finish({...team(),paused:true});await pending;
  assert.equal(c.getSnapshot().pending,false);assert.equal(c.getSnapshot().team.paused,true);
  assert.equal(t.calls.filter(call=>call.method==='command').length,1);off();c.dispose();
});

async function loadClient() {
  const {buildClient}=await import('../../scripts/build-dsh-client.mjs');
  const result=await buildClient({write:false});
  const require=[new URL('../../package.json',import.meta.url),import.meta.url,new URL('../../.tmp/dsh-ui-build/package.json',import.meta.url)]
    .map(base=>createRequire(base)).find(candidate=>{
      try{for(const name of ['react','react-test-renderer','react-dom/client','jsdom'])candidate.resolve(name);return true;}
      catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;return false;}
    });
  assert.ok(require,'Run npm ci at the repository root to install the pinned client test dependencies.');
  const React=require('react');let client;
  runInNewContext(result.code,{window:{__ModuleLoader__:{load:({id,factory})=>{
    assert.equal(id,'dsh-hive-swarm');client=factory(name=>{assert.equal(name,'react');return React;});
  }}},AbortController,AbortSignal,DOMException,URL,crypto:globalThis.crypto,setTimeout,clearTimeout,queueMicrotask,console});
  return {client,React,renderer:require('react-test-renderer'),require};
}

function fakeContext(overrides={}) {
  const definitions=new Map([['wallpaper',{id:'wallpaper'}]]),slots=new Map(),effects=[];
  const t=transport(overrides);const panels=[],sessions=[];
  const ctx={...t,layout:{selectPanel:id=>panels.push(id)},
    sidebarRightTabs:{register:def=>{assert.equal(definitions.has(def.id),false);definitions.set(def.id,def);return()=>definitions.delete(def.id)}},
    slots:{inject:(_name,callback)=>callback(),register:(options,component)=>{
      const key=options.name+':'+(options.key??options.id);assert.equal(slots.has(key),false);
      slots.set(key,{options,component});return()=>slots.delete(key);
    }},effect:callback=>{const off=callback();effects.push(off);return off},on:()=>()=>{},
    uiWorkspace:{openSession:id=>{sessions.push(id);}},logger:{warn:()=>{},error:()=>{}}};
  return {ctx,definitions,slots,panels,sessions,dispose:()=>effects.splice(0).reverse().forEach(off=>off?.())};
}

test('the native client declares workspace navigation before opening an owned session',async()=>{
  const {client}=await loadClient();const f=fakeContext();const declared=new Set(client.inject);
  const utilities=new Set(['effect','on','logger']);
  const ctx=new Proxy(f.ctx,{get(target,key){if(typeof key==='string'&&!declared.has(key)&&!utilities.has(key))throw Error('cannot get property '+key+' without inject');return Reflect.get(target,key);}});
  client.apply(ctx);const seat=f.slots.get('sidebar.right.pane.tab:dsh-hive-swarm');
  const controller=seat.options.inject('parent-session').controllerForTeam('one','D:/fixture project');
  const release=controller.retain();await tick();
  try{await controller.openSession('alpha');assert.deepEqual(f.sessions,['owned-alpha']);assert.equal(controller.getSnapshot().error,null);}
  finally{release();f.dispose();}
});

test('real loader registers the canonical bee guide and additive native seats once, then disposes only Hive',async()=>{
  const {client,React,renderer}=await loadClient();const f=fakeContext();
  client.apply(f.ctx);client.apply(f.ctx);
  const def=f.definitions.get('dsh-hive-swarm');assert.equal(def.kind,'hive-swarm');assert.equal(def.title(),'Swarm');
  assert.equal(def.guide.length,1);assert.equal(def.guide[0].id,'open');assert.equal(def.guide[0].order,900);
  const icon=renderer.create(React.createElement(def.guide[0].icon,{size:22}));
  const svg=decodeURIComponent(icon.root.findByType('img').props.src.split(',')[1]);
  assert.equal(svg,(await readFile(new URL('../../assets/hive-swarm-icon.svg',import.meta.url),'utf8')).replaceAll('\r\n','\n'));
  assert.deepEqual([...f.slots.keys()].sort(),['main:dsh-hive-swarm','sidebar.panellist:dsh-hive-swarm','sidebar.right.pane.tab:dsh-hive-swarm',
    'tool.call.toolview:hive_swarm_open_swarm_panel','tool.call.toolview:hive_swarm_start_team']);
  f.dispose();assert.deepEqual([...f.definitions.keys()],['wallpaper']);assert.equal(f.slots.size,0);icon.unmount();
  client.apply(f.ctx);assert.equal(f.definitions.size,2);f.dispose();
});

const resultTeamId='78963630-4947-4a29-93cb-959632ec9471';
const otherTeamId='b7dd595f-5769-4ffc-8ead-9d31e0252cc8';
const toolKey=toolName=>'tool.call.toolview:'+toolName;
const resultBlock=(navigation,extra={})=>({kind:'tool-result',isError:false,
  content:[{type:'text',text:'Swarm result retained'}],meta:{navigation},...extra});
const navigation=(teamId=resultTeamId)=>({kind:'hive-swarm',teamId});
const openButton=root=>root.findAllByType('button').find(button=>button.children.includes('Open Swarm'));
const toolResult=(React,entry,phase,block,sessionId='source-session',callId='call-fixture')=>React.createElement(entry.component,
  {...entry.options.inject(sessionId),phase,block,callId,toolName:entry.options.key});

test('the keyed Swarm tool rows retain their states and expose only validated durable success navigation',async()=>{
  const {client,React,renderer}=await loadClient();const f=fakeContext();client.apply(f.ctx);
  const start=f.slots.get(toolKey('hive_swarm_start_team'));
  const open=f.slots.get(toolKey('hive_swarm_open_swarm_panel'));
  assert.ok(start&&open,'both exact wire tool names must have a native row');
  let view;
  try {
    await renderer.act(async()=>{view=renderer.create(toolResult(React,start,'preparing',{phase:'preparing',meta:{navigation:navigation()}}));});
    assert.match(JSON.stringify(view.toJSON()),/Preparing/);assert.equal(openButton(view.root),undefined);
    await renderer.act(async()=>view.update(toolResult(React,start,'start',{phase:'start',meta:{navigation:navigation()}})));
    assert.match(JSON.stringify(view.toJSON()),/Running/);assert.equal(openButton(view.root),undefined);
    await renderer.act(async()=>view.update(toolResult(React,start,'result',resultBlock(navigation(),{isError:true,error:{reason:'Workspace access refused'}}))));
    assert.match(JSON.stringify(view.toJSON()),/Workspace access refused/);assert.equal(openButton(view.root),undefined);
    await renderer.act(async()=>view.update(toolResult(React,open,'result',resultBlock(navigation('not-a-team-id')))));
    assert.equal(openButton(view.root),undefined);
    await renderer.act(async()=>view.update(toolResult(React,open,'result',resultBlock(undefined,{
      content:[{type:'text',text:JSON.stringify({navigation:navigation()})}],
    }))));
    assert.equal(openButton(view.root),undefined,'textual hints are not durable presentation metadata');
    await renderer.act(async()=>view.update(toolResult(React,open,'result',resultBlock(navigation()))));
    assert.match(JSON.stringify(view.toJSON()),/Swarm result retained/);
    assert.equal(openButton(view.root)?.props.type,'button');
    assert.equal(f.ctx.calls.length,0,'render alone must not issue a request');
  }finally{await renderer.act(async()=>view?.unmount());f.dispose();}
});

test('clicking Open Swarm selects the exact Host workspace and keeps the tool row’s original parent session',async()=>{
  const {client,React,renderer}=await loadClient();
  const exact={...team(resultTeamId),cwd:'D:/owned project'};
  const distractor={...team(otherTeamId),cwd:'D:/wire workspace'};
  const f=fakeContext({snapshot:({teamId})=>({teams:[distractor,exact],team:teamId===resultTeamId?exact:null})});client.apply(f.ctx);
  const entry=f.slots.get(toolKey('hive_swarm_start_team'));
  assert.ok(entry,'the start-team result must have an action');
  let row,main;
  try {
    await renderer.act(async()=>{row=renderer.create(toolResult(React,entry,'result',resultBlock({...navigation(),cwd:distractor.cwd}),'original-parent'));});
    await renderer.act(async()=>{await openButton(row.root).props.onClick();});
    assert.equal(f.ctx.calls.length,1);
    assert.equal(f.ctx.calls[0].endpoint,'hive-swarm/v1/snapshot');
    assert.deepEqual({...f.ctx.calls[0].payload},{teamId:resultTeamId});
    assert.deepEqual(f.panels,['dsh-hive-swarm']);
    const seat=f.slots.get('main:dsh-hive-swarm');
    const controller=seat.options.inject().surfaces.getSnapshot();
    assert.equal(controller.getSnapshot().sessionId,'original-parent');
    assert.equal(controller.getSnapshot().workspace,exact.cwd);
    await renderer.act(async()=>{main=renderer.create(React.createElement(seat.component,seat.options.inject()));await tick();});
    assert.equal(main.root.findByProps({'aria-label':'Team'}).props.value,resultTeamId);
    assert.deepEqual(main.root.findAllByType('option').map(option=>option.props.value),['',resultTeamId]);
    assert.ok(f.ctx.calls.every(call=>call.method!=='command'));
  }finally{await renderer.act(async()=>{row?.unmount();main?.unmount();});f.dispose();}
});

test('a superseded tool-result navigation cannot commit a late snapshot, and Host refusal stays in the row',async()=>{
  const {client,React,renderer}=await loadClient();const requests=new Map();
  const f=fakeContext({snapshot:({teamId},signal)=>new Promise(resolve=>requests.set(teamId,{resolve,signal}))});
  let layoutNavigation;
  f.ctx.layout.beginNavigation=()=>{layoutNavigation?.abort();layoutNavigation=new AbortController();return layoutNavigation.signal;};
  f.ctx.layout.selectPanel=id=>{layoutNavigation?.abort();f.panels.push(id);};
  client.apply(f.ctx);const entry=f.slots.get(toolKey('hive_swarm_open_swarm_panel'));assert.ok(entry);
  let first,second,oldClick,newClick;
  try {
    await renderer.act(async()=>{
      first=renderer.create(toolResult(React,entry,'result',resultBlock(navigation()),'old-parent','old-call'));
      second=renderer.create(toolResult(React,entry,'result',resultBlock(navigation(otherTeamId)),'new-parent','new-call'));
    });
    await renderer.act(async()=>{oldClick=openButton(first.root).props.onClick();await tick();});
    assert.equal(first.root.findByType('button').props.disabled,true);
    await renderer.act(async()=>{newClick=openButton(second.root).props.onClick();await tick();});
    assert.equal(requests.get(resultTeamId).signal.aborted,true);
    await renderer.act(async()=>{requests.get(otherTeamId).resolve({teams:[],team:team(otherTeamId)});await newClick;});
    await renderer.act(async()=>{requests.get(resultTeamId).resolve({teams:[],team:team(resultTeamId)});await oldClick;});
    const surfaces=f.slots.get('main:dsh-hive-swarm').options.inject().surfaces;
    assert.deepEqual(f.panels,['dsh-hive-swarm']);assert.equal(surfaces.getSnapshot().getSnapshot().selectedId,otherTeamId);
    assert.equal(surfaces.getSnapshot().getSnapshot().sessionId,'new-parent');
    assert.equal(first.root.findAllByProps({role:'alert'}).length,0,'supersession is quiet');
    let denied;
    await renderer.act(async()=>{denied=openButton(first.root).props.onClick();await tick();});
    await renderer.act(async()=>{requests.get(resultTeamId).resolve({teams:[],team:{...team(resultTeamId),host:'codex'}});await denied;});
    assert.match(first.root.findByProps({role:'alert'}).children.join(''),/team.*unavailable|could not open/i);
    assert.equal(f.panels.length,1);
    let interrupted;
    await renderer.act(async()=>{interrupted=openButton(first.root).props.onClick();await tick();});
    f.ctx.layout.beginNavigation(); // Simulate another native UI navigation, without a second Hive click.
    assert.equal(requests.get(resultTeamId).signal.aborted,true);
    await renderer.act(async()=>{requests.get(resultTeamId).resolve({teams:[],team:team(resultTeamId)});await interrupted;});
    assert.equal(first.root.findAllByProps({role:'alert'}).length,0);
    assert.deepEqual(f.panels,['dsh-hive-swarm']);
  }finally{await renderer.act(async()=>{first?.unmount();second?.unmount();});f.dispose();}
});

test('native render switches four real views, opens Journal and expands with the same selected controller',async()=>{
  const {client,React,renderer}=await loadClient();const f=fakeContext();client.apply(f.ctx);
  const entry=f.slots.get('sidebar.right.pane.tab:dsh-hive-swarm');const face=entry.options.inject('parent-chat');
  let view;await renderer.act(async()=>{view=renderer.create(React.createElement(entry.component,face));await tick()});
  const picker=view.root.findByProps({'aria-label':'Team'});
  await renderer.act(async()=>{await picker.props.onChange({target:{value:'one'}});await tick()});
  const tabs=()=>view.root.findAll(x=>x.props.role==='tab');assert.equal(tabs().length,4);
  await renderer.act(async()=>tabs().find(x=>x.children.includes('Board')).props.onClick());
  assert.ok(JSON.stringify(view.toJSON()).includes('Package verified'));
  await renderer.act(async()=>tabs().find(x=>x.children.includes('Graph')).props.onClick());
  assert.ok(view.root.findByProps({'aria-label':'Message flow graph'}));
  assert.ok(view.root.findAll(x=>x.type==='path'&&x.props['data-hive-edge']).length>0);
  await renderer.act(async()=>tabs().find(x=>x.children.includes('Members')).props.onClick());
  assert.ok(JSON.stringify(view.toJSON()).includes('xingchi/gpt-6.1-sol'));
  await renderer.act(async()=>{view.root.findByProps({'aria-label':'Journal for alpha'}).props.onClick({currentTarget:null});await tick()});
  assert.equal(view.root.findAllByType('dialog').length,1);
  await renderer.act(async()=>view.root.findByProps({'aria-label':'Close Journal'}).props.onClick());
  await renderer.act(async()=>view.root.findByProps({'aria-label':'Open full view'}).props.onClick());
  assert.deepEqual(f.panels,['dsh-hive-swarm']);
  const main=f.slots.get('main:dsh-hive-swarm');let full;
  await renderer.act(async()=>{full=renderer.create(React.createElement(main.component,main.options.inject()));await tick()});
  assert.ok(JSON.stringify(full.toJSON()).includes('Release qualification'));
  await renderer.act(async()=>{view.unmount();full.unmount()});f.dispose();
});

test('Members renders the real presentTeam worktree object using cwd, path fallback and legacy strings',async()=>{
  const {presentTeam}=await import('../../core.mjs');
  const {client,React,renderer}=await loadClient();
  const source=team();const base=source.members[0];
  const fixtures=[
    ['nested',{path:'D:/managed tree',cwd:'D:/managed tree/packages/client',base:'fixture-commit'},'D:/managed tree/packages/client'],
    ['path-only',{path:'D:/path-only',base:'fixture-commit'},'D:/path-only'],
    ['invalid-cwd',{cwd:{untrusted:'value'},path:'D:/valid fallback'},'D:/valid fallback'],
    ['legacy','D:/legacy checkout','D:/legacy checkout'],
    ['invalid',{cwd:{untrusted:'value'},path:42,base:'fixture-commit'},null],
  ];
  const projected=presentTeam({...source,members:fixtures.map(([name,workspace])=>({...base,name,workspace,worktree:true,waitFor:[],channels:[]}))});
  assert.deepEqual(projected.members[0].workspace,fixtures[0][1]);
  const f=fakeContext({snapshot:({teamId})=>({teams:[projected],team:teamId?projected:null})});client.apply(f.ctx);
  const entry=f.slots.get('sidebar.right.pane.tab:dsh-hive-swarm');let view;
  try {
    await renderer.act(async()=>{view=renderer.create(React.createElement(entry.component,entry.options.inject('parent')));await tick();});
    await renderer.act(async()=>{await view.root.findByProps({'aria-label':'Team'}).props.onChange({target:{value:'one'}});});
    await renderer.act(async()=>view.root.findAllByProps({role:'tab'}).find(tab=>tab.children.includes('Members')).props.onClick());
    const rows=view.root.findAllByProps({className:'dsh-hive-member'});
    assert.equal(rows.length,fixtures.length);
    fixtures.forEach(([, ,expected],index)=>{
      const group=rows[index].findAllByType('dt').find(dt=>dt.children.includes('Workspace'))?.parent;
      if(expected)assert.equal(group.findByType('dd').children.join(''),expected);
      else assert.equal(group,undefined,'unknown workspace data must never become a React child');
    });
    assert.equal(f.ctx.calls.filter(call=>call.method==='command').length,0);
  }finally{await renderer.act(async()=>view?.unmount());f.dispose();}
});

test('a tab opens its explicit team link and another parent session starts without a selection',async()=>{
  const {client,React,renderer}=await loadClient();const f=fakeContext();client.apply(f.ctx);
  const entry=f.slots.get('sidebar.right.pane.tab:dsh-hive-swarm');
  const id='78963630-4947-4a29-93cb-959632ec9471';let linked,blank;
  await renderer.act(async()=>{
    linked=renderer.create(React.createElement(entry.component,{
      ...entry.options.inject('parent-a'),useTabInfo:()=>({tab:{contentId:'sidebar://hive-swarm',navigation:{params:{teamId:id}}}}),
    }));
    blank=renderer.create(React.createElement(entry.component,{
      ...entry.options.inject('parent-b'),useTabInfo:()=>({tab:{contentId:'hive-swarm'}}),
    }));await tick();
  });
  assert.equal(linked.root.findByProps({'aria-label':'Team'}).props.value,id);
  assert.equal(blank.root.findByProps({'aria-label':'Team'}).props.value,'');
  assert.ok(f.ctx.calls.every(call=>call.method!=='command'));
  await renderer.act(async()=>{linked.unmount();blank.unmount()});f.dispose();
});

test('the right tab scopes its picker to the current parent workspace and a hidden tab releases its wait',async()=>{
  const {client,React,renderer}=await loadClient();
  const outside={...team('other'),cwd:'D:/another project',title:'Other project'};
  const f=fakeContext({snapshot:({teamId})=>({teams:[team(),outside],team:teamId?team(teamId):null})});client.apply(f.ctx);
  const entry=f.slots.get('sidebar.right.pane.tab:dsh-hive-swarm');let view;
  const element=visible=>React.createElement(entry.component,{
    ...entry.options.inject('parent'),useTabInfo:()=>({tab:{visible}}),
    useSessions:select=>select({byId:{parent:{cwd:'d:\\Fixture Project\\'}}}),
  });
  try {
    await renderer.act(async()=>{view=renderer.create(element(true));await tick()});
    assert.deepEqual(view.root.findAllByType('option').map(option=>option.props.value),['','one']);
    await renderer.act(async()=>{await view.root.findByProps({'aria-label':'Team'}).props.onChange({target:{value:'one'}});await tick()});
    assert.equal(view.root.findByProps({'aria-label':'Team'}).props.value,'one');
    const wait=f.ctx.calls.find(call=>call.method==='wait');assert.ok(wait);
    await renderer.act(async()=>{view.update(element(false));await tick()});
    assert.equal(wait.signal.aborted,true);
  }finally{await renderer.act(async()=>view.unmount());f.dispose();}
});

test('native controls post, pause, resume, switch model, add, retire and open the owned session',async()=>{
  const {client,React,renderer}=await loadClient();let current=team();
  const f=fakeContext({snapshot:({teamId})=>({teams:[current],team:teamId?current:null}),command:({action,args,requestId})=>{
    assert.ok(requestId,'the Host requires a request identity for every command');
    assert.equal(args.teamId,'one');
    if(action==='list_models')return {models:[{id:'sol',label:'Sol',efforts:['max']}]};
    if(action==='pause_team'||action==='resume_team')current={...current,paused:action==='pause_team'};
    return current;
  }});client.apply(f.ctx);
  const entry=f.slots.get('sidebar.right.pane.tab:dsh-hive-swarm');let view;
  await renderer.act(async()=>{view=renderer.create(React.createElement(entry.component,entry.options.inject('parent')));await tick()});
  const findButton=label=>view.root.findAllByType('button').find(button=>button.children.join('')===label);
  const click=async label=>renderer.act(async()=>{const button=findButton(label);assert.ok(button,label);assert.notEqual(button.props.disabled,true,label);await button.props.onClick?.({currentTarget:null});await tick()});
  const field=async (node,value)=>renderer.act(async()=>{node.props.onChange({target:{value}});});
  try {
    await field(view.root.findByProps({'aria-label':'Team'}),'one');await tick();
    await click('Pause');await click('Resume');await click('Board');
    await field(view.root.findByType('textarea'),'  @alpha Take the next task.  ');
    await renderer.act(async()=>view.root.findByType('form').props.onSubmit({preventDefault(){}}));
    await click('Members');await click('Open session');assert.deepEqual(f.sessions,['owned-alpha']);
    await click('Change model');
    let dialog=view.root.findByType('dialog');let [model,effort]=dialog.findAllByType('select');
    await field(model,'sol');await field(effort,'max');
    await renderer.act(async()=>dialog.findByType('form').props.onSubmit({preventDefault(){}}));
    await click('Add member');dialog=view.root.findByType('dialog');
    await field(dialog.findAllByType('input').find(input=>input.props.pattern),'beta');
    await field(dialog.findByType('textarea'),'Validate the artifact');
    await renderer.act(async()=>dialog.findByType('form').props.onSubmit({preventDefault(){}}));
    await click('Retire');await click('Retire member');
    const commands=f.ctx.calls.filter(call=>call.method==='command'&&call.payload.action!=='list_models');
    assert.deepEqual(commands.map(call=>call.payload.action),['pause_team','resume_team','post_message','set_member_model','add_member','retire_member']);
    assert.equal(new Set(commands.map(call=>call.payload.requestId)).size,commands.length);
    assert.equal(commands[2].payload.args.text,'@alpha Take the next task.');
    assert.equal(commands[2].payload.args.channel,'main');
    assert.equal(commands[3].payload.args.member,'alpha');assert.equal(commands[3].payload.args.model,'sol');assert.equal(commands[3].payload.args.effort,'max');
    assert.equal(commands[4].payload.args.member.name,'beta');assert.equal(commands[5].payload.args.member,'alpha');
  } finally {await renderer.act(async()=>view.unmount());f.dispose();}
});

test('keyboard tabs and Journal return focus to the native opener',async()=>{
  const {client,React,require}=await loadClient();
  const {JSDOM}=require('jsdom');const {createRoot}=require('react-dom/client');
  const dom=new JSDOM('<main id="root"></main>');const {window}=dom;
  const restore={window:globalThis.window,document:globalThis.document,IS_REACT_ACT_ENVIRONMENT:globalThis.IS_REACT_ACT_ENVIRONMENT};
  Object.assign(globalThis,{window,document:window.document,IS_REACT_ACT_ENVIRONMENT:true});
  // This browser-like fixture checks focus and the native dialog fallback. Chromium owns modal trapping.
  window.HTMLCanvasElement.prototype.getContext=()=>null;
  const f=fakeContext({command:({action})=>action==='read_journal'?{member:'alpha',threadId:'owned-alpha',turns:[{status:'done',steps:[],report:'Journal verified'}]}:team()});
  client.apply(f.ctx);const entry=f.slots.get('sidebar.right.pane.tab:dsh-hive-swarm');
  const root=createRoot(window.document.querySelector('#root'));
  try {
    await React.act(async()=>{root.render(React.createElement(entry.component,entry.options.inject('parent')));await tick()});
    const select=window.document.querySelector('[aria-label="Team"]');
    await React.act(async()=>{select.value='one';select.dispatchEvent(new window.Event('change',{bubbles:true}));await tick()});
    const [overview,board,members]=window.document.querySelectorAll('[role="tab"]');
    await React.act(async()=>{overview.focus();overview.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));});
    assert.equal(window.document.activeElement,board);assert.equal(board.getAttribute('aria-selected'),'true');
    await React.act(async()=>board.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));
    assert.equal(window.document.activeElement,members);
    const opener=window.document.querySelector('[aria-label="Journal for alpha"]');
    await React.act(async()=>{opener.focus();opener.click();await tick()});
    const dialog=window.document.querySelector('dialog');assert.ok(dialog.open);assert.match(dialog.textContent,/Journal verified/);
    assert.equal(window.document.activeElement.getAttribute('aria-label'),'Close Journal');
    await React.act(async()=>dialog.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
    assert.equal(window.document.querySelector('dialog'),null);assert.equal(window.document.activeElement,opener);
  }finally{await React.act(async()=>root.unmount());f.dispose();Object.assign(globalThis,restore);window.close();}
});

test('the native client reaches the exact Host POST routes with correlated Connection envelopes',async t=>{
  const {createController}=await controllerModule();
  const {createSwarmApplication}=await import('../../core.mjs');
  const {registerRoutes}=await import('./routes.mjs');
  const {mkdtemp,realpath,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const directory=await mkdtemp(join(tmpdir(),'hive-client-contract-'));const cwd=await realpath(process.cwd());
  let launches=0,controller,release;const routes=new Map();
  const app=createSwarmApplication({dataDirectory:directory,host:'deepseek-harness',workspaceAllowed:workspace=>workspace===cwd,
    runner:{run(){launches++;throw Error('The no-model fixture must stay paused.');},listModels:async()=>[{id:'fixture',label:'Fixture',efforts:['max']}],
      readTranscript:id=>{assert.equal(id,'owned-fixture');return [{id:'3',status:'done',items:[
        {type:'activity',kind:'tool',label:'Checked package',detail:'Manifest matched'},
        {type:'agentMessage',phase:'final',text:'Verified real Journal contract'},
      ]}];}}});
  const disposeRoutes=registerRoutes({connection:{fetch:{register:route=>{
    routes.set(route.path,route);return()=>routes.delete(route.path);
  }}},application:app});
  t.after(async()=>{release?.();controller?.dispose();await disposeRoutes();await app.close();await rm(directory,{recursive:true,force:true});});
  const created=app.board.create({cwd,task:'Check the client and Host bridge',members:[{name:'alpha',brief:'Fixture only'}]});
  const paused=app.board.pause(created.id);paused.members[0].threadId='owned-fixture';app.board.save(paused);
  const calls=[];const waitUntil=async predicate=>{for(let i=0;i<40;i++){if(predicate())return;await tick();}assert.fail('Expected state was not delivered');};
  controller=createController({connection:{rpc:{async call(path,method,payload,signal){
    const url=path+'/'+method,route=routes.get(url);
    assert.ok(route?.methods.includes('POST'),'No exact POST route for '+url);
    const rpcId=crypto.randomUUID();
    const request=new Request('http://fixture'+url,{method:'POST',signal,headers:{'content-type':'application/json'},
      body:JSON.stringify({type:'client-request',rpcId,method,payload})});
    calls.push({url,payload});
    const response=await route.fetch(request);
    assert.equal(response.status,200);
    const envelope=await response.json();assert.equal(envelope.type,'server-response');assert.equal(envelope.rpcId,rpcId);
    return envelope.result;
  }}},teamId:created.id,workspace:cwd});
  release=controller.retain();await waitUntil(()=>controller.getSnapshot().team?.id===created.id||controller.getSnapshot().error);
  assert.equal(controller.getSnapshot().team?.host,'deepseek-harness',controller.getSnapshot().error?.message);
  await controller.loadModels();assert.equal(controller.getSnapshot().models[0].id,'fixture');
  await controller.openJournal('alpha');assert.deepEqual(controller.getSnapshot().journal.turns.map(turn=>[turn.turn,turn.steps[0].label,turn.report]),[[3,'Checked package','Verified real Journal contract']]);
  const oldRevision=controller.getSnapshot().team.revision;
  await app.command('set_team_title',{teamId:created.id,title:'Updated through real Host'});
  await waitUntil(()=>controller.getSnapshot().team.title==='Updated through real Host');
  assert.notEqual(controller.getSnapshot().team.revision,oldRevision);
  assert.ok(calls.some(call=>call.url==='/api/hive-swarm/v1/events'&&call.payload.revision===oldRevision));
  await controller.command('post_message',{text:'Fixture post',channel:'main'});
  assert.ok(controller.getSnapshot().history.some(post=>post.text==='Fixture post'));
  assert.deepEqual([...new Set(calls.map(call=>call.url))].sort(),[
    '/api/hive-swarm/v1/command','/api/hive-swarm/v1/events','/api/hive-swarm/v1/snapshot',
  ]);
  assert.equal(launches,0);
});

test('native UI renders safe Markdown, clickable #seq jumps, outcome threads, progress bars, milestones, and recovery controls',async()=>{
  const {client,React,renderer}=await loadClient();
  let current={
    ...team(),
    phase:'stalled',
    threads:[
      {id:'t-done',title:'Docs update',goal:'Sync README',members:['beta']},
      {id:'t-blocked',title:'Native runner',goal:'Fix recovery',members:['alpha']},
    ],
    members:[
      {name:'alpha',status:'failed',recoveryRequired:true,brief:'Fix runner',model:'sol',effort:'max',writable:false,
        session:{host:'deepseek-harness',id:'owned-alpha'},threadId:'owned-alpha',workspace:{cwd:'D:/managed/alpha'}},
      {name:'beta',status:'done',brief:'Update docs',model:'sol',effort:'low',writable:false,
        session:{host:'deepseek-harness',id:'owned-beta'},threadId:'owned-beta'},
    ],
    events:[
      {seq:1,kind:'message',author:'beta',text:'[done] **Verified** `README.md` <script>alert(1)</script> [safe](https://example.test/doc) [bad](javascript:alert(1))',targets:[],channel:'main'},
      {seq:2,kind:'message',author:'alpha',text:'Checked #1 with @beta.',targets:['beta'],channel:'main'},
    ],
  };
  const f=fakeContext({snapshot:({teamId})=>({teams:[current],team:teamId?current:null}),command:({action,args})=>{
    if(action==='list_models')return {models:[{id:'sol',label:'Sol',efforts:['low','max']}]};
    if(action==='resolve_recovery')current={...current,members:current.members.map(m=>m.name===args.member?{...m,recoveryRequired:false,status:'queued'}:m)};
    if(action==='set_team_title')current={...current,title:args.title};
    if(action==='remove_worktree')current={...current,members:current.members.map(m=>m.name===args.member?{...m,workspace:undefined}:m)};
    return current;
  }});
  client.apply(f.ctx);
  const entry=f.slots.get('sidebar.right.pane.tab:dsh-hive-swarm');let view;
  const findButton=label=>view.root.findAllByType('button').find(b=>b.children.join('')===label||b.props['aria-label']===label);
  try{
    await renderer.act(async()=>{view=renderer.create(React.createElement(entry.component,entry.options.inject('parent')));await tick();});
    await renderer.act(async()=>{await view.root.findByProps({'aria-label':'Team'}).props.onChange({target:{value:'one'}});await tick();});
    // Overview: progress bars, outcome threads ordered blocked -> done, milestones, recovery controls
    assert.equal(view.root.findAllByType('progress').length,2);
    const overviewText=JSON.stringify(view.toJSON());
    assert.ok(overviewText.includes('Native runner')&&overviewText.includes('Docs update'));
    assert.ok(overviewText.indexOf('Native runner')<overviewText.indexOf('Docs update'));
    assert.ok(overviewText.includes('Milestones'));
    const retryBtn=findButton('Retry fresh turn for @alpha');
    assert.ok(retryBtn,'Expected recovery retry control');
    await renderer.act(async()=>{await retryBtn.props.onClick();await tick();});
    // Jump via #1 button to Board and inspect safe Markdown
    const jump=findButton('Jump to post #1');
    assert.ok(jump,'Expected clickable #1 post jump button');
    await renderer.act(async()=>{jump.props.onClick();await tick();});
    assert.equal(view.root.findAllByType('strong').some(s=>s.children.join('')==='Verified'),true);
    assert.equal(view.root.findAllByType('code').some(c=>c.children.join('')==='README.md'),true);
    const links=view.root.findAllByType('a');
    assert.deepEqual(links.map(l=>l.props.href),['https://example.test/doc']);
    // Rename title in header
    await renderer.act(async()=>{findButton('Rename').props.onClick();});
    const titleInput=view.root.findByProps({'aria-label':'Swarm title'});
    await renderer.act(async()=>{titleInput.props.onChange({target:{value:'Renamed Swarm'}});});
    await renderer.act(async()=>{await titleInput.parent.props.onSubmit({preventDefault(){}});await tick();});
    // Members: model default effort sends null + resume checkbox + clean worktree on retired/done
    current={...current,phase:'done',members:current.members.map(m=>m.name==='alpha'?{...m,status:'waiting',recoveryRequired:false}:m)};
    await renderer.act(async()=>{view.root.findAllByProps({role:'tab'}).find(t=>t.children.includes('Members')).props.onClick();await tick();});
    await renderer.act(async()=>{await findButton('Refresh').props.onClick();await tick();});
    const cleanBtn=findButton('Clean worktree for @alpha');
    assert.ok(cleanBtn,'Expected Clean worktree button');
    await renderer.act(async()=>{await cleanBtn.props.onClick();await tick();});
    await renderer.act(async()=>{findButton('Change model').props.onClick({currentTarget:null});await tick();});
    const dialog=view.root.findByType('dialog');
    const [,effortSelect]=dialog.findAllByType('select');
    await renderer.act(async()=>{effortSelect.props.onChange({target:{value:''}});});
    const resumeCheck=dialog.findAllByType('input').find(i=>i.props.type==='checkbox');
    assert.ok(resumeCheck,'Expected Resume now checkbox in MemberEditor');
    await renderer.act(async()=>{resumeCheck.props.onChange({target:{checked:true}});});
    await renderer.act(async()=>{await dialog.findByType('form').props.onSubmit({preventDefault(){}});await tick();});
    // Graph: playback controls (Play/First/Back/Next) and userSpaceOnUse arrowhead marker
    await renderer.act(async()=>{view.root.findAllByProps({role:'tab'}).find(t=>t.children.includes('Graph')).props.onClick();await tick();});
    assert.ok(findButton('Replay'),'Expected Replay button on native Graph');
    assert.ok(findButton('Previous post'),'Expected Previous post button on native Graph');
    const marker=view.root.findByType('marker');
    assert.equal(marker.props.markerUnits,'userSpaceOnUse');
    const panel=view.root.findByProps({role:'tabpanel'});
    assert.equal(panel.props['aria-labelledby'].includes(':'),false,'tabpanel aria-labelledby must not contain raw colons');

    const actions=f.ctx.calls.filter(c=>c.method==='command'&&c.payload.action!=='list_models');
    assert.deepEqual(actions.map(c=>c.payload.action),['resolve_recovery','set_team_title','remove_worktree','set_member_model']);
    const modelCall=actions.find(c=>c.payload.action==='set_member_model');
    assert.equal(modelCall.payload.args.effort,null);
    assert.equal(modelCall.payload.args.resume,true);
  }finally{await renderer.act(async()=>view?.unmount());f.dispose();}
});

test('native Members renders executionMode badges, passes SubagentAddress on Open session, falls back to Journal, and highlights Verified route',async()=>{
  const {client,React,renderer}=await loadClient();
  const multi={
    ...team(),
    parentSessionId:'parent-chat-1',
    members:[
      {name:'alpha',status:'working',brief:'Research UI',model:'xingchi/gpt-6.1-sol',effort:'max',writable:false,
        executionMode:'subagent',subagentName:'alpha-1',session:{host:'deepseek-harness',id:'child-alpha'},threadId:'child-alpha'},
      {name:'beta',status:'waiting',brief:'Verify patch',model:'xingchi/gpt-6.1-sol',effort:'medium',writable:false,
        executionMode:'attached',session:{host:'deepseek-harness',id:'child-beta'},threadId:'child-beta'},
      {name:'gamma',status:'done',brief:'Legacy worker',model:'xingchi/gpt-6.1-sol',effort:'low',writable:true,
        executionMode:'session',session:{host:'deepseek-harness',id:'legacy-gamma'},threadId:'legacy-gamma'},
    ],
  };
  let failOpen=false;
  const f=fakeContext({
    snapshot:({teamId})=>({teams:[multi],team:teamId?multi:null}),
    command:({action,args})=>{
      if(action==='read_journal')return {member:args.member,threadId:'child-alpha',turns:[
        {turn:1,status:'done',steps:[{kind:'route',label:'Verified route: xingchi/gpt-6.1-sol · max'},{kind:'tool',label:'Read file'}],report:'[done] Route checked.'},
      ]};
      return multi;
    },
  });
  const opened=[];
  f.ctx.uiWorkspace.openSession=target=>{
    if(failOpen)throw Error('Session view unavailable');
    opened.push(target);
  };
  client.apply(f.ctx);
  const entry=f.slots.get('sidebar.right.pane.tab:dsh-hive-swarm');let view;
  try{
    await renderer.act(async()=>{view=renderer.create(React.createElement(entry.component,entry.options.inject('parent-chat-1')));await tick();});
    await renderer.act(async()=>{await view.root.findByProps({'aria-label':'Team'}).props.onChange({target:{value:'one'}});await tick();});
    await renderer.act(async()=>{view.root.findAllByProps({role:'tab'}).find(t=>t.children.includes('Members')).props.onClick();await tick();});
    const badges=view.root.findAllByProps({className:'dsh-hive-mode'});
    assert.deepEqual(badges.map(b=>[b.props['data-mode'],b.children.join('')]),[
      ['subagent','Subagent'],
      ['attached','Attached'],
      ['session','Session'],
    ]);
    assert.equal(badges[0].props.title,'Subagent: alpha-1');
    await renderer.act(async()=>{await view.root.findByProps({'aria-label':'Open session for @alpha'}).props.onClick({currentTarget:null});await tick();});
    await renderer.act(async()=>{await view.root.findByProps({'aria-label':'Open session for @gamma'}).props.onClick({currentTarget:null});await tick();});
    assert.deepEqual(opened.map(item=>typeof item==='object'&&item?{...item}:item),[
      {parentSessionId:'parent-chat-1',childSessionId:'child-alpha',mode:'continuable'},
      'legacy-gamma',
    ]);
    // Fallback to Journal when uiWorkspace.openSession throws
    failOpen=true;
    await renderer.act(async()=>{await view.root.findByProps({'aria-label':'Open session for @alpha'}).props.onClick({currentTarget:null});await tick();});
    const dialog=view.root.findByType('dialog');
    assert.ok(dialog,'Expected fallback to open Journal dialog');
    const routeBadges=dialog.findAllByProps({className:'dsh-hive-route-badge'});
    assert.equal(routeBadges.length,1);
    assert.ok(routeBadges[0].children.some(child=>typeof child==='string'&&child.includes('Verified route:')));
    assert.equal(routeBadges[0].findByType('code').children.join(''),'xingchi/gpt-6.1-sol · max');
  }finally{await renderer.act(async()=>view?.unmount());f.dispose();}
});

test('native Graph clips every SVG edge strictly outside wrapped multi-line node cards and renders mention count pills',async()=>{
  await import('../../hive-graph.js');
  const Graph=globalThis.HiveGraph;
  const {client,React,renderer}=await loadClient();
  const sixNodeTeam={
    ...team(),
    members:[
      {name:'design-research',status:'done',brief:'Design research',model:'sol',writable:false},
      {name:'asset-research',status:'done',brief:'Asset research',model:'sol',writable:false},
      {name:'builder',status:'working',brief:'Build app',model:'sol',writable:true},
      {name:'qa',status:'waiting',brief:'QA app',model:'sol',writable:false},
      {name:'user',status:'observer',brief:'Human',model:'sol',writable:false},
    ],
    events:[
      {seq:1,kind:'brief',author:'coordinator',targets:['design-research'],text:'Research design'},
      {seq:2,kind:'brief',author:'coordinator',targets:['asset-research'],text:'Research assets'},
      {seq:3,kind:'message',author:'user',targets:['qa'],text:'@qa test'},
      {seq:4,kind:'message',author:'qa',targets:['builder'],text:'@builder fix #3'},
      {seq:5,kind:'message',author:'qa',targets:['builder'],text:'@builder second fix'},
      {seq:6,kind:'message',author:'builder',targets:['qa'],text:'@qa retest'},
      {seq:7,kind:'message',author:'builder',targets:['design-research'],text:'@design-research check'},
      {seq:8,kind:'message',author:'design-research',targets:['builder'],text:'@builder looks good'},
    ],
  };
  const f=fakeContext({snapshot:({teamId})=>({teams:[sixNodeTeam],team:teamId?sixNodeTeam:null})});
  client.apply(f.ctx);
  const entry=f.slots.get('sidebar.right.pane.tab:dsh-hive-swarm');let view;
  try{
    await renderer.act(async()=>{view=renderer.create(React.createElement(entry.component,entry.options.inject('parent')));await tick();});
    await renderer.act(async()=>{await view.root.findByProps({'aria-label':'Team'}).props.onChange({target:{value:'one'}});await tick();});
    await renderer.act(async()=>{view.root.findAllByProps({role:'tab'}).find(t=>t.children.includes('Graph')).props.onClick();await tick();});
    const svg=view.root.findByType('svg');
    const [,,wStr,hStr]=svg.props.viewBox.split(' ');
    const width=Number(wStr),height=Number(hStr);
    const narrow=width<440,cardWidth=narrow?94:112;
    const projection=Graph.project(sixNodeTeam.events,sixNodeTeam.members,8,{});
    const points=Graph.layout(projection.nodes,width,height);
    const edges=view.root.findAll(x=>x.type==='path'&&x.props['data-hive-edge']);
    assert.equal(edges.length,7);
    for(const path of edges){
      const [from,to]=path.props['data-hive-edge'].split('>');
      const m=/^M([-\d.]+) ([-\d.]+) Q([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)$/.exec(path.props.d);
      assert.ok(m,'valid quadratic path for '+path.props['data-hive-edge']+': '+path.props.d);
      const sx=Number(m[1]),sy=Number(m[2]),ex=Number(m[5]),ey=Number(m[6]);
      const fromPt=points.get(from),toPt=points.get(to);
      const fromBox=Graph.nodeBox(projection.nodes.find(n=>n.name===from),{variant:'card',cardWidth,narrow});
      const toBox=Graph.nodeBox(projection.nodes.find(n=>n.name===to),{variant:'card',cardWidth,narrow});
      const dStart=Graph.roundedRectSignedDistance(sx,sy,{cx:fromPt.x,cy:fromPt.y,halfW:fromBox.halfW,halfH:fromBox.halfH,radius:fromBox.radius});
      const dEnd=Graph.roundedRectSignedDistance(ex,ey,{cx:toPt.x,cy:toPt.y,halfW:toBox.halfW,halfH:toBox.halfH,radius:toBox.radius});
      assert.ok(dStart>=1.5,'SVG start outside source card for '+from+'->'+to+': '+dStart);
      assert.ok(dEnd>=2.5,'SVG arrowhead tip outside target card for '+from+'->'+to+': '+dEnd);
    }
    // Single marker contract preserved
    assert.equal(view.root.findAllByType('marker').length,1);
    assert.equal(view.root.findByType('marker').props.markerUnits,'userSpaceOnUse');
    // Multi-mention badge pill renders for qa->builder (2 mentions)
    const pills=view.root.findAllByProps({className:'dsh-hive-edge-pill'});
    assert.ok(pills.length>=1,'expected mention count pill(s) on SVG graph');
    // Focus dimming on clicking a node
    const qaBtn=view.root.findAllByProps({className:'dsh-hive-graph-node'}).find(b=>b.findByType('strong').children.join('')==='qa');
    await renderer.act(async()=>{qaBtn.props.onClick();});
    const assetBtn=view.root.findAllByProps({className:'dsh-hive-graph-node'}).find(b=>b.findByType('strong').children.join('')==='asset-research');
    assert.equal(qaBtn.props['aria-pressed'],true);
    assert.equal(assetBtn.props['data-dimmed'],'true');
  }finally{await renderer.act(async()=>view?.unmount());f.dispose();}
});
