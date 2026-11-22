import test from 'node:test';
import assert from 'node:assert/strict';

async function fixture(t,options={}) {
  const {registerRoutes}=await import('./routes.mjs');
  const routes=new Map(),calls=[];
  const connection={fetch:{register:r=>{routes.set(r.path,r);return async()=>routes.delete(r.path)}}};
  const app={snapshot:async(args,context)=>{calls.push({kind:'snapshot',args,context});return {teams:[],team:null}},
    command:async(action,args,context)=>{calls.push({kind:'command',action,args,context});return {id:'owned'}},
    waitForUpdate:async(args,context)=>{calls.push({kind:'wait',args,context});return {posts:[],head:0,status:{revision:'one'}}}};
  const dispose=registerRoutes({connection,application:app,...options});t.after(dispose);
  const rpc=async(endpoint,payload,signal,peer)=>{
    if(peer?.principal.kind!=='owner')return {ok:false}; // Carrier admission is separately qualified on the installed SDK.
    const target=endpoint==='wait'?'events':endpoint;const method='hive-swarm/v1/'+target;
    const response=await routes.get('/api/'+method).fetch(new Request('http://fixture/api/'+method,{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'fixture',method,payload}),signal}));
    const value=await response.json();return value.result??value;
  };
  return {routes,calls,dispose,rpc,app};
}
const signal=()=>new AbortController().signal;
const owner={principal:{kind:'owner'}};

test('RPC owner admission is independent of caller-supplied identity and reads do not mutate',async t=>{
  const f=await fixture(t);
  const denied=await f.rpc('command',{action:'start_team',args:{principal:{kind:'owner'}},requestId:'x'},signal(),{principal:{kind:'guest'}});
  assert.equal(denied.ok,false);assert.equal(f.calls.length,0);
  assert.equal((await f.rpc('snapshot',{},signal(),owner)).ok,true);
  assert.deepEqual(f.calls.map(x=>x.kind),['snapshot']);
  assert.equal((await f.rpc('snapshot',{actor:{member:'admin'}},signal(),owner)).ok,false);
  assert.equal((await f.rpc('command',{action:'arbitrary',args:{},requestId:'x'},signal(),owner)).ok,false);
  assert.equal((await f.rpc('command',{action:'pause_team',args:{teamId:'one',parentSessionId:'spoof'},requestId:'x'},signal(),owner)).ok,false);
  assert.equal((await f.rpc('command',{action:'pause_team',args:{teamId:'one'},requestId:'x'},signal(),owner)).ok,true);
  assert.equal(f.calls.at(-1).context.actor,undefined);
  assert.equal(f.calls.at(-1).context.requestId,'x');
});

test('exact Fetch routes bound JSON input and dispose without owning any listener',async t=>{
  const f=await fixture(t);
  assert.deepEqual([...f.routes.keys()],['/api/hive-swarm/v1/snapshot','/api/hive-swarm/v1/command','/api/hive-swarm/v1/events','/api/hive-swarm/v1/screenshot']);
  const route=f.routes.get('/api/hive-swarm/v1/command');
  const request=body=>new Request('http://fixture/api/hive-swarm/v1/command',{method:'POST',headers:{'content-type':'application/json'},body});
  assert.equal((await route.fetch(request('{broken'))).status,400);
  assert.equal((await route.fetch(request(' '.repeat(128*1024+1)))).status,413);
  assert.equal(f.calls.length,0);
  assert.equal((await route.fetch(request(JSON.stringify({action:'pause_team',args:{teamId:'one'},requestId:'pause-1'})))).status,200);
  await f.dispose();assert.equal(f.routes.size,0);
});

test('native wait preserves cursor/revision and rejects excessive or spoofed fields before waiting',async t=>{
  const f=await fixture(t);
  const value={teamId:'one',since:3,revision:'epoch:1',timeoutSec:55};const abort=new AbortController();
  assert.equal((await f.rpc('wait',value,abort.signal,owner)).ok,true);
  assert.deepEqual(f.calls[0].args,value);assert.equal(f.calls[0].context.signal.aborted,false);
  abort.abort();assert.equal(f.calls[0].context.signal.aborted,true);
  assert.equal((await f.rpc('wait',{...value,timeoutSec:56},signal(),owner)).ok,false);
  assert.equal((await f.rpc('wait',{...value,sessionId:'foreign'},signal(),owner)).ok,false);
  assert.equal(f.calls.length,1);
});

