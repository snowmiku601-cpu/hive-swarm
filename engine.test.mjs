import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { TeamBoard, childEnvironment, teamPhase } from './engine.mjs';
import * as engine from './engine.mjs';

const until = async (condition) => {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await delay(10);
  }
  assert.fail('Team did not reach the expected state');
};

test('stall diagnostics cite an unaddressed result once without dispatching a diagnostic turn', async t => {
  let runs=0;
  const board=new TeamBoard(':memory:',async()=>{
    runs++;
    return {state:'waiting',message:'[done] The patch is ready for review.',notify:[],waitFor:[]};
  });
  t.after(()=>board.close());
  const {id}=board.create({cwd:process.cwd(),task:'Inspect the handoff',members:[{name:'builder',brief:'Build'}]});
  await until(()=>board.get(id).monitorPhase==='stalled');
  const team=board.get(id);
  const result=team.events.find(event=>event.author==='builder');
  const diagnostic=team.events.find(event=>event.kind==='monitor');
  assert.match(diagnostic.text,/^\[stall\]/);
  assert.ok(diagnostic.text.includes('#'+result.seq));
  assert.match(diagnostic.text,/unaddressed|no member was @mentioned/i);
  assert.equal(team.members[0].lastSettledSeq,result.seq);
  assert.ok(team.lastDispatchSeq<result.seq);
  for (let i=0;i<4;i++) board.monitor(board.get(id));
  board.post(id,'A public note without a recipient.');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(board.get(id).events.filter(event=>event.kind==='monitor').length,1);
  assert.equal(runs,1);
  assert.equal(board.get(id).turns,1);
});

test('stall issues exclude old unaddressed posts and name an unanswered mention blocked by a dependency', t => {
  const board=new TeamBoard(':memory:',()=>assert.fail('Diagnostics must not dispatch work'));
  t.after(()=>board.close());
  const team={id:'diagnostic',members:[
    {name:'builder',status:'waiting',waitFor:[],completed:0},
    {name:'reviewer',status:'waiting',waitFor:['builder'],completed:0},
  ],events:[],channels:[{name:'main'}],turns:1,turnLimit:8};
  board.record(team,'builder','An old result without a recipient.',[],'message');
  team.lastDispatchSeq=board.record(team,'system','@builder started turn 1.').seq;
  const mention=board.record(team,'user','@reviewers Please review.', ['reviewer'],'message');
  const issues=engine.stallIssues(team);
  assert.ok(!issues.some(issue=>issue.kind==='unaddressed'));
  const unanswered=issues.find(issue=>issue.kind==='mention');
  assert.equal(unanswered.member,'reviewer');
  assert.equal(unanswered.seq,mention.seq);
  assert.match(unanswered.text,/@reviewer.*not settled/i);
  team.members[1].lastSettledSeq=board.record(team,'reviewer','Waiting for the next build.',[],'message').seq;
  assert.ok(!engine.stallIssues(team).some(issue=>issue.kind==='mention'));
});

test('stall issues follow pending wait chains to the root and identify circular waits', () => {
  const team={members:[
    {name:'reviewer',status:'waiting',waitFor:['builder'],completed:0},
    {name:'builder',status:'waiting',waitFor:['researcher'],completed:0},
    {name:'researcher',status:'quota',waitFor:[],completed:0},
  ],events:[],turns:3,turnLimit:8};
  const issues=engine.stallIssues(team);
  const chain=issues.find(issue=>issue.kind==='dependency'&&issue.chain.length===3);
  assert.deepEqual(chain.chain,['reviewer','builder','researcher']);
  assert.equal(chain.member,'researcher');
  assert.match(chain.text,/Root blocker: @researcher.*quota/i);
  team.members[2]={name:'researcher',status:'waiting',waitFor:['reviewer'],completed:0};
  const cycles=engine.stallIssues(team).filter(issue=>issue.kind==='cycle');
  assert.equal(cycles.length,1);
  assert.deepEqual(cycles[0].chain,['reviewer','builder','researcher','reviewer']);
});

test('satisfied waits do not become blockers and an old completion explains a new-report wait', () => {
  const team={members:[
    {name:'reviewer',status:'waiting',waitFor:['builder'],waitAfter:{builder:1},completed:0},
    {name:'builder',status:'done',waitFor:[],completed:2},
  ],events:[],turns:2,turnLimit:8};
  assert.deepEqual(engine.pendingWaitFor(team,team.members[0]),[]);
  assert.ok(!engine.stallIssues(team).some(issue=>issue.kind==='dependency'));
  team.members[1].completed=1;
  assert.deepEqual(engine.pendingWaitFor(team,team.members[0]),['builder']);
  assert.match(engine.stallIssues(team).find(issue=>issue.kind==='dependency').text,/new report/i);
});

test('quota and failed blockers retain mention evidence without mislabeling error posts as unaddressed results', () => {
  const team={members:[
    {name:'alpha',status:'failed',waitFor:[],lastSettledSeq:4},
    {name:'beta',status:'quota',waitFor:[],lastSettledSeq:5},
  ],events:[
    {seq:1,kind:'message',author:'user',targets:['alpha','beta'],text:'@all Inspect'},
    {seq:2,kind:'status',author:'system',text:'@alpha started turn 1.'},
    {seq:3,kind:'status',author:'system',text:'@beta started turn 2.'},
    {seq:4,kind:'status',author:'alpha',targets:[],text:'The tool failed.'},
    {seq:5,kind:'status',author:'beta',targets:[],text:'429 Too Many Requests'},
  ],turns:2,turnLimit:8};
  const issues=engine.stallIssues(team);
  assert.equal(issues.find(issue=>issue.kind==='failed').member,'alpha');
  assert.equal(issues.find(issue=>issue.kind==='quota').member,'beta');
  assert.equal(issues.find(issue=>issue.kind==='quota').seq,1);
  assert.ok(!issues.some(issue=>issue.kind==='unaddressed'));
});

