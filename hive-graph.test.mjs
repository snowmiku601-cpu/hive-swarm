import assert from 'node:assert/strict';
import test from 'node:test';
import './hive-graph.js';

const {project,isPost} = globalThis.HiveGraph;
const members = [{name:'alpha'},{name:'beta'},{name:'retired-one',status:'retired'}];
const posts = [
  {seq:1,kind:'status',author:'system',targets:[]},
  {seq:2,kind:'brief',author:'coordinator',targets:['alpha']},
  {seq:3,kind:'message',author:'alpha',targets:['beta']},
  {seq:4,kind:'message',author:'alpha',targets:['beta']},
  {seq:5,kind:'message',author:'coordinator',targets:['alpha','beta'],broadcast:true},
  {seq:6,kind:'message',author:'beta',targets:['alpha']},
];

test('the directed graph replays counts at the selected post and keeps broadcasts optional', () => {
  assert.equal(posts.filter(isPost).length,5);
  const early=project(posts,members,3,{});
  assert.deepEqual(early.links.map(({from,to,count})=>[from,to,count]),[
    ['coordinator','alpha',1],['alpha','beta',1],
  ]);
  const collapsed=project(posts,members,6,{});
  assert.equal(collapsed.links.find(edge=>edge.from==='alpha'&&edge.to==='beta').count,2);
  assert.equal(collapsed.broadcasts,1);
  assert.ok(!collapsed.links.some(link=>link.from==='coordinator'&&link.to==='beta'));
  const expanded=project(posts,members,6,{expandBroadcast:true});
  const edge=expanded.links.find(link=>link.from==='coordinator'&&link.to==='alpha');
  assert.deepEqual([edge.count,edge.direct,edge.broadcast],[2,1,1]);
  assert.ok(expanded.links.some(link=>link.from==='beta'&&link.to==='alpha'));
});

test('quiet and retired names can be omitted from a replay without changing later history', () => {
  const projected=project(posts,members,2,{hideInactive:true});
  assert.deepEqual(projected.nodes.map(node=>node.name),['coordinator','alpha']);
  assert.ok(project(posts,members,6,{}).nodes.some(node=>node.name==='retired-one'));
});

test('elapsed spans use replay timestamps or the current live time and tolerate missing or skewed dates', () => {
  const {elapsedSpan}=globalThis.HiveGraph;
  const dated=[{time:'2026-11-19T00:00:00Z'},{time:'invalid'},{time:'2026-11-19T01:12:00Z'}];
  assert.equal(elapsedSpan(dated),'1h 12m');
  assert.equal(elapsedSpan(dated.slice(0,1)),'<1m');
  assert.equal(elapsedSpan(dated,{live:true,now:Date.parse('2026-11-19T02:00:00Z')}),'2h');
  assert.equal(elapsedSpan([]),'<1m');
  assert.equal(elapsedSpan([{time:'invalid'}]),'<1m');
  assert.equal(elapsedSpan(dated.slice().reverse()),'<1m');
  assert.equal(elapsedSpan([{time:'2026-11-19T00:00:00Z'},{time:'2026-11-19T00:00:59Z'}]),'<1m');
});

test('unmentioned posts stay distinct from silent members and collapsed broadcasts at every replay position', () => {
  const events=[
    {seq:1,kind:'message',author:'alpha',targets:[],text:'A result without a recipient.'},
    {seq:2,kind:'message',author:'beta',targets:[],broadcast:true,text:'@all Progress.'},
    {seq:3,kind:'message',author:'alpha',targets:['beta'],text:'@beta Please review.'},
  ];
  const early=project(events,members,1,{});
  assert.equal(early.nodes.find(node=>node.name==='alpha').unmentioned,1);
  assert.equal(early.nodes.find(node=>node.name==='beta').posts,undefined);
  const collapsed=project(events,members,2,{});
  assert.equal(collapsed.nodes.find(node=>node.name==='beta').unmentioned,0);
  assert.equal(collapsed.nodes.find(node=>node.name==='beta').broadcasts,1);
  const later=project(events,members,3,{});
  assert.equal(later.nodes.find(node=>node.name==='alpha').mentions,1);
  assert.equal(later.nodes.find(node=>node.name==='alpha').unmentioned,1);
});

test('a mention to the external coordinator replaces the no-outgoing-mention classification',()=>{
  const events=[{seq:1,kind:'message',author:'alpha',targets:[],text:'The patch is ready.'},
    {seq:2,kind:'message',author:'alpha',targets:[],coordinatorMention:true,text:'@coordinator Please review.'}];
  const projection=project(events,members,2,{});
  const alpha=projection.nodes.find(node=>node.name==='alpha');
  assert.equal(alpha.mentions,1);
  assert.equal(globalThis.HiveGraph.unmentionedNode(alpha),false);
  assert.ok(projection.links.some(link=>link.from==='alpha'&&link.to==='coordinator'));
});

test('small and dense graph layouts keep node labels inside the stage and apart', () => {
  const {layout,minimumHeight}=globalThis.HiveGraph;
  for (const count of [2,3,4,5,6,7,10,13,16]) for (const width of [300,398,420,680,1120]) {
    const nodes=Array.from({length:count},(_,i)=>({name:'member-'+i,role:i===0?'coordinator':'worker'}));
    const height=Math.max(328,minimumHeight(count,width));
    const points=[...layout(nodes,width,height).values()];
    assert.equal(points.length,count);
    for (const point of points) {
      assert.ok(point.x>=45&&point.x<=width-45,'label fits horizontally: '+count+'/'+width);
      assert.ok(point.y>=32&&point.y<=height-64,'node fits vertically: '+count+'/'+width);
    }
    for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++) {
      assert.ok(Math.abs(points[i].x-points[j].x)>=94||Math.abs(points[i].y-points[j].y)>=92,
        'node labels overlap: '+count+'/'+width+' members '+i+'/'+j);
    }
  }
});

test('the canvas rings only nodes with posts but no outgoing mention or broadcast', () => {
  const arcs=[];
  const ctx=new Proxy({}, {get:(target,key)=>target[key]??(()=>{}),set:(target,key,value)=>(target[key]=value,true)});
  ctx.arc=(...args)=>arcs.push(args);
  const canvas={clientWidth:420,clientHeight:350,getContext:()=>ctx};
  const projection={nodes:[
    {name:'poster',posts:1,unmentioned:1,mentions:0,broadcasts:0},
    {name:'silent'},
    {name:'broadcast',posts:1,unmentioned:0,mentions:0,broadcasts:1},
    {name:'direct',posts:2,unmentioned:1,mentions:1,broadcasts:0},
  ],links:[]};
  globalThis.devicePixelRatio=1;
  globalThis.HiveGraph.draw(canvas,projection,new Map(projection.nodes.map((n,i)=>[n.name,{x:50+i*100,y:100}])),null,0,{grid:'#111',edge:'#222',accent:'#333'});
  assert.equal(arcs.length,1);
  assert.deepEqual(arcs[0].slice(0,3),[50,100,31]);
});
