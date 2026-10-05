import { test, expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';

async function copyRange(code: Locator, begin: number, end: number) {
  return code.evaluate((el, { begin, end }) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const point = (offset: number): [Text, number] => {
      for (const node of nodes) { if (offset <= node.length) return [node, offset]; offset -= node.length; }
      throw new Error('Selection offset outside code');
    };
    const range = document.createRange(); range.setStart(...point(begin)); range.setEnd(...point(end));
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    const data = new DataTransfer(); el.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData: data }));
    getSelection()!.removeAllRanges(); return data.getData('text/plain');
  }, { begin, end });
}

test('code selection copies exact text while message, mixed, math and Mermaid copies retain their semantics', async ({ page, context }) => {
  const dir = await mkdtemp('/tmp/viewer-copy-');
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  const code = 'const value = "<tag>";\n\n\tconsole.log(value);  \nreturn value;\n';
  const fence = String.fromCharCode(96).repeat(3), diagram = 'flowchart LR\n  A-->B';
  const source = 'before selection\n\n' + fence + 'js\n' + code + fence + '\n\nafter selection\n\n$\\frac{1}{2}$\n\n' + fence + 'mermaid\n' + diagram + '\n' + fence;
  try {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(app.launchUrl);
    const { thread } = await (await page.request.post(app.origin + '/api/threads', { data: { cwd: dir }, headers: { Origin: app.origin } })).json();
    thread.turns = [{ id: 'turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: source }] }];
    await page.route('**/api/threads/*/open', route => route.fulfill({ json: { thread, requests: [], seq: 0 } }));
    await page.goto(app.origin + '/#' + thread.id);
    const markdown = page.locator('#conversation .markdown'), body = markdown.locator('pre code').first();
    await expect(body).toHaveText(code);
    for (const [begin, end] of [[6, 11], [0, 21], [22, 44], [0, 44], [0, code.length]]) {
      expect(await copyRange(body, begin, end)).toBe(code.slice(begin, end));
    }
    // Also exercise the browser's actual keyboard-to-clipboard path.
    await body.evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    });
    await page.keyboard.press('Control+c');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
    await page.evaluate(() => getSelection()!.removeAllRanges());
    await page.getByRole('button', { name: '复制代码', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
    await page.getByRole('button', { name: '复制 Markdown', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
    const mixed = await markdown.evaluate(el => {
      const range = document.createRange(), code = el.querySelector('pre code')!;
      range.setStart(el.querySelector('p')!.firstChild!, 7);
      range.setEnd(code.querySelector('.hljs-keyword')!.firstChild!, 3);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
      const data = new DataTransfer(); el.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData: data }));
      getSelection()!.removeAllRanges(); return data.getData('text/plain');
    });
    expect(mixed).toBe('selection\n\ncon');
    const whole = await markdown.evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
      const data = new DataTransfer(); el.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData: data }));
      getSelection()!.removeAllRanges(); return data.getData('text/plain');
    });
    expect(whole).toContain(fence + 'js\n' + code + fence);
    expect(whole).toContain('$\\frac{1}{2}$');
    const mermaid = markdown.locator('.mermaid-block');
    await mermaid.getByRole('button', { name: '源码', exact: true }).click();
    const diagramCode = mermaid.locator('pre code'); await expect(diagramCode).toBeVisible();
    expect(await copyRange(diagramCode, 13, 19)).toBe(diagram.slice(13, 19));
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