test('legacy stall markers survive a restart without duplicate diagnostic posts', t => {
  const dir=mkdtempSync(join(tmpdir(),'hive-stall-'));
  const file=join(dir,'test.sqlite');
  let board=new TeamBoard(file,()=>assert.fail('A stalled board dispatched work'));
  t.after(()=>{board.close();rmSync(dir,{recursive:true,force:true});});
  board.save({id:'legacy-stall',members:[{name:'worker',status:'waiting',waitFor:[],channels:[]}],
    channels:[{name:'main'}],turns:1,turnLimit:8,events:[
      {seq:1,kind:'message',author:'worker',text:'Old result.',targets:[]},
      {seq:2,kind:'status',author:'system',text:'@worker started turn 1.',targets:[]},
      {seq:3,kind:'message',author:'worker',text:'Latest result.',targets:[]},
    ]});
  board.monitor(board.get('legacy-stall'));
  assert.match(board.get('legacy-stall').events.at(-1).text,/#3/);
  assert.doesNotMatch(board.get('legacy-stall').events.at(-1).text,/#1\b/);
  board.close();
  board=new TeamBoard(file,()=>assert.fail('A restored stall dispatched work'));
  board.monitor(board.get('legacy-stall'));
  assert.equal(board.readHistory('legacy-stall').posts.filter(event=>event.kind==='monitor').length,1);
});

test('dense dependency cycles produce one bounded diagnostic component',()=>{
  for (const count of [9,13]) {
    const names=Array.from({length:count},(_,i)=>'worker-'+i);
    const team={members:names.map(name=>({name,status:'waiting',completed:0,
      waitFor:names.filter(other=>other!==name)})),events:[],turns:count,turnLimit:24};
    const issues=engine.stallIssues(team);
    assert.equal(issues.filter(issue=>issue.kind==='cycle').length,1);
    assert.ok(issues.length<=names.length);
  }
});

test('an in-turn broadcast retained behind a new dependency remains an unanswered mention',async t=>{
  let release;
  const waiting=new Promise(resolve=>{release=resolve;});
  const board=new TeamBoard(':memory:',async({member})=>{
    if(member.name==='reviewer')await waiting;
    return {state:'waiting',message:'Waiting for the next report.',notify:[],
      waitFor:member.name==='reviewer'?['builder']:[]};
  });
  t.after(()=>{release();board.close();});
  const {id}=board.create({cwd:process.cwd(),task:'Preserve pending handoffs',members:[
    {name:'builder',brief:'Build'},{name:'reviewer',brief:'Review'}]});
  await until(()=>board.get(id).members[0].status==='waiting');
  const broadcast=board.post(id,'@all Review the next build.').events.at(-1);
  release();
  await until(()=>board.get(id).members.every(member=>member.status==='waiting'));
  const team=board.get(id);
  const reviewer=team.members[1];
  assert.ok(reviewer.lastSettledSeq>broadcast.seq);
  assert.ok(reviewer.inbox.some(event=>event.seq===broadcast.seq));
  assert.ok(engine.stallIssues(team).some(issue=>issue.kind==='mention'&&issue.member==='reviewer'&&issue.seq===broadcast.seq));
});

test('a new mention after a quota failure is described as pending without reversing cause and effect',()=>{
  const team={members:[{name:'worker',status:'quota',waitFor:[],lastSettledSeq:4,
    inbox:[{seq:6,author:'user',text:'@all Resume later.'}]}],events:[
      {seq:4,kind:'status',author:'worker',targets:[],text:'429 Too Many Requests'},
      {seq:6,kind:'message',author:'user',targets:['worker'],broadcast:true,text:'@all Resume later.'},
    ],turns:1,turnLimit:8};
  const issue=engine.stallIssues(team).find(issue=>issue.kind==='quota');
  assert.equal(issue.seq,6);
  assert.match(issue.text,/#6 is still pending/);
  assert.doesNotMatch(issue.text,/limit after/);
});

test('a waiting member uses no turns and wakes in its existing thread when mentioned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-board-test-'));
  const calls = [];
  const board = new TeamBoard(join(dir, 'test.sqlite'), async ({ member, remember }) => {
    calls.push({ name: member.name, previous: member.threadId, inbox: member.inbox });
    remember(member.threadId ?? 'thread-' + member.name);
    if (member.name === 'reviewer' && calls.filter(x => x.name === 'reviewer').length === 1) {
      return { state: 'waiting', message: 'Đang chờ diff.', waitFor: [], notify: [] };
    }
    return { state: 'done', message: 'Xong.', waitFor: [], notify: [] };
  });
  try {
    const { id } = board.create({
      cwd: dir, task: 'Kiểm tra nhịp chờ', members: [
        { name: 'reviewer', brief: 'Review' },
        { name: 'builder', brief: 'Build', waitFor: ['reviewer'] },
      ],
    });
    await until(() => board.get(id).members[0].status === 'waiting');
    await delay(60);
    assert.equal(calls.length, 1);
    board.post(id, '@reviewer Diff đã có.');
    await until(() => board.get(id).members.every(m => m.status === 'done'));
    assert.deepEqual(calls.map(c => c.name), ['reviewer', 'reviewer', 'builder']);
    assert.equal(calls[1].previous, 'thread-reviewer');
    assert.equal(calls[1].inbox[0].text, '@reviewer Diff đã có.');
    assert.equal(board.get(id).turns, 3);
  } finally {
    board.close();
    rmSync(join(dir, 'test.sqlite'), { force: true });
    rmdirSync(dir);
  }
});

test('an active member queues mentions and stops at the run budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-board-test-'));
  let release;
  let runs = 0;
  const wait = new Promise(resolve => { release = resolve; });
  const board = new TeamBoard(join(dir, 'test.sqlite'), async () => {
    runs++;
    await wait;
    return { state: 'waiting', message: 'Đợi phản hồi.', waitFor: [], notify: [] };
  });
  try {
    const {id} = board.create({cwd: dir, task: 'Giới hạn lượt', turnLimit: 1,
      members: [{name: 'worker', brief: 'Inspect'}]});
    await until(() => runs === 1);
    board.post(id, '@worker kiểm tra thêm lần nữa');
    assert.equal(board.get(id).members[0].status, 'working');
    release();
    await until(() => board.get(id).members[0].status === 'queued');
    await delay(30);
    assert.equal(runs, 1);
    board.resume(id, 1);
    await until(() => runs === 2 && board.get(id).members[0].status === 'waiting');
  } finally {
    release();
    board.close();
    rmSync(join(dir, 'test.sqlite'), {force: true});
    rmdirSync(dir);
  }
});

test('a worker post wakes another idle member without going through a coordinator', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-board-test-'));
  const calls = [];
  let releaseWriter;
  const writer = new Promise(resolve => { releaseWriter = resolve; });
  const board = new TeamBoard(join(dir, 'test.sqlite'), async ({member, remember}) => {
    calls.push(member.name);
    remember('thread-' + member.name);
    if (member.name === 'builder') {
      await writer;
      return {state:'done', message:'@reviewer Diff sẵn sàng.', notify:[], waitFor:[]};
    }
    return member.inbox.length
      ? {state:'done', message:'Đã review.', notify:[], waitFor:[]}
      : {state:'waiting', message:'Chờ diff.', notify:[], waitFor:[]};
  });
  try {
    const {id} = board.create({cwd:dir, task:'Handoff độc lập', members:[
      {name:'builder',brief:'Prepare diff'},
      {name:'reviewer',brief:'Review diff'},
    ]});
    await until(() => board.get(id).members[1].status === 'waiting');
    assert.deepEqual(calls, ['builder','reviewer']);
    releaseWriter();
    await until(() => board.get(id).members.every(m => m.status === 'done'));
    assert.deepEqual(calls, ['builder','reviewer','reviewer']);
    assert.deepEqual(board.get(id).events.find(e => e.author === 'builder').targets, ['reviewer']);
  } finally {
    releaseWriter();
    board.close();
    rmSync(join(dir, 'test.sqlite'), {force:true});
    rmdirSync(dir);
  }
});

test('a dependency that already finished does not start an idle loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-board-test-'));
  let reviewerRuns = 0;
  const board = new TeamBoard(join(dir, 'test.sqlite'), async ({member}) => {
    if (member.name === 'writer') return {state:'done', message:'Có bản mới.', notify:[], waitFor:[]};
    reviewerRuns++;
    return reviewerRuns === 1
      ? {state:'waiting', message:'Chờ bản sửa tiếp theo.', notify:[], waitFor:['writer']}
      : {state:'done', message:'Đã xem bản mới.', notify:[], waitFor:[]};
  });
  try {
    const {id} = board.create({cwd:dir,task:'Đợi bản sửa mới',members:[
      {name:'writer',brief:'Write'},
      {name:'reviewer',brief:'Review',waitFor:['writer']},
    ]});
    await until(() => reviewerRuns === 1 && board.get(id).members[1].status === 'waiting');
    await delay(60);
    assert.equal(reviewerRuns,1);
    board.post(id,'@writer Gửi bản sửa tiếp theo.');
    await until(() => board.get(id).members[1].status === 'done');
    assert.equal(reviewerRuns,2);
  } finally {
    board.close();
    rmSync(join(dir, 'test.sqlite'), {force:true});
    rmdirSync(dir);
  }
});

test('a service restart holds new turns and retains messages from an interrupted run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-board-test-'));
  const file = join(dir,'test.sqlite');
  let old = new TeamBoard(file, async ({member,remember}) => {
    remember('stored-' + member.name);
    return new Promise(() => {});
  });
  let resumed;
  try {
    const {id} = old.create({cwd:dir,task:'Khôi phục nhóm',members:[{name:'worker',brief:'Inspect'}]});
    old.post(id,'@worker Giữ lại tin nhắn này.');
    await until(() => old.get(id).members[0].threadId);
    old.close();old = null;
    let request;
    resumed = new TeamBoard(file, async ({member}) => {
      request = member;
      return {state:'done',message:'Xong.',notify:[],waitFor:[]};
    });
    assert.equal(resumed.get(id).paused,true);
    assert.equal(resumed.get(id).members[0].status,'failed');
    resumed.post(id,'@worker Tiếp tục.');
    assert.equal(request,undefined);
    resumed.resume(id);
    await until(() => resumed.get(id).members[0].status === 'done');
    assert.equal(request.threadId,'stored-worker');
    assert.deepEqual(request.inbox.map(x => x.text),['@worker Giữ lại tin nhắn này.','@worker Tiếp tục.']);
  } finally {
    old?.close();resumed?.close();
    rmSync(file,{force:true});
    rmdirSync(dir);
  }
});

