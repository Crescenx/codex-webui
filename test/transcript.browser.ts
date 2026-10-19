import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';
import type { Thread } from '../shared/protocol.ts';

function history(thread: Thread, size: number): Thread {
  return { ...thread, turns: Array.from({ length: size }, (_, i) => ({ id: `turn-${i}`, status: 'completed', items: [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: `检查第 ${i} 轮结果。` }] },
    { id: 'command', type: 'commandExecution', command: 'python check.py', status: 'completed', exitCode: 0, aggregatedOutput: `output-needle-${i}\n${'日志内容 '.repeat(140)}` },
    { id: 'answer', type: 'agentMessage', text: `## 第 ${i} 轮\n\n` + ('检查状态变化，保留原始结果。公式 $x^2+\\frac{1}{2}$，以及 $y=2x$。\n\n').repeat(4) + '\n```python\nresult = 123\nprint(result)\n```\n\n| 检查 | 结果 |\n| --- | --- |\n| 渲染 | 通过 |\n\n' + `${thread.id} / end ${i}` },
  ] })) };
}
async function fixture(page: Page, size = 200) {
  const dir = await mkdtemp('/tmp/transcript-browser-'), adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter, staticDir: process.env.VIEWER_BENCH_STATIC });
  await page.setViewportSize({ width: 1920, height: 1080 }); await page.goto(app.launchUrl);
  const threads: Thread[] = [];
  for (let i = 0; i < 2; i++) {
    const { thread } = await (await page.request.post(app.origin + '/api/threads', { data: { cwd: dir }, headers: { Origin: app.origin } })).json(); threads.push(history(thread, size));
  }
  let delay = 0, fail = false;
  await page.route('**/api/threads/*/open', async route => {
    const id = route.request().url().split('/').at(-2), thread = threads.find(t => t.id === id);
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    await route.fulfill({ status: fail ? 502 : 200, json: fail ? { error: '模拟历史读取失败' } : { thread, requests: [], seq: 0 } }).catch(() => {});
  });
  await page.reload(); await expect(page.locator('.thread')).toHaveCount(2);
  return { app, adapter, threads, delay: (ms: number) => { delay = ms; }, fail: (value: boolean) => { fail = value; }, stop: async () => { await app.stop(); await rm(dir, { recursive: true, force: true }); } };
}
async function switchTo(page: Page, id: string, size: number) {
  return page.evaluate(({ id, size }) => new Promise<number>((resolve, reject) => {
    const start = performance.now(); (document.querySelector(`[data-thread-id="${id}"]`) as HTMLButtonElement).click();
    function check() {
      const el = [...document.querySelectorAll('#conversation .markdown')].find(el => el.textContent?.includes(`${id} / end ${size - 1}`));
      const root = document.querySelector('#conversation');
      if (el && root && el.getBoundingClientRect().bottom <= root.getBoundingClientRect().bottom + 2 && el.getBoundingClientRect().bottom > root.getBoundingClientRect().top) requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
      else if (performance.now() - start > 30000) reject(new Error('latest message did not appear: ' + id));
      else requestAnimationFrame(check);
    } check();
  }), { id, size });
}
const anchor = (page: Page) => page.locator('#conversation').evaluate(el => {
  const top = el.getBoundingClientRect().top, row = [...el.querySelectorAll<HTMLElement>('[data-row-key]')].find(row => row.getBoundingClientRect().bottom > top);
  return { key: row?.dataset.rowKey, inset: top - (row?.getBoundingClientRect().top || 0) };
});

