import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync}from'node:fs';
import{join,dirname}from'node:path';import{tmpdir}from'node:os';import{pathToFileURL}from'node:url';
import{packCore,archiveFiles}from'./scripts/pack-core.mjs';

test('the real native artifact loads against the paired core from a clean consumer without monorepo files',async t=>{
  const {packDsh}=await import('./scripts/pack-dsh.mjs');
  const root=mkdtempSync(join(tmpdir(),'hive packages có dấu '));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const core=await packCore({outputDirectory:join(root,'core')}),native=await packDsh({outputDirectory:join(root,'native')});
  const expected=['LICENSE','README.md','package.json','host.mjs','native.mjs','runner.mjs','routes.mjs','client/dist.js','cordis.patch.yml','skills/hive-swarm/SKILL.md'].sort();
  assert.deepEqual(native.files,expected);const consumer=join(root,'clean consumer');
  for(const [name,result] of [['hive-swarm',core],['dsh-hive-swarm',native]]) {
    for(const [file,bytes]of archiveFiles(readFileSync(result.tarball))) {const path=join(consumer,'node_modules',name,file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);}
  }
  const {createHost,apply}=await import(pathToFileURL(join(consumer,'node_modules/dsh-hive-swarm/host.mjs')));
  const routes=new Map();let launched=0;
  const host=await createHost({connection:{fetch:{register:route=>{routes.set(route.path,route);return async()=>routes.delete(route.path)}}},
    workspaceRegistry:{list:()=>[{path:consumer}]},tools:{register:()=>()=>{}},skills:{register:()=>()=>{}}},
    {dataDirectory:join(root,'state'),nativeFactory:()=>({create:async()=>{launched++;throw Error('Models must not start')},listModels:async()=>[],dispose:async()=>{}})});
  try{const response=await routes.get('/api/hive-swarm/v1/snapshot').fetch(new Request('http://fixture/api/hive-swarm/v1/snapshot'));
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{teams:[],team:null});assert.equal(launched,0);
  }finally{await host.close()}
  const effects=[];const context={connection:{fetch:{register:()=>async()=>{}},createPeer:()=>({dispose:async()=>{}})},
    typertGateway:{invoke:async()=>{throw Error('Activation must not call a model')}},profileContext:{dir:join(root,'profile')},
    workspaceRegistry:{list:()=>[]},tools:{register:()=>()=>{}},skills:{register:()=>()=>{}},effect:callback=>effects.push(callback())};
  try{assert.equal(await apply(context),undefined,'Cordis apply returns void, never a service object');}
  finally{for(const release of effects.reverse())await release()}
});
