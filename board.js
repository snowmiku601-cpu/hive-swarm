(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const graph=globalThis.HiveGraph;
  const standalone=parent===window;
  const emptyPanel=standalone && location.pathname==='/swarm';
  const tabs=['overview','board','members','graph'];
  const states={queued:'Queued',working:'Working',waiting:'Waiting',done:'Done',failed:'Failed',
    quota:'Quota limit',retired:'Retired',observer:'Observer'};
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
  let teamId=standalone&&!emptyPanel?location.pathname.split('/').at(-1):null;
  let team,signature='',rosterKey='',feedKey='',activeTab='board',chronology=[],latestByAuthor=new Map();
  let historyTail=0,historyRequest,refreshing=false,following=true,seen=0,feedLimit=160;
  let recentTeams=[],teamListKey='',loadingTeams=false,channelKey='',memberKey='';
  let stream,streamOnline=false,modelCatalog,titleEditing=false,transcript,extendingBudget=false;
  let requestNumber=0,refreshTimer,playTimer,playing=false,cursor=null,focusedNode=null,graphFrame=0;

  function node(tag,kind='',text) {
    const element=document.createElement(tag);
    if (kind) element.className=kind;
    if (text!=null) element.textContent=text;
    return element;
  }
  function author(name) {return Object.hasOwn(authors,name)?authors[name]:'@'+name;}
  function condition(member) {return member.retireAfterTurn?'Retiring after turn':states[member.status]??member.status;}
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
  function bee(member,compact=false) {
    const tile=node('span','bee-tile'+(compact?' compact':''));
    tile.dataset.status=member.status??'observer';
    tile.append(HiveBee.sprite(member.name,{status:tile.dataset.status,coordinator:member.role==='coordinator',tint:member.tint}));
    return tile;
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
      posts.clear();
      chronology=[];
      latestByAuthor.clear();
      historyTail=seen=0;
      cursor=focusedNode=null;
      memberDrafts.clear();
      $('overview-brief-details').open=false;
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
    } else if (activeTab==='overview') renderOverview();
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

  function transcriptButton(member) {
    if (!standalone || !chatUrl(member.threadId)) return null;
    const button=node('button','link-button','View journal');
    button.type='button';
    button.setAttribute('aria-label','View journal for '+author(member.name));
    button.onclick=()=>{
      transcript={name:member.name,threadId:member.threadId,status:member.status,opener:button};
      $('transcript-title').textContent='Journal · '+author(member.name);
      $('transcript-turns').replaceChildren();
      $('member-transcript').showModal();
      syncTranscript();
      return refreshTranscript();
    };
    return button;
  }

  function closeTranscript() {
    const previous=transcript;
    if (!previous) return;
    transcript=null;
    previous.request?.abort();
    $('member-transcript').close();
    (previous.opener.isConnected?previous.opener:$('tab-'+activeTab)).focus({preventScroll:true});
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
          steps.append(...turn.steps.map(step=>node('li','',step)));
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
    const people=(thread.members??[]).map(name=>team.members.find(member=>member.name===name)).filter(Boolean);
    if (people.some(member=>member.recoveryRequired||['failed','quota'].includes(member.status))) {
      return {key:'blocked',label:'Blocked',rank:0};
    }
    if (people.some(member=>member.status==='working')) return {key:'active',label:'Active',rank:1};
    if (people.some(member=>member.status==='queued')) return {key:'queued',label:'Queued',rank:2};
    if (people.some(member=>member.status==='waiting')) return {key:'waiting',label:'Waiting',rank:3};
    if (people.length&&people.every(member=>['done','retired'].includes(member.status))) {
      return {key:'done',label:'Done',rank:4};
    }
    return {key:'queued',label:'Queued',rank:2};
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

  function renderOverview() {
    const members=team.members;
    const workers=members.filter(member=>member.role!=='coordinator'&&member.status!=='retired');
    $('overview-goal').textContent=team.title;
    const brief=team.task?.trim()??'';
    const long=brief.length>180||/\n/.test(brief);
    $('overview-brief').textContent=brief;
    $('overview-brief').hidden=long||!brief||brief===team.title;
    $('overview-brief-details').hidden=!long;
    $('overview-brief-full').textContent=brief;
    progressView('workers','worker-progress',workers.filter(member=>member.status==='done').length,workers.length);
    progressView('turns','turn-progress',team.turns,team.turnLimit);
    liveSlots.clear();
    nowSlots.clear();
    $('overview-members').replaceChildren(...members.map(member=>{
      const row=node('li','overview-member');
      const heading=node('div','member-top');
      const status=node('span','status-word',condition(member));
      status.dataset.status=member.status;
      heading.append(node('strong','',author(member.name)),status);
      row.append(heading);
      const now=node('p','now-summary',memberNow(member));
      nowSlots.set(member.name,now);
      row.append(now);
      const latest=latestByAuthor.get(member.name);
      const journal=transcriptButton(member);
      if (latest||journal) {
        const actions=node('div','overview-actions');
        if (latest) actions.append(postReference(latest.seq));
        if (journal) actions.append(journal);
        row.append(actions);
      }
      return row;
    }));
    const alerts=attentionItems();
    $('overview-alerts').replaceChildren(...alerts.map(attentionRow));
    $('overview-alerts-panel').hidden=!alerts.length;
    const threads=(team.threads??[]).map(thread=>({thread,state:threadState(thread)}))
      .sort((a,b)=>a.state.rank-b.state.rank);
    $('overview-threads').replaceChildren(...threads.map(({thread,state})=>{
      const row=node('li','thread-row');
      const heading=node('div','member-top');
      const badge=node('span','status-word',state.label);
      badge.dataset.status=state.key==='blocked'?'failed':state.key==='active'?'working':state.key;
      heading.append(node('strong','',thread.title),badge);
      row.append(heading);
      if (thread.goal) row.append(node('p','now-summary',thread.goal));
      if (thread.members?.length) row.append(node('p','minor member-context',thread.members.map(author).join(' · ')));
      return row;
    }));
    $('overview-threads-panel').hidden=!threads.length;
    const milestones=chronology.filter(event=>['checkpoint','monitor'].includes(event.kind)||/\[done\]/i.test(event.text)).slice(-6).reverse();
    $('overview-milestones').replaceChildren(...milestones.map(event=>{
      const result=node('li','milestone');
      result.append(postReference(event.seq),node('span','',event.text.slice(0,180)));
      return result;
    }));
    $('overview-milestones-panel').hidden=!milestones.length;
    const summary=$('overview-summary');
    summary.replaceChildren();
    const report=chronology.findLast(event=>event.author==='coordinator'&&event.kind==='message');
    if (report) {
      const body=node('div','message');
      richText(body,report.text);
      summary.append(node('h3','','Coordinator summary'),postReference(report.seq),body);
    }
    summary.hidden=!report;
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
    line.append(node('h3','member-name',author(member.name)),badge);
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
  function renderGraphTotal(events=timeline(),index=cursorIndex(events)) {
    const live=cursor===null&&['working','queued'].includes(team.phase);
    $('graph-total').textContent=events.length+' posts · '+graph.elapsedSpan(events.slice(0,index),{live})+
      (cursor!==null?' · '+index+'/'+events.length:'');
  }
  function renderGraph() {
    const events=timeline();
    const index=cursorIndex(events);
    const current=events[index-1];
    const projection=graph.project(events,people(),current?.seq??0,{
      hideInactive:$('hide-inactive').checked,expandBroadcast:$('expand-all').checked,
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
    $('broadcast-count').textContent=projection.broadcasts+' @all posts';
    const stage=$('graph-stage');
    const minimum=graph.minimumHeight(projection.nodes.length,stage.clientWidth);
    stage.style.height=minimum?minimum+'px':'';
    const coordinates=graph.layout(projection.nodes,stage.clientWidth,stage.clientHeight);
    if (focusedNode && !coordinates.has(focusedNode)) focusedNode=null;
    const active=document.activeElement?.dataset.graphName;
    $('graph-nodes').replaceChildren(...projection.nodes.map(member=>{
      const point=coordinates.get(member.name);
      const button=node('button','graph-node');
      button.type='button';
      button.style.left=point.x+'px';
      button.style.top=point.y+'px';
      button.dataset.graphName=member.name;
      button.dataset.role=member.role??'worker';
      button.dataset.status=member.status;
      button.dataset.muted=String(!member.posts&&!projection.links.some(edge=>edge.to===member.name));
      button.dataset.unmentioned=String(graph.unmentionedNode(member));
      button.title=author(member.name)+' · '+condition(member)+
        (graph.unmentionedNode(member)?' · Posted with no mention':'');
      button.setAttribute('aria-label',button.title);
      button.setAttribute('aria-pressed',String(focusedNode===member.name));
      const hex=node('span','hex');
      hex.append(HiveBee.sprite(member.name,{coordinator:member.role==='coordinator',status:member.status,tint:member.tint}));
      button.append(hex,node('span','node-label',author(member.name)));
      if (member.broadcasts) button.append(node('span','node-broadcast','@all '+member.broadcasts));
      button.onclick=()=>{
        focusedNode=focusedNode===member.name?null:member.name;
        scheduleGraph();
      };
      return button;
    }));
    if (active) [...$('graph-nodes').children].find(button=>button.dataset.graphName===active)?.focus({preventScroll:true});
    const css=getComputedStyle(stage);
    graph.draw($('graph-canvas'),projection,coordinates,focusedNode,current?.seq,{
      grid:css.getPropertyValue('--grid'),link:css.getPropertyValue('--edge'),accent:css.getPropertyValue('--gold'),
      paper:css.getPropertyValue('--surface'),text:css.getPropertyValue('--ink'),
    });
    $('inspection-title').textContent=focusedNode?author(focusedNode):'Selected post';
    $('clear-node').hidden=!focusedNode;
    $('graph-post-author').textContent=current?author(current.author)+' · '+stamp(current):'';
    richText($('graph-post'),current?.text??'No post at this position yet.');
    const links=projection.links.filter(edge=>!focusedNode||edge.from===focusedNode||edge.to===focusedNode)
      .sort((a,b)=>b.count-a.count);
    $('edge-list').replaceChildren(...links.map(edge=>{
      const line=node('li');
      line.append(node('span','',author(edge.from)+' → '+author(edge.to)),node('strong','',edge.count));
      return line;
    }));
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
    $('tab-'+name).scrollIntoView?.({block:'nearest',inline:'nearest'});
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
  function initialTheme() {
    try {
      const saved=localStorage.getItem('team-board-color');
      if (saved==='light'||saved==='dark') return saved;
    } catch {}
    return matchMedia('(prefers-color-scheme:light)').matches?'light':'dark';
  }

  $('brand-bee').append(HiveBee.sprite('coordinator',{coordinator:true}));
  $('theme').onclick=()=>{
    const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';
    setTheme(theme);
    try {localStorage.setItem('team-board-color',theme);} catch {}
  };
  setTheme(initialTheme());
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
  if (standalone) {
    $('close-transcript').onclick=closeTranscript;
    $('refresh-transcript').onclick=refreshTranscript;
    $('member-transcript').oncancel=event=>{
      event.preventDefault();
      closeTranscript();
    };
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
  $('hide-inactive').onchange=$('expand-all').onchange=scheduleGraph;
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
      appInfo:{name:'Hive Swarm',version:globalThis.__HIVE_SWARM_VERSION__||'1.8.0'},appCapabilities:{},protocolVersion:'2026-01-26',
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