test('folding a long active trace leaves no empty height between messages', async ({page},testInfo)=>{
  const h=await fixture(page,1),a=h.threads[0]!;
  const turn={id:'long-trace',status:'inProgress',items:[
    {id:'user',type:'userMessage',content:[{type:'text',text:'检查编译结果。'}]},
    ...Array.from({length:34},(_,i)=>({id:`cmd-${i}`,type:'commandExecution',command:`check ${i}`,status:'completed',aggregatedOutput:'done',exitCode:0})),
  ]};
  a.turns=[turn];
  const notice=(method:string,params:Record<string,unknown>)=>h.adapter.emit('notice',{method,params:{threadId:a.id,turnId:turn.id,...params}});
  try {
    await page.locator(`[data-thread-id="${a.id}"]`).click();
    await expect(page.locator('#conversation')).toContainText('check 33');
    notice('item/started',{item:{id:'reply',type:'agentMessage',text:''}});
    notice('item/agentMessage/delta',{itemId:'reply',delta:'编译完成。'});
    await expect(page.locator('#conversation .trace-toggle')).toHaveAttribute('aria-expanded','false');
    const gaps=()=>page.locator('#conversation').evaluate(el=>{
      const rows=[...el.querySelectorAll<HTMLElement>('.virtual-row')].sort((a,b)=>Number(a.dataset.index)-Number(b.dataset.index));
      return rows.map((r,i)=>i?r.getBoundingClientRect().top-rows[i-1]!.getBoundingClientRect().bottom:0);
    });
    await expect.poll(async()=>Math.max(...await gaps())).toBeLessThan(3);
    await expect.poll(()=>page.locator('#conversation').evaluate(el=>el.scrollHeight-el.clientHeight)).toBeLessThan(2);
    await page.screenshot({path:testInfo.outputPath('folded-long-trace.png')});
  } finally {await h.stop();}
});

test('switching back after an offscreen trace folds restores contiguous row positions',async({page},testInfo)=>{
  const h=await fixture(page,1),a=h.threads[0]!,b=h.threads[1]!;
  a.turns=[{id:'offscreen-trace',status:'inProgress',items:[
    {id:'user',type:'userMessage',content:[{type:'text',text:'检查编译结果。'}]},
    ...Array.from({length:34},(_,i)=>({id:`cmd-${i}`,type:'commandExecution',command:`check ${i}`,status:'completed',aggregatedOutput:'done',exitCode:0})),
  ]}];
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    await page.locator(`[data-thread-id="${a.id}"]`).click();
    await expect(page.locator('#conversation')).toContainText('check 33');
    await switchTo(page,b.id,1);
    a.turns[0]!.items.push({id:'reply',type:'agentMessage',text:'后台检查结束。'});a.turns[0]!.status='completed';
    await page.locator(`[data-thread-id="${a.id}"]`).click();
    await expect(page.locator('#conversation')).toContainText('后台检查结束。');
    const positions=()=>page.locator('#conversation').evaluate(el=>{
      const rows=[...el.querySelectorAll<HTMLElement>('.virtual-row')].sort((a,b)=>Number(a.dataset.index)-Number(b.dataset.index));
      return {gap:Math.max(...rows.map((r,i)=>i?r.getBoundingClientRect().top-rows[i-1]!.getBoundingClientRect().bottom:0)),excess:el.scrollHeight-el.clientHeight};
    });
    await expect.poll(async()=>(await positions()).gap).toBeLessThan(3);
    await expect.poll(async()=>(await positions()).excess).toBeLessThan(2);
    expect(errors).toEqual([]);
    await page.screenshot({path:testInfo.outputPath('restored-folded-trace.png')});
  }finally{await h.stop();}
});

