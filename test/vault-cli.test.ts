import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

test('vault CLI uses the configured PowerShell 7 and never replays failed commands',async()=>{
  const calls:string[]=[];
  let failure='ENOENT';
  const original=childProcess.execFile;
  const saved=process.env.VIEWER_PWSH;
  childProcess.execFile=((file:string,_args:unknown,_options:unknown,callback:Function)=>{
    calls.push(file);
    const error=Object.assign(new Error('spawn '+file+' '+failure),{code:failure,stderr:''});
    queueMicrotask(()=>callback(failure?error:null,'ok',''));
  }) as typeof childProcess.execFile;
  syncBuiltinESMExports();
  try{
    const {obsidianCli}=await import('../scripts/vault-cli.ts');
    delete process.env.VIEWER_PWSH;
    failure='';await obsidianCli('test-vault',['help']);
    assert.deepEqual(calls,['pwsh.exe']);
    calls.length=0;process.env.VIEWER_PWSH='/mnt/c/Program Files/PowerShell/7/pwsh.exe';
    await obsidianCli('test-vault',['help']);assert.deepEqual(calls,[process.env.VIEWER_PWSH]);
    delete process.env.VIEWER_PWSH;
    for(const code of ['ENOENT','EACCES','ETIMEDOUT','1']){
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
  }finally{
    if(saved===undefined)delete process.env.VIEWER_PWSH;else process.env.VIEWER_PWSH=saved;
    childProcess.execFile=original;syncBuiltinESMExports();
  }
});