test('a working member can post to a group and wake peers before finishing its own turn', async t => {
  const requests = [];
  let release;
  const finishBuilder = new Promise(resolve => { release = resolve; });
  const board = new TeamBoard(':memory:', async ({member}) => {
    requests.push(member);
    if (member.name === 'builder') await finishBuilder;
    return {state:member.name === 'builder' || member.inbox.length ? 'done' : 'waiting',
      message:'Đã nhận.', waitFor:[], notify:[]};
  });
  t.after(() => { release(); board.close(); });
  const {id} = board.create({cwd:process.cwd(),task:'Gửi diff giữa lượt',members:[
    {name:'builder',brief:'Sửa code',writable:true},
    {name:'review-a',brief:'Kiểm thử',group:'reviewers'},
    {name:'review-b',brief:'Review diff',group:'reviewers'},
  ]});
  await until(() => board.get(id).members.slice(1).every(member => member.status === 'waiting'));
  const post = board.postFrom(id,'builder','@reviewers @review-a Xem bản diff đang có.');
  assert.deepEqual(post.targets,['review-a','review-b']);
  assert.equal(post.author,'builder');
  await until(() => board.get(id).members.slice(1).every(member => member.status === 'done'));
  assert.equal(board.get(id).members[0].status,'working');
  assert.equal(requests.filter(member => member.inbox.some(message => message.seq === post.seq)).length,2);
  const page = board.readPosts(id,{after:post.seq-1,limit:1});
  assert.deepEqual(page.posts,[post]);
  assert.ok(page.head > post.seq);
  assert.throws(() => board.postFrom(id,'review-a','@all tin nhắn ngoài lượt'),/running turn/i);
  release();
  await until(() => board.get(id).members.every(member => member.status === 'done'));
});

test('a verifier waits for its initial dependencies and receives each new report once', async t => {
  const requests = [];
  let release;
  const finishFirstDiff = new Promise(resolve => { release = resolve; });
  const board = new TeamBoard(':memory:', async ({member,remember}) => {
    const previous = requests.filter(request => request.name === member.name).length;
    requests.push(member);
    remember(member.threadId ?? 'thread-' + member.name);
    if (member.name === 'builder') {
      if (!previous) await finishFirstDiff;
      return {state:'done',message:previous ? 'Diff v2 đã sửa giá trị 0.' : '@verifier Diff v1 đã sẵn sàng.',
        notify:[],waitFor:[]};
    }
    return previous
      ? {state:'done',message:'Đã kiểm lại v2.',notify:[],waitFor:[]}
      : {state:'waiting',message:'@builder Sửa trường hợp giá trị 0.',notify:[],waitFor:['builder']};
  });
  t.after(() => { release(); board.close(); });
  const {id} = board.create({cwd:process.cwd(),task:'Review và kiểm lại',members:[
    {name:'builder',brief:'Chuẩn bị diff',writable:true},
    {name:'verifier',brief:'Chạy test và xác minh diff',waitFor:['builder']},
  ]});
  await until(() => board.get(id).members[0].status === 'working');
  const posted = board.post(id,'@all Chú ý trường hợp giá trị 0.');
  assert.deepEqual(posted.events.at(-1).targets,['builder','verifier']);
  assert.equal(posted.members[1].status,'waiting');
  release();
  await until(() => board.get(id).members.every(member => member.status === 'done'));
  const reviewer = requests.filter(member => member.name === 'verifier');
  assert.equal(reviewer.length,2);
  assert.equal(reviewer[0].inbox.filter(message => message.text.includes('Diff v1')).length,1);
  assert.ok(reviewer[1].inbox.some(message => message.text.includes('Diff v2')));
  assert.equal(reviewer[1].threadId,'thread-verifier');
  assert.ok(board.get(id).events.some(event => event.kind === 'brief' && event.targets.includes('verifier')));
});

test('a quota error keeps the chat asleep and reports the stalled team once', async t => {
  const requests = [];
  const board = new TeamBoard(':memory:', async ({member,remember}) => {
    requests.push(member);
    remember(member.threadId ?? 'quota-thread');
    if (requests.length === 1) throw Error('Exceeded retry limit, last status: 429 Too Many Requests');
    return {state:'done',message:'Đã tiếp tục.',notify:[],waitFor:[]};
  });
  t.after(() => board.close());
  const {id} = board.create({cwd:process.cwd(),task:'Kiểm tra giới hạn provider',members:[
    {name:'worker',brief:'Kiểm tra diff',group:'reviewers'},
  ]});
  await until(() => requests.length && board.get(id).members[0].status !== 'working');
  assert.equal(board.get(id).members[0].status,'quota');
  board.post(id,'Đợi hạn mức phục hồi.');
  board.post(id,'@all Cập nhật tiến độ chung.');
  board.post(id,'@reviewers Có thêm ghi chú để đọc khi quay lại.');
  await delay(30);
  assert.equal(requests.length,1);
  assert.equal(board.get(id).members[0].status,'quota');
  assert.equal(board.get(id).events.filter(event => event.kind === 'monitor').length,1);
  board.post(id,'@worker Tiếp tục phần còn lại.');
  await until(() => board.get(id).members[0].status === 'done');
  assert.equal(requests[1].threadId,'quota-thread');
  assert.deepEqual(requests[1].inbox.map(event => event.text),[
    '@all Cập nhật tiến độ chung.',
    '@reviewers Có thêm ghi chú để đọc khi quay lại.',
    '@worker Tiếp tục phần còn lại.',
  ]);
});

test('older teams keep readable history when post sequence numbers are added', t => {
  const board = new TeamBoard(':memory:', () => assert.fail('A paused legacy team dispatched work.'));
  t.after(() => board.close());
  const time = '2026-11-19T00:00:00.000Z';
  board.save({id:'legacy',paused:true,members:[],events:[
    {time,author:'system',text:'Đã tạo nhóm.',targets:[]},
    {time,author:'builder',text:'Diff đã có.',targets:[]},
  ]});
  const before = board.readPosts('legacy');
  assert.equal(before.head,2);
  board.post('legacy','Đã thấy diff.');
  const after = board.readPosts('legacy',{after:before.head});
  assert.equal(after.head,3);
  assert.deepEqual(after.posts.map(post => post.text),['Đã thấy diff.']);
});

test('a quota-limited worker can resume on a selected model in the same chat', async t => {
  const turns = [];
  const board = new TeamBoard(':memory:', async ({team,member,remember}) => {
    turns.push({model:member.model ?? team.model, threadId:member.threadId});
    remember(member.threadId ?? 'saved-verifier-chat');
    if (turns.length === 1) throw Error('429 Too Many Requests');
    return {state:'done',message:'Đã kiểm thử.',notify:[],waitFor:[]};
  });
  t.after(() => board.close());
  const {id} = board.create({cwd:process.cwd(),task:'Chọn model theo vai',model:'team-default',
    members:[{name:'verifier',brief:'Kiểm thử',model:'fixture-a'}]});
  await until(() => board.get(id).members[0].status === 'quota');
  board.switchModel(id,'verifier','fixture-b');
  await delay(25);
  assert.equal(board.get(id).members[0].status,'quota');
  assert.equal(turns.length,1);
  board.switchModel(id,'verifier','fixture-b',{resume:true});
  await until(() => board.get(id).members[0].status === 'done');
  assert.deepEqual(turns,[
    {model:'fixture-a',threadId:null},
    {model:'fixture-b',threadId:'saved-verifier-chat'},
  ]);
});