test('opening compact history measures rows above the initially estimated viewport',async({page},testInfo)=>{
  const h=await fixture(page,1),a=h.threads[0]!;
  await page.setViewportSize({width:1820,height:1100});
  a.turns=[{id:'prior',status:'completed',items:[
    {id:'user',type:'userMessage',content:[{type:'text',text:'生成课程讲义。'.repeat(20)}]},
    ...Array.from({length:34},(_,i)=>({id:`cmd-${i}`,type:'commandExecution',command:`check ${i}`,status:'completed',aggregatedOutput:'done',exitCode:0})),
    {id:'reply',type:'agentMessage',text:'正在后台编译讲义。'},
    {id:'cmd-last',type:'commandExecution',command:'compile',status:'completed',exitCode:0},
    {id:'reply-last',type:'agentMessage',text:'重新启动编译，等待完成。'},
  ]},{id:'current',status:'inProgress',items:[
    {id:'user',type:'userMessage',content:[{type:'text',text:'好了没'}]},
    {id:'read',type:'dynamicToolCall',tool:'view_file',status:'completed',success:true,arguments:{filePath:'/tmp/doc.tex'},contentItems:[]},
  ]}];
  try {
    await page.locator(`[data-thread-id="${a.id}"]`).click();
    await expect(page.locator('#conversation')).toContainText('view_file');
    const firstVisibleGap=()=>page.locator('#conversation').evaluate(el=>{
      const top=el.getBoundingClientRect().top;
      const boxes=[...el.querySelectorAll('.virtual-row')].map(r=>r.getBoundingClientRect()).filter(r=>r.bottom>top);
      return Math.min(...boxes.map(r=>r.top))-top;
    });
    await expect.poll(firstVisibleGap).toBeLessThan(50);
    await switchTo(page,h.threads[1]!.id,1);
    await page.locator(`[data-thread-id="${a.id}"]`).click();
    await expect(page.locator('#conversation')).toContainText('view_file');
    await expect.poll(firstVisibleGap).toBeLessThan(50);
    await page.reload();
    await page.locator(`[data-thread-id="${a.id}"]`).click();
    await expect(page.locator('#conversation')).toContainText('view_file');
    await expect.poll(firstVisibleGap).toBeLessThan(50);
    await page.screenshot({path:testInfo.outputPath('compact-history.png')});
  }finally{await h.stop();}
});

