import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const read = name => readFileSync(new URL(name,import.meta.url),'utf8');

class ViewNode {
  children=[];
  dataset={};
  attributes={};
  value='';
  scrollTop=0;
  scrollHeight=0;
  isConnected=true;
  constructor(tag) {this.tagName=tag;}
  get childElementCount() {return this.children.filter(child=>child.tagName).length;}
  get textContent() {return this._text??this.children.map(child=>child.textContent).join('');}
  set textContent(value) {this._text=value;this.children=[];}
  set innerHTML(_) {assert.fail('Use text or DOM nodes');}
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.children=children;}
  setAttribute(name,value) {this.attributes[name]=value;}
  focus() {this.focused=true;}
  showModal() {this.open=true;}
  close() {this.open=false;}
  scrollIntoView() {this.scrolled=true;}
  querySelector(selector) {
    const sequence=/^\[data-seq="(\d+)"\]$/.exec(selector)?.[1];
    return this.children.find(child=>String(child.dataset?.seq)===sequence);
  }
  get firstElementChild() {return this.children[0];}
}

async function boardView(initial,{path='/board/'+initial.id,request,live=false}={}) {
  const elements=new Map();
  const element=id=>{
    if (!elements.has(id)) elements.set(id,new ViewNode(id));
    return elements.get(id);
  };
  element('theme').append(new ViewNode('span'));
  const focusEvents=new Map(),visibilityEvents=new Map();
  const frame={addEventListener:(name,callback)=>focusEvents.set(name,callback)};
  const streams=[];
  class EventSource {
    listeners=new Map();
    constructor(url){this.url=url;streams.push(this);}
    addEventListener(event,callback){this.listeners.set(event,callback);}
    publish(event,data){this.listeners.get(event)?.({data:JSON.stringify(data)});}
    close(){this.closed=true;}
  }
  const navigation=[];
  let poll;
  let state=initial;
  const screen={
    window:frame,parent:frame,location:{pathname:path,assign:url=>navigation.push(url)},
    document:{getElementById:element,documentElement:new ViewNode('html'),
      addEventListener:(name,callback)=>visibilityEvents.set(name,callback),
      createElement:tag=>new ViewNode(tag),createTextNode:text=>({textContent:text})},
    Option:class {constructor(text,value) {Object.assign(this,{text,value});}},
    HiveBee:{sprite:()=>new ViewNode('svg')},
    ResizeObserver:class {observe(){}},
    URL,URLSearchParams,Intl,AbortController,clearTimeout,setTimeout,EventSource:live?EventSource:undefined,matchMedia:()=>({matches:false}),
    requestAnimationFrame:callback=>{queueMicrotask(callback);return 1;},
    setInterval:callback=>{poll=callback;return 1;},
    fetch:async (url,options)=>({ok:true,json:async()=>
      (await request?.(url,options))??(url.includes('/history?')
        ? {posts:state.events,head:state.events.at(-1)?.seq??0} : url==='/swarm/teams'?{teams:[]}:state)}),
  };
  runInNewContext(read('hive-graph.js')+'\n'+read('board.js'),screen);
  await new Promise(resolve=>setImmediate(resolve));
  return {element,navigation,streams,update:async next=>{state=next;await poll();},
    focus:()=>focusEvents.get('focus')?.(),visible:()=>visibilityEvents.get('visibilitychange')?.()};
}

test('polling member status preserves each displayed post node and its text selection',async()=>{
  const initial={
    id:'team', title:'Nhóm mẫu',cwd:'fixture', members:[{name:'builder',status:'waiting'}],
    events:[{seq:1,kind:'message',author:'builder',text:'Giữ nguyên nội dung đang chọn.',targets:[]}],
    phase:'stalled',turnLimit:4,turns:1,
  };
  const view=await boardView(initial);
  const feed=view.element('feed');
  const selected=feed.firstElementChild;
  assert.ok(selected);
  await view.update({...initial,members:[{name:'builder',status:'working'}],phase:'working',turns:2});
  assert.equal(view.element('active-count').textContent,1);
  assert.equal(feed.firstElementChild,selected);

  const query=view.element('search-posts');
  query.value='không khớp';
  query.oninput();
  assert.notEqual(feed.firstElementChild,selected);
  assert.equal(feed.firstElementChild.className,'empty');
});

