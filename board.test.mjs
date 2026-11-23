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
  getContext() {
    if (this._ctx) return this._ctx;
    const ops=this.canvasOps??=[];
    const rec=(op,args)=>ops.push({op,args});
    this._ctx=new Proxy({}, {
      get:(target,key)=>target[key]??((...args)=>{rec(key,args);}),
      set:(target,key,value)=>(target[key]=value,rec('set:'+key,[value]),true),
    });
    return this._ctx;
  }
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

async function boardView(initial,{path='/board/'+initial.id,request,live=false,darkMatches=false,localStore=memStorage(),sessionStore=memStorage(),hiveGif,hiveGraphExt,version}={}) {
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
    ...(version?{__HIVE_SWARM_VERSION__:version}:{}),
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
  const extCode=hiveGraphExt?'globalThis.HiveGraph = { ...globalThis.HiveGraph, ...globalThis.__EXT__ };\n':'';
  if (hiveGraphExt) screen.__EXT__=hiveGraphExt;
  runInNewContext(read('hive-graph.js')+'\n'+extCode+read('board.js'),screen);
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

test('threads count retired members as done and Hive connectors route self-loops while offsetting concurrent edges',async()=>{
  const state={
    id:'team',title:'Connector & Thread Audit',cwd:'fixture',phase:'working',turns:2,turnLimit:8,
    threads:[{id:'t-retired',title:'Retired stream',goal:'Done work',members:['legacy']}],
    members:[
      {name:'coordinator',role:'coordinator',status:'waiting'},
      {name:'legacy',status:'retired'},
      {name:'waiter',status:'waiting',pendingWaitFor:['legacy']},
    ],
    events:[
      {seq:1,kind:'message',author:'legacy',targets:['coordinator'],text:'[done] Retired after completing.',time:'2026-11-21T10:00:00Z'},
    ],
  };
  const customGraph={
    projectHive:()=>({
      currentSeq:1,lastPost:{seq:1},
      coordinator:{name:'coordinator',role:'coordinator',status:'waiting',doneCount:1,totalWorkers:1,phase:'working'},
      clusters:[
        {id:'done',label:'Done',tone:'done',count:1,members:[{name:'legacy',status:'retired',role:'worker'}]},
        {id:'waiting',label:'Waiting',tone:'waiting',count:1,members:[{name:'waiter',status:'waiting',role:'worker'}]},
      ],
      connectors:[
        {from:'done',to:'coordinator',kind:'done',label:'Tasks done'},
        {from:'done',to:'coordinator',kind:'message',label:'Message just sent',seq:1},
        {from:'waiting',to:'waiting',kind:'waiting',label:'Self loop'},
      ],
    }),
    layoutHive:(_m,w,h)=>{
      const verts=(cx,cy,r)=>Array.from({length:6},(_,k)=>({x:cx+r*Math.cos(k*Math.PI/3),y:cy+r*Math.sin(k*Math.PI/3)}));
      const doneCell={id:'done',label:'Done',tone:'done',count:1,x:140,y:120,radius:70,vertices:verts(140,120,70),slots:[{member:{name:'legacy',status:'retired'},x:140,y:120}]};
      const waitCell={id:'waiting',label:'Waiting',tone:'waiting',count:1,x:280,y:120,radius:70,vertices:verts(280,120,70),slots:[{member:{name:'waiter',status:'waiting'},x:280,y:120}]};
      const coordCell={id:'coordinator',x:210,y:270,radius:70,vertices:verts(210,270,70),model:{doneCount:1,totalWorkers:1,phase:'working'}};
      return {width:w,height:h,radius:70,coordinator:coordCell,clusters:[doneCell,waitCell],
        cellsById:new Map([['done',doneCell],['waiting',waitCell],['coordinator',coordCell]])};
    },
    hiveMinimumHeight:()=>420,
  };
  const view=await boardView(state,{hiveGraphExt:customGraph});
  view.element('tab-overview').onclick();
  assert.match(view.element('overview-threads').textContent,/Done/);
  assert.ok(childrenOf(view.element('overview-threads')).some(n=>n.className==='thread-fraction mono'&&n.textContent==='1/1'));

  view.element('tab-graph').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  const ops=view.element('graph-canvas').canvasOps;
  const moves=ops.filter(item=>item.op==='moveTo').map(item=>item.args);
  assert.equal(moves.length>=2,true);
  const [mDone,mMsg]=moves;
  const dist=Math.hypot(mMsg[0]-mDone[0],mMsg[1]-mDone[1]);
  assert.ok(dist>=7.5&&dist<=9.5,'Expected ~8px lateral offset between concurrent done and message connectors, got '+dist);
  const selfLoops=ops.filter(item=>item.op==='bezierCurveTo');
  assert.equal(selfLoops.length,1);
  const dashedWires=ops.filter(item=>item.op==='setLineDash'&&item.args[0]?.length>0);
  assert.equal(dashedWires.length,1);
});

test('Antigravity Board filter toggle, post clamping, Latest pill, and clickable Member cards work cleanly',async()=>{
  const longText=Array.from({length:9},(_,i)=>'Line '+(i+1)+' of Codex output evidence.').join('\n');
  const state={
    id:'team',title:'Board & Members Polish',cwd:'fixture',phase:'working',turns:2,turnLimit:8,
    members:[
      {name:'builder',status:'working',model:'gpt-5.4',effort:'high',threadId:'thread-builder-01',taskLabel:'Polish Board'},
    ],
    events:[
      {seq:1,kind:'message',author:'builder',text:longText,targets:[],time:'2026-11-21T10:00:00Z'},
    ],
  };
  const view=await boardView(state,{live:true});
  // Filter drawer starts hidden, toggle reveals it
  assert.equal(view.element('board-filters').hidden,true);
  view.element('toggle-board-filters').onclick();
  assert.equal(view.element('board-filters').hidden,false);
  assert.equal(view.element('toggle-board-filters').attributes['aria-expanded'],'true');
  // Long post is clamped until Show more clicked
  const msg=childrenOf(view.element('feed')).find(n=>n.className==='message');
  const more=childrenOf(view.element('feed')).find(n=>n.className==='expand-post-btn');
  assert.equal(msg.dataset.clamped,'true');
  assert.equal(more.textContent,'Show more');
  more.onclick();
  assert.equal(msg.dataset.clamped,'false');
  assert.equal(more.textContent,'Show less');
  // Unfollowing surfaces Latest pill, clicking Latest restores follow
  view.element('follow').onclick();
  assert.equal(view.element('board-latest').hidden,false);
  view.element('board-latest').onclick();
  assert.equal(view.element('board-latest').hidden,true);
  assert.equal(view.element('follow').attributes['aria-pressed'],'true');
  // Clickable member row opens transcript in standalone unless nested button owns click; overflow ⋯ toggles menu cleanly
  view.element('tab-members').onclick();
  const card=view.element('working-list').firstElementChild;
  assert.equal(card.dataset.clickable,'true');
  assert.equal(card.dataset.menuOpen,'false');
  const menuBtn=childrenOf(card).find(n=>n.className==='member-menu-btn');
  assert.ok(menuBtn,'Expected quiet overflow menu toggle button on Member row');
  menuBtn.onclick({stopPropagation(){}});
  assert.equal(card.dataset.menuOpen,'true');
  assert.equal(menuBtn.attributes['aria-expanded'],'true');
  assert.notEqual(view.element('member-transcript').open,true);
  card.onclick({target:{closest:selector=>selector.includes('button')?{}:null}});
  assert.notEqual(view.element('member-transcript').open,true);
  await card.onclick({target:{closest:()=>null}});
  assert.equal(view.element('member-transcript').open,true);
});

test('board header renders version badge and update reminder pill below it with dismiss persistence',async()=>{
  const localStore=memStorage();
  const state={
    id:'team',title:'Version Check',cwd:'fixture',phase:'working',turns:1,turnLimit:8,
    members:[{name:'builder',status:'working',model:'gpt-5.4'}],
    events:[],
  };
  const view=await boardView(state,{
    version:'2.1.0',
    localStore,
    request:url=>url==='/swarm/update'
      ? {current:'2.1.0',latest:'2.2.0',available:true,url:'https://github.com/snowmiku601-cpu/hive-swarm/releases/tag/v2.2.0',checked:true}
      : undefined,
  });
  assert.equal(view.element('app-version').hidden,false);
  assert.equal(view.element('app-version').textContent,'v2.1.0');
  assert.equal(view.element('update-wrap').hidden,false);
  assert.equal(view.element('update-pill').textContent,'↑ v2.2.0 available');
  assert.equal(view.element('update-popover').hidden,true);

  view.element('update-pill').onclick({stopPropagation(){}});
  assert.equal(view.element('update-popover').hidden,false);
  assert.equal(view.element('update-diff').textContent,'v2.1.0 → v2.2.0');
  assert.equal(view.element('update-cmd').textContent,'npx hive-swarm@latest update --host codex --after-close');
  assert.equal(view.element('update-link').href,'https://github.com/snowmiku601-cpu/hive-swarm/releases/tag/v2.2.0');

  view.element('update-dismiss').onclick();
  assert.equal(view.element('update-wrap').hidden,true);
  assert.equal(localStore.getItem('hive-swarm-dismissed-update'),'2.2.0');
});

test('standalone Members overflow shows Cancel turn only for working workers and posts cancel-turn',async()=>{
  const state={
    id:'team',title:'Cancel Check',cwd:'fixture',phase:'working',turns:2,turnLimit:8,
    members:[{name:'builder',status:'working'},{name:'qa',status:'done'}],
    events:[],
  };
  const posts=[];
  const view=await boardView(state,{
    request:(url,options)=>{
      if (url.endsWith('/cancel-turn')) {
        posts.push([url,JSON.parse(options.body)]);
        return {...state,phase:'stalled',members:[{name:'builder',status:'failed'},{name:'qa',status:'done'}]};
      }
    },
  });
  view.element('tab-members').onclick();
  const workingBtns=childrenOf(view.element('working-list')).filter(n=>n.tagName==='button'&&n.textContent==='Cancel turn');
  const restBtns=childrenOf(view.element('member-list')).filter(n=>n.tagName==='button'&&n.textContent==='Cancel turn');
  assert.equal(workingBtns.length,1);
  assert.equal(restBtns.length,0);
  await workingBtns[0].onclick({isTrusted:true});
  assert.deepEqual(posts,[['/board/team/cancel-turn',{member:'builder'}]]);
});

test('specialized honeycomb wires threads/channels, Ring-2 height, wrapped titles, tooltips, palette, and GIF options',async()=>{
  const html=read('board.html');
  assert.match(html,/id="graph-hexes"/);
  const gifCalls=[];
  const mockGif={
    async exportGraphReplayGif(opts) {
      gifCalls.push(opts);
      return {bytes:new Uint8Array([0x47,0x49,0x46,0x38,0x39,0x61,0x3B]),frameCount:4,width:opts.width,height:opts.height};
    },
  };
  const threads=[
    {id:'core-eng',title:'Core Engine, Bug Fixes & Worktrees',goal:'Harden scheduler and worktrees',members:['alpha','alpha-2']},
    {id:'ui-polish',title:'Dashboard UI',goal:'Match Antigravity honeycomb',members:['beta']},
  ];
  const channels=[{name:'main'},{name:'ops',topic:'Operations'}];
  const state={
    id:'team',title:'Specialized Honeycomb',cwd:'fixture',phase:'working',turns:4,turnLimit:10,
    threads,channels,
    members:[
      {name:'coordinator',role:'coordinator',status:'waiting'},
      {name:'alpha',status:'done'},
      {name:'alpha-2',status:'done'},
      {name:'beta',status:'working'},
      {name:'extra',status:'done'},
    ],
    events:[
      {seq:1,kind:'message',author:'alpha',targets:['alpha-2'],text:'Intra-hex handoff',time:'2026-11-22T10:00:00Z'},
      {seq:2,kind:'message',author:'beta',targets:['coordinator'],text:'Building UI',time:'2026-11-22T10:01:00Z'},
    ],
  };
  const view=await boardView(state,{hiveGif:mockGif,darkMatches:false});
  view.element('tab-graph').onclick();
  await new Promise(resolve=>setImmediate(resolve));

  const ops=view.element('graph-canvas').canvasOps;
  const drawnTexts=ops.filter(o=>o.op==='fillText').map(o=>o.args[0]);
  assert.ok(drawnTexts.includes('2/2'),'renders done/total subtitle for Core group');
  assert.ok(drawnTexts.includes('0/1'),'renders 0/1 subtitle for UI group');
  assert.ok(drawnTexts.includes('1/1'),'renders 1/1 subtitle for Other group');
  assert.ok(drawnTexts.includes('3 of 4 done'),'renders X of Y done on Coordinator');
  assert.ok(drawnTexts.some(t=>t.includes('Core Engine')),'renders wrapped group title lines');

  const fillColors=ops.filter(o=>o.op==='set:fillStyle').map(o=>o.args[0]);
  const strokeColors=ops.filter(o=>o.op==='set:strokeStyle').map(o=>o.args[0]);
  assert.ok(fillColors.includes('#edf7ed')&&strokeColors.includes('#4d9938'),'uses light themePalette done colors');
  assert.ok(fillColors.includes('#ffffff')&&strokeColors.includes('#d0d7de'),'uses light themePalette neutral surface/border for 0/1 group hex');

  const hexBtns=view.element('graph-hexes').children;
  const coreHex=hexBtns.find(n=>n.dataset.clusterId==='core-eng');
  assert.ok(coreHex,'renders interactive hex overlay for core-eng');
  assert.match(coreHex.title,/Core Engine, Bug Fixes & Worktrees · 2\/2 done · alpha, alpha-2/);
  assert.match(coreHex.title,/Harden scheduler and worktrees/);

  await view.element('export-gif').onclick();
  assert.equal(gifCalls.length,1);
  assert.deepEqual(gifCalls[0].threads,threads);
  assert.deepEqual(gifCalls[0].channels,channels);

  // Ring-2 layout with 9 clusters grows stage height dynamically above 490px
  const ring2Threads=Array.from({length:8},(_,i)=>({id:'g-'+i,title:'Stream '+i,members:['w-'+i]}));
  const ring2State={
    id:'ring2',title:'Ring-2 Honeycomb',cwd:'fixture',phase:'working',turns:1,turnLimit:12,
    threads:ring2Threads,
    members:[
      {name:'coordinator',role:'coordinator',status:'waiting'},
      ...Array.from({length:8},(_,i)=>({name:'w-'+i,status:i%2===0?'done':'working'})),
      {name:'unassigned',status:'done'},
    ],
    events:[],
  };
  const ring2View=await boardView(ring2State);
  ring2View.element('tab-graph').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  const stageH=Number.parseInt(ring2View.element('graph-stage').style.height,10);
  assert.ok(stageH>490,'expected Ring-2 stage height > 490px, got '+stageH);
});

test('Hive routed connectors draw curved outer edges, self-loops, arrowheads, and mid-replay Waiting on',async()=>{
  const threads=[
    {id:'nw',title:'North West',members:['a','a2']},
    {id:'ne',title:'North East',members:['b']},
    {id:'sw',title:'South West',members:['c']},
    {id:'se',title:'South East',members:['d']},
  ];
  const state={
    id:'team',title:'Routed Connectors',cwd:'fixture',phase:'working',turns:2,turnLimit:8,
    threads,
    members:[
      {name:'coordinator',role:'coordinator',status:'waiting'},
      {name:'a',status:'done'},
      {name:'a2',status:'done'},
      {name:'b',status:'working'},
      {name:'c',status:'waiting',waitFor:['b']},
      {name:'d',status:'working'},
    ],
    events:[
      {seq:1,kind:'message',author:'a',targets:['a2'],text:'Intra-hex ping',time:'2026-11-22T10:00:00Z'},
      {seq:2,kind:'message',author:'a',targets:['d'],text:'@d outer-to-outer curved msg',time:'2026-11-22T10:01:00Z'},
    ],
  };
  const view=await boardView(state);
  view.element('tab-graph').onclick();
  await new Promise(resolve=>setImmediate(resolve));

  // At head (seq 2): outer-to-outer diagonal nw -> se curves via quadraticCurveTo with arrowhead
  const headOps=view.element('graph-canvas').canvasOps;
  assert.ok(headOps.some(o=>o.op==='quadraticCurveTo'),'draws quadratic Bezier curve for outer-to-outer chord');
  assert.ok(headOps.some(o=>o.op==='setLineDash'&&o.args[0]?.length>0),'draws dashed Waiting on connector at head');

  // Step back to seq 1 (mid-replay): draws intra-hex self-loop (bezierCurveTo) AND mid-replay dashed Waiting on
  view.element('first').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  const midOps=view.element('graph-canvas').canvasOps;
  assert.ok(midOps.some(o=>o.op==='bezierCurveTo'),'draws cubic Bezier self-loop at seq 1');
  assert.ok(midOps.some(o=>o.op==='setLineDash'&&o.args[0]?.length>0),'draws mid-replay dashed Waiting on at seq 1');
});

test('Hive bee widths fit narrow slots, hex/bee focus dims unrelated hexes, blockedReason pills render, and no 2.1.1 version',async()=>{
  assert.doesNotMatch(read('board.js'),/'2\.1\.1'|"2\.1\.1"/,'no stale hardcoded 2.1.1 fallback version');

  const threads=[
    {id:'core',title:'Core Stream',members:['c1','c2']},
    {id:'ui',title:'UI Stream',members:['u1']},
  ];
  const state={
    id:'team',title:'Dense & Blocked',cwd:'fixture',phase:'working',turns:3,turnLimit:12,
    threads,
    members:[
      {name:'coordinator',role:'coordinator',status:'waiting'},
      {name:'c1',status:'done'},
      {name:'c2',status:'working'},
      {name:'u1',status:'queued',blockedReason:'shared-writer-active'},
      {name:'o1',status:'queued',blockedReason:'concurrency-limit'},
      {name:'o2',status:'waiting',blockedReason:'waiting-dependencies',waitFor:['u1']},
      {name:'o3',status:'done'},
      {name:'o4',status:'done'},
      {name:'o5',status:'done'},
    ],
    events:[
      {seq:1,kind:'message',author:'c1',targets:['u1'],text:'@u1 handoff',time:'2026-11-22T10:00:00Z'},
    ],
  };
  const view=await boardView(state);

  // Overview blockedReason pills
  view.element('tab-overview').onclick();
  const overviewPills=childrenOf(view.element('overview-members'))
    .filter(n=>n.className?.includes('blocked-reason-pill'))
    .map(n=>n.textContent);
  assert.ok(overviewPills.includes('Waiting for shared writer'));
  assert.ok(overviewPills.includes('Concurrency limit'));
  assert.ok(overviewPills.includes('Waiting on deps'));

  // Members tab blockedReason pills
  view.element('tab-members').onclick();
  const memberPills=childrenOf(view.element('rest-list'))
    .filter(n=>n.className?.includes('blocked-reason-pill'))
    .map(n=>n.textContent);
  assert.ok(memberPills.includes('Waiting for shared writer'));
  assert.ok(memberPills.includes('Concurrency limit'));
  assert.ok(memberPills.includes('Waiting on deps'));

  // Graph tab: narrow slotWidth (<46px) in dense Other 5-bee hex + Hive focus dimming
  view.element('tab-graph').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  const beeNodes=view.element('graph-nodes').children;
  const denseBee=beeNodes.find(n=>n.dataset.graphName==='o1');
  const denseW=Number.parseFloat(denseBee.style.width);
  assert.ok(denseW>=28&&denseW<46,'expected dense bee button width in [28, 46), got '+denseW);

  // Clicking c1 bee highlights its hex ('core') + connected hex ('ui') and dims unrelated hex ('other') & bees ('o1'..'o5')
  beeNodes.find(n=>n.dataset.graphName==='c1').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  const afterBeeClick=view.element('graph-nodes').children;
  assert.equal(afterBeeClick.find(n=>n.dataset.graphName==='c1').dataset.dimmed,'false');
  assert.equal(afterBeeClick.find(n=>n.dataset.graphName==='c2').dataset.dimmed,'false','same hex stays un-dimmed');
  assert.equal(afterBeeClick.find(n=>n.dataset.graphName==='u1').dataset.dimmed,'false','connected hex stays un-dimmed');
  assert.equal(afterBeeClick.find(n=>n.dataset.graphName==='o1').dataset.dimmed,'true','unrelated hex bee dims');
  assert.equal(view.element('graph-hexes').children.find(n=>n.dataset.clusterId==='other').dataset.dimmed,'true');

  // Clicking a hex highlights that hex + connected hexes and dims unrelated hexes/bees
  view.element('graph-hexes').children.find(n=>n.dataset.clusterId==='other').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  const afterHexClick=view.element('graph-nodes').children;
  assert.equal(afterHexClick.find(n=>n.dataset.graphName==='o1').dataset.dimmed,'false');
  assert.equal(afterHexClick.find(n=>n.dataset.graphName==='u1').dataset.dimmed,'false','connected ui stays un-dimmed');
  assert.equal(afterHexClick.find(n=>n.dataset.graphName==='c1').dataset.dimmed,'true','unrelated core bee dims');
  assert.equal(view.element('graph-hexes').children.find(n=>n.dataset.clusterId==='core').dataset.dimmed,'true');

  // Clear restores all
  view.element('clear-node').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(view.element('graph-nodes').children.every(n=>n.dataset.dimmed==='false'));

  // Non-standalone ui/initialize sends '' when version is absent
  const elements=new Map();
  const element=id=>(elements.has(id)?elements:elements.set(id,new ViewNode(id))).get(id);
  element('theme').append(new ViewNode('span'));
  const posted=[];
  const parentWin={addEventListener(){},postMessage:(msg)=>posted.push(msg)};
  const childWin={addEventListener(){}};
  const iframeScreen={
    window:childWin,parent:parentWin,location:{pathname:'/board/team',origin:'http://127.0.0.1:17943'},
    document:{getElementById:element,documentElement:new ViewNode('html'),body:{append(){}},addEventListener(){},
      createElement:tag=>new ViewNode(tag),createTextNode:text=>({textContent:text})},
    Option:class{constructor(text,value){Object.assign(this,{text,value});}},
    HiveBee:{sprite:()=>new ViewNode('svg')},
    ResizeObserver:class{observe(){}},
    URL,URLSearchParams,Intl,AbortController,clearTimeout,setTimeout,clearInterval,setInterval:()=>1,
    matchMedia:()=>({matches:false,addEventListener(){}}),
    requestAnimationFrame:cb=>{queueMicrotask(cb);return 1;},
    addEventListener(){},
  };
  runInNewContext(read('hive-graph.js')+'\n'+read('board.js'),iframeScreen);
  const initMsg=posted.find(m=>m.method==='ui/initialize');
  assert.ok(initMsg);
  assert.equal(initMsg.params.appInfo.version,'');
});

test('Codex board Hive canvas draws Antigravity progress-ring overlays, neutral surface fills, enhanced tooltips, and preserves status mode',async()=>{
  const threads=[
    {id:'zero',title:'Zero Stream',goal:'Start soon',members:['z1','z2']},
    {id:'partial',title:'Partial Stream',goal:'Finish build',members:['p1','p2']},
    {id:'done',title:'Done Stream',members:['d1','d2']},
    {id:'needs',title:'Needs Stream',members:['n1']},
  ];
  const groupState={
    id:'team',title:'Progress Ring Board',cwd:'fixture',phase:'working',turns:3,turnLimit:12,
    threads,
    members:[
      {name:'coordinator',role:'coordinator',status:'waiting'},
      {name:'z1',status:'working'},
      {name:'z2',status:'waiting'},
      {name:'p1',status:'done'},
      {name:'p2',status:'working'},
      {name:'d1',status:'done'},
      {name:'d2',status:'done'},
      {name:'n1',status:'failed'},
    ],
    events:[],
  };
  const view=await boardView(groupState,{darkMatches:false});
  view.element('tab-graph').onclick();
  await new Promise(resolve=>setImmediate(resolve));

  const ops=view.element('graph-canvas').canvasOps;
  const fills=ops.filter(o=>o.op==='set:fillStyle').map(o=>o.args[0]);
  assert.ok(fills.includes('#ffffff'),'partial/0% group hex fills with neutral palette.surface');
  assert.ok(fills.includes('#edf7ed'),'100% done group hex fills with palette.doneFill');
  assert.ok(fills.includes('#fdf0ef'),'needs hex fills with palette.needsFill');
  assert.ok(!fills.includes('#edf4fc'),'group mode omits workingFill');

  const strokeRecords=[];
  const cur={strokeStyle:'',lineWidth:1,lineCap:'butt',lineJoin:'miter'};
  for (const item of ops) {
    if (item.op==='set:strokeStyle') cur.strokeStyle=item.args[0];
    else if (item.op==='set:lineWidth') cur.lineWidth=item.args[0];
    else if (item.op==='set:lineCap') cur.lineCap=item.args[0];
    else if (item.op==='set:lineJoin') cur.lineJoin=item.args[0];
    else if (item.op==='stroke') strokeRecords.push({...cur});
  }
  assert.ok(strokeRecords.some(s=>s.strokeStyle==='#d0d7de'&&s.lineWidth===1.5),'draws neutral 1.5px border track');
  assert.ok(strokeRecords.some(s=>s.strokeStyle==='#cf483f'&&s.lineWidth===1.6),'draws needs 1.6px border track');
  assert.ok(strokeRecords.some(s=>s.strokeStyle==='#4d9938'&&s.lineWidth===2.2&&s.lineCap==='round'&&s.lineJoin==='round'),
    'draws 2.2px round green progress-ring perimeter overlay');

  const hexBtns=view.element('graph-hexes').children;
  const partialBtn=hexBtns.find(b=>b.dataset.clusterId==='partial');
  assert.equal(partialBtn.title,'Partial Stream · 1/2 done · p1, p2 — Finish build');
  const doneBtn=hexBtns.find(b=>b.dataset.clusterId==='done');
  assert.equal(doneBtn.title,'Done Stream · 2/2 done · d1, d2');

  // Legacy status mode (no threads/group/channels) keeps workingFill & workingStroke untouched
  const statusState={
    id:'legacy',title:'Legacy Status',cwd:'fixture',phase:'working',turns:1,turnLimit:4,
    members:[
      {name:'coordinator',role:'coordinator',status:'waiting'},
      {name:'w1',status:'working'},
    ],
    events:[],
  };
  const legacyView=await boardView(statusState,{darkMatches:false});
  legacyView.element('tab-graph').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  const legacyFills=legacyView.element('graph-canvas').canvasOps.filter(o=>o.op==='set:fillStyle').map(o=>o.args[0]);
  assert.ok(legacyFills.includes('#edf4fc'),'status mode working cluster still uses workingFill');
});