test('replacing a waiting member transfers its unfinished dependency and preserves its chat', async t => {
  const turns = [];
  const board = new TeamBoard(':memory:', async ({member,remember}) => {
    turns.push(member);
    remember('saved-' + member.name);
    return member.name === 'builder'
      ? {state:'waiting',message:'Đang vướng phần sửa.',notify:[],waitFor:[]}
      : {state:'done',message:member.name === 'backup' ? 'Diff từ backup.' : 'Đã review.',notify:[],waitFor:[]};
  });
  t.after(() => board.close());
  const {id} = board.create({cwd:process.cwd(),task:'Thay người giữa chừng',members:[
    {name:'builder',brief:'Sửa code'},
    {name:'verifier',brief:'Review diff',waitFor:['builder']},
  ]});
  await until(() => board.get(id).members[0].status === 'waiting');
  assert.throws(() => board.retireMember(id,'builder'),/verifier/);
  assert.throws(() => board.addMember(id,{name:'cycle',brief:'Invalid',waitFor:['verifier']},
    {replaces:'builder'}),/cycle/i);
  const changed = board.addMember(id,{name:'backup',brief:'Tiếp nhận phần sửa'},{replaces:'builder'});
  assert.equal(changed.members[0].status,'retired');
  assert.equal(changed.members[0].threadId,'saved-builder');
  assert.deepEqual(changed.members[1].waitFor,['backup']);
  await until(() => board.get(id).members[1].status === 'done');
  board.post(id,'@builder Kiểm tra cách định tuyến.');
  await delay(25);
  assert.deepEqual(turns.map(member=>member.name),['builder','backup','verifier']);
  assert.ok(turns.at(-1).inbox.some(event=>event.text==='Diff từ backup.'));
});

test('isolated writers run together and a shared writer retires after its active turn', async t => {
  const runs = [];
  let release;
  const finish = new Promise(resolve => { release = resolve; });
  const board = new TeamBoard(':memory:', async ({member}) => {
    runs.push(member.name);
    await finish;
    return {state:'done',message:'Xong phần sửa.',notify:[],waitFor:[]};
  });
  t.after(() => {release();board.close();});
  const {id} = board.create({cwd:process.cwd(),task:'Các phần sửa độc lập',concurrency:4,members:[
    {name:'isolated-a',brief:'Sửa A',writable:true,worktree:true},
    {name:'isolated-b',brief:'Sửa B',writable:true,worktree:true},
    {name:'shared-a',brief:'Sửa C',writable:true},
    {name:'shared-b',brief:'Sửa D',writable:true},
  ]},{root:process.cwd(),commit:'fixture'});
  await until(() => runs.length === 3);
  assert.deepEqual(runs,['isolated-a','isolated-b','shared-a']);
  const retiring = board.retireMember(id,'shared-a').members.find(member=>member.name==='shared-a');
  assert.equal(retiring.status,'working');
  assert.equal(retiring.retireAfterTurn,true);
  board.post(id,'@shared-a Nhắc một việc.');
  release();
  await until(() => board.get(id).members[3].status === 'done');
  assert.equal(board.get(id).members[2].status,'retired');
  assert.deepEqual(runs,['isolated-a','isolated-b','shared-a','shared-b']);
});

test('replay can page through posts older than the live window after a restart', t => {
  const dir = mkdtempSync(join(tmpdir(),'team-board-replay-'));
  const file = join(dir,'timeline.sqlite');
  let board = new TeamBoard(file,() => assert.fail('A paused board dispatched a worker.'));
  t.after(() => {board.close();rmSync(file,{force:true});rmdirSync(dir);});
  const {id} = board.create({cwd:dir,task:'Timeline',members:[{name:'builder',brief:'Prepare diff'}]});
  board.pause(id);
  board.post(id,'@all Hẹn giao diff.');
  for (let index=0; index<310; index++) board.post(id,'Cập nhật '+index);
  board.close();
  board = new TeamBoard(file,() => assert.fail('A paused board dispatched a worker.'));
  assert.equal(board.get(id).events.length,300);
  const first = board.readHistory(id,{after:0,limit:4});
  assert.deepEqual(first.posts.map(post=>post.seq),[1,2,3,4]);
  assert.equal(first.posts[3].broadcast,true);
  assert.equal(first.head,314);
  assert.equal(first.hasMore,true);
  assert.equal(board.readHistory(id,{after:312,limit:4}).hasMore,false);
});

test('coordinator wakes on a completed worker round and retains its chat for follow-up', async t => {
  const turns = [];
  const board = new TeamBoard(':memory:',async ({member,remember}) => {
    const prior=turns.filter(turn=>turn.name===member.name).length;
    turns.push(member);
    remember(member.threadId ?? 'chat-'+member.name);
    return member.name==='builder' && !prior
      ? {state:'waiting',message:'Chờ thông tin.',notify:[],waitFor:[]}
      : {state:'done',message:member.name==='builder'?'Diff có kiểm thử.':'Kết quả đã tổng hợp.',notify:[],waitFor:[]};
  });
  t.after(() => board.close());
  const {id} = board.create({cwd:process.cwd(),task:'Kiểm tra luồng',coordinator:true,members:[
    {name:'builder',brief:'Chuẩn bị diff'},
  ]});
  await until(() => board.get(id).members[0].status==='waiting');
  assert.deepEqual(turns.map(turn=>turn.name),['builder']);
  board.post(id,'@builder Đủ thông tin rồi.');
  await until(() => board.get(id).members.some(member=>member.role==='coordinator'&&member.status==='done'));
  assert.deepEqual(turns.map(turn=>turn.name),['builder','builder','coordinator']);
  assert.ok(turns[2].inbox.some(post=>post.text.includes('Diff có kiểm thử.')));
  board.post(id,'Tình trạng hiện tại.');
  await delay(20);
  assert.equal(turns.length,3);
  board.post(id,'@coordinator Tóm tắt thêm.');
  await until(() => turns.length===4&&board.get(id).members[1].status==='done');
  assert.equal(turns[3].threadId,'chat-coordinator');
});

test('declared outcomes belong to one active numbered turn and publish after it ends', async t => {
  let finish;
  const wait=new Promise(resolve=>{finish=resolve;});
  const outcomes=[];
  const board=new TeamBoard(':memory:',async ({declaredOutcome})=>{
    await wait;
    const result=declaredOutcome();
    outcomes.push(result);
    return result??{state:'done',message:'Đã tiếp tục.',notify:[],waitFor:[]};
  });
  t.after(()=>{finish();board.close();});
  const {id}=board.create({cwd:process.cwd(),task:'Kết quả theo lượt',members:[
    {name:'builder',brief:'Kiểm tra diff'},
  ]});
  await until(()=>board.get(id).members[0].status==='working');
  assert.throws(()=>board.declareOutcome(id,'builder',{turn:2,state:'done',message:'Sai lượt.'}),/no longer active/);
  board.declareOutcome(id,'builder',{turn:1,state:'waiting',message:'Chờ xác minh.'});
  assert.ok(!board.get(id).events.some(post=>post.text==='Chờ xác minh.'));
  finish();
  await until(()=>board.get(id).members[0].status==='waiting');
  board.post(id,'@builder Đã có kết quả.');
  await until(()=>board.get(id).members[0].status==='done');
  assert.equal(outcomes[0].state,'waiting');
  assert.equal(outcomes[1],undefined);
});

test('the panel finds the latest saved team in precisely the requested project', t => {
  const setup = mkdtempSync(join(tmpdir(),'team-board-panel-'));
  const empty = mkdtempSync(join(tmpdir(),'team-board-empty-'));
  const board = new TeamBoard(':memory:', () => assert.fail('Looking up a board started a model turn.'));
  t.after(() => {board.close();rmdirSync(setup);rmdirSync(empty);});
  const input = cwd => ({cwd,task:'Preview',members:[{name:'builder',brief:'Preview only'}]});
  const first = board.create(input(setup));
  board.pause(first.id);
  const second = board.create(input(setup));
  board.pause(second.id);
  for (let index=0;index<41;index++) {
    const unrelated = board.create(input(process.cwd()));
    board.pause(unrelated.id);
  }
  assert.equal(board.latestIn(setup).id,second.id);
  assert.equal(board.latestIn(empty),null);
});

const report = message => ({state:'done',message,notify:[],waitFor:[]});
const waitForBuilder = {state:'waiting',message:'Chờ bản tiếp theo.',notify:[],waitFor:['builder']};
const dependencyTeam = {
  cwd:process.cwd(),task:'Rà soát các vòng sửa',
  members:[
    {name:'builder',brief:'Chuẩn bị bản sửa'},
    {name:'reviewer',group:'reviewers',brief:'Đọc bản sửa',waitFor:['builder']},
  ],
};

