import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CodexRunner } from './codex.mjs';

const outcome = {state:'done',message:'Đã kiểm tra.',notify:[],waitFor:[]};
const fence = '`'.repeat(3);

function fixture(output=JSON.stringify(outcome), events, rejectProviderChange=false) {
  const runner=new CodexRunner();
  const calls=[];
  const team={id:'team',title:'Nhóm kiểm thử',cwd:process.cwd(),task:'Xác minh kết quả',members:[]};
  const threadId='saved-worker';
  let nextTurn=0;
  let forks=0;
  const providers=new Map();
  const archived=new Set();
  runner.start=async()=>{};
  runner.rpc=async (method,params)=>{
    calls.push({method,params});
    if (method==='config/read') return {config:{model_provider:'fixture-default'}};
    if (method==='thread/name/set'||method==='thread/unsubscribe') return {};
    if (method==='thread/archive') {
      archived.add(params.threadId);
      return {};
    }
    if (method==='thread/unarchive') {
      if (archived.delete(params.threadId)) return {};
      throw Error('no archived rollout found for thread id '+params.threadId);
    }
    if (method==='thread/start'||method==='thread/fork') {
      const id=method==='thread/start'?threadId:'fork-'+(++forks);
      const modelProvider=params.modelProvider??'fixture-default';
      providers.set(id,modelProvider);
      return {thread:{id},model:params.model,modelProvider};
    }
    if (method==='thread/resume') {
      const modelProvider=providers.get(params.threadId);
      if (rejectProviderChange&&modelProvider!==params.modelProvider) {
        if (forks===0) return {thread:{id:params.threadId},modelProvider};
        throw Error('Cannot change this thread\'s model provider on resume.');
      }
      return {thread:{id:params.threadId},model:params.model,modelProvider:params.modelProvider};
    }
    assert.equal(method,'turn/start');
    const id='turn-'+(++nextTurn);
    const emit=(method,values)=>runner.receive(JSON.stringify({method,params:{threadId:params.threadId,...values}}));
    const message=(turnId,text)=>emit('item/completed',{turnId,item:{type:'agentMessage',text}});
    const finish=(id)=>emit('turn/completed',{turn:{id,status:'completed'}});
    if (events) events({id,message,finish,emit});
    else setImmediate(()=>{message(id,output);finish(id);});
    return {turn:{id}};
  };
  return {
    calls,runner,archived,team,
    run:(fields={},remember=()=>{},onActivity)=>runner.run({team,
      member:{name:'worker',brief:'Kiểm tra',inbox:[],lastTurn:1,...fields},
      remember,onActivity,
    }),
    threadId,
  };
}

test('the last fenced JSON outcome wins over a previous example and prose', async()=>{
  const earlier={...outcome,message:'Ví dụ cũ'};
  const output=['Đã kiểm thử.',fence+'json',JSON.stringify(earlier),fence,
    'Kết quả chính thức',fence+'JSON',JSON.stringify(outcome,null,2),fence,'Hết.'].join('\r\n');
  assert.deepEqual(await fixture(output).run(),outcome);
});

test('a trailing balanced JSON object accepts braces, quotes and escapes inside its strings', async()=>{
  const result={...outcome,message:'Chuỗi: } và {, dấu " trích dẫn, \\ cuối',notify:['builder']};
  const output='Ghi chú mở { và " trước báo cáo\n'+JSON.stringify(result,null,2);
  assert.deepEqual(await fixture(output).run(),result);
});

test('prose fallbacks reject malformed and schema-invalid outcomes', async()=>{
  for (const result of [
    {...outcome,state:'failed'}, {...outcome,message:'  '}, {...outcome,notify:[1]},
    {...outcome,waitFor:'builder'}, {...outcome,extra:true},
  ]) {
    const json=JSON.stringify(result);
    await assert.rejects(fixture('Prose\n'+json).run(),/not valid working-status JSON/);
    await assert.rejects(fixture(fence+'json\n'+json+'\n'+fence+'\nProse').run(),/not valid working-status JSON/);
  }
  await assert.rejects(fixture('Prose {"state":"done"').run(),/not valid working-status JSON/);
});

test('structured output and a single unlabeled fence still work', async()=>{
  assert.deepEqual(await fixture().run(),outcome);
  assert.deepEqual(await fixture(fence+'\n'+JSON.stringify(outcome)+'\n'+fence).run(),outcome);
});