const childrenOf=node=>[node,...(node.children??[]).flatMap(childrenOf)];

test('posts render safe Markdown and jump to a filtered-out older sequence',async()=>{
  const fence=String.fromCharCode(96).repeat(3);
  const text='**Báo cáo** @builder xem #2 và '+String.fromCharCode(96)+'#10'+String.fromCharCode(96)+
    '\n'+fence+'html\n<img src=x onerror=alert(1)>\n'+fence;
  const events=Array.from({length:180},(_,i)=>({seq:i+1,kind:'message',author:'builder',
    text:i===179?text:'Bài '+(i+1),targets:[]})).filter(event=>event.seq!==2);
  const state={id:'team',title:'Bảng thử',cwd:'fixture',events,members:[{name:'builder',status:'done'}],phase:'done',turns:1,turnLimit:4};
  const view=await boardView(state,{request:async url=>url.includes('/history?after=1&limit=1')
    ? {posts:[{seq:2,kind:'message',author:'builder',text:'Bài 2',targets:[]}],head:180}:undefined});
  const feed=view.element('feed');
  const query=view.element('search-posts');
  query.value='Báo cáo';
  query.oninput();
  const rendered=childrenOf(feed);
  assert.ok(rendered.some(item=>item.tagName==='strong'&&item.textContent==='Báo cáo'));
  assert.ok(rendered.some(item=>item.className==='mention'&&item.textContent==='@builder'));
  assert.ok(rendered.some(item=>item.tagName==='pre'&&item.firstElementChild.textContent==='<img src=x onerror=alert(1)>'));
  assert.ok(!rendered.some(item=>item.tagName==='img'));
  const references=rendered.filter(item=>item.className==='post-reference');
  assert.deepEqual(references.map(item=>item.textContent),['#2']);
  await references[0].onclick();
  const target=feed.querySelector('[data-seq="2"]');
  assert.ok(target?.focused&&target.scrolled);
  assert.equal(query.value,'');
});

test('the standalone landing and board list saved groups and open the selected path',async()=>{
  const group={id:'53548778-ac26-4f76-b9b0-8fd446dfcee4',title:'Một nhóm'};
  const request=async url=>url==='/swarm/teams'?{teams:[group]}:undefined;
  for (const path of ['/swarm','/board/'+group.id]) {
    const view=await boardView({...group,cwd:'fixture',members:[],events:[],phase:'done'},{path,request});
    const picker=view.element('recent-teams');
    assert.ok(picker.children.some(option=>option.text===group.title));
    picker.value=group.id;
    picker.onchange();
    assert.deepEqual(view.navigation,['/board/'+group.id]);
  }
});

test('the budget button requests eight extra turns only after a user click',async()=>{
  const initial={id:'team',title:'Bảng thử',cwd:'fixture',members:[],events:[],phase:'budget',turnLimit:1,turns:1};
  const calls=[];
  const view=await boardView(initial,{request:async (url,options)=>{
    if (!url.endsWith('/resume')) return;
    calls.push(JSON.parse(options.body));
    return {...initial,phase:'done',turnLimit:9};
  }});
  const button=view.element('extra-turns');
  assert.equal(button.hidden,false);
  await button.onclick({isTrusted:false});
  assert.deepEqual(calls,[]);
  await button.onclick({isTrusted:true});
  assert.deepEqual(calls,[{extraTurns:8}]);
  assert.equal(button.hidden,true);
});

test('inline sequence links have baseline alignment without a button-height minimum',()=>{
  const css=read('board.css');
  const reference=css.match(/\.post-reference\s*\{([^}]+)\}/)[1];
  for (const declaration of ['min-height:0','line-height:inherit','border-radius:3px','vertical-align:baseline']) {
    assert.ok(reference.replaceAll(/\s/g,'').includes(declaration),declaration);
  }
});

