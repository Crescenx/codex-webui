import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

async function keyboardFocus(page:Page) {
  await page.locator('#conversation').focus();
  for (const id of ['model','effort','mode','skills-button','goal-button','settings-toggle','prompt']) {
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

test('Chinese file links display, preview, copy and open native paths after Markdown rendering', async ({ page, context }) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-links-')), root = path.join(dir, 'project');
  await mkdir(path.join(root, '树洞'), { recursive: true });
  const relative = '树洞/中文 空格.md', literal = '树洞/记录%20.md';
  for (const file of [relative, literal]) await writeFile(path.join(root, file), '第一行\n目标行\n第三行');
  const opened: { path: string; line: number; column: number }[] = [];
  const revealed: typeof opened = [];
  const app = await serve({ roots: [root], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0,
    adapter: new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] }), opener: async (file,reveal) => { (reveal?revealed:opened).push(file); } });
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.origin });
    await page.goto(app.launchUrl);
    const { thread } = await (await page.request.post(app.origin + '/api/threads', { headers: { origin: app.origin }, data: { cwd: root } })).json();
    await page.goto(app.origin + '/#' + thread.id);
    const source = `[中文绝对](<${root}/${relative}:2:3>)\n\n[编码相对][ref]\n\n[百分号](<${encodeURI(literal)}:2>)\n\n[文件夹](<${root}/树洞>)\n\n[ref]: <${encodeURI(relative)}#L3>`;
    await expect(page.locator('#send')).toBeEnabled(); await page.locator('#prompt').fill('render-markdown\n' + source); await page.locator('#send').click();
    const links = page.locator('.assistant a[data-file]'); await expect(links).toHaveCount(4); await expect(page.locator('#send')).toBeEnabled();
    const cases = [
      { target: `${root}/${relative}:2:3`, path: path.join(root, relative), line: 2, column: 3 },
      { target: relative + '#L3', path: path.join(root, relative), line: 3, column: 1 },
      { target: literal + ':2', path: path.join(root, literal), line: 2, column: 1 },
    ];
    for (const [index, item] of cases.entries()) {
      const link = links.nth(index); await expect(link).toHaveAttribute('data-file', item.target);
      await expect(link).toContainText(' · ' + item.target.split('/').at(-1));
      await link.click(); const card = page.locator('.reference-card');
      await expect(card.locator('.target-line')).toHaveText(item.line === 2 ? '2  目标行' : '3  第三行');
      await expect(card.locator('code')).toHaveText(`${item.path}:${item.line}`);
      await card.getByRole('button', { name: '复制路径 / URL', exact: true }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(item.target);
      if (index === 0) await page.screenshot({ path: 'test-results/viewer-chinese-paths.png', fullPage: true });
      if (index === 0) {
        await page.route('**/api/files/open', route => route.fulfill({ status: 504, json: { error: '系统打开命令超时，窗口可能已经打开，请先检查桌面' } }));
        await card.getByRole('button', { name: '使用系统默认应用打开', exact: true }).click(); await expect(page.locator('#error')).toContainText('窗口可能已经打开');
        await page.unroute('**/api/files/open');
      }
      await card.getByRole('button', { name: '使用系统默认应用打开', exact: true }).click();
      await card.getByRole('button', { name: '在文件夹中显示', exact: true }).click();
      await expect.poll(()=>revealed.length).toBe(index+1);
      await expect(page.locator('#error')).toBeHidden();
      await expect.poll(() => opened.length).toBe(index + 1); await page.keyboard.press('Escape');
    }
    expect(opened).toEqual(cases.map(({ target, ...file }) => file));
    expect(revealed).toEqual(opened);
    await links.first().click({ modifiers: ['Control'] }); await expect.poll(() => opened.length).toBe(4);
    expect(opened[3]).toEqual(opened[0]);
    await links.nth(3).click();const folderCard=page.locator('.reference-card');
    await expect(folderCard.locator('pre')).toHaveText('文件夹，可使用系统默认应用打开。');
    await expect(folderCard.locator('code')).toHaveText(path.join(root,'树洞'));
    await folderCard.getByRole('button',{name:'使用系统默认应用打开',exact:true}).click();
    await expect.poll(()=>opened.length).toBe(5);expect(opened[4]).toEqual({path:path.join(root,'树洞'),line:1,column:1});
    await folderCard.getByRole('button',{name:'在文件夹中显示',exact:true}).click();
    await expect.poll(()=>revealed.length).toBe(4);expect(revealed[3]).toEqual(opened[4]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '复制 Markdown', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
    const selected = await links.first().evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      const data = new DataTransfer(); el.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData: data })); selection.removeAllRanges(); return data.getData('text/plain');
    });
    expect(selected).toBe(`[中文绝对](<${root}/${relative}:2:3>)`);
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('reasoning summaries group while streaming and expand after completion, reload and in a second tab', async ({ page, context }, testInfo) => {
  const dir = await mkdtemp('/tmp/viewer-reasoning-');
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 1920, height: 1080 }); await page.goto(app.launchUrl);
    await page.locator('#welcome-new').click(); await page.getByRole('button', { name: '▱ ' + dir, exact: true }).click(); await page.locator('#folder-select').click();
    await expect(page.locator('#send')).toBeEnabled(); await page.locator('#prompt').fill('reasoning-stream'); await page.locator('#send').click();
    const reasoning = page.locator('.activity[data-kind="reasoning"]');
    await expect(reasoning.locator('.activity-title')).toHaveText('思考中');
    await expect(reasoning.locator('.reasoning-summary')).toHaveText('Preparing parallel preflight');
    await expect(reasoning.locator('summary, pre')).toHaveCount(0);
    await expect(reasoning.locator('strong')).toHaveCSS('font-weight', '400');
    const second = await context.newPage(); await second.goto(page.url());
    const other = second.locator('.activity[data-kind="reasoning"]');
    await expect(other.locator('.reasoning-summary')).toHaveText('Preparing parallel preflight');
    const threadId = new URL(page.url()).hash.slice(1);
    const turnId = await reasoning.first().evaluate(el => el.closest<HTMLElement>('[data-turn-id]')!.dataset.turnId!);
    await adapter.call('mock/release', { threadId, turnId });
    for (const card of [reasoning, other]) {
      await expect(card).toHaveCount(2);
      await expect(card.locator('.activity-title')).toHaveText('思考中');
      await expect(card.locator('.reasoning-summary p')).toHaveText(['Preparing parallel preflight', 'Check literal *.py and 2 * 3.', 'Monitoring preflight validation', 'Cancelling read-only scan']);
    }
    const firstKey = await reasoning.first().evaluate(el => el.closest<HTMLElement>('[data-row-key]')!.dataset.rowKey);
    await adapter.call('mock/release', { threadId, turnId });
    for (const tab of [page, second]) {
      const toggle = tab.locator('.trace-toggle'); await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await toggle.click();
    }
    for (const card of [reasoning, other]) {
      await expect(card).toHaveCount(3); // The empty native reasoning item adds no extra label or summary.
      await expect(card.locator('.activity-title')).toHaveText('思考');
      await expect(card.locator('.activity-state')).toHaveCount(0);
      await expect(card.locator('.reasoning-summary').last()).toContainText('Keeping preflight serial');
      await expect(card.locator('summary, pre')).toHaveCount(0);
    }
    expect(await reasoning.first().evaluate(el => el.closest<HTMLElement>('[data-row-key]')!.dataset.rowKey)).toBe(firstKey);
    await expect(page.locator('#stop')).toBeHidden(); await page.reload();
    await expect(page.locator('#send')).toBeEnabled(); await page.locator('#conversation').evaluate(el => { el.scrollTop = 0; });
    await page.locator('.trace-toggle').click();
    await expect(reasoning.locator('.activity-title')).toHaveText('思考');
    await expect(reasoning.locator('.reasoning-summary p')).toHaveText(['Preparing parallel preflight', 'Check literal *.py and 2 * 3.', 'Monitoring preflight validation', 'Cancelling read-only scan', 'Keeping preflight serial']);
    await reasoning.locator('.reasoning-summary').first().evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el); getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    });
    await page.keyboard.press('Control+c');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Preparing parallel preflight\n\nCheck literal `*.py` and 2 * 3.\n\nMonitoring preflight validation');
    await page.evaluate(() => getSelection()!.removeAllRanges());
    await page.screenshot({ path: testInfo.outputPath('reasoning-summary-1920.png') });
    await second.close();
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('render, source copy, upload, approval and reconnect', async ({page,context}) => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'viewer-browser-')); const root=path.join(dir,'project'); await mkdir(root);
  await writeFile(path.join(root,'sample.py'),'first line\ntarget line\nthird line');
  const opened:string[]=[];
  const app = await serve({roots:[root],dataDir:path.join(dir,'data'),runtimeDir:path.join(dir,'run'),port:0,adapter:new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]}),opener:async f=>{opened.push(`${f.path}:${f.line}`);}});
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
    await page.locator('#skills-button').click();await page.getByRole('button',{name:'管理启停',exact:true}).click();await page.getByRole('button',{name:'全局：已启用',exact:true}).click();await page.getByRole('button',{name:'全部',exact:true}).click();await expect(page.getByRole('button',{name:'已禁用',exact:true})).toBeDisabled();await page.getByRole('button',{name:'管理启停',exact:true}).click();
    await page.getByRole('button',{name:'全局：已禁用',exact:true}).click();await page.getByRole('button',{name:'全部',exact:true}).click();await expect(page.getByRole('button',{name:'用于本轮',exact:true})).toBeEnabled();await page.getByRole('button',{name:'用于本轮',exact:true}).click();
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
    await page.setViewportSize({width:1920,height:844});
    await page.screenshot({path:'test-results/viewer-approval-widescreen.png',fullPage:true});
    for (const id of ['attach','stop','send']) {
      const action=page.locator('#'+id);
      await expect(action).toHaveCSS('white-space','nowrap');
      expect(await action.evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);return range.getClientRects().length;})).toBe(1);
    }
    await fitsViewport(page,'.composer-actions, #attach, #stop, #send');
    await page.setViewportSize({width:1280,height:720});
    await page.reload(); await expect(page.locator('.approval.windows')).toBeVisible();
    const firstId=new URL(page.url()).hash.slice(1);
    await page.locator('#new').click(); await page.getByRole('button',{name:'▱ '+root,exact:true}).click(); await page.locator('#folder-select').click();
    await expect(page.locator('#folder-dialog')).toBeHidden();
    await expect(page.locator('#send')).toBeEnabled(); await page.locator('#prompt').fill('second task'); await page.locator('#send').click();
    await expect(page.locator('.katex')).toBeVisible();
    await page.reload(); await expect(page.locator('.markdown table')).toBeVisible();
    await page.locator(`#threads .thread[data-thread-id="${firstId}"]`).click(); await expect(page.locator('.approval.windows')).toBeVisible();
    page.on('dialog',()=>{throw new Error('Unexpected confirmation dialog');}); await page.getByRole('button',{name:'允许本次 Windows 操作',exact:true}).click();
    await expect(page.locator('.katex')).toBeVisible(); await expect(page.locator('.markdown table')).toBeVisible();
    await expect(page.locator('#threads .project')).toHaveCount(1);
    await page.locator('.trace-toggle').first().click();
    await expect(page.locator('.activity[data-kind="reasoning"] .activity-title')).toHaveText('思考');
    await expect(page.locator('details.activity[data-kind="reasoning"]')).toHaveCount(0);
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
    await page.locator('.trace-toggle').first().click();
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
    await page.setViewportSize({width:1920,height:844});await page.screenshot({path:'test-results/viewer-widescreen.png',fullPage:true});
    await page.locator('.assistant').evaluate(el=>el.scrollIntoView({block:'start'}));
    await page.screenshot({path:'test-results/viewer-reading-widescreen-top.png',fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  } finally { await app.stop(); await rm(dir,{recursive:true,force:true}); }
});