test('archived threads unarchive before resume with the selected scope and archive after each turn',async()=>{
  const session=fixture();
  await session.run({model:'gpt-fixture'});
  await session.run({threadId:session.threadId,model:'xingchi/gpt-fixture',effort:'low'});
  await session.run({threadId:session.threadId,model:'xingchi/gpt-fixture',effort:'low'});
  await session.run({threadId:session.threadId,model:'gpt-fixture'});
  assert.deepEqual(session.calls.map(call=>call.method),[
    'thread/start','thread/name/set','turn/start','thread/archive',
    'thread/unarchive','thread/resume','turn/start','thread/archive',
    'thread/unarchive','thread/resume','turn/start','thread/archive',
    'thread/unarchive','config/read','thread/resume','turn/start','thread/archive',
  ]);
  const switches=session.calls.filter(call=>call.method==='thread/resume').map(call=>call.params);
  assert.deepEqual(switches.map(params=>params.threadId),Array(3).fill(session.threadId));
  assert.equal(switches[0].modelProvider,'desktop-xingchi');
  assert.equal(switches[0].config.model_reasoning_effort,'low');
  assert.equal(switches[2].modelProvider,'fixture-default');
  assert.equal(switches[2].config.model_reasoning_effort,undefined);
  assert.equal(session.runner.loadedThreads.has(session.threadId),false);
  assert.deepEqual(session.calls.find(call=>call.method==='thread/name/set').params,
    {threadId:session.threadId,name:'🐝 @worker · Nhóm kiểm thử'});
});

test('a naming error does not stop a turn, and a failed turn still archives its chat',async()=>{
  const session=fixture(undefined,({id,emit})=>{
    setImmediate(()=>emit('turn/completed',{turn:{id,status:'failed',error:{message:'Fixture turn failed'}}}));
  });
  const rpc=session.runner.rpc;
  session.runner.rpc=async (method,params)=>{
    if (method==='thread/name/set') {
      session.calls.push({method,params});
      throw Error('Name rejected');
    }
    return rpc(method,params);
  };
  await assert.rejects(session.run(),/Fixture turn failed/);
  assert.deepEqual(session.calls.map(call=>call.method),['thread/start','thread/name/set','turn/start','thread/archive']);
  assert.equal(session.archived.has(session.threadId),true);
});

test('a new chat caps its title at 95 characters without splitting emoji',async()=>{
  const session=fixture();
  session.team.title='Nội dung '+'🌇'.repeat(95);
  await session.run();
  const {name}=session.calls.find(call=>call.method==='thread/name/set').params;
  assert.equal([...name].length,95);
  assert.ok(name.startsWith('🐝 @worker · Nội dung '));
  assert.ok(name.endsWith('🌇'));
});

test('late events from another turn cannot end or overwrite a turn on the same thread',async()=>{
  const stale=JSON.stringify({...outcome,message:'Báo cáo cũ'});
  const session=fixture(undefined,({id,message,finish,emit})=>{
    message('old-before-start',stale);
    finish('old-before-start');
    setImmediate(()=>{
      emit('turn/started',{turn:{id:'late-turn'}});
      message('late-turn',stale);
      finish('late-turn');
      message(id,JSON.stringify(outcome));
      finish(id);
    });
  });
  assert.deepEqual(await session.run({threadId:session.threadId}),outcome);
});

test('member configuration explicitly pre-approves reading the board',async()=>{
  const session=fixture();
  await session.run();
  const config=session.calls[0].params.config['mcp_servers.hive_swarm_peer'];
  assert.equal(config.tools.read_board?.approval_mode,'approve');
});

test('when native resume retains or rejects the provider, the same member uses a warm fork',async()=>{
  const session=fixture(undefined,undefined,true);
  let saved;
  const remember=change=>{saved={...saved,...change};};
  await session.run({model:'primary'},remember);
  await session.run({threadId:saved.threadId,model:'xingchi/alternate'},remember);
  assert.equal(saved.threadId,'fork-1');
  await session.run({threadId:saved.threadId,model:'primary'},remember);
  assert.equal(saved.threadId,'fork-2');
  const forks=session.calls.filter(call=>call.method==='thread/fork').map(call=>call.params);
  assert.deepEqual(forks.map(params=>[params.threadId,params.modelProvider]),[
    [session.threadId,'desktop-xingchi'],['fork-1','fixture-default'],
  ]);
  assert.deepEqual(session.calls.filter(call=>call.method==='turn/start').map(call=>call.params.threadId),
    [session.threadId,'fork-1','fork-2']);
  assert.deepEqual(session.calls.filter(call=>['thread/name/set','thread/archive','thread/unsubscribe'].includes(call.method))
    .map(call=>[call.method,call.params.threadId]),[
    ['thread/name/set',session.threadId],['thread/archive',session.threadId],
    ['thread/name/set','fork-1'],['thread/archive',session.threadId],['thread/unsubscribe',session.threadId],
    ['thread/archive','fork-1'],['thread/name/set','fork-2'],['thread/archive','fork-1'],['thread/unsubscribe','fork-1'],
    ['thread/archive','fork-2'],
  ]);
  assert.deepEqual([...session.archived],[session.threadId,'fork-1','fork-2']);
});

