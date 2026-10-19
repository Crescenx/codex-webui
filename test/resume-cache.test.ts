import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {AppServer} from '../server/adapter.ts';
import {serve} from '../server/main.ts';

for(const runtime of ['codex','antigravity'])test(`${runtime}: historical cache requires resume, retries failed resume, and deduplicates concurrent opens`,async()=>{
  const dir=await mkdtemp('/tmp/viewer-resume-cache-');
  const adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const google=runtime==='antigravity'?new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]}):undefined;
  const native=google||adapter;
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter,antigravity:google});
  try {
    const login=await fetch(app.launchUrl,{redirect:'manual'}),cookie=login.headers.get('set-cookie')!.split(';')[0];
    const post=(route:string)=>fetch(app.origin+'/api'+route,{method:'POST',headers:{cookie,origin:app.origin,'content-type':'application/json'},body:'{}'});
    const {thread}=await native.call('thread/start',{cwd:dir,approvalsReviewer:'user'});
    const id=(google?'agy:':'')+(thread as {id:string}).id;
    let resumes=0,fail=true;
    const call=native.call.bind(native);
    native.call=async(method,params)=>{
      if(method==='thread/resume' && !params?.excludeTurns) {resumes++;if(fail)throw Error('resume unavailable');}
      return call(method,params);
    };
    const history=()=>fetch(app.origin+`/api/threads/${id}?refresh=1`,{headers:{cookie}});
    assert.equal((await history()).status,200);
    assert.equal(resumes,0,'reading history must not resume execution');
    assert.equal((await post(`/threads/${id}/open`)).status,502,'cached history cannot skip resume');
    assert.equal(resumes,1);
    fail=false;
    assert.equal((await history()).status,200);
    const opened=await Promise.all([post(`/threads/${id}/open`),post(`/threads/${id}/open`)]);
    assert.deepEqual(opened.map(r=>r.status),[200,200]);
    assert.equal(resumes,2,'concurrent opens share one successful resume');
    assert.equal((await post(`/threads/${id}/open`)).status,200);
    assert.equal(resumes,2,'an already resumed thread does not reconnect');
  } finally {await app.stop();await rm(dir,{recursive:true,force:true});}
});