test('bracket math streams, renders and copies its exact original source',async({page,context})=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-math-'));
  const app=await serve({roots:[dir],dataDir:path.join(dir,'data'),runtimeDir:path.join(dir,'run'),port:0,adapter:new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]})});
  try {
    await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:app.origin});
    await page.goto(app.launchUrl);await page.locator('#welcome-new').click();await page.getByRole('button',{name:'▱ '+dir,exact:true}).click();await page.locator('#folder-select').click();
    await expect(page.locator('#send')).toBeEnabled();await page.locator('#prompt').fill('bracket-math');await page.locator('#send').click();
    const body=page.locator('.assistant .markdown');
    await expect(body).toContainText('\\[');await expect(body.locator('.katex')).toHaveCount(0);
    await expect(body.locator('.katex')).toHaveCount(4);await expect(body.locator('.katex-display')).toHaveCount(2);
    await expect(body.locator('.katex-error')).toHaveCount(0);await expect(body.locator('pre code')).toHaveText('\\[这段代码不渲染\\]\n');
    await page.locator('.assistant').getByRole('button',{name:'复制 Markdown',exact:true}).click();
    const original=await page.evaluate(()=>navigator.clipboard.readText());
    expect(original).toContain('\\[\nx=F_C');expect(original).toContain('\\(x=\\frac{1}{2}\\)');
    const selected=await body.locator('.katex').first().evaluate(el=>{
      const range=document.createRange();range.selectNodeContents(el);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
      const data=new DataTransfer();el.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,clipboardData:data}));return data.getData('text/plain');
    });
    expect(selected).toBe(original.slice(0,original.indexOf('\\]')+2));
    const inline=await body.locator('.katex').nth(2).evaluate(el=>{
      const range=document.createRange();range.selectNodeContents(el);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
      const data=new DataTransfer();el.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,clipboardData:data}));return data.getData('text/plain');
    });
    expect(inline).toBe('\\(x=\\frac{1}{2}\\)');await page.evaluate(()=>window.getSelection()?.removeAllRanges());
    await page.setViewportSize({width:1440,height:1080});await body.evaluate(el=>el.scrollIntoView({block:'start'}));
    await page.screenshot({path:'test-results/viewer-bracket-math.png',fullPage:true});
    await page.setViewportSize({width:1920,height:844});await fitsViewport(page,'#conversation');
    await body.locator('.katex-display').nth(1).scrollIntoViewIfNeeded();
    await page.screenshot({path:'test-results/viewer-bracket-math-1920.png',fullPage:true});
    await page.reload();await expect(page.locator('.assistant .katex')).toHaveCount(4);
    const equation = '寻找第一对典型变量的问题是\n\\[\n\\max_{a,b}\\operatorname{Corr}(Xa,Yb)\n=\n\\frac{a^T(X^TY)b}{\\|Xa\\|_2\\,\\|Yb\\|_2}\n\\]\n后续正文。';
    await expect(page.locator('#send')).toBeEnabled();await page.locator('#prompt').fill('render-markdown\n'+equation);await page.locator('#send').click();
    const reply=page.locator('.assistant .markdown').last();
    await expect(reply.locator('.katex-display')).toHaveCount(1);
    await expect(reply.locator('h1, h2, .katex-error')).toHaveCount(0);
    await expect(reply.locator('p').first()).toHaveCSS('font-size','17px');
    await expect(reply.locator('p').first()).toHaveCSS('font-family', /Constantia.*serif/);
    await reply.scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/viewer-equation-heading-fix.png'});
  }finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('two concurrent conversations retain both user inputs across reordered events, switching and reload',async({page,context})=>{
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-concurrent-'));
  const adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')],env:{...process.env,VIEWER_FAKE_REORDER_TURNS:'1'}});
  const app=await serve({roots:[dir],dataDir:path.join(dir,'data'),runtimeDir:path.join(dir,'run'),port:0,adapter});
  try {
    await page.goto(app.launchUrl);const second=await context.newPage(); second.on('pageerror', e => errors.push(e.message)); await second.goto(app.origin);
    const pages=[page,second];const ids:string[]=[];
    const verifyInputs = async (p: Page, count: number) => {
      await p.bringToFront();
      await p.getByRole('button', { name: '查找对话', exact: true }).click();
      await p.getByRole('searchbox', { name: '查找当前对话' }).fill('并发实验');
      await expect(p.locator('.conversation-search [role="status"]')).toHaveText(`1 / ${count} 条`);
      const positions: number[] = [];
      for (let i = 0; i < count; i++) {
        await expect(p.locator('.message.search-hit')).toHaveText('你并发实验');
        positions.push(await p.locator('.message.search-hit').evaluate(el => Number(el.parentElement!.dataset.index)));
        if (i + 1 < count) await p.getByRole('button', { name: '下一条匹配' }).click();
      }
      expect(new Set(positions).size).toBe(count); expect(positions).toEqual([...positions].sort((a, b) => a - b));
      await p.getByRole('button', { name: '关闭查找' }).click();
    };
    for(const p of pages) {
      await p.locator('#welcome-new').click();await p.getByRole('button',{name:'▱ '+dir,exact:true}).click();await p.locator('#folder-select').click();
      await expect(p.locator('#send')).toBeEnabled();ids.push(new URL(p.url()).hash.slice(1));
    }
    for(let round=1;round<=2;round++) {
      for(const p of pages)await p.locator('#prompt').fill('并发实验');
      await Promise.all(pages.map(p=>p.locator('#send').click()));
      for(const p of pages) {
        await expect(p.locator('.message.user').last()).toHaveText('你并发实验');
        await expect(p.locator('#stop')).toBeHidden();
        await expect(p.locator('#send')).toBeEnabled();
        await verifyInputs(p, round);
        const snap=await p.evaluate(async(id)=>{const r=await fetch('/api/threads/'+id);return r.json();},new URL(p.url()).hash.slice(1));
        expect(snap.thread.turns.flatMap((t:{items:{type:string}[]})=>t.items).filter((i:{type:string})=>i.type==='userMessage')).toHaveLength(round);
        expect(snap.thread.turns.flatMap((t:{items:{type:string}[]})=>t.items).filter((i:{type:string})=>['userMessage','agentMessage'].includes(i.type)).map((i:{type:string})=>i.type)).toEqual(Array.from({length:round},()=>['userMessage','agentMessage']).flat());
        if (await p.locator('#latest').isVisible()) await p.locator('#latest').click();
      }
    }
    // Select the other conversation without a page reload, then recover from a full reload.
    await page.locator('#threads .thread:not(.selected)').click();await expect(page).toHaveURL(app.origin+'/#'+ids[1]);
    await verifyInputs(page, 2);
    // Reproduce an already-damaged in-memory cache without altering persisted history.
    const broken=structuredClone((await adapter.call('thread/read',{threadId:ids[1],includeTurns:true})).thread) as {id:string;turns:{items:{type:string}[]}[]};
    broken.turns.at(-1)!.items=broken.turns.at(-1)!.items.filter(i=>i.type!=='userMessage');
    adapter.emit('notice',{method:'thread/started',params:{thread:broken}});
    const before=await page.evaluate(async(id)=>(await (await fetch('/api/threads/'+id)).json()).thread,ids[1]);
    expect(before.turns.flatMap((t:{items:{type:string}[]})=>t.items).filter((i:{type:string})=>i.type==='userMessage')).toHaveLength(1);
    await page.reload();await verifyInputs(page, 2);
    await expect(page.locator('.message.user').last()).toHaveText('你并发实验');
    await page.locator('.message.user').last().scrollIntoViewIfNeeded();
    await page.screenshot({path:'test-results/viewer-concurrent-messages.png',fullPage:true});
    await second.close(); expect(errors).toEqual([]);
  } catch (error) { console.log({ errors, state: await page.evaluate(() => ({ ready: document.readyState, focus: document.hasFocus(), visibility: document.visibilityState, error: document.querySelector('#error')?.textContent, tools: document.querySelector('.conversation-tools')?.getBoundingClientRect().toJSON() })) }); throw error; }
  finally{await app.stop();await rm(dir,{recursive:true,force:true});}
});

