import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';
import { reduceNotice, windowsRisk } from '../server/protocol.ts';
import type { Thread } from '../server/protocol.ts';

test('late turn/start cannot undo completion; Windows access is flagged', () => {
  const t: Thread = { id:'t',cwd:'/tmp',turns:[{id:'a',status:'completed',items:[]}],status:{type:'idle'} };
  reduceNotice(t,{method:'turn/started',params:{threadId:'t',turn:{id:'a',status:'inProgress',items:[]}}});
  assert.equal(t.status?.type,'idle'); assert.ok(windowsRisk({command:'powershell.exe Get-Date'})); assert.ok(!windowsRisk({command:'pwd'}));
});
test('authenticated HTTP, root boundaries, uploads, turns and single-use approval', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'viewer-test-'));
  const root = path.join(dir,'root'); await mkdir(root); await symlink(os.tmpdir(),path.join(root,'escape'));
  const app = await serve({ roots:[root],dataDir:path.join(dir,'data'),runtimeDir:path.join(dir,'run'),port:0,
    adapter:new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]}) });
  try {
    assert.equal((await fetch(app.origin+'/api/threads')).status,401);
    const login = await fetch(app.launchUrl,{redirect:'manual'}); const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const request = (p:string, data?:unknown, origin=app.origin) => fetch(app.origin+'/api'+p,{method:data === undefined?'GET':'POST',headers:{cookie,origin,'Content-Type':'application/json'},body:data === undefined?undefined:JSON.stringify(data)});
    assert.equal((await request('/threads',{},'https://evil.example')).status,403);
    assert.equal((await request('/directories?path='+encodeURIComponent(path.join(root,'escape')))).status,403);
    const created = await (await request('/threads',{cwd:root})).json(); const id = created.thread.id;
    const upload = await fetch(app.origin+'/api/attachments?name=hello.txt',{method:'POST',headers:{cookie,origin:app.origin},body:'hello'});
    assert.equal(upload.status,200); const file = await upload.json(); assert.equal(file.path,undefined);
    assert.equal(await (await fetch(app.origin+'/api/attachments/'+file.id,{headers:{cookie}})).text(),'hello');
    assert.equal((await request(`/threads/${id}/turns`,{text:'approve',attachments:[file.id]})).status,200);
    let snapshot;
    for (let i=0;i<30;i++) { snapshot = await (await request(`/threads/${id}`)).json(); if (snapshot.requests.length) break; await new Promise(r=>setTimeout(r,20)); }
    assert.equal(snapshot.requests.length,1); const approval = snapshot.requests[0]; assert.equal(approval.windows,true);
    assert.equal((await request('/requests/'+approval.id,{decision:'accept'})).status,200);
    assert.equal((await request('/requests/'+approval.id,{decision:'accept'})).status,409);
    for (let i=0;i<30;i++) { snapshot = await (await request(`/threads/${id}`)).json(); if (snapshot.thread.status.type==='idle') break; await new Promise(r=>setTimeout(r,20)); }
    assert.equal(snapshot.thread.turns[0].items.at(-1).text.includes('\\frac'),true);
    assert.equal(snapshot.thread.status.type,'idle'); assert.ok(snapshot.seq>0);
  } finally { await app.stop(); await rm(dir,{recursive:true,force:true}); }
});
