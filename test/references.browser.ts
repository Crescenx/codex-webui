import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

test('explicit forwarding excludes collapsed tools, previews exact records, preserves drafts and supports session revocation',async({page})=>{
  const dir=await mkdtemp('/tmp/viewer-ref-browser-'),adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
  try{
    await page.setViewportSize({width:1600,height:1000});await page.goto(app.launchUrl);
    const headers={origin:app.origin};
    const create=async(name:string)=>{const {thread}=await(await page.request.post(app.origin+'/api/threads',{headers,data:{cwd:dir}})).json();await page.request.post(app.origin+'/api/threads/'+thread.id+'/name',{headers,data:{name}});return thread.id;};
    const source=await create('来源讨论'),target=await create('目标讨论');
    await adapter.call('mock/mcpApp',{threadId:source,turnId:'record-turn',items:[{id:'u',type:'userMessage',content:[{type:'text',text:'用户选中的问题'}]},{id:'tool',type:'commandExecution',command:'echo evidence',aggregatedOutput:'明确工具证据',status:'completed'},{id:'a',type:'agentMessage',text:'助手选中的回答'}]});
    await page.evaluate(id=>localStorage.setItem('viewer-draft:'+id,'目标原有草稿'),target);
    await page.goto(app.origin+'/#'+source);await page.getByRole('button',{name:'选择转发',exact:true}).click();
    await expect(page.getByLabel('选择此工具记录',{exact:true})).toHaveCount(0);
    await page.getByLabel('选择此消息',{exact:true}).first().check();await page.getByLabel('选择此消息',{exact:true}).last().check();
    await expect(page.locator('.reference-selection-bar')).toContainText('已选 2 条 · 其中工具 0 条');
    await page.locator('.trace-toggle').click();await page.getByLabel('选择此工具记录',{exact:true}).check();
    await page.locator('.trace-toggle').click();await expect(page.locator('.trace-toggle')).toContainText('已选 1 条工具记录');
    await page.getByRole('button',{name:'清除所选工具'}).click();await page.getByRole('button',{name:'转发到…',exact:true}).click();
    const dialog=page.locator('.reference-dialog[open]');await dialog.getByLabel('目标文件夹').selectOption(dir);await dialog.getByLabel('目标会话').selectOption(target);await dialog.getByRole('button',{name:'预览',exact:true}).click();
    await expect(dialog).toContainText('用户选中的问题');await expect(dialog).toContainText('助手选中的回答');await expect(dialog).not.toContainText('明确工具证据');
    await dialog.getByRole('button',{name:'加入目标草稿'}).click();await expect(page.locator('#prompt')).toHaveValue('目标原有草稿');
    await expect(page.locator('.draft-references .conversation-reference')).toHaveCount(1);await page.reload();await expect(page.locator('.draft-references .conversation-reference')).toHaveCount(1);
    const before=await(await page.request.get(app.origin+'/api/threads/'+target)).json();expect(before.thread.turns).toHaveLength(0);
    await page.locator('#send').click();await expect(page.locator('#conversation .conversation-reference')).toHaveCount(1);
    await expect(page.locator('.draft-references .conversation-reference')).toHaveCount(0);await expect(page.locator('#stop')).toBeHidden();
    await page.getByRole('button',{name:'＋ Session',exact:true}).click();await dialog.getByLabel('来源文件夹').selectOption(dir);await dialog.getByLabel('来源会话').selectOption(source);await dialog.getByRole('button',{name:'预览',exact:true}).click();await dialog.getByRole('button',{name:'加入目标草稿'}).click();
    await page.locator('#send').click();await expect(page.locator('.session-grants')).toContainText('已授权 Session · 1');await page.locator('.session-grants summary').click();
    await page.getByRole('button',{name:'撤销后续读取'}).click();await expect(page.locator('.session-grants')).toHaveCount(0);
    await page.screenshot({path:'test-results/references-desktop.png',fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('new client on old backend keeps reference drafts and hides unsupported creation',async({page})=>{
  const dir=await mkdtemp('/tmp/viewer-ref-old-'),adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
  try{
    await page.goto(app.launchUrl);
    const {thread}=await(await page.request.post(app.origin+'/api/threads',{headers:{origin:app.origin},data:{cwd:dir}})).json();
    await page.route('**/api/controls?*',async route=>{const response=await route.fetch(),body=await response.json();delete body.capabilities;await route.fulfill({response,json:body});});
    await page.evaluate(id=>localStorage.setItem('viewer-references:'+id,JSON.stringify([{version:1,id:'saved-ref',kind:'snapshot',targetThreadId:id,sourceThreadId:'source',title:'已保留',createdAt:'2026-10-14',active:false,revoked:false,entries:[]}])),thread.id);
    await page.goto(app.origin+'/#'+thread.id);await expect(page.locator('#send')).toBeEnabled();
    await expect(page.getByRole('button',{name:'选择转发',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'＋ Session',exact:true})).toHaveCount(0);
    await page.locator('#send').click();await expect(page.locator('.draft-references')).toContainText('已保留');await expect(page.locator('#error')).toContainText('不支持这些引用');
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});