test('trace opens while working, folds on reply, and keeps manual expansion across thread switches', async ({ page }, testInfo) => {
  const h = await fixture(page, 1), a = h.threads[0]!, b = h.threads[1]!;
  const turn = { id: 'live-trace', status: 'inProgress', items: [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: '检查运行结果，并整理结论。' }] },
    { id: 'intro', type: 'agentMessage', text: '我先核对运行记录和结果文件。' },
    { id: 'r1', type: 'reasoning', summary: ['核对输入与运行参数。'] },
    { id: 'cmd', type: 'commandExecution', command: 'python check.py', status: 'completed', aggregatedOutput: 'trace-output-needle: verified' },
    { id: 'r2', type: 'reasoning', summary: ['检查结果是否完整。'] },
    { id: 'mcp', type: 'mcpToolCall', server: 'viewer_watchdogs', tool: 'watchdog_list', status: 'completed', result: { data: [] } },
  ] };
  a.turns = [turn];
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const notice = (method: string, params: Record<string, unknown>) => h.adapter.emit('notice', { method, params: { threadId: a.id, turnId: turn.id, ...params } });
  try {
    await page.locator(`[data-thread-id="${a.id}"]`).click();
    const toggle = page.locator('#conversation .trace-toggle').first();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true'); await expect(toggle).toContainText('4 条 · 进行中');
    await expect(page.locator('#conversation .reasoning-summary')).toHaveCount(2);
    await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#conversation .activity')).toHaveCount(0);
    await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.screenshot({ path: testInfo.outputPath('trace-active-1920.png') });
    notice('item/started', { item: { id: 'reply', type: 'agentMessage', text: '' } });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    notice('item/agentMessage/delta', { itemId: 'reply', delta: '检查已完成，结果文件与运行记录一致。' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#conversation .activity')).toHaveCount(0);
    await expect(page.locator('#conversation')).toContainText('检查已完成');
    await page.screenshot({ path: testInfo.outputPath('trace-collapsed-1920.png') });
    await toggle.focus(); await page.keyboard.press('Enter'); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    turn.items.push({ id: 'reply', type: 'agentMessage', text: '检查已完成，结果文件与运行记录一致。' });
    await switchTo(page, b.id, 1); await page.locator(`[data-thread-id="${a.id}"]`).click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await page.getByRole('button', { name: '查找对话', exact: true }).click();
    await page.getByRole('searchbox', { name: '查找当前对话' }).fill('trace-output-needle');
    await expect(page.locator('#conversation .search-hit .activity-output')).toBeInViewport();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: '关闭查找' }).click();
    notice('item/started', { item: { id: 'after-reply', type: 'contextCompaction' } });
    const next = page.locator('#conversation .trace-toggle').last();
    await expect(page.locator('#conversation .trace-toggle')).toHaveCount(2);
    await expect(next).toHaveAttribute('aria-expanded', 'true');
    notice('turn/completed', { turn: { id: turn.id, status: 'completed', items: [] } });
    await expect(next).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    notice('turn/started', { turn: { id: 'large-trace', status: 'inProgress', items: Array.from({ length: 300 }, (_, i) => ({ id: `step-${i}`, type: 'commandExecution', command: `check step-${i}`, status: 'completed' })) } });
    await page.locator('#latest').click();
    await expect(page.locator('#conversation')).toContainText('check step-299');
    expect(await page.locator('#conversation .message').count()).toBeLessThan(25);
    notice('item/agentMessage/delta', { turnId: 'large-trace', itemId: 'result', delta: '300 项检查已完成。' });
    await expect(page.locator('#conversation .markdown').filter({ hasText: '300 项检查已完成。' })).toBeInViewport();
    await expect(page.locator('.trace-toggle[data-turn-id="large-trace"]')).toHaveAttribute('aria-expanded', 'false');
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('reasoning groups keep native search anchors, reading position and selection in main and subagent history', async ({ page, context }, testInfo) => {
  const h = await fixture(page), [a, b] = h.threads;
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const thought = (id: string, text: string) => ({ id, type: 'reasoning', status: 'completed', summary: [`**${text}**`] });
  a!.turns![50]!.items.splice(1, 0, thought('r1', 'Preparing parallel preflight'), thought('r2', 'reasoning-needle: Monitoring preflight validation'));
  a!.turns![50]!.items.splice(4, 0, thought('r3', 'Keeping preflight serial'));
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await switchTo(page, a!.id, 200); await expect(page.locator('#send')).toBeEnabled();
    expect(await page.locator('#conversation .message').count()).toBeLessThan(25);
    await page.getByRole('button', { name: '查找对话', exact: true }).click();
    await page.getByRole('searchbox', { name: '查找当前对话' }).fill('reasoning-needle');
    await expect(page.locator('.conversation-search [role="status"]')).toHaveText('1 / 1 条');
    await expect(page.locator('#conversation .search-hit .reasoning-summary')).toBeInViewport();
    await expect(page.locator('#conversation .search-hit .activity-title')).toHaveCount(0);
    await expect(page.locator('#conversation [data-turn-id="turn-50"] .reasoning .activity-title')).toHaveText(['思考', '思考']);
    await page.getByRole('button', { name: '关闭查找' }).click();
    const before = await anchor(page);
    await switchTo(page, b!.id, 200); await expect(page.locator('#send')).toBeEnabled();
    await page.locator(`[data-thread-id="${a!.id}"]`).click(); await expect(page.locator('#send')).toBeEnabled();
    await expect.poll(async () => (await anchor(page)).key).toBe(before.key);
    expect(Math.abs((await anchor(page)).inset - before.inset)).toBeLessThan(4);
    const summary = page.locator('#conversation .reasoning-summary').filter({ hasText: 'reasoning-needle' });
    await summary.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); getSelection()!.removeAllRanges(); getSelection()!.addRange(r); });
    await page.keyboard.press('Control+c'); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('reasoning-needle: Monitoring preflight validation');
    await page.locator('#conversation').evaluate(el => { el.scrollTop = 0; });
    await expect.poll(() => page.evaluate(() => getSelection()!.toString())).toBe('reasoning-needle: Monitoring preflight validation');
    await page.evaluate(() => getSelection()!.removeAllRanges());
    const { thread } = await h.adapter.call('mock/agent', { threadId: a!.id, id: 'reasoning-child', name: '摘要子代理' });
    const child = history(thread as Thread, 200);
    child.turns![150]!.items.splice(1, 0, thought('r1', 'child-reasoning: Preparing parallel preflight'), thought('r2', 'child-reasoning: Monitoring preflight validation'));
    await page.route('**/api/threads/reasoning-child?refresh=1', route => route.fulfill({ json: { thread: child, requests: [], seq: 0 } }));
    await page.getByRole('button', { name: '展开 Subagents', exact: true }).click(); await page.locator('[data-agent-id="reasoning-child"]').click();
    await expect(page.locator('#agent-conversation')).toContainText('reasoning-child / end 199');
    await page.locator('#agent-conversation').focus(); await page.keyboard.press('Control+f');
    const search = page.locator('.agent-detail [role="search"]');
    await search.getByRole('searchbox').fill('child-reasoning');
    await expect(search.locator('[role="status"]')).toHaveText('1 / 2 条');
    await expect(page.locator('#agent-conversation .search-hit .reasoning-summary')).toBeInViewport();
    await search.getByRole('button', { name: '下一条匹配' }).click();
    await expect(search.locator('[role="status"]')).toHaveText('2 / 2 条');
    await expect(page.locator('#agent-conversation .search-hit .reasoning-summary')).toBeInViewport();
    await expect(page.locator('#agent-conversation .search-hit .activity-title')).toHaveCount(0);
    await expect(page.locator('#agent-conversation .reasoning .activity-title')).toHaveText('思考');
    await page.screenshot({ path: testInfo.outputPath('reasoning-subagent-1920.png') });
    expect(errors).toEqual([]);
  } finally { await h.stop(); }
});

