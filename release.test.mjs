import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
const read=name=>JSON.parse(readFileSync(new URL(name,import.meta.url),'utf8'));

test('core and native artifacts share the candidate version and published runtime export files',async()=>{
  const core=read('package.json'),plugin=read('.codex-plugin/plugin.json'),native=read('packages/dsh-hive-swarm/package.json');
  assert.equal(plugin.name,core.name);assert.equal(plugin.version,core.version);
  assert.equal(native.version,core.version);assert.equal(native.dependencies['hive-swarm'],core.version);
  assert.equal(core.engines.node,'^22.19.0 || >=24.2.0');
  assert.equal(native.dsh.engines.dsh,'0.2.2-rc.5');
  for(const [key,file] of [['./core','core.mjs'],['./run-store','run-store.mjs']]) {
    assert.equal(core.exports[key],'./'+file);assert.ok(core.files.includes(file));
    assert.ok(existsSync(new URL(file,import.meta.url)));
    assert.ok(await import('hive-swarm/'+key.slice(2)));
  }
  for(const hook of ['preinstall','install','postinstall','prepare'])assert.equal(core.scripts[hook],undefined);
  assert.deepEqual(core.dependencies??{},{});
  const boardJs=readFileSync(new URL('board.js',import.meta.url),'utf8');
  assert.doesNotMatch(boardJs,/version:'1\.7\.4'/,'board.js must not hardcode a stale client version');
});
