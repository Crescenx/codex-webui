import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

async function keyboardFocus(page:Page) {
  await page.locator('#conversation').focus();
  for (const id of ['model','effort','mode','skills-button','prompt']) {
    await page.keyboard.press('Tab');
    const target=page.locator('#'+id);
    await expect(target).toBeFocused();
    if(id==='prompt') {
      await expect(target).toHaveCSS('outline-style','none');
      await expect(target).toHaveCSS('box-shadow','none');
      await expect(page.locator('#composer')).toHaveCSS('border-top-color','rgb(217, 189, 145)');
      continue;
    }
    await expect(target).toHaveCSS('outline-style','solid');
    await expect(target).toHaveCSS('outline-width','2px');
    await expect(target).toHaveCSS('outline-color','rgb(217, 189, 145)');
    if (['model','effort','mode'].includes(id)) {
      await target.hover();
      await expect(target).toHaveCSS('border-top-color','rgb(217, 189, 145)');
    }
  }
  const contrast=await page.locator('#settings-state').evaluate(el=>{
    const luminance=(color:string)=>color.match(/\d+/g)!.slice(0,3).map(Number).map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
    const fg=luminance(getComputedStyle(el).color);
    const bg=luminance(getComputedStyle(el.closest('#composer')!).backgroundColor);
    return (Math.max(fg,bg)+0.05)/(Math.min(fg,bg)+0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
}

async function fitsViewport(page:Page,selector:string) {
  for (const element of await page.locator(selector).all()) {
    await expect(element).toBeVisible();
    const box=await element.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x+box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(await element.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
}

test('render, source copy, upload, approval and reconnect', async ({page,context}) => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'viewer-browser-')); const root=path.join(dir,'project'); await mkdir(root);
  await writeFile(path.join(root,'sample.py'),'first line\ntarget line\nthird line');
  const opened:string[]=[];
  const app = await serve({roots:[root],dataDir:path.join(dir,'data'),runtimeDir:path.join(dir,'run'),port:0,adapter:new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]}),editor:async f=>{opened.push(`${f.path}:${f.line}`);}});
  try {
    await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:app.origin});
    await page.goto(app.launchUrl);
    await expect(page.locator('#composer')).toBeHidden();await expect(page.locator('#welcome-new')).toBeVisible();await expect(page.locator('#skills-button')).toBeDisabled();
    await page.screenshot({path:'test-results/viewer-home.png',fullPage:true});
    await page.route('**/api/controls?*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'模拟配置加载失败'})}));
    await page.locator('#welcome-new').click(); await page.getByRole('button',{name:'▱ '+root,exact:true}).click(); await page.locator('#folder-select').click();
    await expect(page.locator('#settings-state')).toContainText('模拟配置加载失败');await expect(page.locator('#model')).toBeDisabled();
    await page.locator('#skills-button').click();await expect(page.locator('#skill-list')).toContainText('Skills 加载失败');await page.getByRole('button',{name:'关闭 Skills',exact:true}).click();
    await page.unroute('**/api/controls?*');await page.locator('#controls-retry').click();await expect(page.locator('#model')).toBeEnabled();
    await page.route('**/api/controls?*',async route=>{const response=await route.fetch();const data=await response.json();await route.fulfill({response,json:{...data,skills:[]}});});
    await page.reload();await expect(page.locator('#model')).toBeEnabled();await page.locator('#skills-button').click();await expect(page.locator('#skill-list')).toContainText('没有发现可用的 Skill');
    await page.unroute('**/api/controls?*');await page.getByRole('button',{name:'重新加载',exact:true}).click();await expect(page.getByRole('button',{name:'用于本轮',exact:true})).toBeVisible();await page.getByRole('button',{name:'关闭 Skills',exact:true}).click();
    await expect(page.locator('#send')).toBeEnabled();
    await keyboardFocus(page);
    await page.screenshot({path:'test-results/viewer-prompt-focus.png',fullPage:true});
    await page.locator('#model').focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
    await page.screenshot({path:'test-results/viewer-focus.png',fullPage:true});
    await page.locator('#model').selectOption('mock-fast');await page.locator('#effort').selectOption('high');await page.locator('#mode').selectOption('plan');
    await expect(page.locator('#settings-state')).toContainText('已生效：mock · medium · 普通');
    await expect(page.locator('#settings-state')).toContainText('下一轮：mock-fast · high · Plan');
    await page.locator('#skills-button').click();await page.getByRole('button',{name:'全局：已启用',exact:true}).click();await expect(page.getByRole('button',{name:'用于本轮',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'全局：已禁用',exact:true}).click();await expect(page.getByRole('button',{name:'用于本轮',exact:true})).toBeEnabled();await page.getByRole('button',{name:'用于本轮',exact:true}).click();
    await page.screenshot({path:'test-results/viewer-skills.png',fullPage:true});
    await page.getByRole('button',{name:'关闭 Skills',exact:true}).click();
    await expect(page.locator('#selected-skills')).toContainText('sample-skill');
    await page.locator('#files').setInputFiles({name:'note.txt',mimeType:'text/plain',buffer:Buffer.from('sample')});
    await expect(page.locator('#attachments')).toContainText('note.txt');
    await page.locator('#prompt').evaluate(el=>{
      const data=new DataTransfer(); const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
      data.items.add(new File([bytes],'paste.png',{type:'image/png'}));el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:data}));
    });
    await expect(page.locator('#attachments img')).toBeVisible();
    await page.screenshot({path:'test-results/viewer-config.png',fullPage:true});
    await page.locator('#prompt').fill('approve'); await page.locator('#send').click();
    await expect(page.locator('.approval.windows')).toBeVisible();
    await page.screenshot({path:'test-results/viewer-approval.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:'test-results/viewer-approval-mobile.png',fullPage:true});
    for (const id of ['attach','stop','send']) {
      const action=page.locator('#'+id);
      await expect(action).toHaveCSS('white-space','nowrap');
      expect(await action.evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);return range.getClientRects().length;})).toBe(1);
    }
    await fitsViewport(page,'.composer-actions, #attach, #stop, #send');
    await page.setViewportSize({width:1280,height:720});
    await page.reload(); await expect(page.locator('.approval.windows')).toBeVisible();
    const firstTitle=await page.locator('#threads strong').first().innerText();
    await page.locator('#new').click(); await page.getByRole('button',{name:'▱ '+root,exact:true}).click(); await page.locator('#folder-select').click();
    await expect(page.locator('#send')).toBeEnabled(); await page.locator('#prompt').fill('second task'); await page.locator('#send').click();
    await expect(page.locator('.katex')).toBeVisible();
    await page.reload(); await expect(page.locator('.markdown table')).toBeVisible();
    await page.locator('#threads .thread').filter({hasText:firstTitle}).click(); await expect(page.locator('.approval.windows')).toBeVisible();
    page.on('dialog',()=>{throw new Error('Unexpected confirmation dialog');}); await page.getByRole('button',{name:'允许本次 Windows 操作',exact:true}).click();
    await expect(page.locator('.katex')).toBeVisible(); await expect(page.locator('.markdown table')).toBeVisible();
    await expect(page.locator('#threads .project')).toHaveCount(1);
    await expect(page.locator('.activity').filter({hasText:'思考结束'})).toHaveCount(1);
    await expect(page.locator('details.activity').filter({hasText:'思考结束'})).toHaveCount(0);
    for (const header of await page.locator('.tool .message-header').all()) await expect(header).toBeHidden();
    await expect(page.locator('.markdown strong').filter({hasText:'错误的成功判定'})).toHaveCount(1);
    const emphasis=page.locator('.markdown strong').filter({hasText:'错误的成功判定'});
    // A regular-only CJK face reproduces the fallback that font-weight alone cannot fix.
    await page.evaluate(async()=>{const font=new FontFace('CJK regression','local("AR PL KaitiM GB")');document.fonts.add(await font.load());});
    await emphasis.evaluate(el=>{el.style.fontFamily='"CJK regression"';el.style.display='block';});
    const bold=await emphasis.screenshot({path:'test-results/viewer-cjk-bold.png'});
    await emphasis.evaluate(el=>el.style.fontSynthesis='none');
    const unsynthesized=await emphasis.screenshot();
    await emphasis.evaluate(el=>el.style.fontWeight='400');
    const regular=await emphasis.screenshot({path:'test-results/viewer-cjk-regular.png'});
    expect(unsynthesized.equals(regular),'Regular-only Chinese must reproduce the missing bold glyph case').toBe(true);
    expect(bold.equals(regular),'Chinese emphasis must change actual rendered pixels').toBe(false);
    await emphasis.evaluate(el=>el.removeAttribute('style'));
    await expect(page.locator('#model')).toHaveValue('mock-fast');await expect(page.locator('#mode')).toHaveValue('plan');
    const reference=page.locator('a[data-file]');await reference.click();await expect(page.locator('.reference-card')).toContainText('target line');
    await page.screenshot({path:'test-results/viewer-preview.png',fullPage:true});
    await page.keyboard.press('Escape');await reference.click({modifiers:['Control']});await expect.poll(()=>opened).toEqual([path.join(root,'sample.py')+':2']);await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'复制代码',exact:true}).click();
    expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('const x = 1;\n\n\nconsole.log(x);\n');
    await page.getByRole('button',{name:'复制 Markdown',exact:true}).click();
    const raw=await page.evaluate(()=>navigator.clipboard.readText()); expect(raw).toContain('$\\frac{1}{2}$'); expect(raw).toContain('\n\n\nconsole.log');
    const selected = await page.locator('.assistant .markdown').evaluate(el=>{
      const range=document.createRange(); range.selectNodeContents(el); const selection=window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      const data=new DataTransfer(); el.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,clipboardData:data})); return data.getData('text/plain');
    });
    expect(selected).toContain('$\\frac{1}{2}$'); expect(selected).toContain('[OpenAI](https://openai.com)'); expect(selected).toContain('```ts\nconst x = 1;\n\n\nconsole.log(x);\n```'); expect(selected).not.toContain('**world**');
    const partial=await page.locator('.katex-html .mord').first().evaluate(el=>{
      const range=document.createRange();range.selectNodeContents(el);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
      const data=new DataTransfer();el.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,clipboardData:data}));return data.getData('text/plain');
    });
    expect(partial).toBe('$\\frac{1}{2}$');
    await page.evaluate(()=>window.getSelection()?.removeAllRanges());
    await page.reload(); await expect(page.locator('.katex')).toBeVisible();await expect(page.locator('#model')).toBeEnabled();
    await expect(page.locator('.markdown pre code')).toHaveCSS('font-size','13.5px');
    await expect(page.locator('.markdown pre .hljs-keyword')).toContainText('const');
    const command=page.locator('.activity[data-kind="commandExecution"]');
    await expect(command).toHaveCount(1);
    await expect(command.locator('.activity-command')).toHaveCSS('white-space','nowrap');
    const commandColor=await command.locator('.activity-command').evaluate(el=>getComputedStyle(el).color);
    expect(commandColor).not.toBe(await command.locator('.activity-label').evaluate(el=>getComputedStyle(el).color));
    await expect(command.locator('.activity-output code')).toBeEmpty();
    await expect(command.locator('.activity-command .hljs-string')).not.toHaveCount(0);
    await command.locator('summary').click();
    await expect(command.locator('.activity-command-full .hljs-string')).not.toHaveCount(0);
    await expect(command.locator('.activity-command-full')).toContainText('printf');
    await expect(command).toContainText('<safe>');await expect(command.locator('script')).toHaveCount(0);
    await expect(command.locator('.activity-output span').filter({hasText:'PASS'})).toHaveCSS('color','rgb(165, 185, 149)');
    await command.getByRole('button',{name:'复制命令',exact:true}).click();
    expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(await command.locator('.activity-command').getAttribute('title'));
    await command.getByRole('button',{name:'复制输出',exact:true}).click();
    expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('PASS <safe>\nWARN sample warning\nERROR sample error (fixture only)\nCommand output is plain text.');
    await page.setViewportSize({width:1440,height:1080});
    await command.evaluate(el=>el.scrollIntoView({block:'start'}));
    await page.screenshot({path:'test-results/viewer-command-colors.png',fullPage:true});
    await command.locator('summary').click();
    await page.screenshot({path:'test-results/viewer.png',fullPage:true});
    await page.setViewportSize({width:1440,height:1080});
    await page.locator('.assistant').evaluate(el=>el.scrollIntoView({block:'start'}));
    await page.screenshot({path:'test-results/viewer-reading.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/viewer-mobile.png',fullPage:true});
    await page.locator('.assistant').evaluate(el=>el.scrollIntoView({block:'start'}));
    await page.screenshot({path:'test-results/viewer-reading-mobile-top.png',fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  } finally { await app.stop(); await rm(dir,{recursive:true,force:true}); }
});

