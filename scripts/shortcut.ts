import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { powershell, psQuote } from './open.ts';

const distro = process.env.WSL_DISTRO_NAME;
if (!distro) throw new Error('Install the Windows shortcut from inside WSL.');
const iconOnly = process.argv.includes('--icon-only');
const iconSource = execFileSync('wslpath', ['-w', fileURLToPath(new URL('../web/assets/icon.ico', import.meta.url))], { encoding: 'utf8' }).trim();
const launcher = String.raw`& $env:WINDIR\System32\wsl.exe -d ${psQuote(distro)} -u ${psQuote(os.userInfo().username)} -e ${psQuote(process.execPath)} ${psQuote(fileURLToPath(new URL('open.ts', import.meta.url)))};if($LASTEXITCODE){Add-Type -AssemblyName System.Windows.Forms;[Windows.Forms.MessageBox]::Show('Codex Viewer failed to start')}`;
const args = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + Buffer.from(launcher, 'utf16le').toString('base64');
// ponytail: WScript truncates arguments at 1023 characters; use a separate launcher file if paths outgrow this.
if (args.length > 1023) throw new Error('Paths are too long for the Windows shortcut command. Use a shorter project/Node path.');
// EncodedCommand carries literal paths without a .ps1 file or an execution-policy change.
console.log(powershell(`
$ErrorActionPreference = 'Stop'
$paths = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex Viewer.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex Viewer.lnk')
)
$shell = New-Object -ComObject WScript.Shell
foreach ($path in $paths) {
  if (${iconOnly ? '$true' : '$false'}) {
    if (!(Test-Path -LiteralPath $path) -or $shell.CreateShortcut($path).Description -ne 'Start Codex Viewer in WSL and open it in your browser') { throw "Expected Viewer shortcut: $path" }
  } elseif (Test-Path -LiteralPath $path) { throw "Shortcut already exists: $path" }
}
$iconDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex Viewer'
[void](New-Item -ItemType Directory -Force -Path $iconDir)
$icon = Join-Path $iconDir 'icon.ico'
Copy-Item -LiteralPath ${psQuote(iconSource)} -Destination $icon -Force
foreach ($path in $paths) {
  $shortcut = $shell.CreateShortcut($path)
  if (${iconOnly ? '$false' : '$true'}) {
  $shortcut.TargetPath = "$env:WINDIR\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  $shortcut.Arguments = ${psQuote(args)}
  $shortcut.WorkingDirectory = $env:USERPROFILE
  $shortcut.Description = 'Start Codex Viewer in WSL and open it in your browser'
  $shortcut.WindowStyle = 7
  }
  $shortcut.IconLocation = "$icon,0"
  $shortcut.Save()
  Write-Output "Saved: $path"
}`));