test('a new helper forks the saved source with its own board and workspace scope',async()=>{
  const session=fixture();
  let saved;
  await session.run({name:'helper',forkFrom:'saved-source',workspace:{cwd:'D:/workspace/helper',base:'base'}},
    change=>{if (change.threadId) saved=change.threadId;});
  const scope=session.calls.find(call=>call.method==='thread/fork')?.params;
  assert.equal(scope?.threadId,'saved-source');
  assert.equal(scope?.cwd,'D:/workspace/helper');
  assert.equal(scope?.config['mcp_servers.hive_swarm_peer'].env.TEAM_BOARD_PEER_MEMBER,'helper');
  assert.equal(saved,'fork-1');
  assert.equal(session.calls.find(call=>call.method==='turn/start').params.threadId,saved);
  assert.deepEqual(session.calls.filter(call=>call.method==='thread/archive').map(call=>call.params.threadId),
    ['saved-source','fork-1']);
});

test('forking from a running teammate keeps the source open until its own turn ends',async()=>{
  const source=Promise.withResolvers();
  const session=fixture(undefined,({id,message,finish})=>{
    const complete=()=>{message(id,JSON.stringify(outcome));finish(id);};
    if (id==='turn-1') source.resolve(complete);
    else setImmediate(complete);
  });
  const work=session.run();
  const finish=await source.promise;
  try {
    await session.run({name:'helper',forkFrom:session.threadId});
    assert.equal(session.archived.has('fork-1'),true);
    assert.equal(session.archived.has(session.threadId),false);
    assert.ok(!session.calls.some(call=>call.method==='thread/unarchive'));
  } finally {
    finish();
    await work;
  }
  assert.equal(session.archived.has(session.threadId),true);
});

test('prose accepts the last schema-valid labeled or unlabeled code fence',async()=>{
  const earlier={...outcome,message:'Báo cáo cũ'};
  const invalid={...outcome,notify:[1]};
  const output=['Tóm tắt',fence+'json',JSON.stringify(earlier),fence,
    'Bản chính',fence,JSON.stringify(outcome),fence,
    'Ví dụ sai',fence+'json',JSON.stringify(invalid),fence,'Hết.'].join('\n');
  assert.deepEqual(await fixture(output).run(),outcome);
});

test('the first successful fork clears its pending source and explains inherited history only once',async()=>{
  const session=fixture();
  let saved;
  const remember=change=>{saved={...saved,...change};};
  await session.run({name:'helper',forkFrom:'saved-source'},remember);
  assert.equal(saved.forkFrom,null);
  const brief=session.calls.find(call=>call.method==='turn/start').params.input[0].text;
  assert.match(brief,/source history/);
  await session.run({name:'helper',threadId:saved.threadId, forkFrom:saved.forkFrom});
  const next=session.calls.filter(call=>call.method==='turn/start').at(-1).params.input[0].text;
  assert.doesNotMatch(next,/source history/);
});

test('app-server activity follows the accepted turn and omits shell commands and tool arguments',async()=>{
  const seen=[];
  const session=fixture(undefined,({id,emit,message,finish})=>{
    emit('item/agentMessage/delta',{turnId:'stale',delta:'Ignore stale'});
    emit('item/started',{turnId:id,item:{type:'commandExecution',command:'SUPPRESS_ME'}});
    emit('item/completed',{turnId:id,item:{type:'fileChange',changes:[{diff:'SUPPRESS_ME'}]}});
    emit('item/started',{turnId:id,item:{type:'mcpToolCall',tool:'read_board',arguments:{private:'SUPPRESS_ME'}}});
    emit('item/started',{turnId:id,item:{type:'agentMessage'}});
    emit('item/agentMessage/delta',{turnId:id,delta:'Bản nháp'});
    message(id,JSON.stringify(outcome));
    finish(id);
  });
  await session.run({},undefined,event=>seen.push(event));
  assert.deepEqual(seen.map(event=>event.kind),['shell','file','tool','draft','draft']);
  assert.equal(seen.at(-1).delta,'Bản nháp');
  assert.ok(seen.every(event=>!JSON.stringify(event).includes('SUPPRESS_ME')));
  assert.ok(seen.every(event=>Number.isFinite(Date.parse(event.time))));
});

