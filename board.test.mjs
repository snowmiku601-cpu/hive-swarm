import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const read = name => readFileSync(new URL(name,import.meta.url),'utf8');

class ViewNode {
  children=[];
  dataset={};
  style={setProperty(k,v){this[k]=v;}};
  attributes={};
  clientWidth=420;
  clientHeight=350;
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
  remove() {this.removed=true;}
  click() {this.clicked=true;}
  setAttribute(name,value) {this.attributes[name]=value;}
  focus() {this.focused=true;}
  showModal() {this.open=true;}
  close() {this.open=false;}
  getContext() {return new Proxy({}, {get:(target,key)=>target[key]??(()=>{}),set:(target,key,value)=>(target[key]=value,true)});}
  scrollIntoView() {this.scrolled=true;}
  querySelector(selector) {
    const sequence=/^\[data-seq="(\d+)"\]$/.exec(selector)?.[1];
    return this.children.find(child=>String(child.dataset?.seq)===sequence);
  }
  get firstElementChild() {return this.children[0];}
}

function memStorage(seed={}) {
  const map=new Map(Object.entries(seed));
  return {
    getItem:key=>map.get(key)??null,
    setItem:(key,value)=>{map.set(key,String(value));},
    dump:()=>Object.fromEntries(map),
  };
}

