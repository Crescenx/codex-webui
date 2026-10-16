import { test,expect } from '@playwright/test';
import { mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';
test('shared sidebar finds dialogue and deletes native sessions without losing another draft',async({page})=>{
 const dir=await mkdtemp('/tmp/viewer-session-actions-'),adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
 const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
 try{
  await page.goto(app.launchUrl);const headers={origin:app.origin};
  const create=async(name:string)=>{const {thread}=await(await page.request.post(app.origin+'/api/threads',{headers,data:{cwd:dir}})).json();await page.request.post(app.origin+'/api/threads/'+thread.id+'/name',{headers,data:{name}});return thread.id;};
  const kept=await create('保留的会话'),removed=await create('待删除会话');await page.goto(app.origin+'/#'+kept);
  await expect(page.locator('#send')).toBeEnabled();await page.locator('#prompt').fill('render-markdown\n正文查找验收');await page.locator('#send').click();await expect(page.locator('.assistant').last()).toContainText('正文查找验收');await expect(page.locator('#send')).toBeEnabled();await page.locator('#prompt').fill('保留未发送草稿');
  await page.locator('#sidebar .conversation-find').click();const search=page.getByRole('searchbox',{name:'查找当前对话'});await expect(search).toBeVisible();expect(await search.evaluate(el=>!!el.closest('#sidebar'))).toBe(true);await search.fill('正文查找验收');await expect(page.locator('#sidebar .conversation-search [role="status"]')).toContainText('条');await page.getByRole('button',{name:'关闭查找',exact:true}).click();
  await page.locator('[data-thread-id="'+removed+'"]').hover();await page.getByRole('button',{name:'删除 待删除会话',exact:true}).click();await expect(page.locator('#delete-thread-dialog')).toBeVisible();await page.locator('#delete-thread-dialog').getByRole('button',{name:'取消',exact:true}).click();await expect(page.locator('[data-thread-id="'+removed+'"]')).toBeVisible();
  await page.getByRole('button',{name:'删除 待删除会话',exact:true}).click();await page.locator('#delete-thread-dialog').getByRole('button',{name:'删除',exact:true}).click();await expect(page.locator('[data-thread-id="'+removed+'"]')).toHaveCount(0);await expect(page.locator('#prompt')).toHaveValue('保留未发送草稿');await page.reload();await expect(page.locator('[data-thread-id="'+removed+'"]')).toHaveCount(0);await expect(page.locator('#prompt')).toHaveValue('保留未发送草稿');
  await page.locator('[data-thread-id="'+kept+'"]').hover();await page.getByRole('button',{name:'删除 保留的会话',exact:true}).click();await page.locator('#delete-thread-dialog').getByRole('button',{name:'删除',exact:true}).click();await expect(page.locator('.thread')).toHaveCount(0);await expect.poll(()=>new URL(page.url()).hash).toBe('');await page.reload();await expect(page.locator('.thread')).toHaveCount(0);
 }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});