test('archived transcripts read only summary turns and discard prompts, command details and raw structured reports',async()=>{
  const runner=new CodexRunner();
  const calls=[];
  const escaped='Kiểm tra xong.\nĐường dẫn \\ và dấu "kép".';
  runner.start=async()=>{};
  runner.rpc=async (method,params)=>{
    calls.push({method,params});
    return {data:[
      {id:'one',status:'completed',error:{message:'DO_NOT_SHOW'},items:[
        {type:'userMessage',content:[{type:'text',text:'You are member @worker in Team Board. DO_NOT_SHOW'}]},
        {type:'reasoning',content:['DO_NOT_SHOW']},
        {type:'hookPrompt',fragments:['DO_NOT_SHOW']},
        {type:'commandExecution',command:'echo DO_NOT_SHOW',cwd:'DO_NOT_SHOW',env:{DO_NOT_SHOW:'value'}},
        {type:'fileChange',changes:[{diff:'DO_NOT_SHOW'}]},
        {type:'mcpToolCall',tool:'read_board',arguments:{token:'DO_NOT_SHOW'}},
        {type:'dynamicToolCall',tool:'run DO_NOT_SHOW',arguments:{value:'DO_NOT_SHOW'}},
        {type:'agentMessage',text:'You are member @worker in Team Board. DO_NOT_SHOW'},
        {type:'agentMessage',text:['Kết quả:',fence+'json',JSON.stringify({...outcome,message:escaped}),fence].join('\n')},
      ]},
      {id:'two',status:'inProgress',items:[{type:'agentMessage',text:'{"state":"waiting","message":"Đang chờ'}]},
      {id:'three',status:'failed',items:[{type:'agentMessage',text:'{"state":"done","notify":["DO_NOT_SHOW"]}'}]},
      {id:'four',status:'completed',items:[{type:'agentMessage',text:'Đã gửi kết quả lên bảng.'}]},
    ]};
  };
  assert.deepEqual(await runner.readTranscript('saved-worker'),[
    {id:'one',status:'completed',steps:['Shell command','Edit file','read_board','Tool call'],report:escaped},
    {id:'two',status:'inProgress',steps:[],report:'Đang chờ'},
    {id:'three',status:'failed',steps:[],report:''},
    {id:'four',status:'completed',steps:[],report:'Đã gửi kết quả lên bảng.'},
  ]);
  assert.deepEqual(calls,[{method:'thread/turns/list',params:{threadId:'saved-worker',itemsView:'summary',sortDirection:'asc',limit:30}}]);
});

