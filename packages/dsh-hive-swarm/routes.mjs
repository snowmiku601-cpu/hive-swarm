const maximum=128*1024;
export const ownerActions=new Set(['start_team','list_teams','list_models','board_status','board_history','read_board',
  'open_swarm_panel','post_message','pause_team','resume_team','cancel_turn','resolve_recovery','set_team_title','set_team_plan',
  'manage_channel','add_member','retire_member','set_member_model','remove_worktree','read_journal','wait_for_board']);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
function exact(value,keys) {
  if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error('Invalid request fields.');
}
function short(value,name,{optional=false,max=256}={}) {
  if(optional&&value===undefined)return;
  if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\0'))throw Error('Invalid '+name+'.');
}
function parse(endpoint,value) {
  if(endpoint==='snapshot') {exact(value,['teamId']);short(value.teamId,'team identity',{optional:true});return value;}
  if(endpoint==='wait') {
    exact(value,['teamId','since','revision','timeoutSec']);short(value.teamId,'team identity');
    if(value.since!==undefined&&(!Number.isSafeInteger(value.since)||value.since<0))throw Error('Invalid cursor.');
    short(value.revision,'revision',{optional:true});
    if(value.timeoutSec!==undefined&&(!Number.isFinite(value.timeoutSec)||value.timeoutSec<0||value.timeoutSec>55))throw Error('Invalid wait duration.');
    return value;
  }
  if(endpoint==='command') {
    exact(value,['action','args','requestId']);short(value.requestId,'request identity',{max:160});
    if(!ownerActions.has(value.action)||!object(value.args))throw Error('Unknown command or invalid arguments.');
    if(['actor','principal','sessionId','dataDirectory','host','parentSessionId'].some(key=>Object.hasOwn(value.args,key)))throw Error('Host identity cannot be supplied by the client.');
    return value;
  }
  throw Error('Unknown Hive Swarm endpoint.');
}
async function body(request) {
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw Error('Expected application/json.');
  const reader=request.body?.getReader();if(!reader)throw Error('Missing JSON request.');
  const chunks=[];let size=0;
  try {for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
    if(size>maximum){const error=Error('Request exceeds 128 KiB.');error.status=413;await reader.cancel();throw error;}chunks.push(part.value);}}
  finally {reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
const failure=error=>({ok:false,error:{code:'hive-swarm/invalid-request',message:String(error?.message??error).slice(0,600),details:{}}});
const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});