test('all and group posts keep a second-round dependency intact until its new report',async t=>{
  const reviewers=[];
  const board=new TeamBoard(':memory:',async ({member})=>{
    if (member.name==='builder') return report('Có bản sửa.');
    reviewers.push(member);
    return reviewers.length===1?waitForBuilder:report('Đã xem bản mới.');
  });
  t.after(()=>board.close());
  const {id}=board.create(dependencyTeam);
  await until(()=>reviewers.length===1&&board.get(id).members[1].status==='waiting');
  board.pause(id);
  for (const message of ['@reviewers Thông tin cho nhóm.','@all Cập nhật chung.']) {
    const reviewer=board.post(id,message).members[1];
    assert.equal(reviewer.status,'waiting');
    assert.deepEqual(reviewer.waitFor,['builder']);
    assert.ok(reviewer.inbox.some(post=>post.text===message));
  }
  board.resume(id);
  await until(()=>reviewers.length===2&&board.get(id).members[1].status==='done');
  const messages=reviewers[1].inbox.map(post=>post.text);
  assert.ok(messages.includes('@reviewers Thông tin cho nhóm.'));
  assert.ok(messages.includes('Có bản sửa.'));
});

test('a group post during a turn does not cancel the dependency set by its outcome',async t=>{
  let release;
  const held=new Promise(resolve=>{release=resolve;});
  const board=new TeamBoard(':memory:',async ({member})=>{
    if (member.name==='builder') return report('Đã có bản đầu.');
    await held;
    return waitForBuilder;
  });
  t.after(()=>{release();board.close();});
  const {id}=board.create(dependencyTeam);
  await until(()=>board.get(id).members[1].status==='working');
  board.pause(id);
  board.post(id,'@reviewers Ghi chú chung.');
  release();
  await until(()=>board.get(id).members[1].status!=='working');
  const reviewer=board.get(id).members[1];
  assert.equal(reviewer.status,'waiting');
  assert.deepEqual(reviewer.waitFor,['builder']);
  assert.ok(reviewer.inbox.some(post=>post.text==='@reviewers Ghi chú chung.'));
});

test('a named mention can override both initial and subsequent dependencies',async t=>{
  const board=new TeamBoard(':memory:',async ({member})=>member.name==='builder'
    ? report('Đã có bản đầu.') : waitForBuilder);
  t.after(()=>board.close());
  const initial=board.create(dependencyTeam);
  board.pause(initial.id);
  assert.equal(board.post(initial.id,'@reviewers Ghi chú.').members[1].status,'waiting');
  const woken=board.post(initial.id,'@reviewer Tiếp tục phần khác.').members[1];
  assert.equal(woken.status,'queued');
  assert.deepEqual(woken.waitFor,[]);

  const later=board.create(dependencyTeam);
  await until(()=>board.get(later.id).members[1].waitAfter?.builder===1);
  const resumed=board.post(later.id,'@reviewer Tiếp tục phần khác.').members[1];
  assert.equal(resumed.status,'queued');
  assert.deepEqual(resumed.waitFor,[]);
});

test('spending the final turn on a worker reports budget until the coordinator can finish',async t=>{
  const calls=[];
  const board=new TeamBoard(':memory:',async ({member})=>{
    calls.push(member.name);
    return member.name==='coordinator'
      ? {state:'waiting',message:'Đã tổng hợp.',notify:[],waitFor:[]}
      : report('Đã sửa.');
  });
  t.after(()=>board.close());
  const {id}=board.create({cwd:process.cwd(),task:'Kiểm tra giới hạn',coordinator:true,
    turnLimit:1,members:[{name:'builder',brief:'Sửa'}]});
  await until(()=>board.get(id).members[0].status==='done');
  const pending=board.get(id);
  assert.equal(teamPhase(pending),'budget');
  assert.ok(pending.events.some(event=>event.kind==='monitor'&&event.text.includes('turn limit')));
  assert.deepEqual(calls,['builder']);
  board.resume(id,1);
  await until(()=>calls.length===2&&board.get(id).members[1].status==='waiting');
  assert.equal(teamPhase(board.get(id)),'done');
});

test('an earlier coordinator summary does not finish a later worker round',async t=>{
  const board=new TeamBoard(':memory:',async ()=>report('Hoàn thành lượt.'));
  t.after(()=>board.close());
  const {id}=board.create({cwd:process.cwd(),task:'Kiểm tra hai vòng',coordinator:true,
    turnLimit:2,members:[{name:'builder',brief:'Sửa'}]});
  await until(()=>board.get(id).members[1].status==='done');
  assert.equal(teamPhase(board.get(id)),'done');
  board.resume(id,1);
  board.post(id,'@builder Chuẩn bị bản thứ hai.');
  await until(()=>board.get(id).members[0].completed===2);
  assert.equal(teamPhase(board.get(id)),'budget');
});

test('twelve workers plus a coordinator can replace a worker but cannot add a thirteenth',t=>{
  const board=new TeamBoard(':memory:',async ()=>report('Đã xong.'));
  t.after(()=>board.close());
  const members=Array.from({length:12},(_,index)=>({name:'worker-'+index,brief:'Kiểm tra'}));
  const {id}=board.create({cwd:process.cwd(),task:'Kiểm tra roster',coordinator:true,members});
  board.pause(id);
  assert.throws(()=>board.addMember(id,{name:'extra',brief:'Dư worker'}),/12 active/);
  const replaced=board.addMember(id,{name:'backup',brief:'Thay người'},{replaces:'worker-0'});
  assert.equal(replaced.members[0].status,'retired');
  assert.equal(replaced.members.filter(member=>member.status!=='retired').length,13);
});

for (const actor of ['coordinator','reviewer']) {
  test('@'+actor+' can invite a helper from a saved teammate chat',async t=>{
    const hold=Promise.withResolvers();
    const turns=new Map();
    const board=new TeamBoard(':memory:',async ({member,remember})=>{
      remember({threadId:'chat-'+member.name});
      turns.set(member.name,member);
      if (member.name===actor) await hold.promise;
      return report('[done] Đã chạy.');
    });
    t.after(()=>{board.close();hold.resolve();});
    const {id}=board.create({cwd:process.cwd(),task:'Dùng lại lịch sử',coordinator:actor==='coordinator',members:[
      {name:'builder',brief:'Chuẩn bị bản sửa'},
      ...(actor==='reviewer'?[{name:'reviewer',brief:'Rà soát',waitFor:['builder']}]:[]),
    ]});
    await until(()=>turns.has(actor));
    const helper=board.addMember(id,{name:'helper',brief:'Đối chiếu'},{actor,fork:'builder'}).members.at(-1);
    assert.equal(helper.addedBy,actor);
    assert.equal(helper.forkFrom,'chat-builder');
    await until(()=>turns.has('helper'));
    assert.equal(turns.get('helper').forkFrom,'chat-builder');
  });
}

test('an invited member can inherit a saved chat from the same team',async t=>{
  const turns=[];
  const board=new TeamBoard(':memory:',async ({member,remember})=>{
    turns.push(member);
    remember('session-'+member.name);
    return report('Đã chạy.');
  });
  t.after(()=>board.close());
  const {id}=board.create({cwd:process.cwd(),task:'Tiếp tục việc từ lịch sử',
    members:[{name:'builder',brief:'Chuẩn bị báo cáo'}]});
  const helper={name:'helper',brief:'Rà soát báo cáo'};
  assert.throws(()=>board.addMember(id,helper,{fork:'builder'}),/saved chat/);
  await until(()=>board.get(id).members[0].status==='done');
  assert.throws(()=>board.addMember(id,helper,{fork:'unknown'}),/saved chat/);
  const added=board.addMember(id,helper,{fork:'builder'}).members[1];
  assert.equal(added.threadId,null);
  assert.equal(added.forkFrom,'session-builder');
  await until(()=>board.get(id).members[1].status==='done');
  assert.equal(turns[1].forkFrom,'session-builder');
  assert.equal(board.get(id).members[0].threadId,'session-builder');
});

