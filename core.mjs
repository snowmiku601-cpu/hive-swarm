import {mkdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {TeamBoard,boardWaitTimeout,configuredEffort,pendingWaitFor,stallIssues,teamPhase,visibleChannels} from './engine.mjs';
import {openWorktree,removeWorktree,worktreeSource} from './worktrees.mjs';

const reads=new Set(['list_teams','board_status','board_history','read_board','list_models','read_journal','open_swarm_panel','wait_for_board']);
const workerActions=new Set(['board_status','board_history','read_board','list_models','post_to_board','set_turn_outcome','add_member','retire_member','set_member_model','manage_channel']);
const coordinatorActions=new Set(['set_team_title','set_team_plan']);

function signature(value) {
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(signature).join(',')+']';
  if(value&&typeof value==='object'&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)) {
    return '{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+signature(value[k])).join(',')+'}';
  }
  throw Error('Command arguments must be plain JSON values.');
}

export function normalizeModels(models) {
  if(!Array.isArray(models))throw Error('Host model catalog is unavailable.');
  return models.map(model=>({id:model.id??model.model,label:model.label??model.displayName??model.id??model.model,
    efforts:model.efforts??model.supportedReasoningEfforts?.map(e=>e.reasoningEffort)??[],
    defaultEffort:model.defaultEffort??model.defaultReasoningEffort})).filter(model=>typeof model.id==='string'&&model.id);
}

export function presentTeam(team,{activity={},actor,host=team.host??'codex'}={}) {
  const selected=actor&&team.members.find(member=>member.name===actor);
  const visible=visibleChannels(selected);
  const events=visible?team.events.filter(event=>visible.includes(event.channel??'main')):team.events;
  const recovery=team.members.filter(m=>m.recoveryRequired).map(m=>({kind:'recovery',member:m.name,text:'@'+m.name+' outcome unconfirmed. Inspect the owned session before continuing.'}));
  const input=team.members.filter(m=>m.inputRequired).map(m=>({kind:'input',member:m.name,text:'@'+m.name+' needs your permission or input in its owned DSH session.'}));
  return {id:team.id,host,title:team.title,cwd:team.cwd,task:team.task,model:team.model,effort:team.effort,
    ...(team.parentSessionId?{parentSessionId:team.parentSessionId}:{}),
    ...(team.fallbackModel?{fallbackModel:team.fallbackModel,...(team.fallbackEffort!==undefined?{fallbackEffort:team.fallbackEffort}:{})}:{}),
    ...(team.threads?.length?{threads:team.threads}:{}),
    paused:team.paused,turns:team.turns,turnLimit:team.turnLimit,phase:teamPhase(team),channels:team.channels,activity,
    attention:[...input,...recovery,...stallIssues(team)],events:events.slice(-60),
    members:team.members.map(member=>{
      const executionMode=member.executionMode??(member.threadId?'session':undefined);
      return {name:member.name,role:member.role,group:member.group,brief:member.brief,
        status:member.status,writable:member.writable,threadId:member.threadId,
        ...(executionMode?{executionMode}:{}),
        ...(member.subagentName?{subagentName:member.subagentName}:{}),
        session:member.threadId?{host,id:member.threadId}:null,waitFor:member.waitFor,pendingWaitFor:pendingWaitFor(team,member),
        worktree:member.worktree,workspace:member.workspace,channels:member.channels,lastTurn:member.lastTurn,
        retireAfterTurn:member.retireAfterTurn,recoveryRequired:member.recoveryRequired===true,
        ...(member.fallbackModel?{fallbackModel:member.fallbackModel,...(member.fallbackEffort!==undefined?{fallbackEffort:member.fallbackEffort}:{})}:{}),
        model:member.model??member.activeModel??team.model,effort:member.effort??member.activeEffort??configuredEffort(team,member)};
    })};
}