test('the GET event stream delivers every backlog page before advancing its reconnect cursor',async t=>{
  const f=await fixture(t);let count=0;const cursors=[];
  f.app.waitForUpdate=async(args,{signal})=>{
    cursors.push(args.since);
    if(++count>2)return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    const posts=Array.from({length:count===1?100:5},(_,index)=>({seq:(count===1?1:101)+index,text:'Backlog'}));
    return {posts,head:105,hasMore:count===1,revision:'one'};
  };
  const abort=new AbortController();const response=await f.routes.get('/api/hive-swarm/v1/events').fetch(
    new Request('http://fixture/api/hive-swarm/v1/events?teamId=one&since=0',{signal:abort.signal}));
  const reader=response.body.getReader();
  try{
    const first=new TextDecoder().decode((await reader.read()).value),second=new TextDecoder().decode((await reader.read()).value);
    assert.match(first,/\nid: 100\n/);assert.match(second,/\nid: 105\n/);assert.deepEqual(cursors.slice(0,2),[0,100]);
    assert.match(second,/"seq":101/);assert.match(second,/"seq":105/);
  }finally{abort.abort();await reader.cancel();}
});

test('GET /api/hive-swarm/v1/screenshot serves confined workspace/data images and returns 404 for traversal, symlinks, non-images, and oversized files',async t=>{
  const {mkdirSync,mkdtempSync,realpathSync,rmSync,symlinkSync,writeFileSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {createSwarmApplication}=await import('../../core.mjs');
  const {registerRoutes}=await import('./routes.mjs');

  const root=mkdtempSync(join(tmpdir(),'hive-dsh-shots-'));
  const dataDirectory=join(root,'data');
  const repoDir=join(dataDirectory,'repo');
  const outsideDir=join(root,'outside');
  mkdirSync(join(repoDir,'shots'),{recursive:true});
  mkdirSync(join(dataDirectory,'worktrees','wt'),{recursive:true});
  mkdirSync(outsideDir,{recursive:true});

  const png=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  const jpg=Buffer.from([0xff,0xd8,0xff,0xe0]);
  const webp=Buffer.from('RIFF\0\0\0\0WEBP');
  writeFileSync(join(repoDir,'shots','ui.png'),png);
  writeFileSync(join(repoDir,'shots','ui.jpg'),jpg);
  writeFileSync(join(dataDirectory,'worktrees','wt','wt.webp'),webp);
  writeFileSync(join(dataDirectory,'secret.png'),png);
  writeFileSync(join(outsideDir,'secret.png'),png);
  writeFileSync(join(repoDir,'shots','note.txt'),'plain text');
  writeFileSync(join(repoDir,'shots','huge.png'),Buffer.alloc(10*1024*1024+1));
  symlinkSync(outsideDir,join(repoDir,'shots','escape'),process.platform==='win32'?'junction':'dir');

  const app=createSwarmApplication({
    dataDirectory,host:'deepseek-harness',
    runner:{listModels:async()=>[],run:async()=>new Promise(()=>{}),close:async()=>{}},
    workspaceAllowed:async dir=>dir===realpathSync(repoDir),
  });
  const routes=new Map();
  const dispose=registerRoutes({connection:{fetch:{register:r=>{routes.set(r.path,r);return async()=>routes.delete(r.path);}}},application:app});
  t.after(async()=>{await dispose();await app.close();rmSync(root,{recursive:true,force:true});});

  const team=await app.command('start_team',{cwd:repoDir,task:'Screenshot route',members:[{name:'ui',brief:'Render view'}]});
  const posted=await app.command('post_message',{
    teamId:team.id,
    text:[
      'Screenshot: shots/ui.png | Relative PNG',
      'Screenshot: '+join(repoDir,'shots','ui.jpg')+' | Absolute JPG',
      'Screenshot: '+join(dataDirectory,'worktrees','wt','wt.webp')+' | Worktree WEBP',
      'Screenshot: ../secret.png | Traversal',
      'Screenshot: '+join(outsideDir,'secret.png')+' | Outside root',
      'Screenshot: shots/note.txt | Non-image',
      'Screenshot: shots/escape/secret.png | Symlink escape',
      'Screenshot: shots/huge.png | Over 10 MiB',
    ].join('\n'),
  });
  const seq=posted.events.at(-1).seq;
  assert.equal(posted.screenshots[0].url,'/api/hive-swarm/v1/screenshot?teamId='+encodeURIComponent(team.id)+'&seq='+seq+'&index=0');
  assert.equal(Object.hasOwn(posted.screenshots[0],'path'),false);

  const route=routes.get('/api/hive-swarm/v1/screenshot');
  const getShot=query=>route.fetch(new Request('http://fixture/api/hive-swarm/v1/screenshot?'+query));

  const res0=await getShot('teamId='+encodeURIComponent(team.id)+'&seq='+seq+'&index=0');
  assert.equal(res0.status,200);
  assert.equal(res0.headers.get('content-type'),'image/png');
  assert.equal(res0.headers.get('cache-control'),'no-store');
  assert.equal(res0.headers.get('x-content-type-options'),'nosniff');
  assert.equal(res0.headers.get('cross-origin-resource-policy'),'same-origin');
  assert.deepEqual(Buffer.from(await res0.arrayBuffer()),png);

  const res1=await getShot('teamId='+encodeURIComponent(team.id)+'&seq='+seq+'&index=1');
  assert.equal(res1.status,200);
  assert.equal(res1.headers.get('content-type'),'image/jpeg');

  const res2=await getShot('teamId='+encodeURIComponent(team.id)+'&seq='+seq+'&index=2');
  assert.equal(res2.status,200);
  assert.equal(res2.headers.get('content-type'),'image/webp');

  for(const badIdx of [3,4,5,6,7,99]) {
    const res=await getShot('teamId='+encodeURIComponent(team.id)+'&seq='+seq+'&index='+badIdx);
    assert.equal(res.status,404,'index '+badIdx+' must 404');
  }
  assert.equal((await getShot('teamId=missing-team&seq=1&index=0')).status,404);
  assert.equal((await getShot('teamId='+encodeURIComponent(team.id)+'&seq=abc&index=0')).status,404);
  assert.equal((await getShot('teamId='+encodeURIComponent(team.id)+'&seq=1&index=0&extra=1')).status,404);
  assert.equal((await getShot('teamId='+encodeURIComponent(team.id)+'&teamId='+encodeURIComponent(team.id)+'&seq=1&index=0')).status,404);
});

test('POST snapshot Connection RPC includes getMeta version/update while GET snapshot stays exact',async t=>{
  const update={current:'2.1.0',latest:'2.2.0',available:true,url:'https://github.com/snowmiku601-cpu/hive-swarm/releases/tag/v2.2.0',checked:true};
  const f=await fixture(t,{getMeta:()=>({version:'2.1.0',update})});
  const rpcSnapshot=await f.rpc('snapshot',{},signal(),owner);
  assert.equal(rpcSnapshot.ok,true);
  assert.equal(rpcSnapshot.value.version,'2.1.0');
  assert.deepEqual(rpcSnapshot.value.update,update);

  const getRes=await f.routes.get('/api/hive-swarm/v1/snapshot').fetch(new Request('http://fixture/api/hive-swarm/v1/snapshot'));
  assert.equal(getRes.status,200);
  assert.deepEqual(await getRes.json(),{teams:[],team:null});
});

test('2.2.0 /api/hive-swarm/v1/events strictly requires integer timeoutSec in 1..55 (rejecting 0 and floats)',async t=>{
  const f=await fixture(t);
  assert.equal((await f.rpc('wait',{teamId:'one',since:0,timeoutSec:1},signal(),owner)).ok,true);
  for(const bad of [0,-1,1.5,55.5,56,'10',null,NaN]) {
    const res=await f.rpc('wait',{teamId:'one',since:0,timeoutSec:bad},signal(),owner);
    assert.equal(res.ok,false,'RPC wait must reject timeoutSec='+String(bad));
  }
  const route=f.routes.get('/api/hive-swarm/v1/events');
  for(const bad of ['0','1.5','-2','56','abc']) {
    const res=await route.fetch(new Request('http://fixture/api/hive-swarm/v1/events?teamId=one&since=0&timeoutSec='+bad));
    assert.equal(res.status,400,'GET events must reject timeoutSec='+bad);
  }
});
