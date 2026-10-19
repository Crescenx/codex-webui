import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { permissionMode, permissionPolicy, readPermissionMode, savePermissionMode } from '../server/permissions.ts';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';
import type { Obj } from '../shared/protocol.ts';

test('permission modes persist per thread, reset explicitly, and reject malformed data', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-permissions-'));
  try {
    assert.equal(await readPermissionMode(dir,'a'),null);
    for(const mode of ['auto','manual','bypass',null] as const) {
      await savePermissionMode(dir,'a',mode);assert.equal(await readPermissionMode(dir,'a'),mode);
      assert.equal(await readPermissionMode(dir,'b'),null);
    }
    for(const value of [undefined,'never',{},true])assert.throws(()=>permissionMode(value));
    await writeFile(path.join(dir,'thread-permissions/a.json'),'{"mode":"invalid"}');
    await assert.rejects(readPermissionMode(dir,'a'));
    assert.deepEqual(permissionPolicy('bypass',dir),{approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}});
    for(const mode of ['auto','manual',null] as const) {
      const p=permissionPolicy(mode,dir);assert.equal(p.approvalPolicy,'on-request');
      assert.equal(p.sandboxPolicy.type,'workspaceWrite');assert.equal(p.sandboxPolicy.networkAccess,false);
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('permissions API authenticates, rejects active changes, and sends each saved mode on subsequent turns', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-permissions-api-'));
  const adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const calls:{method:string;params:Obj}[]=[];const call=adapter.call.bind(adapter);
  adapter.call=async(method,params={})=>{calls.push({method,params});return call(method,params);};
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
  try {
    const cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
    const request=(route:string,method='GET',data?:unknown)=>fetch(app.origin+'/api'+route,{method,headers:{cookie,origin:app.origin,'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
    const {thread}=await (await request('/threads','POST',{cwd:dir})).json();
    const route=`/threads/${thread.id}/permissions`;
    assert.equal((await fetch(app.origin+'/api'+route)).status,401);
    assert.equal((await fetch(app.origin+'/api'+route,{method:'PUT',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({mode:'bypass'})})).status,403);
    assert.equal((await request(route,'PUT',{mode:'invalid'})).status,400);
    for(const mode of ['bypass','manual','auto',null] as const) {
      const changed=await request(route,'PUT',{mode});assert.equal(changed.status,200,await changed.clone().text());
      assert.equal((await changed.json()).effectiveOn,'nextTurn');
      assert.equal((await (await request(route)).json()).mode,mode);
      assert.equal(await readPermissionMode(dir+'/data',thread.id),mode);
      assert.equal((await request(`/threads/${thread.id}/turns`,'POST',{text:'long-stream',attachments:[]})).status,200);
      const sent=calls.findLast(c=>c.method==='turn/start')!.params;
      assert.equal(sent.approvalPolicy,mode==='bypass'?'never':'on-request');
      assert.equal((sent.sandboxPolicy as Obj).type,mode==='bypass'?'dangerFullAccess':'workspaceWrite');
      assert.equal(sent.approvalsReviewer,mode==='bypass'||mode==='manual'?'user':'auto_review');
      assert.equal((await request(route,'PUT',{mode:'manual'})).status,409);
      assert.equal((await request(`/threads/${thread.id}/interrupt`,'POST',{})).status,200);
    }
    await adapter.call('mock/goal',{threadId:thread.id,objective:'test active goal',status:'active'});
    assert.equal((await request(route,'PUT',{mode:'bypass'})).status,409);
  } finally {await app.stop();await rm(dir,{recursive:true,force:true});}
});
