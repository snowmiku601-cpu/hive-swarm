import React, {useEffect,useLayoutEffect,useId,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import Graph from 'hive:graph';
import Bees from 'hive:bees';
import beeSvg from 'hive:icon';
import styles from './style.css';
import {ownedSession} from './controller.mjs';

export const BEE_URL='data:image/svg+xml,'+encodeURIComponent(beeSvg);
export function BeeIcon({size=22,className}) {
  return <img src={BEE_URL} width={size} height={size} className={className} alt="" aria-hidden="true" data-dsh-panel-entry="dsh-hive-swarm"/>;
}
function Bee({name,status,coordinator=false}) {
  const ref=useRef(null);
  useEffect(()=>{const canvas=ref.current;if(!canvas)return;
    const context=canvas.getContext('2d');if(context)context.drawImage(Bees.sprite(name,{status,coordinator}),0,0);
  },[name,status,coordinator]);
  return <canvas ref={ref} width="20" height="18" aria-hidden="true" className="dsh-hive-bee"/>;
}
const ignore=()=>{};
const act=(controller,action,args)=>{void controller.command(action,args).catch(ignore);};
const phaseLabels={working:'Working',waiting:'Waiting',done:'Done',paused:'Paused',budget:'Turn budget reached',
  stalled:'Needs you',quota:'Quota reached',retired:'Retired',failed:'Needs you'};
function Status({value}) {return <span className="dsh-hive-status" data-status={value}>{phaseLabels[value]??value??'Ready'}</span>;}
function Empty({title,children}) {return <section className="dsh-hive-empty"><h2>{title}</h2><p>{children}</p></section>;}
function ErrorNotice({error,controller}) {return <div role="alert" className="dsh-hive-error">
  <p>{error.message}</p><p className="dsh-hive-secondary">{error.action?'The action may have reached the Host. Refresh to inspect the result, or retry the same request.':'Check the Host connection and workspace permission, then refresh.'}</p>
  <div className="dsh-hive-actions"><button type="button" onClick={()=>controller.refresh()}>Refresh</button>
    {controller.getSnapshot().selectedId&&!controller.getSnapshot().team?<button type="button" onClick={controller.showTeams}>Show teams</button>:null}
    {error.action?<button type="button" disabled={controller.getSnapshot().pending} onClick={()=>{void controller.retryCommand().catch(ignore);}}>Retry action</button>:null}</div>
</div>;}

// Native dialog owns modal focus/trapping; its opener regains focus after dismissal.
function Dialog({title,onClose,opener,children}) {
  const ref=useRef(null),close=useRef(null),titleId=useId();
  useLayoutEffect(()=>{
    const dialog=ref.current;if(!dialog)return;
    if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
    close.current?.focus();
    return()=>{if(dialog.open&&typeof dialog.close==='function')dialog.close();if(opener?.isConnected)opener.focus();};
  },[opener]);
  return <dialog ref={ref} className="dsh-hive-dialog" aria-labelledby={titleId}
    onCancel={event=>{event.preventDefault();onClose();}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();onClose();}}}>
    <header className="dsh-hive-dialog-head"><h2 id={titleId}>{title}</h2><button type="button" ref={close} aria-label={'Close '+title} onClick={onClose}>Close</button></header>
    {children}
  </dialog>;
}
function Journal({controller,journal,opener,onClose}) {
  return <Dialog title="Journal" onClose={onClose} opener={opener}>
    <div className="dsh-hive-actions"><strong>@{journal.member}</strong><button type="button" disabled={journal.loading} onClick={()=>{void controller.openJournal(journal.member);}}>Refresh Journal</button></div>
    {journal.loading?<p role="status">Loading Journal…</p>:journal.error?<ErrorNotice error={journal.error} controller={{...controller,refresh:()=>controller.openJournal(journal.member)}}/>:
      journal.turns.length?<ol className="dsh-hive-journal">{journal.turns.map((turn,index)=><li key={turn.turn??index}>
        <div className="dsh-hive-line"><h3>Turn {turn.turn??index+1}</h3><Status value={turn.status}/></div>
        {turn.steps?.length?<ul>{turn.steps.map((step,i)=><li key={i}>{typeof step==='string'?step:step.label}{typeof step==='object'&&step.detail?' — '+step.detail:''}</li>)}</ul>:null}
        {turn.report?<p className="dsh-hive-prose">{turn.report}</p>:<p className="dsh-hive-secondary">No report saved for this turn.</p>}
      </li>)}</ol>:<p>No saved turns yet. Live work appears here after the Host records it.</p>}
    {journal.live?.steps?.length?<section><h3>Current activity</h3><ul>{journal.live.steps.map((step,index)=><li key={index}>{typeof step==='string'?step:step.label}</li>)}</ul></section>:null}
  </Dialog>;
}