test('worktree cleanup holds dispatch and saves the cleared workspace alongside a concurrent mention',async t=>{
  let finishWork;
  const working=new Promise(resolve=>{finishWork=resolve;});
  let finishCleanup;
  const cleaning=new Promise(resolve=>{finishCleanup=resolve;});
  const seen=[];
  const workspace={path:'owned-worktree',cwd:'owned-worktree',base:'base'};
  const board=new TeamBoard(':memory:',async ({member,remember})=>{
    seen.push(member);
    if (seen.length===1) {
      remember({workspace});
      await working;
    }
    return report('Đã xong.');
  });
  t.after(()=>{finishWork();finishCleanup();board.close();});
  const {id}=board.create({cwd:process.cwd(),task:'Dọn checkout',
    members:[{name:'builder',brief:'Sửa',worktree:true}]},{root:process.cwd(),commit:'base'});
  await until(()=>board.get(id).members[0].workspace);
  await assert.rejects(board.removeWorktree(id,'builder',()=>assert.fail('Must not remove a running checkout')),/finished|retired/);
  finishWork();
  await until(()=>teamPhase(board.get(id))==='done');
  const result=board.removeWorktree(id,'builder',async ({member})=>{
    assert.deepEqual(member.workspace,workspace);
    await cleaning;
  });
  board.post(id,'@builder Kiểm tra tiếp.');
  await delay(20);
  assert.equal(seen.length,1);
  finishCleanup();
  assert.equal((await result).members[0].workspace,undefined);
  await until(()=>seen.length===2&&teamPhase(board.get(id))==='done');
  assert.equal(seen[1].workspace,undefined);
  assert.ok(seen[1].inbox.some(post=>post.text.includes('Kiểm tra tiếp')));
});

test('replaces cannot turn a coordinator into a worker',t=>{
  const board=new TeamBoard(':memory:',async()=>report('Đã xong.'));
  t.after(()=>board.close());
  const {id}=board.create({cwd:process.cwd(),task:'Điều phối',coordinator:true,
    members:[{name:'builder',brief:'Sửa'}]});
  assert.throws(()=>board.addMember(id,{name:'backup',brief:'Kiểm tra'},{replaces:'coordinator'}),/coordinator/i);
  assert.equal(board.get(id).members.find(member=>member.name==='coordinator').role,'coordinator');
});

test('a consumed fork marker is removed from saved member state',async t=>{
  const board=new TeamBoard(':memory:',async ({member,remember})=>{
    remember({threadId:'thread-'+member.name,...(member.forkFrom?{forkFrom:null}:{})});
    return report('Đã xong.');
  });
  t.after(()=>board.close());
  const {id}=board.create({cwd:process.cwd(),task:'Lưu fork',
    members:[{name:'builder',brief:'Sửa'}]});
  await until(()=>board.get(id).members[0].status==='done');
  board.addMember(id,{name:'helper',brief:'Rà soát'},{fork:'builder'});
  await until(()=>board.get(id).members[1].status==='done');
  assert.equal(board.get(id).members[1].threadId,'thread-helper');
  assert.ok(!Object.hasOwn(board.get(id).members[1],'forkFrom'));
});

test('wait for board returns matching history immediately and observes new posts without issuing turns',async t=>{
  const board=new TeamBoard(':memory:',async()=>report('Xong.'));
  t.after(()=>board.close());
  const {id}=board.create({cwd:process.cwd(),task:'Theo dõi bảng',members:[{name:'builder',brief:'Kiểm tra'}]});
  board.pause(id);
  board.manageChannel(id,{op:'create',channel:'qa'});
  const baseline=board.readHistory(id).head;
  board.post(id,'Tin có sẵn', 'qa');
  const immediate=await board.waitForBoard(id,{since:baseline,channel:'qa'});
  assert.equal(immediate.wokeBy,'post');
  assert.equal(immediate.posts[0].text,'Tin có sẵn');
  board.resume(id);
  const waiting=board.waitForBoard(id,{channel:'qa',mentionsOnly:true,timeoutSec:2});
  board.post(id,'@coordinator Sai kênh');
  board.post(id,'Không nhắc điều phối','qa');
  board.post(id,'@coordinator Báo cáo mới','qa');
  const received=await waiting;
  assert.equal(received.wokeBy,'post');
  assert.deepEqual(received.posts.map(post=>post.text),['@coordinator Báo cáo mới']);
  assert.equal(received.status.turns,0);
});

test('briefs follow the posting channel for initial and invited members',t=>{
  const board=new TeamBoard(':memory:',async()=>assert.fail('Unexpected model turn'));
  t.after(()=>board.close());
  const {id}=board.create({cwd:process.cwd(),task:'Phân luồng brief',members:[
    {name:'builder',brief:'Sửa API',channels:['backend']}, {name:'reviewer',brief:'Rà soát tổng thể'},
  ]});
  board.addMember(id,{name:'helper',brief:'Soát API',channels:['backend']});
  const briefs=channel=>board.readHistory(id,{channel}).posts.filter(post=>post.kind==='brief');
  assert.deepEqual(briefs('backend').map(post=>[post.targets,post.text]),[
    [['builder'],'Sửa API'],[['helper'],'Soát API'],
  ]);
  assert.deepEqual(briefs('main').map(post=>post.targets),[['reviewer']]);
});

for (const phase of ['done','stalled','budget','paused','retired']) {
  test('a board already in '+phase+' returns its phase immediately',async t=>{
    const board=new TeamBoard(':memory:',async()=>phase==='done'?report('Xong.'):{...report('Chờ.'),state:'waiting'});
    t.after(()=>board.close());
    const {id}=board.create({cwd:process.cwd(),task:'Chờ bảng',turnLimit:phase==='budget'?1:2,
      members:[{name:'builder',brief:'Kiểm tra'}]});
    if (phase==='paused') board.pause(id);
    if (phase==='retired') board.retireMember(id,'builder');
    await until(()=>teamPhase(board.get(id))===phase);
    const waiting=board.waitForBoard(id,{timeoutSec:1});
    const listeners=board.signals.listenerCount(id);
    const result=await waiting;
    assert.equal(result.wokeBy,'phase');
    assert.equal(result.phase,phase);
    assert.equal(listeners,0);
    assert.deepEqual(result.posts,[]);
  });
}

test('a board wait observes phase transitions, times out and removes cancelled listeners',async t=>{
  const running=Promise.withResolvers();
  const board=new TeamBoard(':memory:',()=>running.promise);
  t.after(()=>{
    if (!board.closed) board.close();
    running.resolve(report('Xong.'));
  });
  const {id}=board.create({cwd:process.cwd(),task:'Thức theo trạng thái',members:[{name:'builder',brief:'Kiểm tra'}]});
  const phase=board.waitForBoard(id,{mentionsOnly:true,timeoutSec:3});
  board.pause(id);
  assert.equal((await phase).wokeBy,'phase');
  board.resume(id);
  await until(()=>teamPhase(board.get(id))==='working');
  assert.equal((await board.waitForBoard(id,{timeoutSec:1})).wokeBy,'timeout');
  const controller=new AbortController();
  const cancelled=board.waitForBoard(id,{},controller.signal);
  assert.equal(board.signals.listenerCount(id),1);
  controller.abort();
  await assert.rejects(cancelled,{name:'AbortError'});
  assert.equal(board.signals.listenerCount(id),0);
  const closing=board.waitForBoard(id,{});
  board.close();
  await assert.rejects(closing,/closed/);
  assert.equal(board.signals.listenerCount(id),0);
});

