import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {TeamBoard} from './engine.mjs';

const input=()=>({cwd:process.cwd(),task:'Host boundary fixture',members:[{name:'builder',brief:'Inspect the controlled fixture.'}]});
const waitUntil=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await delay(5);}throw Error('Fixture did not reach expected state');};

test('teams inherit an explicit host from their application, and callers cannot switch it',()=>{
  const board=new TeamBoard(':memory:',()=>new Promise(()=>{}),{host:'deepseek-harness',recovery:'preserve'});
  try{
    const team=board.create(input());
    assert.equal(team.host,'deepseek-harness');
    assert.equal(board.get(team.id).host,'deepseek-harness');
    assert.throws(()=>board.create({...input(),host:'codex'}),/host/i);
  }finally{board.close();}
});

test('DSH restart preserves the pending run/outcome and cannot re-prompt after mention or resume',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hive-host-'));const file=join(dir,'teams.sqlite');
  let board=new TeamBoard(file,()=>new Promise(()=>{}),{host:'deepseek-harness',recovery:'preserve'});
  try{
    const team=board.create(input());
    await waitUntil(()=>board.get(team.id).members[0].status==='working');
    let current=board.get(team.id);current.members[0].pendingRun={requestId:'fixture-request-1',turn:1};board.save(current);
    board.declareOutcome(team.id,'builder',{turn:1,state:'done',message:'Verified fixture result.',notify:[],waitFor:[]});
    board.close();
    let prompts=0;
    board=new TeamBoard(file,()=>{prompts++;return new Promise(()=>{});},{host:'deepseek-harness',recovery:'preserve'});
    current=board.get(team.id);
    assert.equal(current.paused,true);
    assert.equal(current.members[0].recoveryRequired,true);
    assert.equal(current.members[0].pendingRun.requestId,'fixture-request-1');
    assert.equal(current.members[0].declaredOutcome.message,'Verified fixture result.');
    board.post(team.id,'@builder Is the prior run finished?');board.resume(team.id);
    await delay(15);
    assert.equal(prompts,0);
  }finally{board.close();rmSync(dir,{recursive:true,force:true});}
});

test('a host cannot open the other host storage and reinterpret its sessions',()=>{
  const dir=mkdtempSync(join(tmpdir(),'hive-host-'));const file=join(dir,'teams.sqlite');
  const codex=new TeamBoard(file,()=>new Promise(()=>{}));codex.create(input());codex.close();
  let foreign;
  try{assert.throws(()=>{foreign=new TeamBoard(file,()=>{}, {host:'deepseek-harness',recovery:'preserve'});},/host|Codex/i);}
  finally{foreign?.close();rmSync(dir,{recursive:true,force:true});}
});