/** Host-owned application. Wire transports must supply trusted actor metadata separately from args. */
export function createSwarmApplication({dataDirectory,runner,host='codex',workspaceAllowed,shutdownTimeoutMs=5000}) {
  if(typeof dataDirectory!=='string'||!dataDirectory||typeof runner?.run!=='function'||typeof workspaceAllowed!=='function') {
    throw Error('A data directory, runner and workspace scope are required.');
  }
  mkdirSync(dataDirectory,{recursive:true});
  const inflight=new Map();let closing;let closed=false;
  const board=new TeamBoard(join(dataDirectory,'teams.sqlite'),async request=>{
    if(request.member.worktree) {
      const workspace=await openWorktree(dataDirectory,request.team.worktreeSource,request.team.id,request.member.name,{mustExist:Boolean(request.member.workspace)});
      request.remember({workspace});request.member.workspace=workspace;
    }
    return runner.run(request);
  },{host});
  board.db.exec('CREATE TABLE IF NOT EXISTS application_commands (id TEXT PRIMARY KEY, action TEXT NOT NULL, signature TEXT NOT NULL, state TEXT NOT NULL, value TEXT)');
  const find=board.db.prepare('SELECT * FROM application_commands WHERE id=?');
  const reserve=board.db.prepare("INSERT INTO application_commands VALUES (?, ?, ?, 'pending', NULL)");
  const finish=board.db.prepare('UPDATE application_commands SET state=?,value=? WHERE id=?');
  const epoch=randomUUID();const revisions=new Map();let revision=0;
  board.subscribe('update',id=>revisions.set(id,++revision));
  const view=(team,actor)=>({...presentTeam(team,{activity:board.activityFor(team.id),actor,host}),revision:epoch+':'+(revisions.get(team.id)??0)});
  const ensureOpen=()=>{if(closed||closing)throw Error('Swarm application is closing.');};
  async function allowed(cwd,context={}) {
    let canonical;try{canonical=realpathSync(cwd);}catch{throw Error('Workspace is unavailable.');}
    if(!await workspaceAllowed(canonical,context))throw Error('Workspace is outside the permitted scope.');
    return canonical;
  }
  function actorOf(actor,args={}) {
    if(!actor)return undefined;
    if(args.teamId!=null&&args.teamId!==actor.teamId)throw Error('A worker cannot access another team.');
    const team=board.get(actor.teamId);const member=board.peerMember(team,actor.member);
    if(member.lastTurn!==actor.turn)throw Error('This worker turn is no longer active.');
    return {...actor,role:member.role};
  }
  async function ownTeam(id,context={}) {
    const team=board.get(id);if(team.host!==host)throw Error('Team belongs to another host.');
    await allowed(team.cwd,context);return team;
  }
  async function models() {return normalizeModels(await runner.listModels());}
  async function selections(values) {
    const chosen=values.filter(value=>value?.model);if(!chosen.length)return [];
    const catalog=await models();return chosen.map(value=>{
      const model=catalog.find(m=>m.id===value.model);if(!model)throw Error('Requested host model is unavailable.');
      if(value.effort!=null&&!model.efforts.includes(value.effort))throw Error('Requested reasoning effort is unavailable for this model.');
      return model;
    });
  }
  async function snapshot({teamId}={},context={}) {
    ensureOpen();const actor=actorOf(context.actor,{teamId});const teams=[];
    for(const item of board.list()) {
      if(actor&&item.id!==actor.teamId)continue;
      try{await allowed(item.cwd,context);teams.push({...item,host});}catch{/* Out-of-scope teams are not catalog entries. */}
    }
    const id=teamId??actor?.teamId;
    return {teams,team:id?view(await ownTeam(id,context),actor?.member):null};
  }
  async function perform(action,args,context) {
    const actor=actorOf(context.actor,args);
    if(actor&&!workerActions.has(action)&&!(actor.role==='coordinator'&&coordinatorActions.has(action)))throw Error('This action is not available to this worker.');
    const id=actor?.teamId??args.teamId;
    if(action==='list_teams')return {teams:(await snapshot({},context)).teams};
    if(action==='list_models')return {models:await models()};
    if(action==='start_team') {
      if(Object.hasOwn(args,'parentSessionId'))throw Error('Host identity cannot be supplied in command arguments.');
      const cwd=await allowed(args.cwd,context);
      const memberChecks=(args.members??[]).flatMap(m=>[
        (m?.model||(args.model&&m?.effort))?{model:m.model??args.model,effort:m.effort===null?undefined:m.effort??args.effort}:null,
        m?.fallbackModel?{model:m.fallbackModel,effort:m.fallbackEffort}:null,
      ]);
      await selections([args,args.fallbackModel?{model:args.fallbackModel,effort:args.fallbackEffort}:null,...memberChecks]);
      const source=args.members?.some(m=>m.worktree)?await worktreeSource(cwd):undefined;
      const parentSessionId=context.parentSessionId==null||context.parentSessionId===''?undefined:context.parentSessionId;
      return view(board.create({...args,cwd,host},source,{parentSessionId}));
    }
    const team=await ownTeam(id,context);
    switch(action) {
      case 'board_status':return view(team,actor?.member);
      case 'open_swarm_panel':return {teamId:team.id,title:team.title,host,navigation:{kind:'hive-swarm',teamId:team.id}};
      case 'board_history':return board.readHistory(id,{...args,actor:actor?.member});
      case 'read_board':return board.readPosts(id,{...args,actor:actor?.member});
      case 'wait_for_board':return board.waitForBoard(id,args,context.signal);
      case 'post_message':return view(board.post(id,args.text,args.channel));
      case 'post_to_board':if(!actor)throw Error('An active worker identity is required.');return board.postFrom(id,actor.member,args.text,args.channel);
      case 'set_turn_outcome':
        if(!actor||args.turn!==actor.turn)throw Error('The outcome must match the active worker turn.');
        return board.declareOutcome(id,actor.member,args);
      case 'pause_team':return view(board.pause(id));
      case 'resume_team':return view(board.resume(id,args.extraTurns));
      case 'resolve_recovery':return view(board.resolveRecovery(id,args.member,{action:args.action}));
      case 'retire_member':return view(board.retireMember(id,args.member,{actor:actor?.member}));
      case 'set_team_title':return view(board.setTeamTitle(id,args.title,actor?.member));
      case 'set_team_plan':return view(board.setTeamPlan(id,args.threads,actor?.member));
      case 'manage_channel':return board.manageChannel(id,args,actor?.member);
      case 'add_member': {
        const m=args.member;
        const model=m?.model??team.model;
        const effort=m?.effort===null?undefined:m?.effort??team.effort;
        await selections([model&&(m?.model||m?.effort)?{model,effort}:null,
          m?.fallbackModel?{model:m.fallbackModel,effort:m.fallbackEffort}:null]);
        const source=m?.worktree?team.worktreeSource??await worktreeSource(team.cwd):undefined;
        return view(board.addMember(id,m,{replaces:args.replaces,fork:args.fork,actor:actor?.member,worktreeSource:source}));
      }
      case 'set_member_model': {
        const member=board.liveMember(team,args.member);
        if(member.status==='working'&&!actor)throw Error('Wait for this member to finish before changing model.');
        let effort=args.effort===null?null:args.effort??configuredEffort(team,member)??null;
        const [model]=await selections([{model:args.model,effort:args.effort}]);
        if(effort&&!model.efforts.includes(effort))effort=null;
        return view(board.switchModel(id,args.member,args.model,{resume:args.resume,effort,actor:actor?.member}));
      }
      case 'remove_worktree':return view(await board.removeWorktree(id,args.member,({team,member})=>removeWorktree(dataDirectory,team.worktreeSource,team.id,member.name,member.workspace,{force:args.force===true})));
      case 'read_journal': {
        const member=team.members.find(m=>m.name===args.member);if(!member?.threadId)throw Error('This member has no owned session yet.');
        return {member:member.name,status:member.status,threadId:member.threadId,
          turns:(await runner.readTranscript(member.threadId)).slice(-30),live:board.activityFor(id)[member.name]??null};
      }
      default:throw Error('Unknown Swarm action.');
    }
  }
  async function command(action,args={},context={}) {
    ensureOpen();if(typeof action!=='string'||!args||Array.isArray(args)||typeof args!=='object')throw Error('Invalid command.');
    actorOf(context.actor,args);const input=signature(args);
    if(reads.has(action)||context.requestId==null)return perform(action,args,context);
    if(typeof context.requestId!=='string'||!context.requestId||context.requestId.length>160)throw Error('Invalid command request identity.');
    const actor=context.actor;
    const key=(actor?actor.teamId+':'+actor.member+':'+actor.turn:'owner')+':'+context.requestId;
    const prior=find.get(key);
    if(prior) {
      if(prior.action!==action||prior.signature!==input)throw Error('Request identity cannot be reused for different arguments.');
      if(inflight.has(key))return inflight.get(key);
      if(prior.state==='pending')throw Error('Command outcome unconfirmed; inspect state before a new request.');
      const value=JSON.parse(prior.value);
      if(prior.state==='failed')throw Error(value.error);
      if(value.teamId)return view(await ownTeam(value.teamId,context),actor?.member);
      return value.result;
    }
    reserve.run(key,action,input);
    const promise=perform(action,args,context).then(result=>{
      finish.run('settled',JSON.stringify(result?.id?{teamId:result.id}:{result}),key);return result;
    },error=>{finish.run('failed',JSON.stringify({error:String(error.message??error)}),key);throw error;})
      .finally(()=>inflight.delete(key));
    inflight.set(key,promise);return promise;
  }
  async function subscribe(teamId,listener,context={}) {
    ensureOpen();await ownTeam(teamId,context);const actor=actorOf(context.actor,{teamId});let active=true;
    const release=board.subscribe('update',id=>{if(id===teamId&&active&&!context.signal?.aborted)listener(view(board.get(id),actor?.member));});
    const unsubscribe=()=>{active=false;release();context.signal?.removeEventListener('abort',unsubscribe);};
    context.signal?.addEventListener('abort',unsubscribe,{once:true});if(context.signal?.aborted)unsubscribe();return unsubscribe;
  }
  async function waitForUpdate({teamId,since=0,revision:previous,timeoutSec=45},context={}) {
    ensureOpen();await ownTeam(teamId,context);const actor=actorOf(context.actor,{teamId});
    if(!Number.isSafeInteger(since)||since<0)throw Error('Invalid update cursor.');
    const duration=boardWaitTimeout(timeoutSec)*1000;
    return new Promise((resolve,reject)=>{
      let done=false,timer;
      const current=reason=>{const page=board.readHistory(teamId,{after:since,limit:100,actor:actor?.member});
        const status=view(board.get(teamId),actor?.member);return {...page,status,revision:status.revision,wokeBy:reason};};
      const finish=(value,error)=>{if(done)return;done=true;clearTimeout(timer);release();releaseClose();
        context.signal?.removeEventListener('abort',abort);if(error)reject(error);else resolve(value);};
      const release=board.subscribe('update',id=>{if(id===teamId)finish(current('update'));});
      const releaseClose=board.subscribe('close',()=>finish(null,Error('Swarm application closed.')));
      const abort=()=>finish(null,context.signal.reason??Error('Update wait cancelled.'));
      context.signal?.addEventListener('abort',abort,{once:true});
      if(context.signal?.aborted)return abort();
      const first=current('post');
      if(first.posts.length||(previous!=null&&previous!==first.revision))return finish(first);
      timer=setTimeout(()=>finish(current('timeout')),duration);
    });
  }
  function close() {
    if(closing)return closing;if(closed)return Promise.resolve({quiescent:true});
    closing=(async()=>{
      board.pauseAll();
      let timer;let quiescent=false;
      try{await Promise.race([(async()=>{await board.cancelRunning();await runner.close?.();quiescent=true;})(),
        new Promise(resolve=>{timer=setTimeout(resolve,shutdownTimeoutMs);})]);}
      finally{clearTimeout(timer);closed=true;board.close();}
      return {quiescent};
    })();return closing;
  }
  return {board,host,snapshot,command,subscribe,waitForUpdate,close};
}