test('channel subscriptions route # mentions, preserve waits and support archived history',t=>{
  const board=new TeamBoard(':memory:',async()=>assert.fail('Unexpected model turn'));
  t.after(()=>board.close());
  const {id}=board.create({cwd:process.cwd(),task:'Tách kênh',members:[
    {name:'builder',brief:'Sửa'}, {name:'tester',brief:'Kiểm thử',waitFor:['builder']},
  ]});
  board.pause(id);
  board.manageChannel(id,{op:'create',channel:'qa',topic:'Kiểm thử hồi quy'});
  board.manageChannel(id,{op:'subscribe',channel:'qa',member:'tester'});
  const posted=board.post(id,'@#qa Thông báo','qa');
  assert.deepEqual(posted.events.at(-1).targets,['tester']);
  assert.equal(posted.members[1].status,'waiting');
  const at=(actor,channel)=>board.readPosts(id,{actor,channel,limit:20}).posts.map(post=>post.text);
  assert.ok(!at('builder').includes('@#qa Thông báo'));
  assert.ok(at('tester').includes('@#qa Thông báo'));
  assert.ok(at('builder','*').includes('@#qa Thông báo'));
  assert.throws(()=>board.post(id,'@#main Dừng'),/@#main/);
  board.manageChannel(id,{op:'unsubscribe',channel:'qa',member:'tester'});
  assert.deepEqual(board.post(id,'@#qa Sau unsubscribe').events.at(-1).targets,[]);
  board.manageChannel(id,{op:'archive',channel:'qa'});
  assert.throws(()=>board.post(id,'Đăng mới','qa'),/archived/);
  assert.throws(()=>board.manageChannel(id,{op:'archive',channel:'main'}),/main/);
  assert.deepEqual(board.post(id,'@#qa @#missing Bỏ qua').events.at(-1).targets,[]);
  assert.deepEqual(at('builder','qa'),['@#qa Thông báo']);
});

test('sharded starts and invites use common groups and group retirement is atomic',t=>{
  const board=new TeamBoard(':memory:',async()=>assert.fail('Unexpected model turn'));
  t.after(()=>board.close());
  const {id,members}=board.create({cwd:process.cwd(),task:'Chia lô',members:[
    {name:'builder',brief:'Sửa',n:2},
    {name:'review',brief:'Đối chiếu',tasks:['HTML','API']},
  ]});
  board.pause(id);
  assert.deepEqual(members.map(member=>[member.name,member.group]),[
    ['builder-1','builder'],['builder-2','builder'],['review-1','review'],['review-2','review'],
  ]);
  assert.equal(members.at(-1).brief,'Đối chiếu\n\nAssigned slice: API');
  assert.throws(()=>board.addMember(id,{name:'mixed',brief:'X',n:2,tasks:['A','B']}),/tasks/);
  assert.throws(()=>board.addMember(id,{name:'replacement',brief:'X',n:2},{replaces:'builder-1'}),/replaces/);
  board.addMember(id,{name:'helpers',brief:'X',tasks:['A','B']});
  board.addMember(id,{name:'depends',brief:'Chờ',waitFor:['helpers-2']});
  assert.throws(()=>board.retireMember(id,'helpers'),/depends.*need a report/);
  assert.ok(board.get(id).members.filter(member=>member.group==='helpers').every(member=>member.status==='queued'));
  const retired=board.retireMember(id,'review');
  assert.ok(retired.members.filter(member=>member.group==='review').every(member=>member.status==='retired'));
  assert.equal(board.setTeamTitle(id,'Nhóm mới').title,'Nhóm mới');
});

test('live buffers are capped in memory and expire when the corresponding turn settles',async t=>{
  let active;
  let release;
  const held=new Promise(resolve=>{release=resolve;});
  const board=new TeamBoard(':memory:',async request=>{active=request;await held;return report('Xong.');});
  t.after(()=>{release();board.close();});
  const {id}=board.create({cwd:process.cwd(),task:'Theo dõi hoạt động',members:[{name:'builder',brief:'Kiểm tra'}]});
  await until(()=>active);
  for (let i=0;i<12;i++) active.onActivity({kind:'tool',label:'Tool '+i});
  active.onActivity({kind:'draft',delta:JSON.stringify(report('x'.repeat(800)))});
  const live=board.activityFor(id).builder;
  assert.equal(live.steps.length,10);
  assert.equal(live.steps[0].label,'Tool 2');
  assert.equal(live.draft,'x'.repeat(600));
  assert.ok(!JSON.stringify(board.get(id)).includes('Tool 2'));
  release();
  await until(()=>board.get(id).members[0].status==='done');
  active.onActivity({kind:'tool',label:'Sự kiện trễ'});
  assert.deepEqual(board.activityFor(id),{});
});

test('a live report shows only decoded message text while JSON is still streaming',async t=>{
  let active;
  const hold=Promise.withResolvers();
  const board=new TeamBoard(':memory:',async request=>{
    active=request;
    await hold.promise;
    return report('Xong.');
  });
  t.after(()=>{board.close();hold.resolve();});
  const {id}=board.create({cwd:process.cwd(),task:'Đọc nháp',members:[{name:'builder',brief:'Kiểm tra'}]});
  await until(()=>active);
  function draft(delta) {
    active.onActivity({kind:'draft',delta});
    return board.activityFor(id).builder.draft;
  }
  const drafting='Drafting report…';
  assert.equal(draft(''),drafting);
  assert.equal(draft('{"state":"done","mess'),drafting);
  assert.equal(draft('age":"'),drafting);
  assert.equal(draft('Dòng 1\\'),'Dòng 1');
  assert.equal(draft('nDòng 2: \\"OK\\" và \\\\'),'Dòng 1\nDòng 2: "OK" và \\');
  assert.equal(draft(' \\u26'),'Dòng 1\nDòng 2: "OK" và \\ ');
  const done='Dòng 1\nDòng 2: "OK" và \\ ☀';
  assert.equal(draft('00","notify":[],"waitFor":[]}'),done);
  assert.equal(draft(''),drafting);
  const fence=String.fromCharCode(96).repeat(3);
  assert.equal(draft('Ghi chú\n'+fence+'json\n{"state":"done",'),drafting);
  assert.equal(draft('"message":"Bản sửa đã xong."}'), 'Bản sửa đã xong.');
});

test('a saved 1.7.0 board restores public results without scheduling a removed role',t=>{
  const dir=mkdtempSync(join(tmpdir(),'team-board-legacy-roster-'));
  const file=join(dir,'test.sqlite');
  const run=()=>assert.fail('Unexpected model turn');
  let board=new TeamBoard(file,run);
  t.after(()=>{board.close();rmSync(file);rmdirSync(dir);});
  const team=board.create({cwd:dir,task:'Đọc dữ liệu cũ',members:[{name:'builder',brief:'Sửa'}]});
  Object.assign(team.members[0],{status:'done',threadId:'chat-builder'});
  team.members.push({name:'narrator',role:'narrator',status:'working',waitFor:[],inbox:[]});
  team.overview={headline:'Tổng quan cũ'};
  board.record(team,'builder','[done] Bản sửa đã xong.',[],'message');
  board.save(team);
  board.close();
  board=new TeamBoard(file,run);
  const restored=board.get(team.id);
  assert.equal(board.hasRunningTurns(),false);
  assert.equal(teamPhase(restored),'done');
  assert.deepEqual(restored.members.map(member=>[member.name,member.threadId]),[['builder','chat-builder']]);
  assert.equal(restored.overview,undefined);
  assert.equal(board.readHistory(team.id).posts.at(-1).text,'[done] Bản sửa đã xong.');
});

test('childEnvironment strips host session and Windows MSIX markers without altering other variables',()=>{
  const base={
    PATH:'C:\\Windows\\System32',
    CODEX_HOME:'C:\\Users\\fixture\\.codex',
    TEAM_BOARD_DATA:'C:\\Temp\\board',
    CODEX_WINDOWS_REGISTERED_CORE:'1',
    CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY:'OpenAI.Codex_fixture',
    CODEX_WINDOWS_SANDBOX_PROXY_PORTS:'1234',
    CODEX_SANDBOX:'unelevated',
    CODEX_SANDBOX_NETWORK_DISABLED:'1',
    CODEX_SANDBOX_LAUNCH_COUNT:'2',
    CODEX_SANDBOX_LAUNCH_BYTES:'512',
    CODEX_THREAD_ID:'parent-thread',
    CODEX_TOOL_CALL_ID:'parent-call',
    CODEX_SESSION_ID:'parent-session',
    CODEX_DAEMON_SHUTDOWN_FILE:'shutdown.flag',
    CODEX_DAEMON_SHUTDOWN_SOCKET:'\\\\.\\pipe\\shutdown',
    CODEX_DAEMON_TELEMETRY_HANDOFF:'handoff',
  };
  const filtered=childEnvironment(base);
  assert.equal(filtered.PATH,base.PATH);
  assert.equal(filtered.CODEX_HOME,base.CODEX_HOME);
  assert.equal(filtered.TEAM_BOARD_DATA,base.TEAM_BOARD_DATA);
  for (const key of [
    'CODEX_WINDOWS_REGISTERED_CORE','CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY',
    'CODEX_WINDOWS_SANDBOX_PROXY_PORTS','CODEX_SANDBOX','CODEX_SANDBOX_NETWORK_DISABLED',
    'CODEX_SANDBOX_LAUNCH_COUNT','CODEX_SANDBOX_LAUNCH_BYTES','CODEX_THREAD_ID',
    'CODEX_TOOL_CALL_ID','CODEX_SESSION_ID','CODEX_DAEMON_SHUTDOWN_FILE',
    'CODEX_DAEMON_SHUTDOWN_SOCKET','CODEX_DAEMON_TELEMETRY_HANDOFF',
  ]) {
    assert.equal(Object.hasOwn(filtered,key),false,key);
    assert.ok(Object.hasOwn(base,key),key);
  }
});

test('sharded group names expand in waitFor and outcome threads, and empty channel strings act as omitted',t=>{
  const board=new TeamBoard(':memory:',async()=>assert.fail('Unexpected model turn'));
  t.after(()=>board.close());
  const created=board.create({
    cwd:process.cwd(),
    task:'Verify shard group references',
    threads:[{id:'research',title:'Research',goal:'Design + assets',members:['design']}],
    members:[
      {name:'design',brief:'Research',tasks:['Layout','Typography']},
      {name:'builder',brief:'Build',waitFor:['design']},
    ],
  });
  board.pause(created.id);
  const builder=created.members.find(m=>m.name==='builder');
  assert.deepEqual(builder.waitFor,['design-1','design-2']);
  assert.deepEqual(created.threads[0].members,['design-1','design-2']);
  board.post(created.id,'Empty channel defaults to main','');
  const recent=board.readPosts(created.id,{channel:'',limit:10});
  assert.ok(recent.posts.some(p=>p.text==='Empty channel defaults to main'));
  const history=board.readHistory(created.id,{channel:'',limit:10});
  assert.ok(history.posts.some(p=>p.text==='Empty channel defaults to main'));
});

test('trusted parentSessionId persists, untrusted input.parentSessionId is rejected, and fork: coordinator works across create and addMember',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'hive-parent-fork-'));
  const file=join(dir,'test.sqlite');
  const seen=[];
  let board=new TeamBoard(file,async ({team,member,remember})=>{
    seen.push({name:member.name,parentSessionId:team.parentSessionId,forkSource:member.forkSource,forkFrom:member.forkFrom});
    remember({
      threadId:'child-'+member.name,
      executionMode:member.name.startsWith('shard')?'attached':'subagent',
      subagentName:'hive-'+member.name,
      ...(member.forkSource?{forkSource:null}:{}),
    });
    return report('[done] Verified.');
  });
  t.after(()=>{board.close();rmSync(dir,{recursive:true,force:true});});

  assert.throws(()=>board.create({cwd:dir,task:'Spoofed',parentSessionId:'spoof',members:[{name:'a',brief:'x'}]}),/host/i);
  assert.throws(()=>board.create({cwd:dir,task:'No parent',members:[{name:'a',brief:'x',fork:'coordinator'}]}),/parent session/i);
  assert.throws(()=>board.create({cwd:dir,task:'Bad initial fork',members:[{name:'a',brief:'x',fork:'other'}]},undefined,{parentSessionId:'parent-1'}),/only fork from "coordinator"/i);
  assert.throws(()=>board.create({cwd:dir,task:'Bad id',members:[{name:'a',brief:'x'}]},undefined,{parentSessionId:'bad\0id'}),/invalid characters/i);

  const created=board.create({
    cwd:dir,task:'Warm fork start',
    members:[
      {name:'researcher',brief:'Investigate',fork:'@coordinator'},
      {name:'shard',brief:'Split',tasks:['A','B'],fork:'coordinator'},
    ],
  },undefined,{parentSessionId:'parent-session-42'});
  assert.equal(created.parentSessionId,'parent-session-42');
  assert.equal(created.members[0].forkSource,'coordinator');
  assert.equal(created.members[1].forkSource,'coordinator');
  assert.equal(created.members[2].forkSource,'coordinator');
  assert.equal(Object.hasOwn(created.members[0],'fork'),false);

  await until(()=>board.get(created.id).members.every(m=>m.status==='done'));
  assert.deepEqual(seen.map(s=>s.parentSessionId),['parent-session-42','parent-session-42','parent-session-42']);
  assert.deepEqual(seen.map(s=>s.forkSource),['coordinator','coordinator','coordinator']);

  const afterCreate=board.get(created.id);
  for (const m of afterCreate.members) {
    assert.equal(Object.hasOwn(m,'forkSource'),false);
    assert.equal(m.subagentName,'hive-'+m.name);
  }
  assert.equal(afterCreate.members[0].executionMode,'subagent');
  assert.equal(afterCreate.members[1].executionMode,'attached');

  assert.throws(()=>board.addMember(created.id,{name:'bad',brief:'x',fork:'coordinator'},{fork:'researcher'}),/matching fork/i);
  const bySpec=board.addMember(created.id,{name:'followup-a',brief:'Check A',fork:'coordinator'});
  assert.equal(bySpec.members.at(-1).forkSource,'coordinator');
  const byTop=board.addMember(created.id,{name:'followup-b',brief:'Check B'},{fork:'coordinator'});
  assert.equal(byTop.members.at(-1).forkSource,'coordinator');
  await until(()=>board.get(created.id).members.every(m=>m.status==='done'));

  board.close();
  board=new TeamBoard(file,()=>assert.fail('Restored done team should not dispatch'));
  const reopened=board.get(created.id);
  assert.equal(reopened.parentSessionId,'parent-session-42');
  assert.equal(reopened.members.find(m=>m.name==='researcher').executionMode,'subagent');
  assert.equal(reopened.members.find(m=>m.name==='researcher').subagentName,'hive-researcher');
  assert.equal(reopened.members.find(m=>m.name==='shard-1').executionMode,'attached');
});