test('launch strips host MSIX and session variables from the app-server environment',async t=>{
  const restore=new Map([
    ['TEAM_BOARD_CODEX',process.env.TEAM_BOARD_CODEX],
    ['CODEX_WINDOWS_REGISTERED_CORE',process.env.CODEX_WINDOWS_REGISTERED_CORE],
    ['CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY',process.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY],
    ['CODEX_THREAD_ID',process.env.CODEX_THREAD_ID],
    ['CODEX_HOME',process.env.CODEX_HOME],
  ]);
  t.after(()=>{
    for (const [key,value] of restore) {
      if (value===undefined) delete process.env[key];
      else process.env[key]=value;
    }
  });
  process.env.TEAM_BOARD_CODEX='codex-fixture';
  process.env.CODEX_WINDOWS_REGISTERED_CORE='1';
  process.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY='OpenAI.Codex_fixture';
  process.env.CODEX_THREAD_ID='host-thread';
  process.env.CODEX_HOME='C:\\Users\\fixture\\.codex';

  const launched=[];
  const seenMethods=[];
  const runner=new CodexRunner({
    spawnProcess(command,args,options) {
      launched.push({command,args,options});
      const child=new EventEmitter();
      child.stdin=new PassThrough();
      child.stdout=new PassThrough();
      child.kill=()=>child.emit('exit');
      let buffer='';
      child.stdin.on('data',chunk=>{
        buffer+=chunk.toString();
        let newline;
        while ((newline=buffer.indexOf('\n'))>=0) {
          const msg=JSON.parse(buffer.slice(0,newline));
          buffer=buffer.slice(newline+1);
          seenMethods.push(msg.method);
          if (msg.id!==undefined) child.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{userAgent:'fixture'}})+'\n');
        }
      });
      return child;
    },
  });
  t.after(()=>runner.close());
  await runner.start();
  assert.equal(launched.length,1);
  const {command,args,options}=launched[0];
  assert.equal(command,'codex-fixture');
  assert.equal(options.env.CODEX_WINDOWS_REGISTERED_CORE,undefined);
  assert.equal(options.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY,undefined);
  assert.equal(options.env.CODEX_THREAD_ID,undefined);
  assert.equal(options.env.CODEX_HOME,'C:\\Users\\fixture\\.codex');
  assert.equal(args.includes('features.prefer_mxc=false'),process.platform==='win32');
  assert.ok(args.includes('plugins."hive-swarm@hive-swarm".enabled=false'));
  assert.ok(args.includes('plugins."team-board@local-team-board".enabled=false'));
  assert.deepEqual(seenMethods,['initialize','initialized']);
});

test('Windows npm codex.cmd shim resolves directly to @openai/codex bin/codex.js without cmd.exe',async t=>{
  const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');
  const {join}=await import('node:path');
  const {tmpdir}=await import('node:os');
  const {resolveCodexLaunch}=await import('./codex.mjs');
  const dir=mkdtempSync(join(tmpdir(),'hive-codex-cmd-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const shim=join(dir,'codex.cmd');
  const pkg=join(dir,'node_modules','@openai','codex');
  const entry=join(pkg,'bin','codex.js');
  mkdirSync(join(pkg,'bin'),{recursive:true});
  writeFileSync(shim,'@echo off\r\n');
  writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'@openai/codex',bin:{codex:'./bin/codex.js'}}));
  writeFileSync(entry,'// fixture codex entry\n');
  const launch=resolveCodexLaunch({env:{HIVE_SWARM_CODEX:shim},platform:'win32'});
  assert.equal(launch.command,process.execPath);
  assert.deepEqual(launch.prefixArgs,[entry]);
});

test('turn inactivity timeout resets on live activity and worker prompt enforces peer handoffs without double-posting',async()=>{
  const session=fixture(undefined,({id,emit,message,finish})=>{
    setTimeout(()=>emit('item/started',{turnId:id,item:{type:'commandExecution'}}),35);
    setTimeout(()=>emit('item/completed',{turnId:id,item:{type:'commandExecution'}}),70);
    setTimeout(()=>{message(id,JSON.stringify(outcome));finish(id);},105);
  });
  session.runner.turnIdleTimeoutMs=60;
  session.runner.turnMaxTimeoutMs=400;
  const result=await session.run();
  assert.deepEqual(result,outcome);
  const startCall=session.calls.find(call=>call.method==='turn/start');
  const promptText=startCall.params.input[0].text;
  assert.match(promptText,/wakeup doorbell|without @/i);
  assert.match(promptText,/do not.*duplicate|double-post/i);
});