for (const width of [1280,390]) test(`long content, streaming and manual reading at ${width}px`, async ({page})=>{
  await page.setViewportSize({width,height:width===390?844:720});
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-reading-'));
  const root=path.join(dir,'项目目录-'+ 'long-project-path-'.repeat(5));await mkdir(root);
  await writeFile(path.join(root,'sample.py'),'first line\ntarget line\nthird line');
  const adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  let deltas=0;adapter.on('notice',n=>{if(n.method==='item/agentMessage/delta')deltas++;});
  const app=await serve({roots:[root],dataDir:path.join(dir,'data'),runtimeDir:path.join(dir,'run'),port:0,adapter,editor:async()=>{throw new Error('Editor must not open');}});
  try {
    await page.goto(app.launchUrl);
    await page.screenshot({path:`test-results/viewer-home-${width}.png`,fullPage:true});
    await page.route('**/api/controls?*',async route=>{
      const response=await route.fetch();const data=await response.json();
      data.models[0].displayName='模型-'+ 'long-model-name-'.repeat(8);
      data.skills=Array.from({length:24},(_,i)=>({...data.skills[0],name:i===0?'超长技能-'+ 'long-skill-name-'.repeat(14):`阅读辅助 Skill ${i}`,path:`/mock/skills/${i}/SKILL.md`,description:'中文与 English 混排说明，保留全局开关和本轮选择的区别。'+ 'long-description-'.repeat(6)}));
      await route.fulfill({response,json:data});
    });
    await page.locator('#welcome-new').click();
    await expect(page.locator('.folder')).toHaveCount(1);
    await fitsViewport(page,'#folder-dialog, .folder');
    await page.screenshot({path:`test-results/viewer-folder-${width}.png`,fullPage:true});
    await page.getByRole('button',{name:'▱ '+root,exact:true}).click();await page.locator('#folder-select').click();
    await expect(page.locator('#model')).toBeEnabled();await keyboardFocus(page);
    await expect(page.locator('#model')).toHaveAttribute('title','模型-'+ 'long-model-name-'.repeat(8));
    await fitsViewport(page,'.topbar, .controls, #model, #settings-state');
    await page.locator('#skills-button').click();await expect(page.locator('.skill-row')).toHaveCount(24);
    await fitsViewport(page,'#skills-dialog, .skill-row');
    await page.screenshot({path:`test-results/viewer-many-skills-${width}.png`,fullPage:true});
    await page.locator('.skill-row').last().getByRole('button',{name:'用于本轮',exact:true}).click();
    await page.locator('.skill-row').first().getByRole('button',{name:'用于本轮',exact:true}).click();
    await page.getByRole('button',{name:'关闭 Skills',exact:true}).click();
    await fitsViewport(page,'#composer, #selected-skills, .skill-chip');
    const chip=page.locator('.skill-chip').last();await chip.scrollIntoViewIfNeeded();
    expect(await chip.evaluate(el=>{const range=document.createRange();range.setStart(el.firstChild!,el.textContent!.length-1);range.setEnd(el.firstChild!,el.textContent!.length);const r=range.getBoundingClientRect();const b=el.getBoundingClientRect();return r.left>=b.left&&r.right<=b.right&&r.bottom<=b.bottom;})).toBe(true);
    await page.screenshot({path:`test-results/viewer-long-config-${width}.png`,fullPage:true});
    await chip.click();await expect(page.locator('.skill-chip')).toHaveCount(1);await page.locator('.skill-chip').click();
    await page.unroute('**/api/controls?*');
    await page.locator('#prompt').fill('long-stream');await page.locator('#send').click();
    const conversation=page.locator('#conversation');
    const bottomGap=()=>conversation.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop);
    await expect.poll(()=>conversation.evaluate(el=>el.scrollTop)).toBeGreaterThan(500);
    await expect.poll(bottomGap).toBeLessThan(3);
    const initialTop=await conversation.evaluate(el=>el.scrollTop);
    await expect.poll(()=>conversation.evaluate(el=>el.scrollTop)).toBeGreaterThan(initialTop+200);
    await expect.poll(bottomGap).toBeLessThan(3);
    await page.emulateMedia({reducedMotion:'reduce'});
    await expect(page.locator('#hint')).toHaveCSS('animation-name','none',{pseudo:'before'});
    await expect(conversation).toHaveCSS('scroll-behavior','auto');
    await conversation.hover();await page.mouse.wheel(0,-400);
    await expect(page.locator('#latest')).toBeVisible();
    const position=await conversation.evaluate(el=>el.scrollTop);const before=deltas;
    await expect.poll(()=>deltas).toBeGreaterThan(before+2);
    expect(Math.abs(await conversation.evaluate(el=>el.scrollTop)-position)).toBeLessThan(3);
    await page.locator('.assistant .markdown p').first().evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const selection=getSelection()!;selection.removeAllRanges();selection.addRange(range);});
    const selected=await page.evaluate(()=>getSelection()!.toString());
    const transcript=await page.locator('.assistant .markdown').innerText();const selectionStart=deltas;
    await expect.poll(()=>deltas).toBeGreaterThan(selectionStart+2);
    expect(await page.evaluate(()=>getSelection()!.toString())).toBe(selected);
    expect(await page.locator('.assistant .markdown').innerText()).toBe(transcript);
    await page.evaluate(()=>getSelection()!.removeAllRanges());
    await expect.poll(()=>page.locator('.assistant .markdown').innerText()).not.toBe(transcript);
    expect(Math.abs(await conversation.evaluate(el=>el.scrollTop)-position)).toBeLessThan(3);
    await page.locator('#latest').click();await expect.poll(bottomGap).toBeLessThan(3);
    await page.reload();await expect(page.locator('#stop')).toBeVisible();await expect.poll(bottomGap).toBeLessThan(3);
    await page.screenshot({path:`test-results/viewer-stream-${width}.png`,fullPage:true});
    await page.locator('#stop').click();await expect(page.locator('#send')).toBeEnabled();
    await fitsViewport(page,'#composer, .composer-actions, #conversation');
    await page.locator('#prompt').fill('preview');await page.locator('#send').click();await expect(page.locator('a[data-file]')).toBeVisible();
    await page.locator('a[data-file]').click();await expect(page.locator('.reference-card')).toContainText('target line');
    await fitsViewport(page,'.reference-card');
    await page.screenshot({path:`test-results/viewer-preview-${width}.png`,fullPage:true});
    await page.keyboard.press('Escape');
    await expect(page.locator('#send')).toBeEnabled();
    const threadId=await page.evaluate(()=>location.hash.slice(1));const turnId='output-stream';
    const emit=(method:string,params:Record<string,unknown>)=>adapter.emit('notice',{method,params:{threadId,turnId,...params}});
    emit('turn/started',{turn:{id:turnId,status:'inProgress',items:[]}});
    emit('item/started',{item:{id:'stream-command',type:'commandExecution',command:'printf "$VALUE"',aggregatedOutput:'\x1b[32mPASS\x1b[0m\n'+ 'line of output\n'.repeat(80)}});
    const tool=page.locator('.activity[data-kind="commandExecution"]').last();
    await expect(tool.locator('.activity-command')).toHaveText('printf "$VALUE"');
    await expect(tool.locator('.activity-output code')).toBeEmpty();
    emit('item/commandExecution/outputDelta',{itemId:'stream-command',delta:'\x1b[3'});
    await tool.locator('summary').click();
    const output=tool.locator('.activity-output');
    await expect(output.locator('code')).toContainText('PASS');
    expect(await output.locator('code').textContent()).not.toContain('\x1b');
    await output.evaluate(el=>el.scrollTop=180);
    emit('item/commandExecution/outputDelta',{itemId:'stream-command',delta:'1mERROR split sequence\x1b[0m\n'});
    await expect(output.locator('span').filter({hasText:'ERROR split sequence'})).toHaveCSS('color','rgb(220, 154, 139)');
    expect(await output.evaluate(el=>el.scrollTop)).toBe(180);
    await output.locator('span').first().evaluate(el=>el.setAttribute('data-reuse-check','yes'));
    emit('item/completed',{item:{id:'stream-command',type:'commandExecution',exitCode:0}});
    await expect(tool.locator('.activity-state')).toHaveText('已完成');
    await expect(output.locator('[data-reuse-check]')).toHaveCount(1);
    await page.screenshot({path:`test-results/viewer-output-stream-${width}.png`,fullPage:true});
  } finally {await app.stop();await rm(dir,{recursive:true,force:true});}
});
