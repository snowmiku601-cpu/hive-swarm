import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

/** Correlate only durable events belonging to one admitted prompt. Never infer completion from a receipt. */
export function correlateRun(run,records) {
  const unique=new Map();
  for(const record of records){const event=record.event??record;if(!Number.isSafeInteger(event.seq)||event.seq<0)throw Error('Invalid native event sequence.');
    if(unique.has(event.seq)&&JSON.stringify(unique.get(event.seq))!==JSON.stringify(event))throw Error('Conflicting native event sequence.');unique.set(event.seq,event);}
  const events=[...unique.values()].sort((a,b)=>a.seq-b.seq);let acceptedSeq=0,claimSeq=0,turnEndSeq=0,turn,claimedTurn;
  const inbox={'next-turn':[],'next-step':[]};
  for(const event of events) {
    const {type,data={}}=event;
    if(type==='agent/inbox/spliced') {
      const queue=inbox[data.target];if(!queue||!Number.isSafeInteger(data.start)||data.start<0||data.start>queue.length)throw Error('Native inbox evidence is incomplete.');
      const removed=queue.splice(data.start,data.removedCount??0,...(data.inserted??[]));
      for(const message of data.inserted??[]) {
        const source=message.source;
        if(source?.kind==='user'&&source.rpcId===run.requestId)acceptedSeq=acceptedSeq||event.seq;
        else if((acceptedSeq||claimSeq)&&source?.kind==='user')throw Error('Foreign user admission; outcome unconfirmed.');
      }
      for(const message of removed)if(message.source?.kind==='user'&&message.source.rpcId===run.requestId) {
        if(data.outcome==='canceled')throw Error('Owned prompt was canceled before claim; outcome unconfirmed.');
        if(claimSeq||!Number.isSafeInteger(turn))throw Error('Owned prompt claim is ambiguous.');
        claimSeq=event.seq;claimedTurn=turn;
      }
    }
    if(type==='turn/start')turn=data.turn;
    if(type==='user/message'&&data.source?.kind==='user') {
      if(data.source.rpcId!==run.requestId&&(acceptedSeq||claimSeq))throw Error('Foreign user admission; outcome unconfirmed.');
      if(data.source.rpcId===run.requestId&&claimedTurn!==turn)throw Error('User message belongs to another native turn.');
    }
    if(type==='turn/end'&&claimSeq&&data.turn===claimedTurn) {
      if(data.reason?.kind!=='completed')throw Error('Native turn did not complete; outcome unconfirmed.');
      turnEndSeq=event.seq;
    }
  }
  return {acceptedSeq,claimSeq,turnEndSeq,claimedTurn};
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
    const records=await this.native.events(sessionId);const proof=correlateRun(active.run,records);
    const boundary=this.native.currentTurn(sessionId);
    if(!proof.claimSeq||proof.turnEndSeq||!boundary||boundary.openTurnStartSeq==null||boundary.lastTurn!==proof.claimedTurn)throw Error('The scoped report does not match the active claimed native turn.');
    return this.store.setOutcome(active.run,result).outcome;
  }
  async evidence(run,signal) {
    const events=await this.native.events(run.sessionId,signal);const proof=correlateRun(run,events);
    const patch=Object.fromEntries(Object.entries(proof).filter(([key,value])=>key!=='claimedTurn'&&value>0));
    if(Object.keys(patch).length)this.store.patch(run,patch);
    return this.store.read(run);
  }
  async run({team,member,remember,signal,onActivity=()=>{}}) {
    if(this.closed)throw Error('Native runner is closed.');signal?.throwIfAborted();
    const controller=new AbortController();signal=AbortSignal.any([controller.signal,...signal?[signal]:[]]);
    if(member.pendingRun)throw Error('Pending native outcome unconfirmed; inspect before continuing.');
    const catalog=await this.listModels();const id=member.model??team.model??catalog.find(model=>model.default)?.id;
    const selected=catalog.find(model=>model.id===id);if(!selected)throw Error('Requested native model is unavailable.');
    const effort=member.effort??team.effort??selected.defaultEffort;
    if(effort&&!selected.efforts?.includes(effort))throw Error('Requested native model effort is unavailable.');
    const workspace=member.workspace?.cwd??team.cwd;let sessionId=member.threadId;
    if(sessionId){const owner=this.store.findSession(sessionId);if(!owner||owner.teamId!==team.id||owner.member!==member.name||owner.workspace!==workspace)throw Error('Session ownership or workspace does not match.');}
    else if(member.forkFrom){const source=this.store.findSession(member.forkFrom);
      if(!source||source.teamId!==team.id)throw Error('A native fork must use a session owned by this team.');
      if(source.workspace!==workspace)throw Error('A native history fork cannot change its immutable workspace.');
      sessionId=await this.native.fork(member.forkFrom,signal);remember({threadId:sessionId,forkFrom:null});
    }
    else {sessionId=await this.native.create({cwd:workspace},signal);remember({threadId:sessionId});}
    const identity={teamId:team.id,member:member.name,turn:member.lastTurn,requestId:randomUUID(),sessionId,workspace};
    const run=this.store.begin(identity);let admitted=false,inputRequired=false,finish;const entry={run,controller,done:new Promise(resolve=>{finish=resolve})};
    const cancellation=()=>{void this.cancelEntry(entry).catch(()=>{});};
    try {
      await this.native.prepare(sessionId,{cwd:workspace,writable:member.writable===true,model:selected,effort},signal);
      signal?.throwIfAborted();
      remember({pendingRun:{requestId:run.requestId,turn:run.turn}});
      this.active.set(sessionId,entry);signal?.addEventListener('abort',cancellation,{once:true});
      admitted=true;
      await this.native.prompt({sessionId,requestId:run.requestId,mode:'queue',content:[{type:'text',text:
        'You are Hive Swarm member @'+member.name+'.\nGoal: '+team.task+'\nAssignment: '+member.brief+'\n'+
        'Work only in the assigned workspace and permissions. Do not create another scheduler. Use the scoped hive_swarm tools. '+
        'Finish by calling hive_swarm_set_turn_outcome for turn '+run.turn+' with state, message, notify and waitFor. '+
        'The outcome tool concludes this turn. Incoming board messages: '+JSON.stringify(member.inbox??[])}]},signal);
      for(;;) {
        signal?.throwIfAborted();const value=await this.native.wait(sessionId,signal);signal?.throwIfAborted();
        let current=await this.evidence(run,signal);
        const step={kind:'turn',label:value.reason==='timeout'?'Native worker remains active':'Native worker state observed',time:new Date().toISOString()};
        this.store.appendStep(run,step);onActivity(step);
        if(value.reason==='timeout')continue;
        if(value.reason==='input-required'){
          if(!inputRequired){inputRequired=true;remember({inputRequired:true});}
          onActivity({kind:'permission',label:'Native worker needs your permission or input',time:new Date().toISOString()});
          await delay(1000,undefined,{signal});continue;
        }
        if(inputRequired){inputRequired=false;remember({inputRequired:false});}
        if(value.reason!=='idle'||value.state?.running||value.state?.queue?.length)continue;
        await this.native.flush(sessionId,signal);signal?.throwIfAborted();current=await this.evidence(run,signal);
        const stopped=await this.native.state(sessionId,signal);signal?.throwIfAborted();
        if(stopped.running||stopped.queue?.length||stopped.pendingInput?.length)continue;
        if(!current.claimSeq||!current.turnEndSeq||!current.outcome)throw Error('Native outcome unconfirmed: missing matching durable claim, turn end or scoped report.');
        this.store.patch(run,{hostIdle:true});const result=this.store.finish(run).run.outcome;
        return result;
      }
    } catch(error) {
      if(admitted) {remember({status:'failed',recoveryRequired:true});throw Error('Native outcome unconfirmed: '+String(error.message??error),{cause:error});}
      throw error;
    } finally {signal?.removeEventListener('abort',cancellation);await entry.cancellation?.catch(()=>{});
      if(this.active.get(sessionId)===entry)this.active.delete(sessionId);finish();}
  }
  cancelEntry(entry){
    if(!entry.cancellation){const promise=Promise.resolve().then(()=>this.native.cancel(entry.run.sessionId));entry.cancellation=promise;
      this.cancellations.add(promise);promise.then(()=>this.cancellations.delete(promise),()=>{});}
    return entry.cancellation;
  }
  async reconcile(board) {
    // Include already-finished store rows: a crash can occur between store commit and scheduler commit.
    const saved=board.db.prepare('SELECT value FROM teams').all();let settled=0;
    for(const row of saved){const team=JSON.parse(row.value);for(const member of team.members){
      if(member.status==='retired'||!member.recoveryRequired||!member.pendingRun||!member.threadId)continue;
      const run=this.store.findSession(member.threadId);
      if(!run||run.teamId!==team.id||run.member!==member.name||run.turn!==member.lastTurn||run.turn!==member.pendingRun.turn||run.requestId!==member.pendingRun.requestId)continue;
      try{const state=await this.native.state(run.sessionId);if(state.running||state.queue?.length||state.pendingInput?.length){
          if(!this.recoveries.has(run.sessionId)) {
            this.recoveryStatus(board,run,'working');
            const controller=new AbortController();const entry={controller,run};this.recoveries.set(run.sessionId,entry);
            entry.done=(async()=>{for(;;){controller.signal.throwIfAborted();const value=await this.native.wait(run.sessionId,controller.signal);
              if(value.reason==='input-required'){this.recoveryInput(board,run,true);await delay(1000,undefined,{signal:controller.signal});continue;}
              if(value.reason!=='idle')continue;this.recoveryInput(board,run,false);
              controller.signal.throwIfAborted();await this.settleRecovery(board,run,controller.signal);return;
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