test('fresh attached workers fork paginated parents with beforeTurnId and skip unarchive/archive churn without ever archiving parent',async()=>{
  const runner=new CodexRunner();
  const calls=[];
  const archived=new Set();
  let forks=0,nextTurn=0;
  runner.start=async()=>{};
  runner.rpc=async (method,params)=>{
    calls.push({method,params});
    if (method==='thread/read') return {thread:{id:params.threadId,historyMode:'paginated'}};
    if (method==='thread/turns/list') return {data:[{id:'parent-turn-1'}]};
    if (method==='config/read') return {config:{model_provider:'openai'}};
    if (method==='thread/name/set'||method==='thread/unsubscribe') return {};
    if (method==='thread/archive') { archived.add(params.threadId); return {}; }
    if (method==='thread/unarchive') throw Error('Unexpected unarchive on attached thread: '+params.threadId);
    if (method==='thread/fork') {
      const id='attached-'+(++forks);
      return {thread:{id,attachedToThreadId:params.threadId,forkedFromId:params.threadId},model:params.model,modelProvider:params.modelProvider};
    }
    if (method==='thread/resume') {
      return {thread:{id:params.threadId,attachedToThreadId:'parent-thread-1'},model:params.model,modelProvider:params.modelProvider};
    }
    assert.equal(method,'turn/start');
    const id='turn-'+(++nextTurn);
    setImmediate(()=>{
      runner.receive(JSON.stringify({method:'item/completed',params:{threadId:params.threadId,turnId:id,item:{type:'agentMessage',text:JSON.stringify(outcome)}}}));
      runner.receive(JSON.stringify({method:'turn/completed',params:{threadId:params.threadId,turn:{id,status:'completed'}}}));
    });
    return {turn:{id}};
  };

  const team={id:'team',title:'Attached Team',cwd:process.cwd(),task:'Run attached',parentSessionId:'parent-thread-1',members:[]};
  let saved={};
  const remember=change=>{saved={...saved,...change};};
  await runner.run({team,member:{name:'builder',brief:'Build',model:'gpt-5.4',inbox:[],lastTurn:1},remember});
  assert.equal(saved.threadId,'attached-1');
  assert.equal(saved.executionMode,'attached');
  assert.equal(archived.size,0);
  const forkCall=calls.find(c=>c.method==='thread/fork');
  assert.equal(forkCall.params.threadId,'parent-thread-1');
  assert.equal(forkCall.params.attachToSource,true);
  assert.equal(forkCall.params.beforeTurnId,'parent-turn-1');
  assert.equal(forkCall.params.ephemeral,false);
  const firstPrompt=calls.find(c=>c.method==='turn/start').params.input[0].text;
  assert.doesNotMatch(firstPrompt,/source history/);

  // Turn 2 on same loaded attached thread goes straight to turn/start with zero archive/resume churn.
  const beforeTurn2=calls.length;
  await runner.run({team,member:{name:'builder',brief:'Build',model:'gpt-5.4',threadId:saved.threadId,executionMode:saved.executionMode,inbox:[],lastTurn:2},remember});
  assert.deepEqual(calls.slice(beforeTurn2).map(c=>c.method),['turn/start']);

  // Turn 3 after app-server unloads the thread resumes cleanly without unarchive/archive.
  runner.receive(JSON.stringify({method:'thread/status/changed',params:{threadId:'attached-1',status:{type:'notLoaded'}}}));
  const beforeTurn3=calls.length;
  await runner.run({team,member:{name:'builder',brief:'Build',model:'gpt-5.4',threadId:saved.threadId,executionMode:saved.executionMode,inbox:[],lastTurn:3},remember});
  assert.deepEqual(calls.slice(beforeTurn3).map(c=>c.method),['config/read','thread/resume','turn/start']);
  assert.equal(archived.size,0);
});

test('fork: coordinator omits beforeTurnId, explains source history once, clears forkSource, and never archives parent',async()=>{
  const runner=new CodexRunner();
  const calls=[];
  const archived=new Set();
  let forks=0,nextTurn=0;
  let parentMode='paginated';
  runner.start=async()=>{};
  runner.rpc=async (method,params)=>{
    calls.push({method,params});
    if (method==='thread/read') return {thread:{id:params.threadId,historyMode:parentMode}};
    if (method==='config/read') return {config:{model_provider:'openai'}};
    if (method==='thread/name/set'||method==='thread/unsubscribe') return {};
    if (method==='thread/archive') { archived.add(params.threadId); return {}; }
    if (method==='thread/unarchive') throw Error('Parent must never be unarchived: '+params.threadId);
    if (method==='thread/fork') {
      const id='coord-fork-'+(++forks);
      return {thread:{id,...(params.attachToSource?{attachedToThreadId:params.threadId}:{})},model:params.model,modelProvider:params.modelProvider};
    }
    assert.equal(method,'turn/start');
    const id='turn-'+(++nextTurn);
    setImmediate(()=>{
      runner.receive(JSON.stringify({method:'item/completed',params:{threadId:params.threadId,turnId:id,item:{type:'agentMessage',text:JSON.stringify(outcome)}}}));
      runner.receive(JSON.stringify({method:'turn/completed',params:{threadId:params.threadId,turn:{id,status:'completed'}}}));
    });
    return {turn:{id}};
  };

  const team={id:'team',title:'Warm Fork',cwd:process.cwd(),task:'Inherit context',parentSessionId:'parent-chat-7',members:[]};
  let saved={};
  await runner.run({team,member:{name:'researcher',brief:'Continue',forkSource:'coordinator',inbox:[],lastTurn:1},remember:c=>{saved={...saved,...c};}});
  assert.equal(saved.threadId,'coord-fork-1');
  assert.equal(saved.executionMode,'attached');
  assert.equal(saved.forkSource,null);
  const firstFork=calls.find(c=>c.method==='thread/fork');
  assert.equal(firstFork.params.threadId,'parent-chat-7');
  assert.equal(firstFork.params.attachToSource,true);
  assert.equal(Object.hasOwn(firstFork.params,'beforeTurnId'),false);
  assert.match(calls.find(c=>c.method==='turn/start').params.input[0].text,/source history/);
  assert.equal(archived.size,0);

  // Legacy (non-paginated) parent falls back to unattached fork: child archives, parent NEVER archives.
  parentMode='legacy';
  let legacySaved={};
  await runner.run({team,member:{name:'legacy-warm',brief:'Continue',forkSource:'coordinator',inbox:[],lastTurn:2},remember:c=>{legacySaved={...legacySaved,...c};}});
  assert.equal(legacySaved.executionMode,'session');
  assert.equal(legacySaved.forkSource,null);
  const secondFork=calls.filter(c=>c.method==='thread/fork')[1];
  assert.equal(Object.hasOwn(secondFork.params,'attachToSource'),false);
  assert.deepEqual([...archived],['coord-fork-2']);
});

