import assert from 'node:assert/strict';import{spawnSync}from'node:child_process';
import{createHash}from'node:crypto';import{createRequire}from'node:module';
import{closeSync,lstatSync,mkdirSync,mkdtempSync,openSync,readFileSync,rmSync,writeFileSync}from'node:fs';
import{dirname,join,relative,resolve,sep}from'node:path';import{fileURLToPath}from'node:url';import{runInNewContext}from'node:vm';
import{archiveFiles,npmCli,prepareOutputDirectory}from'./pack-core.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const expected=['LICENSE','README.md','package.json','host.mjs','native.mjs','runner.mjs','routes.mjs','client/dist.js','cordis.patch.yml','skills/hive-swarm/SKILL.md'].sort();
export async function packDsh({packageDirectory=join(root,'packages/dsh-hive-swarm'),outputDirectory=join(root,'.tmp/npm-dsh')}={}) {
  packageDirectory=resolve(packageDirectory);outputDirectory=resolve(outputDirectory);
  const manifest=JSON.parse(readFileSync(join(packageDirectory,'package.json'),'utf8'));
  const core=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  assert.equal(manifest.name,'dsh-hive-swarm');assert.equal(manifest.version,core.version);
  assert.equal(manifest.dependencies['hive-swarm'],core.version);assert.equal(manifest.dsh.engines.dsh,'0.2.2-rc.5');
  assert.equal(manifest.exports['.'],'./host.mjs');assert.equal(manifest.exports['./client'],'./client/dist.js');
  assert.equal(manifest.dsh.bundle.patch,'./cordis.patch.yml');
  for(const key of ['preinstall','install','postinstall','prepare'])assert.equal(manifest.scripts?.[key],undefined);
  const allowed=[...new Set([...manifest.files,'LICENSE','README.md','package.json'])].sort();assert.deepEqual(allowed,expected);
  prepareOutputDirectory(outputDirectory);const stage=mkdtempSync(join(outputDirectory,'.pack-dsh-'));const identity=lstatSync(stage);
  try {
    const source=join(stage,'source');mkdirSync(source,{mode:0o700});
    for(const file of expected){let current=packageDirectory;for(const part of file.split('/')){current=join(current,part);assert.ok(!lstatSync(current).isSymbolicLink(),'Linked native package source');}
      assert.ok(lstatSync(current).isFile());const target=join(source,file);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(current),{flag:'wx'});}
    const loader=readFileSync(join(source,'client/dist.js'),'utf8');assert.ok(Buffer.byteLength(loader)<250000);let loaded;
    const react=createRequire(join(root,'package.json'))('react');
    runInNewContext(loader,{window:{__ModuleLoader__:{load:({id,factory})=>{assert.equal(id,'dsh-hive-swarm');assert.equal(loaded,undefined);
      loaded=factory(name=>{assert.equal(name,'react');return react});}}},AbortController,DOMException,URL,crypto:globalThis.crypto,setTimeout,clearTimeout,queueMicrotask,console},{timeout:2000});
    assert.equal(loaded.name,'dsh-hive-swarm');assert.equal(typeof loaded.apply,'function');
    let out,err,result;
    try{out=openSync(join(stage,'npm.stdout'),'wx',0o600);err=openSync(join(stage,'npm.stderr'),'wx',0o600);
      result=spawnSync(process.execPath,[npmCli(),'pack','--offline','--ignore-scripts','--json','--pack-destination',stage,
        '--userconfig',join(stage,'empty-user.npmrc'),'--globalconfig',join(stage,'empty-global.npmrc')],
        {cwd:source,windowsHide:true,stdio:['ignore',out,err],timeout:30000,env:{...process.env,npm_config_cache:join(stage,'.npm-cache'),npm_config_update_notifier:'false'}});
    }finally{if(out!==undefined)closeSync(out);if(err!==undefined)closeSync(err)}
    if(result.error)throw result.error;assert.equal(result.status,0,readFileSync(join(stage,'npm.stderr'),'utf8'));
    const [metadata]=JSON.parse(readFileSync(join(stage,'npm.stdout'),'utf8'));assert.equal(metadata.filename,'dsh-hive-swarm-'+manifest.version+'.tgz');
    const tarball=join(stage,metadata.filename),bytes=readFileSync(tarball);assert.ok(bytes.length<150000);
    const integrity='sha512-'+createHash('sha512').update(bytes).digest('base64');assert.equal(integrity,metadata.integrity);
    const files=archiveFiles(bytes);assert.deepEqual([...files.keys()].sort(),expected);
    for(const [file,contents]of files)assert.deepEqual(contents,readFileSync(join(source,file)),'Native archive/source mismatch: '+file);
    return {tarball,size:bytes.length,integrity,files:[...files.keys()].sort(),loaderBytes:Buffer.byteLength(loader)};
  }catch(error){const current=lstatSync(stage),name=relative(outputDirectory,stage);
    if(name.startsWith('.pack-dsh-')&&!name.includes(sep)&&!current.isSymbolicLink()&&current.dev===identity.dev&&current.ino===identity.ino)rmSync(stage,{recursive:true,force:true});throw error;}
}
if(import.meta.main)console.log(JSON.stringify(await packDsh({outputDirectory:process.argv[2]}),null,2));
