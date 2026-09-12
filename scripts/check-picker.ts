// WSL/Windows smoke check: opens the real native script, verifies its window, then cancels.
// Run manually with: node scripts/check-picker.ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const start = (await run('wslpath', ['-w', process.cwd()])).stdout.trim();
// ponytail: extract the fixed script; move it to a .ps1 file if it grows beyond this template.
const source = await readFile(new URL('../server/files.ts', import.meta.url), 'utf8');
const template = source.match(/const script = `([\s\S]*?)`;/)![1];
const script = '[Console]::WriteLine("PID="+$PID);' + template.replace("${Buffer.from(start).toString('base64')}", Buffer.from(start).toString('base64'));
const command = (text: string) => ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(text, 'utf16le').toString('base64')];
const pending = run('powershell.exe', command(script), { timeout: 20000, maxBuffer: 16384 });
pending.catch(() => {});
let output = '', pid: string | undefined;
pending.child.stdout!.on('data', chunk => { output += chunk; });
try {
  for (let i = 0; i < 40 && !pid; i++) { await new Promise(resolve => setTimeout(resolve, 100)); pid = output.match(/PID=(\d+)/)?.[1]; }
  assert.ok(pid, 'Picker process did not start');
  const inspect = `
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class ViewerWindow {
 public delegate bool Callback(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback c, IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int n);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
'@
$windows = [Collections.Generic.List[IntPtr]]::new()
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  $windows.Clear()
  $null = [ViewerWindow]::EnumWindows({ param($h, $p)
    [uint32]$owner = 0
    $null = [ViewerWindow]::GetWindowThreadProcessId($h, [ref]$owner)
    if ($owner -eq ${pid} -and [ViewerWindow]::IsWindowVisible($h)) {
      $class = [Text.StringBuilder]::new(256)
      $null = [ViewerWindow]::GetClassName($h, $class, 256)
      if ($class.ToString() -eq '#32770') { $windows.Add($h) }
    }
    return $true
  }, [IntPtr]::Zero)
  if ($windows.Count -gt 0) {
    $topmost = ([ViewerWindow]::GetWindowLong($windows[0], -20) -band 8) -ne 0
    if ($topmost -or $attempt -eq 29) {
      [pscustomobject]@{ visible = $true; topmost = $topmost } | ConvertTo-Json -Compress
      $null = [ViewerWindow]::PostMessage($windows[0], 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
      exit
    }
  }
  Start-Sleep -Milliseconds 200
}
throw 'Native picker did not appear'
`;
  const result = await run('powershell.exe', command(inspect), { timeout: 15000, maxBuffer: 16384 });
  assert.deepEqual(JSON.parse(result.stdout), { visible: true, topmost: true });
  assert.equal((await pending).stdout.replace(/PID=\d+\s*/, '').trim(), '');
  console.log('Native WSL picker is visible, on top, and cancels cleanly.');
} finally {
  pending.child.kill();
  if (pid) await run('powershell.exe', command(`Stop-Process -Id ${pid} -ErrorAction SilentlyContinue`), { timeout: 5000 }).catch(() => {});
  await pending.catch(() => {});
}
