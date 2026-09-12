import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, chmod, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';
import type { NewThreadOptions, Thread } from '../shared/protocol.ts';

// Opt-in: three small live responses, including one real context transition. User config stays untouched.
const dir=await mkdtemp('/tmp/viewer-context-live-'),home=path.join(dir,'codex'),cwd=path.join(dir,'project');
let app:Awaited<ReturnType<typeof serve>>|undefined,cookie='';
try{
  await mkdir(home,{mode:0o700});await mkdir(cwd);
  for(const name of ['auth.json','models_cache.json']){
    await copyFile(path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),name),path.join(home,name));
    await chmod(path.join(home,name),0o600);
  }
  await writeFile(path.join(home,'config.toml'),'model_reasoning_effort = "low"\n');
  const start=async()=>{
    const adapter=new AppServer({cwd,env:{...process.env,CODEX_HOME:home}});
    app=await serve({roots:[cwd],dataDir:path.join(dir,'viewer'),runtimeDir:path.join(dir,'run'),port:0,adapter,codexHome:home});
    cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
  };
  const http=async(url:string,body?:unknown)=>{
    const response=await fetch(app!.origin+'/api'+url,{method:body===undefined?'GET':'POST',headers:{cookie,origin:app!.origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const result=await response.json();assert.equal(response.status,200,result.error);return result;
  };
  const turn=async(id:string,text:string)=>{
    await http(`/threads/${id}/turns`,{text,attachments:[]});
    const until=Date.now()+120000;
    while(Date.now()<until){
      const {thread}=await http(`/threads/${id}`) as {thread:Thread};const latest=thread.turns?.at(-1);
      if(latest&&latest.status!=='inProgress'){
        assert.equal(latest.status,'completed',JSON.stringify(latest.error));
        return latest.items.findLast(i=>i.type==='agentMessage')?.text?.trim();
      }
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw new Error('Live context check timed out');
  };
  await start();
  const options=await http('/thread-options?cwd='+encodeURIComponent(cwd)) as NewThreadOptions;
  assert.equal(options.contextReason,'');const model=options.models.find(m=>m.supportsExperimentalContext===true)?.model;
  assert.ok(model,'No eligible model in the current catalog');
  const ordinary=await http('/threads',{cwd,model,contextManagement:false});
  assert.equal(await turn(ordinary.thread.id,'Without tools, reply exactly CONTEXT_ON if new_context is available to you, otherwise CONTEXT_OFF.'),'CONTEXT_OFF');
  console.log('Ordinary session has no experimental context tools.');
  const enabled=await http('/threads',{cwd,model,contextManagement:true});
  assert.equal(await turn(enabled.thread.id,'Explicit bounded integration test: save marker VIEWER_CONTEXT_4829 in your notes, invoke new_context exactly once, recover the marker from your notes, then finish with exactly that marker. Do not use shell, network, subagents or modify project files. After recovery do not invoke new_context again.'),'VIEWER_CONTEXT_4829');
  const files=await readdir(path.join(home,'sessions'),{recursive:true});
  const file=files.find(f=>f.endsWith(enabled.thread.id+'.jsonl'));assert.ok(file);
  const rows=(await readFile(path.join(home,'sessions',file),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(rows.filter(r=>r.type==='response_item'&&r.payload?.type==='function_call'&&r.payload.name==='new_context').length,1);
  assert.ok(rows.filter(r=>r.type==='turn_context').length>=2);
  console.log('Experimental session completed one real context transition and recovered its note.');
  await app!.stop();await start();
  assert.equal((await http(`/threads/${enabled.thread.id}/open`,{})).thread.contextManagement,true);
  assert.equal(await turn(enabled.thread.id,'Without tools, reply exactly CONTEXT_ON if new_context is available to you, otherwise CONTEXT_OFF.'),'CONTEXT_ON');
  assert.equal((await http(`/threads/${ordinary.thread.id}/open`,{})).thread.contextManagement,false);
  console.log('Viewer restart preserved both choices; resumed experimental session still has its tools.');
}finally{await app?.stop();await rm(dir,{recursive:true,force:true});}
