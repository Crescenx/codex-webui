import { open, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { HttpError, inside, imageMime } from './security.ts';
const exec=promisify(execFile);

export async function directoryPath(value: string) {
  if (!value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new HttpError(400, '无效目录路径');
  if (value === '~' || value.startsWith('~/')) value = path.join(os.homedir(), value.slice(2));
  if (/^(?:[a-z]:[\\/]|\\\\)/i.test(value)) {
    try { value = (await exec('wslpath', ['-u', value], { timeout: 5000, maxBuffer: 16384 })).stdout.trim(); }
    catch { throw new HttpError(400, '无法转换此 Windows 路径，请输入 WSL 路径'); }
  }
  if (!path.isAbsolute(value)) throw new HttpError(400, '请输入完整目录路径');
  return value;
}

export async function pickDirectory(initial: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const start = (await exec('wslpath', ['-w', initial], { timeout: 5000, maxBuffer: 16384, signal })).stdout.trim();
    // Only base64-encoded data enters the fixed PowerShell script, never path syntax.
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
# Raise after the native modal loop starts, so the picker stays above the browser.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 300
$timer.Add_Tick({ $owner.TopMost = $false; $owner.TopMost = $true; $owner.Activate(); $timer.Stop() })
$timer.Start()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select a project folder (Windows or WSL)'
$dialog.ShowNewFolderButton = $false
$dialog.SelectedPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(start).toString('base64')}'))
try { if ($dialog.ShowDialog($owner) -eq [Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) } }
finally { $timer.Dispose(); $dialog.Dispose(); $owner.Dispose() }
`;
    const { stdout } = await exec(process.env.VIEWER_PWSH || 'pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 120000, maxBuffer: 16384, signal });
    return stdout.trim() || null;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new HttpError(502, '无法打开系统选择器，请使用下方目录列表或输入 WSL 路径');
  }
}

export async function projectRoot(cwd:string, roots:string[]) {
  try { const {stdout}=await exec('git',['-C',cwd,'rev-parse','--show-toplevel'],{timeout:2000,maxBuffer:4096});
    const p=await realpath(stdout.trim()); return roots.some(r=>inside(r,p))?p:cwd;
  } catch {return cwd;}
}
export async function localFile(target:string,cwd:string,roots:string[]) {
  if(target.length>4096 || /[\x00-\x1f]/.test(target)) throw new HttpError(400,'不支持的文件引用');
  const match=/(?::(\d+)(?::(\d+))?|#L(\d+))$/.exec(target);
  const line=match?Number(match[1]||match[3]):1; const column=Number(match?.[2]||1);
  if(!Number.isSafeInteger(line)||line<1||!Number.isSafeInteger(column)||column<1)throw new HttpError(400,'无效行号');
  const raw=match?target.slice(0,match.index):target;
  if(/^[a-z][a-z\d+.-]*:/i.test(raw)||raw.startsWith('//'))throw new HttpError(400,'不支持的文件引用');
  const requested=path.resolve(cwd,raw);
  const p=await realpath(requested).catch(()=>{throw new HttpError(404,'文件不存在');});
  if(!roots.some(r=>inside(r,p)))throw new HttpError(403,'文件超出授权目录');
  // Preview/open only visible project files, never hidden credentials or configuration stores.
  if([requested,p].some(v=>v.split(path.sep).some(s=>s.startsWith('.'))))throw new HttpError(403,'不打开隐藏或敏感配置文件');
  const info=await stat(p);
  if(!info.isFile()&&!info.isDirectory())throw new HttpError(400,'引用不是普通文件或文件夹');
  return {path:p,line,column};
}
export async function previewFile(file:{path:string;line:number;column:number}) {
  const handle=await open(file.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let text:string;
  try {
    const s=await handle.stat();
    if(s.isDirectory())return {...file,kind:'directory' as const,start:1,totalLines:0,lines:[]};
    if(!s.isFile()||s.size>256*1024)throw new HttpError(413,'仅预览不超过 256 KiB 的文本文件');
    const data=Buffer.alloc(256*1024+1);const {bytesRead}=await handle.read(data,0,data.length,0);
    if(bytesRead>256*1024)throw new HttpError(413,'文件过大');
    if(data.subarray(0,bytesRead).includes(0))throw new HttpError(415,'不预览二进制文件');
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(0,bytesRead));}catch{throw new HttpError(415,'文件不是 UTF-8 文本');}
  } finally {await handle.close();}
  const lines=text.split(/\r?\n/); if(file.line>lines.length)throw new HttpError(416,'行号超出当前文件范围');
  const start=Math.max(1,file.line-5);
  return {...file,start,totalLines:lines.length,lines:lines.slice(start-1,file.line+5)};
}
export async function imageFile(file: { path: string }) {
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await handle.stat();
    if (!s.isFile() || s.size > 25 * 1024 * 1024) throw new HttpError(413, '仅显示不超过 25 MiB 的图片');
    const buffer = Buffer.alloc(s.size + 1); let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > s.size) throw new HttpError(409, '图片读取期间发生变化，请重试');
    const data = buffer.subarray(0, size), mime = imageMime(data);
    if (!mime) throw new HttpError(415, '仅支持 PNG、JPEG、WebP 图片');
    return { data, mime };
  } finally { await handle.close(); }
}
export async function openDefault(file:{path:string;line:number;column:number},reveal=false) {
  try {
    const options={timeout:30000,maxBuffer:1024*1024,shell:false};
    const wsl=!!process.env.WSL_DISTRO_NAME||/microsoft/i.test(os.release());
    if(wsl||process.platform==='win32') {
      const target=wsl?(await exec('wslpath',['-w',file.path],options)).stdout.trim():file.path;
      // Pass only encoded path data to PowerShell; line/column belong to the text preview.
      const script=`$ErrorActionPreference = 'Stop'\n$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(target).toString('base64')}'))\n`+
        (reveal?`Start-Process -FilePath explorer.exe -ArgumentList ('/select,"' + $target + '"')`:'Start-Process -FilePath $target');
      await exec(process.env.VIEWER_PWSH || 'pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],options);
    } else if(process.platform==='darwin')await exec('open',reveal?['-R',file.path]:[file.path],options);
    else await exec('xdg-open',[reveal?path.dirname(file.path):file.path],options);
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { killed?: boolean };
    if (e.killed && e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new HttpError(504,'系统打开命令超时，窗口可能已经打开，请先检查桌面');
    if (e.code === 'ENOENT') throw new HttpError(502,'找不到系统打开命令，请检查 Viewer 后台服务的 PATH');
    throw new HttpError(502,reveal?'无法在文件夹中显示，请检查系统环境':'无法使用系统默认应用打开，请检查文件关联和系统环境');
  }
}
