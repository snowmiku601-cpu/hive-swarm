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
  stalled:'Needs you',quota:'Quota reached',retired:'Retired',failed:'Needs you',queued:'Queued',blocked:'Blocked',active:'Active'};
function Status({value}) {return <span className="dsh-hive-status" data-status={value}>{phaseLabels[value]??value??'Ready'}</span>;}
function Empty({title,children}) {return <section className="dsh-hive-empty"><h2>{title}</h2><p>{children}</p></section>;}
function ErrorNotice({error,controller}) {return <div role="alert" className="dsh-hive-error">
  <p>{error.message}</p><p className="dsh-hive-secondary">{error.action?'The action may have reached the Host. Refresh to inspect the result, or retry the same request.':'Check the Host connection and workspace permission, then refresh.'}</p>
  <div className="dsh-hive-actions"><button type="button" onClick={()=>controller.refresh()}>Refresh</button>
    {controller.getSnapshot().selectedId&&!controller.getSnapshot().team?<button type="button" onClick={controller.showTeams}>Show teams</button>:null}
    {error.action?<button type="button" disabled={controller.getSnapshot().pending} onClick={()=>{void controller.retryCommand().catch(ignore);}}>Retry action</button>:null}</div>
</div>;}

function PostRef({seq,onJumpPost}) {
  if(!onJumpPost)return '#'+seq;
  return <button type="button" className="dsh-hive-ref" aria-label={'Jump to post #'+seq} onClick={()=>onJumpPost(seq)}>#{seq}</button>;
}
function safeHref(destination) {
  try {
    const url=new URL(destination);
    return ['http:','https:'].includes(url.protocol)?url.href:null;
  } catch {return null;}
}
function renderInline(value,onJumpPost,prefix='i') {
  const parts=[];let offset=0,count=0;
  const tokens=/\x60([^\x60\n]+)\x60|\*\*([^\n]+?)\*\*|\*([^*\n]+)\*|\[([^\]\n]+)\]\(([^\s)]+)\)|\[(done|stall)\]|(?<![a-z0-9_])(@#?[a-z][a-z0-9_-]*|#[1-9]\d*\b)/gi;
  for (const match of value.matchAll(tokens)) {
    if (offset<match.index) parts.push(value.slice(offset,match.index));
    const key=prefix+'-'+(count++);
    if (match[1]) parts.push(<code key={key}>{match[1]}</code>);
    else if (match[2]) parts.push(<strong key={key}>{renderInline(match[2],onJumpPost,key)}</strong>);
    else if (match[3]) parts.push(<em key={key}>{renderInline(match[3],onJumpPost,key)}</em>);
    else if (match[4]) {
      const href=safeHref(match[5]);
      parts.push(href?<a key={key} href={href} target="_blank" rel="noopener noreferrer">{match[4]}</a>:match[0]);
    } else if (match[6]) parts.push(<span key={key} className="dsh-hive-badge" data-badge={match[6].toLowerCase()}>{match[0]}</span>);
    else if (match[0].startsWith('@')) parts.push(<span key={key} className="dsh-hive-mention">{match[0]}</span>);
    else {
      const seq=Number(match[0].slice(1));
      parts.push(Number.isSafeInteger(seq)?<PostRef key={key} seq={seq} onJumpPost={onJumpPost}/>:match[0]);
    }
    offset=match.index+match[0].length;
  }
  if (offset<value.length) parts.push(value.slice(offset));
  return parts;
}
function renderBlocks(value,onJumpPost,prefix='b') {
  const blocks=[];let paragraph=[],list=null,count=0;
  const flushParagraph=()=>{
    if (!paragraph.length) return;
    const key=prefix+'-p'+(count++);
    blocks.push(<p key={key} className="dsh-hive-prose">{renderInline(paragraph.join('\n'),onJumpPost,key)}</p>);
    paragraph=[];
  };
  const flushList=()=>{
    if (!list) return;
    const key=prefix+'-l'+(count++);
    const items=list.items.map((text,idx)=><li key={idx}>{renderInline(text,onJumpPost,key+'-'+idx)}</li>);
    blocks.push(list.ordered?<ol key={key} className="dsh-hive-list" start={list.start}>{items}</ol>:<ul key={key} className="dsh-hive-list">{items}</ul>);
    list=null;
  };
  for (const line of value.split(/\r?\n/)) {
    const heading=/^ {0,3}(#{1,3})\s+(.+)$/.exec(line);
    const entry=/^ {0,3}([-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();flushList();
      const key=prefix+'-h'+(count++);
      const Tag='h'+(2+heading[1].length);
      blocks.push(<Tag key={key}>{renderInline(heading[2],onJumpPost,key)}</Tag>);
    } else if (entry) {
      flushParagraph();
      const ordered=/^\d/.test(entry[1]);
      if (!list||list.ordered!==ordered) {
        flushList();
        list={ordered,start:ordered?Number.parseInt(entry[1],10):1,items:[]};
      }
      list.items.push(entry[2]);
    } else {
      flushList();
      if (line.trim()) paragraph.push(line);
      else flushParagraph();
    }
  }
  flushParagraph();flushList();
  return blocks;
}
function RichText({text,onJumpPost}) {
  const value=String(text??'');
  const nodes=[];let offset=0,count=0;
  const fences=/^[ \t]*\x60{3}[^\r\n\x60]*\r?\n([\s\S]*?)^[ \t]*\x60{3}[ \t]*\r?$/gm;
  for (const match of value.matchAll(fences)) {
    const before=value.slice(offset,match.index);
    if (before.trim()) nodes.push(...renderBlocks(before,onJumpPost,'s'+(count++)));
    nodes.push(<pre key={'c'+(count++)} className="dsh-hive-code"><code>{match[1].replace(/\r?\n$/,'')}</code></pre>);
    offset=match.index+match[0].length;
  }
  const rest=value.slice(offset);
  if (rest.trim()||!nodes.length) nodes.push(...renderBlocks(rest,onJumpPost,'s'+(count++)));
  return <div className="dsh-hive-rich">{nodes}</div>;
}

function compact(value,max=140) {
  const text=String(value??'').replace(/\s+/g,' ').trim();
  return text.length>max?text.slice(0,max-1).trimEnd()+'…':text;
}
function threadState(thread,members) {
  const people=(thread.members??[]).map(name=>members.find(member=>member.name===name)).filter(Boolean);
  if (people.some(member=>member.recoveryRequired||['failed','quota'].includes(member.status))) {
    return {key:'blocked',rank:0};
  }
  if (people.some(member=>member.status==='working')) return {key:'active',rank:1};
  if (people.some(member=>member.status==='queued')) return {key:'queued',rank:2};
  if (people.some(member=>member.status==='waiting')) return {key:'waiting',rank:3};
  if (people.length&&people.every(member=>['done','retired'].includes(member.status))) return {key:'done',rank:4};
  return {key:'queued',rank:2};
}
function memberNow(member,activity,latest) {
  if (member.status==='working') {
    const step=activity?.steps?.findLast(item=>item?.label?.trim())?.label;
    return compact(step)||(member.lastTurn?'Working on turn '+member.lastTurn:'Working on the current turn');
  }
  if (member.recoveryRequired) return 'Outcome unconfirmed. Inspect journal before continuing.';
  if (['quota','failed'].includes(member.status)) return compact(latest?.text)||phaseLabels[member.status]||member.status;
  const waiting=member.pendingWaitFor??member.waitFor;
  if (waiting?.length) return compact('Waiting on '+waiting.map(name=>'@'+name).join(', '));
  const done=/\[done\]\s*([^\r\n]+)/i.exec(latest?.text??'');
  if (done) return compact(done[1]);
  if (member.status==='waiting') return 'Waiting for an @mention';
  if (member.status==='queued') return 'Queued for the next turn';
  return compact(latest?.text?.split(/\r?\n/)[0])||phaseLabels[member.status]||member.status;
}

// Native dialog owns modal focus/trapping; its opener regains focus after dismissal.
function Dialog({title,onClose,opener,closeOnBackdrop=false,children}) {
  const ref=useRef(null),close=useRef(null),titleId=useId().replace(/[^a-zA-Z0-9_-]/g,'');
  useLayoutEffect(()=>{
    const dialog=ref.current;if(!dialog)return;
    if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
    close.current?.focus();
    return()=>{if(dialog.open&&typeof dialog.close==='function')dialog.close();if(opener?.isConnected)opener.focus();};
  },[opener]);
  return <dialog ref={ref} className="dsh-hive-dialog" aria-labelledby={titleId} {...closeOnBackdrop?{closedby:'any'}:{}}
    onCancel={event=>{event.preventDefault();onClose();}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();onClose();}}}>
    <header className="dsh-hive-dialog-head"><h2 id={titleId}>{title}</h2><button type="button" ref={close} aria-label={'Close '+title} onClick={onClose}>Close</button></header>
    {children}
  </dialog>;
}
function Journal({controller,journal,opener,onClose,onJumpPost}) {
  const jump=seq=>{onClose();onJumpPost(seq);};
  return <Dialog title="Journal" onClose={onClose} opener={opener} closeOnBackdrop>
    <div className="dsh-hive-actions"><strong>@{journal.member}</strong><button type="button" disabled={journal.loading} onClick={()=>{void controller.openJournal(journal.member);}}>Refresh Journal</button></div>
    {journal.loading?<p role="status">Loading Journal…</p>:journal.error?<ErrorNotice error={journal.error} controller={{...controller,refresh:()=>controller.openJournal(journal.member)}}/>:
      journal.turns.length?<ol className="dsh-hive-journal">{journal.turns.map((turn,index)=><li key={turn.turn??index}>
        <div className="dsh-hive-line"><h3>Turn {turn.turn??index+1}</h3><Status value={turn.status}/></div>
        {turn.steps?.length?<ul>{turn.steps.map((step,i)=><li key={i}>{typeof step==='string'?step:step.label}{typeof step==='object'&&step.detail?' — '+step.detail:''}</li>)}</ul>:null}
        {turn.report?<RichText text={turn.report} onJumpPost={jump}/>:<p className="dsh-hive-secondary">No report saved for this turn.</p>}
      </li>)}</ol>:<p>No saved turns yet. Live work appears here after the Host records it.</p>}
    {journal.live?.steps?.length?<section><h3>Current activity</h3><ul>{journal.live.steps.map((step,index)=><li key={index}>{typeof step==='string'?step:step.label}</li>)}</ul></section>:null}
  </Dialog>;
}