test('automatic titles, manual rename, cross-tab events and external refresh',async({page,context})=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-title-ui-'));
  const adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const call=adapter.call.bind(adapter);let externalName:string|undefined;let failNaming=false;
  let releaseName:()=>void=()=>{};let delayed=true;
  adapter.call=async(method,params={})=>{
    if(method==='thread/name/set') {
      if(failNaming)throw new Error('模拟命名失败');
      if(delayed){delayed=false;await new Promise<void>(resolve=>{releaseName=resolve;});}
    }
    const result=await call(method,params);
    if(externalName!==undefined){
      if(method==='thread/read')(result.thread as {name:string}).name=externalName;
      if(method==='thread/list')for(const t of result.data as {name:string}[])t.name=externalName;
    }
    return result;
  };
  const app=await serve({roots:[dir],dataDir:path.join(dir,'data'),runtimeDir:path.join(dir,'run'),port:0,adapter});
  try{
    await page.goto(app.launchUrl);await expect(page.locator('#rename')).toBeHidden();
    await page.locator('#welcome-new').click();await page.getByRole('button',{name:'▱ '+dir,exact:true}).click();await page.locator('#folder-select').click();
    await expect(page.locator('#send')).toBeEnabled();await expect(page.locator('#title')).toHaveText('新任务');
    await page.locator('#prompt').fill('# 自动命名演示\n详细任务内容');await page.locator('#send').click();
    await expect(page.locator('#title')).toHaveText('自动命名演示');
    await expect(page.locator('#threads strong')).toHaveText('自动命名演示');
    await expect.poll(()=>delayed).toBe(false);releaseName();
    await expect(page.locator('#title')).toHaveText('概括任务目的');
    await expect(page.locator('#threads strong')).toHaveText('概括任务目的');
    await expect(page.locator('#send')).toBeEnabled();
    await page.reload();await expect(page.locator('#title')).toHaveText('概括任务目的');
    await page.locator('#rename').click();await expect(page.locator('#thread-name')).toBeFocused();
    await page.locator('#thread-name').fill('');await page.locator('#name-save').click();await expect(page.locator('#name-dialog')).toBeVisible();
    await page.locator('#thread-name').fill('自定义标题');failNaming=true;
    await page.locator('#name-save').click();await expect(page.locator('#name-error')).toContainText('模拟命名失败');
    await expect(page.locator('#title')).toHaveText('概括任务目的');failNaming=false;
    await page.locator('#name-save').click();await expect(page.locator('#name-dialog')).not.toBeVisible();
    await expect(page.locator('#title')).toHaveText('自定义标题');
    const second=await context.newPage();await second.goto(page.url());await expect(second.locator('#title')).toHaveText('自定义标题');
    await page.locator('#rename').click();await page.locator('#thread-name').fill('跨页同步标题');await page.locator('#name-save').click();
    await expect(second.locator('#title')).toHaveText('跨页同步标题');await expect(second.locator('#threads strong')).toHaveText('跨页同步标题');
    externalName='来自 CLI 的标题';
    await page.locator('.sidebar-more').evaluate(el => el.setAttribute('open', ''));await page.locator('#refresh').click();await expect(page.locator('#title')).toHaveText(externalName);await expect(page.locator('#threads strong')).toHaveText(externalName);
    await expect(page.locator('.katex')).toBeVisible();
    await page.reload();await expect(page.locator('#title')).toHaveText(externalName);
    await page.setViewportSize({width:1920,height:844});await page.locator('#rename').click();
    await fitsViewport(page,'.topbar, #rename, #name-dialog, #thread-name, #name-save');
    await page.screenshot({path:'test-results/viewer-rename-1920.png',fullPage:true});
    await page.keyboard.press('Escape');await expect(page.locator('#name-dialog')).not.toBeVisible();await expect(page.locator('#rename')).toBeFocused();
    await second.close();
  }finally{releaseName();await app.stop();await rm(dir,{recursive:true,force:true});}
});

for (const width of [1280,1920]) test(`long content, streaming and manual reading at ${width}px`, async ({page})=>{
  await page.setViewportSize({width,height:width===1920?844:720});
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-reading-'));
  const root=path.join(dir,'项目目录-'+ 'long-project-path-'.repeat(5));await mkdir(root);
  await writeFile(path.join(root,'sample.py'),'first line\ntarget line\nthird line');
  const adapter=new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  let deltas=0;adapter.on('notice',n=>{if(n.method==='item/agentMessage/delta')deltas++;});
  const app=await serve({roots:[root],dataDir:path.join(dir,'data'),runtimeDir:path.join(dir,'run'),port:0,adapter,opener:async()=>{throw new Error('Editor must not open');}});
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
    await fitsViewport(page,'.topbar, .controls, #model');
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