test('non-coordinator workers cannot fork coordinator, while addMember without parentSessionId falls back to saved coordinator member',async t=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const board=new TeamBoard(':memory:',async ({member,remember})=>{
    remember('saved-'+member.name);
    if (member.name==='builder') await gate;
    return report('[done] OK.');
  });
  t.after(()=>{release();board.close();});

  const withParent=board.create({cwd:process.cwd(),task:'Peer restriction',members:[{name:'builder',brief:'Work'}]},undefined,{parentSessionId:'parent-99'});
  await until(()=>board.get(withParent.id).members[0].status==='working');
  assert.throws(()=>board.addMember(withParent.id,{name:'helper',brief:'Sneak'},{actor:'builder',fork:'coordinator'}),/coordinator/i);
  release();
  await until(()=>board.get(withParent.id).members[0].status==='done');

  const legacyBoard=new TeamBoard(':memory:',async ({member,remember})=>{
    remember('chat-'+member.name);
    return report('[done] OK.');
  });
  t.after(()=>legacyBoard.close());
  const legacy=legacyBoard.create({cwd:process.cwd(),task:'Legacy coordinator',coordinator:true,members:[{name:'builder',brief:'Work'}]});
  await until(()=>teamPhase(legacyBoard.get(legacy.id))==='done');
  const added=legacyBoard.addMember(legacy.id,{name:'helper',brief:'From coordinator'},{fork:'coordinator'});
  assert.equal(added.members.at(-1).forkFrom,'chat-coordinator');
  assert.equal(added.members.at(-1).forkSource,undefined);
});

test('restoring legacy 1.8/1.9 SQLite teams defaults executionMode to session only when threadId exists',t=>{
  const dir=mkdtempSync(join(tmpdir(),'hive-legacy-mode-'));
  const file=join(dir,'test.sqlite');
  let board=new TeamBoard(file,()=>assert.fail('Must not dispatch'));
  t.after(()=>{board.close();rmSync(dir,{recursive:true,force:true});});
  board.save({
    id:'legacy-19',paused:true,cwd:dir,task:'Legacy team',title:'Legacy team',
    concurrency:2,turns:1,turnLimit:8,channels:[{name:'main',archived:false}],events:[],
    members:[
      {name:'ran',brief:'Done',status:'done',writable:false,waitFor:[],channels:[],threadId:'old-thread-1',inbox:[],completed:1},
      {name:'queued',brief:'Never ran',status:'waiting',writable:false,waitFor:[],channels:[],threadId:null,inbox:[],completed:0},
    ],
  });
  board.close();
  board=new TeamBoard(file,()=>assert.fail('Must not dispatch'));
  const restored=board.get('legacy-19');
  assert.equal(restored.members[0].executionMode,'session');
  assert.equal(restored.members[1].executionMode,undefined);
});