/** All physical carriers use the owner-admitted exact Fetch registry, including native Connection RPC. */
export function registerRoutes({connection,application,getMeta}) {
  if(typeof connection?.fetch?.register!=='function')throw Error('DSH Connection exact Fetch capability is required.');
  const lifetime=new AbortController();const disposers=[];let closed=false;
  async function dispatch(endpoint,payload,signal) {
    if(closed)throw Error('Hive Swarm is closed.');
    if(Buffer.byteLength(JSON.stringify(payload)??'')>maximum)throw Error('Request exceeds 128 KiB.');
    const value=parse(endpoint,payload);const context={signal:AbortSignal.any([signal??new AbortController().signal,lifetime.signal])};
    context.signal.throwIfAborted();
    if(endpoint==='snapshot')return application.snapshot(value,context);
    if(endpoint==='wait')return application.waitForUpdate(value,context);
    return application.command(value.action,value.args,{...context,requestId:value.requestId});
  }
  function query(request,endpoint) {
    const params=new URL(request.url).searchParams;const value={};
    for(const [key,entry] of params){if(Object.hasOwn(value,key))throw Error('Duplicate query parameter.');value[key]=['since','timeoutSec'].includes(key)?Number(entry):entry;}
    return parse(endpoint,value);
  }
  const route=(path,methods,fetch)=>disposers.push(connection.fetch.register({path,methods,requestBody:'buffered',fetch:async request=>{
    try{return await fetch(request);}catch(error){return json(failure(error),error.status??400);}
  }}));
  async function envelope(request,endpoint,decoded) {
    const message=decoded??await body(request);exact(message,['type','rpcId','method','payload']);
    const expected='hive-swarm/v1/'+(endpoint==='wait'?'events':endpoint);
    if(message.type!=='client-request'||message.method!==expected)throw Error('Invalid Connection RPC envelope or method.');
    short(message.rpcId,'RPC identity');let result;
    try{
      let value=await dispatch(endpoint,message.payload,request.signal);
      if(endpoint==='snapshot'&&typeof getMeta==='function') {
        const meta=getMeta();
        if(meta&&object(meta))value={...value,...meta};
      }
      result={ok:true,value};
    }catch(error){result=failure(error);}
    return json({type:'server-response',rpcId:message.rpcId,result});
  }
  try {
    route('/api/hive-swarm/v1/snapshot',['GET','POST'],async request=>request.method==='POST'?envelope(request,'snapshot'):
      json(await dispatch('snapshot',query(request,'snapshot'),request.signal)));
    route('/api/hive-swarm/v1/command',['POST'],async request=>{const value=await body(request);
      return value?.type==='client-request'?envelope(request,'command',value):json(await dispatch('command',value,request.signal));});
    route('/api/hive-swarm/v1/events',['GET','POST'],async request=>{
      if(request.method==='POST')return envelope(request,'wait');
      let cursor=query(request,'wait');const abort=new AbortController();const signal=AbortSignal.any([request.signal,lifetime.signal,abort.signal]);
      const encoder=new TextEncoder();
      const stream=new ReadableStream({async start(controller){
        try{while(!signal.aborted){const value=await dispatch('wait',cursor,signal);if(signal.aborted)break;
          const next=value.hasMore?value.posts?.at(-1)?.seq:value.head;
          if(!Number.isSafeInteger(next)||next<(cursor.since??0)||(value.hasMore&&next===(cursor.since??0)))throw Error('Invalid native event cursor.');
          controller.enqueue(encoder.encode('event: update\nid: '+next+'\ndata: '+JSON.stringify(value)+'\n\n'));
          cursor={...cursor,since:next,revision:value.revision};}}
        catch(error){if(!signal.aborted)controller.error(error);}
        finally{if(signal.aborted)try{controller.close();}catch{}}
      },cancel(){abort.abort();}});
      return new Response(stream,{headers:{'content-type':'text/event-stream','cache-control':'no-store'}});
    });
    route('/api/hive-swarm/v1/screenshot',['GET'],async request=>{
      if(closed)throw Error('Hive Swarm is closed.');
      const empty404=()=>new Response(null,{status:404,headers:{'cache-control':'no-store','x-content-type-options':'nosniff','cross-origin-resource-policy':'same-origin'}});
      const params=new URL(request.url).searchParams;const raw={};
      for(const [key,entry] of params){if(Object.hasOwn(raw,key))return empty404();raw[key]=entry;}
      if(!Object.keys(raw).every(k=>k==='teamId'||k==='seq'||k==='index'))return empty404();
      if(typeof raw.teamId!=='string'||!raw.teamId.trim()||raw.teamId.length>256||raw.teamId.includes('\0'))return empty404();
      if(typeof raw.seq!=='string'||!/^\d+$/.test(raw.seq)||typeof raw.index!=='string'||!/^\d+$/.test(raw.index))return empty404();
      const seq=Number(raw.seq),index=Number(raw.index);
      if(!Number.isSafeInteger(seq)||seq<1||!Number.isSafeInteger(index)||index<0)return empty404();
      const signal=AbortSignal.any([request.signal,lifetime.signal]);signal.throwIfAborted();
      let file=null;
      try{file=await application.screenshot?.({teamId:raw.teamId,seq,index},{signal});}
      catch{file=null;}
      if(!file?.body||!file?.contentType)return empty404();
      return new Response(file.body,{
        status:200,
        headers:{
          'content-type':file.contentType,
          'cache-control':'no-store',
          'x-content-type-options':'nosniff',
          'cross-origin-resource-policy':'same-origin',
        },
      });
    });
  } catch(error) {lifetime.abort();for(const dispose of disposers.reverse())void dispose();throw error;}
  return async()=>{if(closed)return;closed=true;lifetime.abort();for(const dispose of disposers.reverse())await dispose();};
}
