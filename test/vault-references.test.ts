import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';
import { VaultAssistant } from '../server/vault.ts';

test('plugin and browser share cross-project references; native reads retain target identity, revocation and root checks',async()=>{
  const dir=await mkdtemp('/tmp/vault-references-'),a=dir+'/a',b=dir+'/b';await mkdir(a);await mkdir(b);
  const adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
  try{
    const vaults=new VaultAssistant(dir+'/data');
    const token='fixture-vault-token';vaults.db.prepare('INSERT INTO vaults VALUES(?,?,?,?,?)').run('a','A',a,'D:\\fixture-a',createHash('sha256').update(token).digest('hex'));
    vaults.db.prepare('INSERT INTO vaults VALUES(?,?,?,?,?)').run('b','B',b,'D:\\fixture-b','unused');vaults.close();
    const cookie=(await fetch(app.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
    const req=(p:string,body?:unknown,plugin=true)=>fetch(app.origin+'/api'+p,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(plugin?{Authorization:'Bearer '+token}:{Cookie:cookie,Origin:app.origin})},body:body===undefined?undefined:JSON.stringify(body)});
    const create=async(cwd:string,plugin=true)=>(await(await req('/threads',{cwd},plugin)).json()).thread.id;
    const source=await create(a),target=await create(a),outside=await create(b,false);
    await adapter.call('mock/turn',{threadId:source,turnId:'src',items:[{id:'message',type:'agentMessage',text:'same-vault record'}]});
    await adapter.call('mock/turn',{threadId:outside,turnId:'src',items:[{id:'message',type:'agentMessage',text:'other-vault private'}]});
    const route=`/threads/${target}/references`;
    const snapshot=await req(route,{kind:'snapshot',sourceThreadId:outside,selected:[{turnId:'src',itemId:'message'}]});assert.equal(snapshot.status,200);assert.match(JSON.stringify(await snapshot.json()),/other-vault private/);
    assert.equal((await req(route,{kind:'session',sourceThreadId:outside})).status,200);
    const cross=await req(`/threads/${outside}/references`,{kind:'session',sourceThreadId:source});assert.equal(cross.status,200);const crossRef=(await cross.json()).reference;
    assert.equal((await req(`/threads/${outside}/turns`,{text:'use the idea in this project',attachments:[],references:[crossRef.id],clientMessageId:'project-send'},false)).status,200);
    assert.match(JSON.stringify(await adapter.call('mock/references',{threadId:outside,name:'session_read',arguments:{referenceId:crossRef.id,mode:'items'}})),/same-vault record/);
    await assert.rejects(adapter.call('mock/references',{threadId:target,name:'session_read',arguments:{referenceId:crossRef.id,mode:'items'}}),/引用不存在|不属于/);
    const made=await req(route,{kind:'session',sourceThreadId:source});assert.equal(made.status,200);const {reference}=await made.json();
    assert.equal((await req(`/threads/${target}/turns`,{text:'inspect source',attachments:[],references:[reference.id],clientMessageId:'vault-send'})).status,200);
    const read=()=>adapter.call('mock/references',{threadId:target,name:'session_read',arguments:{referenceId:reference.id,mode:'items'}});
    assert.match(JSON.stringify(await read()),/same-vault record/);
    const state=new VaultAssistant(dir+'/data');state.bind(source,'b');state.close();
    assert.match(JSON.stringify(await read()),/same-vault record/,'origin metadata does not change reference authorization');
    assert.equal((await req(`/threads/${target}/references/${reference.id}`,{action:'revoke'})).status,200);
    await assert.rejects(read(),/读取授权/);
    const hidden=await adapter.call('thread/start',{cwd:'/etc'});const hiddenId=(hidden.thread as {id:string}).id;
    assert.equal((await req(route,{kind:'session',sourceThreadId:hiddenId})).status,403);
    assert.equal((await req('/threads/'+target)).status,200,'old plugin reads are unchanged');
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});
