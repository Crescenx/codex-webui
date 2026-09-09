import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppServer } from '../server/adapter.ts';
import { threadFrom, object } from '../server/protocol.ts';
import type { Notice } from '../server/protocol.ts';

// Opt-in live check: consumes one short model response, with no tool permission grants.
const cwd = await mkdtemp(path.join(os.tmpdir(),'viewer-live-'));
const adapter = new AppServer({cwd});
let response = '';
adapter.on('notice', (n:Notice) => { if(n.method==='item/agentMessage/delta') response += String(n.params.delta || ''); });
adapter.on('request', m => adapter.unsupported(m.id));
try {
  await adapter.start();
  const models=await adapter.call('model/list',{limit:10});assert.ok((models.data as unknown[]).length);
  const modes=await adapter.call('collaborationMode/list',{});assert.ok((modes.data as {mode:string}[]).some(m=>m.mode==='plan'));
  const skills=await adapter.call('skills/list',{cwds:[cwd]});assert.ok(Array.isArray(skills.data));
  const list = await adapter.call('thread/list',{limit:1,sourceKinds:['cli','vscode','appServer']}); assert.ok(Array.isArray(list.data));
  const created=await adapter.call('thread/start',{cwd,sandbox:'read-only',approvalPolicy:'on-request',approvalsReviewer:'user',ephemeral:true});
  const t = threadFrom(created.thread);
  const completed = new Promise<Notice>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Live turn timed out')),120000);
    adapter.on('notice',(n:Notice)=>{if(n.method==='turn/completed' && n.params.threadId===t.id){clearTimeout(timer);resolve(n);}});
  });
  await adapter.call('turn/start',{threadId:t.id,input:[{type:'text',text:'Reply with exactly VIEWER_OK. Do not call any tools.',text_elements:[]}],collaborationMode:{mode:'default',settings:{model:created.model,reasoning_effort:created.reasoningEffort,developer_instructions:null}},approvalPolicy:'on-request',approvalsReviewer:'user',sandboxPolicy:{type:'readOnly'}});
  const n=await completed; assert.equal(object(n.params.turn).status,'completed');
  assert.equal(response.trim(),'VIEWER_OK');
  console.log('Live models, modes, skills, explicit collaboration settings and streamed turn completed.');
  const isolated=path.join(cwd,'isolated-codex');const skillDir=path.join(isolated,'skills','viewer-probe');await mkdir(skillDir,{recursive:true});
  const skillPath=path.join(skillDir,'SKILL.md');await writeFile(skillPath,'---\nname: viewer-probe\ndescription: Isolated protocol test fixture\n---\nOnly a test fixture.\n');
  const probe=new AppServer({cwd,env:{...process.env,CODEX_HOME:isolated}});
  try{
    const before=await probe.call('skills/list',{cwds:[cwd],forceReload:true});assert.ok(JSON.stringify(before).includes('viewer-probe'));
    const result=await probe.call('skills/config/write',{path:skillPath,enabled:false});assert.equal(result.effectiveEnabled,false);
    const after=await probe.call('skills/list',{cwds:[cwd],forceReload:true});
    const group=(after.data as {skills:{path:string;enabled:boolean}[]}[])[0];assert.equal(group.skills.find(s=>s.path===skillPath)?.enabled,false);
    console.log('Isolated real Skill configuration write/read passed; user configuration unchanged.');
  }finally{probe.stop();}
} finally { adapter.stop(); await rm(cwd,{recursive:true,force:true}); }
