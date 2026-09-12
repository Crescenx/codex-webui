import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

test('new sessions link context to model capability and preserve it across navigation',async({page})=>{
  const dir=await mkdtemp('/tmp/viewer-context-ui-');
  const app=await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter:new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]})});
  try{
    await page.setViewportSize({width:1280,height:900});await page.goto(app.launchUrl);
    await page.locator('#welcome-new').click();await page.locator('.folder').filter({hasText:dir}).click();
    const model=page.locator('#new-model'),context=page.locator('#new-context');
    await expect(model).toHaveValue('mock');await expect(context).toBeEnabled();await expect(context).not.toBeChecked();
    await context.check();await model.selectOption('mock-fast');await expect(context).toBeDisabled();await expect(context).not.toBeChecked();
    await expect(page.locator('#new-context-help')).toContainText('不支持');
    await model.selectOption('mock');await expect(context).not.toBeChecked();await context.check();
    await page.screenshot({path:'test-results/context-new-desktop.png'});
    await page.setViewportSize({width:1920,height:844});await page.locator('#folder-select').scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(page.locator('#folder-select')).toBeInViewport();await page.screenshot({path:'test-results/context-new-widescreen.png'});
    await page.locator('#folder-select').click();await expect(page.locator('#context-state')).toContainText('已开启');
    const experiment=new URL(page.url()).hash;
    await expect(page.locator('#model option[value="mock-fast"]')).toHaveJSProperty('disabled',true);
    await page.locator('#prompt').fill('context check');await page.locator('#send').click();
    await expect(page.locator('#stop')).toBeHidden();await page.reload();await expect(page.locator('#context-state')).toContainText('已开启');
    await page.locator('.project-new').click();
    await expect(page.locator('#folder-path')).toHaveText(dir);
    await expect(page.locator('#folder-native')).toHaveCount(0);
    await expect(page.locator('#folder-location')).toHaveCount(0);
    await expect(page.locator('.folder-navigation')).toHaveCount(0);
    await expect(page.locator('#folders')).toHaveCount(0);
    await expect(model).toHaveValue('mock');await expect(context).toBeEnabled();
    await page.screenshot({path:'test-results/context-project-new-widescreen.png'});
    await expect(context).not.toBeChecked();await model.selectOption('mock-fast');await page.locator('#folder-select').click();
    await expect(page.locator('#model')).toHaveValue('mock-fast');await expect(page.locator('#context-state')).toHaveCount(0);
    await expect(page.locator('#cwd')).toHaveText(dir);
    await page.locator('#new').click();
    await expect(page.locator('#folder-native')).toBeVisible();
    await expect(page.locator('#folder-location')).toBeVisible();
    await page.locator('#folder-dialog button[aria-label="关闭"]').click();
    await page.goto(app.origin+'/'+experiment);await expect(page.locator('#context-state')).toContainText('已开启');
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});
