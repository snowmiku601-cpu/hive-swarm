import {copyFileSync,lstatSync,mkdirSync,readdirSync,rmdirSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';

// Older supported Windows Node builds mishandle fs.rmSync on Unicode paths.
// Keep test teardown on the long-established unlink/rmdir calls so setup
// mutations actually happen before asserting the product's behavior.
export function removeFixture(path,{recursive=false,force=false}={}) {
  let info;
  try {info=lstatSync(path);} catch(error) {if(force&&error.code==='ENOENT')return;throw error;}
  if(info.isDirectory()&&!info.isSymbolicLink()) {
    if(recursive)for(const name of readdirSync(path))removeFixture(join(path,name),{recursive,force});
    rmdirSync(path);
  }else unlinkSync(path);
}

export function copyFixture(source,target,{recursive=false}={}) {
  const info=lstatSync(source);
  if(info.isSymbolicLink())throw Error('Test fixture copies must use regular files.');
  if(info.isDirectory()) {
    if(!recursive)throw Error('A fixture directory requires recursive copying.');
    mkdirSync(target,{recursive:true});
    for(const name of readdirSync(source))copyFixture(join(source,name),join(target,name),{recursive});
  }else copyFileSync(source,target);
}
