import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {serve} from '../server/main.ts';
import {AppServer} from '../server/adapter.ts';

test('Codex delegated tasks and native children share the existing panel',async({page})=>{
  const dir=await mkdtemp('/tmp/viewer-hybrid-browser-');await mkdir(dir+'/project');
  const adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const app=await serve({roots:[dir+'/project'],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
  try{
    await page.setViewportSize({width:1920,height:1080});await page.goto(app.launchUrl);
    const post=async(route:string,data:unknown)=>{const r=await page.request.post(app.origin+'/api'+route,{headers:{origin:app.origin},data});expect(r.ok()).toBeTruthy();return r.json();};
    const {thread}=await post('/threads',{cwd:dir+'/project'});
    await adapter.call('mock/turn',{threadId:thread.id,turnId:'seed',items:[{id:'original',type:'agentMessage',text:'HISTORY-MARKER'}]});
    await page.goto(app.origin+'/#'+thread.id);await expect(page.locator('#send')).toBeEnabled();
    await page.locator('#prompt').fill('preserved draft');
    await expect(page.locator('#handoff-toggle')).toHaveCount(0);
    await adapter.call('mock/agent',{threadId:thread.id,id:'native-child'});
    const result=await post('/threads/'+thread.id+'/agents',{runtimeId:'codex',operationId:'browser-child',task:'Inspect fixture'});
    const child=result.operation.result.threadId;
    await page.locator('#agents-toggle').click();
    await expect(page.locator('[data-agent-id="native-child"]')).toBeVisible();
    await page.locator(`[data-agent-id="${child}"]`).click();
    await expect(page.locator('.agent-detail')).toContainText('你好 world');
    await page.screenshot({path:'test-results/hybrid-desktop.png'});
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});
