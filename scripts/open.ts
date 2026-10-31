import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
export function powershell(script: string) {
  return execFileSync(process.env.VIEWER_PWSH || 'pwsh.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ProgressPreference = 'SilentlyContinue'\n" + script, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 30_000 }).trim();
}

export function launchUrl(text: string) {
  const url = text.trim();
  if (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/\?token=[A-Za-z0-9_-]{43}$/.test(url)) throw new Error('Invalid local launch URL');
  const port = Number(new URL(url).port || 80);
  if (port < 1 || port > 65535) throw new Error('Invalid local port');
  return url;
}

export async function waitForViewer(file: string, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    if (text) {
      const url = launchUrl(text);
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))) }).catch(() => undefined);
      await response?.body?.cancel();
      if (response?.status === 303 && response.headers.get('location') === '/') return url;
    }
    await delay(250);
  }
  throw new Error('Codex Viewer did not become ready. Check: journalctl --user -u codex-viewer -n 30');
}

async function main() {
  process.env.XDG_RUNTIME_DIR ||= `/run/user/${process.getuid!()}`;
  process.env.DBUS_SESSION_BUS_ADDRESS ||= `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;
  execFileSync('/usr/bin/systemctl', ['--user', 'start', 'codex-viewer.service'], { timeout: 60_000, stdio: 'inherit' });
  const runtime = path.join(process.env.XDG_RUNTIME_DIR, `codex-viewer-${process.getuid!()}`);
  const url = await waitForViewer(path.join(runtime, 'url'));
  if (process.argv.includes('--check')) { console.log('Codex Viewer is ready.'); return; }
  powershell(`$ErrorActionPreference = 'Stop'; Start-Process -FilePath ${psQuote(url)}`);
  // WSL systemd services alone do not keep the distro alive. One holder serves all shortcut clicks.
  const holder = spawnSync('/usr/bin/flock', ['--nonblock', '--conflict-exit-code', '73', path.join(runtime, 'launcher.lock'),
    '/bin/sh', '-c', 'while /usr/bin/systemctl --user is-active --quiet codex-viewer.service; do /usr/bin/sleep 30; done'], { stdio: 'ignore' });
  if (holder.error) throw holder.error;
  if (holder.status !== 0 && holder.status !== 73) throw new Error('Could not keep WSL running for Codex Viewer');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