test('explicit model passes allowProviderModelFallback: false and older Codex rejections degrade cleanly to 1.9.1 thread/start + archive',async()=>{
  const runner=new CodexRunner();
  const calls=[];
  const archived=new Set();
  let starts=0,nextTurn=0;
  runner.start=async()=>{};
  runner.rpc=async (method,params)=>{
    calls.push({method,params});
    if (method==='thread/read') return {thread:{id:params.threadId,historyMode:'paginated'}};
    if (method==='thread/turns/list') return {data:[{id:'t1'}]};
    if (method==='config/read') return {config:{model_provider:'openai'}};
    if (method==='thread/fork') throw Error('unknown field `attachToSource`');
    if (method==='thread/start') {
      if (params.allowProviderModelFallback===false) throw Error('unknown field `allowProviderModelFallback`');
      return {thread:{id:'legacy-'+(++starts)},model:params.model,modelProvider:'openai'};
    }
    if (method==='thread/name/set') return {};
    if (method==='thread/archive') { archived.add(params.threadId); return {}; }
    assert.equal(method,'turn/start');
    const id='turn-'+(++nextTurn);
    setImmediate(()=>{
      runner.receive(JSON.stringify({method:'item/completed',params:{threadId:params.threadId,turnId:id,item:{type:'agentMessage',text:JSON.stringify(outcome)}}}));
      runner.receive(JSON.stringify({method:'turn/completed',params:{threadId:params.threadId,turn:{id,status:'completed'}}}));
    });
    return {turn:{id}};
  };

  const team={id:'team',title:'Fallback',cwd:process.cwd(),task:'Fallback',parentSessionId:'parent-1',members:[]};
  let saved={};
  await runner.run({team,member:{name:'builder',brief:'Build',model:'gpt-5.4',inbox:[],lastTurn:1},remember:c=>{saved={...saved,...c};}});
  assert.equal(saved.threadId,'legacy-1');
  assert.equal(saved.executionMode,'session');
  assert.equal(archived.has('legacy-1'),true);
  assert.equal(archived.has('parent-1'),false);
  const startCalls=calls.filter(c=>c.method==='thread/start');
  assert.equal(startCalls.length,2);
  assert.equal(startCalls[0].params.allowProviderModelFallback,false);
  assert.equal(Object.hasOwn(startCalls[1].params,'allowProviderModelFallback'),false);
  assert.equal(runner.supportsAttachToSource,false);
  assert.equal(runner.supportsModelFallbackFlag,false);

  // Subsequent worker skips unsupported flags immediately.
  const beforeSecond=calls.length;
  await runner.run({team,member:{name:'reviewer',brief:'Check',model:'gpt-5.4',inbox:[],lastTurn:2},remember:()=>{}});
  assert.deepEqual(calls.slice(beforeSecond).map(c=>c.method),['thread/start','thread/name/set','turn/start','thread/archive']);
  assert.equal(Object.hasOwn(calls[beforeSecond].params,'allowProviderModelFallback'),false);
});

