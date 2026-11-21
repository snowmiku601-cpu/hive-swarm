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

test('nodeBox accounts for wrapped multi-line card names and asymmetric Codex hex labels', () => {
  const {nodeBox}=globalThis.HiveGraph;
  const shortCard=nodeBox({name:'qa',posts:30},{variant:'card'});
  const longCard=nodeBox({name:'design-research',posts:7},{variant:'card'});
  const assetCard=nodeBox({name:'asset-research',posts:4},{variant:'card'});
  assert.ok(longCard.halfH>shortCard.halfH,'wrapped design-research card must be taller than qa');
  assert.ok(assetCard.halfH>shortCard.halfH,'wrapped asset-research card must be taller than qa');
  assert.equal(shortCard.offsetY,0);
  const hex=nodeBox({name:'design-research',posts:7},{variant:'hex'});
  assert.ok(hex.offsetY>0,'Codex hex+label bounding box shifts downward to cover the label');
  assert.ok(hex.offsetY+hex.halfH>=46,'Codex box covers full label height below hex');
});

test('clipEdge and routeEdges keep every arrow and arrowhead cleanly outside node cards in the 6-node screenshot scenario', () => {
  const {layout,minimumHeight,nodeBox,routeEdges,roundedRectSignedDistance}=globalThis.HiveGraph;
  const screenshotNodes=[
    {name:'coordinator',role:'coordinator',status:'waiting',posts:4},
    {name:'design-research',role:'worker',status:'done',posts:7},
    {name:'asset-research',role:'worker',status:'done',posts:4},
    {name:'builder',role:'worker',status:'done',posts:34},
    {name:'qa',role:'worker',status:'done',posts:30},
    {name:'user',role:'worker',status:'observer',posts:43},
  ];
  const screenshotLinks=[
    {from:'coordinator',to:'design-research',count:2,direct:2,broadcast:0,lastSeq:10},
    {from:'coordinator',to:'asset-research',count:2,direct:2,broadcast:0,lastSeq:11},
    {from:'asset-research',to:'coordinator',count:1,direct:1,broadcast:0,lastSeq:12},
    {from:'user',to:'design-research',count:3,direct:3,broadcast:0,lastSeq:13},
    {from:'user',to:'coordinator',count:4,direct:4,broadcast:0,lastSeq:14},
    {from:'user',to:'qa',count:5,direct:5,broadcast:0,lastSeq:15},
    {from:'user',to:'builder',count:6,direct:6,broadcast:0,lastSeq:16},
    {from:'qa',to:'design-research',count:2,direct:2,broadcast:0,lastSeq:17},
    {from:'qa',to:'builder',count:12,direct:12,broadcast:0,lastSeq:18},
    {from:'builder',to:'qa',count:11,direct:11,broadcast:0,lastSeq:19},
    {from:'builder',to:'design-research',count:4,direct:4,broadcast:0,lastSeq:20},
    {from:'design-research',to:'builder',count:3,direct:3,broadcast:0,lastSeq:21},
    {from:'asset-research',to:'builder',count:3,direct:3,broadcast:0,lastSeq:22},
    {from:'builder',to:'asset-research',count:2,direct:2,broadcast:0,lastSeq:23},
  ];
  const projection={nodes:screenshotNodes,links:screenshotLinks};
  const bezier=(a,c,b,t)=>{const u=1-t;return {x:u*u*a.x+2*u*t*c.x+t*t*b.x,y:u*u*a.y+2*u*t*c.y+t*t*b.y};};
  const toAbs=(pt,box)=>({cx:pt.x+(box.offsetX??0),cy:pt.y+(box.offsetY??0),halfW:box.halfW,halfH:box.halfH,radius:box.radius??8});

  for (const variant of ['card','hex']) {
    for (const width of [480,620,680,960]) {
      const height=Math.max(400,minimumHeight(screenshotNodes.length,width));
      const points=layout(screenshotNodes,width,height);
      const routed=routeEdges(projection,points,{variant,narrow:width<465,marginStart:6,marginEnd:7,obstacleMargin:8});
      assert.equal(routed.length,screenshotLinks.length,'every edge renders at '+variant+'/'+width);
      for (const {link,edge} of routed) {
        const fromAbs=toAbs(points.get(link.from),nodeBox(screenshotNodes.find(n=>n.name===link.from),{variant,narrow:width<465}));
        const toAbsBox=toAbs(points.get(link.to),nodeBox(screenshotNodes.find(n=>n.name===link.to),{variant,narrow:width<465}));
        const dStart=roundedRectSignedDistance(edge.start.x,edge.start.y,fromAbs);
        const dEnd=roundedRectSignedDistance(edge.end.x,edge.end.y,toAbsBox);
        assert.ok(dStart>=5.5,'start outside source card for '+link.from+'->'+link.to+' ('+variant+'/'+width+'): '+dStart);
        assert.ok(dEnd>=6.5,'arrowhead outside target card for '+link.from+'->'+link.to+' ('+variant+'/'+width+'): '+dEnd);
        for (let step=0;step<=16;step++) {
          const pt=bezier(edge.start,edge.control,edge.end,step/16);
          assert.ok(roundedRectSignedDistance(pt.x,pt.y,fromAbs)>0,'curve never re-enters source box: '+link.from+'->'+link.to);
          assert.ok(roundedRectSignedDistance(pt.x,pt.y,toAbsBox)>0,'curve never enters target box: '+link.from+'->'+link.to);
        }
      }
      // Verify bidirectional pair qa <-> builder bows cleanly in opposite directions with distinct endpoints
      const qaToBuilder=routed.find(r=>r.link.from==='qa'&&r.link.to==='builder').edge;
      const builderToQa=routed.find(r=>r.link.from==='builder'&&r.link.to==='qa').edge;
      assert.ok(Math.hypot(qaToBuilder.mid.x-builderToQa.mid.x,qaToBuilder.mid.y-builderToQa.mid.y)>=16,
        'bidirectional qa<->builder midpoints stay well separated at '+variant+'/'+width);
      assert.ok(Math.hypot(qaToBuilder.end.x-builderToQa.start.x,qaToBuilder.end.y-builderToQa.start.y)>=4,
        'bidirectional qa<->builder endpoints separate cleanly at '+variant+'/'+width);
      // Verify outer chords clear the center coordinator card
      const coordAbs=toAbs(points.get('coordinator'),nodeBox(screenshotNodes[0],{variant,narrow:width<465}));
      for (const [from,to] of [['user','builder'],['qa','design-research'],['builder','design-research'],['design-research','builder']]) {
        const {edge}=routed.find(r=>r.link.from===from&&r.link.to===to);
        for (let step=0;step<=16;step++) {
          const pt=bezier(edge.start,edge.control,edge.end,step/16);
          assert.ok(roundedRectSignedDistance(pt.x,pt.y,coordAbs)>0,
            'outer chord '+from+'->'+to+' clears coordinator at '+variant+'/'+width);
        }
      }
    }
  }
});
