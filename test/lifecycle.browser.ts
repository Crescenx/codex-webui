import { test, expect } from '@playwright/test';
import { createServer } from 'vite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

test('Vue remount releases SSE, copy and preview listeners without replaying user actions', async ({ page, context }) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viewer-lifecycle-'));
  await writeFile(path.join(dir, 'sample.py'), 'first line\ntarget line\nthird line');
  const adapter = new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')] });
  const app = await serve({ roots: [dir], dataDir: path.join(dir, 'data'), runtimeDir: path.join(dir, 'run'), port: 0, adapter });
  let dev: Awaited<ReturnType<typeof createServer>> | undefined;
  let turns = 0, approvals = 0, previews = 0;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    // Use Vite's existing module loader to exercise real component unmounts, not page reloads.
    dev = await createServer({ configFile: path.resolve('vite.config.ts'), server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: app.origin, changeOrigin: true, headers: { origin: app.origin } } } } });
    await dev.listen(); const address = dev.httpServer!.address(); if (!address || typeof address === 'string') throw new Error('Missing Vite address');
    const origin = `http://127.0.0.1:${address.port}`;
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await page.addInitScript(() => {
      const Original = window.EventSource;
      const sources = new Set<EventSource>();
      Object.assign(window, { viewerConnections: () => sources.size });
      window.EventSource = class extends Original {
        constructor(url: string | URL, options?: EventSourceInit) { super(url, options); sources.add(this); }
        override close() { sources.delete(this); super.close(); }
      };
    });
    page.on('request', request => {
      if (/\/api\/threads\/[^/]+\/turns$/.test(request.url())) turns++;
      if (/\/api\/requests\//.test(request.url())) approvals++;
      if (request.url().includes('/api/files/preview?')) previews++;
    });
    await page.goto(app.launchUrl); // Login cookie is host-scoped and also serves the Vite test port.
    await page.goto(origin);
    await page.locator('#welcome-new').click(); await page.getByRole('button', { name: '▱ ' + dir, exact: true }).click(); await page.locator('#folder-select').click();
    await expect(page.locator('#send')).toBeEnabled(); await page.locator('#prompt').fill('preview'); await page.locator('#send').click();
    await expect(page.locator('a[data-file]')).toBeVisible(); await expect(page.locator('#send')).toBeEnabled();
    const sent = turns;
    await page.evaluate(async () => {
      const modulePath = '/web/main.ts'; const entry = await import(modulePath);
      entry.unmount();
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { viewerConnections: () => number }).viewerConnections())).toBe(0);
    await expect(page.locator('.reference-card')).toHaveCount(0);
    for (let i = 0; i < 2; i++) {
      await page.evaluate(async () => {
        const modulePath = '/web/main.ts'; const entry = await import(modulePath);
        Object.assign(window, { viewerUnmount: entry.mountViewer(document.querySelector('#app')!) });
      });
      await expect(page.locator('a[data-file]')).toBeVisible();
      await expect.poll(() => page.evaluate(() => (window as unknown as { viewerConnections: () => number }).viewerConnections())).toBe(1);
      await expect(page.locator('.reference-card')).toHaveCount(1);
      const before = previews;
      await page.locator('a[data-file]').click(); await expect(page.locator('.reference-card')).toContainText('target line');
      expect(previews - before).toBe(1);
      await page.getByRole('button', { name: '复制 Markdown', exact: true }).last().click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('sample.py');
      await page.evaluate(() => (window as unknown as { viewerUnmount: () => void }).viewerUnmount());
      await expect.poll(() => page.evaluate(() => (window as unknown as { viewerConnections: () => number }).viewerConnections())).toBe(0);
      await expect(page.locator('.reference-card')).toHaveCount(0);
    }
    expect(turns).toBe(sent); expect(approvals).toBe(0); expect(errors).toEqual([]);
  } finally { await dev?.close(); await app.stop(); await rm(dir, { recursive: true, force: true }); }
});