function Overview({state,controller,onJournal}) {
  const team=state.team;
  const needs=team.members.filter(member=>member.recoveryRequired||['quota','failed'].includes(member.status));
  return <div className="dsh-hive-overview">
    <section><h2>Goal</h2><p className="dsh-hive-prose">{team.task}</p></section>
    {team.attention?.length||needs.length?<section><h2>Needs you</h2><ul className="dsh-hive-attention">
      {(team.attention??[]).map((item,index)=><li key={index}><p>{item.text??item.message??item.kind}</p>{ownedSession(team.members.find(member=>member.name===item.member))?<button type="button" onClick={event=>onJournal(item.member,event.currentTarget)}>Inspect @{item.member}</button>:null}</li>)}
      {needs.filter(member=>!team.attention?.some(item=>item.member===member.name)).map(member=><li key={member.name}>
        <p>@{member.name}: {member.recoveryRequired?'Outcome unconfirmed. Inspect the owned session before continuing.':member.status==='quota'?'Model quota reached. Choose an available model before resuming.':'The last turn failed. Inspect the Journal for recovery details.'}</p>
        {ownedSession(member)?<button type="button" onClick={event=>onJournal(member.name,event.currentTarget)}>Inspect Journal</button>:null}</li>)}
    </ul></section>:<section><h2>Progress</h2><p>No blockers reported.</p></section>}
    <section><h2>Execution</h2><dl className="dsh-hive-facts">
      <div><dt>Turns</dt><dd>{team.turns} of {team.turnLimit} used</dd></div>
      <div><dt>Members</dt><dd>{team.members.filter(member=>member.status!=='retired').length} active · {team.members.filter(member=>member.status==='working').length} working</dd></div>
      <div><dt>Model</dt><dd>{team.model??'Host default'}{team.effort?' · '+team.effort:''}</dd></div>
      <div><dt>Workspace</dt><dd>{team.cwd}</dd></div>
    </dl>{team.phase==='budget'?<div className="dsh-hive-actions"><p>The turn budget is exhausted.</p><button type="button" disabled={state.pending} onClick={()=>act(controller,'resume_team',{extraTurns:8})}>Add 8 turns and resume</button></div>:null}</section>
    <section><h2>Latest activity</h2>{team.events?.length?<ol className="dsh-hive-feed">{team.events.slice(-4).map(event=><Post key={event.seq} event={event}/>)}</ol>:<p>The board has no posts yet.</p>}</section>
  </div>;
}
function Post({event}) {return <li className="dsh-hive-post">
  <div className="dsh-hive-line"><strong>{event.author==='system'?'System':'@'+event.author}</strong><span className="dsh-hive-secondary">#{event.seq} · {event.channel??'main'}</span>
    {event.time?<time dateTime={event.time}>{new Date(event.time).toLocaleString()}</time>:null}</div>
  <p className="dsh-hive-prose">{event.text}</p>
</li>;}
function Board({state,controller}) {
  const [query,setQuery]=useState(''),[channel,setChannel]=useState('*'),[author,setAuthor]=useState('*');
  const [text,setText]=useState(''),[postChannel,setPostChannel]=useState('main');
  const events=state.history.filter(event=>(channel==='*'||(event.channel??'main')===channel)&&
    (author==='*'||event.author===author)&&(!query||event.text?.toLowerCase().includes(query.toLowerCase())));
  async function submit(event) {event.preventDefault();if(!text.trim())return;
    try{await controller.command('post_message',{text:text.trim(),channel:postChannel});setText('');}catch{/* Persistent error lives above the view. */}}
  return <div className="dsh-hive-board">
    <div className="dsh-hive-filters"><label>Search board<input type="search" value={query} onChange={event=>setQuery(event.target.value)}/></label>
      <label>Channel<select value={channel} onChange={event=>setChannel(event.target.value)}><option value="*">All channels</option>{state.team.channels.filter(item=>!item.archived).map(item=><option key={item.name}>{item.name}</option>)}</select></label>
      <label>Author<select value={author} onChange={event=>setAuthor(event.target.value)}><option value="*">Everyone</option><option value="coordinator">Coordinator</option>{state.team.members.map(member=><option key={member.name}>{member.name}</option>)}</select></label></div>
    <div className="dsh-hive-actions"><button type="button" disabled={state.historyLoading} onClick={()=>{void controller.loadHistory({reset:true});}}>Load earlier history</button>
      {state.hasMoreHistory?<button type="button" disabled={state.historyLoading} onClick={()=>{void controller.loadHistory();}}>Load next history page</button>:null}
      {state.historyLoading?<span role="status">Loading history…</span>:null}</div>
    {events.length?<ol className="dsh-hive-feed" aria-label="Board posts">{events.map(event=><Post key={event.seq} event={event}/>)}</ol>:<p role="status">No posts match these filters.</p>}
    <form className="dsh-hive-compose" onSubmit={submit}><label>Post to the board<textarea required rows="3" maxLength="6000" value={text} onChange={event=>setText(event.target.value)} placeholder="Share direction or unblock a member…"/></label>
      <div className="dsh-hive-actions"><label>Post channel<select value={postChannel} onChange={event=>setPostChannel(event.target.value)}>{state.team.channels.filter(item=>!item.archived).map(item=><option key={item.name}>{item.name}</option>)}</select></label>
        <button type="submit" disabled={state.pending||!text.trim()}>Post message</button></div>
    </form>
  </div>;
}

