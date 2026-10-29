import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

test('vault CLI falls back only when PowerShell did not spawn',async()=>{
  const calls:string[]=[];
  let failure='ENOENT';
  const original=childProcess.execFile;
  childProcess.execFile=((file:string,_args:unknown,_options:unknown,callback:Function)=>{
    calls.push(file);
    const error=Object.assign(new Error('spawn '+file+' '+failure),{code:failure,stderr:''});
    queueMicrotask(()=>callback(file==='pwsh.exe'||failure!=='ENOENT'?error:null,'ok',''));
  }) as typeof childProcess.execFile;
  syncBuiltinESMExports();
  try{
    const {obsidianCli}=await import('../scripts/vault-cli.ts');
    await obsidianCli('knowbase',['help']);
    assert.deepEqual(calls,['pwsh.exe','/mnt/c/Users/cresc/AppData/Local/Microsoft/WindowsApps/pwsh.exe']);
    for(const code of ['EACCES','ETIMEDOUT','1']){
      calls.length=0;failure=code;
      await assert.rejects(obsidianCli('knowbase',['help']),error=>{
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(code));
        assert.ok(error.message.includes('spawn pwsh.exe'));
        assert.equal((error.cause as NodeJS.ErrnoException).code,code);
        return true;
      });
      assert.deepEqual(calls,['pwsh.exe']);
    }
  }finally{childProcess.execFile=original;syncBuiltinESMExports();}
});
