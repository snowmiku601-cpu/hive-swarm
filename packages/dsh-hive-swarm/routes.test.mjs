import test from 'node:test';
import assert from 'node:assert/strict';

async function fixture(t) {
  const {registerRoutes}=await import('./routes.mjs');
  const routes=new Map(),calls=[];
  const connection={fetch:{register:r=>{routes.set(r.path,r);return async()=>routes.delete(r.path)}}};
  const app={snapshot:async(args,context)=>{calls.push({kind:'snapshot',args,context});return {teams:[],team:null}},
    command:async(action,args,context)=>{calls.push({kind:'command',action,args,context});return {id:'owned'}},
    waitForUpdate:async(args,context)=>{calls.push({kind:'wait',args,context});return {posts:[],head:0,status:{revision:'one'}}}};
  const dispose=registerRoutes({connection,application:app});t.after(dispose);
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

test('three exact Fetch routes bound JSON input and dispose without owning any listener',async t=>{
  const f=await fixture(t);
  assert.deepEqual([...f.routes.keys()],['/api/hive-swarm/v1/snapshot','/api/hive-swarm/v1/command','/api/hive-swarm/v1/events']);
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
