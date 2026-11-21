import React, {useEffect,useLayoutEffect,useId,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import Graph from 'hive:graph';
import Bees from 'hive:bees';
import Gif from 'hive:gif';
import beeSvg from 'hive:icon';
import styles from './style.css';
import {ownedSession} from './controller.mjs';

const useSafeLayoutEffect=typeof document!=='undefined'?useLayoutEffect:useEffect;
const GRAPH_MODE_KEY='hive-swarm:dsh:graph-mode';
const supportsMutedSprite=typeof Bees.drawSprite==='function';

export const BEE_URL='data:image/svg+xml,'+encodeURIComponent(beeSvg);
export function BeeIcon({size=22,className}) {
  return <img src={BEE_URL} width={size} height={size} className={className} alt="" aria-hidden="true" data-dsh-panel-entry="dsh-hive-swarm"/>;
}
function Bee({name,status,coordinator=false,tint,muted=false,size='md'}) {
  const ref=useRef(null);
  const spriteStatus=muted&&!supportsMutedSprite?'working':status;
  useEffect(()=>{const canvas=ref.current;if(!canvas)return;
    const context=canvas.getContext('2d');
    if(context){
      context.clearRect(0,0,canvas.width,canvas.height);
      const sprite=Bees.sprite(name,{status:spriteStatus,coordinator,tint,muted});
      if(sprite)context.drawImage(sprite,0,0);
    }
  },[name,spriteStatus,coordinator,tint,muted]);
  return <canvas ref={ref} width="20" height="18" aria-hidden="true" className="dsh-hive-bee" data-size={size} data-muted={muted?'true':undefined}/>;
}

const ignore=()=>{};
const act=(controller,action,args)=>{void controller.command(action,args).catch(ignore);};
const phaseLabels={working:'Live',waiting:'Waiting',done:'Done',paused:'Paused',budget:'Turn limit',
  stalled:'Needs you',quota:'Quota reached',retired:'Retired',failed:'Needs you',queued:'Queued',blocked:'Blocked',active:'Active'};
const memberLabels={working:'Working',waiting:'Waiting',done:'Done',paused:'Paused',budget:'Turn limit',
  stalled:'Needs you',quota:'Quota reached',retired:'Retired',failed:'Failed',queued:'Queued',blocked:'Blocked',active:'Active'};
const executionModeLabels={subagent:'Subagent',attached:'Attached',session:'Session'};

function Status({value,compactView=false}) {
  const labels=compactView?phaseLabels:memberLabels;
  return <span className={compactView?'dsh-hive-header-status':'dsh-hive-status'} data-status={value}><span className="dsh-hive-status-dot" aria-hidden="true"/>{labels[value]??value??'Ready'}</span>;
}
function ModeBadge({mode,subagentName}) {
  if(!mode||!Object.hasOwn(executionModeLabels,mode))return null;
  return <span className="dsh-hive-mode" data-mode={mode} title={subagentName?'Subagent: '+subagentName:undefined}>{executionModeLabels[mode]}</span>;
}
function Empty({title,children}) {return <section className="dsh-hive-empty"><h2>{title}</h2><p>{children}</p></section>;}
function ErrorNotice({error,controller}) {return <div role="alert" className="dsh-hive-error">
  <p>{error.message}</p><p className="dsh-hive-secondary">{error.action?'The action may have reached the Host. Refresh to inspect the result, or retry the same request.':'Check the Host connection and workspace permission, then refresh.'}</p>
  <div className="dsh-hive-actions"><button type="button" onClick={()=>controller.refresh()}>Refresh</button>
    {controller.getSnapshot().selectedId&&!controller.getSnapshot().team?<button type="button" onClick={controller.showTeams}>Show teams</button>:null}
    {error.action?<button type="button" disabled={controller.getSnapshot().pending} onClick={()=>{void controller.retryCommand().catch(ignore);}}>Retry action</button>:null}</div>
</div>;}

function Chevron({className='dsh-hive-chevron'}) {
  return <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>;
}
function StateGlyph({status,recovery=false}) {
  if(recovery||['failed','quota','stalled','blocked'].includes(status)) {
    return <span className="dsh-hive-glyph" data-tone="danger" aria-hidden="true">!</span>;
  }
  if(status==='done') {
    return <span className="dsh-hive-glyph" data-tone="done" aria-hidden="true">✓</span>;
  }
  if(status==='working'||status==='active') {
    return <span className="dsh-hive-glyph" data-tone="active" aria-hidden="true"><span className="dsh-hive-glyph-dot"/></span>;
  }
  return <span className="dsh-hive-glyph" data-tone="idle" aria-hidden="true"><span className="dsh-hive-glyph-dot"/></span>;
}

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
function safeImageUrl(url) {
  if(typeof url!=='string')return null;
  const trimmed=url.trim();
  if(!trimmed)return null;
  if(trimmed.startsWith('/api/hive-swarm/v1/screenshot')||trimmed.startsWith('/board/'))return trimmed;
  if(/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(trimmed))return trimmed;
  try {
    const parsed=new URL(trimmed);
    return ['http:','https:','blob:'].includes(parsed.protocol)?parsed.href:null;
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
function smartTaskLabel(member) {
  if(typeof Graph.smartTaskLabel==='function')return Graph.smartTaskLabel(member);
  const explicit=String(member?.taskLabel??'').trim();
  if(explicit)return compact(explicit,64);
  let text=String(member?.brief??'').replace(/[`*_#>\[\]]/g,' ').replace(/\s+/g,' ').trim();
  text=text.replace(/^You are\s+(?:@[a-z0-9_-]+\s+)?(?:an?\s+|the\s+)?(?:Hive Swarm\s+)?(?:member|worker|agent|author|verifier|researcher|investigator|auditor|reviewer)?[^.:\n]*?(?:[.:]\s+|\s+—\s+|\s+-\s+)/i,'');
  text=text.replace(/^(?:Your\s+)?(?:assignment|mission|role|task)(?:\s*\([^)]*\))?\s*[:\-–—]\s*/i,'');
  text=text.replace(/^You\s+own\s+(?:the\s+)?/i,'');
  const first=text.split(/(?<=[.!?])\s+|\s*;\s*|\r?\n/)[0]?.trim()??'';
  let words=first.replace(/[.:,;!?]+$/,'').split(/\s+/).filter(Boolean);
  if(words.length>10)words=words.slice(0,10);
  while(words.length>2&&/^(?:for|in|on|with|to|of|from|by|at|and|or|the|a|an)$/i.test(words.at(-1)))words.pop();
  const result=words.join(' ').trim();
  return compact(result||member?.name||'Task',64);
}
function beeTintStyle(name,coordinator=false,tint) {
  if(typeof Bees.tintStyle==='function')return Bees.tintStyle(name,coordinator,tint);
  const [base,highlight,shade]=Bees.colors(name,coordinator,tint);
  return {
    base,highlight,shade,
    bg:'color-mix(in oklab, '+base+' 16%, transparent)',
    border:'color-mix(in oklab, '+shade+' 42%, var(--hive-border))',
    text:'var(--hive-ink)',
  };
}
function rosterWithCoordinator(team) {
  const members=team?.members??[];
  const hasCoord=members.some(m=>m.role==='coordinator'||m.name==='coordinator');
  const base=hasCoord?members:[{name:'coordinator',role:'coordinator',status:team?.phase==='done'?'done':'waiting',model:team?.model,effort:team?.effort,brief:team?.task??'Coordinator',waitFor:[]},...members];
  let tint=0;
  return base.map(m=>(m.role==='coordinator'||m.name==='coordinator')?{...m,role:'coordinator',tint:0}:{...m,tint:tint++});
}
function BeePill({member,name,coordinator=false,tint,muted=false,onClick,title,ariaLabel}) {
  const label=name??member?.name??'member';
  const style=beeTintStyle(label,coordinator,tint??member?.tint);
  const vars={'--bee-pill-bg':style.bg,'--bee-pill-border':style.border};
  const content=<><Bee name={label} status={member?.status??'waiting'} coordinator={coordinator} tint={tint??member?.tint} muted={muted} size="xs"/><span>{label}</span></>;
  if(onClick) {
    return <button type="button" className="dsh-hive-bee-pill" style={vars} title={title} aria-label={ariaLabel??('Inspect '+label)} onClick={onClick}>{content}</button>;
  }
  return <span className="dsh-hive-bee-pill" data-static="true" style={vars} title={title}>{content}</span>;
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
  if (['quota','failed'].includes(member.status)) return compact(latest?.text)||memberLabels[member.status]||member.status;
  const waiting=member.pendingWaitFor??member.waitFor;
  if (waiting?.length) return compact('Waiting on '+waiting.map(name=>'@'+name).join(', '));
  const done=/\[done\]\s*([^\r?\n]+)/i.exec(latest?.text??'');
  if (done) return compact(done[1]);
  if (member.status==='waiting') return 'Waiting for an @mention';
  if (member.status==='queued') return 'Queued for the next turn';
  return compact(latest?.text?.split(/\r?\n/)[0])||memberLabels[member.status]||member.status;
}

// Native dialog owns modal focus/trapping; its opener regains focus after dismissal.
function Dialog({title,onClose,opener,closeOnBackdrop=false,className='dsh-hive-dialog',children}) {
  const ref=useRef(null),close=useRef(null),titleId=useId().replace(/[^a-zA-Z0-9_-]/g,'');
  useLayoutEffect(()=>{
    const dialog=ref.current;if(!dialog)return;
    if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
    close.current?.focus();
    let cleanupOutside;
    if(closeOnBackdrop&&typeof HTMLDialogElement!=='undefined'&&!('closedBy' in HTMLDialogElement.prototype)) {
      let pressedOutside=false;
      const outside=e=>{const r=dialog.getBoundingClientRect();return e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom;};
      const down=e=>{pressedOutside=outside(e);};
      const up=e=>{if(pressedOutside&&outside(e))onClose();};
      dialog.addEventListener('pointerdown',down);dialog.addEventListener('pointerup',up);
      cleanupOutside=()=>{dialog.removeEventListener('pointerdown',down);dialog.removeEventListener('pointerup',up);};
    }
    return()=>{cleanupOutside?.();if(dialog.open&&typeof dialog.close==='function')dialog.close();if(opener?.isConnected)opener.focus();};
  },[opener,closeOnBackdrop,onClose]);
  return <dialog ref={ref} className={className} aria-labelledby={titleId} {...closeOnBackdrop?{closedby:'any'}:{}}
    onCancel={event=>{event.preventDefault();onClose();}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();onClose();}}}>
    <header className="dsh-hive-dialog-head"><h2 id={titleId}>{title}</h2><button type="button" ref={close} aria-label={'Close '+title} onClick={onClose}>Close</button></header>
    {children}
  </dialog>;
}
function JournalStep({step}) {
  const label=typeof step==='string'?step:String(step?.label??'');
  const detail=typeof step==='object'&&step?.detail?String(step.detail):'';
  const route=/^Verified route:\s*(.+)$/i.exec(label);
  if (route||(typeof step==='object'&&step?.kind==='route')) {
    const routeValue=route?route[1]:label;
    return <li className="dsh-hive-route-item">
      <span className="dsh-hive-route-badge"><span className="dsh-hive-route-check" aria-hidden="true">✓</span>Verified route: <code>{routeValue}</code></span>
      {detail?<span className="dsh-hive-secondary"> — {detail}</span>:null}
    </li>;
  }
  return <li>{label}{detail?' — '+detail:''}</li>;
}
function Journal({controller,journal,opener,onClose,onJumpPost}) {
  const jump=seq=>{onClose();onJumpPost(seq);};
  return <Dialog title="Journal" onClose={onClose} opener={opener} closeOnBackdrop>
    <div className="dsh-hive-actions dsh-hive-journal-bar"><strong>@{journal.member}</strong><button type="button" disabled={journal.loading} onClick={()=>{void controller.openJournal(journal.member);}}>Refresh Journal</button></div>
    {journal.loading?<p role="status">Loading Journal…</p>:journal.error?<ErrorNotice error={journal.error} controller={{...controller,refresh:()=>controller.openJournal(journal.member)}}/>:
      journal.turns.length?<ol className="dsh-hive-journal">{journal.turns.map((turn,index)=><li key={turn.turn??index} className="dsh-hive-journal-turn">
        <div className="dsh-hive-line"><h3>Turn {turn.turn??index+1}</h3><Status value={turn.status}/></div>
        {turn.steps?.length?<ul className="dsh-hive-journal-steps">{turn.steps.map((step,i)=><JournalStep key={i} step={step}/>)}</ul>:null}
        {turn.report?<RichText text={turn.report} onJumpPost={jump}/>:<p className="dsh-hive-secondary">No report saved for this turn.</p>}
      </li>)}</ol>:<p>No saved turns yet. Live work appears here after the Host records it.</p>}
    {journal.live?.steps?.length?<section className="dsh-hive-live"><h3>Current activity</h3><ul>{journal.live.steps.map((step,index)=><li key={index}>{typeof step==='string'?step:step.label}</li>)}</ul></section>:null}
  </Dialog>;
}

function RecoveryButtons({memberName,pending,controller}) {
  return <>
    <button type="button" disabled={pending} aria-label={'Retry fresh turn for @'+memberName} onClick={()=>act(controller,'resolve_recovery',{member:memberName,action:'retry'})}>Retry fresh turn</button>
    <button type="button" disabled={pending} aria-label={'Dismiss unconfirmed run for @'+memberName} onClick={()=>act(controller,'resolve_recovery',{member:memberName,action:'dismiss'})}>Dismiss</button>
  </>;
}

function DisclosureCard({className,defaultOpen=false,summary,children}) {
  const [open,setOpen]=useState(defaultOpen);
  return <details className={className} open={open}>
    <summary className={className==='dsh-hive-task-card'?'dsh-hive-task-summary':'dsh-hive-thread-head'}
      onClick={event=>{event.preventDefault();setOpen(value=>!value);}}>
      {summary}
    </summary>
    {children}
  </details>;
}

function Overview({state,controller,onJournal,onJumpPost,onMention}) {
  const team=state.team;
  const events=state.history.length?state.history:(team.events??[]);
  const roster=useMemo(()=>rosterWithCoordinator(team),[team]);
  const memberByName=useMemo(()=>new Map(roster.map(m=>[m.name,m])),[roster]);
  const latestByAuthor=useMemo(()=>{
    const map=new Map();
    for (const post of events) if (post.kind!=='brief'&&post.author!=='system') map.set(post.author,post);
    return map;
  },[events]);
  const workers=team.members.filter(member=>member.role!=='coordinator'&&member.name!=='coordinator'&&member.status!=='retired');
  const workersDone=workers.filter(member=>member.status==='done').length;
  const allWorkersDone=workers.length>0&&workersDone===workers.length;
  const brief=team.task?.trim()??'';
  const goalLine=team.goalLine?.trim()??'';
  const longBrief=brief.length>140||/\n/.test(brief);
  const needs=team.members.filter(member=>member.recoveryRequired||['quota','failed'].includes(member.status));
  const filteredAttention=(team.attention??[]).filter(item=>['stalled','budget'].includes(team.phase)||['recovery','input','quota','failed','dependency','cycle'].includes(item.kind));
  const hasAttention=filteredAttention.length>0||needs.length>0||team.phase==='budget'||team.phase==='stalled';

  const workerRows=useMemo(()=>{
    return roster.filter(m=>m.role!=='coordinator'&&m.name!=='coordinator'&&m.status!=='retired')
      .map(member=>({member,latest:latestByAuthor.get(member.name)}))
      .sort((a,b)=>(b.latest?.seq??0)-(a.latest?.seq??0));
  },[roster,latestByAuthor]);

  const threadGroups=useMemo(()=>{
    const source=team.threads?.length?team.threads:workers.length?[{id:'tasks',title:'Tasks',members:workers.map(w=>w.name)}]:[];
    return source.map(thread=>({thread,state:threadState(thread,team.members)})).sort((a,b)=>a.state.rank-b.state.rank);
  },[team.threads,team.members,workers]);

  const screenshots=useMemo(()=>(team.screenshots??[]).map((shot,idx)=>{
    const url=safeImageUrl(shot?.url);
    return url?{...shot,id:shot.id??(shot.seq+':'+idx),url}:null;
  }).filter(Boolean),[team.screenshots]);
  const [lightbox,setLightbox]=useState(null);

  const coordMember=roster.find(m=>m.role==='coordinator'||m.name==='coordinator');
  const hasCoordMember=team.members.some(m=>m.role==='coordinator'||m.name==='coordinator');
  const summary=useMemo(()=>
    events.findLast(e=>e.author==='coordinator'&&e.kind!=='brief')
    ??events.findLast(e=>e.author==='user'&&e.kind!=='brief'&&/\[done\]/i.test(e.text??''))
    ??(!hasCoordMember?events.findLast(e=>e.author==='user'&&e.kind!=='brief'):undefined)
  ,[events,hasCoordMember]);
  const summaryText=summary?.text?.trim()??'';
  const summarySnippet=summaryText?compact(summaryText.replace(/^\[done\]\s*/i,''),180):'';
  const longSummary=summaryText.length>180||/\n/.test(summaryText);

  const inspectMember=(member,opener)=>{
    if(ownedSession(member)){onJournal(member.name,opener);return;}
    const latest=latestByAuthor.get(member.name);
    if(latest)onJumpPost(latest.seq);
    else if(member.status!=='retired'&&!member.retireAfterTurn)onMention(member.name);
  };

  return <div className="dsh-hive-overview">
    {goalLine?<p className="dsh-hive-goal-line">{goalLine}</p>:
      (!longBrief&&brief&&brief!==team.title)?<p className="dsh-hive-goal-line">{brief}</p>:null}
    {longBrief?<details className="dsh-hive-details dsh-hive-brief-disclosure"><summary>Full brief</summary><RichText text={brief} onJumpPost={onJumpPost}/></details>:null}

    <DisclosureCard className="dsh-hive-task-card" defaultOpen={false} summary={<>
      <StateGlyph status={needs.length?'failed':allWorkersDone?'done':'working'} recovery={needs.some(m=>m.recoveryRequired)}/>
      <span className="dsh-hive-task-count"><strong>{workersDone} of {workers.length}</strong> tasks done</span>
      <span className="dsh-hive-task-turns">Turns {team.turns}/{team.turnLimit}</span>
      <Chevron/>
    </>}>
      <div className="dsh-hive-task-body">
        {workerRows.length?<ul className="dsh-hive-task-list">{workerRows.map(({member,latest})=>{
          const now=memberNow(member,team.activity?.[member.name],latest);
          const muted=member.status==='retired';
          return <li key={member.name} className="dsh-hive-task-row">
            <StateGlyph status={member.status} recovery={member.recoveryRequired}/>
            <div className="dsh-hive-task-main">
              <div className="dsh-hive-task-title">{smartTaskLabel(member)}</div>
              <div className="dsh-hive-task-sub">{now}</div>
              {member.recoveryRequired?<div className="dsh-hive-actions dsh-hive-inline-actions"><RecoveryButtons memberName={member.name} pending={state.pending||member.status==='working'} controller={controller}/></div>:null}
            </div>
            <BeePill member={member} muted={muted} title={ownedSession(member)?'Inspect @'+member.name+' Journal':'View @'+member.name}
              ariaLabel={(ownedSession(member)?'Inspect journal for @':'Jump to @')+member.name}
              onClick={event=>inspectMember(member,event.currentTarget)}/>
          </li>;
        })}</ul>:<p className="dsh-hive-secondary dsh-hive-task-empty">No worker tasks assigned yet.</p>}
      </div>
    </DisclosureCard>

    {hasAttention?<section className="dsh-hive-section"><h2>Needs you</h2><ul className="dsh-hive-attention">
      {filteredAttention.map((item,index)=>{
        const target=team.members.find(member=>member.name===item.member);
        return <li key={'a-'+index} className="dsh-hive-alert-card" data-kind={item.kind}><p>{item.text??item.message??item.kind}</p>
          <div className="dsh-hive-actions">
            {item.seq?<PostRef seq={item.seq} onJumpPost={onJumpPost}/>:null}
            {item.kind==='budget'?<button type="button" disabled={state.pending} onClick={()=>act(controller,'resume_team',{extraTurns:8})}>Add 8 turns and resume</button>:null}
            {ownedSession(target)?<button type="button" onClick={event=>onJournal(item.member,event.currentTarget)}>Inspect @{item.member}</button>:null}
            {target?.recoveryRequired?<RecoveryButtons memberName={target.name} pending={state.pending||target.status==='working'} controller={controller}/>:null}
          </div></li>;
      })}
      {needs.filter(member=>!filteredAttention.some(item=>item.member===member.name)).map(member=><li key={member.name} className="dsh-hive-alert-card" data-kind={member.recoveryRequired?'recovery':member.status}>
        <p>@{member.name}: {member.recoveryRequired?'Outcome unconfirmed. Inspect the owned session before continuing.':member.status==='quota'?'Model quota reached. Choose an available model before resuming.':'The last turn failed. Inspect the Journal for recovery details.'}</p>
        <div className="dsh-hive-actions">
          {ownedSession(member)?<button type="button" onClick={event=>onJournal(member.name,event.currentTarget)}>Inspect Journal</button>:null}
          {member.recoveryRequired?<RecoveryButtons memberName={member.name} pending={state.pending||member.status==='working'} controller={controller}/>:null}
        </div></li>)}
      {team.phase==='budget'&&!filteredAttention.some(item=>item.kind==='budget')?<li key="budget-alert" className="dsh-hive-alert-card" data-kind="budget">
        <p>Turn limit reached ({team.turns}/{team.turnLimit}). Add 8 turns to continue.</p>
        <div className="dsh-hive-actions"><button type="button" disabled={state.pending} onClick={()=>act(controller,'resume_team',{extraTurns:8})}>Add 8 turns and resume</button></div>
      </li>:null}
    </ul></section>:null}

    {threadGroups.length?<section className="dsh-hive-section"><h2>Threads</h2><div className="dsh-hive-threads">{threadGroups.map(({thread,state:ts})=>{
      const people=(thread.members??[]).map(name=>memberByName.get(name)??{name,status:'queued',brief:thread.goal??name});
      const total=people.length;
      const doneCount=people.filter(m=>['done','retired'].includes(m.status)).length;
      const openByDefault=threadGroups.length===1||['blocked','active','done'].includes(ts.key);
      return <DisclosureCard key={thread.id??thread.title} className="dsh-hive-thread-card" defaultOpen={openByDefault} summary={<>
        <span className="dsh-hive-thread-left">
          <span className="dsh-hive-thread-dot" data-status={ts.key} aria-hidden="true"/>
          <strong className="dsh-hive-thread-title">{thread.title}</strong>
          <span className="dsh-hive-thread-state">{phaseLabels[ts.key]??ts.key}</span>
        </span>
        <span className="dsh-hive-thread-right">
          <progress className="dsh-hive-mini-progress" max={Math.max(total,1)} value={doneCount} aria-label={thread.title+' progress'}/>
          <span className="dsh-hive-thread-ratio">{doneCount}/{total}</span>
          <Chevron/>
        </span>
      </>}>
        <div className="dsh-hive-thread-body">
          {thread.goal?<p className="dsh-hive-thread-goal">{thread.goal}</p>:null}
          {people.length?<ul className="dsh-hive-thread-rows">{people.map(member=><li key={member.name} className="dsh-hive-thread-task">
            <StateGlyph status={member.status} recovery={member.recoveryRequired}/>
            <span className="dsh-hive-thread-task-title">{smartTaskLabel(member)}</span>
            <BeePill member={member} muted={member.status==='retired'}
              ariaLabel={(ownedSession(member)?'Inspect journal for @':'Jump to @')+member.name}
              onClick={event=>inspectMember(member,event.currentTarget)}/>
          </li>)}</ul>:<p className="dsh-hive-secondary">No members assigned to this thread.</p>}
        </div>
      </DisclosureCard>;
    })}</div></section>:null}

    {screenshots.length?<section className="dsh-hive-section"><h2>Screenshots</h2>
      <ul className="dsh-hive-screenshots-strip">{screenshots.map(shot=>{
        const authorMember=memberByName.get(shot.author);
        return <li key={shot.id} className="dsh-hive-shot-card">
          <button type="button" className="dsh-hive-shot-thumb" aria-label={'Preview screenshot: '+shot.caption}
            onClick={event=>setLightbox({shot,opener:event.currentTarget})}>
            <img src={shot.url} alt={shot.caption} loading="lazy"/>
          </button>
          <div className="dsh-hive-shot-meta">
            <p className="dsh-hive-shot-caption">{shot.caption}</p>
            <div className="dsh-hive-shot-foot">
              {shot.seq?<PostRef seq={shot.seq} onJumpPost={onJumpPost}/>:null}
              {shot.author?<BeePill member={authorMember} name={shot.author} coordinator={shot.author==='coordinator'}
                onClick={authorMember?event=>inspectMember(authorMember,event.currentTarget):undefined}/>:null}
            </div>
          </div>
        </li>;
      })}</ul>
    </section>:null}

    <section className="dsh-hive-section"><h2>The team</h2>
      <div className="dsh-hive-team-card">
        <div className="dsh-hive-coordinator-tile" aria-hidden="true">
          <Bee name="coordinator" status="working" coordinator size="lg"/>
        </div>
        <div className="dsh-hive-team-body">
          <div className="dsh-hive-line">
            <strong className="dsh-hive-team-name">Coordinator</strong>
            <div className="dsh-hive-pill-group">
              {summary?.seq?<PostRef seq={summary.seq} onJumpPost={onJumpPost}/>:null}
              {ownedSession(coordMember)?<button type="button" className="dsh-hive-ghost-btn" onClick={event=>onJournal(coordMember.name,event.currentTarget)}>Journal</button>:null}
            </div>
          </div>
          <p className="dsh-hive-team-summary">{summarySnippet||(brief?compact(brief,180):'Coordinating team progress.')}</p>
          {longSummary?<details className="dsh-hive-details"><summary>Full summary</summary><RichText text={summaryText} onJumpPost={onJumpPost}/></details>:null}
          <details className="dsh-hive-details dsh-hive-exec">
            <summary>Execution</summary>
            <dl className="dsh-hive-facts">
              <div><dt>Turns</dt><dd>{team.turns} of {team.turnLimit} used</dd></div>
              <div><dt>Members</dt><dd>{team.members.filter(member=>member.status!=='retired').length} active · {team.members.filter(member=>member.status==='working').length} working</dd></div>
              <div><dt>Model</dt><dd>{team.model??'Host default'}{team.effort?' · '+team.effort:''}</dd></div>
              {team.fallbackModel?<div><dt>Fallback</dt><dd>{team.fallbackModel}{team.fallbackEffort?' · '+team.fallbackEffort:''}</dd></div>:null}
              <div><dt>Workspace</dt><dd>{team.cwd}</dd></div>
            </dl>
          </details>
          {team.phase==='budget'?<div className="dsh-hive-actions"><button type="button" className="dsh-hive-primary" disabled={state.pending} onClick={()=>act(controller,'resume_team',{extraTurns:8})}>+8 turns</button></div>:null}
        </div>
      </div>
    </section>

    {lightbox?<Dialog title={lightbox.shot.caption||'Screenshot'} opener={lightbox.opener} closeOnBackdrop className="dsh-hive-dialog dsh-hive-lightbox" onClose={()=>setLightbox(null)}>
      <figure className="dsh-hive-lightbox-figure">
        <img src={lightbox.shot.url} alt={lightbox.shot.caption} className="dsh-hive-lightbox-img"/>
        <figcaption className="dsh-hive-lightbox-meta">
          <span>{lightbox.shot.caption}</span>
          <div className="dsh-hive-actions">
            {lightbox.shot.seq?<PostRef seq={lightbox.shot.seq} onJumpPost={seq=>{setLightbox(null);onJumpPost(seq);}}/>:null}
            {lightbox.shot.author?<BeePill member={memberByName.get(lightbox.shot.author)} name={lightbox.shot.author} coordinator={lightbox.shot.author==='coordinator'}/>:null}
            {lightbox.shot.time?<time className="dsh-hive-secondary dsh-hive-mono" dateTime={lightbox.shot.time}>{new Date(lightbox.shot.time).toLocaleString()}</time>:null}
          </div>
        </figcaption>
      </figure>
    </Dialog>:null}
  </div>;
}

function Post({event,onJumpPost,focused=false}) {return <li className="dsh-hive-post" data-seq={event.seq} data-kind={event.kind??'message'} data-focused={focused?'true':undefined}>
  <div className="dsh-hive-line"><strong className="dsh-hive-author">{event.author==='system'?'System':'@'+event.author}</strong>
    {event.targets?.length?<span className="dsh-hive-targets">{'→ '+event.targets.map(name=>'@'+name).join(' ')}</span>:null}
    <span className="dsh-hive-secondary dsh-hive-mono">#{event.seq} · {event.channel??'main'}</span>
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

  const authorOptions=useMemo(()=>{
    const seen=new Set(['user','coordinator']);
    const extra=[];
    for(const member of state.team.members) {
      if(member?.name&&!seen.has(member.name)){seen.add(member.name);extra.push({value:member.name,label:member.name});}
    }
    for(const event of state.history) {
      if(event?.author&&event.author!=='system'&&!seen.has(event.author)){seen.add(event.author);extra.push({value:event.author,label:event.author});}
    }
    return [{value:'*',label:'Everyone'},{value:'user',label:'You (user)'},{value:'coordinator',label:'Coordinator'},...extra];
  },[state.team.members,state.history]);

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
    <div className="dsh-hive-toolbar">
      <div className="dsh-hive-filters"><label>Search board<input type="search" value={query} onChange={event=>setQuery(event.target.value)}/></label>
        <label>Channel<select value={channel} onChange={event=>setChannel(event.target.value)}><option value="*">All channels</option>{state.team.channels.filter(item=>!item.archived).map(item=><option key={item.name}>{item.name}</option>)}</select></label>
        <label>Author<select aria-label="Author" value={author} onChange={event=>setAuthor(event.target.value)}>{authorOptions.map(opt=><option key={opt.value} value={opt.value}>{opt.label}</option>)}</select></label>
        <button type="button" aria-pressed={following} onClick={()=>setFollowing(value=>!value)}>Follow</button></div>
      <div className="dsh-hive-actions"><button type="button" disabled={state.historyLoading} onClick={()=>{void controller.loadHistory({reset:true});}}>Load earlier history</button>
        {state.hasMoreHistory?<button type="button" disabled={state.historyLoading} onClick={()=>{void controller.loadHistory();}}>Load next history page</button>:null}
        {state.historyLoading?<span role="status" className="dsh-hive-secondary">Loading history…</span>:null}</div>
    </div>
    {matching.length?<ol ref={feedRef} className="dsh-hive-feed" aria-label="Board posts">{matching.map(event=><Post key={event.seq} event={event} onJumpPost={onJumpPost} focused={focusedSeq===event.seq}/>)}</ol>:<p role="status" className="dsh-hive-secondary">No posts match these filters.</p>}
    <form className="dsh-hive-compose" onSubmit={submit}><label>Post to the board<textarea ref={composeRef} required rows="3" maxLength="6000" value={text} onChange={event=>setText(event.target.value)} placeholder="Share direction or unblock a member…"/></label>
      <div className="dsh-hive-actions"><label>Post channel<select value={postChannel} onChange={event=>setPostChannel(event.target.value)}>{state.team.channels.filter(item=>!item.archived).map(item=><option key={item.name}>{item.name}</option>)}</select></label>
        <button type="submit" className="dsh-hive-primary" disabled={state.pending||!text.trim()}>Post message</button></div>
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
        <button type="submit" className="dsh-hive-primary" disabled={state.pending||!validModel||!validEffort||(member&&!model)||(!member&&(!name||!brief.trim()))}>{state.pending?'Saving…':member?'Apply model':'Add member'}</button></div>
    </form>
  </Dialog>;
}
function MemberWorkspace({workspace}) {
  const path=[workspace?.cwd,workspace?.path,workspace].find(value=>typeof value==='string'&&value.trim());
  return path?<div><dt>Workspace</dt><dd>{path}</dd></div>:null;
}
function Members({state,controller,onJournal,onOpenSession,onMention}) {
  const [filter,setFilter]=useState(''),[editor,setEditor]=useState(null),[retire,setRetire]=useState(null);
  const members=state.team.members.filter(member=>member.name.toLowerCase().includes(filter.toLowerCase()));
  return <div className="dsh-hive-members-view"><div className="dsh-hive-actions dsh-hive-member-bar"><label>Find a member<input type="search" value={filter} onChange={event=>setFilter(event.target.value)}/></label>
    <button type="button" disabled={state.pending} onClick={event=>setEditor({member:null,opener:event.currentTarget})}>Add member</button></div>
    {members.length?<ul className="dsh-hive-members">{members.map(member=>{
      const brief=member.brief?.trim()??'';
      const longBrief=brief.length>220||/\n/.test(brief);
      const isCoordinator=member.role==='coordinator'||member.name==='coordinator';
      return <li key={member.name} className="dsh-hive-member" data-role={isCoordinator?'coordinator':'worker'} data-status={member.status}>
      <div className="dsh-hive-line dsh-hive-member-head"><Bee name={member.name} status={member.status} coordinator={isCoordinator}/><h2>@{member.name}</h2>
        <div className="dsh-hive-pill-group"><ModeBadge mode={member.executionMode} subagentName={member.subagentName}/><Status value={member.status}/></div></div>
      {longBrief?<><p className="dsh-hive-prose">{compact(brief,200)}</p><details className="dsh-hive-details"><summary>Full brief</summary><p className="dsh-hive-prose">{brief}</p></details></>:
        <p className="dsh-hive-prose">{member.brief}</p>}
      <dl className="dsh-hive-facts"><div><dt>Model</dt><dd>{member.model}{member.effort?' · '+member.effort:''}</dd></div>
        {member.fallbackModel?<div><dt>Fallback</dt><dd>{member.fallbackModel}{member.fallbackEffort?' · '+member.fallbackEffort:''}</dd></div>:null}
        <div><dt>Permission</dt><dd>{member.writable?'Workspace write requested':'Read only'}</dd></div>
        <MemberWorkspace workspace={member.workspace}/>
        {member.group?<div><dt>Group</dt><dd>@{member.group}</dd></div>:null}
        {member.channels?.length?<div><dt>Channels</dt><dd>{member.channels.map(ch=>'#'+ch).join(', ')}</dd></div>:null}
        {member.pendingWaitFor?.length?<div><dt>Waiting for</dt><dd>{member.pendingWaitFor.map(name=>'@'+name).join(', ')}</dd></div>:null}</dl>
      {member.recoveryRequired?<p role="status" className="dsh-hive-recovery-note">Outcome unconfirmed. Inspect the owned session before continuing.</p>:null}
      {state.team.activity?.[member.name]?.steps?.length?<p className="dsh-hive-secondary">{state.team.activity[member.name].steps.at(-1).label}</p>:null}
      <div className="dsh-hive-actions"><button type="button" aria-label={'Journal for '+member.name} disabled={!ownedSession(member)} onClick={event=>onJournal(member.name,event.currentTarget)}>Journal</button>
        <button type="button" aria-label={'Open session for @'+member.name} disabled={!ownedSession(member)} onClick={event=>onOpenSession(member.name,event.currentTarget)}>Open session</button>
        {member.status!=='retired'&&!member.retireAfterTurn?<button type="button" aria-label={'@mention @'+member.name+' on board'} onClick={()=>onMention(member.name)}>@mention</button>:null}
        <button type="button" aria-label={'Change model for @'+member.name} disabled={state.pending||member.status==='working'||member.status==='retired'} onClick={event=>setEditor({member,opener:event.currentTarget})}>Change model</button>
        <button type="button" aria-label={'Retire @'+member.name} disabled={state.pending||member.status==='retired'||member.retireAfterTurn} onClick={event=>setRetire({member,opener:event.currentTarget})}>{member.retireAfterTurn?'Retiring after turn':'Retire'}</button>
        {member.recoveryRequired?<RecoveryButtons memberName={member.name} pending={state.pending||member.status==='working'} controller={controller}/>:null}
        {member.workspace&&(member.status==='retired'||state.team.phase==='done')?<button type="button" disabled={state.pending} aria-label={'Clean worktree for @'+member.name} onClick={()=>act(controller,'remove_worktree',{member:member.name})}>Clean worktree</button>:null}</div>
    </li>;})}</ul>:<p className="dsh-hive-secondary">No members match your search.</p>}
    {editor?<MemberEditor key={editor.member?.name??'new'} {...editor} state={state} controller={controller} onClose={()=>setEditor(null)}/>:null}
    {retire?<Dialog title={'Retire '+retire.member.name+'?'} opener={retire.opener} onClose={()=>setRetire(null)}>
      <p>This member will receive no further turns. Its Journal and session remain available.</p>
      {state.error?<p role="alert">{state.error.message}</p>:null}
      <button type="button" disabled={state.pending} onClick={async()=>{try{await controller.command('retire_member',{member:retire.member.name});setRetire(null);}catch{}}}>Retire member</button>
    </Dialog>:null}
  </div>;
}

function readGraphMode() {
  try {
    const v=globalThis.sessionStorage?.getItem?.(GRAPH_MODE_KEY);
    return v==='mentions'||v==='hive'?v:'hive';
  } catch {return 'hive';}
}
function writeGraphMode(mode) {
  try {globalThis.sessionStorage?.setItem?.(GRAPH_MODE_KEY,mode);} catch {}
}
function detectTheme(element) {
  const docTheme=typeof document!=='undefined'?document.documentElement?.dataset?.theme:undefined;
  if(docTheme==='dark'||docTheme==='light')return docTheme;
  try {
    if(element&&typeof getComputedStyle==='function') {
      const style=getComputedStyle(element);
      const scheme=style.colorScheme;
      if(scheme==='dark'||scheme==='light')return scheme;
      const match=/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/.exec(style.backgroundColor??'');
      if(match) {
        const lum=0.299*Number(match[1])+0.587*Number(match[2])+0.114*Number(match[3]);
        return lum<128?'dark':'light';
      }
    }
  } catch {}
  try {if(globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches)return 'dark';} catch {}
  return 'light';
}

function chevronPoints(end,angle) {
  const cos=Math.cos(angle),sin=Math.sin(angle);
  const pt=(lx,ly)=>(end.x+lx*cos-ly*sin).toFixed(1)+','+(end.y+lx*sin+ly*cos).toFixed(1);
  return pt(1,0)+' '+pt(-8,-3.8)+' '+pt(-6.1,0)+' '+pt(-8,3.8);
}

// Defensive fallbacks until graph-gif merges into release/2.1.0.
function fallbackProjectHive(posts,members,cursor) {
  const filtered=posts.filter(p=>p.seq<=cursor&&Graph.isPost(p));
  const lastPost=filtered.at(-1)??null;
  const live=cursor>=(posts.at(-1)?.seq??0);
  const coord=members.find(m=>m.role==='coordinator'||m.name==='coordinator')??{name:'coordinator',role:'coordinator',status:'waiting'};
  const workers=members.filter(m=>m.role!=='coordinator'&&m.name!=='coordinator');
  const latestSeqBy=new Map();
  for(const p of filtered)latestSeqBy.set(p.author,p.seq);
  const buckets=[
    {id:'working',label:'Working',tone:'working',members:[]},
    {id:'waiting',label:'Waiting',tone:'waiting',members:[]},
    {id:'needs',label:'Needs you',tone:'needs',members:[]},
    {id:'done',label:'Done',tone:'done',members:[]},
  ];
  const byId=new Map(buckets.map(b=>[b.id,b]));
  for(const w of workers) {
    const st=live?w.status:(latestSeqBy.has(w.name)?(w.status==='done'?'done':'waiting'):'waiting');
    const bucketId=(w.recoveryRequired||['failed','quota'].includes(st))?'needs':
      st==='working'?'working':
      ['done','retired'].includes(st)?'done':'waiting';
    byId.get(bucketId).members.push({
      name:w.name,status:st,role:w.role??'worker',tint:w.tint,
      muted:['done','retired'].includes(st),latestSeq:latestSeqBy.get(w.name)??0,pendingWaitFor:w.pendingWaitFor??[],
    });
  }
  const clusters=buckets.filter(b=>b.members.length>0).map(b=>({...b,count:b.members.length}));
  const doneCount=byId.get('done').members.length;
  const phase=byId.get('needs').members.length?'stalled':byId.get('working').members.length?'working':(workers.length&&doneCount===workers.length)?'done':'waiting';
  const connectors=[];
  if(byId.get('done').members.length)connectors.push({from:'done',to:'coordinator',kind:'done',label:'Tasks done'});
  if(lastPost) {
    const authorCluster=lastPost.author==='coordinator'?'coordinator':clusters.find(c=>c.members.some(m=>m.name===lastPost.author))?.id;
    const targets=[...(lastPost.targets??[]),...(lastPost.coordinatorMention?['coordinator']:[])];
    for(const t of targets) {
      const targetCluster=t==='coordinator'?'coordinator':clusters.find(c=>c.members.some(m=>m.name===t))?.id;
      if(authorCluster&&targetCluster&&authorCluster!==targetCluster) {
        connectors.push({from:authorCluster,to:targetCluster,kind:'message',label:'Message just sent',seq:lastPost.seq});
        break;
      }
    }
  }
  for(const c of clusters) {
    for(const m of c.members) {
      for(const dep of m.pendingWaitFor??[]) {
        const depCluster=clusters.find(cl=>cl.members.some(x=>x.name===dep))?.id;
        if(depCluster&&depCluster!==c.id&&!connectors.some(k=>k.kind==='waiting'&&k.from===c.id&&k.to===depCluster)) {
          connectors.push({from:c.id,to:depCluster,kind:'waiting',label:'Waiting on'});
        }
      }
    }
  }
  return {
    currentSeq:lastPost?.seq??0,lastPost,
    coordinator:{name:'coordinator',status:coord.status,role:'coordinator',doneCount,totalWorkers:workers.length,phase,latestSeq:latestSeqBy.get('coordinator')??0,tint:0},
    clusters,connectors,
  };
}

function hexVertices(cx,cy,r) {
  return Array.from({length:6},(_,i)=>({x:cx+r*Math.cos(i*Math.PI/3),y:cy+r*Math.sin(i*Math.PI/3)}));
}
function hexSlotGrid(cx,cy,radius,members) {
  if(!members.length)return [];
  const count=members.length;
  const cols=count<=2?count:count<=6?3:4;
  const rows=Math.ceil(count/cols);
  const availW=radius*1.48;
  const slotWidth=Math.min(72,Math.max(46,availW/cols));
  const rowGap=rows===1?0:rows===2?46:38;
  const startY=cy-(rows-1)*rowGap/2+14;
  return members.map((member,idx)=>{
    const row=Math.floor(idx/cols);
    const inRow=Math.min(cols,count-row*cols);
    const col=idx%cols;
    const x=cx+(col-(inRow-1)/2)*slotWidth;
    const y=startY+row*rowGap;
    return {member,x,y,slotWidth,beeScale:rows>=3?0.9:1};
  });
}
function fallbackLayoutHive(hiveModel,width,height) {
  const clusters=hiveModel.clusters??[];
  const gap=18;
  const cellsById=new Map();
  let radius,coordCenter;
  const laidClusters=[];
  if(!clusters.length) {
    radius=Math.max(76,Math.min(118,width*0.24,height*0.32));
    coordCenter={x:width/2,y:height/2};
  } else if(clusters.length===1) {
    radius=Math.max(76,Math.min(120,width*0.24,(height-36)/(2*Math.sqrt(3)+0.35)));
    const apothem=radius*Math.sqrt(3)/2;
    const midY=height/2;
    const offset=apothem+gap/2;
    const cl=clusters[0];
    const clPos={x:width/2,y:midY-offset};
    coordCenter={x:width/2,y:midY+offset};
    const cell={...cl,x:clPos.x,y:clPos.y,radius,vertices:hexVertices(clPos.x,clPos.y,radius),slots:hexSlotGrid(clPos.x,clPos.y,radius,cl.members)};
    laidClusters.push(cell);
    cellsById.set(cl.id,cell);
  } else {
    coordCenter={x:width/2,y:height*0.70};
    const span=clusters.length===2?Math.PI*0.44:clusters.length===3?Math.PI*0.64:Math.PI*0.74;
    const delta=span/(clusters.length-1);
    const ringR=Math.max(110,Math.min(width*0.34,coordCenter.y-82));
    const minSpacing=Math.min(ringR,2*ringR*Math.sin(delta/2));
    const maxApothem=Math.max(46,(minSpacing-gap)/2);
    radius=Math.max(54,Math.min(92,maxApothem/(Math.sqrt(3)/2)));
    clusters.forEach((cl,i)=>{
      const angle=-Math.PI/2-span/2+i*delta;
      const cx=coordCenter.x+Math.cos(angle)*ringR;
      const cy=coordCenter.y+Math.sin(angle)*ringR;
      const cell={...cl,x:cx,y:cy,radius,vertices:hexVertices(cx,cy,radius),slots:hexSlotGrid(cx,cy,radius,cl.members)};
      laidClusters.push(cell);
      cellsById.set(cl.id,cell);
    });
  }
  const coordinator={id:'coordinator',x:coordCenter.x,y:coordCenter.y,radius,vertices:hexVertices(coordCenter.x,coordCenter.y,radius),model:hiveModel.coordinator};
  cellsById.set('coordinator',coordinator);
  return {width,height,radius,coordinator,clusters:laidClusters,cellsById};
}
function hexBoundaryDist(radius,angle) {
  const apothem=radius*Math.sqrt(3)/2;
  let dist=Infinity;
  for(const k of [Math.PI/6,Math.PI/2,5*Math.PI/6,-Math.PI/6,-Math.PI/2,-5*Math.PI/6]) {
    const c=Math.cos(angle-k);
    if(c>1e-4)dist=Math.min(dist,apothem/c);
  }
  return dist;
}

function fallbackLayoutMentions(nodes,width,height) {
  const result=new Map();
  if(!nodes.length)return result;
  if(nodes.length>12||width<300)return Graph.layout(nodes,width,height);
  const coordIdx=nodes.findIndex(n=>n.role==='coordinator'||n.name==='coordinator');
  const ordered=coordIdx>=0?[nodes[coordIdx],...nodes.filter((_,i)=>i!==coordIdx)]:nodes;
  const topPad=42,bottomPad=42,sidePad=Math.min(92,Math.max(58,width*0.14));
  const cx=width/2,cy=(topPad+(height-bottomPad))/2;
  const rx=Math.max(56,Math.min(width*0.38,width/2-sidePad));
  const ry=Math.max(46,(height-topPad-bottomPad)/2);
  if(ordered.length===1){result.set(ordered[0].name,{x:cx,y:cy});return result;}
  ordered.forEach((node,i)=>{
    const angle=-Math.PI/2+i*(Math.PI*2/ordered.length);
    result.set(node.name,{x:cx+Math.cos(angle)*rx,y:cy+Math.sin(angle)*ry});
  });
  return result;
}
function pillBox(node,narrow) {
  if(typeof Graph.nodeBox==='function') {
    const candidate=Graph.nodeBox(node,{variant:'pill',narrow});
    if(candidate&&candidate.radius>=candidate.halfH-1)return candidate;
  }
  const name=String(node?.name??'');
  const halfH=narrow?14:16;
  const halfW=Math.max(44,Math.min(96,24+name.length*4.1));
  return {halfW,halfH,offsetX:0,offsetY:0,radius:halfH};
}

function FlowGraph({state,controller,onJournal,onJumpPost}) {
  const [graphMode,setGraphMode]=useState(readGraphMode);
  const [replay,setReplay]=useState(null),[playing,setPlaying]=useState(false),[pacing,setPacing]=useState('even'),[speed,setSpeed]=useState(1);
  const [hideInactive,setHideInactive]=useState(false),[expandBroadcast,setExpandBroadcast]=useState(false),[focus,setFocus]=useState(null);
  const [hoveredEdge,setHoveredEdge]=useState(null),[measuredBoxes,setMeasuredBoxes]=useState(null);
  const [gifStatus,setGifStatus]=useState({busy:false,message:'',error:false});
  const rootRef=useRef(null),ref=useRef(null),nodeRefs=useRef(new Map()),[width,setWidth]=useState(480);
  const arrow=useId().replaceAll(':','');

  useEffect(()=>{const node=ref.current;if(!node||typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(entries=>setWidth(Math.max(280,entries[0].contentRect.width)));observer.observe(node);return()=>observer.disconnect();},[]);

  const roster=useMemo(()=>rosterWithCoordinator(state.team),[state.team]);
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
  const selectMode=next=>{
    if(next===graphMode)return;
    setGraphMode(next);writeGraphMode(next);setFocus(null);setHoveredEdge(null);
  };

  const narrow=width<440;
  const elapsed=Graph.elapsedSpan(posts.slice(0,index),{live:replay===null&&['working','queued'].includes(state.team.phase)});

  // Hive mode projection & geometry
  const hiveModel=useMemo(()=>{
    if(graphMode!=='hive')return null;
    return typeof Graph.projectHive==='function'?Graph.projectHive(posts,roster,cursor):fallbackProjectHive(posts,roster,cursor);
  },[graphMode,posts,roster,cursor]);
  const hiveHeight=useMemo(()=>{
    if(graphMode!=='hive'||!hiveModel)return 420;
    const minH=typeof Graph.hiveMinimumHeight==='function'?Graph.hiveMinimumHeight(hiveModel.clusters.length,width):((hiveModel.clusters.length<=1?400:440));
    return Math.max(380,minH);
  },[graphMode,hiveModel,width]);
  const hiveLayout=useMemo(()=>{
    if(graphMode!=='hive'||!hiveModel)return null;
    return typeof Graph.layoutHive==='function'?Graph.layoutHive(hiveModel,width,hiveHeight):fallbackLayoutHive(hiveModel,width,hiveHeight);
  },[graphMode,hiveModel,width,hiveHeight]);

  // Mentions mode projection & capsule pill layout
  const projection=useMemo(()=>Graph.project(posts,roster,cursor,{hideInactive,expandBroadcast}),[posts,roster,cursor,hideInactive,expandBroadcast]);
  const mentionsHeight=useMemo(()=>{
    if(typeof Graph.mentionsMinimumHeight==='function')return Math.max(380,Graph.mentionsMinimumHeight(projection.nodes.length,width));
    return Math.max(380,Graph.minimumHeight(projection.nodes.length,width));
  },[projection.nodes.length,width]);
  const points=useMemo(()=>{
    if(graphMode!=='mentions')return new Map();
    return typeof Graph.layoutMentions==='function'?Graph.layoutMentions(projection.nodes,width,mentionsHeight):fallbackLayoutMentions(projection.nodes,width,mentionsHeight);
  },[graphMode,projection.nodes,width,mentionsHeight]);

  useSafeLayoutEffect(()=>{
    if(graphMode!=='mentions')return;
    const next=new Map();
    let changed=false;
    for (const node of projection.nodes) {
      const el=nodeRefs.current.get(node.name);
      if (el&&el.offsetWidth>0&&el.offsetHeight>0) {
        const halfH=el.offsetHeight/2;
        const box={halfW:el.offsetWidth/2,halfH,offsetX:0,offsetY:0,radius:halfH};
        next.set(node.name,box);
        const prev=measuredBoxes?.get(node.name);
        if (!prev||Math.abs(prev.halfW-box.halfW)>0.5||Math.abs(prev.halfH-box.halfH)>0.5) changed=true;
      }
    }
    if (next.size&&(changed||!measuredBoxes||measuredBoxes.size!==next.size)) setMeasuredBoxes(next);
  },[graphMode,projection.nodes,width,narrow]);

  const effectiveBoxes=useMemo(()=>{
    if(graphMode!=='mentions')return null;
    if(measuredBoxes&&measuredBoxes.size===projection.nodes.length)return measuredBoxes;
    const map=new Map();
    for(const node of projection.nodes)map.set(node.name,measuredBoxes?.get(node.name)??pillBox(node,narrow));
    return map;
  },[graphMode,projection.nodes,measuredBoxes,narrow]);

  const routed=useMemo(()=>{
    if(graphMode!=='mentions')return [];
    return Graph.routeEdges(projection,points,{
      variant:'pill',boxes:effectiveBoxes,narrow,marginStart:5,marginEnd:6,obstacleMargin:narrow?14:22,
    });
  },[graphMode,projection,points,effectiveBoxes,narrow]);

  const hoveredPair=hoveredEdge?hoveredEdge.split('>'):null;
  const connectedNodes=useMemo(()=>{
    if (hoveredPair) return new Set(hoveredPair);
    if (!focus) return null;
    const set=new Set([focus]);
    for (const link of projection.links) {
      if (link.from===focus) set.add(link.to);
      if (link.to===focus) set.add(link.from);
    }
    return set;
  },[focus,hoveredEdge,projection.links]);

  const stageHeight=graphMode==='hive'?hiveHeight:mentionsHeight;
  const focusedMember=focus?roster.find(m=>m.name===focus):null;

  async function handleExportGif() {
    if(!posts.length||gifStatus.busy)return;
    const gifApi=(typeof globalThis.HiveGif?.exportGraphReplayGif==='function'?globalThis.HiveGif:null)??Gif;
    if(typeof gifApi?.exportGraphReplayGif!=='function') {
      setGifStatus({busy:false,message:'GIF export is unavailable until the GIF module is bundled.',error:true});
      return;
    }
    setGifStatus({busy:true,message:'Rendering GIF replay…',error:false});
    try {
      const theme=detectTheme(rootRef.current);
      const result=await Promise.resolve(gifApi.exportGraphReplayGif({
        mode:graphMode,posts,members:roster,phase:state.team.phase,
        pacing,speed,hideInactive,expandBroadcast,focus,theme,
        width:Math.max(480,Math.round(width)),height:Math.max(360,Math.round(stageHeight)),
        graph:Graph,bees:Bees,
      }));
      const blob=typeof Blob!=='undefined'&&result?.blob instanceof Blob?result.blob:(result?.bytes&&typeof Blob!=='undefined'?new Blob([result.bytes],{type:'image/gif'}):null);
      if(!blob&&!result?.bytes)throw Error('GIF encoder returned empty data.');
      const slug=(state.team.title||'hive-swarm').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'hive-swarm';
      const filename=slug+'-graph.gif';
      if(blob&&typeof URL.createObjectURL==='function'&&typeof document!=='undefined'&&typeof document.createElement==='function') {
        const url=URL.createObjectURL(blob);
        const link=document.createElement('a');
        link.href=url;link.download=filename;link.style.display='none';
        document.body?.appendChild?.(link);
        link.click?.();
        link.remove?.();
        setTimeout(()=>{try{URL.revokeObjectURL(url);}catch{}},1000);
      }
      setGifStatus({busy:false,message:'Exported '+filename+(result.frameCount?' ('+result.frameCount+' frames)':'')+'.',error:false});
    } catch(error) {
      setGifStatus({busy:false,message:'GIF export failed: '+(error?.message??String(error)),error:true});
    }
  }

  const hiveTone=tone=>{
    if(tone==='done')return 'done';
    if(tone==='working'||tone==='active')return 'working';
    if(tone==='needs'||tone==='stalled'||tone==='blocked')return 'needs';
    return 'waiting';
  };

  return <div ref={rootRef} className="dsh-hive-graph-view">
    <div className="dsh-hive-graph-controls">
      <div className="dsh-hive-replay-row1">
        <div className="dsh-hive-actions dsh-hive-transport">
          <button type="button" aria-label="First post" disabled={!posts.length||index===1} onClick={()=>setPosition(1)}>|‹</button>
          <button type="button" aria-label="Previous post" disabled={index===0} onClick={()=>setPosition(Math.max(0,index-1))}>‹</button>
          <button type="button" aria-label={playing?'Pause replay':'Replay'} disabled={!posts.length} onClick={togglePlay}>{playing?'Ⅱ':'▶'}</button>
          <button type="button" aria-label="Next post" disabled={index>=posts.length} onClick={()=>setPosition(index+1)}>›</button>
        </div>
        <input className="dsh-hive-scrubber" aria-label="Replay through post" type="range" min="0" max={posts.length} value={index} onChange={event=>setPosition(Number(event.target.value))}/>
        <button type="button" className="dsh-hive-live-btn" aria-pressed={replay===null} onClick={()=>{setPlaying(false);setReplay(null);}}>
          <span className="dsh-hive-status-dot" aria-hidden="true"/>Live
        </button>
      </div>
      <div className="dsh-hive-replay-row2">
        <span className="dsh-hive-graph-stat"><strong>{posts.length} posts</strong> over {elapsed}{replay!==null?' · '+index+'/'+posts.length:''}</span>
        <div className="dsh-hive-segmented" role="group" aria-label="Graph view mode">
          <button type="button" aria-pressed={graphMode==='hive'} onClick={()=>selectMode('hive')}>Hive</button>
          <button type="button" aria-pressed={graphMode==='mentions'} onClick={()=>selectMode('mentions')}>Mentions</button>
        </div>
        <div className="dsh-hive-graph-options">
          <label className="dsh-hive-inline-select"><span className="dsh-hive-sr-only">Pacing</span>
            <select aria-label="Pacing" value={pacing} onChange={event=>setPacing(event.target.value)}>
              <option value="even">Even pacing</option>
              <option value="real">Real-time</option>
            </select>
          </label>
          <label className="dsh-hive-inline-select"><span className="dsh-hive-sr-only">Speed</span>
            <select aria-label="Speed" value={speed} onChange={event=>setSpeed(Number(event.target.value))}>
              <option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option>
            </select>
          </label>
          {graphMode==='mentions'?<div className="dsh-hive-graph-toggles">
            <label className="dsh-hive-switch"><input type="checkbox" role="switch" className="dsh-hive-switch-input" checked={hideInactive} onChange={event=>setHideInactive(event.target.checked)}/><span className="dsh-hive-switch-track" aria-hidden="true"/><span>Hide inactive</span></label>
            <label className="dsh-hive-switch"><input type="checkbox" role="switch" className="dsh-hive-switch-input" checked={expandBroadcast} onChange={event=>setExpandBroadcast(event.target.checked)}/><span className="dsh-hive-switch-track" aria-hidden="true"/><span>Expand @all</span></label>
          </div>:null}
          <button type="button" className="dsh-hive-export-gif" disabled={!posts.length||gifStatus.busy} onClick={()=>{void handleExportGif();}}>
            <span aria-hidden="true">⬇</span>{gifStatus.busy?'Exporting…':'Export GIF'}
          </button>
          {state.hasMoreHistory?<button type="button" className="dsh-hive-ghost-btn" disabled={state.historyLoading} onClick={()=>{void controller.loadHistory();}}>Load earlier</button>:null}
        </div>
      </div>
      {gifStatus.message?<p role="status" className={gifStatus.error?'dsh-hive-gif-error':'dsh-hive-secondary'}>{gifStatus.message}</p>:null}
    </div>

    {graphMode==='hive'&&hiveLayout?<>
      <div ref={ref} className="dsh-hive-graph dsh-hive-graph-hive" style={{height:hiveHeight}} role="group" aria-label="Hive cluster graph">
        <svg width="100%" height={hiveHeight} viewBox={'0 0 '+width+' '+hiveHeight} aria-hidden="true">
          <defs>
            <marker id={arrow} markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" refX="8.5" refY="5" orient="auto">
              <path d="M0.5 1.2L9.5 5L0.5 8.8L2.4 5Z" fill="context-stroke"/>
            </marker>
          </defs>
          {hiveLayout.clusters.map(cell=><g key={cell.id} className="dsh-hive-hex-cell" data-tone={hiveTone(cell.tone)}>
            <polygon points={cell.vertices.map(v=>v.x.toFixed(1)+','+v.y.toFixed(1)).join(' ')} className="dsh-hive-hex-poly"/>
            <text x={cell.x} y={cell.y-cell.radius*0.56} textAnchor="middle" className="dsh-hive-hex-title">{cell.label}</text>
            <text x={cell.x} y={cell.y-cell.radius*0.41} textAnchor="middle" className="dsh-hive-hex-count">{cell.count}</text>
          </g>)}
          <g className="dsh-hive-hex-cell" data-role="coordinator" data-tone={hiveTone(hiveLayout.coordinator.model.phase==='done'?'done':hiveLayout.coordinator.model.phase==='stalled'?'needs':'working')}>
            <polygon points={hiveLayout.coordinator.vertices.map(v=>v.x.toFixed(1)+','+v.y.toFixed(1)).join(' ')} className="dsh-hive-hex-poly"/>
            <text x={hiveLayout.coordinator.x} y={hiveLayout.coordinator.y+hiveLayout.coordinator.radius*0.34} textAnchor="middle" className="dsh-hive-hex-title">Coordinator</text>
            <text x={hiveLayout.coordinator.x} y={hiveLayout.coordinator.y+hiveLayout.coordinator.radius*0.50} textAnchor="middle" className="dsh-hive-hex-count">
              {hiveLayout.coordinator.model.doneCount} of {hiveLayout.coordinator.model.totalWorkers} done
            </text>
          </g>
          {(hiveModel?.connectors??[]).map((conn,i)=>{
            const lookup=id=>hiveLayout.cellsById?.get?.(id)??hiveLayout.cellsById?.[id]??(id==='coordinator'?hiveLayout.coordinator:hiveLayout.clusters.find(c=>c.id===id));
            const fromCell=lookup(conn.from),toCell=lookup(conn.to);
            if(!fromCell||!toCell||fromCell===toCell)return null;
            const dx=toCell.x-fromCell.x,dy=toCell.y-fromCell.y,dist=Math.hypot(dx,dy);
            if(dist<2)return null;
            const angle=Math.atan2(dy,dx);
            const shift=conn.kind==='message'?8:conn.kind==='waiting'?-8:0;
            const pad=shift?6:3;
            const dFrom=hexBoundaryDist(fromCell.radius,angle)+pad;
            const dTo=hexBoundaryDist(toCell.radius,angle+Math.PI)+pad;
            if(dFrom+dTo>=dist)return null;
            const nx=-Math.sin(angle),ny=Math.cos(angle);
            const x1=fromCell.x+Math.cos(angle)*dFrom+nx*shift,y1=fromCell.y+Math.sin(angle)*dFrom+ny*shift;
            const x2=toCell.x-Math.cos(angle)*dTo+nx*shift,y2=toCell.y-Math.sin(angle)*dTo+ny*shift;
            return <line key={conn.from+'>'+conn.to+':'+conn.kind+':'+i} x1={x1.toFixed(1)} y1={y1.toFixed(1)} x2={x2.toFixed(1)} y2={y2.toFixed(1)}
              className="dsh-hive-hex-connector" data-kind={conn.kind}
              strokeDasharray={conn.kind==='waiting'?'4 4':undefined}
              markerEnd={conn.kind==='waiting'?'url(#'+arrow+')':undefined}/>;
          })}
        </svg>
        {hiveLayout.clusters.flatMap(cell=>cell.slots.map(slot=>{
          const m=slot.member;
          const active=focus===m.name;
          return <button key={m.name} type="button" className="dsh-hive-hex-bee-btn" data-status={m.status} aria-pressed={active}
            style={{left:slot.x/width*100+'%',top:slot.y,maxWidth:slot.slotWidth}}
            title={'@'+m.name+' · '+(memberLabels[m.status]??m.status)} aria-label={'Inspect @'+m.name+' ('+(memberLabels[m.status]??m.status)+')'}
            onClick={()=>setFocus(active?null:m.name)}>
            <Bee name={m.name} status={m.status} tint={m.tint} muted={m.muted} size="hive"/>
            <span className="dsh-hive-hex-bee-name">{m.name}</span>
          </button>;
        }))}
        <button type="button" className="dsh-hive-hex-coord-btn" aria-pressed={focus==='coordinator'}
          style={{left:hiveLayout.coordinator.x/width*100+'%',top:hiveLayout.coordinator.y-hiveLayout.coordinator.radius*0.14}}
          aria-label="Inspect Coordinator" onClick={()=>setFocus(focus==='coordinator'?null:'coordinator')}>
          <Bee name="coordinator" status={hiveLayout.coordinator.model.phase==='working'?'working':'active'} coordinator size="lg"/>
        </button>
      </div>
      <div className="dsh-hive-graph-legend">
        <span className="dsh-hive-legend-item" data-legend="done">Tasks done</span>
        <span className="dsh-hive-legend-item" data-legend="message">Message just sent</span>
        <span className="dsh-hive-legend-item" data-legend="waiting">Waiting on</span>
      </div>
    </>:<>
      <div ref={ref} className="dsh-hive-graph dsh-hive-graph-mentions" style={{height:mentionsHeight}} role="group" aria-label="Message flow graph">
        <svg width="100%" height={mentionsHeight} viewBox={'0 0 '+width+' '+mentionsHeight} aria-hidden="true">
          <defs>
            <marker id={arrow} markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" refX="8.5" refY="5" orient="auto">
              <path d="M0.5 1.2L9.5 5L0.5 8.8L2.4 5Z" fill="context-stroke"/>
            </marker>
          </defs>
          {routed.map(({link,edge})=>{
            const key=link.from+'>'+link.to;
            const isPulse=Boolean(current&&link.lastSeq===current.seq);
            const isHovered=hoveredEdge===key;
            const related=hoveredEdge?isHovered:(!focus||focus===link.from||focus===link.to);
            const isAccent=isHovered||(isPulse&&related);
            const strokeWidth=Math.min(4.2,1.1+Math.sqrt(link.count)*0.72);
            const showBadge=related&&edge.length>=36&&(link.count>1||isAccent||isHovered);
            const label=String(link.count);
            const pillW=Math.max(18,label.length*7+8);
            return <g key={key} className="dsh-hive-edge-group" data-active={isAccent?'true':undefined}>
              <path d={edge.d} fill="none" stroke="transparent" strokeWidth="14" className="dsh-hive-edge-hit"
                onMouseEnter={()=>setHoveredEdge(key)} onMouseLeave={()=>setHoveredEdge(prev=>prev===key?null:prev)}/>
              <path data-hive-edge={key} d={edge.d} className="dsh-hive-edge" data-active={isAccent?'true':undefined}
                strokeWidth={isAccent?Math.max(2.4,strokeWidth+0.4):strokeWidth} strokeDasharray={link.direct?undefined:'4 4'}
                opacity={related?(isAccent?1:0.72):0.16} markerEnd={'url(#'+arrow+')'}/>
              {isAccent?<polygon className="dsh-hive-edge-tip" points={chevronPoints(edge.end,edge.endAngle)}/>:null}
              {showBadge?<g className="dsh-hive-edge-pill" data-active={isAccent?'true':undefined} transform={'translate('+edge.mid.x.toFixed(1)+','+edge.mid.y.toFixed(1)+')'}>
                <rect x={-pillW/2} y="-8" width={pillW} height="16" rx="8"/>
                <text textAnchor="middle" dominantBaseline="central">{label}</text>
              </g>:null}
            </g>;
          })}
        </svg>
        {projection.nodes.map(node=>{
          const point=points.get(node.name)??{x:width/2,y:mentionsHeight/2};
          const unmentioned=Graph.unmentionedNode(node);
          const isCoordinator=node.role==='coordinator'||node.name==='coordinator';
          const retired=node.status==='retired';
          const muted=!isCoordinator&&['done','retired'].includes(node.status);
          const dimmed=Boolean(connectedNodes&&!connectedNodes.has(node.name));
          return <button key={node.name} ref={el=>{if(el)nodeRefs.current.set(node.name,el);else nodeRefs.current.delete(node.name);}}
            type="button" className="dsh-hive-graph-pill" data-role={isCoordinator?'coordinator':'worker'} data-status={node.status??'observer'}
            data-retired={retired?'true':undefined} data-unmentioned={unmentioned?'true':undefined} data-dimmed={dimmed?'true':undefined}
            style={{left:point.x/width*100+'%',top:point.y}} aria-pressed={focus===node.name}
            title={node.name+' · '+(memberLabels[node.status]??node.status)+(unmentioned?' · Posted with no mention':'')}
            onClick={()=>setFocus(focus===node.name?null:node.name)}>
            <Bee name={node.name} status={node.status} coordinator={isCoordinator} tint={node.tint} muted={muted} size="sm"/>
            <span className="dsh-hive-graph-pill-name">{node.name}</span>
            <span className="dsh-hive-node-dot" aria-hidden="true"/>
            {node.broadcasts?<span className="dsh-hive-node-broadcast">@all {node.broadcasts}</span>:null}
          </button>;
        })}
      </div>
      <div className="dsh-hive-graph-legend">
        <span className="dsh-hive-legend-item" data-legend="mention">@mention, width = count</span>
        <span className="dsh-hive-legend-item" data-legend="broadcast">via @all</span>
        <span className="dsh-hive-legend-item" data-legend="unmentioned">posted with no mention</span>
        <span className="dsh-hive-legend-item" data-legend="all-badge"><span className="dsh-hive-all-badge">@all {projection.broadcasts}</span>@all posts, drawn by Expand @all</span>
      </div>
    </>}

    {focus&&focusedMember?<section className="dsh-hive-selected-post">
      <div className="dsh-hive-line">
        <BeePill member={focusedMember} coordinator={focusedMember.role==='coordinator'||focusedMember.name==='coordinator'} muted={focusedMember.status==='retired'}/>
        <Status value={focusedMember.status}/>
        <div className="dsh-hive-pill-group">
          {ownedSession(focusedMember)?<button type="button" onClick={event=>onJournal(focus,event.currentTarget)}>Inspect @{focus} Journal</button>:null}
          <button type="button" className="dsh-hive-ghost-btn" onClick={()=>setFocus(null)}>Clear</button>
        </div>
      </div>
      {current&&current.author===focus?<RichText text={current.text} onJumpPost={onJumpPost}/>:null}
    </section>:null}

    {current?<section className="dsh-hive-selected-post">
      <div className="dsh-hive-line"><h3>Selected post</h3><strong>{current.author==='system'?'System':'@'+current.author}</strong><PostRef seq={current.seq} onJumpPost={onJumpPost}/></div>
      <RichText text={current.text} onJumpPost={onJumpPost}/>
    </section>:null}

    {graphMode==='mentions'&&(projection.links.length?<ul className="dsh-hive-flow-list" aria-label="Message flow counts">{projection.links.filter(link=>!focus||link.from===focus||link.to===focus).map(link=><li key={link.from+'>'+link.to}>@{link.from} → @{link.to}: {link.count} {link.count===1?'mention':'mentions'}</li>)}</ul>:<p className="dsh-hive-secondary">No directed mentions at this point in the replay.</p>)}
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
  const onOpenSession=async(member,opener)=>{
    const result=await controller.openSession(member,{fallbackToJournal:false});
    if(result==='fallback')onJournal(member,opener);
  };
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

  const boardCount=useMemo(()=>(state.history.length?state.history:(state.team?.events??[])).filter(Graph.isPost).length,[state.history,state.team?.events]);
  const activeMembersCount=useMemo(()=>state.team?state.team.members.filter(m=>m.status!=='retired').length:0,[state.team]);
  const tabCounts={Board:boardCount,Members:activeMembersCount};

  return <div className="dsh-hive" data-dsh-hive-swarm={mode}><style>{styles}</style>
    <header className="dsh-hive-header">
      <div className="dsh-hive-header-top">
        <div className="dsh-hive-title-wrap"><BeeIcon size={20}/><h1>{state.team?.title??'Hive Swarm'}</h1></div>
        {state.team?<Status value={state.team.paused?'paused':state.team.phase} compactView/>:null}
      </div>
      {state.team&&renaming?<form className="dsh-hive-rename" onSubmit={saveTitle}>
        <input aria-label="Swarm title" maxLength="95" required value={titleDraft} onChange={event=>setTitleDraft(event.target.value)}/>
        <button type="submit" disabled={state.pending||!titleDraft.trim()}>Save</button>
        <button type="button" onClick={()=>setRenaming(false)}>Cancel</button>
      </form>:null}
      <div className="dsh-hive-header-actions">
        <select aria-label="Team" value={state.team?.id??''} disabled={state.loading||snapshot.pending} onChange={event=>controller.selectTeam(event.target.value)}>
          <option value="">Choose a team</option>{state.teams.map(team=><option key={team.id} value={team.id}>{team.title} · {team.cwd}</option>)}
        </select>
        {state.team&&!renaming?<button type="button" className="dsh-hive-compact-btn" disabled={state.pending} onClick={()=>{setTitleDraft(state.team.title??'');setRenaming(true);}}>Rename</button>:null}
        <button type="button" className="dsh-hive-compact-btn" disabled={state.loading} onClick={controller.refresh}>Refresh</button>
        {state.team?<button type="button" className="dsh-hive-compact-btn" disabled={state.pending} onClick={()=>act(controller,state.team.paused?'resume_team':'pause_team')}>{state.team.paused?'Resume':'Pause'}</button>:null}
        {onExpand?<button type="button" className="dsh-hive-compact-btn" aria-label="Open full view" onClick={()=>onExpand(controller)}>Open full view</button>:null}
      </div>
      {(state.loading||state.connection==='disconnected'||snapshot.pending||!state.team)?<p className="dsh-hive-secondary dsh-hive-context" role="status">{state.loading?'Loading Swarm…':state.connection==='disconnected'?'Disconnected · refresh to reconnect':snapshot.pending?'Saving action…':state.workspace??'Teams in the Host’s permitted workspace scope'}</p>:null}
    </header>
    {state.error?<ErrorNotice error={state.error} controller={controller}/>:null}
    {!state.team?<Empty title={state.loading?'Loading teams…':state.teams.length?'Choose a team':'No teams in this workspace'}>
      {state.loading?'Reading the native Host.':state.teams.length?'Select a team to inspect its work. Opening Swarm does not start workers.':'Create a team through /hive-swarm in an authorized parent session, then refresh.'}
    </Empty>:<>
      <nav role="tablist" aria-label="Swarm views" className="dsh-hive-tabs">{VIEWS.map((title,index)=><button key={title} ref={node=>{tabRefs.current[index]=node;}} type="button" role="tab"
        id={prefix+'-tab-'+title} aria-controls={prefix+'-panel-'+title} aria-selected={view===title} tabIndex={view===title?0:-1} onClick={()=>selectView(title)} onKeyDown={event=>keyTab(event,index)}>
        {title}{Object.hasOwn(tabCounts,title)?<span className="dsh-hive-tab-count">{tabCounts[title]}</span>:null}
      </button>)}</nav>
      <section role="tabpanel" tabIndex="0" id={prefix+'-panel-'+view} aria-labelledby={prefix+'-tab-'+view} className="dsh-hive-content">
        {view==='Overview'?<Overview state={state} controller={controller} onJournal={onJournal} onJumpPost={onJumpPost} onMention={onMention}/>:
          view==='Board'?<Board key={state.team.id} state={state} controller={controller} focusedSeq={focusedSeq} onClearFocus={()=>setFocusedSeq(null)} mentionRequest={mentionRequest} onConsumeMention={()=>setMentionRequest(null)} onJumpPost={onJumpPost}/>:
          view==='Members'?<Members key={state.team.id} state={state} controller={controller} onJournal={onJournal} onOpenSession={onOpenSession} onMention={onMention}/>:
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
