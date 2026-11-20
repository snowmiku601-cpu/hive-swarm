import {realpathSync} from 'node:fs';

const never=()=>new AbortController().signal;
const samePath=(left,right)=>realpathSync(left)===realpathSync(right);
const readTools=new Set(['read','read_image','glob','grep','skill','web_search','web_fetch','todo_write','working_directory','job_list','job_output']);
const writeTools=new Set(['write','edit','apply_patch','job_kill']);
const shellTools=new Set(['bash','pwsh']);

/** Adapter for the pinned rc.5 public Gateway, SessionStore and per-session sandbox contracts. */
export function createNativeAccess(ctx,{ownsSession=()=>false,coordinationTools=[]}={}) {
  if(typeof ctx.connection?.createPeer!=='function'||typeof ctx.typertGateway?.invoke!=='function')throw Error('Native DSH Gateway and Connection are unavailable.');
  const peer=ctx.connection.createPeer({principal:{kind:'owner'},interactions:'none'});
  const created=new Set(),scopes=new Map();let disposed=false;
  const owned=id=>{if(disposed||(!created.has(id)&&!ownsSession(id)))throw Error('Only a Hive-owned session may be controlled.');};
  const invoke=(method,request,signal)=>ctx.typertGateway.invoke({namespace:'session',method,args:request===undefined?{}:{request},peer,signal:signal??never()});
  const live=id=>{const agent=ctx.agents?.get(id);if(!agent||agent.session!==ctx.sessions?.get(id))throw Error('The owned native Agent is unavailable.');return agent;};
  async function listModels() {
    const catalog=await invoke('modelCatalog');
    if(!Array.isArray(catalog.groups))throw Error('Native model catalog is unavailable.');
    return catalog.groups.flatMap(group=>group.models.map(model=>({id:group.id+'/'+model.id,provider:group.id,model:model.id,
      label:group.name+' · '+model.name,efforts:model.reasoning?.efforts?.map(e=>e.id)??[],defaultEffort:model.reasoning?.defaultEffort,
      default:catalog.default?.provider===group.id&&catalog.default?.model===model.id})));
  }
  async function create({cwd},signal) {
    const workspace=ctx.workspaceRegistry?.list().find(item=>samePath(item.path,cwd));
    const value=await invoke('create',workspace?{workspaceId:workspace.id}:{cwd},signal);
    if(typeof value?.sessionId!=='string'||!value.sessionId)throw Error('Native create returned no session identity.');
    created.add(value.sessionId);return value.sessionId;
  }
  async function prepare(id,{cwd,writable,model,effort},signal) {
    owned(id);signal?.throwIfAborted();
    let agent=ctx.agents?.get(id);
    if(!agent){if(typeof ctx.sessionController?.resolveAgent!=='function')throw Error('Native preset-preserving Agent resume is unavailable.');
      const value=await ctx.sessionController.resolveAgent(id);if(value.error)throw value.error;agent=value.agent;}
    if(agent.session!==ctx.sessions.get(id)||!samePath(agent.session.header.cwd,cwd))throw Error('Owned session workspace does not match.');
    const preset=ctx.agentPresets?.composedPreset(agent.ctx);
    const service=name=>preset===undefined?ctx[name]:ctx.agentPresets.serviceFor(agent,name)??agent.ctx.get?.(name);
    const policyService=service('sandboxPolicy');
    if(service('fs')?.sandboxMode===undefined||service('shell')?.sandboxMode===undefined||typeof policyService?.resolve!=='function')throw Error('Enforcing filesystem and shell sandbox capabilities are required in the worker preset.');
    const mode=writable?'workspace-write':'read-only';
    agent.session.append('sandbox/mode',{mode});
    const policy=policyService.resolve({session:agent.session});
    if(policy.mode!==mode||!samePath(policy.workspaceRoot,cwd)||(policy.additionalWritableRoots?.length??0)>0)throw Error('Native sandbox scope has broader writable roots or the wrong policy.');
    if(typeof agent.ctx?.tools?.restrict!=='function'||typeof agent.ctx.tools.guard!=='function'||typeof agent.model?.select!=='function')throw Error('Scoped tools, guards and session-local model selection are unavailable.');
    const definitions=agent.ctx.tools.definitions(agent);
    const coordination=new Set(coordinationTools);
    const allow=definitions.map(tool=>tool.name).filter(name=>readTools.has(name)||shellTools.has(name)||(writable&&writeTools.has(name))||coordination.has(name));
    scopes.get(id)?.();const releases=[agent.ctx.tools.restrict({allow})];const permitted=new Set(allow);
    releases.push(agent.ctx.tools.guard(exec=>{
      if(!permitted.has(exec.name))return 'This capability is outside the Hive worker grant.';
      if(!writable&&shellTools.has(exec.name)&&(exec.args?.sandbox_permissions||exec.input?.sandbox_permissions))return 'Read-only Hive workers cannot escalate shell sandbox permissions.';
      return undefined;
    }));
    scopes.set(id,()=>{for(const release of releases.reverse())release()});
    // SessionController.selectModel also saves the personal default in rc.5. Keep this choice session-local.
    const selection={provider:model.provider,model:model.model,...effort?{reasoningEffort:effort}:{}};
    await ctx.llm?.resolveCallConfig(selection);agent.model.select(selection);
    if(!await ctx.sessions.flush(agent.session))throw Error('Session policy has no durable persistence listener.');
  }
  async function events(id,signal) {
    owned(id);const records=[];let beforeSeq,throughSeq;
    for(let page=0;page<100;page++) {
      const value=await invoke('events',{address:{kind:'session',sessionId:id},maxMessages:1000,
        ...beforeSeq===undefined?{}:{beforeSeq},...throughSeq===undefined?{}:{throughSeq}},signal);
      throughSeq??=value.cursor;
      const batch=value.records.map(record=>record.event);records.push(...batch);
      if(!value.hasMore)return records;
      const earliest=Math.min(...batch.map(event=>event.seq));
      if(!Number.isSafeInteger(earliest)||beforeSeq!==undefined&&earliest>=beforeSeq)throw Error('Native history cursor made no progress.');
      beforeSeq=earliest;
    }
    throw Error('Native history is too large to verify automatically. Inspect the owned session.');
  }
  async function flush(id,signal) {owned(id);signal?.throwIfAborted();const session=ctx.sessions?.get(id);
    if(!session){const state=await invoke('state',{sessionId:id},signal);
      if(state.active||state.running)throw Error('Native session changed during passive recovery.');
      // The subsequent events read uses the cold stored history; do not resume merely to flush it.
      return;
    }
    if(!await ctx.sessions.flush(session))throw Error('Native durable persistence is unavailable.');}
  async function cancel(id) {owned(id);await invoke('cancel',{sessionId:id});await live(id).whenIdle();await flush(id);}
  async function sessionRoute(agent,signal) {
    if(!agent)return null;
    const cwd=agent.session?.header?.cwd;
    const sel=agent.model?.current??agent.model?.selection??(typeof agent.model?.get==='function'?agent.model.get():null);
    let provider=sel?.provider,model=sel?.model,effort=sel?.reasoningEffort;
    if(!provider||!model) {
      try {
        const st=await invoke('state',{sessionId:agent.id},signal);
        const m=st?.model??st?.selection??st?.config;
        if(m?.provider&&m?.model){provider=m.provider;model=m.model;effort??=m.reasoningEffort;}
      } catch {/* Ignore unsupported state shape */}
    }
    if(!provider||!model) {
      try {
        const value=await invoke('events',{address:{kind:'session',sessionId:agent.id},maxMessages:40},signal);
        for(const record of [...(value?.records??[])].reverse()) {
          const ev=record?.event??record;
          const cfg=ev?.type==='request/header'?ev.data?.header?.config:(ev?.type==='model/selection'||ev?.type==='model/selected')?ev.data:null;
          if(cfg?.provider&&cfg?.model){provider=cfg.provider;model=cfg.model;effort??=cfg.reasoningEffort;break;}
        }
      } catch {/* Ignore unavailable session events */}
    }
    return {
      sessionId:agent.id,
      ...(typeof cwd==='string'&&cwd?{cwd}:{}),
      ...(provider&&model?{model:provider+'/'+model,provider,modelId:model}:{}),
      ...(typeof effort==='string'&&effort?{effort}:{}),
    };
  }
  return {listModels,sessionRoute,create,prepare,events,flush,cancel,
    fork:async(id,signal)=>{owned(id);const value=await invoke('fork',{sessionId:id,allowMigration:false},signal);
      if(typeof value?.sessionId!=='string'||!value.sessionId||value.sessionId===id)throw Error('Native fork returned no distinct session identity.');
      created.add(value.sessionId);return value.sessionId;},
    currentTurn:id=>{owned(id);return ctx.agents.turnBoundaryOf(live(id).session)},
    isCurrentAgent:agent=>Boolean(agent&&ctx.agents?.get(agent.id)===agent&&ctx.sessions?.get(agent.id)===agent.session),
    state:async(id,signal)=>{owned(id);return invoke('state',{sessionId:id},signal)},
    prompt:async(request,signal)=>{owned(request.sessionId);return invoke('prompt',request,signal)},
    wait:async(id,signal)=>{owned(id);return invoke('wait',{sessionId:id,timeoutMs:30000,maxMessages:1},signal)},
    async dispose(){if(disposed)return;disposed=true;for(const release of scopes.values())release();scopes.clear();await peer.dispose();},
  };
}