function RecoveryButtons({memberName,pending,controller}) {
  return <>
    <button type="button" disabled={pending} aria-label={'Retry fresh turn for @'+memberName} onClick={()=>act(controller,'resolve_recovery',{member:memberName,action:'retry'})}>Retry fresh turn</button>
    <button type="button" disabled={pending} aria-label={'Dismiss unconfirmed run for @'+memberName} onClick={()=>act(controller,'resolve_recovery',{member:memberName,action:'dismiss'})}>Dismiss</button>
  </>;
}

function Overview({state,controller,onJournal,onJumpPost,onMention}) {
  const team=state.team;
  const events=state.history.length?state.history:(team.events??[]);
  const latestByAuthor=useMemo(()=>{
    const map=new Map();
    for (const post of events) if (post.kind!=='brief'&&post.author!=='system') map.set(post.author,post);
    return map;
  },[events]);
  const workers=team.members.filter(member=>member.role!=='coordinator'&&member.status!=='retired');
  const workersDone=workers.filter(member=>member.status==='done').length;
  const brief=team.task?.trim()??'';
  const longBrief=brief.length>180||/\n/.test(brief);
  const needs=team.members.filter(member=>member.recoveryRequired||['quota','failed'].includes(member.status));
  const threads=useMemo(()=>(team.threads??[]).map(thread=>({thread,state:threadState(thread,team.members)}))
    .sort((a,b)=>a.state.rank-b.state.rank),[team.threads,team.members]);
  const milestones=useMemo(()=>events.filter(event=>['checkpoint','monitor'].includes(event.kind)||/\[done\]/i.test(event.text??'')).slice(-6).reverse(),[events]);
  const summary=useMemo(()=>events.findLast(event=>event.author==='coordinator'&&event.kind==='message'),[events]);
  return <div className="dsh-hive-overview">
    <section>
      <h2>Goal and progress</h2>
      {longBrief?<details className="dsh-hive-details"><summary>Full brief</summary><RichText text={brief} onJumpPost={onJumpPost}/></details>:
        brief?<p className="dsh-hive-prose">{brief}</p>:null}
      <div className="dsh-hive-progress">
        <label><span>Workers done</span><strong>{workersDone}/{workers.length}</strong><progress max={Math.max(workers.length,1)} value={workersDone}/></label>
        <label><span>Turns used</span><strong>{team.turns}/{team.turnLimit}</strong><progress max={Math.max(team.turnLimit,1)} value={team.turns}/></label>
      </div>
      {summary?<div className="dsh-hive-summary">
        <div className="dsh-hive-line"><h3>Coordinator summary</h3><PostRef seq={summary.seq} onJumpPost={onJumpPost}/></div>
        <RichText text={summary.text} onJumpPost={onJumpPost}/>
      </div>:null}
    </section>
    {team.attention?.length||needs.length?<section><h2>Needs you</h2><ul className="dsh-hive-attention">
      {(team.attention??[]).map((item,index)=>{
        const target=team.members.find(member=>member.name===item.member);
        return <li key={'a-'+index}><p>{item.text??item.message??item.kind}</p>
          <div className="dsh-hive-actions">
            {item.seq?<PostRef seq={item.seq} onJumpPost={onJumpPost}/>:null}
            {ownedSession(target)?<button type="button" onClick={event=>onJournal(item.member,event.currentTarget)}>Inspect @{item.member}</button>:null}
            {target?.recoveryRequired?<RecoveryButtons memberName={target.name} pending={state.pending||target.status==='working'} controller={controller}/>:null}
          </div></li>;
      })}
      {needs.filter(member=>!team.attention?.some(item=>item.member===member.name)).map(member=><li key={member.name}>
        <p>@{member.name}: {member.recoveryRequired?'Outcome unconfirmed. Inspect the owned session before continuing.':member.status==='quota'?'Model quota reached. Choose an available model before resuming.':'The last turn failed. Inspect the Journal for recovery details.'}</p>
        <div className="dsh-hive-actions">
          {ownedSession(member)?<button type="button" onClick={event=>onJournal(member.name,event.currentTarget)}>Inspect Journal</button>:null}
          {member.recoveryRequired?<RecoveryButtons memberName={member.name} pending={state.pending||member.status==='working'} controller={controller}/>:null}
        </div></li>)}
    </ul></section>:<section><h2>Progress</h2><p>No blockers reported.</p></section>}
    {threads.length?<section><h2>Threads</h2><ul className="dsh-hive-threads">{threads.map(({thread,state:ts})=><li key={thread.id} className="dsh-hive-thread">
      <div className="dsh-hive-line"><strong>{thread.title}</strong><Status value={ts.key}/></div>
      {thread.goal?<p className="dsh-hive-secondary">{thread.goal}</p>:null}
      {thread.members?.length?<p className="dsh-hive-secondary">{thread.members.map(name=>'@'+name).join(' · ')}</p>:null}
    </li>)}</ul></section>:null}
    <section><h2>Member status</h2><ul className="dsh-hive-status-list">{team.members.map(member=>{
      const latest=latestByAuthor.get(member.name);
      return <li key={member.name} className="dsh-hive-status-row">
        <div className="dsh-hive-line"><strong>@{member.name}</strong><Status value={member.status}/></div>
        <p className="dsh-hive-secondary">{memberNow(member,team.activity?.[member.name],latest)}</p>
        <div className="dsh-hive-actions">
          {latest?<PostRef seq={latest.seq} onJumpPost={onJumpPost}/>:null}
          {ownedSession(member)?<button type="button" aria-label={'View journal for @'+member.name} onClick={event=>onJournal(member.name,event.currentTarget)}>Journal</button>:null}
          {member.status!=='retired'&&!member.retireAfterTurn?<button type="button" aria-label={'@mention @'+member.name+' on board'} onClick={()=>onMention(member.name)}>@mention</button>:null}
        </div>
      </li>;
    })}</ul></section>
    {milestones.length?<section><h2>Milestones</h2><ul className="dsh-hive-milestones">{milestones.map(event=><li key={event.seq} className="dsh-hive-milestone">
      <PostRef seq={event.seq} onJumpPost={onJumpPost}/><span>{compact(event.text,180)}</span>
    </li>)}</ul></section>:null}
    <section><h2>Execution</h2><dl className="dsh-hive-facts">
      <div><dt>Turns</dt><dd>{team.turns} of {team.turnLimit} used</dd></div>
      <div><dt>Members</dt><dd>{team.members.filter(member=>member.status!=='retired').length} active · {team.members.filter(member=>member.status==='working').length} working</dd></div>
      <div><dt>Model</dt><dd>{team.model??'Host default'}{team.effort?' · '+team.effort:''}</dd></div>
      {team.fallbackModel?<div><dt>Fallback</dt><dd>{team.fallbackModel}{team.fallbackEffort?' · '+team.fallbackEffort:''}</dd></div>:null}
      <div><dt>Workspace</dt><dd>{team.cwd}</dd></div>
    </dl>{team.phase==='budget'?<div className="dsh-hive-actions"><p>The turn budget is exhausted.</p><button type="button" disabled={state.pending} onClick={()=>act(controller,'resume_team',{extraTurns:8})}>Add 8 turns and resume</button></div>:null}</section>
    <section><h2>Latest activity</h2>{events.length?<ol className="dsh-hive-feed">{events.slice(-4).map(event=><Post key={event.seq} event={event} onJumpPost={onJumpPost}/>)}</ol>:<p>The board has no posts yet.</p>}</section>
  </div>;
}
function Post({event,onJumpPost,focused=false}) {return <li className="dsh-hive-post" data-seq={event.seq} data-focused={focused?'true':undefined}>
  <div className="dsh-hive-line"><strong>{event.author==='system'?'System':'@'+event.author}</strong>
    {event.targets?.length?<span className="dsh-hive-mention">{'→ '+event.targets.map(name=>'@'+name).join(' ')}</span>:null}
    <span className="dsh-hive-secondary">#{event.seq} · {event.channel??'main'}</span>
    {event.time?<time dateTime={event.time}>{new Date(event.time).toLocaleString()}</time>:null}</div>
  <RichText text={event.text} onJumpPost={onJumpPost}/>
</li>;}
function Board({state,controller,focusedSeq,onClearFocus,mentionRequest,onConsumeMention,onJumpPost}) {
  const [query,setQuery]=useState(''),[channel,setChannel]=useState('*'),[author,setAuthor]=useState('*');
  const [text,setText]=useState(''),[postChannel,setPostChannel]=useState('main'),[following,setFollowing]=useState(true);
  const feedRef=useRef(null),composeRef=useRef(null);
  useEffect(()=>{
    if(!mentionRequest?.name)return;
    const tag='@'+mentionRequest.name;
    setText(prev=>{
      const pattern=new RegExp('(?:^|[^a-z0-9_])@'+mentionRequest.name+'(?![a-z0-9_-])','i');
      return pattern.test(prev)?prev:tag+' '+prev;
    });
    composeRef.current?.focus?.();
    onConsumeMention?.();
  },[mentionRequest,onConsumeMention]);
  const matching=state.history.filter(event=>(channel==='*'||(event.channel??'main')===channel)&&
    (author==='*'||event.author===author)&&(!query||event.text?.toLowerCase().includes(query.toLowerCase())));
  useEffect(()=>{
    if(focusedSeq==null)return;
    if(!matching.some(event=>event.seq===focusedSeq)&&state.history.some(event=>event.seq===focusedSeq)) {
      setQuery('');setChannel('*');setAuthor('*');
    }
    setFollowing(false);
    const node=feedRef.current?.querySelector?.('[data-seq="'+focusedSeq+'"]');
    node?.scrollIntoView?.({block:'nearest'});
  },[focusedSeq,state.history.length,matching.length]);
  useEffect(()=>{
    if(following&&feedRef.current)feedRef.current.scrollTop=feedRef.current.scrollHeight;
  },[following,matching.length]);
  const working=state.team.members.filter(member=>member.status==='working');
  async function submit(event) {event.preventDefault();if(!text.trim())return;
    try{await controller.command('post_message',{text:text.trim(),channel:postChannel});setText('');onClearFocus?.();}catch{/* Persistent error lives above the view. */}}
  return <div className="dsh-hive-board">
    {working.length?<section className="dsh-hive-live" aria-label="Live activity">
      <h3>Live activity</h3>
      <ul>{working.map(member=>{
        const activity=state.team.activity?.[member.name];
        const step=activity?.steps?.at(-1);
        return <li key={member.name}><strong>@{member.name}</strong><span>{step?step.label+(step.detail?' · '+step.detail:''):'Working…'}</span></li>;
      })}</ul>
    </section>:null}
    <div className="dsh-hive-filters"><label>Search board<input type="search" value={query} onChange={event=>setQuery(event.target.value)}/></label>
      <label>Channel<select value={channel} onChange={event=>setChannel(event.target.value)}><option value="*">All channels</option>{state.team.channels.filter(item=>!item.archived).map(item=><option key={item.name}>{item.name}</option>)}</select></label>
      <label>Author<select value={author} onChange={event=>setAuthor(event.target.value)}><option value="*">Everyone</option><option value="coordinator">Coordinator</option>{state.team.members.map(member=><option key={member.name}>{member.name}</option>)}</select></label>
      <button type="button" aria-pressed={following} onClick={()=>setFollowing(value=>!value)}>Follow</button></div>
    <div className="dsh-hive-actions"><button type="button" disabled={state.historyLoading} onClick={()=>{void controller.loadHistory({reset:true});}}>Load earlier history</button>
      {state.hasMoreHistory?<button type="button" disabled={state.historyLoading} onClick={()=>{void controller.loadHistory();}}>Load next history page</button>:null}
      {state.historyLoading?<span role="status">Loading history…</span>:null}</div>
    {matching.length?<ol ref={feedRef} className="dsh-hive-feed" aria-label="Board posts">{matching.map(event=><Post key={event.seq} event={event} onJumpPost={onJumpPost} focused={focusedSeq===event.seq}/>)}</ol>:<p role="status">No posts match these filters.</p>}
    <form className="dsh-hive-compose" onSubmit={submit}><label>Post to the board<textarea ref={composeRef} required rows="3" maxLength="6000" value={text} onChange={event=>setText(event.target.value)} placeholder="Share direction or unblock a member…"/></label>
      <div className="dsh-hive-actions"><label>Post channel<select value={postChannel} onChange={event=>setPostChannel(event.target.value)}>{state.team.channels.filter(item=>!item.archived).map(item=><option key={item.name}>{item.name}</option>)}</select></label>
        <button type="submit" disabled={state.pending||!text.trim()}>Post message</button></div>
    </form>
  </div>;
}

