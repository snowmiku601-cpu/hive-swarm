import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

function isOwnedUserMessage(run,item) {
  const source=item?.source;
  if(source?.kind!=='user')return false;
  if(run.requestId&&source.rpcId===run.requestId)return true;
  if(run.messageId&&item?.id===run.messageId)return true;
  return false;
}

export function formatInbox(inbox) {
  if(!Array.isArray(inbox)||!inbox.length)return 'No new board messages.';
  return inbox.map(entry=>{
    const who=entry?.author==='system'?'System':'@'+(entry?.author??'member');
    const channel=entry?.channel&&entry.channel!=='main'?' #'+entry.channel:'';
    const addressed=entry?.addressed?' (addressed to you)':'';
    const header=(entry?.seq!=null?'#'+entry.seq+' ':'')+who+channel+addressed+':';
    return header+'\n'+String(entry?.text??'').trim();
  }).join('\n\n');
}

/** Correlate only durable events belonging to one admitted prompt. Never infer completion from a receipt. */
export function correlateRun(run,records) {
  const unique=new Map();
  for(const record of records){const event=record.event??record;if(!Number.isSafeInteger(event.seq)||event.seq<0)throw Error('Invalid native event sequence.');
    if(unique.has(event.seq)&&JSON.stringify(unique.get(event.seq))!==JSON.stringify(event))throw Error('Conflicting native event sequence.');unique.set(event.seq,event);}
  const events=[...unique.values()].sort((a,b)=>a.seq-b.seq);let acceptedSeq=0,claimSeq=0,turnEndSeq=0,turn,claimedTurn,lastRoute=null;
  const routes=[];
  const inbox={'next-turn':[],'next-step':[]};
  for(const event of events) {
    const {type,data={}}=event;
    if(type==='agent/inbox/spliced') {
      const queue=inbox[data.target];if(!queue||!Number.isSafeInteger(data.start)||data.start<0||data.start>queue.length)throw Error('Native inbox evidence is incomplete.');
      const removed=queue.splice(data.start,data.removedCount??0,...(data.inserted??[]));
      for(const message of data.inserted??[]) {
        const source=message.source;
        if(isOwnedUserMessage(run,message))acceptedSeq=acceptedSeq||event.seq;
        else if((acceptedSeq||claimSeq)&&source?.kind==='user')throw Error('Foreign user admission; outcome unconfirmed.');
      }
      for(const message of removed)if(isOwnedUserMessage(run,message)) {
        if(data.outcome==='canceled')throw Error('Owned prompt was canceled before claim; outcome unconfirmed.');
        if(claimSeq||!Number.isSafeInteger(turn))throw Error('Owned prompt claim is ambiguous.');
        claimSeq=event.seq;claimedTurn=turn;
      }
    }
    if(type==='turn/start')turn=data.turn;
    if(type==='user/message'&&data.source?.kind==='user') {
      if(!isOwnedUserMessage(run,data)&&(acceptedSeq||claimSeq))throw Error('Foreign user admission; outcome unconfirmed.');
      if(isOwnedUserMessage(run,data)&&claimedTurn!==turn)throw Error('User message belongs to another native turn.');
    }
    if(type==='request/header'||type==='model/selection'||type==='model/selected') {
      const cfg=type==='request/header'?data.header?.config:data;
      if(cfg?.provider&&cfg?.model) {
        const route=cfg.provider+'/'+cfg.model+(cfg.reasoningEffort?' · '+cfg.reasoningEffort:'');
        lastRoute=route;
        if(type==='request/header'&&claimSeq&&!turnEndSeq&&!routes.includes(route))routes.push(route);
      }
    }
    if(type==='turn/end'&&claimSeq&&data.turn===claimedTurn) {
      if(data.reason?.kind!=='completed') {
        const detail=data.reason?.message||data.reason?.error||data.reason?.kind||'incomplete';
        throw Error('Native turn did not complete ('+detail+'); outcome unconfirmed.');
      }
      turnEndSeq=event.seq;
    }
  }
  if(claimSeq&&!routes.length&&lastRoute)routes.push(lastRoute);
  return {acceptedSeq,claimSeq,turnEndSeq,claimedTurn,routes};
}