function MemberEditor({state,controller,member,opener,onClose}) {
  const [name,setName]=useState(''),[brief,setBrief]=useState(''),[writable,setWritable]=useState(false);
  const [model,setModel]=useState(member?.model??''),[effort,setEffort]=useState(member?.effort??'');
  useEffect(()=>{void controller.loadModels();},[controller]);
  const selection=state.models.find(item=>item.id===model);
  const validModel=!model||Boolean(selection);
  const validEffort=!effort||Boolean(selection?.efforts?.includes(effort));
  async function submit(event) {event.preventDefault();
    try {
      if(member)await controller.command('set_member_model',{member:member.name,model,effort:effort||undefined,resume:false});
      else await controller.command('add_member',{member:{name,brief,writable,...model?{model}:{},...effort?{effort}:{}}});
      onClose();
    } catch{/* Keep the editor and input intact; the error remains visible. */}}
  return <Dialog title={member?'Change model':'Add member'} onClose={onClose} opener={opener}>
    <form onSubmit={submit} className="dsh-hive-form">
      {member?<p>Apply to the next turn for @{member.name}.</p>:<><label>Member name<input required pattern={'[a-z][a-z0-9_\\-]*'} maxLength="30" value={name} onChange={event=>setName(event.target.value)}/></label>
        <label>Assignment<textarea required rows="4" maxLength="6000" value={brief} onChange={event=>setBrief(event.target.value)}/></label>
        <label className="dsh-hive-check"><input type="checkbox" checked={writable} onChange={event=>setWritable(event.target.checked)}/>Request workspace write access</label><p className="dsh-hive-secondary">The Host verifies workspace scope and permission before execution.</p></>}
      <label>Model<select value={model} disabled={state.modelsLoading} onChange={event=>{setModel(event.target.value);setEffort('');}}>
        <option value="">{member?'Choose a model':'Use the team model'}</option>
        {model&&!selection?<option value={model}>{model} (unavailable)</option>:null}
        {state.models.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      {state.modelsLoading?<p role="status">Loading native models…</p>:!state.models.length?<p>No models are available. Enable a model in DSH, then reload the model list.</p>:null}
      {!validModel?<p role="alert">This model is unavailable. Choose a model from the native catalog.</p>:null}
      <label>Reasoning effort<select value={effort} disabled={!selection} onChange={event=>setEffort(event.target.value)}><option value="">Model default</option>{selection?.efforts?.map(value=><option key={value}>{value}</option>)}</select></label>
      {state.error?<p role="alert">{state.error.message}</p>:null}
      <div className="dsh-hive-actions"><button type="button" disabled={state.modelsLoading} onClick={()=>{void controller.loadModels();}}>Reload models</button>
        <button type="submit" disabled={state.pending||!validModel||!validEffort||(member&&!model)||(!member&&(!name||!brief.trim()))}>{state.pending?'Saving…':member?'Apply model':'Add member'}</button></div>
    </form>
  </Dialog>;
}
function MemberWorkspace({workspace}) {
  const path=[workspace?.cwd,workspace?.path,workspace].find(value=>typeof value==='string'&&value.trim());
  return path?<div><dt>Workspace</dt><dd>{path}</dd></div>:null;
}
function Members({state,controller,onJournal}) {
  const [filter,setFilter]=useState(''),[editor,setEditor]=useState(null),[retire,setRetire]=useState(null);
  const members=state.team.members.filter(member=>member.name.toLowerCase().includes(filter.toLowerCase()));
  return <div><div className="dsh-hive-actions"><label>Find a member<input type="search" value={filter} onChange={event=>setFilter(event.target.value)}/></label>
    <button type="button" disabled={state.pending} onClick={event=>setEditor({member:null,opener:event.currentTarget})}>Add member</button></div>
    {members.length?<ul className="dsh-hive-members">{members.map(member=><li key={member.name} className="dsh-hive-member">
      <div className="dsh-hive-line"><Bee name={member.name} status={member.status}/><h2>@{member.name}</h2><Status value={member.status}/></div>
      <p className="dsh-hive-prose">{member.brief}</p>
      <dl className="dsh-hive-facts"><div><dt>Model</dt><dd>{member.model}{member.effort?' · '+member.effort:''}</dd></div>
        <div><dt>Permission</dt><dd>{member.writable?'Workspace write requested':'Read only'}</dd></div>
        <MemberWorkspace workspace={member.workspace}/>
        {member.pendingWaitFor?.length?<div><dt>Waiting for</dt><dd>{member.pendingWaitFor.map(name=>'@'+name).join(', ')}</dd></div>:null}</dl>
      {member.recoveryRequired?<p role="status">Outcome unconfirmed. Inspect the owned session before continuing.</p>:null}
      {state.team.activity?.[member.name]?.steps?.length?<p className="dsh-hive-secondary">{state.team.activity[member.name].steps.at(-1).label}</p>:null}
      <div className="dsh-hive-actions"><button type="button" aria-label={'Journal for '+member.name} disabled={!ownedSession(member)} onClick={event=>onJournal(member.name,event.currentTarget)}>Journal</button>
        <button type="button" disabled={!ownedSession(member)} onClick={()=>controller.openSession(member.name)}>Open session</button>
        <button type="button" disabled={state.pending||member.status==='working'||member.status==='retired'} onClick={event=>setEditor({member,opener:event.currentTarget})}>Change model</button>
        <button type="button" disabled={state.pending||member.status==='retired'||member.retireAfterTurn} onClick={event=>setRetire({member,opener:event.currentTarget})}>{member.retireAfterTurn?'Retiring after turn':'Retire'}</button></div>
    </li>)}</ul>:<p>No members match your search.</p>}
    {editor?<MemberEditor key={editor.member?.name??'new'} {...editor} state={state} controller={controller} onClose={()=>setEditor(null)}/>:null}
    {retire?<Dialog title={'Retire '+retire.member.name+'?'} opener={retire.opener} onClose={()=>setRetire(null)}>
      <p>This member will receive no further turns. Its Journal and session remain available.</p>
      {state.error?<p role="alert">{state.error.message}</p>:null}
      <button type="button" disabled={state.pending} onClick={async()=>{try{await controller.command('retire_member',{member:retire.member.name});setRetire(null);}catch{}}}>Retire member</button>
    </Dialog>:null}
  </div>;
}

function FlowGraph({state,controller,onJournal}) {
  const [replay,setReplay]=useState(null),[hideInactive,setHideInactive]=useState(false),[expandBroadcast,setExpandBroadcast]=useState(false),[focus,setFocus]=useState(null);
  const ref=useRef(null),[width,setWidth]=useState(360),arrow=useId().replaceAll(':','');
  useEffect(()=>{const node=ref.current;if(!node||typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(entries=>setWidth(Math.max(280,entries[0].contentRect.width)));observer.observe(node);return()=>observer.disconnect();},[]);
  const maximum=state.history.at(-1)?.seq??0;const cursor=replay===null?maximum:Math.min(replay,maximum);
  const projection=useMemo(()=>Graph.project(state.history,state.team.members,cursor,{hideInactive,expandBroadcast}),[state.history,state.team.members,cursor,hideInactive,expandBroadcast]);
  const height=Math.max(340,Graph.minimumHeight(projection.nodes.length,width));
  const points=useMemo(()=>Graph.layout(projection.nodes,width,height),[projection,width,height]);
  return <div className="dsh-hive-graph-view"><div className="dsh-hive-filters">
    <label className="dsh-hive-check"><input type="checkbox" checked={hideInactive} onChange={event=>setHideInactive(event.target.checked)}/>Hide inactive</label>
    <label className="dsh-hive-check"><input type="checkbox" checked={expandBroadcast} onChange={event=>setExpandBroadcast(event.target.checked)}/>Expand broadcasts</label>
    <button type="button" disabled={state.historyLoading} onClick={()=>{void controller.loadHistory({reset:true});}}>Load full history</button>
    {state.hasMoreHistory?<button type="button" disabled={state.historyLoading} onClick={()=>{void controller.loadHistory();}}>Load next history page</button>:null}</div>
    <div className="dsh-hive-replay"><label>Replay through post #{cursor}<input aria-label="Replay through post" type="range" min="0" max={maximum} value={cursor} onChange={event=>setReplay(Number(event.target.value))}/></label>
      <button type="button" aria-pressed={replay===null} onClick={()=>setReplay(null)}>Live</button></div>
    <div ref={ref} className="dsh-hive-graph" style={{height}} role="group" aria-label="Message flow graph">
      <svg width="100%" height={height} viewBox={'0 0 '+width+' '+height} aria-hidden="true"><defs><marker id={arrow} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7Z" fill="currentColor"/></marker></defs>
        {projection.links.map(link=>{const a=points.get(link.from),b=points.get(link.to);if(!a||!b)return null;
          const dx=b.x-a.x,dy=b.y-a.y,distance=Math.max(1,Math.hypot(dx,dy)),x=b.x-dx/distance*40,y=b.y-dy/distance*38;
          return <path key={link.from+'>'+link.to} data-hive-edge={link.from+'>'+link.to} d={'M'+a.x+' '+a.y+' Q'+((a.x+b.x)/2-dy*.12)+' '+((a.y+b.y)/2+dx*.12)+' '+x+' '+y}
            className="dsh-hive-edge" strokeWidth={Math.min(4,1+Math.sqrt(link.count))} strokeDasharray={link.direct?undefined:'5 5'}
            opacity={!focus||focus===link.from||focus===link.to?1:.2} markerEnd={'url(#'+arrow+')'}/>;})}
      </svg>
      {projection.nodes.map(node=>{const point=points.get(node.name);return <button key={node.name} type="button" className="dsh-hive-graph-node"
        style={{left:point.x/width*100+'%',top:point.y}} aria-pressed={focus===node.name} onClick={()=>setFocus(focus===node.name?null:node.name)}>
        <Bee name={node.name} status={node.status} coordinator={node.name==='coordinator'}/><strong>{node.name}</strong><span>{node.posts??0} posts</span>
      </button>;})}
    </div>
    <p className="dsh-hive-secondary">Directed mentions in loaded board history. {projection.broadcasts} broadcasts. Dashed lines show expanded broadcasts.</p>
    {projection.links.length?<ul className="dsh-hive-flow-list" aria-label="Message flow counts">{projection.links.filter(link=>!focus||link.from===focus||link.to===focus).map(link=><li key={link.from+'>'+link.to}>@{link.from} → @{link.to}: {link.count} {link.count===1?'mention':'mentions'}</li>)}</ul>:<p>No directed mentions at this point in the replay.</p>}
    {ownedSession(state.team.members.find(member=>member.name===focus))?<button type="button" onClick={event=>onJournal(focus,event.currentTarget)}>Inspect @{focus} Journal</button>:null}
  </div>;
}

const VIEWS=['Overview','Board','Members','Graph'];
export function SwarmView({controller,onExpand,mode='dock',visible=true}) {
  const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const state={...snapshot,pending:snapshot.pending||snapshot.connection!=='connected'};
  const [view,setView]=useState('Overview'),[journal,setJournal]=useState(null);
  const tabRefs=useRef([]),prefix=useId(),journalOwner=useRef(false);
  useEffect(()=>{
    if(!visible)return;
    const release=controller.retain();
    return()=>{if(journalOwner.current){controller.closeJournal();journalOwner.current=false;}release();};
  },[controller,visible]);
  const onJournal=(member,opener)=>{journalOwner.current=true;setJournal({opener,controller});void controller.openJournal(member);};
  const closeJournal=()=>{journalOwner.current=false;setJournal(null);controller.closeJournal();};
  function keyTab(event,index) {const next={ArrowRight:(index+1)%4,ArrowLeft:(index+3)%4,Home:0,End:3}[event.key];if(next===undefined)return;event.preventDefault();setView(VIEWS[next]);tabRefs.current[next]?.focus();}
  return <div className="dsh-hive" data-dsh-hive-swarm={mode}><style>{styles}</style>
    <header className="dsh-hive-header"><div className="dsh-hive-line"><BeeIcon size={28}/><h1>Hive Swarm</h1>{state.team?<Status value={state.team.paused?'paused':state.team.phase}/>:null}</div>
      <div className="dsh-hive-actions"><label>Team<select aria-label="Team" value={state.team?.id??''} disabled={state.loading||snapshot.pending} onChange={event=>controller.selectTeam(event.target.value)}>
        <option value="">Choose a team</option>{state.teams.map(team=><option key={team.id} value={team.id}>{team.title} · {team.cwd}</option>)}</select></label>
        <button type="button" disabled={state.loading} onClick={controller.refresh}>Refresh</button>
        {state.team?<button type="button" disabled={state.pending} onClick={()=>act(controller,state.team.paused?'resume_team':'pause_team')}>{state.team.paused?'Resume':'Pause'}</button>:null}
        {onExpand?<button type="button" aria-label="Open full view" onClick={()=>onExpand(controller)}>Open full view</button>:null}</div>
      <p className="dsh-hive-secondary dsh-hive-context" role="status">{state.loading?'Loading Swarm…':state.connection==='disconnected'?'Disconnected · refresh to reconnect':snapshot.pending?'Saving action…':state.workspace??state.team?.cwd??'Teams in the Host’s permitted workspace scope'}</p>
    </header>
    {state.error?<ErrorNotice error={state.error} controller={controller}/>:null}
    {!state.team?<Empty title={state.loading?'Loading teams…':state.teams.length?'Choose a team':'No teams in this workspace'}>
      {state.loading?'Reading the native Host.':state.teams.length?'Select a team to inspect its work. Opening Swarm does not start workers.':'Create a team through /hive-swarm in an authorized parent session, then refresh.'}
    </Empty>:<>
      <nav role="tablist" aria-label="Swarm views" className="dsh-hive-tabs">{VIEWS.map((title,index)=><button key={title} ref={node=>{tabRefs.current[index]=node;}} type="button" role="tab"
        id={prefix+'-tab-'+title} aria-controls={prefix+'-panel-'+title} aria-selected={view===title} tabIndex={view===title?0:-1} onClick={()=>setView(title)} onKeyDown={event=>keyTab(event,index)}>{title}</button>)}</nav>
      <section role="tabpanel" tabIndex="0" id={prefix+'-panel-'+view} aria-labelledby={prefix+'-tab-'+view} className="dsh-hive-content">
        {view==='Overview'?<Overview state={state} controller={controller} onJournal={onJournal}/>:view==='Board'?<Board key={state.team.id} state={state} controller={controller}/>:view==='Members'?<Members key={state.team.id} state={state} controller={controller} onJournal={onJournal}/>:<FlowGraph key={state.team.id} state={state} controller={controller} onJournal={onJournal}/>}
      </section>
    </>}
    {visible&&journal?.controller===controller&&state.journal?<Journal controller={controller} journal={state.journal} opener={journal.opener} onClose={closeJournal}/>:null}
  </div>;
}

export function FullSurface({surfaces}) {
  const controller=useSyncExternalStore(surfaces.subscribe,surfaces.getSnapshot,surfaces.getSnapshot);
  return <SwarmView controller={controller} mode="main"/>;
}

// The default guide opens a page; a native Open Swarm result can name an exact team address.
const noTab=()=>null;
const linkedTeam=/^hive-swarm:\/\/team\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
export function DockSurface({parentSessionId,controllerForTeam,onExpand,useTabInfo=noTab,useSessions=noTab}) {
  const tab=useTabInfo()?.tab,params=tab?.navigation?.params;
  const workspace=useSessions(state=>state?.byId?.[parentSessionId]?.cwd);
  const address=typeof params?.teamId==='string'?'hive-swarm://team/'+params.teamId:tab?.contentId;
  const teamId=typeof address==='string'?linkedTeam.exec(address)?.[1]?.toLowerCase():undefined;
  return <SwarmView controller={controllerForTeam(teamId,workspace)} onExpand={onExpand} visible={tab?.visible!==false}/>;
}
