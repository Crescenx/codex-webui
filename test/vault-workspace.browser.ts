import { test, expect } from '@playwright/test';
import { createServer } from 'vite';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

test('Obsidian and web share references with folder-scoped selection and new target creation',async({page,browser})=>{
 const dir=await mkdtemp('/tmp/vault-workspace-'),vault=dir+'/notes',project=dir+'/project';await mkdir(vault);await mkdir(project);
 const adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
 const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
 const dev=await createServer({configFile:path.resolve('vite.config.ts'),server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:app.origin,changeOrigin:true,headers:{origin:app.origin}}}}});
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await dev.listen();const address=dev.httpServer!.address();if(!address||typeof address==='string')throw new Error('Missing Vite address');
  await page.setViewportSize({width:1600,height:1000});await page.goto(app.launchUrl);
  const create=async(cwd:string,name:string)=>{const r=await page.request.post(app.origin+'/api/threads',{headers:{origin:app.origin},data:{cwd}});const {thread}=await r.json();await page.request.post(app.origin+'/api/threads/'+thread.id+'/name',{headers:{origin:app.origin},data:{name}});return thread.id;};
  const source=await create(vault,'论文讨论'),target=await create(project,'开发任务');
  await adapter.call('mock/turn',{threadId:source,turnId:'idea',items:[{id:'answer',type:'agentMessage',text:'把论文里的算法想法用于项目实验'}]});
  await page.goto('http://127.0.0.1:'+address.port);
  await page.evaluate(async({vault,source})=>{
   const entryPath='/web/main.ts',vuePath='/node_modules/.vite/deps/vue.js',storePath='/web/store.ts',componentPath='/obsidian-plugin/VaultApp.vue',stylePath='/obsidian-plugin/style.css';
   (await import(entryPath)).unmount();
   const {createApp}=await import(vuePath),{createViewerStore}=await import(storePath),{default:VaultApp}=await import(componentPath);
   await import(stylePath);
   const store=createViewerStore(undefined,undefined,{reloadOnRestart:false});
   const root=document.querySelector('#app')!;root.classList.add('vault-assistant');
   createApp(VaultApp,{store,host:{binding:{id:'vault',name:'notes',root:vault,windowsRoot:'D:\\notes'},lastSession:source,save:async()=>{},selection:()=>'',remember:()=>{}}}).mount(root);
  },{vault,source});
  await expect(page.locator('.va-header')).toContainText(vault);await expect(page.locator('.project-name')).toHaveCount(0);
  await expect(page.locator(`#threads [data-thread-id="${source}"]`)).toHaveCount(1);
  await expect(page.locator(`#threads [data-thread-id="${target}"]`)).toHaveCount(0);
  await expect(page.locator('#restart-backend')).toHaveCount(0);
  await page.getByRole('button',{name:'引用此 Session 到…',exact:true}).click();
  const dialog=page.locator('.reference-dialog[open]');
  await expect(dialog.getByLabel('目标会话')).toBeDisabled();
  await dialog.getByLabel('目标文件夹').selectOption(project);await dialog.getByLabel('目标会话').selectOption(target);
  await expect(dialog.getByLabel('目标会话').locator('option',{hasText:'开发任务'})).toHaveText('开发任务');
  await dialog.getByLabel('目标文件夹').selectOption(vault);
  await expect(dialog.getByLabel('目标会话')).toHaveValue('');
  await expect(dialog.getByLabel('目标会话').locator(`option[value="${target}"]`)).toHaveCount(0);
  await dialog.getByLabel('目标文件夹').selectOption(project);await dialog.getByLabel('目标会话').selectOption(target);await dialog.getByRole('button',{name:'预览',exact:true}).click();await dialog.getByRole('button',{name:'加入目标草稿'}).click();
  await expect(page.locator('.va-header')).toContainText(project);await expect(page.locator('.draft-references')).toContainText('论文讨论');
  await expect(page.locator(`#threads [data-thread-id="${target}"]`)).toHaveCount(0);
  await page.locator('#prompt').fill('请按引用的想法实现实验');await page.locator('#send').click();await expect(page.locator('.session-grants')).toContainText('已授权 Session');
  await expect(page.locator('#send')).toBeEnabled();
  const webContext=await browser.newContext({viewport:{width:1600,height:1000}});
  try{
   const web=await webContext.newPage();await web.goto(app.launchUrl);await web.goto(app.origin+'/#'+target);
   await expect(web.locator('.session-grants')).toContainText('已授权 Session');
   await expect(web.locator('#conversation .conversation-reference')).toContainText('论文讨论');
   await web.getByRole('button',{name:'引用此 Session 到…',exact:true}).click();
   const webDialog=web.locator('.reference-dialog[open]');await webDialog.getByLabel('目标文件夹').selectOption(vault);
   await webDialog.getByLabel('目标会话').selectOption('__new__');await webDialog.getByRole('button',{name:'预览',exact:true}).click();await webDialog.getByRole('button',{name:'加入目标草稿'}).click();
   const newId=new URL(web.url()).hash.slice(1);
   const created=await(await web.request.get(app.origin+'/api/threads/'+newId)).json();
   expect(created.thread.cwd).toBe(vault);expect(created.thread.turns).toHaveLength(0);
   await web.locator('#prompt').fill('把开发方案带回笔记');await web.locator('#send').click();await expect(web.locator('.session-grants')).toContainText('已授权 Session');
   await page.evaluate(async id=>{const root=document.querySelector('.vault-assistant-shell') as any;await root.__vueParentComponent.props.store.selectThread(id);},newId);
   await expect(page.locator('.va-header')).toContainText(vault);await expect(page.locator('#conversation .conversation-reference')).toContainText('开发任务');
  }finally{await webContext.close();}
  // Reproduce list/open returning different casing for the same Windows vault.
  const windowsVault='/mnt/d/Documents/obsidian/knowbase';
  await page.route('**/api/threads**',async route=>{
   const response=await route.fetch();const body=await response.json();
   if(Array.isArray(body.data))for(const thread of body.data)if(thread.cwd===vault)thread.cwd=windowsVault;
   if(body.thread?.cwd===vault)body.thread.cwd=windowsVault.toLowerCase();
   await route.fulfill({response,json:body});
  });
  await page.evaluate(async({windowsVault,source})=>{
   const root=document.querySelector('#app') as any;root.__vue_app__.unmount();
   const vuePath='/node_modules/.vite/deps/vue.js',storePath='/web/store.ts',componentPath='/obsidian-plugin/VaultApp.vue';
   const {createApp}=await import(vuePath),{createViewerStore}=await import(storePath),{default:VaultApp}=await import(componentPath);
   createApp(VaultApp,{store:createViewerStore(undefined,undefined,{reloadOnRestart:false}),host:{binding:{id:'vault',name:'notes',root:windowsVault,windowsRoot:'D:\\Documents\\obsidian\\knowbase'},lastSession:source,save:async()=>{},selection:()=>'',remember:()=>{}}}).mount(root);
  },{windowsVault,source});
  await expect(page.locator('#threads .thread')).toHaveCount(2);
  const ids=await page.locator('#threads .thread').evaluateAll(rows=>rows.map(row=>(row as HTMLElement).dataset.threadId!));
  for(const id of [...ids,...ids]){
   await page.locator(`#threads [data-thread-id="${id}"]`).click();
   await expect(page.locator('.va-header')).toContainText(windowsVault.toLowerCase());
   await expect(page.locator('#threads .thread')).toHaveCount(2);
  }
  await expect(page.locator(`#threads [data-thread-id="${target}"]`)).toHaveCount(0);
  await page.screenshot({path:'test-results/vault-shared-workspace.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
 }finally{await dev.close();await app.stop();await rm(dir,{recursive:true,force:true});}
});
