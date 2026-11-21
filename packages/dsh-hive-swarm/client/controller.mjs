// A read path never starts a run. Only explicit commands cross the Host action bridge.
const RPC_METHODS = {snapshot:'hive-swarm/v1/snapshot',command:'hive-swarm/v1/command',wait:'hive-swarm/v1/events'};
const NATIVE_HOST = 'deepseek-harness';
const headOf = team => (team?.events??[]).reduce((head,event)=>Math.max(head,event.seq),team?.head??0);
const errorOf = error => ({message:typeof error==='string'?error:error?.message??'The Swarm connection is unavailable.',
  code:typeof error?.code==='string'?error.code:'connection'});
const requestIdentity = () => globalThis.crypto.randomUUID();
export const ownedSession = member => member?.session?.host===NATIVE_HOST?member.session.id:undefined;
export function sessionTarget(team,member) {
  const id=ownedSession(member);
  if(!id)return null;
  if(member?.executionMode==='subagent'&&typeof team?.parentSessionId==='string'&&team.parentSessionId.trim()) {
    return {parentSessionId:team.parentSessionId.trim(),childSessionId:id,mode:'continuable'};
  }
  return id;
}

async function swarmRpc(connection,method,payload,signal) {
  if(typeof connection?.rpc?.call!=='function')throw Error('DSH Connection RPC is unavailable. Enable the Connection capability and reload Hive Swarm.');
  // The Connection SDK posts a correlated request envelope to this exact Host Fetch route.
  const response=await connection.rpc.call('/api',RPC_METHODS[method],payload,signal);
  if(signal.aborted)throw signal.reason??new DOMException('Cancelled','AbortError');
  if(!response?.ok){const error=Error(errorOf(response?.error).message);error.code=response?.error?.code;throw error;}
  return response.value;
}

export async function readExactTeam(connection,teamId,signal) {
  const {team}=await swarmRpc(connection,'snapshot',{teamId},signal)??{};
  if(team?.id!==teamId||team.host!==NATIVE_HOST||typeof team.cwd!=='string'||!team.cwd.trim()) {
    throw Error('The Swarm team is unavailable in this Host. Check its workspace and access.');
  }
  return team;
}

function journalTurns(turns) {
  return Array.isArray(turns)?turns.map((turn,index)=>{
    const entries=Array.isArray(turn.items)?turn.items:[];
    const turnNumber=Number(turn.turn??turn.id);
    return {turn:Number.isSafeInteger(turnNumber)&&turnNumber>0?turnNumber:index+1,status:turn.status,
      steps:turn.steps??entries.filter(item=>item.type==='activity'),
      report:turn.report??entries.findLast(item=>item.type==='agentMessage'&&item.phase==='final')?.text};
  }):[];
}

function workspaceKey(path) {
  if(typeof path!=='string'||!path)return null;
  const windows=/^(?:[a-z]:[\\/]|\\\\)/i.test(path);
  const normalized=windows?path.replaceAll('\\','/').toLowerCase():path;
  return normalized.replace(/\/+$/,'')||'/';
}