export class NativeRunner {
  constructor({native,store}) {if(!native||!store)throw Error('Native services and durable RunStore are required.');this.native=native;this.store=store;this.active=new Map();this.recoveries=new Map();this.cancellations=new Set();this.closed=false;this.closing=null;}
  listModels(){return this.native.listModels();}
  readTranscript(sessionId){if(!this.store.findSession(sessionId))throw Error('This session is not owned by Hive.');
    return this.store.readJournal(sessionId).map(run=>({id:String(run.turn),status:run.status,items:[...run.steps.map(step=>({type:'activity',...step})),
      ...run.report?[{type:'agentMessage',phase:'final',text:run.report}]:[]]}));}
  actorForSession(sessionId){const value=this.active.get(sessionId)??this.recoveries.get(sessionId);
    return value?{teamId:value.run.teamId,member:value.run.member,turn:value.run.turn,...this.recoveries.get(sessionId)===value?{recovering:true}:{}}:null;}
  async setOutcome(sessionId,turn,result) {
    if(this.closed)throw Error('Native runner is closing.');
    if(!result||!['done','waiting'].includes(result.state))throw Error('Worker outcome state must be done or waiting.');
    const active=this.active.get(sessionId)??this.recoveries.get(sessionId);if(!active||active.run.turn!==turn)throw Error('No matching owned active worker turn.');
    const records=await this.native.events(sessionId,undefined,{parentSessionId:active.run.parentSessionId,executionMode:active.run.executionMode});
    const proof=correlateRun(active.run,records);
    const boundary=this.native.currentTurn(sessionId);
    if(!proof.claimSeq||proof.turnEndSeq||!boundary||boundary.openTurnStartSeq==null||boundary.lastTurn!==proof.claimedTurn)throw Error('The scoped report does not match the active claimed native turn.');
    return this.store.setOutcome(active.run,result).outcome;
  }
  async evidence(run,signal) {
    const events=await this.native.events(run.sessionId,signal,{parentSessionId:run.parentSessionId,executionMode:run.executionMode});
    const proof=correlateRun(run,events);
    const patch=Object.fromEntries(['acceptedSeq','claimSeq','turnEndSeq'].filter(key=>proof[key]>0).map(key=>[key,proof[key]]));
    if(Object.keys(patch).length)this.store.patch(run,patch);
    let current=this.store.read(run);
    for(const route of proof.routes??[]) {
      const label='Verified route: '+route;
      if(!current.steps.some(step=>step.kind==='route'&&step.label===label)) {
        this.store.appendStep(run,{kind:'route',label,time:new Date().toISOString()});
        current=this.store.read(run);
      }
    }
    return current;
  }
  async run({team,member,remember,signal,onActivity=()=>{}}) {
    if(this.closed)throw Error('Native runner is closed.');signal?.throwIfAborted();
    const controller=new AbortController();signal=AbortSignal.any([controller.signal,...signal?[signal]:[]]);
    if(member.pendingRun)throw Error('Pending native outcome unconfirmed; inspect before continuing.');
    const catalog=await this.listModels();const id=member.model??team.model??catalog.find(model=>model.default)?.id;
    const selected=catalog.find(model=>model.id===id);if(!selected)throw Error('Requested native model is unavailable.');
    const effort=(member.effort===null?undefined:member.effort??team.effort)??selected.defaultEffort;
    if(effort&&!selected.efforts?.includes(effort))throw Error('Requested native model effort is unavailable.');
    const workspace=member.workspace?.cwd??team.cwd;
    const workerLabel='🐝 @'+member.name+(team.title?' · '+team.title:'');
    const activeRoster=(team.members??[]).filter(m=>m.name!==member.name&&m.status!=='retired');
    const peers=activeRoster
      .map(m=>'@'+m.name+(m.group?' in @'+m.group:'')+(m.channels?.length?' ['+m.channels.map(c=>'#'+c).join(', ')+']':'')+(m.workspace?.cwd?' at '+m.workspace.cwd:'')).join(', ');
    const compactPeers=activeRoster.map(m=>'@'+m.name).join(', ');
    const resuming=Boolean(member.threadId);
    const promptLines=(resuming?[
      'Resume Hive Swarm turn '+member.lastTurn+' as @'+member.name+' (teamId: '+team.id+').'+(compactPeers?' Active teammates: '+compactPeers+'.':''),
      'All new board messages since your last turn are delivered directly below; do not call hive_swarm_read_board or hive_swarm_list_models unless you need older history or a model switch.',
      'Finish by calling hive_swarm_set_turn_outcome for turn '+member.lastTurn+' with state ("done" or "waiting"), a concise message (start finished reports with [done] and cite prior posts with #seq), notify, and waitFor.',
      'New board messages:\n'+formatInbox(member.inbox),
    ]:[
      'You are Hive Swarm member @'+member.name+' in team '+team.id+'.'+(peers?' Active teammates: '+peers+'.':''),
      'Goal: '+team.task,
      'Your assignment: '+member.brief,
      member.workspace?.cwd?'Your Git worktree is '+workspace+(member.workspace.base?' at base '+member.workspace.base:'')+'. Work in this checkout and report changed files and verification.':'',
      'Work only in the assigned workspace and permissions. Do not create another scheduler or launch subagents.',
      'Coordinate directly with teammates using scoped hive_swarm tools (teamId: '+team.id+'). Tag @name directly for peer-to-peer handoffs instead of routing through @coordinator. Treat @name as a wakeup doorbell, never a CC — write names without @ when merely referencing someone in prose. Use @#channel for channel subscribers and @all only for team-wide rules.',
      'Reserve hive_swarm_post_message for mid-turn peer questions or handoffs; do not double-post your final report via hive_swarm_post_message right before calling hive_swarm_set_turn_outcome.',
      'All new board messages for each turn are delivered directly below; do not call hive_swarm_read_board or hive_swarm_list_models unless you need older history or a model switch.',
      'Finish by calling hive_swarm_set_turn_outcome for turn '+member.lastTurn+' with state ("done" or "waiting"), a concise message (start finished reports with [done] and cite prior posts with #seq), notify (peer names who must act next), and waitFor (peer names you need a new report from). The outcome tool concludes this turn.',
      'New board messages:\n'+formatInbox(member.inbox),
    ]).filter(Boolean).join('\n\n');

    let sessionId=member.threadId,executionMode=member.executionMode??'session',initialMessageId,startedSubagent=false;
    if(sessionId) {
      const owner=this.store.findSession(sessionId);
      if(!owner||owner.teamId!==team.id||owner.member!==member.name||owner.workspace!==workspace)throw Error('Session ownership or workspace does not match.');
      if(executionMode==='subagent')this.native.registerSubagent?.(sessionId,team.parentSessionId);
    } else if(member.forkFrom) {
      const source=this.store.findSession(member.forkFrom);
      if(!source||source.teamId!==team.id)throw Error('A native fork must use a session owned by this team.');
      if(source.workspace!==workspace)throw Error('A native history fork cannot change its immutable workspace.');
      sessionId=await this.native.fork(member.forkFrom,signal);executionMode='session';
      await this.native.rename?.(sessionId,workerLabel,signal);
      remember({threadId:sessionId,executionMode,forkFrom:null,...(member.forkSource?{forkSource:null}:{})});
    } else {
      const forkCoordinator=member.forkSource==='coordinator';
      if(forkCoordinator&&member.worktree)throw Error('A native history fork cannot change its immutable workspace.');
      if(!member.worktree&&team.parentSessionId&&typeof this.native.startSubagent==='function') {
        const started=await this.native.startSubagent({
          teamId:team.id,parentSessionId:team.parentSessionId,memberName:member.name,label:workerLabel,
          cwd:workspace,writable:member.writable===true,model:selected,effort,forkCoordinator,prompt:promptLines,
        },signal);
        if(started) {
          startedSubagent=true;sessionId=started.sessionId;initialMessageId=started.messageId;
          executionMode=started.executionMode??'subagent';
          remember({threadId:sessionId,executionMode,...(started.subagentName?{subagentName:started.subagentName}:{}),...(member.forkSource?{forkSource:null}:{})});
        }
      }
      if(!sessionId) {
        if(forkCoordinator) {
          if(!team.parentSessionId||typeof this.native.forkParent!=='function')throw Error('Coordinator history is unavailable to fork.');
          sessionId=await this.native.forkParent(team.parentSessionId,{cwd:workspace},signal);
        } else {
          sessionId=await this.native.create({cwd:workspace},signal);
        }
        executionMode='session';
        await this.native.rename?.(sessionId,workerLabel,signal);
        remember({threadId:sessionId,executionMode,...(member.forkSource?{forkSource:null}:{})});
      }
    }

    const identity={teamId:team.id,member:member.name,turn:member.lastTurn,requestId:randomUUID(),sessionId,workspace};
    const baseRun=this.store.begin(identity);
    const run={...baseRun,...(initialMessageId?{messageId:initialMessageId}:{}),...(team.parentSessionId?{parentSessionId:team.parentSessionId}:{}),executionMode};
    let admitted=false,inputRequired=false,finish;const entry={run,controller,done:new Promise(resolve=>{finish=resolve})};
    const cancellation=()=>{void this.cancelEntry(entry).catch(()=>{});};
    try {
      if(startedSubagent) {
        signal?.throwIfAborted();
        remember({pendingRun:{requestId:run.requestId,turn:run.turn,...(initialMessageId?{messageId:initialMessageId}:{})}});
        this.active.set(sessionId,entry);signal?.addEventListener('abort',cancellation,{once:true});
        admitted=true;
      } else if(executionMode==='subagent'&&typeof this.native.prepareSubagentTurn==='function') {
        await this.native.prepareSubagentTurn(sessionId,{parentSessionId:team.parentSessionId,cwd:workspace,writable:member.writable===true,model:selected,effort},signal);
        signal?.throwIfAborted();
        remember({pendingRun:{requestId:run.requestId,turn:run.turn}});
        this.active.set(sessionId,entry);signal?.addEventListener('abort',cancellation,{once:true});
        admitted=true;
        await this.native.promptSubagentTurn({sessionId,requestId:run.requestId,parentSessionId:team.parentSessionId,cwd:workspace,writable:member.writable===true,model:selected,effort,prompt:promptLines},signal);
      } else {
        await this.native.prepare(sessionId,{cwd:workspace,writable:member.writable===true,model:selected,effort},signal);
        signal?.throwIfAborted();
        remember({pendingRun:{requestId:run.requestId,turn:run.turn}});
        this.active.set(sessionId,entry);signal?.addEventListener('abort',cancellation,{once:true});
        admitted=true;
        await this.native.prompt({sessionId,requestId:run.requestId,mode:'queue',content:[{type:'text',text:promptLines}]},signal);
      }
      for(;;) {
        signal?.throwIfAborted();const value=await this.native.wait(sessionId,signal);signal?.throwIfAborted();
        let current=await this.evidence(run,signal);
        const step={kind:'turn',label:value.reason==='timeout'?'Native worker remains active':'Native worker state observed',time:new Date().toISOString()};
        if(current.steps.at(-1)?.kind!==step.kind||current.steps.at(-1)?.label!==step.label)this.store.appendStep(run,step);
        onActivity(step);
        if(value.reason==='input-required'){
          if(!inputRequired){inputRequired=true;remember({inputRequired:true});}
          onActivity({kind:'permission',label:'Native worker needs your permission or input',time:new Date().toISOString()});
          await delay(1000,undefined,{signal});continue;
        }
        if(inputRequired){inputRequired=false;remember({inputRequired:false});}
        if(value.reason==='timeout')continue;
        if(value.reason!=='idle'||value.state?.running||value.state?.queue?.length)continue;
        await this.native.flush(sessionId,signal);signal?.throwIfAborted();current=await this.evidence(run,signal);
        const stopped=await this.native.state(sessionId,signal);signal?.throwIfAborted();
        if(stopped.running||stopped.queue?.length||stopped.pendingInput?.length)continue;
        if(!current.claimSeq||!current.turnEndSeq||!current.outcome)throw Error('Native outcome unconfirmed: missing matching durable claim, turn end or scoped report.');
        await this.native.settleTurn?.(sessionId);
        this.store.patch(run,{hostIdle:true});const result=this.store.finish(run).run.outcome;
        return result;
      }
    } catch(error) {
      if(admitted) {
        remember({status:'failed',recoveryRequired:true});
        const wrapped=Error('Native outcome unconfirmed: '+String(error.message??error),{cause:error});
        wrapped.recoveryRequired=true;
        throw wrapped;
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort',cancellation);await entry.cancellation?.catch(()=>{});
      await this.native.releaseTurn?.(sessionId);
      if(this.active.get(sessionId)===entry)this.active.delete(sessionId);finish();
    }
  }
  cancelEntry(entry){
    if(!entry.cancellation){
      const promise=Promise.resolve().then(()=>this.native.cancel(entry.run.sessionId,{executionMode:entry.run.executionMode,parentSessionId:entry.run.parentSessionId}));
      entry.cancellation=promise;
      this.cancellations.add(promise);promise.then(()=>this.cancellations.delete(promise),()=>{});
    }
    return entry.cancellation;
  }
  async reconcile(board) {
    // Include already-finished store rows: a crash can occur between store commit and scheduler commit.
    const saved=board.db.prepare('SELECT value FROM teams').all();let settled=0;
    for(const row of saved){const team=JSON.parse(row.value);for(const member of team.members){
      if(member.status==='retired'||!member.recoveryRequired||!member.pendingRun||!member.threadId)continue;
      const stored=this.store.findSession(member.threadId);
      if(!stored||stored.teamId!==team.id||stored.member!==member.name||stored.turn!==member.lastTurn||stored.turn!==member.pendingRun.turn||stored.requestId!==member.pendingRun.requestId)continue;
      const run={...stored,...(member.pendingRun.messageId?{messageId:member.pendingRun.messageId}:{}),...(team.parentSessionId?{parentSessionId:team.parentSessionId}:{}),...(member.executionMode?{executionMode:member.executionMode}:{})};
      if(member.executionMode==='subagent')this.native.registerSubagent?.(run.sessionId,team.parentSessionId);
      try{const state=await this.native.state(run.sessionId);if(state.running||state.queue?.length||state.pendingInput?.length){
          if(!this.recoveries.has(run.sessionId)) {
            this.recoveryStatus(board,run,'working');
            const controller=new AbortController();const entry={controller,run};this.recoveries.set(run.sessionId,entry);
            entry.done=(async()=>{for(;;){controller.signal.throwIfAborted();const value=await this.native.wait(run.sessionId,controller.signal);
              if(value.reason==='input-required'){this.recoveryInput(board,run,true);await delay(1000,undefined,{signal:controller.signal});continue;}
              this.recoveryInput(board,run,false);
              if(value.reason!=='idle'||value.state?.running||value.state?.queue?.length)continue;
              controller.signal.throwIfAborted();
              if(await this.settleRecovery(board,run,controller.signal))return;
              const current=await this.native.state(run.sessionId,controller.signal);
              if(!current.running&&!current.queue?.length&&!current.pendingInput?.length)return;
            }})().catch(()=>{}).finally(()=>{this.recoveries.delete(run.sessionId);this.recoveryStatus(board,run,'failed');});
          }
          continue;
        }
        if(await this.settleRecovery(board,run))settled++;
      }catch{/* Missing or conflicting evidence remains Needs you; never re-prompt. */}
    }}return {settled,observing:this.recoveries.size};
  }
  recoveryInput(board,run,inputRequired){
    const team=board.get(run.teamId),member=team.members.find(value=>value.name===run.member);
    if(member?.pendingRun?.requestId===run.requestId&&member.pendingRun.turn===run.turn&&member.lastTurn===run.turn&&member.inputRequired!==inputRequired){member.inputRequired=inputRequired;board.save(team);}
  }
  recoveryStatus(board,run,status){
    if(board.closed)return;
    const team=board.get(run.teamId),member=team.members.find(value=>value.name===run.member);
    if(member?.recoveryRequired&&member.status!=='retired'&&member.pendingRun?.requestId===run.requestId&&member.pendingRun.turn===run.turn&&member.lastTurn===run.turn&&member.status!==status){
      member.status=status;board.save(team);
    }
  }
  async settleRecovery(board,run,signal) {
    if(this.closed)return false;signal?.throwIfAborted();let current=this.store.read(run);
    if(!current.settled){await this.native.flush(run.sessionId,signal);current=await this.evidence(run,signal);}
    const state=await this.native.state(run.sessionId,signal);signal?.throwIfAborted();
    if(this.closed||state.running||state.queue?.length||state.pendingInput?.length||!current.outcome||!current.claimSeq||!current.turnEndSeq)return false;
    if(!current.settled){this.store.patch(run,{hostIdle:true});current=this.store.finish(run).run;}
    return board.settleRecovered(run.teamId,run.member,{turn:run.turn,requestId:run.requestId,result:current.outcome}).settled;
  }
  close(){if(this.closing)return this.closing;this.closed=true;
    return this.closing=(async()=>{const entries=[...this.active.values(),...this.recoveries.values()];
      for(const entry of entries){entry.controller.abort(Error('Native host is closing.'));void this.cancelEntry(entry).catch(()=>{});}
      const cancelled=await Promise.allSettled([...this.cancellations]);await Promise.allSettled(entries.map(entry=>entry.done));
      if(cancelled.some(result=>result.status==='rejected'))throw Error('Native cancellation is unconfirmed; worker guards remain active.');
      await this.native.dispose?.();})();}
}
