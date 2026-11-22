import {randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';

const never=()=>new AbortController().signal;
const realPathSync=target=>(realpathSync.native??realpathSync)(target);
const normalizePath=(target,platform=process.platform)=>{
  const resolved=realPathSync(target);
  return platform==='win32'?resolved.toLowerCase():resolved;
};
const samePath=(left,right,platform=process.platform)=>normalizePath(left,platform)===normalizePath(right,platform);
const optionalService=(ctx,name)=>{
  try{if(typeof ctx?.get==='function'){const value=ctx.get(name);if(value!==undefined)return value;}}catch{}
  try{return ctx?.[name];}catch{return undefined;}
};
const readTools=new Set(['read','read_image','glob','grep','skill','web_search','web_fetch','todo_write','working_directory','job_list','job_output']);
const writeTools=new Set(['write','edit','apply_patch','job_kill']);
const shellTools=new Set(['bash','pwsh']);
const fallbackSubagentCodes=new Set(['ACTIVATION_LIMIT_REACHED','NO_PROVIDER','UNSUPPORTED_CAPABILITY','CONTINUATION_UNAVAILABLE','PRESET_UNAVAILABLE','UNAUTHORIZED','NOT_RESUMABLE']);

function truncateUtf8(value,maxBytes) {
  const text=String(value??'').trim();
  const encoder=new TextEncoder();
  if(encoder.encode(text).byteLength<=maxBytes)return text;
  let out='';
  for(const ch of text) {
    if(encoder.encode(out+ch+'…').byteLength>maxBytes)break;
    out+=ch;
  }
  return out+'…';
}

function deepFreeze(value) {
  if(!value||typeof value!=='object'||Object.isFrozen(value))return value;
  if(Array.isArray(value))for(const item of value)deepFreeze(item);
  else for(const key of Object.keys(value))deepFreeze(value[key]);
  return Object.freeze(value);
}

function isFallbackSubagentError(error) {
  if(!error||error.securityViolation||error.name==='AbortError')return false;
  return error.name==='SubagentDepthError'||fallbackSubagentCodes.has(error.code);
}

function isForkUnavailableError(error) {
  if(!error||error.securityViolation||error.name==='AbortError')return false;
  if(error.code==='session/fork-unavailable'||error.code==='FORK_UNAVAILABLE'||error.error?.code==='session/fork-unavailable')return true;
  return /session\/fork-unavailable|fork-unavailable|no completed turn/i.test(String(error.message??error));
}

function stripForkFraming(prompt) {
  const note='Note: source chat has no completed turn to fork yet (session/fork-unavailable), so this worker started a clean session. Follow only the Hive Swarm brief below.';
  const text=String(prompt??'');
  if(/^Earlier messages in this chat are source history[^\n]*$/m.test(text)) {
    return text.replace(/^Earlier messages in this chat are source history[^\n]*$/m,note);
  }
  return note+'\n\n'+text;
}

/** Adapter for DSH 0.2.2-rc.5 subagents, Gateway, SessionStore and per-session sandbox contracts. */
export function createNativeAccess(ctx,{ownsSession=()=>false,coordinationTools=[],scopedTools}={}) {
  if(typeof ctx.connection?.createPeer!=='function'||typeof ctx.typertGateway?.invoke!=='function')throw Error('Native DSH Gateway and Connection are unavailable.');
  const peer=ctx.connection.createPeer({principal:{kind:'owner'},interactions:'none'});
  const subagents=optionalService(ctx,'subagents');
  const sessionTitle=optionalService(ctx,'sessionTitle');
  const created=new Set(),scopes=new Map();
  const subagentsSeen=new Set(),subagentParents=new Map(),sessionParents=new Map(),forkFallbacks=new Set(),subagentActivations=new Map(),subagentResumes=new Map(),pendingStarts=new Map(),usedSubagentNames=new Set();
  let disposed=false;
  const owned=id=>{if(disposed||(!created.has(id)&&!ownsSession(id)))throw Error('Only a Hive-owned session may be controlled.');};
  const invoke=(method,request,signal,namespace='session')=>ctx.typertGateway.invoke({namespace,method,args:request===undefined?{}:{request},peer,signal:signal??never()});
  const live=id=>{const agent=ctx.agents?.get(id);if(!agent||agent.session!==ctx.sessions?.get(id))throw Error('The owned native Agent is unavailable.');return agent;};
  const selectionOf=(model,effort)=>({provider:model?.provider,model:model?.model,...effort?{reasoningEffort:effort}:{}});

  function resolveWorkerMode(id,agent,{writable,parentSessionId,policyService}) {
    if(!writable)return 'read-only';
    const resolvedParentId=parentSessionId??subagentParents.get(id)??sessionParents.get(id)??agent.session?.header?.parentSession;
    const parentAgent=resolvedParentId?ctx.agents?.get(resolvedParentId):undefined;
    const parentSession=resolvedParentId?(ctx.sessions?.get(resolvedParentId)??parentAgent?.session):undefined;
    if(!parentSession)return 'workspace-write';
    let parentPolicyService=policyService;
    if(parentAgent?.ctx) {
      const parentPreset=ctx.agentPresets?.composedPreset(parentAgent.ctx);
      parentPolicyService=parentPreset===undefined
        ?ctx.sandboxPolicy
        :ctx.agentPresets.serviceFor(parentAgent,'sandboxPolicy')??parentAgent.ctx?.get?.('sandboxPolicy');
    }
    const parentMode=parentPolicyService?.resolve?.({session:parentSession})?.mode;
    return parentMode==='danger-full-access'?'danger-full-access':'workspace-write';
  }

  function applyToolScope(id,agent,effectiveCtx,{allow,writable}) {
    const releases=[];
    try {
      const scopedDefs=typeof scopedTools==='function'?scopedTools(agent,effectiveCtx):[];
      if(Array.isArray(scopedDefs)&&scopedDefs.length&&typeof effectiveCtx.tools.register==='function') {
        for(const def of scopedDefs) {
          const release=effectiveCtx.tools.register(def.tool??def,def.options);
          if(typeof release==='function')releases.push(release);
        }
      }
      const viewRestrictable=typeof effectiveCtx.tools.view==='function'?effectiveCtx.tools.view(agent)?.restrictableNames:undefined;
      const explicitRestrictable=effectiveCtx.tools.restrictableNames;
      const knownRestrictable=viewRestrictable??(typeof explicitRestrictable==='function'?explicitRestrictable(agent):explicitRestrictable);
      let restrictAllow=knownRestrictable?allow.filter(toolName=>new Set(knownRestrictable).has(toolName)):allow;
      const tryRestrict=names=>{
        try{return {ok:true,release:effectiveCtx.tools.restrict({allow:names})};}
        catch(error){return {ok:false,error};}
      };
      let restricted=tryRestrict(restrictAllow);
      if(!restricted.ok) {
        const emptyProbe=tryRestrict([]);
        if(!emptyProbe.ok)throw restricted.error;
        if(typeof emptyProbe.release==='function')emptyProbe.release();
        const filterRestrictable=items=>{
          if(!items.length)return [];
          const probe=tryRestrict(items);
          if(probe.ok){if(typeof probe.release==='function')probe.release();return items;}
          if(items.length===1)return [];
          const mid=items.length>>1;
          return [...filterRestrictable(items.slice(0,mid)),...filterRestrictable(items.slice(mid))];
        };
        restrictAllow=filterRestrictable(restrictAllow);
        restricted=tryRestrict(restrictAllow);
        if(!restricted.ok)throw restricted.error;
      }
      if(typeof restricted.release==='function')releases.push(restricted.release);
      const permitted=new Set(allow);
      const guardRelease=effectiveCtx.tools.guard(exec=>{
        if(!permitted.has(exec.name))return 'This capability is outside the Hive worker grant.';
        if(!writable&&shellTools.has(exec.name)&&(exec.args?.sandbox_permissions||exec.input?.sandbox_permissions)) {
          return 'Read-only Hive workers cannot escalate shell sandbox permissions.';
        }
        return undefined;
      });
      if(typeof guardRelease==='function')releases.push(guardRelease);
      scopes.set(id,()=>{for(const release of releases.reverse())release();});
    } catch(error) {
      for(const release of releases.reverse()){try{release();}catch{}}
      throw error;
    }
  }

  function validateAndLock(agent,{cwd,writable,selection,agentCtx,parentSessionId}) {
    const id=agent?.id;
    const effectiveCtx=agent?.ctx??agentCtx;
    if(!agent||!id||agent.session!==ctx.sessions?.get(id)||!samePath(agent.session.header.cwd,cwd))throw Error('Owned session workspace does not match.');
    const preset=ctx.agentPresets?.composedPreset(effectiveCtx);
    const service=name=>preset===undefined?ctx[name]:ctx.agentPresets.serviceFor(agent,name)??effectiveCtx?.get?.(name);
    const policyService=service('sandboxPolicy');
    if(service('fs')?.sandboxMode===undefined||service('shell')?.sandboxMode===undefined||typeof policyService?.resolve!=='function') {
      throw Error('Enforcing filesystem and shell sandbox capabilities are required in the worker preset.');
    }
    const mode=resolveWorkerMode(id,agent,{writable,parentSessionId,policyService});
    let policy=policyService.resolve({session:agent.session});
    if(policy?.mode!==mode) {
      agent.session.append('sandbox/mode',{mode});
      policy=policyService.resolve({session:agent.session});
    }
    const confined=mode!=='danger-full-access';
    if(policy?.mode!==mode||
      (confined?(!policy.workspaceRoot||!samePath(policy.workspaceRoot,cwd)):(policy.workspaceRoot!=null&&!samePath(policy.workspaceRoot,cwd)))||
      (confined&&(policy.additionalWritableRoots?.length??0)>0)) {
      throw Error('Native sandbox scope has broader writable roots or the wrong policy.');
    }
    if(typeof effectiveCtx?.tools?.restrict!=='function'||typeof effectiveCtx.tools.guard!=='function'||typeof agent.model?.select!=='function') {
      throw Error('Scoped tools, guards and session-local model selection are unavailable.');
    }
    scopes.get(id)?.();
    scopes.delete(id);
    const definitions=effectiveCtx.tools.definitions(agent);
    const coordination=new Set(coordinationTools);
    const allow=definitions.map(tool=>tool.name).filter(name=>readTools.has(name)||shellTools.has(name)||(writable&&writeTools.has(name))||coordination.has(name));
    applyToolScope(id,agent,effectiveCtx,{allow,writable});
    // SessionController.selectModel also saves the personal default in rc.5. Keep this choice session-local.
    if(selection?.provider&&selection?.model)agent.model.select(selection);
  }

  // Register only when subagents exist so minimal non-subagent injection tests never probe ctx.on.
  const releaseLifecycle=subagents&&typeof ctx.on==='function'?ctx.on('subagent/start',info=>{
    const pending=pendingStarts.get(info?.id);
    if(!pending)return;
    const agent=ctx.agents?.get(info.id);
    try {
      validateAndLock(agent,pending);
      pending.prepared=true;
    } catch(error) {
      error.securityViolation=true;
      pending.error=error;
      try {
        if(typeof agent?.ctx?.tools?.restrict==='function')agent.ctx.tools.restrict({allow:[]});
        if(typeof agent?.ctx?.tools?.guard==='function')agent.ctx.tools.guard(()=>'Hive security policy rejected this worker.');
      } catch {/* Ignore lockdown cleanup error */}
    }
  }):null;

  function registerSubagent(id,parentSessionId) {
    if(typeof id==='string'&&id) {
      subagentsSeen.add(id);
      if(typeof parentSessionId==='string'&&parentSessionId)subagentParents.set(id,parentSessionId);
    }
  }

  async function allocateSubagentName(parentSessionId,memberName,teamId,signal) {
    const raw=String(memberName??'worker').toLowerCase().replaceAll('_','-').replace(/[^a-z0-9-]/g,'-').replace(/^-+|-+$/g,'');
    let slug=raw&&/^[a-z]/.test(raw)?raw:'w-'+(raw||'worker');
    if(slug==='lead')slug='worker-lead';
    const teamTag=String(teamId??'').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,6);
    const suffix=teamTag?'-'+teamTag:'';
    const base=(slug.slice(0,Math.max(1,32-suffix.length)).replace(/-+$/g,'')||'w')+suffix;
    const used=new Set(usedSubagentNames);
    if(typeof subagents?.listDescendants==='function') {
      try {
        const descendants=await subagents.listDescendants(parentSessionId,signal);
        for(const entry of descendants??[])if(entry?.name)used.add(entry.name);
      } catch {/* Ignore unavailable catalog listing */}
    }
    if(!used.has(base)){usedSubagentNames.add(base);return base;}
    for(let n=2;n<100;n++) {
      const tag='-'+n;
      const candidate=base.slice(0,32-tag.length).replace(/-+$/g,'')+tag;
      if(!used.has(candidate)){usedSubagentNames.add(candidate);return candidate;}
    }
    return undefined;
  }

  async function resolveLiveAgent(id) {
    let agent=ctx.agents?.get(id);
    if(!agent&&typeof ctx.sessionController?.resolveAgent==='function') {
      const value=await ctx.sessionController.resolveAgent(id);
      if(value?.error)throw value.error;
      agent=value?.agent;
    }
    return agent;
  }

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

  async function forkParent(parentSessionId,{cwd},signal) {
    if(disposed||typeof parentSessionId!=='string'||!parentSessionId)throw Error('Coordinator history is unavailable to fork.');
    const parentSession=ctx.sessions?.get(parentSessionId);
    if(parentSession?.header?.cwd&&!samePath(parentSession.header.cwd,cwd))throw Error('A native history fork cannot change its immutable workspace.');
    try {
      const value=await invoke('fork',{sessionId:parentSessionId,allowMigration:false},signal);
      if(typeof value?.sessionId!=='string'||!value.sessionId||value.sessionId===parentSessionId)throw Error('Native fork returned no distinct session identity.');
      created.add(value.sessionId);sessionParents.set(value.sessionId,parentSessionId);return value.sessionId;
    } catch(error) {
      if(!signal?.aborted&&isForkUnavailableError(error)) {
        const sessionId=await create({cwd},signal);
        sessionParents.set(sessionId,parentSessionId);
        forkFallbacks.add(sessionId);
        return sessionId;
      }
      throw error;
    }
  }

  async function rename(id,title,signal) {
    owned(id);
    if(subagentsSeen.has(id)||typeof title!=='string'||!title.trim())return;
    const clean=truncateUtf8(title,80);
    try{await invoke('rename',{sessionId:id,title:clean},signal);return;}
    catch{/* Fall back to local sessionTitle service when gateway rename is unavailable */}
    if(signal?.aborted)return;
    const titleService=sessionTitle??optionalService(ctx,'sessionTitle');
    const session=ctx.sessions?.get(id);
    if(session&&typeof titleService?.rename==='function') {
      try{titleService.rename(session,clean);}catch{/* Ignore local sessionTitle failure */}
    }
  }

  async function prepare(id,{cwd,writable,model,effort,parentSessionId},signal) {
    owned(id);signal?.throwIfAborted();
    if(parentSessionId&&!ctx.sessions?.get(parentSessionId)&&!ctx.agents?.get(parentSessionId)&&typeof ctx.sessionController?.resolveAgent==='function') {
      await ctx.sessionController.resolveAgent(parentSessionId).catch(()=>{});
    }
    const agent=await resolveLiveAgent(id);
    const selection=selectionOf(model,effort);
    await ctx.llm?.resolveCallConfig(selection);
    validateAndLock(agent,{cwd,writable,selection,parentSessionId});
    if(!await ctx.sessions.flush(agent.session))throw Error('Session policy has no durable persistence listener.');
  }

  async function startSubagent({teamId,parentSessionId,memberName,label,cwd,writable,model,effort,forkCoordinator,prompt,onStarting,onRollback},signal) {
    if(disposed)throw Error('Native adapter is disposed.');
    signal?.throwIfAborted();
    if(!subagents||typeof subagents.startActivation!=='function'||!parentSessionId)return null;
    const selection=selectionOf(model,effort);
    await ctx.llm?.resolveCallConfig(selection);
    let parent=ctx.agents?.get(parentSessionId);
    if(!parent&&typeof ctx.sessionController?.resolveAgent==='function') {
      try{const resolved=await ctx.sessionController.resolveAgent(parentSessionId);if(!resolved?.error&&resolved?.agent)parent=resolved.agent;}
      catch{/* Fall back cleanly when parent cannot be resumed */}
    }
    if(!parent||ctx.agents?.get(parent.id)!==parent||parent.session!==ctx.sessions?.get(parent.id))return null;
    if(!parent.session?.header?.cwd||!samePath(parent.session.header.cwd,cwd)) {
      if(forkCoordinator)throw Error('A native history fork cannot change its immutable workspace.');
      return null;
    }
    const parentDepth=Math.max(parent.session?.header?.delegationDepth??0,parent.options?.subagentDepth??0);
    const childId=randomUUID();
    const subagentName=await allocateSubagentName(parentSessionId,memberName,teamId,signal);
    const pending={cwd,writable,selection,parentSessionId,prepared:false,error:null};
    pendingStarts.set(childId,pending);
    const rollbackChild=id=>{
      created.delete(id);
      subagentsSeen.delete(id);
      subagentParents.delete(id);
      forkFallbacks.delete(id);
      onRollback?.(id);
    };
    created.add(childId);
    registerSubagent(childId,parentSessionId);
    onStarting?.(childId);
    let activation,forkFallback=false;
    try {
      const baseSpec={
        provider:forkCoordinator?'fork':'spawn',
        parent,
        label:truncateUtf8(label,80),
        cwd,
        prompt:[{type:'text',text:prompt}],
        agentOptions:selection,
        maxDepth:parentDepth+1,
        delivery:'caller',
        childId,
        signal,
      };
      const launchActivation=async spec=>{
        try {
          return await subagents.startActivation({...spec,...subagentName?{name:subagentName}:{}});
        } catch(error) {
          if((error?.code==='INVALID_AGENT_NAME'||error?.code==='DUPLICATE_AGENT_NAME')&&subagentName) {
            return await subagents.startActivation(spec);
          }
          throw error;
        }
      };
      try {
        activation=await launchActivation(baseSpec);
      } catch(error) {
        if(!pending.error&&!signal?.aborted&&forkCoordinator&&isForkUnavailableError(error)) {
          forkFallback=true;
          pending.prepared=false;
          activation=await launchActivation({...baseSpec,provider:'spawn',prompt:[{type:'text',text:stripForkFraming(prompt)}]});
        } else throw error;
      }
    } catch(error) {
      rollbackChild(childId);
      if(pending.error)throw pending.error;
      if(!signal?.aborted&&isFallbackSubagentError(error))return null;
      throw error;
    } finally {
      pendingStarts.delete(childId);
    }
    const actualId=activation.childId??childId;
    if(actualId!==childId) {
      rollbackChild(childId);
      created.add(actualId);
      registerSubagent(actualId,parentSessionId);
      onStarting?.(actualId);
    }
    if(forkFallback)forkFallbacks.add(actualId);
    const done=Promise.resolve(activation.result).catch(()=>{});
    const disposeActivation=async()=>{
      try{await activation.dispose?.();}catch{/* Ignore secondary dispose error */}
      await done;
    };
    if(pending.error){rollbackChild(actualId);await disposeActivation();throw pending.error;}
    subagentActivations.set(actualId,{activation,done});
    if(!pending.prepared) {
      try{await prepare(actualId,{cwd,writable,model,effort,parentSessionId},signal);}
      catch(error){rollbackChild(actualId);subagentActivations.delete(actualId);await disposeActivation();throw error;}
    } else {
      const session=ctx.sessions?.get(actualId);
      if(!session||!await ctx.sessions.flush(session)){
        rollbackChild(actualId);subagentActivations.delete(actualId);await disposeActivation();
        throw Error('Session policy has no durable persistence listener.');
      }
    }
    return {sessionId:actualId,subagentName:activation.name??subagentName,messageId:activation.messageId,executionMode:'subagent',...forkFallback?{forkFallback:true}:{}};
  }

  async function prepareSubagentTurn(id,{parentSessionId,cwd,writable,model,effort},signal) {
    owned(id);signal?.throwIfAborted();
    registerSubagent(id,parentSessionId);
    const priorActivation=subagentActivations.get(id);
    if(priorActivation){await priorActivation.done;subagentActivations.delete(id);}
    const priorResume=subagentResumes.get(id);
    if(priorResume){try{await priorResume.handle.dispose?.();}catch{} subagentResumes.delete(id);}
    const selection=selectionOf(model,effort);
    await ctx.llm?.resolveCallConfig(selection);
    if(parentSessionId&&!ctx.sessions?.get(parentSessionId)&&!ctx.agents?.get(parentSessionId)&&typeof ctx.sessionController?.resolveAgent==='function') {
      await ctx.sessionController.resolveAgent(parentSessionId).catch(()=>{});
    }
    const existing=ctx.agents?.get(id);
    if(existing) {
      validateAndLock(existing,{cwd,writable,selection,parentSessionId});
      if(!await ctx.sessions.flush(existing.session))throw Error('Session policy has no durable persistence listener.');
      return;
    }
    if(typeof ctx.agents?.resume==='function') {
      const handle=await ctx.agents.resume({
        resumeSessionId:id,
        agentOptions:selection,
        signal,
        setup:async(childCtx,child)=>{
          const presets=ctx.agentPresets;
          const presetId=child.session?.header?.agentPreset??presets?.presetForSession?.(child.session);
          if(presetId&&typeof presets?.mount==='function')await presets.mount(childCtx,presetId);
          validateAndLock(child,{cwd,writable,selection,agentCtx:childCtx,parentSessionId});
        },
      });
      try {
        if(!handle?.agent||handle.agent.session!==ctx.sessions?.get(id))throw Error('Resumed subagent session mismatch.');
        if(selection.provider&&selection.model)handle.agent.model?.select?.(selection);
        if(!await ctx.sessions.flush(handle.agent.session))throw Error('Session policy has no durable persistence listener.');
        subagentResumes.set(id,{handle});
      } catch(error) {
        await handle?.dispose?.().catch(()=>{});
        throw error;
      }
      return;
    }
    pendingStarts.set(id,{cwd,writable,selection,parentSessionId,prepared:false,error:null});
  }

  async function promptSubagentTurn({sessionId,requestId,parentSessionId,cwd,writable,model,effort,prompt},signal) {
    owned(sessionId);signal?.throwIfAborted();
    const resumed=subagentResumes.get(sessionId);
    const warmAgent=resumed?.handle?.agent??(typeof ctx.agents?.get(sessionId)?.followup==='function'?ctx.agents.get(sessionId):null);
    if(warmAgent&&typeof warmAgent.followup==='function') {
      const selection=selectionOf(model,effort);
      if(selection.provider&&selection.model)warmAgent.model?.select?.(selection);
      const message=deepFreeze({id:randomUUID(),role:'user',content:[{type:'text',text:prompt}],source:{kind:'user',rpcId:requestId}});
      warmAgent.followup(message);
      return {accepted:true};
    }
    const pending=pendingStarts.get(sessionId);
    try {
      const receipt=await invoke('prompt',{requestId,childSessionId:sessionId,delivery:'queue',content:[{type:'text',text:prompt}]},signal,'subagents');
      if(pending?.error) {
        await subagents?.interrupt?.(sessionId,{kind:'user'}).catch(()=>{});
        throw pending.error;
      }
      if(pending&&!pending.prepared&&ctx.agents?.get(sessionId)) {
        await prepare(sessionId,{cwd,writable,model,effort,parentSessionId:parentSessionId??pending.parentSessionId},signal);
      }
      return receipt;
    } finally {
      pendingStarts.delete(sessionId);
    }
  }

  async function disposeResumedHandle(id,resumed,{cancelOnFailure=false}={}) {
    try {
      while(true) {
        await resumed.handle.agent.whenIdle();
        if(!resumed.handle.agent.inbox?.hasPending)break;
      }
      await ctx.sessions?.flush?.(resumed.handle.agent.session).catch(()=>{});
      await resumed.handle.dispose();
    } catch(error) {
      if(!cancelOnFailure)throw error;
      try{resumed.handle.agent.cancel?.({kind:'user'});await resumed.handle.agent.whenIdle();await resumed.handle.dispose();}catch{}
    } finally {subagentResumes.delete(id);}
  }

  async function settleTurn(id) {
    const active=subagentActivations.get(id);
    if(active){try{await active.done;}finally{subagentActivations.delete(id);}}
    const resumed=subagentResumes.get(id);
    if(resumed)await disposeResumedHandle(id,resumed);
  }

  async function releaseTurn(id) {
    pendingStarts.delete(id);
    const active=subagentActivations.get(id);
    if(active) {
      try{await active.activation.dispose?.().catch(()=>{});await active.done;}
      finally{subagentActivations.delete(id);}
    }
    const resumed=subagentResumes.get(id);
    if(resumed)await disposeResumedHandle(id,resumed,{cancelOnFailure:true});
  }

  async function events(id,signalOrOpts,maybeOpts) {
    const signal=signalOrOpts&&(signalOrOpts instanceof AbortSignal||typeof signalOrOpts.aborted==='boolean')?signalOrOpts:undefined;
    const opts=(!signal&&signalOrOpts&&typeof signalOrOpts==='object'?signalOrOpts:maybeOpts)??{};
    owned(id);
    const isSubagent=subagentsSeen.has(id)||opts.executionMode==='subagent';
    const parentSessionId=opts.parentSessionId??subagentParents.get(id);
    if(isSubagent&&!parentSessionId)throw Error('Parent session identity is required to read subagent history.');
    const address=isSubagent?{kind:'subagent',parentSessionId,childSessionId:id,mode:'continuable'}:{kind:'session',sessionId:id};
    const afterSeq=Number.isSafeInteger(opts.afterSeq)&&opts.afterSeq>=0?opts.afterSeq:undefined;
    const records=[];let beforeSeq,throughSeq;
    for(let page=0;page<100;page++) {
      const value=await invoke('events',{address,maxMessages:afterSeq!==undefined&&page===0?200:1000,
        ...beforeSeq===undefined?{}:{beforeSeq},...throughSeq===undefined?{}:{throughSeq}},signal);
      throughSeq??=value.cursor;
      const batch=(value.records??[]).map(record=>record.event??record);
      for(const ev of batch) {
        if(afterSeq===undefined||ev.seq>afterSeq)records.push(ev);
      }
      if(!value.hasMore||!batch.length)return records;
      const earliest=Math.min(...batch.map(event=>event.seq));
      if(afterSeq!==undefined&&earliest<=afterSeq)return records;
      if(!Number.isSafeInteger(earliest)||beforeSeq!==undefined&&earliest>=beforeSeq)throw Error('Native history cursor made no progress.');
      beforeSeq=earliest;
    }
    throw Error('Native history is too large to verify automatically. Inspect the owned session.');
  }

  async function flush(id,signal) {
    owned(id);signal?.throwIfAborted();
    const session=ctx.sessions?.get(id);
    if(!session){
      const state=await invoke('state',{sessionId:id},signal);
      if(state.active||state.running)throw Error('Native session changed during passive recovery.');
      // The subsequent events read uses the cold stored history; do not resume merely to flush it.
      return;
    }
    if(!await ctx.sessions.flush(session))throw Error('Native durable persistence is unavailable.');
  }

  async function cancel(id,opts={}) {
    owned(id);
    pendingStarts.delete(id);
    const active=subagentActivations.get(id);
    if(active) {
      try {
        if(typeof active.activation.dispose==='function')await active.activation.dispose();
        else if(typeof subagents?.interrupt==='function')await subagents.interrupt(id,{kind:'user'});
        else await ctx.typertGateway.invoke({namespace:'subagents',method:'interruptByUser',args:{childSessionId:id},peer,signal:never()});
      } finally {
        await active.done;
        subagentActivations.delete(id);
      }
      await flush(id);
      return;
    }
    const resumed=subagentResumes.get(id);
    if(resumed) {
      try {
        resumed.handle.agent.cancel({kind:'user'});
        await resumed.handle.agent.whenIdle();
        await ctx.sessions?.flush?.(resumed.handle.agent.session).catch(()=>{});
        await resumed.handle.dispose();
      } finally {subagentResumes.delete(id);}
      return;
    }
    if(subagentsSeen.has(id)||opts?.executionMode==='subagent') {
      if(typeof subagents?.interrupt==='function')await subagents.interrupt(id,{kind:'user'});
      else await ctx.typertGateway.invoke({namespace:'subagents',method:'interruptByUser',args:{childSessionId:id},peer,signal:never()});
      const agent=ctx.agents?.get(id);
      if(agent)await agent.whenIdle();
      await flush(id);
      return;
    }
    await invoke('cancel',{sessionId:id});await live(id).whenIdle();await flush(id);
  }

  async function sessionRoute(agent,signal) {
    if(!agent)return null;
    const cwd=agent.session?.header?.cwd;
    const currentModel=typeof agent.model?.current==='function'?agent.model.current():agent.model?.current;
    const sel=currentModel??agent.model?.selection??(typeof agent.model?.get==='function'?agent.model.get():null);
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
        const parentSessionId=subagentParents.get(agent.id)??(agent.session?.header?.origin==='subagent'?agent.session.header.parentSession:undefined);
        const address=(subagentsSeen.has(agent.id)||agent.session?.header?.origin==='subagent')&&parentSessionId
          ?{kind:'subagent',parentSessionId,childSessionId:agent.id,mode:'continuable'}
          :{kind:'session',sessionId:agent.id};
        let beforeSeq,throughSeq;
        for(let page=0;page<5;page++) {
          const value=await invoke('events',{address,maxMessages:200,
            ...beforeSeq===undefined?{}:{beforeSeq},...throughSeq===undefined?{}:{throughSeq}},signal);
          throughSeq??=value?.cursor;
          const recs=value?.records??[];
          for(const record of [...recs].reverse()) {
            const ev=record?.event??record;
            const cfg=ev?.type==='request/header'?ev.data?.header?.config:(ev?.type==='model/selection'||ev?.type==='model/selected')?ev.data:null;
            if(cfg?.provider&&cfg?.model){provider=cfg.provider;model=cfg.model;effort??=cfg.reasoningEffort;break;}
          }
          if((provider&&model)||!value?.hasMore||!recs.length)break;
          const earliest=Math.min(...recs.map(r=>(r?.event??r)?.seq));
          if(!Number.isSafeInteger(earliest)||(beforeSeq!==undefined&&earliest>=beforeSeq))break;
          beforeSeq=earliest;
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

  return {listModels,sessionRoute,create,forkParent,rename,prepare,startSubagent,prepareSubagentTurn,promptSubagentTurn,settleTurn,releaseTurn,registerSubagent,events,flush,cancel,
    wasForkFallback:id=>forkFallbacks.has(id),
    fork:async(id,signal,opts={})=>{
      owned(id);
      try {
        const value=await invoke('fork',{sessionId:id,allowMigration:false},signal);
        if(typeof value?.sessionId!=='string'||!value.sessionId||value.sessionId===id)throw Error('Native fork returned no distinct session identity.');
        created.add(value.sessionId);return value.sessionId;
      } catch(error) {
        const fallbackCwd=opts?.cwd??ctx.sessions?.get(id)?.header?.cwd;
        if(!signal?.aborted&&fallbackCwd&&isForkUnavailableError(error)) {
          const sessionId=await create({cwd:fallbackCwd},signal);
          forkFallbacks.add(sessionId);
          return sessionId;
        }
        throw error;
      }
    },
    currentTurn:id=>{owned(id);return ctx.agents.turnBoundaryOf(live(id).session)},
    isCurrentAgent:agent=>Boolean(agent&&ctx.agents?.get(agent.id)===agent&&ctx.sessions?.get(agent.id)===agent.session),
    state:async(id,signal)=>{owned(id);return invoke('state',{sessionId:id},signal)},
    prompt:async(request,signal)=>{owned(request.sessionId);return invoke('prompt',request,signal)},
    wait:async(id,signal)=>{owned(id);return invoke('wait',{sessionId:id,timeoutMs:30000,maxMessages:1},signal)},
    async dispose(){
      if(disposed)return;disposed=true;
      try{releaseLifecycle?.();}catch{}
      for(const release of scopes.values())release();scopes.clear();
      pendingStarts.clear();subagentActivations.clear();subagentResumes.clear();sessionParents.clear();forkFallbacks.clear();
      await peer.dispose();
    },
  };
}