async function boardView(initial,{path='/board/'+initial.id,request,live=false,darkMatches=false,localStore=memStorage(),sessionStore=memStorage(),hiveGif}={}) {
  const elements=new Map();
  const element=id=>{
    if (!elements.has(id)) elements.set(id,new ViewNode(id));
    return elements.get(id);
  };
  element('theme').append(new ViewNode('span'));
  const focusEvents=new Map(),visibilityEvents=new Map(),mediaListeners=[];
  const frame={addEventListener:(name,callback)=>focusEvents.set(name,callback)};
  const streams=[];
  const body=new ViewNode('body');
  const downloads=[];
  const createdUrls=[];
  const revokedUrls=[];
  class TestURL extends URL {
    static createObjectURL(blob) {
      const url='blob:test/'+(createdUrls.length+1);
      createdUrls.push({url,blob});
      return url;
    }
    static revokeObjectURL(url) {revokedUrls.push(url);}
  }
  class TestBlob {
    constructor(parts,opts={}){this.parts=parts;this.type=opts.type??'';}
  }
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
  const docElement=new ViewNode('html');
  const screen={
    window:frame,parent:frame,location:{pathname:path,origin:'http://127.0.0.1:17943',assign:url=>navigation.push(url)},
    document:{getElementById:element,documentElement:docElement,body:{append:(...nodes)=>{
      body.append(...nodes);
      for (const n of nodes) if (n.tagName==='a'&&n.download) downloads.push(n);
    }},
      addEventListener:(name,callback)=>visibilityEvents.set(name,callback),
      createElement:tag=>new ViewNode(tag),createTextNode:text=>({textContent:text})},
    Option:class {constructor(text,value) {Object.assign(this,{text,value});}},
    HiveBee:{sprite:()=>new ViewNode('svg')},
    HiveGif:hiveGif,
    ResizeObserver:class {observe(){}},
    localStorage:localStore,
    sessionStorage:sessionStore,
    Blob:TestBlob,
    devicePixelRatio:1,getComputedStyle:()=>({getPropertyValue:()=>'#d1a76a'}),
    URL:TestURL,URLSearchParams,Intl,AbortController,clearTimeout,setTimeout,EventSource:live?EventSource:undefined,
    matchMedia:query=>({
      matches:query.includes('dark')?darkMatches:false,
      addEventListener:(evt,cb)=>{if(evt==='change')mediaListeners.push(cb);},
    }),
    requestAnimationFrame:callback=>{queueMicrotask(callback);return 1;},
    setInterval:callback=>{poll=callback;return 1;},
    fetch:async (url,options)=>({ok:true,json:async()=>
      (await request?.(url,options))??(url.includes('/history?')
        ? {posts:state.events,head:state.events.at(-1)?.seq??0} : url==='/swarm/teams'?{teams:[]}:state)}),
  };
  runInNewContext(read('hive-graph.js')+'\n'+read('board.js'),screen);
  await new Promise(resolve=>setImmediate(resolve));
  return {element,docElement,navigation,streams,downloads,createdUrls,revokedUrls,localStore,sessionStore,
    update:async next=>{state=next;await poll();},
    emitDarkChange:matches=>{for (const cb of mediaListeners) cb({matches});},
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

test('overview keeps a long brief collapsed while live one-line summaries and journal links stay useful',async()=>{
  const state={id:'team',title:'Verify the release',task:'A long release brief.\n\n'+'Check each contract. '.repeat(35),
    cwd:'fixture',phase:'working',turns:3,turnLimit:8,members:[
      {name:'builder',status:'working',lastTurn:3,threadId:'saved-builder-thread'},
      {name:'reviewer',status:'waiting',waitFor:['builder']},
      {name:'verifier',status:'done'},
      {name:'broken',status:'failed'},
    ],activity:{builder:{steps:[{label:'Checking the release artifacts'}]}},events:[
      {seq:1,kind:'message',author:'verifier',text:'[done] All mocked checks pass.\nDetailed evidence follows.',targets:[]},
      {seq:2,kind:'status',author:'broken',text:'The local tool exited with code 2.',targets:[]},
    ]};
  const view=await boardView(state,{live:true});
  view.element('tab-overview').onclick();
  assert.equal(view.element('overview-goal').textContent,'Verify the release');
  assert.equal(view.element('overview-brief-details').hidden,false);
  assert.equal(Boolean(view.element('overview-brief-details').open),false);
  assert.equal(view.element('overview-brief').hidden,true);
  assert.equal(view.element('overview-brief-full').textContent,state.task.trim());
  const summaries=()=>childrenOf(view.element('overview-members')).filter(item=>item.className==='now-summary');
  assert.deepEqual(summaries().map(item=>item.textContent),[
    'Checking the release artifacts','Waiting on @builder','All mocked checks pass.','The local tool exited with code 2.',
  ]);
  assert.ok(childrenOf(view.element('overview-members')).some(item=>item.textContent==='View journal'));
  assert.ok(childrenOf(view.element('overview-members')).some(item=>item.className==='post-reference'&&item.textContent==='#1'));
  const builder=summaries()[0];
  view.element('overview-brief-details').open=true;
  view.streams[0].publish('activity',{builder:{steps:[{label:'Inspecting the final diff'}]}});
  assert.equal(builder.textContent,'Inspecting the final diff');
  assert.equal(view.element('overview-brief-details').open,true);
  await view.update({...state,activity:{builder:{steps:[]}}});
  assert.equal(summaries()[0].textContent,'Working on turn 3');
});

test('overview ranks attention and its quick links draft mentions or add exactly eight turns on a trusted click',async()=>{
  const state={id:'team',title:'Release',cwd:'fixture',phase:'stalled',turns:4,turnLimit:8,
    members:[{name:'builder',status:'waiting'},{name:'quota',status:'quota'},
      {name:'retired',status:'retired',workspace:{cwd:'fixture/worktree'}},
      {name:'coordinator',role:'coordinator',status:'waiting'}],events:[
        {seq:8,kind:'message',author:'builder',text:'[done] The patch is ready.',targets:[]},
      ],attention:[
        {kind:'dependency',member:'builder',chain:['reviewer','builder'],text:'Dependency wait: @reviewer -> @builder.'},
        {kind:'unaddressed',member:'builder',seq:8,text:'Unaddressed post #8. No member was @mentioned.'},
        {kind:'quota',member:'quota',text:'@quota hit model quota limit.'},
      ]};
  const mutations=[];
  const view=await boardView(state,{request:(url,options)=>{
    if (options?.method==='POST') mutations.push([url,JSON.parse(options.body)]);
  }});
  view.element('tab-overview').onclick();
  const rows=view.element('overview-alerts').children;
  assert.deepEqual(rows.map(row=>row.dataset.kind),['quota','unaddressed','dependency','worktree']);
  assert.ok(childrenOf(rows[1]).some(item=>item.className==='post-reference'&&item.textContent==='#8'));
  view.element('message').value='Please review the result.';
  childrenOf(rows[1]).find(item=>item.tagName==='button'&&item.textContent==='Mention @coordinator').onclick();
  assert.equal(view.element('message').value,'@coordinator Please review the result.');
  assert.equal(view.element('panel-board').hidden,false);
  assert.equal(view.element('message').focused,true);
  assert.deepEqual(mutations,[]);
  await view.update({...state,phase:'budget',turnLimit:4,attention:[{kind:'budget',text:'Turn limit reached (4/4).'}]});
  view.element('tab-overview').onclick();
  const add=childrenOf(view.element('overview-alerts')).find(item=>item.tagName==='button'&&item.textContent==='+8 turns');
  await add.onclick({isTrusted:false});
  assert.deepEqual(mutations,[]);
  await add.onclick({isTrusted:true});
  assert.deepEqual(mutations,[['/board/team/resume',{extraTurns:8}]]);
});

test('the coordinator Needs you state explains current stall or budget and clears after resuming',async()=>{
  const state={id:'team',title:'Release',cwd:'fixture',phase:'stalled',turns:2,turnLimit:4,events:[],
    members:[{name:'worker',status:'waiting'}],
    attention:[{kind:'unaddressed',member:'worker',seq:7,text:'Unaddressed post #7. No member was @mentioned.'}]};
  const view=await boardView(state);
  view.element('tab-members').onclick();
  let card=view.element('coordinator-list');
  assert.match(card.textContent,/Needs you/);
  assert.match(card.textContent,/Unaddressed post #7/);
  await view.update({...state,phase:'budget',turnLimit:2,attention:[{kind:'budget',text:'Turn limit reached (2/2).'}]});
  assert.match(card.textContent,/Needs you.*Turn limit reached \(2\/2\)/);
  await view.update({...state,phase:'working',attention:[],members:[{name:'worker',status:'working'}]});
  assert.doesNotMatch(card.textContent,/Needs you|Unaddressed post|Turn limit reached/);
});

test('active Overview retains blocked waits and shows only pending dependencies in now summaries',async()=>{
  const state={id:'team',title:'Active review',cwd:'fixture',phase:'working',turns:3,turnLimit:8,events:[],
    members:[{name:'reviewer',status:'waiting',waitFor:['alpha','beta'],pendingWaitFor:['beta']},
      {name:'alpha',status:'done'},{name:'beta',status:'quota'},{name:'observer',status:'working'}],
    attention:[{kind:'quota',member:'beta',text:'@beta hit model quota limit.'},
      {kind:'dependency',member:'beta',chain:['reviewer','beta'],text:'Dependency wait: @reviewer -> @beta.'},
      {kind:'cycle',member:'a',chain:['a','b','a'],text:'Circular wait: @a -> @b -> @a.'},
      {kind:'unaddressed',seq:1,text:'An old stall detail.'}]};
  const view=await boardView(state);
  view.element('tab-overview').onclick();
  assert.match(view.element('overview-alerts').textContent,/Dependency wait|Circular wait/);
  assert.doesNotMatch(view.element('overview-alerts').textContent,/old stall/);
  const summary=childrenOf(view.element('overview-members')).find(item=>item.className==='now-summary');
  assert.equal(summary.textContent,'Waiting on @beta');
});

test('graph shows elapsed time and distinguishes an unmentioned poster from a silent node',async()=>{
  const state={id:'team',title:'Replay',cwd:'fixture',phase:'done',turns:2,turnLimit:4,
    members:[{name:'builder',status:'done'},{name:'silent',status:'waiting'}],events:[
      {seq:1,kind:'brief',author:'coordinator',targets:['builder'],text:'Build',time:'2026-11-19T00:00:00Z'},
      {seq:2,kind:'message',author:'builder',targets:[],text:'[done] Built.',time:'2026-11-19T01:12:00Z'},
    ]};
  const view=await boardView(state);
  view.element('tab-graph').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(view.element('graph-total').textContent,'2 posts · 1h 12m');
  const nodes=view.element('graph-nodes').children;
  assert.equal(nodes.find(node=>node.dataset.graphName==='builder').dataset.unmentioned,'true');
  assert.equal(nodes.find(node=>node.dataset.graphName==='silent').dataset.unmentioned,'false');
  assert.equal(nodes.find(node=>node.dataset.graphName==='silent').dataset.muted,'true');
  view.element('first').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(view.element('graph-total').textContent,'2 posts · <1m · 1/2');
});

test('queen bee pixels add a gold crown in awake and sleeping poses while worker tints and Zzz stay crisp',()=>{
  const screen={document:{createElement:tag=>{
    const canvas=new ViewNode(tag);
    const pixels=new Map();
    canvas.pixels=pixels;
    const ctx={fillStyle:'',fillRect(x,y,w,h){
      assert.ok([x,y,w,h].every(Number.isInteger));
      assert.ok(x>=0&&y>=0&&x+w<=canvas.width&&y+h<=canvas.height);
      for(let dx=0;dx<w;dx++)for(let dy=0;dy<h;dy++)pixels.set((x+dx)+','+(y+dy),this.fillStyle);
    }};
    canvas.getContext=()=>ctx;
    return canvas;
  }}};
  runInNewContext(read('hive-bees.js'),screen);
  for(const status of ['working','waiting','quota','done','retired']) {
    const queen=screen.HiveBee.sprite('coordinator',{coordinator:true,status});
    const worker=screen.HiveBee.sprite('worker',{status,tint:0});
    assert.equal(queen.pixels.get('5,0'),'#ffd86b','central crown point is gold in '+status);
    assert.equal(queen.pixels.get('5,3'),'#fff3bf','crown jewel stays visible in '+status);
    assert.notEqual(worker.pixels.get('5,0'),'#ffd86b');
    assert.equal(worker.pixels.get('6,10'),'#75baef','worker tint remains blue');
    if(status!=='working') {
      assert.equal(queen.dataset.pose,'sleeping');
      assert.equal(queen.pixels.get('17,0'),'#d7dcff');
      assert.equal(worker.pixels.get('2,2'),'#d7dcff');
    }
  }
});

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
  assert.equal(view.element('overview-goal').textContent,state.title);
  assert.equal(view.element('overview-brief').textContent,state.task);
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

test('overview displays outcome threads ordered blocked -> active -> queued -> done',async()=>{
  const state={
    id:'team',title:'Outcome threads',cwd:'fixture',phase:'working',turns:3,turnLimit:12,
    threads:[
      {id:'t-done',title:'Docs polish',goal:'Update README',members:['docs']},
      {id:'t-active',title:'Engine core',goal:'Fix scheduler',members:['builder']},
      {id:'t-blocked',title:'DSH recovery',goal:'Unblock native runs',members:['native']},
    ],
    members:[
      {name:'docs',status:'done'},
      {name:'builder',status:'working',lastTurn:3},
      {name:'native',status:'failed',recoveryRequired:true},
    ],
    events:[{seq:1,kind:'message',author:'docs',text:'[done] README updated.',targets:[]}],
  };
  const mutations=[];
  const view=await boardView(state,{request:(url,options)=>{
    if (url.endsWith('/resolve-recovery')) {
      mutations.push(JSON.parse(options.body));
      return {...state,members:state.members.map(m=>m.name==='native'?{...m,recoveryRequired:false,status:'queued'}:m)};
    }
  }});
  view.element('tab-overview').onclick();
  assert.equal(view.element('overview-threads-panel').hidden,false);
  const threadTitles=childrenOf(view.element('overview-threads')).filter(n=>n.tagName==='strong').map(n=>n.textContent);
  assert.deepEqual(threadTitles,['DSH recovery','Engine core','Docs polish']);
  const retryBtn=childrenOf(view.element('overview-alerts')).find(n=>n.tagName==='button'&&/Retry fresh turn/i.test(n.textContent));
  assert.ok(retryBtn);
  await retryBtn.onclick({isTrusted:true});
  assert.deepEqual(mutations,[{member:'native',action:'retry'}]);
});

test('board renders executionMode badges, Verified route journal badges, and light/dark color-scheme metadata',async()=>{
  assert.match(read('board.html'),/<meta name="color-scheme" content="light dark">/i);
  const state={
    id:'team',title:'Modes & Routes',cwd:'fixture',phase:'working',turns:2,turnLimit:8,
    members:[
      {name:'builder',status:'working',executionMode:'attached',threadId:'saved-builder'},
      {name:'researcher',status:'waiting',executionMode:'subagent',subagentName:'researcher-1',threadId:'saved-researcher'},
      {name:'legacy',status:'done',executionMode:'session',threadId:'saved-legacy'},
    ],
    events:[
      {seq:1,kind:'brief',author:'coordinator',targets:['builder'],text:'Start build'},
      {seq:2,kind:'message',author:'builder',targets:['researcher'],text:'Check #1'},
    ],
  };
  const view=await boardView(state,{request:url=>{
    if (url.endsWith('/member/builder/transcript')) {
      return {member:'builder',threadId:'saved-builder',status:'working',live:null,turns:[
        {id:'turn-1',status:'completed',steps:['Verified route: openai/gpt-5.4 · high','Edit file'],report:'Done.'},
      ]};
    }
  }});
  view.element('tab-members').onclick();
  const badges=[...childrenOf(view.element('working-list')),...childrenOf(view.element('rest-list'))]
    .filter(n=>n.className==='mode-badge');
  assert.deepEqual(badges.map(b=>[b.dataset.mode,b.textContent]),[
    ['attached','Attached'],
    ['subagent','Subagent'],
    ['session','Session'],
  ]);
  const journalBtn=childrenOf(view.element('working-list')).find(n=>n.tagName==='button'&&n.textContent==='View journal');
  await journalBtn.onclick();
  const routeItems=childrenOf(view.element('transcript-turns')).filter(n=>n.className==='transcript-route');
  assert.equal(routeItems.length,1);
  assert.match(routeItems[0].textContent,/Verified route: openai\/gpt-5\.4 · high/);
  view.element('close-transcript').onclick();
  // Graph focus dims unrelated nodes
  view.element('tab-graph').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  const graphButtons=view.element('graph-nodes').children;
  const builderBtn=graphButtons.find(n=>n.dataset.graphName==='builder');
  builderBtn.onclick();
  await new Promise(resolve=>setImmediate(resolve));
  const updated=view.element('graph-nodes').children;
  assert.equal(updated.find(n=>n.dataset.graphName==='builder').dataset.dimmed,'false');
  assert.equal(updated.find(n=>n.dataset.graphName==='legacy').dataset.dimmed,'true');
});

test('reactive prefers-color-scheme: dark listener tracks OS preference until user overrides theme',async()=>{
  const view=await boardView({id:'team',title:'Theme test',cwd:'fixture',members:[],events:[],phase:'done'},{darkMatches:true});
  assert.equal(view.docElement.dataset.theme,'dark');
  view.emitDarkChange(false);
  assert.equal(view.docElement.dataset.theme,'light');
  view.emitDarkChange(true);
  assert.equal(view.docElement.dataset.theme,'dark');
  view.element('theme').onclick();
  assert.equal(view.docElement.dataset.theme,'light');
  assert.equal(view.localStore.getItem('team-board-color'),'light');
  view.emitDarkChange(true);
  assert.equal(view.docElement.dataset.theme,'light');
});

test('overview 2.1.0 renders goalLine, smartTaskLabel accordion with bee pills, synthesized Tasks thread, and Goal summary',async()=>{
  const state={
    id:'team',title:'Hive Swarm 2.1.0',goalLine:'Ship Antigravity Dashboard and bug fixes',
    coordinator:false,cwd:'fixture',phase:'done',turns:4,turnLimit:8,
    members:[
      {name:'core-fixes',status:'done',taskLabel:'Fix DSH and Codex bugs',threadId:'thread-core-fixes'},
      {name:'codex-ui',status:'working',brief:'You are Hive Swarm member @codex-ui for Hive Swarm 2.1.0. Overhaul Codex board UI in D:\\Codex CLI\\hive-swarm.',lastTurn:2},
    ],
    events:[
      {seq:1,kind:'message',author:'core-fixes',text:'[done] All 6 backend fixes committed.',targets:[]},
      {seq:2,kind:'message',author:'user',text:'[done] Goal summary confirmed without coordinator.',targets:[]},
    ],
  };
  const view=await boardView(state,{request:url=>{
    if (url.endsWith('/member/core-fixes/transcript')) {
      return {member:'core-fixes',threadId:'thread-core-fixes',status:'done',live:null,turns:[]};
    }
  }});
  view.element('tab-overview').onclick();
  assert.equal(view.element('overview-goal-line').hidden,false);
  assert.equal(view.element('overview-goal-line').textContent,'Ship Antigravity Dashboard and bug fixes');
  assert.equal(Boolean(view.element('overview-tasks-accordion').open),false);
  assert.equal(view.element('overview-tasks-heading').textContent,'1 of 2 tasks done');
  const taskTitles=childrenOf(view.element('overview-members')).filter(n=>n.className==='task-row-title').map(n=>n.textContent);
  assert.equal(taskTitles[0],'Fix DSH and Codex bugs');
  assert.doesNotMatch(taskTitles[1],/^You are/i);
  assert.match(taskTitles[1],/Overhaul Codex board UI/);
  const pills=childrenOf(view.element('overview-members')).filter(n=>n.className==='bee-pill');
  assert.deepEqual(pills.map(p=>p.textContent),['core-fixes','codex-ui']);
  await pills[0].onclick();
  assert.equal(view.element('member-transcript').open,true);
  assert.equal(view.element('transcript-title').textContent,'Journal · @core-fixes');
  view.element('close-transcript').onclick();
  // Auto-synthesized Tasks thread when team.threads is empty
  assert.equal(view.element('overview-threads-panel').hidden,false);
  assert.deepEqual(childrenOf(view.element('overview-threads')).filter(n=>n.tagName==='strong').map(n=>n.textContent),['Tasks']);
  assert.ok(childrenOf(view.element('overview-threads')).some(n=>n.className==='thread-fraction mono'&&n.textContent==='1/2'));
  // The team card renders Goal summary for coordinator: false
  assert.equal(view.element('overview-team-mode').hidden,false);
  assert.equal(view.element('overview-team-mode').textContent,'Goal summary');
  assert.match(view.element('overview-summary').textContent,/Goal summary confirmed without coordinator/);
  assert.match(view.element('overview-execution').textContent,/4\/8 turns/);
});

test('overview screenshots strip filters unsafe URLs and opens accessible lightbox with focus restoration',async()=>{
  const state={
    id:'team',title:'Visual verification',cwd:'fixture',phase:'done',turns:2,turnLimit:4,
    members:[{name:'ui',status:'done'}],
    screenshots:[
      {id:'5:0',seq:5,index:0,author:'ui',caption:'Hive honeycomb view',url:'/board/team/screenshot/5/0'},
      {id:'6:0',seq:6,index:0,author:'ui',caption:'Blocked bad scheme',url:'javascript:alert(1)'},
    ],
    events:[{seq:5,kind:'message',author:'ui',text:'Screenshot: out.png | Hive honeycomb view',targets:[]}],
  };
  const view=await boardView(state);
  view.element('tab-overview').onclick();
  assert.equal(view.element('overview-screenshots-panel').hidden,false);
  assert.equal(view.element('overview-screenshots-count').textContent,'1 capture');
  const thumbs=childrenOf(view.element('overview-screenshots')).filter(n=>n.className==='screenshot-thumb-btn');
  assert.equal(thumbs.length,1);
  thumbs[0].onclick();
  const lightbox=view.element('screenshot-lightbox');
  assert.equal(lightbox.open,true);
  assert.equal(view.element('lightbox-caption').textContent,'Hive honeycomb view');
  assert.equal(view.element('lightbox-image').src,'/board/team/screenshot/5/0');
  view.element('close-lightbox').onclick();
  assert.equal(lightbox.open,false);
  assert.equal(thumbs[0].focused,true);
});

test('graph defaults to Hive mode, persists Mentions mode in sessionStorage, renders pills, and exports GIF',async()=>{
  const html=read('board.html');
  assert.match(html,/id="hide-inactive"[^>]*\bswitch\b/);
  assert.match(html,/id="expand-all"[^>]*\bswitch\b/);
  const sharedSession=memStorage();
  const gifCalls=[];
  const mockGif={
    async exportGraphReplayGif(opts) {
      gifCalls.push(opts);
      return {bytes:new Uint8Array([0x47,0x49,0x46,0x38,0x39,0x61,0x3B]),frameCount:6,width:opts.width,height:opts.height};
    },
  };
  const state={
    id:'team',title:'Antigravity Swarm UI',cwd:'fixture',phase:'done',turns:3,turnLimit:8,
    members:[
      {name:'coordinator',role:'coordinator',status:'waiting'},
      {name:'builder',status:'done'},
      {name:'legacy',status:'retired'},
    ],
    events:[
      {seq:1,kind:'brief',author:'coordinator',targets:['builder'],text:'Build UI',time:'2026-11-21T10:00:00Z'},
      {seq:2,kind:'message',author:'builder',targets:[],text:'[done] UI complete.',time:'2026-11-21T10:05:00Z'},
    ],
  };
  const view=await boardView(state,{sessionStore:sharedSession,hiveGif:mockGif,darkMatches:false});
  view.element('tab-graph').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  // Default mode is Hive
  assert.equal(view.element('graph-mode-hive').attributes['aria-pressed'],'true');
  assert.equal(view.element('graph-mode-mentions').attributes['aria-pressed'],'false');
  assert.equal(view.element('mentions-options').hidden,true);
  assert.equal(view.element('legend-hive').hidden,false);
  assert.equal(view.element('legend-mentions').hidden,true);
  assert.equal(view.element('graph-stage').dataset.mode,'hive');
  assert.ok(view.element('graph-nodes').children.every(n=>n.className==='graph-node graph-hive-bee'));

  // Switch to Mentions mode
  view.element('graph-mode-mentions').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sharedSession.getItem('hive-swarm-graph-mode'),'mentions');
  assert.equal(view.element('mentions-options').hidden,false);
  assert.equal(view.element('legend-mentions').hidden,false);
  assert.equal(view.element('graph-stage').dataset.mode,'mentions');
  const pills=view.element('graph-nodes').children;
  assert.ok(pills.every(n=>n.className==='graph-node graph-pill-node'));
  const coordPill=pills.find(n=>n.dataset.graphName==='coordinator');
  const legacyPill=pills.find(n=>n.dataset.graphName==='legacy');
  const builderPill=pills.find(n=>n.dataset.graphName==='builder');
  assert.equal(legacyPill.dataset.status,'retired');
  assert.equal(builderPill.dataset.unmentioned,'true');
  assert.ok(Number.parseFloat(coordPill.style.top)<Number.parseFloat(legacyPill.style.top));

  // Export GIF delegates to HiveGif.exportGraphReplayGif and triggers download
  await view.element('export-gif').onclick();
  assert.equal(gifCalls.length,1);
  assert.equal(gifCalls[0].mode,'mentions');
  assert.equal(gifCalls[0].theme,'light');
  assert.equal(view.downloads.length,1);
  assert.equal(view.downloads[0].download,'antigravity-swarm-ui-graph.gif');
  assert.match(view.element('notice').textContent,/Exported antigravity-swarm-ui-graph\.gif \(6 frames\)/);

  // Second view sharing sessionStorage remembers Mentions, and inline fallback produces valid GIF89a without HiveGif
  const second=await boardView(state,{sessionStore:sharedSession});
  second.element('tab-graph').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(second.element('graph-mode-mentions').attributes['aria-pressed'],'true');
  await second.element('export-gif').onclick();
  assert.equal(second.downloads.length,1);
  const rawGif=second.createdUrls[0].blob.parts[0];
  assert.equal(Buffer.from(rawGif.slice(0,6)).toString('ascii'),'GIF89a');
  assert.equal(rawGif[rawGif.length-1],0x3B);
});
