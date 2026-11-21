import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import './hive-bees.js';
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
  assert.ok(hex.halfW>=54,'Codex hex nodeBox accommodates full @design-research pill without truncation');
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
    {from:'user',to:'asset-research',count:2,direct:2,broadcast:0,lastSeq:24},
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
      for (const [from,to] of [['user','builder'],['user','asset-research'],['qa','design-research'],['builder','design-research'],['design-research','builder']]) {
        const {edge}=routed.find(r=>r.link.from===from&&r.link.to===to);
        for (let step=0;step<=16;step++) {
          const pt=bezier(edge.start,edge.control,edge.end,step/16);
          assert.ok(roundedRectSignedDistance(pt.x,pt.y,coordAbs)>0,
            'outer chord '+from+'->'+to+' clears coordinator at '+variant+'/'+width);
        }
      }
      // Verify rendered mention count pills (count > 1) never overlap each other or node cards
      const pills=routed.filter(r=>r.link.count>1&&r.edge.length>=40).map(r=>r.edge.mid);
      for (let i=0;i<pills.length;i++) {
        for (const node of screenshotNodes) {
          const nAbs=toAbs(points.get(node.name),nodeBox(node,{variant,narrow:width<465}));
          assert.ok(roundedRectSignedDistance(pills[i].x,pills[i].y,nAbs)>=8,
            'pill '+i+' clears node '+node.name+' at '+variant+'/'+width);
        }
        for (let j=i+1;j<pills.length;j++) {
          assert.ok(Math.hypot(pills[i].x-pills[j].x,pills[i].y-pills[j].y)>=22,
            'pills '+i+' & '+j+' do not collide at '+variant+'/'+width);
        }
      }
    }
  }
});

