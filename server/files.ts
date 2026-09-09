import { open, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { HttpError, inside } from './security.ts';
const exec=promisify(execFile);

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
  if(! (await stat(p)).isFile())throw new HttpError(400,'引用不是普通文件');
  return {path:p,line,column};
}
export async function previewFile(file:{path:string;line:number;column:number}) {
  const handle=await open(file.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let text:string;
  try {
    const s=await handle.stat(); if(!s.isFile()||s.size>256*1024)throw new HttpError(413,'仅预览不超过 256 KiB 的文本文件');
    const data=Buffer.alloc(256*1024+1);const {bytesRead}=await handle.read(data,0,data.length,0);
    if(bytesRead>256*1024)throw new HttpError(413,'文件过大');
    if(data.subarray(0,bytesRead).includes(0))throw new HttpError(415,'不预览二进制文件');
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(0,bytesRead));}catch{throw new HttpError(415,'文件不是 UTF-8 文本');}
  } finally {await handle.close();}
  const lines=text.split(/\r?\n/); if(file.line>lines.length)throw new HttpError(416,'行号超出当前文件范围');
  const start=Math.max(1,file.line-5);
  return {...file,start,totalLines:lines.length,lines:lines.slice(start-1,file.line+5)};
}
export async function openEditor(file:{path:string;line:number;column:number}) {
  await exec('code',['--reuse-window','--goto',`${file.path}:${file.line}:${file.column}`],{timeout:15000,maxBuffer:16384,shell:false});
}