test('scrolling up after returning to latest stays under user control', async ({ page }) => {
  const h = await fixture(page, 1000);
  try {
    await switchTo(page, h.threads[0]!.id, 1000);
    const conversation = page.locator('#conversation');
    const gap = () => conversation.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
    for (let i = 0; i < 3; i++) {
      await conversation.hover();
      await page.mouse.wheel(0, -40);
      await expect.poll(gap).toBeGreaterThan(20);
      // An upward wheel must remain effective even within the former 100px follow threshold.
      await page.waitForTimeout(250);
      expect(await gap()).toBeGreaterThan(20);
      await expect(page.locator('#latest')).toBeVisible();
      await page.mouse.wheel(0, 20);
      await expect.poll(gap).toBeLessThan(30);
      await expect(page.locator('#latest')).toBeVisible();
      await page.locator('#latest').click();
      await expect.poll(gap).toBeLessThan(3);
    }
    await conversation.hover(); await page.mouse.wheel(0, -40);
    await expect.poll(gap).toBeGreaterThan(20);
    await page.mouse.wheel(0, 40);
    await expect(page.locator('#latest')).toBeHidden();
    expect(await gap()).toBeLessThan(1);
  } finally { await h.stop(); }
});

test('long history keeps reading position, expanded output, selection, search and cached errors', async ({ page, context }) => {
  const h = await fixture(page), [a, b] = h.threads;
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await switchTo(page, a!.id, 200); await expect(page.locator('#send')).toBeEnabled();
    expect(await page.locator('#conversation .message').count()).toBeLessThan(25);
    await page.getByRole('button', { name: '查找对话', exact: true }).click();
    await page.getByRole('searchbox', { name: '查找当前对话' }).fill('output-needle-50');
    await expect(page.locator('.conversation-search [role="status"]')).toHaveText('1 / 1 条');
    const output = page.locator('#conversation .activity[open] .activity-output code');
    await expect(output).toContainText('output-needle-50');
    await page.getByRole('button', { name: '关闭查找' }).click();
    await expect(page.locator('#latest')).toBeVisible();
    const before = await anchor(page);
    await switchTo(page, b!.id, 200); await expect(page.locator('#send')).toBeEnabled();
    h.delay(500);
    await page.locator(`[data-thread-id="${a!.id}"]`).click();
    await expect(output).toContainText('output-needle-50'); await expect(page.locator('#send')).toBeDisabled();
    await expect(page.locator('#send')).toBeEnabled();
    const after = await anchor(page); expect(after.key).toBe(before.key); expect(Math.abs(after.inset - before.inset)).toBeLessThan(4);
    await page.setViewportSize({ width: 2560, height: 1080 });
    await expect.poll(async () => (await anchor(page)).key).toBe(before.key);
    // Selection pins its row when a programmatic scroll moves outside the viewport.
    await output.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); });
    const selected = await page.evaluate(() => getSelection()!.toString());
    await page.locator('#conversation').evaluate(el => { el.scrollTop = 0; });
    await expect.poll(() => page.evaluate(() => getSelection()!.toString())).toBe(selected);
    await page.evaluate(() => getSelection()!.removeAllRanges());
    await page.locator('#conversation').focus(); await page.keyboard.press('Control+f');
    await expect(page.getByRole('searchbox', { name: '查找当前对话' })).toBeFocused();
    await page.getByRole('searchbox', { name: '查找当前对话' }).fill('end 5');
    await expect(page.locator('.conversation-search [role="status"]')).toHaveText('1 / 11 条');
    await page.keyboard.press('Enter'); await expect(page.locator('.conversation-search [role="status"]')).toHaveText('2 / 11 条');
    await page.keyboard.press('Shift+Enter'); await expect(page.locator('.conversation-search [role="status"]')).toHaveText('1 / 11 条');
    const answer = page.locator('#conversation .search-hit'); await answer.getByRole('button', { name: '复制 Markdown', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('$x^2+\\frac{1}{2}$');
    await page.getByRole('button', { name: '关闭查找' }).click(); await page.locator('#latest').click();
    await expect(page.locator('#conversation')).toContainText(`${a!.id} / end 199`);
    await switchTo(page, b!.id, 200); await expect(page.locator('#send')).toBeEnabled(); h.fail(true);
    await page.locator(`[data-thread-id="${a!.id}"]`).click(); await expect(page.getByRole('button', { name: '重新读取对话' })).toBeVisible();
    await expect(page.locator('#conversation')).toContainText(`${a!.id} / end 199`); await expect(page.locator('#send')).toBeDisabled();
    h.fail(false); h.delay(0); await page.getByRole('button', { name: '重新读取对话' }).click(); await expect(page.locator('#send')).toBeEnabled();
    await page.screenshot({ path: 'test-results/transcript-cached-2560.png' }); expect(errors).toEqual([]);
  } catch (error) {
    console.log(await page.locator('#conversation').evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, rows: [...el.querySelectorAll<HTMLElement>('[data-row-key]')].map(row => ({ key: row.dataset.rowKey, top: row.getBoundingClientRect().top, open: row.querySelector('details')?.open, text: row.textContent?.slice(0, 90) })) })));
    throw error;
  } finally { await h.stop(); }
});