function MemberEditor({state,controller,member,opener,onClose}) {
  const [name,setName]=useState(''),[brief,setBrief]=useState(''),[writable,setWritable]=useState(false);
  const [model,setModel]=useState(member?.model??''),[effort,setEffort]=useState(member?.effort??''),[resume,setResume]=useState(false);
  useEffect(()=>{void controller.loadModels();},[controller]);
  const selection=state.models.find(item=>item.id===model);
  const validModel=!model||Boolean(selection);
  const validEffort=!effort||Boolean(selection?.efforts?.includes(effort));
  const mayResume=Boolean(member&&['waiting','failed','quota'].includes(member.status)&&!member.recoveryRequired);
  async function submit(event) {event.preventDefault();
    try {
      if(member)await controller.command('set_member_model',{member:member.name,model,effort:effort||null,resume:Boolean(mayResume&&resume)});
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
      {mayResume?<label className="dsh-hive-check"><input type="checkbox" checked={resume} onChange={event=>setResume(event.target.checked)}/>Resume now</label>:null}
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
function Members({state,controller,onJournal,onMention}) {
  const [filter,setFilter]=useState(''),[editor,setEditor]=useState(null),[retire,setRetire]=useState(null);
  const members=state.team.members.filter(member=>member.name.toLowerCase().includes(filter.toLowerCase()));
  return <div className="dsh-hive-members-view"><div className="dsh-hive-actions"><label>Find a member<input type="search" value={filter} onChange={event=>setFilter(event.target.value)}/></label>
    <button type="button" disabled={state.pending} onClick={event=>setEditor({member:null,opener:event.currentTarget})}>Add member</button></div>
    {members.length?<ul className="dsh-hive-members">{members.map(member=>{
      const brief=member.brief?.trim()??'';
      const longBrief=brief.length>220||/\n/.test(brief);
      return <li key={member.name} className="dsh-hive-member">
      <div className="dsh-hive-line"><Bee name={member.name} status={member.status}/><h2>@{member.name}</h2><Status value={member.status}/></div>
      {longBrief?<><p className="dsh-hive-prose">{compact(brief,200)}</p><details className="dsh-hive-details"><summary>Full brief</summary><p className="dsh-hive-prose">{brief}</p></details></>:
        <p className="dsh-hive-prose">{member.brief}</p>}
      <dl className="dsh-hive-facts"><div><dt>Model</dt><dd>{member.model}{member.effort?' · '+member.effort:''}</dd></div>
        {member.fallbackModel?<div><dt>Fallback</dt><dd>{member.fallbackModel}{member.fallbackEffort?' · '+member.fallbackEffort:''}</dd></div>:null}
        <div><dt>Permission</dt><dd>{member.writable?'Workspace write requested':'Read only'}</dd></div>
        <MemberWorkspace workspace={member.workspace}/>
        {member.group?<div><dt>Group</dt><dd>@{member.group}</dd></div>:null}
        {member.channels?.length?<div><dt>Channels</dt><dd>{member.channels.map(ch=>'#'+ch).join(', ')}</dd></div>:null}
        {member.pendingWaitFor?.length?<div><dt>Waiting for</dt><dd>{member.pendingWaitFor.map(name=>'@'+name).join(', ')}</dd></div>:null}</dl>
      {member.recoveryRequired?<p role="status">Outcome unconfirmed. Inspect the owned session before continuing.</p>:null}
      {state.team.activity?.[member.name]?.steps?.length?<p className="dsh-hive-secondary">{state.team.activity[member.name].steps.at(-1).label}</p>:null}
      <div className="dsh-hive-actions"><button type="button" aria-label={'Journal for '+member.name} disabled={!ownedSession(member)} onClick={event=>onJournal(member.name,event.currentTarget)}>Journal</button>
        <button type="button" aria-label={'Open session for @'+member.name} disabled={!ownedSession(member)} onClick={()=>controller.openSession(member.name)}>Open session</button>
        {member.status!=='retired'&&!member.retireAfterTurn?<button type="button" aria-label={'@mention @'+member.name+' on board'} onClick={()=>onMention(member.name)}>@mention</button>:null}
        <button type="button" aria-label={'Change model for @'+member.name} disabled={state.pending||member.status==='working'||member.status==='retired'} onClick={event=>setEditor({member,opener:event.currentTarget})}>Change model</button>
        <button type="button" aria-label={'Retire @'+member.name} disabled={state.pending||member.status==='retired'||member.retireAfterTurn} onClick={event=>setRetire({member,opener:event.currentTarget})}>{member.retireAfterTurn?'Retiring after turn':'Retire'}</button>
        {member.recoveryRequired?<RecoveryButtons memberName={member.name} pending={state.pending||member.status==='working'} controller={controller}/>:null}
        {member.workspace&&(member.status==='retired'||state.team.phase==='done')?<button type="button" disabled={state.pending} aria-label={'Clean worktree for @'+member.name} onClick={()=>act(controller,'remove_worktree',{member:member.name})}>Clean worktree</button>:null}</div>
    </li>;})}</ul>:<p>No members match your search.</p>}
    {editor?<MemberEditor key={editor.member?.name??'new'} {...editor} state={state} controller={controller} onClose={()=>setEditor(null)}/>:null}
    {retire?<Dialog title={'Retire '+retire.member.name+'?'} opener={retire.opener} onClose={()=>setRetire(null)}>
      <p>This member will receive no further turns. Its Journal and session remain available.</p>
      {state.error?<p role="alert">{state.error.message}</p>:null}
      <button type="button" disabled={state.pending} onClick={async()=>{try{await controller.command('retire_member',{member:retire.member.name});setRetire(null);}catch{}}}>Retire member</button>
    </Dialog>:null}
  </div>;
}

function FlowGraph({state,controller,onJournal,onJumpPost}) {
  const [replay,setReplay]=useState(null),[playing,setPlaying]=useState(false),[pacing,setPacing]=useState('even'),[speed,setSpeed]=useState(1);
  const [hideInactive,setHideInactive]=useState(false),[expandBroadcast,setExpandBroadcast]=useState(false),[focus,setFocus]=useState(null);
  const ref=useRef(null),[width,setWidth]=useState(360),arrow=useId().replaceAll(':','');
  useEffect(()=>{const node=ref.current;if(!node||typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(entries=>setWidth(Math.max(280,entries[0].contentRect.width)));observer.observe(node);return()=>observer.disconnect();},[]);
  const posts=useMemo(()=>state.history.filter(Graph.isPost),[state.history]);
  const index=replay===null?posts.length:Math.max(0,Math.min(posts.length,posts.findIndex(e=>e.seq>replay)===-1?posts.length:posts.findIndex(e=>e.seq>replay)));
  const current=posts[index-1];
  const cursor=current?.seq??0;
  useEffect(()=>{
    if(!playing)return;
    if(index>=posts.length){setPlaying(false);return;}
    const gap=Date.parse(posts[index].time)-Date.parse(posts[index-1]?.time);
    const delay=pacing==='real'&&Number.isFinite(gap)?Math.max(110,Math.min(gap,2000)):620;
    const timer=setTimeout(()=>{setReplay(posts[index].seq);},delay/speed);
    return()=>clearTimeout(timer);
  },[playing,index,posts,pacing,speed]);
  const setPosition=next=>{setPlaying(false);setReplay(posts[next-1]?.seq??0);};
  const togglePlay=()=>{
    if(playing){setPlaying(false);return;}
    if(!posts.length)return;
    if(replay===null||index>=posts.length)setReplay(0);
    setPlaying(true);
  };
  const projection=useMemo(()=>Graph.project(posts,state.team.members,cursor,{hideInactive,expandBroadcast}),[posts,state.team.members,cursor,hideInactive,expandBroadcast]);
  const height=Math.max(380,Graph.minimumHeight(projection.nodes.length,width));
  const points=useMemo(()=>Graph.layout(projection.nodes,width,height),[projection,width,height]);
  const elapsed=Graph.elapsedSpan(posts.slice(0,index),{live:replay===null&&['working','queued'].includes(state.team.phase)});
  return <div className="dsh-hive-graph-view"><div className="dsh-hive-filters">
    <label className="dsh-hive-check"><input type="checkbox" checked={hideInactive} onChange={event=>setHideInactive(event.target.checked)}/>Hide inactive</label>
    <label className="dsh-hive-check"><input type="checkbox" checked={expandBroadcast} onChange={event=>setExpandBroadcast(event.target.checked)}/>Expand broadcasts</label>
    <label>Pacing<select value={pacing} onChange={event=>setPacing(event.target.value)}><option value="even">Even</option><option value="real">Real-time</option></select></label>
    <label>Speed<select value={speed} onChange={event=>setSpeed(Number(event.target.value))}><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select></label>
    <button type="button" disabled={state.historyLoading} onClick={()=>{void controller.loadHistory({reset:true});}}>Load full history</button>
    {state.hasMoreHistory?<button type="button" disabled={state.historyLoading} onClick={()=>{void controller.loadHistory();}}>Load next history page</button>:null}</div>
    <div className="dsh-hive-replay">
      <div className="dsh-hive-actions">
        <button type="button" aria-label="First post" disabled={!posts.length||index===1} onClick={()=>setPosition(1)}>|‹</button>
        <button type="button" aria-label="Previous post" disabled={index===0} onClick={()=>setPosition(Math.max(0,index-1))}>‹</button>
        <button type="button" aria-label={playing?'Pause replay':'Replay'} disabled={!posts.length} onClick={togglePlay}>{playing?'Ⅱ':'▶'}</button>
        <button type="button" aria-label="Next post" disabled={index>=posts.length} onClick={()=>setPosition(index+1)}>›</button>
      </div>
      <label>Replay ({index}/{posts.length} · {elapsed})<input aria-label="Replay through post" type="range" min="0" max={posts.length} value={index} onChange={event=>setPosition(Number(event.target.value))}/></label>
      <button type="button" aria-pressed={replay===null} onClick={()=>{setPlaying(false);setReplay(null);}}>Live</button></div>
    <div ref={ref} className="dsh-hive-graph" style={{height}} role="group" aria-label="Message flow graph">
      <svg width="100%" height={height} viewBox={'0 0 '+width+' '+height} aria-hidden="true"><defs><marker id={arrow} markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M1 1.5L9 5L1 8.5Z" fill="currentColor"/></marker></defs>
        {projection.links.map(link=>{const a=points.get(link.from),b=points.get(link.to);if(!a||!b)return null;
          const dx=b.x-a.x,dy=b.y-a.y,distance=Math.hypot(dx,dy);if(distance<16)return null;
          const ux=dx/distance,uy=dy/distance,padStart=Math.min(48,distance*0.34),padEnd=Math.min(54,distance*0.4);
          const sx=a.x+ux*padStart,sy=a.y+uy*padStart,ex=b.x-ux*padEnd,ey=b.y-uy*padEnd;
          const seg=Math.hypot(ex-sx,ey-sy);if(seg<6)return null;
          const bend=Math.min(24,seg*0.16),cx=(sx+ex)/2-uy*bend,cy=(sy+ey)/2+ux*bend;
          return <path key={link.from+'>'+link.to} data-hive-edge={link.from+'>'+link.to} d={'M'+sx.toFixed(1)+' '+sy.toFixed(1)+' Q'+cx.toFixed(1)+' '+cy.toFixed(1)+' '+ex.toFixed(1)+' '+ey.toFixed(1)}
            className="dsh-hive-edge" strokeWidth={Math.min(4,1+Math.sqrt(link.count))} strokeDasharray={link.direct?undefined:'5 5'}
            opacity={!focus||focus===link.from||focus===link.to?1:.2} markerEnd={'url(#'+arrow+')'}/>;})}
      </svg>
      {projection.nodes.map(node=>{const point=points.get(node.name);const unmentioned=Graph.unmentionedNode(node);return <button key={node.name} type="button" className="dsh-hive-graph-node"
        data-unmentioned={unmentioned?'true':undefined} style={{left:point.x/width*100+'%',top:point.y}} aria-pressed={focus===node.name} onClick={()=>setFocus(focus===node.name?null:node.name)}>
        <Bee name={node.name} status={node.status} coordinator={node.name==='coordinator'}/><strong>{node.name}</strong><span>{node.posts??0} posts</span>
      </button>;})}
    </div>
    <p className="dsh-hive-secondary">Directed mentions in loaded board history. {projection.broadcasts} broadcasts. Dashed lines show expanded broadcasts; dashed node rings posted without @mentions.</p>
    {current?<section className="dsh-hive-selected-post">
      <div className="dsh-hive-line"><h3>Selected post</h3><strong>{current.author==='system'?'System':'@'+current.author}</strong><PostRef seq={current.seq} onJumpPost={onJumpPost}/></div>
      <RichText text={current.text} onJumpPost={onJumpPost}/>
    </section>:null}
    {projection.links.length?<ul className="dsh-hive-flow-list" aria-label="Message flow counts">{projection.links.filter(link=>!focus||link.from===focus||link.to===focus).map(link=><li key={link.from+'>'+link.to}>@{link.from} → @{link.to}: {link.count} {link.count===1?'mention':'mentions'}</li>)}</ul>:<p>No directed mentions at this point in the replay.</p>}
    {ownedSession(state.team.members.find(member=>member.name===focus))?<button type="button" onClick={event=>onJournal(focus,event.currentTarget)}>Inspect @{focus} Journal</button>:null}
  </div>;
}

const VIEWS=['Overview','Board','Members','Graph'];
export function SwarmView({controller,onExpand,mode='dock',visible=true}) {
  const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const state={...snapshot,pending:snapshot.pending||snapshot.connection!=='connected'};
  const [view,setView]=useState('Overview'),[journal,setJournal]=useState(null);
  const [renaming,setRenaming]=useState(false),[titleDraft,setTitleDraft]=useState('');
  const [focusedSeq,setFocusedSeq]=useState(null),[mentionRequest,setMentionRequest]=useState(null);
  const tabRefs=useRef([]),prefix=useId().replace(/[^a-zA-Z0-9_-]/g,''),journalOwner=useRef(false);
  useEffect(()=>{
    if(!visible)return;
    const release=controller.retain();
    return()=>{if(journalOwner.current){controller.closeJournal();journalOwner.current=false;}release();};
  },[controller,visible]);
  useEffect(()=>{setRenaming(false);setFocusedSeq(null);setMentionRequest(null);},[state.team?.id]);
  const onJournal=(member,opener)=>{journalOwner.current=true;setJournal({opener,controller});void controller.openJournal(member);};
  const closeJournal=()=>{journalOwner.current=false;setJournal(null);controller.closeJournal();};
  const onJumpPost=seq=>{
    setFocusedSeq(seq);
    setView('Board');
    if(!state.history.some(event=>event.seq===seq))void controller.loadHistory({reset:true});
  };
  const onMention=name=>{setMentionRequest({name,id:Date.now()});setView('Board');};
  const selectView=next=>{setView(next);const idx=VIEWS.indexOf(next);tabRefs.current[idx]?.scrollIntoView?.({block:'nearest',inline:'nearest'});};
  function keyTab(event,index) {const next={ArrowRight:(index+1)%4,ArrowLeft:(index+3)%4,Home:0,End:3}[event.key];if(next===undefined)return;event.preventDefault();selectView(VIEWS[next]);tabRefs.current[next]?.focus();}
  async function saveTitle(event) {
    event.preventDefault();
    const value=titleDraft.trim();
    if(!value)return;
    try{await controller.command('set_team_title',{title:value});setRenaming(false);}catch{}
  }
  return <div className="dsh-hive" data-dsh-hive-swarm={mode}><style>{styles}</style>
    <header className="dsh-hive-header"><div className="dsh-hive-line"><BeeIcon size={28}/><h1>{state.team?.title??'Hive Swarm'}</h1>{state.team?<Status value={state.team.paused?'paused':state.team.phase}/>:null}
        {state.team&&!renaming?<button type="button" disabled={state.pending} onClick={()=>{setTitleDraft(state.team.title??'');setRenaming(true);}}>Rename</button>:null}</div>
      {state.team&&renaming?<form className="dsh-hive-rename" onSubmit={saveTitle}>
        <input aria-label="Swarm title" maxLength="95" required value={titleDraft} onChange={event=>setTitleDraft(event.target.value)}/>
        <button type="submit" disabled={state.pending||!titleDraft.trim()}>Save</button>
        <button type="button" onClick={()=>setRenaming(false)}>Cancel</button>
      </form>:null}
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
        id={prefix+'-tab-'+title} aria-controls={prefix+'-panel-'+title} aria-selected={view===title} tabIndex={view===title?0:-1} onClick={()=>selectView(title)} onKeyDown={event=>keyTab(event,index)}>{title}</button>)}</nav>
      <section role="tabpanel" tabIndex="0" id={prefix+'-panel-'+view} aria-labelledby={prefix+'-tab-'+view} className="dsh-hive-content">
        {view==='Overview'?<Overview state={state} controller={controller} onJournal={onJournal} onJumpPost={onJumpPost} onMention={onMention}/>:
          view==='Board'?<Board key={state.team.id} state={state} controller={controller} focusedSeq={focusedSeq} onClearFocus={()=>setFocusedSeq(null)} mentionRequest={mentionRequest} onConsumeMention={()=>setMentionRequest(null)} onJumpPost={onJumpPost}/>:
          view==='Members'?<Members key={state.team.id} state={state} controller={controller} onJournal={onJournal} onMention={onMention}/>:
          <FlowGraph key={state.team.id} state={state} controller={controller} onJournal={onJournal} onJumpPost={onJumpPost}/>}
      </section>
    </>}
    {visible&&journal?.controller===controller&&state.journal?<Journal controller={controller} journal={state.journal} opener={journal.opener} onClose={closeJournal} onJumpPost={onJumpPost}/>:null}
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