test('an empty Swarm discovers new teams on focus, visibility and its quiet refresh',async()=>{
  let teams=[];
  const view=await boardView({}, {path:'/swarm',request:()=>({teams})});
  const picker=view.element('recent-teams');
  assert.equal(picker.children.length,1);
  const discover=async (title,trigger)=>{
    teams=[{id:'53548778-ac26-4f76-b9b0-8fd446dfcee4',title}];
    await trigger();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(picker.children[1]?.text,title);
    assert.equal(view.element('team-picker').hidden,false);
  };
  await discover('Nhóm vừa tạo',view.focus);
  await discover('Nhóm vừa hiện',view.visible);
  await discover('Nhóm vừa tải',()=>view.update({}));
});

test('overview derives progress and the latest coordinator summary while live updates preserve posts',async()=>{
  const state={id:'team',title:'Tổng quan mẫu',task:'Kiểm tra chức năng bốn tab',cwd:'fixture',
    members:[{name:'builder',status:'working'},{name:'verifier',status:'done'},
      {name:'coordinator',role:'coordinator',status:'waiting'}],
    phase:'working',turns:2,turnLimit:8,overview:{headline:'Tổng quan đã lưu trước khi nâng cấp'},events:[
      {seq:1,kind:'message',author:'verifier',text:'[done] Xong verify',targets:[]},
      {seq:2,kind:'message',author:'coordinator',text:'Bản tổng hợp trước',targets:[]},
      {seq:3,kind:'message',author:'coordinator',text:'Bản tổng hợp mới nhất',targets:[]},
    ]};
  const view=await boardView(state,{live:true});
  const [stream]=view.streams;
  assert.equal(stream.url,'/board/team/events');
  assert.equal(view.element('board-live').hidden,false);
  const post=view.element('feed').firstElementChild;
  assert.ok(post);
  stream.publish('activity',{builder:{steps:[{label:'Kiểm tra console'}],draft:'Đang xem'}});
  assert.equal(view.element('feed').firstElementChild,post);
  assert.match(view.element('board-live-list').textContent,/Kiểm tra console/);
  view.element('tab-overview').onclick();
  assert.equal(view.element('overview-goal').textContent,state.task);
  assert.equal(view.element('worker-progress').textContent,'1/2');
  assert.equal(view.element('turn-progress').textContent,'2/8');
  assert.match(view.element('overview-milestones').textContent,/Xong verify/);
  assert.match(view.element('overview-summary').textContent,/Bản tổng hợp mới nhất/);
  assert.doesNotMatch(view.element('overview-summary').textContent,/trước/);
  stream.publish('activity',{builder:{steps:[{label:'Hoàn tất console'}]}});
  assert.match(view.element('overview-members').textContent,/Hoàn tất console/);
  assert.equal((read('board.html').match(/role="tab"/g)??[]).length,4);
});

test('the member mention button opens the public composer, focuses it and adds the exact name once',async()=>{
  const state={id:'team',title:'Soạn công khai',cwd:'fixture',members:[{name:'builder',status:'waiting'}],
    channels:[{name:'main'},{name:'qa'}],phase:'stalled',events:[],turns:1,turnLimit:4};
  const posts=[];
  const view=await boardView(state,{request:(url,options)=>{
    if (options?.method==='POST') posts.push([url,JSON.parse(options.body)]);
  }});
  const message=view.element('message');
  const mention=()=>{
    view.element('tab-members').onclick();
    childrenOf(view.element('rest-list')).find(item=>item.tagName==='button'&&item.textContent==='@mention').onclick();
  };
  mention();
  assert.equal(message.value,'@builder ');
  message.value='Xem bản sửa của @builder-extra.';
  mention();
  assert.equal(view.element('panel-board').hidden,false);
  assert.equal(message.value,'@builder Xem bản sửa của @builder-extra.');
  assert.ok(message.focused);
  mention();
  assert.equal(message.value,'@builder Xem bản sửa của @builder-extra.');
  view.element('composer-channel').value='qa';
  await view.element('compose').onsubmit({preventDefault(){}});
  assert.deepEqual(posts,[['/board/team/post',{channel:'qa',text:'@builder Xem bản sửa của @builder-extra.'}]]);
});