test('production switching benchmark: 100, 200 and 1000 turns, twenty warm switches each', async ({ page }, testInfo) => {
  test.setTimeout(process.env.VIEWER_BENCH_STATIC ? 600000 : 180000);
  const results: object[] = [];
  for (const size of [100, 200, 1000]) {
    const h = await fixture(page, size), cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Performance.enable');
      const cold = await switchTo(page, h.threads[0]!.id, size); await expect(page.locator('#send')).toBeEnabled();
      await switchTo(page, h.threads[1]!.id, size); await expect(page.locator('#send')).toBeEnabled();
      await page.evaluate(() => {
        const durations: number[] = []; (window as unknown as { longTasks: number[] }).longTasks = durations;
        new PerformanceObserver(list => { durations.push(...list.getEntries().map(e => e.duration)); }).observe({ type: 'longtask' });
      });
      const samples: number[] = [], layouts: number[] = []; let mounted = 0, nodes = 0;
      const layout = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'LayoutDuration')!.value;
      for (let i = 0; i < 20; i++) {
        const before = await layout(); samples.push(await switchTo(page, h.threads[i % 2]!.id, size)); layouts.push(1000 * (await layout() - before));
        mounted = Math.max(mounted, await page.locator('#conversation .message').count()); nodes = Math.max(nodes, await page.locator('#conversation *').count());
        await expect(page.locator('#send')).toBeEnabled();
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const longTasks = await page.evaluate(() => (window as unknown as { longTasks: number[] }).longTasks);
      const result = { turns: size, coldMs: cold, medianMs: sorted[9], p95Ms: sorted[18], mounted, nodes, layoutMedianMs: [...layouts].sort((a,b) => a-b)[9], longTaskCount: longTasks.length, longestTaskMs: Math.max(0, ...longTasks), samples };
      results.push(result); console.log(JSON.stringify(result));
      await writeFile(testInfo.outputPath('switching-performance.json'), JSON.stringify(results, null, 2));
      if (!process.env.VIEWER_BENCH_STATIC) { expect(mounted).toBeLessThan(25); expect(result.p95Ms).toBeLessThan(size === 1000 ? 150 : 100); }
    } finally { await cdp.detach(); await h.stop(); }
  }
});