test('smartTaskLabel prefers taskLabel and strips boilerplate, markdown, and dangling prepositions', () => {
  const { smartTaskLabel } = globalThis.HiveGraph;
  assert.equal(smartTaskLabel({ name: 'alpha', taskLabel: '  Build graph engine & GIF export  ', brief: 'Ignored' }),
    'Build graph engine & GIF export');
  const boilerplate = 'You are Hive Swarm member "core-codex" for Hive Swarm 2.0.0.\n' +
    'Your assignment (recorded on the board as #40 for @core-codex):\n' +
    'You own **engine.mjs**, `core.mjs`, and [server](http://example.com) for Hive Swarm 2.0.0 in your shared worktree.';
  const label = smartTaskLabel({ name: 'core-codex', brief: boilerplate });
  assert.ok(label.length <= 64, 'label within 64 chars: ' + label);
  assert.doesNotMatch(label, /You are Hive Swarm|Your assignment|You own|for Hive Swarm|\*\*|`/i);
  assert.match(label, /engine\.mjs/i);
  assert.doesNotMatch(label, /\b(for|in|on|to|with|of|by|and)$/i);

  const dangling = smartTaskLabel({ name: 'ui', brief: 'Refactor the Overview accordion and Threads progress bar for' });
  assert.equal(dangling, 'Refactor the Overview accordion and Threads progress bar');

  const fallback = smartTaskLabel({ name: 'probe', brief: '' });
  assert.equal(fallback, 'probe');
});

test('layoutMentions places coordinator at 12 o clock with no center blocker and clips arrows to capsule pills', () => {
  const { layoutMentions, mentionsMinimumHeight, nodeBox, routeEdges, roundedRectSignedDistance } = globalThis.HiveGraph;
  for (const width of [340, 380, 420, 480, 680, 960]) for (const count of [1, 2, 4, 6, 8, 12, 14]) {
    const nodes = Array.from({ length: count }, (_, i) => ({
      name: i === 0 ? 'coordinator' : 'worker-' + i,
      role: i === 0 ? 'coordinator' : 'worker',
      posts: 2,
    }));
    const narrow = width < 465;
    const height = Math.max(360, mentionsMinimumHeight(count, width));
    const points = layoutMentions(nodes, width, height);
    assert.equal(points.size, count);

    const coord = points.get('coordinator');
    const isGrid = count > 12 || (count > 5 && width < 380) || (count > 8 && width < 465);
    if (count > 1 && !isGrid) {
      assert.ok(Math.abs(coord.x - width / 2) < 1e-6, 'coordinator centered horizontally at 12 o clock');
      assert.ok(coord.y < height / 2, 'coordinator sits in top half (12 o clock)');
      // Verify no node sits near the ellipse center when count >= 3
      if (count >= 3) {
        const centerY = (36 + (height - 40)) / 2;
        for (const [name, pt] of points) {
          assert.ok(Math.hypot(pt.x - width / 2, pt.y - centerY) >= 40, name + ' stays on outer ring for count=' + count + ' w=' + width);
        }
      }
    }

    // Verify no pill boxes overlap across 1..14 nodes
    const boxes = nodes.map(n => {
      const b = nodeBox(n, { variant: 'pill', narrow });
      const pt = points.get(n.name);
      return { name: n.name, cx: pt.x, cy: pt.y, ...b };
    });
    for (const b of boxes) {
      assert.equal(b.offsetX, 0);
      assert.equal(b.offsetY, 0);
      assert.equal(b.radius, b.halfH);
      assert.ok(b.cx - b.halfW >= 0 && b.cx + b.halfW <= width, b.name + ' inside X bounds w=' + width);
      assert.ok(b.cy - b.halfH >= 0 && b.cy + b.halfH <= height, b.name + ' inside Y bounds w=' + width);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const dx = Math.abs(boxes[i].cx - boxes[j].cx) - (boxes[i].halfW + boxes[j].halfW);
        const dy = Math.abs(boxes[i].cy - boxes[j].cy) - (boxes[i].halfH + boxes[j].halfH);
        assert.ok(dx >= 2 || dy >= 2, `pills ${boxes[i].name} and ${boxes[j].name} do not overlap for count=${count} w=${width}`);
      }
    }
  }

  // Test capsule clipping with 6-node Screenshot 2 topology
  const ringNodes = [
    { name: 'coordinator', role: 'coordinator', posts: 5, unmentioned: 0, mentions: 4, broadcasts: 1 },
    { name: 'core-codex', role: 'worker', status: 'done', posts: 7 },
    { name: 'dsh-backend', role: 'worker', status: 'done', posts: 6 },
    { name: 'probe', role: 'worker', status: 'done', posts: 8 },
    { name: 'ui-polish', role: 'worker', status: 'done', posts: 4 },
    { name: 'verifier', role: 'worker', status: 'done', posts: 9 },
  ];
  const ringLinks = [
    { from: 'coordinator', to: 'verifier', count: 8, direct: 8, broadcast: 0, lastSeq: 30 },
    { from: 'verifier', to: 'coordinator', count: 3, direct: 3, broadcast: 0, lastSeq: 31 },
    { from: 'coordinator', to: 'core-codex', count: 5, direct: 5, broadcast: 0, lastSeq: 32 },
    { from: 'probe', to: 'dsh-backend', count: 7, direct: 7, broadcast: 0, lastSeq: 33 },
    { from: 'probe', to: 'coordinator', count: 4, direct: 4, broadcast: 0, lastSeq: 34 },
  ];
  const pts = layoutMentions(ringNodes, 680, 440);
  const routed = routeEdges({ nodes: ringNodes, links: ringLinks }, pts, { variant: 'pill', marginStart: 4, marginEnd: 6, obstacleMargin: 10 });
  assert.equal(routed.length, ringLinks.length);
  for (const { link, edge } of routed) {
    const fromBox = nodeBox(ringNodes.find(n => n.name === link.from), { variant: 'pill' });
    const toBox = nodeBox(ringNodes.find(n => n.name === link.to), { variant: 'pill' });
    const fAbs = { cx: pts.get(link.from).x, cy: pts.get(link.from).y, halfW: fromBox.halfW, halfH: fromBox.halfH, radius: fromBox.radius };
    const tAbs = { cx: pts.get(link.to).x, cy: pts.get(link.to).y, halfW: toBox.halfW, halfH: toBox.halfH, radius: toBox.radius };
    assert.ok(roundedRectSignedDistance(edge.start.x, edge.start.y, fAbs) >= 3.5);
    assert.ok(roundedRectSignedDistance(edge.end.x, edge.end.y, tAbs) >= 5.5);
  }
});

test('projectHive and layoutHive build 1-cluster and multi-cluster honeycombs with inner bee slots inside hexes', () => {
  const { projectHive, layoutHive } = globalThis.HiveGraph;
  const doneMembers = [
    { name: 'coordinator', role: 'coordinator', status: 'waiting' },
    { name: 'core-codex', status: 'done' },
    { name: 'dsh-backend', status: 'done' },
    { name: 'probe', status: 'done' },
    { name: 'ui-polish', status: 'done' },
    { name: 'verifier', status: 'done' },
  ];
  const donePosts = [
    { seq: 1, kind: 'brief', author: 'coordinator', targets: ['core-codex'], text: 'Start' },
    { seq: 2, kind: 'message', author: 'verifier', targets: ['coordinator'], text: '[done] All done.' },
  ];
  const model1 = projectHive(donePosts, doneMembers, 2);
  assert.equal(model1.clusters.length, 1);
  assert.equal(model1.clusters[0].id, 'done');
  assert.equal(model1.clusters[0].count, 5);
  assert.ok(model1.clusters[0].members.every(m => m.muted === true));
  assert.equal(model1.coordinator.doneCount, 5);
  assert.equal(model1.coordinator.totalWorkers, 5);
  assert.equal(model1.coordinator.phase, 'done');
  assert.ok(model1.connectors.some(c => c.kind === 'done' && c.from === 'done' && c.to === 'coordinator'));
  assert.ok(model1.connectors.some(c => c.kind === 'message' && c.from === 'done' && c.to === 'coordinator'));

  const lay1 = layoutHive(model1, 680, 460);
  assert.equal(lay1.clusters.length, 1);
  assert.equal(lay1.clusters[0].vertices.length, 6);
  assert.equal(lay1.coordinator.vertices.length, 6);
  assert.ok(Math.abs(lay1.clusters[0].x - lay1.coordinator.x) < 1e-6, '1-cluster stacks directly above coordinator');
  assert.ok(lay1.clusters[0].y < lay1.coordinator.y, 'Done hex sits above Coordinator hex');
  // Flat-top regular hexagon check: vertices 4 and 5 share top horizontal y
  assert.ok(Math.abs(lay1.clusters[0].vertices[4].y - lay1.clusters[0].vertices[5].y) < 1e-6);

  // Multi-cluster honeycomb check + waiting dependency + 1..12 inner slot containment
  const multiMembers = [
    { name: 'coordinator', role: 'coordinator', status: 'working' },
    { name: 'w1', status: 'working' },
    { name: 'w2', status: 'waiting', pendingWaitFor: ['w1'] },
    { name: 'w3', status: 'failed', recoveryRequired: true },
    { name: 'w4', status: 'done' },
  ];
  const multiModel = projectHive([
    { seq: 1, kind: 'message', author: 'w1', targets: ['coordinator'], text: 'Working' },
  ], multiMembers, 1);
  assert.deepEqual(multiModel.clusters.map(c => c.id), ['working', 'waiting', 'needs', 'done']);
  assert.equal(multiModel.coordinator.phase, 'stalled');
  assert.ok(multiModel.connectors.some(c => c.kind === 'waiting' && c.from === 'waiting' && c.to === 'working'));

  const lay4 = layoutHive(multiModel, 680, 500);
  const allCells = [lay4.coordinator, ...lay4.clusters];
  const minDist = Math.sqrt(3) * lay4.radius * 0.99;
  for (let i = 0; i < allCells.length; i++) {
    for (const v of allCells[i].vertices) {
      assert.ok(v.x >= 0 && v.x <= 680 && v.y >= 0 && v.y <= 500, 'hex vertex inside stage');
    }
    for (let j = i + 1; j < allCells.length; j++) {
      assert.ok(Math.hypot(allCells[i].x - allCells[j].x, allCells[i].y - allCells[j].y) >= minDist,
        `hexes ${allCells[i].id} and ${allCells[j].id} do not overlap`);
    }
  }

  // Verify 1..12 worker bee slots stay strictly inside flat-top hexagon bounds
  for (let n = 1; n <= 12; n++) {
    const swarm = Array.from({ length: n }, (_, i) => ({ name: 'bee-' + i, status: 'done' }));
    const m = projectHive([], swarm, 0);
    const l = layoutHive(m, 640, 460);
    const cell = l.clusters[0];
    assert.equal(cell.slots.length, n);
    const apothem = (Math.sqrt(3) / 2) * cell.radius;
    for (const slot of cell.slots) {
      const dx = Math.abs(slot.x - cell.x);
      const dy = Math.abs(slot.y - cell.y);
      assert.ok(dy <= apothem - 4, `slot y inside hex for n=${n}`);
      assert.ok(0.8660254 * dx + 0.5 * dy <= apothem - 4, `slot diagonal inside hex for n=${n}`);
    }
  }
});

test('HiveBee muted sprites omit Zzz and renderGrayscale while renderGraphFrame renders hive and mentions modes', () => {
  const canvases = [];
  const doc = {
    createElement(tag) {
      const pixels = new Map();
      const ctx = {
        fillStyle: '',
        fillRect(x, y, w, h) {
          for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) pixels.set(`${x + dx},${y + dy}`, this.fillStyle);
        },
      };
      const c = { tagName: tag, width: 20, height: 18, dataset: {}, attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, getContext: () => ctx, pixels };
      canvases.push(c);
      return c;
    },
  };
  const vm = { document: doc };
  runInNewContext(readFileSync(new URL('./hive-bees.js', import.meta.url), 'utf8'), vm);
  const mutedBee = vm.HiveBee.sprite('worker', { status: 'done', tint: 0, muted: true });
  assert.equal(mutedBee.dataset.muted, 'true');
  assert.equal(mutedBee.dataset.pose, 'muted');
  assert.ok(![...mutedBee.pixels.values()].includes('#d7dcff'), 'muted bee omits sleeping Zzz');
  assert.ok(![...mutedBee.pixels.values()].includes('#75baef'), 'muted bee uses grayscale instead of blue tint');

  const accent = vm.HiveBee.tintStyle('worker', false, 0);
  assert.equal(accent.base, '#75baef');
  assert.match(accent.bg, /^rgba\(/);
  assert.match(accent.border, /^rgba\(/);

  // Verify renderGraphFrame works in both hive & mentions modes and dark/light themes
  const { renderGraphFrame } = globalThis.HiveGraph;
  const members = [
    { name: 'coordinator', role: 'coordinator', status: 'working' },
    { name: 'alpha', status: 'done' },
    { name: 'beta', status: 'working' },
  ];
  const posts = [
    { seq: 1, kind: 'brief', author: 'coordinator', targets: ['alpha', 'beta'], text: 'Go' },
    { seq: 2, kind: 'message', author: 'alpha', targets: ['coordinator'], text: '[done] Ready' },
  ];
  for (const mode of ['hive', 'mentions']) {
    for (const theme of ['light', 'dark']) {
      const texts = [];
      const rects = [];
      const ctx = new Proxy({
        fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '', textAlign: '', textBaseline: '',
        fillRect: (...args) => rects.push(args),
        fillText: (text) => texts.push(text),
      }, { get: (t, k) => t[k] ?? (() => {}) });
      renderGraphFrame(ctx, { mode, theme, posts, members, width: 680, height: 460, bees: globalThis.HiveBee });
      assert.ok(rects.length > 5, `${mode}/${theme} drew background and bee pixels`);
      assert.ok(texts.length > 0, `${mode}/${theme} drew labels and legend`);
      if (mode === 'hive') assert.ok(texts.includes('Coordinator') && texts.includes('Tasks done'));
      else assert.ok(texts.includes('coordinator') && texts.includes('@mention, width = count'));
    }
  }
});

test('Goal mode (no dedicated coordinator) merges user posts/targets into coordinator in project and projectHive', () => {
  const { project, projectHive, shouldMergeUserToCoordinator } = globalThis.HiveGraph;
  const syntheticRoster = [
    { name: 'coordinator', role: 'coordinator', external: true, status: 'waiting' },
    { name: 'builder', role: 'worker', status: 'working' },
    { name: 'qa', role: 'worker', status: 'done' },
  ];
  assert.equal(shouldMergeUserToCoordinator(syntheticRoster), true);
  assert.equal(shouldMergeUserToCoordinator([{ name: 'builder' }]), true);

  const events = [
    { seq: 1, kind: 'brief', author: 'coordinator', targets: ['builder'], text: 'Build UI' },
    { seq: 2, kind: 'message', author: 'user', targets: ['builder'], text: '@builder adjust padding' },
    { seq: 3, kind: 'message', author: 'user', targets: ['coordinator'], coordinatorMention: true, text: '@coordinator check' },
    { seq: 4, kind: 'message', author: 'builder', targets: ['coordinator'], coordinatorMention: true, text: '@coordinator done' },
    { seq: 5, kind: 'message', author: 'qa', targets: ['user'], text: '@user ready for review' },
    { seq: 6, kind: 'message', author: 'user', targets: ['builder'], text: '@builder ship it' },
  ];

  // Goal mode Mentions projection consolidates user into coordinator with zero separate user node.
  const proj = project(events, syntheticRoster, 6, {});
  assert.equal(proj.nodes.some(n => n.name === 'user'), false);
  const coord = proj.nodes.find(n => n.name === 'coordinator');
  assert.equal(coord.posts, 4);
  assert.equal(coord.mentions, 3);
  assert.equal(proj.links.find(l => l.from === 'coordinator' && l.to === 'builder').count, 3);
  assert.equal(proj.links.find(l => l.from === 'coordinator' && l.to === 'coordinator'), undefined);
  assert.equal(proj.links.find(l => l.from === 'builder' && l.to === 'coordinator').count, 1);
  assert.equal(proj.links.find(l => l.from === 'qa' && l.to === 'coordinator').count, 1);

  // Goal mode Hive projection keeps the purple "Message just sent" connector when lastPost.author is user.
  const hive = projectHive(events, syntheticRoster, 6);
  assert.equal(hive.coordinator.latestSeq, 6);
  const msgConn = hive.connectors.find(c => c.kind === 'message');
  assert.ok(msgConn, 'expected purple message connector from coordinator when Lead (user) posts');
  assert.equal(msgConn.from, 'coordinator');
  assert.equal(msgConn.to, 'working');

  // Dedicated coordinator mode keeps user distinct only when human manually posts.
  const dedicatedRoster = [
    { name: 'coordinator', role: 'coordinator', status: 'working' },
    { name: 'builder', role: 'worker', status: 'working' },
  ];
  assert.equal(shouldMergeUserToCoordinator(dedicatedRoster), false);
  const noUserEvents = [
    { seq: 1, kind: 'brief', author: 'coordinator', targets: ['builder'], text: 'Build UI' },
    { seq: 2, kind: 'message', author: 'builder', targets: ['coordinator'], text: '@coordinator Done' },
  ];
  assert.equal(project(noUserEvents, dedicatedRoster, 2, {}).nodes.some(n => n.name === 'user'), false);
  const withUserEvents = [...noUserEvents, { seq: 3, kind: 'message', author: 'user', targets: ['builder'], text: '@builder manual override' }];
  const dedicatedProj = project(withUserEvents, dedicatedRoster, 3, {});
  assert.equal(dedicatedProj.nodes.some(n => n.name === 'user'), true);
  assert.equal(dedicatedProj.links.find(l => l.from === 'user' && l.to === 'builder').count, 1);
});
