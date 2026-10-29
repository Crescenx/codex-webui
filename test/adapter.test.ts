import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {AppServer} from '../server/adapter.ts';

test('Viewer opts out of oversized raw snapshots while ordinary RPCs keep working',async()=>{
  const adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  let offline=false;adapter.on('offline',()=>{offline=true;});
  try{
    assert.equal((await adapter.call('mock/nativeSnapshot')).ready,true);
    assert.equal(((await adapter.call('model/list')).data as unknown[]).length,2);
    assert.equal(offline,false);
  }finally{adapter.stop();}
});
