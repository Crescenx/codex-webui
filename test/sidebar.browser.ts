import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppServer } from '../server/adapter.ts';
import { serve } from '../server/main.ts';
import type { Thread } from '../shared/protocol.ts';

async function fixture(page: Page, projectFor: (i: number) => number, count: number) {
  const dir = await mkdtemp('/tmp/viewer-sidebar-');
  const roots = Array.from({ length: 20 }, (_, i) => path.join(dir, 'project-' + i));
  await Promise.all(roots.map(root => mkdir(root)));
  const records: Thread[] = Array.from({ length: count }, (_, i) => ({
    id: 'listed-' + i, cwd: roots[projectFor(i)], name: '会话 ' + i, updatedAt: count - i,
    status: { type: 'idle' }, settings: { model: 'mock', effort: 'medium', mode: 'default' },
    approvalsReviewer: 'auto_review', turns: [],
  }));
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const original = adapter.call.bind(adapter), requests: number[] = [], durations: number[] = [];
  let gate: Promise<void> | undefined, release = () => {}, fail = false, empty = false, active = 0, peak = 0;
  adapter.call = async (method, params = {}) => {
    if (method === 'thread/list') {
      if (params.ancestorThreadId) return { data: [], nextCursor: null };
      const offset = Number(params.cursor || 0), start = performance.now();
      requests.push(offset); peak = Math.max(peak, ++active);
      try {
        if (offset) { await gate; if (fail) throw new Error('分页暂时失败'); }
        const data = empty && offset === 50 ? [] : records.slice(offset, offset + 50).map(t => ({ ...t, turns: undefined }));
        return { data, nextCursor: offset + 50 < records.length ? String(offset + 50) : null };
      } finally { active--; durations.push(performance.now() - start); }
    }
    const thread = records.find(t => t.id === params.threadId);
    if (thread && ['thread/read', 'thread/resume'].includes(method)) return { thread, model: 'mock', reasoningEffort: 'medium', approvalsReviewer: 'auto_review' };
    return original(method, params);
  };
  const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0, adapter });
  await page.setViewportSize({ width: 1920, height: 1080 }); await page.goto(app.launchUrl);
  return {
    app, records, requests, durations, peak: () => peak,
    hold: () => { gate = new Promise<void>(resolve => { release = resolve; }); },
    release: () => { release(); gate = undefined; },
    fail: (value: boolean) => { fail = value; }, empty: (value: boolean) => { empty = value; },
    stop: async () => { release(); await app.stop(); await rm(dir, { recursive: true, force: true }); },
  };
}


test('Windows directory casing shares one project group while Linux casing remains distinct', async ({page}) => {
  const h=await fixture(page,i=>i,4);
  try {
    const projects=['/mnt/d/Documents/obsidian/knowbase','/mnt/d/documents/obsidian/knowbase','/home/user/Notes','/home/user/notes'];
    await page.route('**/api/threads**',async route=>{
      const response=await route.fetch(),body=await response.json();
      for(const thread of body.data || (body.thread?[body.thread]:[])) {
        const index=h.records.findIndex(t=>t.id===thread.id);
        if(index>=0)thread.projectRoot=projects[index];
      }
      await route.fulfill({response,json:body});
    });
    await page.reload();
    await expect(page.locator('.project')).toHaveCount(3);
    await expect(page.locator('.project-name').filter({hasText:'knowbase'})).toHaveCount(1);
    const vault=page.locator('.project').filter({has:page.locator('.project-name',{hasText:'knowbase'})});
    await expect(vault.locator('.thread')).toHaveCount(2);
    await vault.locator('.thread').first().click();await expect(page.locator('#send')).toBeEnabled();
    await expect(vault.locator('.thread')).toHaveCount(2);
    await expect(page.locator('.project')).toHaveCount(3);
  } finally {await h.stop();}
});