test('channel filtering keeps archived posts readable and Markdown uses safe nested DOM nodes',async()=>{
  const state={id:'team',title:'Kênh',cwd:'fixture',members:[{name:'builder',status:'done'}],
    channels:[{name:'main'},{name:'qa',archived:true},{name:'design'}],phase:'done',turns:1,turnLimit:4,events:[
      {seq:1,kind:'message',author:'builder',channel:'main',text:'Bài chính',targets:[]},
      {seq:2,kind:'message',author:'builder',channel:'qa',text:[
        '## Kết quả','- [done] **@builder xem #1**','- *Kiểm tra*',
        '1. [Tài liệu](https://example.test/guide)','2. [Không an toàn](javascript:alert)', '[stall]',
      ].join('\n'),targets:[]},
    ]};
  const view=await boardView(state);
  const filter=view.element('channel-filter');
  assert.ok(filter.children.some(option=>option.text.includes('#qa · Archived')));
  assert.ok(!view.element('composer-channel').children.some(option=>option.value==='qa'));
  filter.value='qa';
  filter.onchange();
  const items=childrenOf(view.element('feed'));
  assert.ok(!items.some(item=>item.textContent==='Bài chính'));
  for (const tagName of ['h4','ul','ol','strong','em']) assert.ok(items.some(item=>item.tagName===tagName),tagName);
  const bold=items.find(item=>item.tagName==='strong'&&item.textContent.includes('@builder xem'));
  assert.ok(childrenOf(bold).some(item=>item.className==='post-reference'));
  assert.deepEqual(items.filter(item=>item.tagName==='a').map(link=>[link.href,link.rel,link.target]),
    [['https://example.test/guide','noopener noreferrer','_blank']]);
  assert.deepEqual(items.filter(item=>item.className==='post-badge').map(item=>item.dataset.badge),['done','stall']);
});

test('standalone retirement requires a second trusted click and a running member model stays disabled',async()=>{
  const state={id:'team',title:'Quick actions',cwd:'fixture',members:[{name:'builder',status:'working'}],
    phase:'working',events:[],turns:1,turnLimit:4};
  const mutations=[];
  const view=await boardView(state,{request:(url,options)=>{
    if (!url.endsWith('/member-retire')) return;
    mutations.push(JSON.parse(options.body));
    return {...state,members:[{name:'builder',status:'working',retireAfterTurn:true}]};
  }});
  view.element('tab-members').onclick();
  const card=view.element('working-list');
  const action=label=>childrenOf(card).find(item=>item.tagName==='button'&&item.textContent===label);
  assert.equal(action('Switch model').disabled,true);
  action('Retire').onclick({isTrusted:false});
  assert.equal(action('Confirm retire'),undefined);
  action('Retire').onclick({isTrusted:true});
  assert.deepEqual(mutations,[]);
  await action('Confirm retire').onclick({isTrusted:true});
  assert.deepEqual(mutations,[{member:'builder'}]);
});

test('model controls hold the same place below member actions across a status change',async()=>{
  const state={id:'team',title:'Vị trí nút',cwd:'fixture',members:[{name:'builder',status:'working'}],
    phase:'working',events:[],turns:1,turnLimit:4};
  const view=await boardView(state);
  view.element('tab-members').onclick();
  const control=list=>{
    const card=view.element(list).firstElementChild;
    const {children}=card.children[1];
    const actionRow=children.findIndex(item=>item.className==='member-actions');
    assert.ok(actionRow>=0);
    assert.equal(children[actionRow+1]?.className,'model-editor');
    return childrenOf(children[actionRow+1]).find(item=>['button','summary'].includes(item.tagName));
  };
  assert.equal(control('working-list').disabled,true);
  await view.update({...state,members:[{name:'builder',status:'waiting'}],phase:'stalled'});
  const available=control('rest-list');
  assert.equal(available.tagName,'summary');
  assert.equal(available.textContent,'Switch model');
});

