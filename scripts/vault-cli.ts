import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec=promisify(execFile);
export async function obsidianCli(vault: string, args: string[], executable='C:\\Program Files\\Obsidian\\Obsidian.com') {
  if(!vault || /[\x00-\x1f]/.test(vault) || args.some(a=>a.startsWith('vault=')||a.includes('\0')))throw new Error('明确指定一个 vault；不允许覆盖 vault 参数');
  const payload=Buffer.from(JSON.stringify({executable,args:['vault='+vault,...args]})).toString('base64');
  const script="$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+payload+"')) | ConvertFrom-Json; & $p.executable @($p.args); if ($LASTEXITCODE) { exit $LASTEXITCODE }";
  try { return await exec('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:30000,maxBuffer:2000000}); } catch(error) { const e=error as {killed?:boolean;stderr?:string};throw new Error(e.killed?'Obsidian CLI 超时；请检查应用状态，不重放写操作':'Obsidian CLI 执行失败：'+(e.stderr||'请检查 PowerShell 7 和 Obsidian 入口').slice(0,500)); }
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const [vault,...args]=process.argv.slice(2);if(!vault||!args.length)throw new Error('用法：node scripts/vault-cli.ts <vault> <command> [args...]');
  const result=await obsidianCli(vault,args);process.stdout.write(result.stdout);process.stderr.write(result.stderr);
}