test('long subagent has independent search and scrolling, pins diff dialogs and restores expanded files', async ({ page }) => {
  const h = await fixture(page), parent = h.threads[0]!;
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await switchTo(page, parent.id, 200); await expect(page.locator('#send')).toBeEnabled();
    await page.getByRole('button', { name: '查找对话', exact: true }).click();
    await page.getByRole('searchbox', { name: '查找当前对话' }).fill(parent.id + ' / end 50');
    await expect(page.locator('#conversation .search-hit')).toBeVisible();
    await page.getByRole('button', { name: '关闭查找' }).click();
    const parentAnchor = await anchor(page);
    const { thread } = await h.adapter.call('mock/agent', { threadId: parent.id, id: 'long-child', name: '长记录子代理' });
    const child = history(thread as Thread, 1000);
    child.turns![50]!.items[1] = { id: 'files', type: 'fileChange', status: 'completed', changes: [{ path: parent.cwd + '/child.ts', kind: { type: 'add' }, diff: 'const CHILD_DIFF_NEEDLE = 42;\n' }] };
    await page.route('**/api/threads/long-child?refresh=1', route => route.fulfill({ json: { thread: child, requests: [], seq: 0 } }));
    await page.getByRole('button', { name: '展开 Subagents', exact: true }).click(); await page.locator('[data-agent-id="long-child"]').click();
    await expect(page.locator('#agent-conversation')).toContainText('long-child / end 999');
    await expect.poll(async () => (await anchor(page)).key).toBe(parentAnchor.key);
    expect(await page.locator('#agent-conversation .message').count()).toBeLessThan(25);
    await page.locator('#agent-conversation').focus(); await page.keyboard.press('Control+f');
    const search = page.locator('.agent-detail [role="search"]');
    await expect(search.getByRole('searchbox')).toBeFocused(); await expect(page.locator('main > [role="search"]')).toHaveCount(0);
    await search.getByRole('searchbox').fill('child_diff_needle');
    await expect(search.locator('[role="status"]')).toHaveText('1 / 1 条');
    const card = page.locator('#agent-conversation .file-change'); await expect(card.locator('.diff-code')).toContainText('CHILD_DIFF_NEEDLE');
    await search.getByRole('button', { name: '关闭查找' }).click();
    await card.getByRole('button', { name: /放大查看/ }).click();
    const modal = page.getByRole('dialog', { name: '查看文件变更' }); await expect(modal).toBeVisible();
    await page.locator('#agent-conversation').evaluate(el => { el.scrollTop = 0; });
    await expect(modal).toBeVisible(); await expect(modal.locator('.diff-code')).toContainText('CHILD_DIFF_NEEDLE');
    await page.keyboard.press('Control+f'); await expect(search).toHaveCount(0);
    await page.keyboard.press('Escape'); await expect(card.getByRole('button', { name: /放大查看/ })).toBeFocused();
    await page.getByRole('button', { name: '关闭子代理详情' }).click(); await page.locator('[data-agent-id="long-child"]').click();
    await page.locator('#agent-conversation').focus(); await page.keyboard.press('Control+f'); await search.getByRole('searchbox').fill('child_diff_needle');
    await expect(card.locator('.diff-file-toggle')).toHaveAttribute('aria-expanded', 'true');
    await search.getByRole('button', { name: '关闭查找' }).click();
    await page.locator('#agent-latest').click();
    h.adapter.emit('notice', { method: 'item/agentMessage/delta', params: { threadId: child.id, turnId: 'turn-999', itemId: 'answer', delta: ' child-live-tail' } });
    child.turns![999]!.items[2]!.text += ' child-live-tail';
    await expect(page.locator('#agent-conversation')).toContainText('child-live-tail');
    await expect.poll(async () => (await anchor(page)).key).toBe(parentAnchor.key);
    await page.screenshot({ path: 'test-results/transcript-subagent-1920.png' }); expect(errors).toEqual([]);
  } finally { await h.stop(); }
});