export function createController({connection,teamId=null,sessionId=null,workspace=null,openSession}={}) {
  const workspaceId=workspaceKey(workspace);
  const inWorkspace=team=>!workspaceId||workspaceKey(team.cwd)===workspaceId;
  let selected=teamId||null,refs=0,disposed=false,generation=0,scope=null,cursor=null,retry=null,historyAfter=0,journalRequest=null;
  let state={teams:[],team:null,selectedId:selected,sessionId,workspace,loading:false,connection:'idle',error:null,pending:false,
    models:[],modelsLoading:false,journal:null,history:[],hasMoreHistory:false,historyLoading:false};
  const listeners=new Set(),requests=new Set();
  const emit=patch=>{if(disposed)return;state={...state,...patch};for(const listener of listeners)listener();};
  const active=(token,signal)=>!disposed&&refs>0&&token===generation&&!signal.aborted;
  function cancel() {
    generation++;scope?.abort();scope=null;
    for(const request of requests)request.abort();requests.clear();
  }
  const rpc=(method,payload,signal)=>swarmRpc(connection,method,payload,signal);
  function mergeHistory(events) {
    const history=new Map(state.history.map(event=>[event.seq,event]));
    for(const event of events)history.set(event.seq,event);
    return [...history.values()].sort((a,b)=>a.seq-b.seq);
  }
  function accept(team) {
    if(!team||team.id!==selected)throw Error('The Host returned a different team. Select the team again.');
    if(team.host!==NATIVE_HOST)throw Error('This team does not belong to the native DSH Host.');
    if(!inWorkspace(team))throw Error('This team is outside the parent workspace. Choose a team from this workspace.');
    cursor??=headOf(team);
    if(state.team&&headOf(team)<headOf(state.team))return;
    emit({team,history:mergeHistory(team.events??[])});
  }
  async function snapshot(signal,token) {
    const value=await rpc('snapshot',selected?{teamId:selected}:{},signal);
    if(!active(token,signal))return;
    if(!Array.isArray(value?.teams))throw Error('The Swarm snapshot is invalid. Refresh to reconnect.');
    const teams=value.teams.filter(team=>team.host===NATIVE_HOST&&inWorkspace(team));
    if(selected){
      try{accept(value.team);}catch(error){emit({teams,team:null});throw error;}
      if(!teams.some(team=>team.id===selected))teams.push(value.team);
    }else emit({team:null});
    emit({teams,loading:false,error:state.error?.action?state.error:null,connection:'connected'});
  }
  async function follow(signal,token) {
    try {
      while(selected&&active(token,signal)) {
        const since=cursor??0,revision=state.team?.revision;
        const update=await rpc('wait',{teamId:selected,since,...revision?{revision}:{},timeoutSec:50},signal);
        if(!active(token,signal))return;
        if(!Number.isSafeInteger(update?.head)||update.head<0)throw Error('The Swarm event cursor is invalid. Refresh to reconnect.');
        const posts=Array.isArray(update.posts)?update.posts:[];
        if(update.hasMore) {
          const delivered=posts.at(-1)?.seq;
          if(!Number.isSafeInteger(delivered)||delivered<=since||delivered>update.head)throw Error('The Swarm history page has an invalid cursor. Refresh to reconnect.');
          cursor=delivered;
        }else cursor=Math.max(since,update.head);
        if(posts.length)emit({history:mergeHistory(posts)});
        if(update.wokeBy==='timeout'&&cursor===since&&update.revision===revision&&!posts.length)continue;
        await snapshot(signal,token);
      }
    } catch(error) {
      if(active(token,signal))emit({loading:false,connection:'disconnected',error:errorOf(error)});
    }
  }
  async function connect() {
    scope?.abort();scope=null;if(disposed||!refs)return;
    const controller=new AbortController();scope=controller;const token=generation,signal=controller.signal;
    emit({loading:state.team===null,connection:'connecting',error:state.error?.action?state.error:null});
    try{await snapshot(signal,token);if(active(token,signal)&&selected)void follow(signal,token);}
    catch(error){if(active(token,signal))emit({loading:false,connection:'disconnected',error:errorOf(error)});}
  }
  async function read(action,args={},controller=new AbortController()) {
    requests.add(controller);const token=generation;
    try {
      const value=await rpc('command',{action,args:selected?{...args,teamId:selected}:args,requestId:requestIdentity()},controller.signal);
      if(disposed||token!==generation)throw new DOMException('Selection changed','AbortError');
      return value;
    } finally {requests.delete(controller);}
  }
  async function execute(payload) {
    if(disposed||!selected||!state.team)throw Error('Select a team before changing it.');
    if(state.connection!=='connected')throw Error('Refresh the connection before changing the team.');
    if(state.pending)throw Error('Wait for the current action to finish.');
    const controller=new AbortController();requests.add(controller);const token=generation;
    emit({pending:true,error:null});
    try {
      const value=await rpc('command',payload,controller.signal);
      if(disposed||token!==generation)throw new DOMException('Selection changed','AbortError');
      retry=null;if(value?.id)accept(value);else await snapshot(scope.signal,token);
      emit({pending:false,error:null});return value;
    } catch(error) {
      if(!disposed&&token===generation){
        const issue=errorOf(error),uncertain=!issue.code.startsWith('hive-swarm/')||/outcome unconfirmed/i.test(issue.message);
        retry=uncertain?payload:null;
        emit({pending:false,error:{...issue,action:uncertain}});
      }
      throw error;
    } finally {requests.delete(controller);}
  }
  const api={
    getSnapshot:()=>state,
    subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
    retain() {
      if(disposed)return()=>{};
      refs++;if(refs===1)void connect();let released=false;
      return()=>{if(released)return;released=true;if(--refs===0){cancel();emit({connection:'idle',loading:false,pending:false,
        modelsLoading:false,historyLoading:false,journal:null});}};
    },
    async selectTeam(id) {
      cancel();selected=id||null;cursor=null;historyAfter=0;retry=null;
      emit({team:null,selectedId:selected,journal:null,history:[],hasMoreHistory:false,historyLoading:false,modelsLoading:false,error:null,pending:false,loading:Boolean(refs)});
      // Selection waits for its snapshot, never for the open event stream.
      await connect();
    },
    refresh:()=>{void connect();},
    showTeams:()=>api.selectTeam(null),
    command(action,args={}) {
      const ownedArgs={...args,teamId:selected};
      const sameRetry=retry?.action===action&&JSON.stringify(retry.args)===JSON.stringify(ownedArgs);
      return execute(sameRetry?retry:{action,args:ownedArgs,requestId:requestIdentity()});
    },
    retryCommand:()=>retry?execute(retry):Promise.reject(Error('There is no action to retry.')),
    async loadModels() {
      emit({modelsLoading:true});try{const value=await read('list_models');emit({models:value.models??[],modelsLoading:false});}
      catch(error){if(error?.name!=='AbortError')emit({modelsLoading:false,error:errorOf(error)});}
    },
    async openJournal(member) {
      const owned=state.team?.members.find(item=>item.name===member);
      const id=ownedSession(owned);
      if(!id){emit({error:{message:'This member has no owned session yet.'}});return;}
      journalRequest?.abort();const request=new AbortController();journalRequest=request;
      emit({journal:{member,loading:true,turns:[],error:null}});
      try {
        const value=await read('read_journal',{member},request);
        if(value.threadId&&value.threadId!==id)throw Error('The member’s session changed. Refresh its Journal to continue.');
        if(journalRequest===request&&state.journal?.member===member)emit({journal:{...value,member,turns:journalTurns(value.turns),loading:false}});
      } catch(error) {
        if(error?.name!=='AbortError'&&journalRequest===request&&state.journal?.member===member)emit({journal:{...state.journal,loading:false,error:errorOf(error)}});
      }
    },
    closeJournal:()=>{journalRequest?.abort();journalRequest=null;emit({journal:null});},
    async loadHistory({reset=false}={}) {
      if(state.historyLoading||!selected)return;
      emit({historyLoading:true});
      try {
        const after=reset?0:historyAfter;
        const page=await read('board_history',{after,limit:200});
        const events=page.posts??page.events??[];
        historyAfter=events.at(-1)?.seq??after;
        emit({history:mergeHistory(events),historyLoading:false,hasMoreHistory:page.hasMore===true});
      } catch(error){if(error?.name!=='AbortError')emit({historyLoading:false,error:errorOf(error)});}
    },
    async openSession(member,{fallbackToJournal=true}={}) {
      const owned=state.team?.members.find(item=>item.name===member);
      const target=sessionTarget(state.team,owned);
      if(!target){emit({error:{message:'This member has no owned session yet.'}});return 'none';}
      if(typeof openSession==='function') {
        try{await openSession(target);return 'session';}
        catch{
          if(!fallbackToJournal)return 'fallback';
          await api.openJournal(member);return 'journal';
        }
      }
      if(!fallbackToJournal)return 'fallback';
      await api.openJournal(member);return 'journal';
    },
    setError:error=>emit({error:errorOf(error)}),
    dispose(){if(disposed)return;cancel();disposed=true;listeners.clear();},
  };
  return api;
}

// Full-panel expansion retains the same controller instead of copying its team selection.
export function createSurfaceStore(create) {
  const sessions=new Map(),listeners=new Set();let current=null;
  const forSession=(sessionId,teamId,workspace)=>{
    const key=JSON.stringify([sessionId??null,teamId??null,workspaceKey(workspace)]);
    if(!sessions.has(key))sessions.set(key,create(sessionId,teamId,workspace));
    return sessions.get(key);
  };
  const initial=forSession(null);
  return {forSession,getSnapshot:()=>current??initial,
    subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
    select(controller){current=controller;for(const listener of listeners)listener();},
    reconnect(){for(const controller of sessions.values())controller.refresh();},
    dispose(){for(const controller of sessions.values())controller.dispose();sessions.clear();listeners.clear();}};
}