test('the journal opens inside Swarm from the member card and overview, and renders safe DOM',async()=>{
  const member={name:'builder',status:'working',threadId:'saved-builder'};
  const state={id:'team',title:'Nhật ký',cwd:'fixture',members:[member,{name:'reviewer',status:'waiting'}],
    phase:'working',events:[],turns:2,turnLimit:4};
  const journalPath='/board/team/member/builder/transcript';
  const report='[done] **Đã kiểm tra** <img src=x onerror=alert(1)> [mở thử](javascript:alert)';
  const requests=[];
  const view=await boardView(state,{live:true,request:(url,options)=>{
    if (url!==journalPath) return;
    requests.push(options);
    return {member:'builder',threadId:member.threadId,status:'working',live:{steps:[{label:'Bước đang chạy'}]},
      turns:[{id:'turn-1',status:'completed',steps:['Shell command','Edit file'],report}]};
  }});
  view.element('tab-members').onclick();
  const button=activeList=>childrenOf(view.element(activeList)).find(item=>item.textContent==='View journal'&&item.tagName==='button');
  const cardButton=button('working-list');
  assert.ok(cardButton);
  assert.equal(button('rest-list'),undefined);
  await cardButton.onclick();
  const dialog=view.element('member-transcript');
  assert.equal(dialog.open,true);
  assert.equal(view.element('transcript-title').textContent,'Journal · @builder');
  assert.equal(view.element('transcript-chat').href,'codex://threads/saved-builder');
  const rendered=childrenOf(view.element('transcript-turns'));
  assert.ok(rendered.some(item=>item.tagName==='strong'&&item.textContent==='Đã kiểm tra'));
  assert.match(view.element('transcript-turns').textContent,/Shell command/);
  assert.match(view.element('transcript-turns').textContent,/<img/);
  assert.ok(!rendered.some(item=>['img','a'].includes(item.tagName)));
  assert.match(view.element('transcript-activity').textContent,/Bước đang chạy/);
  view.streams[0].publish('activity',{builder:{steps:[{label:'Đã cập nhật'}]}});
  assert.match(view.element('transcript-activity').textContent,/Đã cập nhật/);

  await view.element('refresh-transcript').onclick();
  assert.equal(requests.length,2);
  assert.ok(requests.every(options=>!options.method||options.method==='GET'));
  view.element('close-transcript').onclick();
  assert.equal(dialog.open,false);
  assert.equal(cardButton.focused,true);
  view.element('tab-overview').onclick();
  const overviewButton=button('overview-members');
  await overviewButton.onclick();
  assert.equal(dialog.open,true);
  let cancelled=false;
  dialog.oncancel({preventDefault(){cancelled=true;}});
  assert.equal(cancelled,true);
  assert.equal(dialog.open,false);
  assert.equal(overviewButton.focused,true);
  assert.doesNotMatch(read('board.js'),/\binnerHTML\b/);
});

test('closing the journal aborts a pending read and ignores its late result',async()=>{
  const response=Promise.withResolvers();
  const entered=Promise.withResolvers();
  const state={id:'team',title:'Nhật ký',cwd:'fixture',members:[{name:'builder',status:'done',threadId:'saved-builder'}],
    phase:'done',events:[],turns:1,turnLimit:4};
  let signal;
  const view=await boardView(state,{request:(url,options)=>{
    if (!url.endsWith('/transcript')) return;
    signal=options.signal;
    entered.resolve();
    return response.promise;
  }});
  view.element('tab-members').onclick();
  const button=childrenOf(view.element('rest-list')).find(item=>item.textContent==='View journal'&&item.tagName==='button');
  const pending=button.onclick();
  await entered.promise;
  view.element('close-transcript').onclick();
  assert.equal(signal.aborted,true);
  response.resolve({member:'builder',threadId:'saved-builder',status:'done',live:null,
    turns:[{id:'old',status:'completed',steps:[],report:'Kết quả đến muộn.'}]});
  await pending;
  assert.doesNotMatch(view.element('transcript-turns').textContent,/Kết quả đến muộn/);
});