test('ephemeral runner never sends attachToSource, and attached teammate forks skip archiving the attached source',async()=>{
  const ephemeral=new CodexRunner({ephemeral:true});
  const ephCalls=[];
  ephemeral.start=async()=>{};
  ephemeral.rpc=async (method,params)=>{
    ephCalls.push({method,params});
    if (method==='config/read') return {config:{model_provider:'openai'}};
    if (method==='thread/start') return {thread:{id:'eph-1'},model:params.model,modelProvider:'openai'};
    if (method==='thread/fork') return {thread:{id:'eph-fork-1'},model:params.model,modelProvider:'openai'};
    if (method==='thread/name/set') return {};
    assert.equal(method,'turn/start');
    setImmediate(()=>{
      ephemeral.receive(JSON.stringify({method:'item/completed',params:{threadId:params.threadId,turnId:'t1',item:{type:'agentMessage',text:JSON.stringify(outcome)}}}));
      ephemeral.receive(JSON.stringify({method:'turn/completed',params:{threadId:params.threadId,turn:{id:'t1',status:'completed'}}}));
    });
    return {turn:{id:'t1'}};
  };
  const team={id:'team',title:'Ephemeral',cwd:process.cwd(),task:'Run',parentSessionId:'parent-1',members:[]};
  await ephemeral.run({team,member:{name:'fresh',brief:'Fresh',model:'gpt-5.4',inbox:[],lastTurn:1},remember:()=>{}});
  await ephemeral.run({team,member:{name:'warm',brief:'Warm',forkSource:'coordinator',inbox:[],lastTurn:2},remember:()=>{}});
  assert.ok(ephCalls.every(c=>c.params?.attachToSource!==true));
  assert.equal(ephCalls.find(c=>c.method==='thread/start').params.allowProviderModelFallback,false);

  // Teammate fork from an attached worker skips unarchive/archive on source and stays attached.
  const attached=new CodexRunner();
  const attCalls=[];
  attached.start=async()=>{};
  attached.rpc=async (method,params)=>{
    attCalls.push({method,params});
    if (method==='config/read') return {config:{model_provider:'openai'}};
    if (method==='thread/name/set') return {};
    if (method==='thread/archive'||method==='thread/unarchive') throw Error('Should not archive/unarchive attached thread');
    if (method==='thread/fork') return {thread:{id:'attached-child',attachedToThreadId:params.threadId},model:params.model,modelProvider:params.modelProvider};
    assert.equal(method,'turn/start');
    setImmediate(()=>{
      attached.receive(JSON.stringify({method:'item/completed',params:{threadId:params.threadId,turnId:'t2',item:{type:'agentMessage',text:JSON.stringify(outcome)}}}));
      attached.receive(JSON.stringify({method:'turn/completed',params:{threadId:params.threadId,turn:{id:'t2',status:'completed'}}}));
    });
    return {turn:{id:'t2'}};
  };
  const attTeam={id:'team',title:'Nested',cwd:process.cwd(),task:'Run',members:[{name:'builder',threadId:'attached-builder',executionMode:'attached'}]};
  let saved={};
  await attached.run({team:attTeam,member:{name:'helper',brief:'Help',forkFrom:'attached-builder',inbox:[],lastTurn:1},remember:c=>{saved={...saved,...c};}});
  assert.equal(saved.threadId,'attached-child');
  assert.equal(saved.executionMode,'attached');
  assert.equal(saved.forkFrom,null);
  assert.equal(attCalls.find(c=>c.method==='thread/fork').params.attachToSource,true);
});

test('generic invalid params errors from thread/start do not latch supportsModelFallbackFlag to false',async()=>{
  const runner=new CodexRunner();
  const startCalls=[];
  runner.start=async()=>{};
  runner.rpc=async (method,params)=>{
    if (method==='thread/start') {
      startCalls.push(params);
      throw Error('invalid params: cwd does not exist');
    }
    throw Error('Unexpected method '+method);
  };
  await assert.rejects(
    runner.run({team:{id:'team',title:'Err',cwd:process.cwd(),task:'Err',members:[]},member:{name:'builder',brief:'Build',model:'gpt-5.4',inbox:[],lastTurn:1},remember:()=>{}}),
    /invalid params: cwd does not exist/,
  );
  assert.equal(startCalls.length,1);
  assert.equal(startCalls[0].allowProviderModelFallback,false);
  assert.equal(runner.supportsModelFallbackFlag,true);
});
