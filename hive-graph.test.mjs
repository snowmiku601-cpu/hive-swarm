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
