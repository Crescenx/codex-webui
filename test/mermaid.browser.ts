import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

type Metrics = { layouts: number; created: number; revoked: number };
const metrics = (page: Page) => page.evaluate(() => (window as unknown as { diagramStats: Metrics }).diagramStats);
const flow = 'flowchart LR\n  A["搜集并积累证据<br/>Yifan 与 Hanzhe 的重点"] --> B["形成答案"]\n  B --> C["同伴背书或反对<br/>Qinqi 的重点"]\n  C --> D["发布或保留<br/>Qinqi 的重点"]';
const fence = (source: string) => '```mermaid\n' + source + '\n```';

test('Mermaid module load failure keeps source and recovers after a page refresh', async ({ page }) => {
  const dir = await mkdtemp('/tmp/viewer-mermaid-load-');
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  try {
    await page.goto(app.launchUrl);
    const created = await (await page.request.post(app.origin + '/api/threads', { headers: { origin: app.origin }, data: { cwd: dir } })).json();
    const threadId = created.thread.id; await page.goto(app.origin + '/#' + threadId); await expect(page.locator('#send')).toBeEnabled();
    const publish = () => adapter.emit('notice', { method: 'turn/completed', params: { threadId, turn: { id: 'load-turn', status: 'completed', items: [{ id: 'load-item', type: 'agentMessage', text: fence(flow) }] } } });
    await page.route('**/mermaid.core-*.js', route => route.abort()); publish();
    const diagram = page.locator('.mermaid-block'); await expect(diagram).toContainText('图表组件加载失败'); await expect(diagram.locator('pre code')).toHaveText(flow + '\n');
    await expect(diagram.getByRole('button', { name: '重试', exact: true })).toBeVisible(); await expect(page.locator('.mermaid-scratch')).toHaveCount(0);
    await page.unroute('**/mermaid.core-*.js'); await page.reload(); await expect(page.locator('#send')).toBeEnabled(); publish();
    await expect(diagram.locator('img')).toBeVisible();
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('Mermaid streams once, preserves source, shares SVG, and releases views under the real CSP', async ({ page, context }) => {
  test.setTimeout(90_000);
  const dir = await mkdtemp('/tmp/viewer-mermaid-');
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(request.url()));
  await page.addInitScript(() => {
    const stats: Metrics = { layouts: 0, created: 0, revoked: 0 }; Object.assign(window, { diagramStats: stats });
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { if (blob instanceof Blob && blob.type === 'image/svg+xml') stats.created++; return create(blob); };
    URL.revokeObjectURL = url => { stats.revoked++; revoke(url); };
    new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node instanceof Element && node.classList.contains('mermaid-scratch')) stats.layouts++; }).observe(document, { subtree: true, childList: true });
  });
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.origin });
    await page.setViewportSize({ width: 1280, height: 900 }); await page.goto(app.launchUrl);
    const created = await (await page.request.post(app.origin + '/api/threads', { headers: { origin: app.origin }, data: { cwd: dir } })).json();
    const threadId = created.thread.id; await page.goto(app.origin + '/#' + threadId); await expect(page.locator('#send')).toBeEnabled();
    expect(requests.some(url => /mermaid\.core-/.test(url))).toBe(false);
    const turnId = 'diagram-turn', itemId = 'diagram-item';
    const notice = (method: string, params: Record<string, unknown>) => adapter.emit('notice', { method, params: { threadId, turnId, ...params } });
    notice('turn/started', { turn: { id: turnId, status: 'inProgress', items: [] } });
    notice('item/started', { item: { id: itemId, type: 'agentMessage', text: '' } });
    let source = '图表如下。\n\n```mermaid\n' + flow;
    const replace = async (text: string) => {
      source = text; notice('item/completed', { item: { id: itemId, type: 'agentMessage', text } });
      await expect(page.locator('.mermaid-block pre code').first()).toHaveText(text.split('```mermaid\n')[1].split('\n```')[0] + '\n');
    };
    notice('item/agentMessage/delta', { itemId, delta: source });
    const diagram = page.locator('.mermaid-block').first();
    await expect(diagram).toContainText('等待图表代码完成'); expect((await metrics(page)).layouts).toBe(0);
    source += '\n```'; notice('item/agentMessage/delta', { itemId, delta: '\n```' });
    await expect(diagram.locator('img')).toBeVisible();
    await expect.poll(() => diagram.locator('img').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect((await metrics(page)).layouts).toBe(1);
    await diagram.evaluate(el => Object.assign(window, { originalDiagram: el }));
    await diagram.getByRole('button', { name: '源码', exact: true }).click();
    await expect(diagram.locator('pre')).toBeVisible();
    source += '\n\n继续解释图表。'; notice('item/agentMessage/delta', { itemId, delta: '\n\n继续解释图表。' });
    await expect(page.locator('.assistant .markdown')).toContainText('继续解释图表');
    expect(await diagram.evaluate(el => el === (window as unknown as { originalDiagram: Element }).originalDiagram)).toBe(true);
    await expect(diagram.locator('pre')).toBeVisible(); expect((await metrics(page)).layouts).toBe(1);
    await diagram.getByRole('button', { name: '复制源码', exact: true }).click(); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(flow);
    await page.getByRole('button', { name: '复制 Markdown', exact: true }).click(); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
    const selected = await page.locator('.assistant .markdown').evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      const data = new DataTransfer(); el.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData: data })); selection.removeAllRanges(); return data.getData('text/plain');
    });
    expect(selected).toContain(fence(flow)); expect(selected).not.toContain('下载 SVG');
    await diagram.getByRole('button', { name: '源码', exact: true }).click();
    await diagram.getByRole('button', { name: '放大', exact: true }).click();
    const modal = page.locator('.mermaid-dialog'); await expect(modal).toBeVisible();
    const originalUrl = await diagram.locator('img').getAttribute('src'); expect(await modal.locator('img').getAttribute('src')).toBe(originalUrl);
    await modal.getByRole('button', { name: '原始大小', exact: true }).click(); await expect(modal.locator('output')).toHaveText('100%');
    await page.keyboard.press('+'); await expect(modal.locator('output')).toHaveText('125%');
    source += '\n\n放大时继续输出。'; notice('item/agentMessage/delta', { itemId, delta: '\n\n放大时继续输出。' });
    await expect(modal.locator('output')).toHaveText('125%'); expect((await metrics(page)).layouts).toBe(1);
    await page.keyboard.press('Escape'); await expect(modal).toHaveCount(0); await expect(diagram.getByRole('button', { name: '放大', exact: true })).toBeFocused();
    const download = page.waitForEvent('download'); await diagram.getByRole('button', { name: '下载 SVG', exact: true }).click();
    const downloaded = await download; const svg = await readFile((await downloaded.path())!, 'utf8');
    expect(svg).toContain('搜集并积累证据'); expect(svg).toContain('viewBox='); expect(svg).toContain('#fffdf8'); expect(svg).not.toMatch(/foreignObject|<script|href="https?:/);
    const exported = await context.newPage(); await exported.goto(originalUrl!);
    expect(await exported.locator('svg').getAttribute('viewBox')).toBeTruthy(); await exported.close();
    await page.setViewportSize({ width: 1920, height: 844 }); await diagram.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/mermaid-widescreen.png' });
    await diagram.getByRole('button', { name: '放大', exact: true }).click(); await expect(page.locator('.mermaid-dialog')).toBeInViewport();
    await page.locator('.mermaid-dialog').getByRole('button', { name: '放大', exact: true }).click();
    expect((await metrics(page)).layouts).toBe(1); await page.screenshot({ path: 'test-results/mermaid-zoom-widescreen.png' }); await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 900 });
    await replace(fence(flow) + '\n\n' + fence(flow)); await expect(page.locator('.mermaid-block')).toHaveCount(2);
    for (const block of await page.locator('.mermaid-block').all()) { await block.scrollIntoViewIfNeeded(); await expect(block.locator('img')).toBeVisible(); }
    expect((await metrics(page)).layouts).toBe(1);
    const beforeTypes = (await metrics(page)).layouts;
    for (const graph of ['sequenceDiagram\nparticipant A as 用户\nparticipant B as 系统\nA->>B: 请求\nB-->>A: 结果', 'mindmap\n  root((研究))\n    方法\n    实验']) {
      await replace(fence(graph)); await expect(diagram.locator('img')).toBeVisible(); await expect.poll(() => diagram.locator('img').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    }
    expect((await metrics(page)).layouts).toBe(beforeTypes + 2);
    await replace(fence('%%{init: {"securityLevel":"loose","htmlLabels":true,"theme":"dark"}}%%\nflowchart LR\nA[中文]-->B[安全配置]'));
    await expect(diagram.locator('img')).toBeVisible();
    const lockedDownload = page.waitForEvent('download'); await diagram.getByRole('button', { name: '下载 SVG', exact: true }).click();
    const locked = await readFile((await (await lockedDownload).path())!, 'utf8');
    expect(locked).not.toContain('foreignObject'); expect(locked).toContain('#fffdf8');
    const beforeBad = (await metrics(page)).layouts;
    for (const bad of ['flowchart LR\nA@{ img: "/api/private.png" }', 'flowchart LR\nA@{ anchor: &key img, ? *key : "/api/private.png" }', 'flowchart LR\nA@{ "im\\\n  g": "/api/private.png" }', 'flowchart LR\nclassDef x fill:url(https://example.com/track)', 'x'.repeat(32_001)]) {
      await replace(fence(bad)); await expect(diagram).toContainText('无法渲染图表'); await expect(diagram.locator('pre')).toBeVisible();
    }
    expect((await metrics(page)).layouts).toBe(beforeBad);
    expect(requests.some(url => /private\.png|example\.com/.test(url))).toBe(false);
    await replace(fence('flowchart LR\nA --> [bad syntax')); await expect(diagram).toContainText('无法渲染图表');
    const badCount = (await metrics(page)).layouts; await replace(source + '\n\n尾部文本'); await expect(page.locator('.assistant .markdown')).toContainText('尾部文本'); await expect(diagram).toContainText('无法渲染图表'); expect((await metrics(page)).layouts).toBe(badCount);
    await diagram.getByRole('button', { name: '重试', exact: true }).click(); await expect.poll(async () => (await metrics(page)).layouts).toBe(badCount + 1);
    await replace(fence('flowchart LR\n' + Array.from({ length: 501 }, (_, i) => `A${i}-->A${i + 1}`).join('\n')));
    await expect(diagram).toContainText('无法渲染图表'); await expect(diagram).toContainText('500');
    await replace('```mermaid\n' + flow); await expect(diagram).toContainText('等待图表代码完成');
    notice('turn/completed', { turn: { id: turnId, status: 'completed', items: [{ id: itemId, type: 'agentMessage', text: source }] } });
    await expect(diagram.locator('img')).toBeVisible();
    await page.screenshot({ path: 'test-results/mermaid-desktop.png' });
    const second = await (await page.request.post(app.origin + '/api/threads', { headers: { origin: app.origin }, data: { cwd: dir } })).json();
    await diagram.getByRole('button', { name: '放大', exact: true }).click();
    await page.evaluate(id => { location.hash = id; }, second.thread.id);
    await expect(page.locator('.mermaid-block, .mermaid-dialog, .mermaid-scratch')).toHaveCount(0);
    const final = await metrics(page); expect(final.created).toBe(final.revoked); expect(errors).toEqual([]);
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('Mermaid bounds its cache, defers offscreen work and discards cancelled results', async ({ page }) => {
  test.setTimeout(90_000);
  const dir = await mkdtemp('/tmp/viewer-mermaid-queue-');
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  let dev: Awaited<ReturnType<typeof createServer>> | undefined;
  let moduleUrl = '';
  page.on('request', request => { if (/\/mermaid(?:\.js|\.core\.mjs)(?:\?|$)/.test(request.url())) moduleUrl = request.url(); });
  type Probe = { diagramCalls: string[]; finishDiagram?: () => void; svgCreated: number; svgRevoked: number };
  const calls = () => page.evaluate(() => (window as unknown as Probe).diagramCalls);
  await page.addInitScript(() => {
    const probe: Probe = { diagramCalls: [], svgCreated: 0, svgRevoked: 0 }; Object.assign(window, probe);
    const state = window as unknown as Probe, create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { if (blob instanceof Blob && blob.type === 'image/svg+xml') state.svgCreated++; return create(blob); };
    URL.revokeObjectURL = url => { state.svgRevoked++; revoke(url); };
  });
  try {
    dev = await createServer({ configFile: path.resolve('vite.config.ts'), server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: app.origin, changeOrigin: true, headers: { origin: app.origin } } } } });
    await dev.listen(); const address = dev.httpServer!.address(); if (!address || typeof address === 'string') throw new Error('Missing Vite address');
    const origin = `http://127.0.0.1:${address.port}`;
    await page.setViewportSize({ width: 1280, height: 900 }); await page.goto(app.launchUrl);
    const created = await (await page.request.post(app.origin + '/api/threads', { headers: { origin: app.origin }, data: { cwd: dir } })).json();
    const threadId = created.thread.id; await page.goto(origin + '/#' + threadId); await expect(page.locator('#send')).toBeEnabled();
    const turnId = 'queue-turn', itemId = 'queue-item';
    const publish = (source: string) => adapter.emit('notice', { method: 'item/completed', params: { threadId, turnId, item: { id: itemId, type: 'agentMessage', text: source } } });
    adapter.emit('notice', { method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
    const code = (label: string) => `flowchart LR\nA["${label}"]-->B`;
    const diagram = page.locator('.mermaid-block').first();
    const show = async (label: string) => {
      publish(fence(code(label))); await expect(diagram.locator('pre code')).toHaveText(code(label) + '\n'); await expect(diagram.locator('img')).toBeVisible();
    };
    await show('warmup'); expect(moduleUrl).toBeTruthy();
    // Use the existing Vite module loader to replace only the external layout
    // operation; our real components, queue, cache and SVG validation stay active.
    await page.evaluate(async url => {
      const { default: mermaid } = await import(url);
      mermaid.render = async (_id: string, source: string) => {
        const state = window as unknown as Probe; state.diagramCalls.push(source);
        if (source.includes('slow')) await new Promise<void>(resolve => { state.finishDiagram = resolve; });
        if (source.includes('retry-once') && state.diagramCalls.filter(value => value === source).length === 1) throw new Error('Transient layout failure');
        const padding = source.includes('big-') ? 'x'.repeat(2300000) : '';
        const unsafe = source.includes('svg-script') ? '<script>window.svgExecuted=true</script>' : source.includes('svg-event') ? '<g onload="window.svgExecuted=true"/>' : source.includes('svg-link') ? '<a href="https://example.com/track"><text>link</text></a>' : source.includes('svg-css') ? '<style>text{fill:url(/api/private)}</style>' : '';
        return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + (source.includes('wide') ? 30000 : 600) + ' 240"><!--' + padding + '--><text x="10" y="30">diagram</text>' + unsafe + '</svg>' };
      };
    }, moduleUrl);
    for (let i = 0; i < 33; i++) await show('small-' + i);
    expect((await calls()).length).toBe(33);
    await show('small-1'); expect((await calls()).length).toBe(33); // refresh recency
    await show('small-0'); expect((await calls()).length).toBe(34); // oldest was evicted
    await show('small-1'); expect((await calls()).length).toBe(34);
    await show('big-a'); await show('big-b'); const largeCount = (await calls()).length;
    publish('暂时移除图表'); await expect(diagram).toHaveCount(0);
    await show('big-b'); expect((await calls()).length).toBe(largeCount);
    await show('big-a'); expect((await calls()).length).toBe(largeCount + 1); // byte limit evicts even with <32 entries

    publish(fence(code('retry-once'))); await expect(diagram).toContainText('Transient layout failure');
    await diagram.getByRole('button', { name: '重试', exact: true }).click(); await expect(diagram.locator('img')).toBeVisible();
    await expect(diagram.getByRole('button', { name: '重试', exact: true })).toBeHidden();
    await diagram.locator('img').evaluate(el => el.dispatchEvent(new Event('error'))); await expect(diagram).toContainText('SVG 图片无法加载'); await expect(diagram.locator('pre')).toBeVisible();
    await diagram.getByRole('button', { name: '重试', exact: true }).click(); await expect(diagram.locator('img')).toBeVisible();
    for (const label of ['svg-script', 'svg-event', 'svg-link', 'svg-css']) {
      publish(fence(code(label))); await expect(diagram.locator('pre code')).toHaveText(code(label) + '\n'); await expect(diagram).toContainText('无法渲染图表');
      await expect(diagram.getByRole('button', { name: '下载 SVG', exact: true })).toBeDisabled();
    }
    expect(await page.evaluate(() => 'svgExecuted' in window)).toBe(false);
    await show('wide'); await diagram.getByRole('button', { name: '放大', exact: true }).click();
    expect(await page.locator('.mermaid-viewport img').evaluate(img => img.getBoundingClientRect().width <= img.parentElement!.clientWidth)).toBe(true);
    await page.locator('.mermaid-dialog').getByRole('button', { name: '原始大小', exact: true }).click();
    const viewport = page.locator('.mermaid-viewport'); await viewport.evaluate(el => { el.scrollLeft = 200; });
    const box = (await viewport.boundingBox())!; const beforeDrag = await viewport.evaluate(el => el.scrollLeft);
    await page.mouse.move(box.x + 150, box.y + 80); await page.mouse.down(); await page.mouse.move(box.x + 70, box.y + 80); await page.mouse.up();
    expect(await viewport.evaluate(el => el.scrollLeft)).toBeGreaterThan(beforeDrag);
    await page.keyboard.press('Escape');

    const beforeLong = (await calls()).length;
    publish(Array.from({ length: 20 }, (_, i) => fence(code('visible-' + i))).join('\n\n'));
    await expect(page.locator('.mermaid-block')).toHaveCount(20);
    await expect(page.locator('.mermaid-block').last().locator('img')).toBeVisible();
    expect((await calls()).length - beforeLong).toBeLessThan(20);
    await page.locator('#conversation').evaluate(el => { el.scrollTop = 0; }); await expect(diagram.locator('img')).toBeVisible();
    expect(await page.locator('#conversation').evaluate(el => el.scrollTop)).toBeLessThan(10);
    await page.locator('#latest').click();

    // A result may finish while the user selects source: preserve the selection
    // and defer the DOM change until selection ends.
    publish('选中这段文字。\n\n' + fence(code('slow-selection')));
    await expect.poll(async () => (await calls()).includes(code('slow-selection'))).toBe(true);
    await page.locator('.assistant .markdown > p').evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      (window as unknown as Probe).finishDiagram!();
    });
    await expect(page.locator('.mermaid-scratch')).toHaveCount(0); await expect(diagram.locator('img')).toBeHidden();
    expect(await page.evaluate(() => getSelection()?.toString())).toBe('选中这段文字。');
    await page.evaluate(() => getSelection()?.removeAllRanges()); await expect(diagram.locator('img')).toBeVisible();

    publish(fence(code('slow-dispose')) + '\n\n' + fence(code('queued-cancelled')));
    await expect.poll(async () => (await calls()).includes(code('slow-dispose'))).toBe(true);
    const beforeDispose = await page.evaluate(() => (window as unknown as Probe).svgCreated);
    const second = await (await page.request.post(app.origin + '/api/threads', { headers: { origin: app.origin }, data: { cwd: dir } })).json();
    await page.evaluate(id => { location.hash = id; }, second.thread.id); await expect(page.locator('.mermaid-block')).toHaveCount(0);
    await page.evaluate(() => (window as unknown as Probe).finishDiagram!()); await expect(page.locator('.mermaid-scratch')).toHaveCount(0);
    expect((await calls()).includes(code('queued-cancelled'))).toBe(false);
    expect(await page.evaluate(() => (window as unknown as Probe).svgCreated)).toBe(beforeDispose);
    expect(await page.evaluate(() => { const state = window as unknown as Probe; return state.svgCreated === state.svgRevoked; })).toBe(true);
    adapter.emit('notice', { method: 'turn/completed', params: { threadId: second.thread.id, turn: { id: 'unmount-turn', status: 'completed', items: [{ id: 'unmount-item', type: 'agentMessage', text: fence(code('app-unmount')) }] } } });
    await expect(page.locator('.mermaid-block img')).toBeVisible();
    await page.evaluate(async () => { const entry = '/web/main.ts'; (await import(entry)).unmount(); });
    await expect(page.locator('.mermaid-block, .mermaid-dialog, .mermaid-scratch')).toHaveCount(0);
    expect(await page.evaluate(() => { const state = window as unknown as Probe; return state.svgCreated === state.svgRevoked; })).toBe(true);
  } finally { await dev?.close(); await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
