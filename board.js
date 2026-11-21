(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const graph=globalThis.HiveGraph;
  const standalone=parent===window;
  const emptyPanel=standalone && location.pathname==='/swarm';
  const tabs=['overview','board','members','graph'];
  const GRAPH_MODE_KEY='hive-swarm-graph-mode';
  const states={queued:'Queued',working:'Working',waiting:'Waiting',done:'Done',failed:'Failed',
    quota:'Quota limit',retired:'Retired',observer:'Observer'};
  const executionModes={subagent:'Subagent',attached:'Attached',session:'Session'};
  const turnStates={completed:'Completed',inProgress:'Running',interrupted:'Interrupted',failed:'Failed'};
  const phases={working:'Live',queued:'Queued',paused:'Paused',done:'Done',
    stalled:'Needs you',budget:'Turn limit',retired:'Retired'};
  const authors={user:'You',system:'System',coordinator:'@coordinator'};
  const time=new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit'});
  const posts=new Map();
  const pending=new Map();
  const liveSlots=new Map();
  const nowSlots=new Map();
  const memberDrafts=new Map();
  const threadOpenState=new Map();
  let teamId=standalone&&!emptyPanel?location.pathname.split('/').at(-1):null;
  let team,signature='',rosterKey='',feedKey='',activeTab='board',chronology=[],latestByAuthor=new Map();
  let historyTail=0,historyRequest,refreshing=false,following=true,seen=0,feedLimit=160;
  let recentTeams=[],teamListKey='',loadingTeams=false,channelKey='',memberKey='';
  let stream,streamOnline=false,modelCatalog,titleEditing=false,transcript,lightbox,extendingBudget=false;
  let requestNumber=0,refreshTimer,playTimer,playing=false,cursor=null,focusedNode=null,graphFrame=0;
  let graphMode=loadGraphMode(),exportingGif=false;

  function loadGraphMode() {
    try {
      const saved=globalThis.sessionStorage?.getItem?.(GRAPH_MODE_KEY);
      if (saved==='hive'||saved==='mentions') return saved;
    } catch {}
    return 'hive';
  }
  function saveGraphMode(mode) {
    try { globalThis.sessionStorage?.setItem?.(GRAPH_MODE_KEY,mode); } catch {}
  }
  function currentTheme() {
    return document.documentElement.dataset.theme==='light'?'light':'dark';
  }

  function node(tag,kind='',text) {
    const element=document.createElement(tag);
    if (kind) element.className=kind;
    if (text!=null) element.textContent=text;
    return element;
  }
  function author(name) {return Object.hasOwn(authors,name)?authors[name]:'@'+name;}
  function condition(member) {return member.retireAfterTurn?'Retiring after turn':states[member.status]??member.status;}
  function modeBadge(member) {
    if (!member?.executionMode || !Object.hasOwn(executionModes,member.executionMode)) return null;
    const pill=node('span','mode-badge',executionModes[member.executionMode]);
    pill.dataset.mode=member.executionMode;
    if (member.subagentName) pill.title='Subagent: '+member.subagentName;
    return pill;
  }
  function notice(text='',error=false) {
    $('notice').textContent=text;
    $('notice').dataset.error=String(error);
  }
  function postReference(seq) {
    const button=node('button','post-reference','#'+seq);
    button.type='button';
    button.setAttribute('aria-label','Jump to post #'+seq);
    button.onclick=()=>{
      if (transcript) closeTranscript();
      if (lightbox) closeLightbox();
      return jumpToPost(seq);
    };
    return button;
  }
  function safeLink(label,destination) {
    try {
      const url=new URL(destination);
      if (!['http:','https:'].includes(url.protocol)) return;
      const link=node('a','',label);
      link.href=url.href;
      link.target='_blank';
      link.rel='noopener noreferrer';
      return link;
    } catch {}
  }
  function safeAssetUrl(destination) {
    const raw=String(destination??'').trim();
    if (!raw) return '';
    if (raw.startsWith('/')&&!raw.startsWith('//')) return raw;
    try {
      const url=new URL(raw,location?.origin||'http://127.0.0.1');
      if (['http:','https:'].includes(url.protocol)&&(!location?.origin||url.origin===location.origin)) return url.href;
    } catch {}
    return '';
  }
  function chevronIcon() {
    if (typeof document.createElementNS!=='function') {
      const span=node('span','accordion-chevron','▾');
      span.setAttribute('aria-hidden','true');
      return span;
    }
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('class','accordion-chevron');
    svg.setAttribute('width','14');
    svg.setAttribute('height','14');
    svg.setAttribute('viewBox','0 0 16 16');
    svg.setAttribute('aria-hidden','true');
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d','M4 6l4 4 4-4');
    path.setAttribute('fill','none');
    path.setAttribute('stroke','currentColor');
    path.setAttribute('stroke-width','1.6');
    path.setAttribute('stroke-linecap','round');
    path.setAttribute('stroke-linejoin','round');
    svg.append(path);
    return svg;
  }
  function inlineText(target,value) {
    let offset=0;
    const tokens=/\x60([^\x60\n]+)\x60|\*\*([^\n]+?)\*\*|\*([^*\n]+)\*|\[([^\]\n]+)\]\(([^\s)]+)\)|\[(done|stall)\]|(?<![a-z0-9_])(@#?[a-z][a-z0-9_-]*|#[1-9]\d*\b)/gi;
    for (const match of value.matchAll(tokens)) {
      if (offset<match.index) target.append(document.createTextNode(value.slice(offset,match.index)));
      if (match[1]) target.append(node('code','',match[1]));
      else if (match[2]||match[3]) {
        const format=node(match[2]?'strong':'em');
        inlineText(format,match[2]??match[3]);
        target.append(format);
      } else if (match[4]) target.append(safeLink(match[4],match[5])??document.createTextNode(match[0]));
      else if (match[6]) {
        const badge=node('span','post-badge',match[0]);
        badge.dataset.badge=match[6].toLowerCase();
        target.append(badge);
      } else if (match[0].startsWith('@')) target.append(node('span','mention',match[0]));
      else {
        const seq=Number(match[0].slice(1));
        target.append(Number.isSafeInteger(seq)?postReference(seq):document.createTextNode(match[0]));
      }
      offset=match.index+match[0].length;
    }
    if (offset<value.length) target.append(document.createTextNode(value.slice(offset)));
  }
  function textBlocks(target,value) {
    let paragraph=[];
    let list;
    const flush=()=>{
      if (!paragraph.length) return;
      const block=node('p');
      inlineText(block,paragraph.join('\n'));
      target.append(block);
      paragraph=[];
    };
    for (const line of value.split(/\r?\n/)) {
      const heading=/^ {0,3}(#{1,3})\s+(.+)$/.exec(line);
      const entry=/^ {0,3}([-*+]|\d+[.)])\s+(.+)$/.exec(line);
      if (heading) {
        flush();
        list=null;
        const title=node('h'+(2+heading[1].length));
        inlineText(title,heading[2]);
        target.append(title);
      } else if (entry) {
        flush();
        const ordered=/^\d/.test(entry[1]);
        const type=ordered?'OL':'UL';
        if (list?.tagName.toUpperCase()!==type) {
          list=node(type.toLowerCase(),'post-list');
          if (ordered) list.start=Number.parseInt(entry[1],10);
          target.append(list);
        }
        const item=node('li');
        inlineText(item,entry[2]);
        list.append(item);
      } else {
        list=null;
        if (line.trim()) paragraph.push(line);
        else flush();
      }
    }
    flush();
  }
  function richText(target,text) {
    const value=String(text??'');
    target.replaceChildren();
    let offset=0;
    const fences=/^[ \t]*\x60{3}[^\r\n\x60]*\r?\n([\s\S]*?)^[ \t]*\x60{3}[ \t]*\r?$/gm;
    for (const match of value.matchAll(fences)) {
      textBlocks(target,value.slice(offset,match.index));
      const block=node('pre');
      block.append(node('code','',match[1].replace(/\r?\n$/,'')));
      target.append(block);
      offset=match.index+match[0].length;
    }
    textBlocks(target,value.slice(offset));
  }
  function stamp(event) {
    return '#'+event.seq+(event.time?' · '+time.format(new Date(event.time)):'');
  }
  function beeSprite(member,{muted=false}={}) {
    return HiveBee.sprite(member.name,{
      status:member.status??'observer',
      coordinator:member.role==='coordinator',
      tint:member.tint,
      muted,
    });
  }
  function bee(member,compact=false) {
    const tile=node('span','bee-tile'+(compact?' compact':''));
    tile.dataset.status=member.status??'observer';
    tile.append(beeSprite(member));
    return tile;
  }
  function beeTint(member) {
    if (typeof HiveBee?.tintStyle==='function') {
      return HiveBee.tintStyle(member.name,member.role==='coordinator',member.tint);
    }
    const palette=[
      ['#efac37','#ffe18d','#bb641d'],['#75baef','#cdefff','#3974bb'],
      ['#55cbb2','#b8f8df','#268c7d'],['#e68db3','#ffcee2','#a24275'],
      ['#b3ce64','#e9f6a1','#6c9137'],['#ad9ce8','#e3d4ff','#6d58af'],
    ];
    const [base,highlight,shade]=typeof HiveBee?.colors==='function'
      ? HiveBee.colors(member.name,member.role==='coordinator',member.tint)
      : (member.role==='coordinator'?palette[0]:palette[1+((member.tint??0)%(palette.length-1))]);
    return {
      base,highlight,shade,
      bg:'color-mix(in oklab, '+base+' 14%, var(--surface))',
      border:'color-mix(in oklab, '+base+' 40%, var(--line))',
      text:'var(--ink)',
    };
  }
  function beePill(member,{clickable=true}={}) {
    const canJournal=standalone&&chatUrl(member.threadId);
    const canMention=!member.external&&member.status!=='retired'&&!member.retireAfterTurn;
    const interactive=clickable&&(canJournal||canMention);
    const pill=node(interactive?'button':'span','bee-pill');
    if (interactive) {
      pill.type='button';
      pill.setAttribute('aria-label',canJournal?'View journal for '+author(member.name):'Mention '+author(member.name));
      pill.onclick=()=>{
        if (canJournal) return openTranscript(member,pill);
        return mentionMember(member.name);
      };
    }
    const palette=beeTint(member);
    if (pill.style?.setProperty) {
      pill.style.setProperty('--pill-bg',palette.bg);
      pill.style.setProperty('--pill-border',palette.border);
      pill.style.setProperty('--pill-ink',palette.text);
    }
    pill.append(beeSprite(member,{muted:member.status==='retired'}),node('span','bee-pill-name',member.name));
    return pill;
  }
  function smartTaskLabel(member) {
    if (typeof graph.smartTaskLabel==='function') return graph.smartTaskLabel(member);
    const explicit=String(member?.taskLabel??'').trim();
    if (explicit) return explicit.slice(0,96);
    let raw=String(member?.brief??'').trim();
    if (!raw) return member?.name??'Task';
    raw=raw.replace(/\[([^\]]+)\]\([^)]+\)/g,'$1')
      .replace(/[`*_#]/g,' ')
      .replace(/\s+/g,' ')
      .trim();
    const sentences=raw.split(/(?<!\d)(?<=[.!?])\s+|\r?\n/).filter(Boolean);
    if (sentences.length>1&&/^(?:you are|act as|your role|member)\b/i.test(sentences[0])) {
      raw=sentences.slice(1).join(' ');
    } else {
      raw=raw.replace(/^you are(?:\s+an?)?(?:\s+hive swarm)?(?:\s+member|\s+agent|\s+worker)?(?:\s+@?[a-z0-9_-]+)?(?:\s*\([^)]*\))?(?:\s+for\s+(?:[^.,:;]|\d\.\d)+)?[.,:;\s-]*/i,'');
    }
    raw=raw.replace(/^(?:your\s+(?:assignment|mission|role|task)(?:\s+in\s+[^:]+)?|you\s+own|mission|goal|objective)\s*[:—–-]?\s*/i,'');
    raw=raw.replace(/\s+(?:in|inside|at)\s+(?:[a-z]:\\|\/)[^\s,;]+/gi,'').trim();
    const firstSentence=raw.split(/(?<!\d)(?<=[.!?])\s+|\r?\n/)[0]?.trim()||raw;
    let label=firstSentence.replace(/[.:;,\s]+$/,'').trim();
    if (label.length>64) {
      const cut=label.slice(0,64);
      const lastSpace=cut.lastIndexOf(' ');
      label=(lastSpace>24?cut.slice(0,lastSpace):cut).trim();
    }
    label=label.replace(/\s+(?:for|in|on|with|to|of|and|or|the|a|an|at|by|from)$/i,'').trim();
    return label||(member?.name??'Task');
  }
  function people() {
    const members=team.members.some(member=>member.role==='coordinator')?team.members:[
      {name:'coordinator',role:'coordinator',status:'observer',model:team.model,effort:team.effort,
        brief:'Starter chat',waitFor:[],external:true},...team.members,
    ];
    let tint=0;
    return members.map(member=>member.role==='coordinator'?member:{...member,tint:tint++});
  }

  function acceptPosts(items) {
    let changed=false;
    for (const item of items??[]) {
      if (!Number.isSafeInteger(item.seq) || posts.has(item.seq)) continue;
      posts.set(item.seq,item);
      changed=true;
    }
    if (changed) {
      chronology=[...posts.values()].sort((a,b)=>a.seq-b.seq);
      latestByAuthor=new Map(chronology.filter(post=>post.kind!=='brief'&&post.author!=='system').map(post=>[post.author,post]));
    }
    return changed;
  }

  function acceptStatus(value) {
    if (!value?.id || !Array.isArray(value.members)) return;
    if (team?.id && team.id!==value.id) {
      if (transcript) closeTranscript();
      if (lightbox) closeLightbox();
      posts.clear();
      chronology=[];
      latestByAuthor.clear();
      threadOpenState.clear();
      historyTail=seen=0;
      cursor=focusedNode=null;
      memberDrafts.clear();
      $('overview-brief-details').open=false;
      $('overview-tasks-accordion').open=false;
      memberKey=channelKey=rosterKey=feedKey='';
    }
    team=value;
    teamId=value.id;
    const {activity,...snapshot}=value;
    const key=JSON.stringify(snapshot);
    const changed=acceptPosts(value.events);
    if (key!==signature || changed) {
      signature=key;
      render();
    } else renderActivity();
  }

  function updateOptions(roster) {
    updateChannels();
    const keys=roster.map(member=>member.name).join(',');
    if (keys===rosterKey) return;
    rosterKey=keys;
    const selector=$('member-filter');
    const selected=selector.value;
    selector.replaceChildren(new Option('All members',''),...roster.map(member=>new Option(author(member.name),member.name)));
    if (roster.some(member=>member.name===selected)) selector.value=selected;
  }

  function updateChannels() {
    const channels=team.channels??[{name:'main'}];
    const key=JSON.stringify(channels);
    if (key===channelKey) return;
    channelKey=key;
    const filter=$('channel-filter');
    const selected=filter.value;
    filter.replaceChildren(new Option('All channels',''),...channels.map(channel=>
      new Option('#'+channel.name+(channel.archived?' · Archived':''),channel.name)));
    filter.value=channels.some(channel=>channel.name===selected)?selected:'';
    const composer=$('composer-channel');
    const previous=composer.value;
    const available=channels.filter(channel=>!channel.archived);
    composer.replaceChildren(...available.map(channel=>new Option('#'+channel.name,channel.name)));
    composer.value=available.some(channel=>channel.name===previous)?previous:'main';
    composer.hidden=available.length<2;
  }

  function render() {
    if (!team) return;
    const roster=people();
    updateOptions(roster);
    $('title').textContent=team.title;
    $('edit-title').hidden=!standalone||titleEditing;
    $('meta').textContent=[team.cwd,team.model,team.effort].filter(Boolean).join(' · ');
    const phase=team.phase??(team.paused?'paused':'working');
    $('phase').dataset.phase=phase;
    $('phase-label').textContent=phases[phase]??phase;
    $('phase').hidden=$('metrics').hidden=$('navigation').hidden=false;
    $('active-count').textContent=team.members.filter(member=>member.status==='working').length;
    $('waiting-count').textContent=team.members.filter(member=>['queued','waiting','quota'].includes(member.status)).length;
    $('turn-count').textContent=team.turns+'/'+team.turnLimit;
    $('post-count').textContent=chronology.filter(graph.isPost).length;
    $('roster-count').textContent=roster.filter(member=>member.status!=='retired').length;
    $('pause').textContent=team.paused?'Resume':'Pause';
    $('extra-turns').hidden=phase!=='budget';
    renderTeamPicker();
    $('panel-'+activeTab).hidden=false;
    if (activeTab==='board') {
      renderFeed(roster);
      renderBoardActivity();
      const live=roster.filter(member=>member.status!=='retired');
      $('side-members').replaceChildren(...live.map(member=>{
        const item=node('li','side-item');
        const details=node('div');
        details.append(node('strong','',author(member.name)),node('small','',condition(member)));
        item.append(bee(member,true),details);
        return item;
      }));
      const retired=roster.length-live.length;
      $('aside-total').textContent=retired?retired+' retired':'';
      $('aside-total').hidden=!retired;
    } else if (activeTab==='overview') renderOverview(roster);
    else if (activeTab==='members') renderMembers(roster);
    else scheduleGraph();
    syncTranscript();
  }

  function matchingPosts() {
    const filter=$('member-filter').value;
    const channel=$('channel-filter').value;
    const query=$('search-posts').value.trim().toLowerCase();
    const matching=chronology.filter(event=>(!channel||(event.channel??'main')===channel)&&
      (!filter||event.author===filter||event.targets?.includes(filter))&&
      (!query||[event.text,author(event.author),...(event.targets??[])].join(' ').toLowerCase().includes(query)));
    return {filter,channel,query,matching};
  }

  function renderFeed(roster=people()) {
    const {filter,channel,query,matching}=matchingPosts();
    if (following) seen=chronology.at(-1)?.seq??0;
    const key=JSON.stringify([team.id,filter,channel,query,following,feedLimit,matching.map(event=>event.seq)]);
    if (key===feedKey) return;
    feedKey=key;
    const feed=$('feed');
    const scroll=feed.scrollTop;
    const items=[];
    if (matching.length>feedLimit) {
      const previous=node('li','empty');
      const button=node('button','','Load earlier posts');
      button.type='button';
      button.onclick=()=>{
        feedLimit+=160;
        renderFeed();
      };
      previous.append(button);
      items.push(previous);
    }
    let divider=false;
    for (const event of matching.slice(-feedLimit)) {
      if (!following && !divider && event.seq>seen && graph.isPost(event)) {
        items.push(node('li','entry-divider','New posts'));
        divider=true;
      }
      const entry=node('li','post'+(event.author==='system'?' system':''));
      entry.tabIndex=-1;
      entry.dataset.kind=event.kind??'message';
      entry.dataset.seq=event.seq;
      const member=roster.find(item=>item.name===event.author)??{name:event.author,status:'observer'};
      const line=node('div','post-top');
      const who=node('div');
      who.append(node('strong','',author(event.author)));
      if (event.channel&&event.channel!=='main') who.append(node('span','channel-tag','#'+event.channel));
      if (event.targets?.length) who.append(node('span','targets','→ '+event.targets.map(author).join(' ')));
      line.append(who,node('span','stamp',stamp(event)));
      const content=node('div');
      const message=node('div','message');
      richText(message,event.text);
      content.append(line,message);
      entry.append(bee(member,true),content);
      items.push(entry);
    }
    if (!items.length) items.push(node('li','empty',query||filter||channel?'No matching posts.':'No posts yet.'));
    feed.replaceChildren(...items);
    feed.scrollTop=following?feed.scrollHeight:scroll;
  }

  async function jumpToPost(seq) {
    const id=teamId;
    try {
      await syncHistory();
      if (teamId!==id) return;
      if (!posts.has(seq)) {
        const page=await call('board_history',{after:seq-1,limit:1});
        if (teamId!==id) return;
        acceptPosts(page.posts);
      }
      if (!posts.has(seq)) throw Error('Post #'+seq+' not found.');
      let {matching}=matchingPosts();
      if (!matching.some(event=>event.seq===seq)) {
        $('search-posts').value=$('member-filter').value=$('channel-filter').value='';
        matching=chronology;
      }
      const needed=matching.length-matching.findIndex(event=>event.seq===seq);
      feedLimit=Math.max(feedLimit,Math.ceil(needed/160)*160);
      following=false;
      $('follow').setAttribute('aria-pressed','false');
      selectTab('board');
      const entry=$('feed').querySelector('[data-seq="'+seq+'"]');
      entry?.focus({preventScroll:true});
      entry?.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'});
      notice();
    } catch (error) {
      notice(error.message,true);
    }
  }

  function renderActivitySlot(slot,activity) {
    const lines=(activity?.steps??[]).slice(-3).map(step=>node('li','',''+step.label+(step.detail?' · '+step.detail:'')));
    const items=[];
    if (lines.length) {
      const steps=node('ul','live-steps');
      steps.append(...lines);
      items.push(steps);
    }
    if (activity?.draft) items.push(node('pre','live-draft',activity.draft));
    slot.replaceChildren(...items);
    slot.hidden=!items.length;
  }

  function activitySlot(member) {
    const slot=node('div','member-live');
    liveSlots.set(member.name,slot);
    renderActivitySlot(slot,team.activity?.[member.name]);
    return slot;
  }

  function renderBoardActivity() {
    const working=team.members.filter(member=>member.status==='working');
    $('board-live').hidden=!working.length;
    $('board-live-list').replaceChildren(...working.map(member=>{
      const row=node('li','live-row');
      const slot=node('div');
      renderActivitySlot(slot,team.activity?.[member.name]);
      row.append(node('strong','',author(member.name)),slot);
      return row;
    }));
  }

  function renderActivity() {
    if (!team) return;
    if (activeTab==='board') renderBoardActivity();
    if (activeTab==='overview'||activeTab==='members') {
      for (const [name,slot] of liveSlots) renderActivitySlot(slot,team.activity?.[name]);
    }
    if (activeTab==='overview') {
      for (const member of team.members) {
        const slot=nowSlots.get(member.name);
        if (slot) slot.textContent=memberNow(member);
      }
    }
    syncTranscript();
  }

  function chatUrl(threadId) {
    if (/^[a-z0-9_-]{10,90}$/i.test(threadId??'')) return 'codex://threads/'+encodeURIComponent(threadId);
    return '';
  }

  function openTranscript(member,opener) {
    if (!standalone||!chatUrl(member.threadId)) return;
    transcript={name:member.name,threadId:member.threadId,status:member.status,opener};
    $('transcript-title').textContent='Journal · '+author(member.name);
    $('transcript-turns').replaceChildren();
    $('member-transcript').showModal();
    syncTranscript();
    return refreshTranscript();
  }

  function transcriptButton(member) {
    if (!standalone || !chatUrl(member.threadId)) return null;
    const button=node('button','link-button','View journal');
    button.type='button';
    button.setAttribute('aria-label','View journal for '+author(member.name));
    button.onclick=()=>openTranscript(member,button);
    return button;
  }

  function closeTranscript() {
    const previous=transcript;
    if (!previous) return;
    transcript=null;
    previous.request?.abort();
    $('member-transcript').close();
    (previous.opener?.isConnected?previous.opener:$('tab-'+activeTab)).focus({preventScroll:true});
  }

  function openLightbox(shot,opener) {
    const src=safeAssetUrl(shot.url);
    if (!src) return;
    lightbox={shot,opener};
    $('lightbox-caption').textContent=shot.caption||'Screenshot';
    $('lightbox-meta').textContent=[author(shot.author),shot.seq?'#'+shot.seq:''].filter(Boolean).join(' · ');
    const img=$('lightbox-image');
    img.src=src;
    img.alt=shot.caption||'Screenshot';
    const actions=$('lightbox-actions');
    actions.replaceChildren();
    if (shot.seq) actions.append(postReference(shot.seq));
    $('screenshot-lightbox').showModal();
  }

  function closeLightbox() {
    const previous=lightbox;
    if (!previous) return;
    lightbox=null;
    $('screenshot-lightbox').close();
    (previous.opener?.isConnected?previous.opener:$('tab-'+activeTab)).focus({preventScroll:true});
  }

  function syncTranscript() {
    if (!transcript) return;
    const member=team.members.find(entry=>entry.name===transcript.name);
    if (!member || !chatUrl(member.threadId)) return closeTranscript();
    const working=member.status==='working';
    const changedChat=transcript.threadId!==member.threadId;
    const settled=transcript.status==='working'&&!working;
    transcript.threadId=member.threadId;
    transcript.status=member.status;
    $('transcript-member-status').textContent=condition(member);
    $('transcript-chat').href=chatUrl(member.threadId);
    $('transcript-live').hidden=!working;
    if (changedChat) $('transcript-turns').replaceChildren();
    if (changedChat || settled) {
      transcript.live=null;
      refreshTranscript();
    }
    if (working) renderActivitySlot($('transcript-activity'),team.activity?.[member.name]??transcript.live);
  }

  async function refreshTranscript() {
    if (!transcript) return;
    const state=transcript;
    state.request?.abort();
    const request=new AbortController();
    state.request=request;
    const status=$('transcript-state');
    const refresh=$('refresh-transcript');
    const current=()=>transcript===state&&!request.signal.aborted;
    status.textContent='Loading journal…';
    status.dataset.error='false';
    refresh.disabled=true;
    try {
      const url=location.pathname+'/member/'+encodeURIComponent(state.name)+'/transcript';
      const response=await fetch(url,{cache:'no-store',signal:request.signal});
      if (!response.ok) throw Error('Could not load journal. Click Refresh to try again.');
      const {turns,live,threadId}=await response.json();
      if (!current()) return;
      if (threadId!==state.threadId) {
        status.textContent='Chat updated. Click Refresh to reload.';
        return;
      }
      state.live=live;
      $('transcript-turns').replaceChildren(...turns.map((turn,index)=>{
        const row=node('li','transcript-turn');
        const heading=node('div','member-top');
        const label=node('span','status-word',turnStates[turn.status]??turn.status);
        label.dataset.status=turn.status;
        heading.append(node('h3','','Turn '+(index+1)),label);
        row.append(heading);
        if (turn.steps.length) {
          const steps=node('ul','transcript-steps');
          steps.append(...turn.steps.map(step=>{
            const text=String(step??'');
            const route=/^Verified route:\s*(.+)$/i.exec(text);
            if (route) {
              const item=node('li','transcript-route');
              item.append(node('span','route-pill','Verified route: '),node('code','',route[1]));
              return item;
            }
            return node('li','',text);
          }));
          row.append(steps);
        }
        if (turn.report) {
          const report=node('div','message');
          richText(report,turn.report);
          row.append(report);
        }
        return row;
      }));
      status.textContent=turns.length?'':'No saved turns yet.';
      syncTranscript();
    } catch {
      if (!current()) return;
      status.textContent='Could not load journal. Click Refresh to try again.';
      status.dataset.error='true';
    } finally {
      if (current()) {
        state.request=null;
        refresh.disabled=false;
      }
    }
  }

  function progressView(name,display,used,total) {
    const bar=$('progress-'+name);
    bar.max=Math.max(total,1);
    bar.value=used;
    $(display).textContent=used+'/'+total;
  }

  function compact(value,max=140) {
    const text=String(value??'').replace(/\s+/g,' ').trim();
    return text.length>max?text.slice(0,max-1).trimEnd()+'…':text;
  }

  function memberNow(member) {
    const latest=latestByAuthor.get(member.name);
    if (member.status==='working') {
      return compact(team.activity?.[member.name]?.steps?.findLast(step=>step.label?.trim())?.label)||
        (member.lastTurn?'Working on turn '+member.lastTurn:'Working on the current turn');
    }
    if (['quota','failed'].includes(member.status)) return compact(latest?.text)||condition(member);
    const waiting=member.pendingWaitFor??member.waitFor;
    if (waiting?.length) return compact('Waiting on '+waiting.map(author).join(', '));
    const done=/\[done\]\s*([^\r\n]+)/i.exec(latest?.text??'');
    if (done) return compact(done[1]);
    if (member.status==='waiting') return 'Waiting for an @mention';
    if (member.status==='queued') return 'Queued for the next turn';
    return compact(latest?.text?.split(/\r?\n/)[0])||condition(member);
  }

  function mentionMember(name) {
    selectTab('board');
    const message=$('message');
    const mentions=message.value.matchAll(/(?:^|[^a-z0-9_])@([a-z][a-z0-9_-]*)/gi);
    if (![...mentions].some(([,value])=>value.toLowerCase()===name)) message.value='@'+name+' '+message.value;
    message.focus();
  }

  function threadState(thread) {
    const members=(thread.members??[]).map(name=>team.members.find(member=>member.name===name)).filter(Boolean);
    if (members.some(member=>member.recoveryRequired||['failed','quota'].includes(member.status))) {
      return {key:'blocked',label:'Blocked',rank:0};
    }
    if (members.some(member=>member.status==='working')) return {key:'active',label:'Active',rank:1};
    if (members.some(member=>member.status==='queued')) return {key:'queued',label:'Queued',rank:2};
    if (members.some(member=>member.status==='waiting')) return {key:'waiting',label:'Waiting',rank:3};
    if (members.length&&members.every(member=>['done','retired'].includes(member.status))) {
      return {key:'done',label:'Done',rank:4};
    }
    return {key:'queued',label:'Queued',rank:2};
  }

  function stateGlyph(member) {
    if (member.recoveryRequired||['failed','quota'].includes(member.status)) return '!';
    if (member.status==='done') return '✓';
    if (member.status==='working') return '●';
    if (member.status==='retired') return '–';
    return '◦';
  }
  function stateKey(member) {
    if (member.recoveryRequired||['failed','quota'].includes(member.status)) return 'failed';
    return member.status??'waiting';
  }

  function attentionItems() {
    const stopped=['stalled','budget'].includes(team.phase);
    const issues=(team.attention??[]).filter(issue=>stopped||['recovery','quota','failed','dependency','cycle'].includes(issue.kind))
      .map(issue=>({...issue}));
    for (const member of team.members) {
      if (member.recoveryRequired&&!issues.some(issue=>issue.kind==='recovery'&&issue.member===member.name)) {
        issues.push({kind:'recovery',member:member.name,
          text:author(member.name)+' · Outcome unconfirmed. Inspect journal, then retry or dismiss.'});
      } else if (['quota','failed'].includes(member.status)&&!member.recoveryRequired&&
        !issues.some(issue=>issue.kind===member.status&&issue.member===member.name)) {
        issues.push({kind:member.status,member:member.name,text:author(member.name)+' · '+condition(member)});
      }
    }
    if (team.phase==='budget'&&!issues.some(issue=>issue.kind==='budget')) {
      issues.push({kind:'budget',text:'Turn limit reached ('+team.turns+'/'+team.turnLimit+'). Add 8 turns to continue.'});
    } else if (team.phase==='stalled'&&!issues.length) {
      const diagnostic=chronology.findLast(event=>event.kind==='monitor');
      const waiting=team.members.find(member=>member.status==='waiting'&&member.waitFor?.length);
      issues.push({kind:waiting?'dependency':'waiting',member:waiting?.waitFor[0],
        text:diagnostic?.text.replace(/^\[stall\]\s*/,'')??(waiting?
          author(waiting.name)+' is waiting on '+waiting.waitFor.map(author).join(', '):'The team is waiting for an @mention.')});
    }
    for (const member of team.members) {
      if (member.workspace&&(member.status==='retired'||team.phase==='done')) {
        issues.push({kind:'worktree',member:member.name,text:author(member.name)+' has a worktree to clean.'});
      }
    }
    const rank={recovery:0,quota:0,failed:0,budget:0,unaddressed:1,mention:1,waiting:1,dependency:2,cycle:2,worktree:3};
    return issues.map(issue=>({...issue,priority:rank[issue.kind]??1})).sort((a,b)=>a.priority-b.priority);
  }

  function attentionRow(issue) {
    const row=node('li','alert-row');
    row.dataset.kind=issue.kind;
    row.dataset.priority=issue.priority;
    row.append(node('span','alert-text',issue.text));
    const actions=node('div','overview-actions');
    if (issue.seq) actions.append(postReference(issue.seq));
    if (issue.kind==='budget') actions.append(trustedButton('+8 turns',extendBudget));
    else if (issue.kind==='recovery'&&issue.member) {
      const target=team.members.find(member=>member.name===issue.member);
      const journal=target?transcriptButton(target):null;
      if (journal) actions.append(journal);
      if (standalone) {
        const busy=target?.status==='working';
        const retry=trustedButton('Retry fresh turn',button=>memberAction(button,'resolve_recovery',{member:issue.member,action:'retry'}),busy);
        retry.setAttribute('aria-label','Retry fresh turn for '+author(issue.member));
        const dismiss=trustedButton('Dismiss',button=>memberAction(button,'resolve_recovery',{member:issue.member,action:'dismiss'}),busy);
        dismiss.setAttribute('aria-label','Dismiss unconfirmed run for '+author(issue.member));
        actions.append(retry,dismiss);
      }
    } else if (issue.kind==='worktree') {
      const button=node('button','link-button','View member');
      button.type='button';
      button.onclick=()=>{
        $('search-members').value=issue.member;
        selectTab('members');
        $('search-members').focus();
      };
      actions.append(button);
    } else {
      const active=team.members.filter(member=>member.status!=='retired'&&!member.retireAfterTurn);
      const coordinator=active.find(member=>member.role==='coordinator');
      const target=issue.kind==='unaddressed'?coordinator??active.find(member=>member.status==='waiting')??active.find(member=>member.name===issue.member):
        active.find(member=>member.name===issue.member)??coordinator;
      if (target) {
        const button=node('button','link-button','Mention '+author(target.name));
        button.type='button';
        button.onclick=()=>mentionMember(target.name);
        actions.append(button);
      }
    }
    if (actions.childElementCount) row.append(actions);
    return row;
  }

  function renderOverview(roster=people()) {
    const members=roster.filter(member=>!member.external);
    const allWorkers=members.filter(member=>member.role!=='coordinator');
    const liveWorkers=allWorkers.filter(member=>member.status!=='retired');
    const doneWorkers=liveWorkers.filter(member=>member.status==='done').length;
    $('overview-intro').hidden=false;
    $('overview-goal').textContent=team.title;
    const goalLine=team.goalLine?.trim()??'';
    $('overview-goal-line').textContent=goalLine;
    $('overview-goal-line').hidden=!goalLine||goalLine===team.title;
    const brief=team.task?.trim()??'';
    const long=brief.length>180||/\n/.test(brief);
    $('overview-brief').textContent=brief;
    $('overview-brief').hidden=long||!brief||brief===team.title;
    $('overview-brief-details').hidden=!long;
    $('overview-brief-full').textContent=brief;

    const tasksTotal=liveWorkers.length;
    const heading=$('overview-tasks-heading');
    heading.replaceChildren(
      node('strong','',doneWorkers+' of '+tasksTotal),
      document.createTextNode(' tasks done')
    );
    const taskIcon=$('overview-tasks-icon');
    const hasBlocked=members.some(member=>member.recoveryRequired||['failed','quota'].includes(member.status));
    const hasWorking=members.some(member=>member.status==='working');
    taskIcon.textContent=tasksTotal>0&&doneWorkers===tasksTotal?'✓':hasBlocked?'!':'•';
    taskIcon.dataset.status=tasksTotal>0&&doneWorkers===tasksTotal?'done':hasBlocked?'failed':hasWorking?'working':'waiting';
    progressView('workers','worker-progress',doneWorkers,tasksTotal);
    progressView('turns','turn-progress',team.turns,team.turnLimit);

    liveSlots.clear();
    nowSlots.clear();
    const taskListMembers=allWorkers.length?allWorkers:members;
    $('overview-members').replaceChildren(...taskListMembers.map(member=>{
      const row=node('li','overview-task-row');
      const icon=node('span','task-state-icon',stateGlyph(member));
      icon.setAttribute('aria-hidden','true');
      icon.dataset.status=stateKey(member);
      const info=node('div','task-row-info');
      info.append(node('span','task-row-title',smartTaskLabel(member)));
      const now=node('p','now-summary',memberNow(member));
      nowSlots.set(member.name,now);
      info.append(now);
      const latest=latestByAuthor.get(member.name);
      const journal=transcriptButton(member);
      if (latest||journal) {
        const actions=node('div','overview-actions');
        if (latest) actions.append(postReference(latest.seq));
        if (journal) actions.append(journal);
        info.append(actions);
      }
      const aside=node('div','task-row-aside');
      aside.append(beePill(member));
      row.append(icon,info,aside);
      return row;
    }));

    const alerts=attentionItems();
    $('overview-alerts').replaceChildren(...alerts.map(attentionRow));
    $('overview-alerts-panel').hidden=!alerts.length;

    const sourceThreads=team.threads?.length
      ? team.threads
      : (taskListMembers.length?[{id:'__tasks__',title:'Tasks',goal:'',members:taskListMembers.map(member=>member.name)}]:[]);
    const threads=sourceThreads.map(thread=>({thread,state:threadState(thread)}))
      .sort((a,b)=>a.state.rank-b.state.rank);
    $('overview-threads').replaceChildren(...threads.map(({thread,state})=>{
      const item=node('li');
      const card=node('details','panel thread-card');
      const threadKey=thread.id??thread.title;
      card.open=threadOpenState.get(threadKey)??true;
      card.ontoggle=()=>{threadOpenState.set(threadKey,card.open);};
      const summary=node('summary','thread-summary');
      const left=node('span','thread-summary-left');
      const dot=node('span','thread-dot');
      dot.dataset.state=state.key;
      dot.setAttribute('aria-hidden','true');
      // Only thread title uses <strong> to keep thread heading structure clear and testable.
      left.append(dot,node('strong','',thread.title),node('span','thread-status-text',state.label));
      const threadMembers=(thread.members??[]).map(name=>roster.find(member=>member.name===name)??{name,status:'queued'});
      const threadDone=threadMembers.filter(member=>['done','retired'].includes(member.status)).length;
      const threadTotal=threadMembers.length;
      const pct=threadTotal?Math.round(threadDone/threadTotal*100):0;
      const right=node('span','thread-progress-wrap');
      const bar=node('span','thread-bar');
      bar.setAttribute('aria-hidden','true');
      const fill=node('span','thread-bar-fill');
      fill.dataset.state=state.key;
      fill.style.width=pct+'%';
      bar.append(fill);
      const chevron=chevronIcon();
      right.append(bar,node('span','thread-fraction mono',threadDone+'/'+threadTotal),chevron);
      summary.append(left,right);
      card.append(summary);

      const body=node('div','thread-body');
      if (thread.goal&&thread.goal!==thread.title) body.append(node('p','thread-goal quiet',thread.goal));
      if (threadMembers.length) {
        const list=node('ul','thread-task-rows');
        list.append(...threadMembers.map(member=>{
          const taskRow=node('li','thread-task-row');
          const icon=node('span','task-state-icon',stateGlyph(member));
          icon.setAttribute('aria-hidden','true');
          icon.dataset.status=stateKey(member);
          taskRow.append(icon,node('span','thread-task-title',smartTaskLabel(member)),beePill(member));
          return taskRow;
        }));
        body.append(list);
      }
      card.append(body);
      item.append(card);
      return item;
    }));
    $('overview-threads-panel').hidden=!threads.length;

    const shots=(Array.isArray(team.screenshots)?team.screenshots:[]).filter(shot=>safeAssetUrl(shot?.url));
    $('overview-screenshots-panel').hidden=!shots.length;
    if (shots.length) {
      $('overview-screenshots-count').textContent=shots.length+(shots.length===1?' capture':' captures');
      $('overview-screenshots').replaceChildren(...shots.map(shot=>{
        const card=node('article','screenshot-card');
        card.setAttribute('role','listitem');
        const thumb=node('button','screenshot-thumb-btn');
        thumb.type='button';
        thumb.setAttribute('aria-label','Preview screenshot: '+(shot.caption||'Capture'));
        const img=node('img');
        img.src=safeAssetUrl(shot.url);
        img.alt=shot.caption||'Screenshot';
        img.loading='lazy';
        img.decoding='async';
        thumb.append(img,node('span','screenshot-caption',shot.caption||'Screenshot'));
        thumb.onclick=()=>openLightbox(shot,thumb);
        const meta=node('div','screenshot-meta');
        const authorMember=roster.find(member=>member.name===shot.author)??{name:shot.author||'user',status:'observer'};
        meta.append(beePill(authorMember,{clickable:false}));
        if (shot.seq) meta.append(postReference(shot.seq));
        card.append(thumb,meta);
        return card;
      }));
    } else $('overview-screenshots').replaceChildren();

    const coordMember=roster.find(member=>member.role==='coordinator')??{name:'coordinator',role:'coordinator',status:'observer'};
    $('overview-team-badge').replaceChildren(beeSprite(coordMember));
    const goalMode=team.coordinator===false||!team.members?.some(member=>member.role==='coordinator');
    $('overview-team-role').textContent='Coordinator';
    $('overview-team-mode').textContent='Goal summary';
    $('overview-team-mode').hidden=!goalMode;

    const summary=$('overview-summary');
    summary.replaceChildren();
    const coordReport=chronology.findLast(event=>event.author==='coordinator'&&event.kind==='message');
    const goalReport=goalMode?chronology.findLast(event=>event.kind==='message'&&(event.author==='user'||/\[done\]/i.test(event.text??''))):null;
    const report=coordReport??goalReport;
    if (report) {
      const body=node('div','message');
      richText(body,report.text);
      summary.append(postReference(report.seq),body);
    }
    summary.hidden=!report;
    $('overview-summary-empty').hidden=Boolean(report);
    const execFacts=[
      team.turns+'/'+team.turnLimit+' turns',
      [team.model,team.effort].filter(Boolean).join(' · '),
      team.fallbackModel?'Fallback: '+team.fallbackModel+(team.fallbackEffort?' · '+team.fallbackEffort:''):'',
      team.cwd,
    ].filter(Boolean).join(' · ');
    $('overview-execution').textContent=execFacts;
    $('overview-execution').hidden=!execFacts;

    const milestones=chronology.filter(event=>['checkpoint','monitor'].includes(event.kind)||/\[done\]/i.test(event.text)).slice(-6).reverse();
    $('overview-milestones').replaceChildren(...milestones.map(event=>{
      const result=node('li','milestone');
      result.append(postReference(event.seq),node('span','',event.text.slice(0,180)));
      return result;
    }));
    $('overview-milestones-panel').hidden=!milestones.length;
  }

  function trustedButton(label, action, disabled=false, style='link-button') {
    const button=node('button',style,label);
    button.type='button';
    button.disabled=disabled;
    button.onclick=event=>{if(event.isTrusted&&!button.disabled) return action(button);};
    return button;
  }

  async function memberAction(button,tool,values) {
    button.disabled=true;
    try {
      acceptStatus(await call(tool,values));
      notice();
      return true;
    } catch (error) {
      notice(error.message,true);
      return false;
    } finally {
      button.disabled=false;
    }
  }

  function getModels() {
    return modelCatalog??=fetch('/swarm/models',{cache:'no-store'}).then(async response=>{
      const data=await response.json();
      if (!response.ok) throw Error(data.error);
      return data.models;
    }).catch(error=>{modelCatalog=null;throw error;});
  }

  function modelEditor(member, draft) {
    const control=node('div','model-editor');
    if (member.status==='working') {
      control.append(trustedButton('Switch model',()=>{},true));
      return control;
    }
    const details=node('details');
    const heading=node('summary','link-button','Switch model');
    const body=node('div');
    details.append(heading,body);
    control.append(details);
    details.open=draft.open;
    let loading=false;
    const prepare=async()=>{
      draft.open=details.open;
      if (!draft.open||loading||body.childElementCount) return;
      loading=true;
      try {
        const models=await getModels();
        const form=node('form','model-form');
        const model=node('select');
        const optional=node('select');
        const modelLabel=node('label','','Model');
        const effortLabel=node('label','','Effort');
        model.setAttribute('aria-label','Model');
        optional.setAttribute('aria-label','Effort');
        const save=node('button','primary','Apply');
        save.type='submit';
        if (!models.length) throw Error('Model list is empty.');
        model.replaceChildren(...models.map(entry=>new Option(entry.label,entry.id)));
        const chosen=draft.model??member.model;
        model.value=models.some(entry=>entry.id===chosen)?chosen:models[0].id;
        const updateEffort=value=>{
          const available=models.find(entry=>entry.id===model.value)?.efforts??[];
          optional.replaceChildren(new Option('Default',''),...available.map(entry=>new Option(entry,entry)));
          optional.value=available.includes(value)?value:'';
        };
        updateEffort(draft.effort??member.effort);
        model.onchange=()=>{draft.model=model.value;draft.effort='';updateEffort('');};
        optional.onchange=()=>{draft.effort=optional.value;};
        const resume=node('input');
        resume.type='checkbox';
        resume.checked=draft.resume===true;
        const resumeLabel=node('label','resume-check');
        resumeLabel.append(resume,document.createTextNode('Resume now'));
        resume.onchange=()=>{draft.resume=resume.checked;};
        modelLabel.append(model);
        effortLabel.append(optional);
        form.append(modelLabel,effortLabel);
        const mayResume=['waiting','failed','quota'].includes(member.status)&&!member.recoveryRequired;
        if (mayResume) form.append(resumeLabel);
        form.append(save);
        form.onsubmit=async event=>{
          event.preventDefault();
          if (!event.isTrusted||save.disabled) return;
          const result=await memberAction(save,'set_member_model',{member:member.name,model:model.value,
            effort:optional.value||null,resume:mayResume&&resume.checked});
          if (result) {
            details.open=false;
            draft.open=false;
            draft.model=draft.effort=draft.resume=undefined;
            memberKey='';
            renderMembers();
          }
        };
        body.append(form);
      } catch (error) {
        notice(error.message,true);
      } finally {loading=false;}
    };
    details.ontoggle=prepare;
    if (draft.open) prepare();
    return control;
  }

  function memberCard(member) {
    const card=node('li','member-card'+(member.role==='coordinator'?' coordinator':''));
    const info=node('div');
    const line=node('div','member-top');
    const badge=node('span','status-word',condition(member));
    badge.dataset.status=member.status;
    const mode=modeBadge(member);
    const pills=node('span','member-pills');
    if (mode) pills.append(mode);
    pills.append(badge);
    line.append(node('h3','member-name',author(member.name)),pills);
    info.append(line);
    if (member.role==='coordinator'&&['stalled','budget'].includes(team.phase)) {
      card.dataset.needsYou='true';
      line.append(node('strong','needs-you','Needs you'));
      const alerts=attentionItems();
      const reason=node('p','needs-reason',(team.phase==='budget'?alerts.find(issue=>issue.kind==='budget'):
        alerts.find(issue=>issue.kind!=='worktree'))?.text);
      info.append(reason);
    }
    const last=latestByAuthor.get(member.name);
    const context=[member.model,member.effort,member.group?'@'+member.group:'',
      ...(member.channels??[]).map(channel=>'#'+channel),member.addedBy?'Invited by '+author(member.addedBy):'',
      last?'#'+last.seq:''].filter(Boolean);
    if (context.length) info.append(node('p','minor member-context',context.join(' · ')));
    const detail=last?.text??member.brief;
    if (detail) {
      const summary=node('p','member-summary',detail);
      summary.title=detail;
      info.append(summary);
    }
    const waiting=member.pendingWaitFor??member.waitFor;
    if (waiting?.length) info.append(node('p','quiet','Waiting on '+waiting.map(author).join(', ')));
    if (member.recoveryRequired) info.append(node('p','needs-reason','Outcome unconfirmed. Inspect journal, then retry or dismiss.'));
    if (member.workspace) info.append(node('code','member-path',member.workspace.cwd));
    else if (member.worktree) info.append(node('p','quiet','Isolated worktree on first turn'));
    const actions=node('div','member-actions');
    let modelControl;
    const url=chatUrl(member.threadId);
    if (url) {
      const link=node('a','','Open chat');
      link.href=url;
      if (!standalone) link.onclick=event=>{
        event.preventDefault();
        rpc('ui/open-link',{url:link.href}).catch(error=>notice(error.message,true));
      };
      actions.append(link);
    }
    const journal=transcriptButton(member);
    if (journal) actions.append(journal);
    if (!member.external && member.status!=='retired' && !member.retireAfterTurn) {
      const send=node('button','link-button','@mention');
      send.type='button';
      send.setAttribute('aria-label','@mention '+author(member.name)+' on board');
      send.onclick=()=>mentionMember(member.name);
      actions.append(send);
    }
    if (standalone&&!member.external) {
      const active=member.status!=='retired'&&!member.retireAfterTurn;
      const draft=memberDrafts.get(member.name)??{};
      memberDrafts.set(member.name,draft);
      if (member.recoveryRequired) {
        const busy=member.status==='working';
        const retry=trustedButton('Retry fresh turn',button=>memberAction(button,'resolve_recovery',{member:member.name,action:'retry'}),busy);
        retry.setAttribute('aria-label','Retry fresh turn for '+author(member.name));
        const dismiss=trustedButton('Dismiss',button=>memberAction(button,'resolve_recovery',{member:member.name,action:'dismiss'}),busy);
        dismiss.setAttribute('aria-label','Dismiss unconfirmed run for '+author(member.name));
        actions.append(retry,dismiss);
      }
      if (active) {
        const retire=node('div','retire-choice');
        const draw=()=>{
          if (draft.confirmRetire) {
            const confirm=trustedButton('Confirm retire',async button=>{
              if (await memberAction(button,'retire_member',{member:member.name})) draft.confirmRetire=false;
            },false,'link-button danger');
            confirm.setAttribute('aria-label','Confirm retire '+author(member.name));
            retire.replaceChildren(confirm,trustedButton('Cancel',()=>{draft.confirmRetire=false;draw();}));
          } else {
            const start=trustedButton('Retire',()=>{draft.confirmRetire=true;draw();});
            start.setAttribute('aria-label','Retire '+author(member.name));
            retire.replaceChildren(start);
          }
        };
        draw();
        actions.append(retire);
        modelControl=modelEditor(member,draft);
      }
      if (member.workspace&&(member.status==='retired'||team.phase==='done')) {
        const clean=trustedButton('Clean worktree',button=>memberAction(button,'remove_worktree',{member:member.name}));
        clean.setAttribute('aria-label','Clean worktree for '+author(member.name));
        actions.append(clean);
      }
    }
    if (actions.childElementCount) info.append(actions);
    if (modelControl) info.append(modelControl);
    if (member.status==='working') info.append(activitySlot(member));
    card.append(bee(member),info);
    return card;
  }

  function renderMembers(roster=people()) {
    const query=$('search-members').value.toLowerCase().trim();
    const visible=roster.filter(member=>!query||[author(member.name),member.group,member.model,condition(member),
      ...(member.channels??[]),member.addedBy]
      .join(' ').toLowerCase().includes(query));
    const key=JSON.stringify([query,team.phase,team.attention,team.turns,team.turnLimit,visible.map(member=>[member,latestByAuthor.get(member.name)?.seq])]);
    if (key===memberKey) {renderActivity();return;}
    memberKey=key;
    liveSlots.clear();
    const groups={
      coordinator:visible.filter(member=>member.role==='coordinator'&&member.status!=='retired'),
      working:visible.filter(member=>member.role!=='coordinator'&&member.status==='working'),
      rest:visible.filter(member=>member.role!=='coordinator'&&!['working','retired'].includes(member.status)),
      retired:visible.filter(member=>member.status==='retired'),
    };
    for (const [name,members] of Object.entries(groups)) {
      $(name+'-group').hidden=!members.length;
      $(name+'-list').replaceChildren(...members.map(memberCard));
    }
    $('working-title').textContent='Working · '+groups.working.length;
    $('rest-title').textContent='Standing by & done · '+groups.rest.length;
    $('retired-title').textContent='Retired · '+groups.retired.length;
    $('member-empty').hidden=visible.length>0;
  }

  /* Fallback graph & GIF helpers when HiveGraph 2.1 / HiveGif are not yet loaded */
  function fallbackProjectHive(events,roster,cursorSeq) {
    const upTo=events.filter(event=>event.seq<=cursorSeq&&graph.isPost(event));
    const lastPost=upTo.at(-1)??null;
    const latestSeqByAuthor=new Map();
    for (const post of upTo) latestSeqByAuthor.set(post.author,post.seq);
    const coordMember=roster.find(member=>member.role==='coordinator')??{name:'coordinator',role:'coordinator',status:'waiting'};
    const workers=roster.filter(member=>member.role!=='coordinator'&&!member.external);
    const buckets={working:[],waiting:[],needs:[],done:[]};
    const memberBucket=new Map();
    for (const member of workers) {
      let bucket='waiting';
      if (member.recoveryRequired||['failed','quota'].includes(member.status)) bucket='needs';
      else if (member.status==='working') bucket='working';
      else if (['done','retired'].includes(member.status)) bucket='done';
      buckets[bucket].push({
        ...member,
        muted:['done','retired'].includes(member.status),
        latestSeq:latestSeqByAuthor.get(member.name)??0,
      });
      memberBucket.set(member.name,bucket);
    }
    const meta={
      working:{label:'Working',tone:'working'},
      waiting:{label:'Waiting',tone:'waiting'},
      needs:{label:'Needs you',tone:'needs'},
      done:{label:'Done',tone:'done'},
    };
    const clusters=['working','waiting','needs','done']
      .filter(id=>buckets[id].length>0)
      .map(id=>({id,label:meta[id].label,tone:meta[id].tone,count:buckets[id].length,members:buckets[id]}));
    const doneCount=buckets.done.length;
    const totalWorkers=workers.length;
    const coordPhase=buckets.needs.length?'stalled':buckets.working.length?'working':
      totalWorkers>0&&doneCount===totalWorkers?'done':'waiting';
    const connectors=[];
    if (buckets.done.length) connectors.push({from:'done',to:'coordinator',kind:'done',label:'Tasks done'});
    if (buckets.needs.length) connectors.push({from:'coordinator',to:'needs',kind:'waiting',label:'Needs you'});
    if (buckets.waiting.some(member=>(member.pendingWaitFor??member.waitFor)?.length)) {
      connectors.push({from:'waiting',to:'coordinator',kind:'waiting',label:'Waiting on'});
    }
    if (lastPost&&(lastPost.targets?.length||coordPhase!=='done')) {
      const from=lastPost.author==='coordinator'?'coordinator':(memberBucket.get(lastPost.author)??'coordinator');
      const target=lastPost.targets?.find(name=>name!==lastPost.author);
      const to=target?(target==='coordinator'?'coordinator':(memberBucket.get(target)??'coordinator')):(from==='coordinator'&&clusters[0]?clusters[0].id:'coordinator');
      if (from!==to) connectors.push({from,to,kind:'message',label:'Message just sent',seq:lastPost.seq});
    }
    return {
      currentSeq:cursorSeq,
      lastPost,
      coordinator:{
        name:coordMember.name,status:coordMember.status,role:'coordinator',
        doneCount,totalWorkers,phase:coordPhase,latestSeq:latestSeqByAuthor.get(coordMember.name)??0,
        tint:coordMember.tint,
      },
      clusters,
      connectors,
    };
  }
  function hexVertices(cx,cy,radius) {
    return Array.from({length:6},(_,k)=>{
      const angle=k*Math.PI/3;
      return {x:cx+radius*Math.cos(angle),y:cy+radius*Math.sin(angle)};
    });
  }
  function fallbackLayoutHive(hiveModel,width,height) {
    const clusters=hiveModel.clusters??[];
    const count=clusters.length;
    const radius=count<=1
      ? Math.max(88,Math.min(120,width*0.25,height*0.225))
      : Math.max(70,Math.min(104,width*0.21,height*0.195));
    const hexH=Math.sqrt(3)*radius;
    const cellsById=new Map();
    let coordPos;
    const clusterLayouts=[];
    if (count===0) {
      coordPos={x:width/2,y:height/2};
    } else if (count===1) {
      const gap=Math.max(12,Math.min(22,height-hexH*2-20));
      const totalH=hexH*2+gap;
      const topY=Math.max(hexH/2+10,(height-totalH)/2+hexH/2);
      const clusterPos={x:width/2,y:topY};
      coordPos={x:width/2,y:topY+hexH+gap};
      clusterLayouts.push({pos:clusterPos,cluster:clusters[0]});
    } else {
      coordPos={x:width/2,y:height*0.64};
      const spreadX=Math.min(width*0.33,radius*2.2);
      const spreadY=Math.min(height*0.34,hexH*1.12);
      clusters.forEach((cluster,idx)=>{
        const angle=-Math.PI+(idx+1)*Math.PI/(count+1);
        clusterLayouts.push({
          pos:{x:width/2+Math.cos(angle)*spreadX,y:coordPos.y+Math.sin(angle)*spreadY},
          cluster,
        });
      });
    }
    const coordinator={
      id:'coordinator',x:coordPos.x,y:coordPos.y,radius,
      vertices:hexVertices(coordPos.x,coordPos.y,radius),
      model:hiveModel.coordinator,
    };
    cellsById.set('coordinator',coordinator);
    const laidOutClusters=clusterLayouts.map(({pos,cluster})=>{
      const items=cluster.members??[];
      const cols=items.length<=2?items.length:items.length<=6?3:4;
      const rows=Math.max(1,Math.ceil(items.length/Math.max(1,cols)));
      const slotW=Math.min(68,(radius*1.58)/Math.max(1,cols));
      const rowGap=rows===1?0:Math.min(48,(hexH*0.56)/Math.max(1,rows));
      const baseY=pos.y+12-((rows-1)*rowGap)/2;
      const slots=items.map((member,idx)=>{
        const row=Math.floor(idx/cols);
        const col=idx%cols;
        const inRow=Math.min(cols,items.length-row*cols);
        const sx=pos.x+(col-(inRow-1)/2)*slotW;
        const sy=baseY+row*rowGap;
        return {member,x:sx,y:sy,slotWidth:slotW,beeScale:1};
      });
      const cell={
        id:cluster.id,label:cluster.label,tone:cluster.tone,count:cluster.count,
        x:pos.x,y:pos.y,radius,vertices:hexVertices(pos.x,pos.y,radius),slots,
      };
      cellsById.set(cluster.id,cell);
      return cell;
    });
    return {width,height,radius,coordinator,clusters:laidOutClusters,cellsById};
  }
  function fallbackHiveMinimumHeight(clusterCount,width) {
    if (clusterCount<=1) return width<440?380:430;
    return width<440?420:460;
  }
  function fallbackLayoutMentions(nodes,width,height) {
    const result=new Map();
    if (!nodes.length) return result;
    if (nodes.length>12||width<320) return graph.layout(nodes,width,height);
    const ordered=[...nodes].sort((a,b)=>(b.role==='coordinator')-(a.role==='coordinator'));
    const topPad=48,bottomPad=48;
    const centerY=(topPad+(height-bottomPad))/2;
    const radiusY=Math.max(54,(height-topPad-bottomPad)/2);
    const sidePad=Math.min(110,Math.max(72,width*0.16));
    const radiusX=Math.max(60,width/2-sidePad);
    if (ordered.length===1) {
      result.set(ordered[0].name,{x:width/2,y:centerY});
      return result;
    }
    ordered.forEach((member,idx)=>{
      const angle=-Math.PI/2+idx*Math.PI*2/ordered.length;
      result.set(member.name,{
        x:width/2+Math.cos(angle)*radiusX,
        y:centerY+Math.sin(angle)*radiusY,
      });
    });
    return result;
  }
  function fallbackPillBox(member,narrow) {
    const len=String(member?.name??'').length;
    const w=Math.max(76,Math.min(narrow?134:180,len*7.1+48));
    return {halfW:w/2,halfH:15,offsetX:0,offsetY:0,radius:15};
  }
  function pillBoxFor(member,narrow) {
    if (typeof graph.layoutMentions==='function'&&typeof graph.nodeBox==='function') {
      return graph.nodeBox(member,{variant:'pill',narrow});
    }
    return fallbackPillBox(member,narrow);
  }
  function clipRayToHex(origin,target,vertices) {
    if (!vertices?.length) return origin;
    const dx=target.x-origin.x,dy=target.y-origin.y;
    let bestT=Infinity;
    for (let i=0;i<vertices.length;i++) {
      const a=vertices[i],b=vertices[(i+1)%vertices.length];
      const ex=b.x-a.x,ey=b.y-a.y;
      const denom=dx*ey-dy*ex;
      if (Math.abs(denom)<1e-6) continue;
      const t=((a.x-origin.x)*ey-(a.y-origin.y)*ex)/denom;
      const u=((a.x-origin.x)*dy-(a.y-origin.y)*dx)/denom;
      if (t>0&&u>=-1e-4&&u<=1+1e-4&&t<bestT) bestT=t;
    }
    return Number.isFinite(bestT)?{x:origin.x+dx*bestT,y:origin.y+dy*bestT}:origin;
  }
  function rayClipHex(fromCell,toCell,offset=0) {
    const angle=Math.atan2(toCell.y-fromCell.y,toCell.x-fromCell.x);
    const nx=-Math.sin(angle),ny=Math.cos(angle);
    const fromPt=offset?{x:fromCell.x+nx*offset,y:fromCell.y+ny*offset}:fromCell;
    const toPt=offset?{x:toCell.x+nx*offset,y:toCell.y+ny*offset}:toCell;
    const start=clipRayToHex(fromPt,toPt,fromCell.vertices);
    const end=clipRayToHex(toPt,fromPt,toCell.vertices);
    return {start,end};
  }
  function drawHexCell(ctx,cell,palette,title,subtitle) {
    ctx.beginPath();
    cell.vertices.forEach((pt,idx)=>idx===0?ctx.moveTo(pt.x,pt.y):ctx.lineTo(pt.x,pt.y));
    ctx.closePath();
    ctx.fillStyle=palette.fill;
    ctx.fill();
    ctx.lineWidth=2;
    ctx.strokeStyle=palette.stroke;
    ctx.stroke();
    ctx.textAlign='center';
    ctx.textBaseline='middle';
    const titleY=cell.id==='coordinator'?cell.y+cell.radius*0.42:cell.y-cell.radius*0.62;
    ctx.fillStyle=palette.ink;
    ctx.font='650 12px var(--sans), system-ui, sans-serif';
    ctx.fillText(title,cell.x,titleY);
    if (subtitle!=null) {
      ctx.fillStyle=palette.muted;
      ctx.font='500 11px var(--sans), system-ui, sans-serif';
      ctx.fillText(String(subtitle),cell.x,titleY+15);
    }
  }
  function drawArrowHead(ctx,end,angle,color) {
    const len=8;
    ctx.fillStyle=color;
    ctx.beginPath();
    ctx.moveTo(end.x,end.y);
    ctx.lineTo(end.x-len*Math.cos(angle-0.45),end.y-len*Math.sin(angle-0.45));
    ctx.lineTo(end.x-(len*0.65)*Math.cos(angle),end.y-(len*0.65)*Math.sin(angle));
    ctx.lineTo(end.x-len*Math.cos(angle+0.45),end.y-len*Math.sin(angle+0.45));
    ctx.closePath();
    ctx.fill();
  }
  function drawHiveCanvas(canvas,hiveLayout,connectors,color) {
    const width=canvas.clientWidth,height=canvas.clientHeight;
    if (!width||!height) return;
    const scale=Math.min(devicePixelRatio||1,2);
    const pw=Math.round(width*scale),ph=Math.round(height*scale);
    if (canvas.width!==pw||canvas.height!==ph) {canvas.width=pw;canvas.height=ph;}
    const ctx=canvas.getContext('2d');
    ctx.setTransform(scale,0,0,scale,0,0);
    ctx.clearRect(0,0,width,height);
    for (const conn of connectors) {
      const fromCell=hiveLayout.cellsById.get(conn.from);
      const toCell=hiveLayout.cellsById.get(conn.to);
      if (!fromCell||!toCell||fromCell===toCell) continue;
      const offset=conn.kind==='message'?8:conn.kind==='waiting'?-8:0;
      const {start,end}=rayClipHex(fromCell,toCell,offset);
      if (Math.hypot(end.x-start.x,end.y-start.y)<1) continue;
      const stroke=conn.kind==='done'?color.good:conn.kind==='message'?color.purple:color.gold;
      ctx.strokeStyle=stroke;
      ctx.lineWidth=conn.kind==='message'?2.2:1.8;
      ctx.setLineDash(conn.kind==='waiting'?[5,4]:[]);
      ctx.beginPath();
      ctx.moveTo(start.x,start.y);
      ctx.lineTo(end.x,end.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (conn.kind==='waiting') drawArrowHead(ctx,end,Math.atan2(end.y-start.y,end.x-start.x),stroke);
    }
    const tonePalette=tone=>{
      if (tone==='done') return {fill:color.goodSoft,stroke:color.good,ink:color.text,muted:color.muted};
      if (tone==='working') return {fill:color.wash,stroke:color.gold,ink:color.text,muted:color.muted};
      if (tone==='needs') return {fill:color.badSoft,stroke:color.bad,ink:color.text,muted:color.muted};
      return {fill:color.paper,stroke:color.link,ink:color.text,muted:color.muted};
    };
    for (const cluster of hiveLayout.clusters) {
      drawHexCell(ctx,cluster,tonePalette(cluster.tone),cluster.label,cluster.count);
    }
    const coordTone=hiveLayout.coordinator.model.phase==='done'?'done':
      hiveLayout.coordinator.model.phase==='stalled'?'needs':'working';
    const doneTotal=hiveLayout.coordinator.model.doneCount+' of '+hiveLayout.coordinator.model.totalWorkers+' done';
    drawHexCell(ctx,hiveLayout.coordinator,tonePalette(coordTone),'Coordinator',doneTotal);
  }
  function drawMentionsCanvas(canvas,projection,coordinates,boxes,focus,highlight,color) {
    const width=canvas.clientWidth,height=canvas.clientHeight;
    if (!width||!height) return;
    const scale=Math.min(devicePixelRatio||1,2);
    const pw=Math.round(width*scale),ph=Math.round(height*scale);
    if (canvas.width!==pw||canvas.height!==ph) {canvas.width=pw;canvas.height=ph;}
    const ctx=canvas.getContext('2d');
    ctx.setTransform(scale,0,0,scale,0,0);
    ctx.clearRect(0,0,width,height);
    ctx.font='600 10px ui-monospace, monospace';
    ctx.textAlign='center';
    ctx.textBaseline='middle';
    const routed=graph.routeEdges(projection,coordinates,{
      variant:'pill',boxes,narrow:width<465,marginStart:5,marginEnd:6,obstacleMargin:width<465?12:20,
    });
    for (const {link,edge} of routed) {
      const {start:a,control:c,end:b,mid,endAngle:angle}=edge;
      const pulse=link.lastSeq===highlight;
      const related=!focus||link.from===focus||link.to===focus;
      const stroke=pulse&&related?color.accent:color.link;
      ctx.globalAlpha=related?(pulse?1:0.78):0.16;
      ctx.strokeStyle=ctx.fillStyle=stroke;
      ctx.lineWidth=Math.min(4.2,1.1+Math.sqrt(link.count)*0.72);
      ctx.lineCap='round';
      ctx.setLineDash(link.direct?[]:[4,4]);
      const inset=Math.min(4.5,edge.length*0.25);
      ctx.beginPath();
      ctx.moveTo(a.x,a.y);
      ctx.quadraticCurveTo(c.x,c.y,b.x-Math.cos(angle)*inset,b.y-Math.sin(angle)*inset);
      ctx.stroke();
      ctx.setLineDash([]);
      drawArrowHead(ctx,b,angle,stroke);
      if (related&&edge.length>=40&&(link.count>1||pulse||focus)) {
        const label=String(link.count);
        const pillW=Math.max(18,label.length*6.5+8);
        ctx.globalAlpha=0.98;
        ctx.fillStyle=color.paper;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(mid.x-pillW/2,mid.y-7.5,pillW,15,7.5);
        else ctx.rect(mid.x-pillW/2,mid.y-7.5,pillW,15);
        ctx.fill();
        ctx.strokeStyle=pulse?color.accent:color.link;
        ctx.lineWidth=1;
        ctx.stroke();
        ctx.fillStyle=pulse?color.accent:color.text;
        ctx.fillText(label,mid.x,mid.y+0.25);
      }
    }
    ctx.globalAlpha=1;
  }

  function timeline() {return chronology.filter(graph.isPost);}
  function cursorIndex(events) {
    if (cursor===null) return events.length;
    const future=events.findIndex(event=>event.seq>cursor);
    return future===-1?events.length:future;
  }
  function setIndex(index,events=timeline()) {
    cursor=events[index-1]?.seq??0;
    scheduleGraph();
  }
  function stopPlayback() {
    clearTimeout(playTimer);
    playing=false;
  }
  function nextTick() {
    const events=timeline();
    const index=cursorIndex(events);
    if (index>=events.length || document.hidden || activeTab!=='graph') {
      stopPlayback();
      scheduleGraph();
      return;
    }
    const gap=Date.parse(events[index].time)-Date.parse(events[index-1]?.time);
    const duration=$('pacing').value==='real'&&Number.isFinite(gap)?Math.max(110,Math.min(gap,2000)):620;
    playTimer=setTimeout(()=>{setIndex(index+1,events);nextTick();},duration/Number($('speed').value));
  }
  function scheduleGraph() {
    if (activeTab!=='graph'||graphFrame) return;
    graphFrame=requestAnimationFrame(()=>{graphFrame=0;if (team && activeTab==='graph') renderGraph();});
  }
  function setGraphMode(mode) {
    graphMode=mode==='mentions'?'mentions':'hive';
    saveGraphMode(graphMode);
    $('graph-mode-hive').setAttribute('aria-pressed',String(graphMode==='hive'));
    $('graph-mode-mentions').setAttribute('aria-pressed',String(graphMode==='mentions'));
    $('mentions-options').hidden=graphMode!=='mentions';
    $('graph-stage').dataset.mode=graphMode;
    $('graph-legend').dataset.mode=graphMode;
    $('legend-hive').hidden=graphMode!=='hive';
    $('legend-mentions').hidden=graphMode!=='mentions';
    scheduleGraph();
  }
  function renderGraphTotal(events=timeline(),index=cursorIndex(events)) {
    const live=cursor===null&&['working','queued'].includes(team.phase);
    $('graph-total').textContent=events.length+' posts · '+graph.elapsedSpan(events.slice(0,index),{live})+
      (cursor!==null?' · '+index+'/'+events.length:'');
  }
  function graphPalette(stage) {
    const css=getComputedStyle(stage);
    const val=(prop,fallback)=>css.getPropertyValue(prop).trim()||fallback;
    const light=currentTheme()==='light';
    return {
      grid:val('--grid',light?'#eaedf2':'#242933'),
      link:val('--edge',light?'#9ba5b5':'#7c8698'),
      accent:val('--gold',light?'#8f5b10':'#f6c458'),
      gold:val('--gold-solid','#e5a024'),
      good:val('--good',light?'#247a3d':'#6fd89c'),
      goodSoft:light?'rgba(36, 122, 61, 0.08)':'rgba(111, 216, 156, 0.1)',
      purple:val('--purple',light?'#7c4dff':'#b39ddb'),
      bad:val('--bad',light?'#c4302b':'#ff8a80'),
      badSoft:light?'rgba(196, 48, 43, 0.08)':'rgba(255, 138, 128, 0.1)',
      wash:val('--wash',light?'#fdf4e2':'#2b2416'),
      paper:val('--surface',light?'#ffffff':'#181b21'),
      text:val('--ink',light?'#181c23':'#eef1f6'),
      muted:val('--muted',light?'#555e6d':'#a4adbd'),
    };
  }

  function renderGraph() {
    const events=timeline();
    const index=cursorIndex(events);
    const current=events[index-1];
    const roster=people();
    const mentionsProjection=graph.project(events,roster,current?.seq??0,{
      hideInactive:graphMode==='mentions'?$('hide-inactive').checked:false,
      expandBroadcast:graphMode==='mentions'?$('expand-all').checked:false,
    });
    renderGraphTotal(events,index);
    $('replay').max=events.length;
    $('replay').value=index;
    $('replay').setAttribute('aria-valuetext',current?stamp(current):'Before first post');
    $('first').disabled=!events.length||index===1;
    $('back').disabled=index===0;
    $('next').disabled=index>=events.length;
    $('play').disabled=!events.length;
    $('play').textContent=playing?'Ⅱ':'▶';
    const playLabel=playing?'Pause replay':'Replay';
    $('play').setAttribute('aria-label',playLabel);
    $('play').title=playLabel;
    $('live').setAttribute('aria-pressed',String(cursor===null));
    $('broadcast-count').textContent=mentionsProjection.broadcasts+' @all posts';

    $('graph-mode-hive').setAttribute('aria-pressed',String(graphMode==='hive'));
    $('graph-mode-mentions').setAttribute('aria-pressed',String(graphMode==='mentions'));
    $('mentions-options').hidden=graphMode!=='mentions';
    $('graph-stage').dataset.mode=graphMode;
    $('graph-legend').dataset.mode=graphMode;
    $('legend-hive').hidden=graphMode!=='hive';
    $('legend-mentions').hidden=graphMode!=='mentions';

    const stage=$('graph-stage');
    const color=graphPalette(stage);
    const activeFocus=document.activeElement?.dataset.graphName;
    const projByName=new Map(mentionsProjection.nodes.map(item=>[item.name,item]));
    const isConnected=name=>!focusedNode||focusedNode===name||mentionsProjection.links.some(
      edge=>(edge.from===focusedNode&&edge.to===name)||(edge.to===focusedNode&&edge.from===name));

    if (graphMode==='hive') {
      const hiveModel=(graph.projectHive??fallbackProjectHive)(events,roster,current?.seq??0);
      const minimum=(graph.hiveMinimumHeight??fallbackHiveMinimumHeight)(hiveModel.clusters.length,stage.clientWidth);
      stage.style.height=minimum?minimum+'px':'';
      const hiveLayout=(graph.layoutHive??fallbackLayoutHive)(hiveModel,stage.clientWidth,stage.clientHeight);
      if (focusedNode&&!roster.some(member=>member.name===focusedNode)) focusedNode=null;
      const buttons=[];
      const makeHiveButton=(member,x,y,isCoordinator,slotWidth)=>{
        const projNode=projByName.get(member.name)??member;
        const btn=node('button','graph-node graph-hive-bee');
        btn.type='button';
        btn.style.left=x+'px';
        btn.style.top=y+'px';
        if (Number.isFinite(slotWidth)&&slotWidth>0) btn.style.width=Math.max(46,Math.min(70,Math.floor(slotWidth)))+'px';
        btn.dataset.graphName=member.name;
        btn.dataset.role=isCoordinator?'coordinator':'worker';
        btn.dataset.status=member.status??'waiting';
        btn.dataset.muted=String(!projNode.posts&&!mentionsProjection.links.some(edge=>edge.to===member.name));
        btn.dataset.dimmed=String(!isConnected(member.name));
        btn.dataset.unmentioned=String(graph.unmentionedNode(projNode));
        const beeMuted=!isCoordinator&&['done','retired'].includes(member.status);
        btn.dataset.beeMuted=String(beeMuted);
        btn.title=author(member.name)+' · '+condition(member)+(graph.unmentionedNode(projNode)?' · Posted with no mention':'');
        btn.setAttribute('aria-label',btn.title);
        btn.setAttribute('aria-pressed',String(focusedNode===member.name));
        btn.append(beeSprite({...member,role:isCoordinator?'coordinator':'worker'},{muted:beeMuted}));
        if (!isCoordinator) btn.append(node('span','hive-bee-label',member.name));
        btn.onclick=()=>{
          focusedNode=focusedNode===member.name?null:member.name;
          scheduleGraph();
        };
        return btn;
      };
      const coordMember=roster.find(member=>member.role==='coordinator')??{name:'coordinator',role:'coordinator',status:'waiting'};
      const coordSlot=hiveLayout.coordinator.slots?.[0];
      buttons.push(makeHiveButton(coordMember,coordSlot?.x??hiveLayout.coordinator.x,coordSlot?.y??(hiveLayout.coordinator.y-16),true));
      for (const cluster of hiveLayout.clusters) {
        for (const slot of cluster.slots) {
          buttons.push(makeHiveButton(slot.member,slot.x,slot.y,false,slot.slotWidth));
        }
      }
      $('graph-nodes').replaceChildren(...buttons);
      drawHiveCanvas($('graph-canvas'),hiveLayout,hiveModel.connectors,color);
    } else {
      const minimum=(graph.mentionsMinimumHeight??graph.minimumHeight)(mentionsProjection.nodes.length,stage.clientWidth);
      stage.style.height=minimum?minimum+'px':'';
      const coordinates=(graph.layoutMentions??fallbackLayoutMentions)(mentionsProjection.nodes,stage.clientWidth,stage.clientHeight);
      if (focusedNode&&!coordinates.has(focusedNode)) focusedNode=null;
      const narrow=stage.clientWidth<465;
      const pillBoxes=new Map();
      const pillButtons=mentionsProjection.nodes.map(member=>{
        const point=coordinates.get(member.name);
        pillBoxes.set(member.name,pillBoxFor(member,narrow));
        const btn=node('button','graph-node graph-pill-node');
        btn.type='button';
        btn.style.left=point.x+'px';
        btn.style.top=point.y+'px';
        btn.dataset.graphName=member.name;
        btn.dataset.role=member.role??'worker';
        btn.dataset.status=member.status??'observer';
        btn.dataset.muted=String(!member.posts&&!mentionsProjection.links.some(edge=>edge.to===member.name));
        btn.dataset.dimmed=String(!isConnected(member.name));
        btn.dataset.unmentioned=String(graph.unmentionedNode(member));
        const beeMuted=member.role!=='coordinator'&&['done','retired'].includes(member.status);
        btn.dataset.beeMuted=String(beeMuted);
        btn.title=author(member.name)+' · '+condition(member)+(graph.unmentionedNode(member)?' · Posted with no mention':'');
        btn.setAttribute('aria-label',btn.title);
        btn.setAttribute('aria-pressed',String(focusedNode===member.name));
        const dot=node('span','pill-dot');
        dot.setAttribute('aria-hidden','true');
        btn.append(beeSprite(member,{muted:beeMuted}),node('span','pill-name',member.name),dot);
        if (member.broadcasts) btn.append(node('span','node-broadcast','@all '+member.broadcasts));
        btn.onclick=()=>{
          focusedNode=focusedNode===member.name?null:member.name;
          scheduleGraph();
        };
        return btn;
      });
      $('graph-nodes').replaceChildren(...pillButtons);
      for (const btn of pillButtons) {
        if (btn.offsetWidth>0&&btn.offsetHeight>0) {
          pillBoxes.set(btn.dataset.graphName,{halfW:btn.offsetWidth/2,halfH:btn.offsetHeight/2,offsetX:0,offsetY:0,radius:btn.offsetHeight/2});
        }
      }
      drawMentionsCanvas($('graph-canvas'),mentionsProjection,coordinates,pillBoxes,focusedNode,current?.seq,color);
    }

    if (activeFocus) [...$('graph-nodes').children].find(button=>button.dataset.graphName===activeFocus)?.focus({preventScroll:true});

    $('inspection-title').textContent=focusedNode?author(focusedNode):'Selected post';
    $('clear-node').hidden=!focusedNode;
    const focusedMember=focusedNode?roster.find(member=>member.name===focusedNode):null;
    const memberActions=$('graph-member-actions');
    memberActions.replaceChildren();
    const journal=focusedMember?transcriptButton(focusedMember):null;
    if (journal) memberActions.append(journal);
    memberActions.hidden=!memberActions.childElementCount;
    $('graph-post-author').textContent=current?author(current.author)+' · '+stamp(current):'';
    richText($('graph-post'),current?.text??'No post at this position yet.');
    const links=mentionsProjection.links.filter(edge=>!focusedNode||edge.from===focusedNode||edge.to===focusedNode)
      .sort((a,b)=>b.count-a.count);
    $('edge-list').replaceChildren(...links.map(edge=>{
      const line=node('li');
      line.append(node('span','',author(edge.from)+' → '+author(edge.to)),node('strong','',edge.count));
      return line;
    }));
  }

  /* Fallback GIF89a exporter when HiveGif is not yet merged */
  function fallbackEncodeSingleFrameGif(rgba,width,height) {
    const out=[0x47,0x49,0x46,0x38,0x39,0x61,width&255,(width>>8)&255,height&255,(height>>8)&255,0xF0,0,0];
    // 2-color table (theme paper & ink)
    out.push(0xFA,0xFA,0xFA,0x20,0x24,0x2C);
    // NETSCAPE2.0 infinite loop extension
    out.push(0x21,0xFF,0x0B,0x4E,0x45,0x54,0x53,0x43,0x41,0x50,0x45,0x32,0x2E,0x30,0x03,0x01,0,0,0);
    out.push(0x2C,0,0,0,0,width&255,(width>>8)&255,height&255,(height>>8)&255,0,2);
    const total=width*height;
    const idx=new Uint8Array(total);
    for (let i=0;i<total;i++) {
      const lum=(rgba[i*4]*299+rgba[i*4+1]*587+rgba[i*4+2]*114)/1000;
      idx[i]=lum<128?1:0;
    }
    const bytes=[];
    let bitBuf=0,bitCount=0;
    const emit=(code,bits)=>{
      bitBuf|=code<<bitCount;
      bitCount+=bits;
      while (bitCount>=8) {bytes.push(bitBuf&255);bitBuf>>=8;bitCount-=8;}
    };
    emit(4,3);
    for (let i=0;i<total;i++) {
      emit(idx[i],3);
      if (i%120===119) emit(4,3);
    }
    emit(5,3);
    if (bitCount>0) bytes.push(bitBuf&255);
    for (let i=0;i<bytes.length;i+=255) {
      const chunk=bytes.slice(i,i+255);
      out.push(chunk.length,...chunk);
    }
    out.push(0,0x3B);
    return new Uint8Array(out);
  }
  function fallbackExportGraphReplayGif(opts) {
    const width=Math.max(320,Math.min(960,Math.round(opts.width||680)));
    const height=Math.max(240,Math.min(720,Math.round(opts.height||460)));
    const canvas=document.createElement('canvas');
    canvas.width=width;
    canvas.height=height;
    const ctx=canvas.getContext('2d');
    if (ctx) {
      if (typeof graph.renderGraphFrame==='function') graph.renderGraphFrame(ctx,{...opts,width,height});
      else {
        ctx.fillStyle=opts.theme==='light'?'#f9fafc':'#15181e';
        ctx.fillRect?.(0,0,width,height);
        const stageCanvas=$('graph-canvas');
        if (stageCanvas?.width&&stageCanvas?.height) ctx.drawImage?.(stageCanvas,0,0,width,height);
      }
    }
    const rgba=ctx?.getImageData?.(0,0,width,height)?.data??new Uint8ClampedArray(width*height*4);
    const bytes=fallbackEncodeSingleFrameGif(rgba,width,height);
    const blob=typeof Blob!=='undefined'?new Blob([bytes],{type:'image/gif'}):undefined;
    return {bytes,blob,frameCount:1,width,height};
  }
  function teamSlug() {
    const slug=String(team?.title??team?.id??'swarm').toLowerCase()
      .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48);
    return slug||'swarm';
  }
  async function exportGif() {
    if (!team||exportingGif) return;
    const btn=$('export-gif');
    exportingGif=true;
    btn.disabled=true;
    notice('Exporting '+graphMode+' GIF…');
    try {
      const stage=$('graph-stage');
      const events=timeline();
      const exporter=globalThis.HiveGif?.exportGraphReplayGif??fallbackExportGraphReplayGif;
      const result=await exporter({
        mode:graphMode,
        posts:events,
        members:people(),
        phase:team.phase??(team.paused?'paused':'working'),
        pacing:$('pacing').value,
        speed:Number($('speed').value),
        hideInactive:$('hide-inactive').checked,
        expandBroadcast:$('expand-all').checked,
        focus:focusedNode,
        theme:currentTheme(),
        width:Math.max(480,stage.clientWidth||680),
        height:Math.max(360,stage.clientHeight||460),
        graph,
        bees:globalThis.HiveBee,
      });
      const blob=result?.blob??(typeof Blob!=='undefined'&&result?.bytes?new Blob([result.bytes],{type:'image/gif'}):null);
      const filename=teamSlug()+'-graph.gif';
      if (blob&&typeof URL.createObjectURL==='function') {
        const href=URL.createObjectURL(blob);
        const link=node('a');
        link.href=href;
        link.download=filename;
        link.style.display='none';
        document.body?.append?.(link);
        link.click?.();
        link.remove?.();
        setTimeout(()=>URL.revokeObjectURL?.(href),1500);
      }
      notice('Exported '+filename+' ('+(result?.frameCount??1)+' frames).');
    } catch (error) {
      notice(error?.message||'Could not export GIF.',true);
    } finally {
      exportingGif=false;
      btn.disabled=false;
    }
  }

  function selectTab(name,focus=false) {
    if (name!==activeTab) stopPlayback();
    if (name==='members'&&activeTab!==name) memberKey='';
    activeTab=name;
    for (const tab of tabs) {
      const selected=tab===name;
      $('tab-'+tab).setAttribute('aria-selected',String(selected));
      $('tab-'+tab).tabIndex=selected?0:-1;
      $('panel-'+tab).hidden=!selected||!team;
    }
    render();
    $('tab-'+name).scrollIntoView?.({block:'nearest',inline:'nearest',container:'nearest'});
    if (focus) $('tab-'+name).focus();
  }

  function rpc(method,params={}) {
    const id=++requestNumber;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(Error('Codex did not respond.'));},12000);
      pending.set(id,{resolve,reject,timer});
      parent.postMessage({jsonrpc:'2.0',id,method,params},'*');
    });
  }
  function unpack(result) {
    if (result?.isError) throw Error(result.content?.[0]?.text??'Action failed.');
    return result?.structuredContent??result;
  }
  async function call(tool,values={}) {
    if (!standalone) return unpack(await rpc('tools/call',{name:tool,arguments:{teamId,...values}}));
    const routes={board_status:'status',board_history:'history',post_message:'post',
      pause_team:'pause',resume_team:'resume',set_member_model:'member-model',retire_member:'member-retire',
      remove_worktree:'worktree-remove',set_team_title:'title',resolve_recovery:'resolve-recovery'};
    const reading=tool==='board_status'||tool==='board_history';
    const query=tool==='board_history'?'?'+new URLSearchParams(values):'';
    const options=reading?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)};
    const response=await fetch(location.pathname+'/'+routes[tool]+query,options);
    const data=await response.json();
    if (!response.ok) throw Error(data.error);
    return data;
  }
  function syncHistory() {
    if (historyRequest) return historyRequest;
    if (!teamId || historyTail>=(team?.events?.at(-1)?.seq??0)) return;
    const id=teamId;
    historyRequest=(async()=>{
      let more=true;
      while (more && id===teamId) {
        const page=await call('board_history',{after:historyTail,limit:48});
        if (teamId!==id) break;
        acceptPosts(page.posts);
        historyTail=page.posts.at(-1)?.seq??page.head;
        more=page.hasMore && !!page.posts.length;
      }
      render();
    })().finally(()=>{historyRequest=null;});
    return historyRequest;
  }
  async function refresh() {
    if (!teamId||refreshing||document.hidden) return;
    refreshing=true;
    try {
      acceptStatus(await call('board_status'));
      await syncHistory();
    } catch (error) {
      if (!team) notice(error.message,true);
    } finally {
      refreshing=false;
    }
  }
  function renderTeamPicker() {
    if (!standalone) return;
    const current=team?.id??'';
    const groups=team&&!recentTeams.some(entry=>entry.id===current)
      ? [{id:current,title:team.title},...recentTeams]
      : recentTeams.map(entry=>entry.id===current?{...entry,title:team.title}:entry);
    const key=JSON.stringify([current,groups]);
    if (key===teamListKey) return;
    teamListKey=key;
    const select=$('recent-teams');
    const choice=new Option('Select swarm','');
    choice.disabled=true;
    select.replaceChildren(choice,...groups.map(entry=>new Option(entry.title,entry.id)));
    select.value=current;
    $('team-picker').hidden=!groups.length;
    if (emptyPanel) $('meta').textContent=groups.length?'Select a swarm to open its board.':'No swarms to display yet.';
  }
  function acceptTeams(value) {
    if (!Array.isArray(value.teams)) return;
    recentTeams=value.teams;
    renderTeamPicker();
  }
  async function loadRecentTeams() {
    if (loadingTeams) return;
    loadingTeams=true;
    try {
      const response=await fetch('/swarm/teams',{cache:'no-store'});
      if (!response.ok) throw Error('Could not load recent swarms.');
      acceptTeams(await response.json());
    } catch (error) {
      if (emptyPanel) notice(error.message,true);
    } finally {
      loadingTeams=false;
    }
  }
  function connectEvents() {
    if (!standalone||stream||typeof EventSource==='undefined') return;
    stream=new EventSource(location.pathname+'/events');
    stream.onopen=()=>{streamOnline=true;};
    stream.onerror=()=>{streamOnline=false;};
    const handle=(type,receive)=>stream.addEventListener(type,event=>{
      try {receive(JSON.parse(event.data));} catch (error) {notice(error.message,true);}
    });
    if (emptyPanel) handle('teams',acceptTeams);
    else {
      handle('status',value=>{
        acceptStatus(value);
        syncHistory()?.catch(error=>notice(error.message,true));
      });
      handle('activity',value=>{
        if (!team) return;
        team.activity=value;
        renderActivity();
      });
    }
  }
  function setTheme(theme) {
    document.documentElement.dataset.theme=theme;
    $('theme').firstElementChild.textContent=theme==='dark'?'☀':'☾';
    scheduleGraph();
  }
  const colorSchemeQuery=matchMedia('(prefers-color-scheme: dark)');
  function initialTheme() {
    try {
      const saved=localStorage.getItem('team-board-color');
      if (saved==='light'||saved==='dark') return saved;
    } catch {}
    return colorSchemeQuery.matches?'dark':'light';
  }
  function attachLightDismiss(dialog,closeFn) {
    if (!dialog||typeof dialog.addEventListener!=='function') return;
    if (globalThis.HTMLDialogElement && 'closedBy' in globalThis.HTMLDialogElement.prototype) return;
    const outside=(event)=>{
      const rect=dialog.getBoundingClientRect?.();
      if (!rect) return false;
      return event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom;
    };
    let pressedOutside=false;
    dialog.addEventListener('pointerdown',event=>{pressedOutside=outside(event);});
    dialog.addEventListener('pointerup',event=>{if (pressedOutside&&outside(event)) closeFn();});
  }

  $('brand-bee').append(HiveBee.sprite('coordinator',{coordinator:true}));
  $('theme').onclick=()=>{
    const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';
    setTheme(theme);
    try {localStorage.setItem('team-board-color',theme);} catch {}
  };
  setTheme(initialTheme());
  colorSchemeQuery.addEventListener?.('change',event=>{
    try {if (localStorage.getItem('team-board-color')) return;} catch {}
    setTheme(event.matches?'dark':'light');
  });
  for (const [index,name] of tabs.entries()) {
    const tab=$('tab-'+name);
    tab.onclick=()=>selectTab(name);
    tab.onkeydown=event=>{
      const directions={ArrowRight:(index+1)%tabs.length,ArrowLeft:(index+tabs.length-1)%tabs.length,Home:0,End:tabs.length-1};
      if (!Object.hasOwn(directions,event.key)) return;
      event.preventDefault();
      selectTab(tabs[directions[event.key]],true);
    };
  }
  $('open-members').onclick=()=>selectTab('members',true);
  $('search-posts').oninput=()=>renderFeed();
  $('member-filter').onchange=()=>renderFeed();
  $('channel-filter').onchange=()=>renderFeed();
  $('search-members').oninput=()=>renderMembers();
  $('follow').onclick=()=>{
    following=!following;
    $('follow').setAttribute('aria-pressed',String(following));
    renderFeed();
  };
  $('compose').onsubmit=async event=>{
    event.preventDefault();
    const text=$('message').value.trim();
    if (!text || $('submit').disabled) return;
    $('submit').disabled=true;
    try {
      acceptStatus(await call('post_message',{text,channel:$('composer-channel').value||'main'}));
      $('message').value='';
      notice('Posted to the board.');
    } catch (error) {
      notice(error.message,true);
    } finally {
      $('submit').disabled=false;
    }
  };
  $('pause').onclick=async()=>{
    $('pause').disabled=true;
    try {acceptStatus(await call(team.paused?'resume_team':'pause_team'));}
    catch (error) {notice(error.message,true);}
    finally {$('pause').disabled=false;}
  };
  async function extendBudget(button) {
    if (extendingBudget || button.disabled || team?.phase!=='budget') return;
    extendingBudget=true;
    button.disabled=true;
    $('extra-turns').disabled=true;
    try {acceptStatus(await call('resume_team',{extraTurns:8}));}
    catch (error) {notice(error.message,true);}
    finally {extendingBudget=false;button.disabled=false;$('extra-turns').disabled=false;}
  }
  $('extra-turns').onclick=event=>{if (event.isTrusted) return extendBudget($('extra-turns'));};
  $('close-lightbox').onclick=closeLightbox;
  $('screenshot-lightbox').oncancel=event=>{
    event.preventDefault();
    closeLightbox();
  };
  attachLightDismiss($('screenshot-lightbox'),closeLightbox);
  if (standalone) {
    $('close-transcript').onclick=closeTranscript;
    $('refresh-transcript').onclick=refreshTranscript;
    $('member-transcript').oncancel=event=>{
      event.preventDefault();
      closeTranscript();
    };
    attachLightDismiss($('member-transcript'),closeTranscript);
    const select=$('recent-teams');
    select.onfocus=loadRecentTeams;
    select.onchange=()=>{
      if (/^[a-f0-9-]{36}$/.test(select.value)) location.assign('/board/'+select.value);
    };
    loadRecentTeams();
    const titleForm=$('title-form');
    const title=$('new-title');
    function setTitleEditing(editing) {
      titleEditing=editing;
      titleForm.hidden=!editing;
      $('edit-title').hidden=editing;
      if (editing) {title.value=team.title;title.focus();}
      else $('edit-title').focus();
    }
    $('edit-title').onclick=event=>{
      if (event.isTrusted&&team) setTitleEditing(true);
    };
    $('cancel-title').onclick=event=>{
      if (event.isTrusted) setTitleEditing(false);
    };
    titleForm.onsubmit=async event=>{
      event.preventDefault();
      const button=$('save-title');
      const value=title.value.trim();
      if (!event.isTrusted||!value||button.disabled) return;
      if (await memberAction(button,'set_team_title',{title:value})) setTitleEditing(false);
    };
    window.addEventListener('pageshow',connectEvents);
    window.addEventListener('pagehide',()=>{
      stream?.close();
      stream=null;
      streamOnline=false;
    });
  }
  $('first').onclick=()=>{stopPlayback();setIndex(1);};
  $('back').onclick=()=>{stopPlayback();setIndex(Math.max(0,cursorIndex(timeline())-1));};
  $('next').onclick=()=>{stopPlayback();setIndex(cursorIndex(timeline())+1);};
  $('replay').oninput=()=>{stopPlayback();setIndex(Number($('replay').value));};
  $('live').onclick=()=>{stopPlayback();cursor=null;scheduleGraph();};
  $('play').onclick=()=>{
    if (playing) {stopPlayback();scheduleGraph();return;}
    const events=timeline();
    if (cursor===null||cursorIndex(events)>=events.length) setIndex(0,events);
    playing=true;
    scheduleGraph();
    nextTick();
  };
  $('clear-node').onclick=()=>{focusedNode=null;scheduleGraph();};
  $('graph-mode-hive').onclick=()=>setGraphMode('hive');
  $('graph-mode-mentions').onclick=()=>setGraphMode('mentions');
  $('hide-inactive').onchange=$('expand-all').onchange=scheduleGraph;
  $('export-gif').onclick=exportGif;
  const observer=new ResizeObserver(scheduleGraph);
  observer.observe($('graph-stage'));
  function refreshLanding() {
    if (!document.hidden) return loadRecentTeams();
  }
  document.addEventListener('visibilitychange',()=>{
    if (document.hidden) {stopPlayback();return;}
    if (emptyPanel) return refreshLanding();
    refresh();
    scheduleGraph();
  });
  if (emptyPanel) {
    $('title').textContent='Swarm';
    $('meta').textContent='No swarms to display yet.';
    $('empty-swarm').hidden=false;
    window.addEventListener('focus',refreshLanding);
  } else if (standalone) refresh();
  else {
    addEventListener('message',({source,data})=>{
      if (source!==parent||data?.jsonrpc!=='2.0') return;
      if (!data.method&&pending.has(data.id)) {
        const waiting=pending.get(data.id);
        pending.delete(data.id);
        clearTimeout(waiting.timer);
        if (data.error) waiting.reject(Error(data.error.message)); else waiting.resolve(data.result);
      }
      if (data.method==='ui/notifications/tool-input') {
        teamId??=data.params?.arguments?.teamId;
        refresh();
      }
      if (data.method==='ui/notifications/tool-result') {
        try {acceptStatus(unpack(data.params));refresh();}
        catch (error) {notice(error.message,true);}
      }
      if (data.method==='ui/resource-teardown') {
        clearInterval(refreshTimer);
        stopPlayback();
        observer.disconnect();
        parent.postMessage({jsonrpc:'2.0',id:data.id,result:{}},'*');
      }
    });
    rpc('ui/initialize',{
      appInfo:{name:'Hive Swarm',version:globalThis.__HIVE_SWARM_VERSION__||'2.1.0'},appCapabilities:{},protocolVersion:'2026-01-26',
    }).then(()=>{
      parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');
      refresh();
    }).catch(()=>notice('Open the Board link from the tool output to view the board.',true));
  }
  connectEvents();
  refreshTimer=emptyPanel?setInterval(()=>{if(!streamOnline)return refreshLanding();},12000)
    :setInterval(()=>{
      if(!streamOnline)return refresh();
      if(team&&activeTab==='graph'&&!document.hidden)renderGraphTotal();
    },2400);
})();