test('single project history is incremental, preserves navigation and retries failures', async ({ page, context }, info) => {
  const h = await fixture(page, i => i < 50 || i >= 100 && i < 125 ? 0 : i < 100 ? 1 : 2, 200);
  try {
    await expect(page.locator('.thread')).toHaveCount(6); expect(h.requests).toEqual([0]);
    await page.locator('.project-more').first().click(); await expect(page.locator('.thread')).toHaveCount(50);
    await page.locator('.thread').first().click(); await expect(page.locator('#send')).toBeEnabled();
    h.hold(); await page.locator('#threads').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(() => h.requests.includes(50)).toBe(true); await page.locator('#prompt').fill('分页期间保留草稿');
    h.release(); await expect(page.locator('.thread')).toHaveCount(75);
    expect(h.requests.filter(n => n > 0)).toEqual([50, 100]); expect(h.peak()).toBe(1);
    await expect(page.locator('#prompt')).toHaveValue('分页期间保留草稿');
    await page.locator('#threads').evaluate(el => { el.scrollTop = 300; });
    const before = await page.locator('#threads').evaluate(el => el.scrollTop);
    await page.locator('#all-projects').click(); await expect(page.locator('.project')).toHaveCount(3);
    await page.locator('#project-scope').selectOption(h.records[0]!.cwd);
    await expect.poll(() => page.locator('#threads').evaluate(el => el.scrollTop)).toBe(before);
    h.fail(true); await page.locator('#project-scope').selectOption(h.records[125]!.cwd); await page.locator('#more').click();
    await expect(page.locator('.thread-pagination [role="alert"]')).toContainText('分页暂时失败');
    h.fail(false); await page.locator('#more').click(); await expect(page.locator('.thread')).toHaveCount(75); await expect(page.locator('#more')).toBeHidden();
    await page.screenshot({ path: info.outputPath('single-project-history.png') });
    h.empty(true); await page.reload(); await expect(page.locator('.thread')).toHaveCount(6);
    await page.locator('.project-more').first().click(); await page.locator('#more').click(); await expect(page.locator('.thread')).toHaveCount(75);
    await page.locator('#prompt').fill('登录过期仍保留');
    await context.clearCookies(); await page.locator('.sidebar-more summary').click(); await page.locator('#refresh').click();
    await expect(page.locator('#connection')).toHaveText('登录已过期'); await expect(page.locator('#prompt')).toHaveValue('登录过期仍保留'); await expect(page.locator('#send')).toBeDisabled();
  } finally { await h.stop(); }
});

test('project scans stop after five pages and stop when navigation changes', async ({ page }) => {
  const h = await fixture(page, i => i < 50 ? 0 : 1, 500);
  try {
    await expect(page.locator('.thread')).toHaveCount(6); h.empty(true);
    await page.locator('.project-more').first().click(); await page.locator('#more').click();
    await expect(page.locator('#more')).toBeEnabled(); expect(h.requests).toEqual([0, 50, 100, 150, 200, 250]);
    await expect(page.locator('.thread')).toHaveCount(50);
    h.hold(); await page.locator('#more').click(); await expect.poll(() => h.requests.at(-1)).toBe(300);
    await page.locator('#all-projects').click(); h.release(); await expect(page.locator('#more')).toBeEnabled();
    expect(h.requests).toEqual([0, 50, 100, 150, 200, 250, 300]);
    await expect(page.locator('.project')).toHaveCount(2);
  } finally { await h.stop(); }
});

async function painted(page: Page, count: number, click = '') {
  return page.evaluate(({ count, click }) => new Promise<{ render: number; request: number }>((resolve, reject) => {
    const started = performance.now();
    if (click) (document.querySelector(click) as HTMLButtonElement).click();
    const check = () => {
      if (document.querySelectorAll('.thread').length >= count) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const entry = performance.getEntriesByType('resource').filter(e => new URL(e.name).pathname === '/api/threads').at(-1) as PerformanceResourceTiming;
          resolve({ render: performance.now() - entry.responseEnd, request: entry.responseEnd - entry.startTime });
        }));
      } else if (performance.now() - started > 10000) reject(new Error('sidebar did not paint'));
      else requestAnimationFrame(check);
    }; check();
  }), { count, click });
}

test('sidebar search benchmark: 20 projects and 1000 sessions remain incremental and responsive', async ({ page }, info) => {
  test.setTimeout(180000);
  const h = await fixture(page, i => i % 20, 1000);
  await page.locator('#search').fill('会话');
  const first: number[] = [], append: number[] = [], expand: number[] = [], requests: number[] = [];
  try {
    for (let i = 0; i < 20; i++) {
      if (i) { await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('#search').fill('会话'); }
      const initial = await painted(page, 50); first.push(initial.render); requests.push(initial.request);
      const next = await painted(page, 100, '#more'); append.push(next.render); requests.push(next.request);
    }
    for (let count = 150; count <= 1000; count += 50) {
      const next = await painted(page, count, '#more'); append.push(next.render); requests.push(next.request);
    }
    await expect(page.locator('.project')).toHaveCount(20); await expect(page.locator('.thread')).toHaveCount(1000);
    for (let i = 0; i < 20; i++) {
      const value = await page.locator('.project').nth(i).evaluate(el => new Promise<number>(resolve => {
        const button = el.querySelector<HTMLButtonElement>('.project-toggle')!;
        button.click();
        requestAnimationFrame(() => {
          const start = performance.now(); button.click();
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
        });
      }));
      expand.push(value);
    }
    const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
    const result = { first, append, expand, requestMs: requests, p95: { first: p95(first), append: p95(append), expand: p95(expand) }, peakPaginationRequests: h.peak() };
    await writeFile(info.outputPath('sidebar-performance.json'), JSON.stringify(result, null, 2));
    expect(result.p95.first).toBeLessThanOrEqual(100); expect(result.p95.append).toBeLessThanOrEqual(100); expect(result.p95.expand).toBeLessThanOrEqual(100);
    expect(h.peak()).toBe(1);
  } finally { await h.stop(); }
});
