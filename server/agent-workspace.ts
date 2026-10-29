import { mkdir, readdir, lstat, readFile, writeFile, chmod, realpath, unlink, rename, rm, copyFile } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { HttpError, inside } from './security.ts';
import type { AgentWorkspace } from '../shared/hybrid.ts';

const exec=promisify(execFile);
const omit=new Set(['.git','node_modules','.runtime','dist','dist-obsidian','.venv','__pycache__','.cache','test-results','playwright-report']);
type FileState={hash:string;mode:number};
type Manifest=Record<string,FileState>;
type Change={path:string;before?:FileState;after?:FileState};
type Journal={id:string;revision:string;state:'applying'|'applied'|'conflict';writes:{path:string;expected?:FileState;result?:FileState;data?:string;payload?:string}[]};
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const same=(a?:FileState,b?:FileState)=>a?.hash===b?.hash && a?.mode===b?.mode;
const missing=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';

async function fileHash(file:string,size?:number) {
  const digest=createHash('sha256');
  if(size!==0)for await(const chunk of createReadStream(file,{highWaterMark:1024*1024}))digest.update(chunk);
  return digest.digest('hex');
}
async function cloneFile(source:string,target:string,mode:number) {
  // COPYFILE_FICLONE falls back to copying when the filesystem cannot clone extents.
  await copyFile(source,target,constants.COPYFILE_FICLONE);
  await chmod(target,mode);
}

async function scan(root:string, excluded:string[]=[], copy?:string, excludedRoot?:string,rejectLinks=false,retainedHistory=new Set<string>()):Promise<Manifest> {
  const files:Manifest={};
  async function walk(dir:string) {
    for(const entry of await readdir(path.join(root,dir),{withFileTypes:true})) {
      const name=path.join(dir,entry.name),full=path.join(root,name);
      if(omit.has(entry.name) || entry.name==='.runs'&&!retainedHistory.has(name) || excludedRoot && inside(excludedRoot,full)){excluded.push(name);continue;}
      const info=await lstat(full);
      // Links may escape the independent copy; report omissions instead of following them.
      if(info.isSymbolicLink() || !info.isDirectory() && !info.isFile()){if(rejectLinks)throw new HttpError(409,'副本包含不支持合并的链接或特殊文件：'+name);excluded.push(name);continue;}
      if(info.isDirectory()){if(copy)await mkdir(path.join(copy,name),{recursive:true});await walk(name);continue;}
      const target=copy?path.join(copy,name):full;
      if(copy)await cloneFile(full,target,info.mode&0o777);
      const digest=await fileHash(target,info.size),after=await lstat(full);
      if(info.size!==after.size || info.mtimeMs!==after.mtimeMs)throw new HttpError(409,'创建副本时文件变化，请重试：'+name);
      files[name]={hash:digest,mode:info.mode&0o777};
    }
  }
  await walk('');return files;
}
async function safePath(root:string,name:string) {
  const target=path.resolve(root,name);
  if(!inside(root,target)||target===root)throw new HttpError(403,'无效副本路径');
  let parent=root;
  for(const part of path.relative(root,target).split(path.sep)){
    parent=path.join(parent,part);
    const info=await lstat(parent).catch(e=>{if(missing(e))return;throw e;});
    if(info?.isSymbolicLink())throw new HttpError(409,'路径已变为符号链接：'+name);
  }
  return target;
}
async function state(root:string,name:string):Promise<FileState|undefined> {
  const full=await safePath(root,name),info=await lstat(full).catch(e=>{if(missing(e))return;throw e;});
  if(!info)return;
  if(!info.isFile())throw new HttpError(409,'目标不再是普通文件：'+name);
  return {hash:await fileHash(full),mode:info.mode&0o777};
}
export class AgentWorkspaces {
  root:string;
  constructor(root:string){this.root=root;}
  async create(source:string,cwd:string):Promise<AgentWorkspace> {
    source=await realpath(source);cwd=await realpath(cwd);
    if(!inside(source,cwd))throw new HttpError(400,'工作目录不属于来源项目');
    const root=path.join(this.root,randomUUID()),base=path.join(root,'base'),work=path.join(root,'work'),excluded:string[]=[];
    await mkdir(base,{recursive:true,mode:0o700});await mkdir(work,{mode:0o700});
    try {
      const baseline=await scan(source,excluded,base,this.root);
      const verified=await scan(source,[],undefined,this.root);
      if(JSON.stringify(baseline)!==JSON.stringify(verified))throw new HttpError(409,'创建副本期间工作区变化，请重试');
      await scan(base,[],work);
      await writeFile(path.join(root,'baseline.json'),JSON.stringify(baseline),{mode:0o600});
      const workspace={root,cwd:path.join(work,path.relative(source,cwd)),source,excluded};
      await mkdir(workspace.cwd,{recursive:true});
      // A private Git repository supports normal agent diff/status without sharing source refs/hooks.
      await exec('git',['init','--quiet',work]);
      await exec('git',['-C',work,'add','--all','--force','.']);
      await exec('git',['-C',work,'-c','user.name=Viewer','-c','user.email=viewer@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','--quiet','--allow-empty','-m','Delegated workspace baseline']);
      return workspace;
    }catch(error){await rm(root,{recursive:true,force:true});throw error;}
  }
  async changes(w:AgentWorkspace) {
    const baseline=JSON.parse(await readFile(path.join(w.root,'baseline.json'),'utf8')) as Manifest;
    // Existing copies may track history: keep those entries visible so they never become false deletions.
    const history=new Set<string>();
    for(const file of Object.keys(baseline)){
      const parts=file.split(path.sep);parts.forEach((part,index)=>{if(part==='.runs')history.add(parts.slice(0,index+1).join(path.sep));});
    }
    const current=await scan(path.join(w.root,'work'),[],undefined,undefined,true,history);
    const changes:Change[]=[...new Set([...Object.keys(baseline),...Object.keys(current)])].sort().filter(p=>!same(baseline[p],current[p])).map(p=>({path:p,before:baseline[p],after:current[p]}));
    return {revision:hash(JSON.stringify(changes)),changes};
  }
  async apply(w:AgentWorkspace,id:string,revision:string) {
    if(!/^[\w-]{1,128}$/.test(id))throw new HttpError(400,'需要稳定的 operationId');
    const journalPath=path.join(w.root,'apply-'+id+'.json');
    let journal:Journal|undefined;
    try{journal=JSON.parse(await readFile(journalPath,'utf8'));}catch(e){if(!missing(e))throw e;}
    if(journal && journal.revision!==revision)throw new HttpError(409,'同一合并操作不能用于不同版本');
    if(journal?.state==='applied')return {state:'applied',revision,files:journal.writes.map(v=>v.path)};
    if(journal?.state==='conflict')throw new HttpError(409,'此合并曾发生冲突，请检查主工作区后用新操作重试');
    if(!journal) {
      const diff=await this.changes(w);if(diff.revision!==revision)throw new HttpError(409,'子任务修改已变化，请重新查看后合并');
      const writes:Journal['writes']=[],conflicts:string[]=[],staged:string[]=[];
      try{
      for(const change of diff.changes){
        const current=await state(w.source,change.path),work=path.join(w.root,'work',change.path);
        let payload:string|undefined,result=change.after;
        if(change.after){
          payload='payload-'+randomUUID();
          staged.push(path.join(w.root,payload));
          await cloneFile(work,path.join(w.root,payload),change.after.mode);
          if(await fileHash(path.join(w.root,payload))!==change.after.hash)throw new HttpError(409,'准备合并时子任务文件发生变化');
        }
        if(!same(current,change.before) && !same(current,change.after)) {
          if(!current||!change.before||!change.after){conflicts.push(change.path);continue;}
          const temp=path.join(w.root,'merge-'+randomUUID());await mkdir(temp);
          try {
            await cloneFile(await safePath(w.source,change.path),temp+'/current',current.mode);
            if(await fileHash(temp+'/current')!==current.hash)throw new HttpError(409,'准备合并时来源发生变化');
            await exec('git',['merge-file',temp+'/current',path.join(w.root,'base',change.path),path.join(w.root,payload!)]);
            await rename(temp+'/current',path.join(w.root,payload!));
            result={hash:await fileHash(path.join(w.root,payload!)),mode:change.after.mode===change.before.mode?current.mode:change.after.mode};
          }catch{conflicts.push(change.path);continue;}finally{await rm(temp,{recursive:true,force:true});}
        }
        writes.push({path:change.path,expected:current,result,...(payload?{payload}:{})});
      }
      if(conflicts.length)throw new HttpError(409,'合并冲突，尚未写回：'+conflicts.join('、'));
      journal={id,revision,state:'applying',writes};await writeFile(journalPath,JSON.stringify(journal),{mode:0o600});
      }catch(error){await Promise.all(staged.map(file=>rm(file,{force:true})));throw error;}
    }
    // A durable journal makes a partially applied operation recoverable without overwriting later edits.
    for(const file of journal.writes) {
      const current=await state(w.source,file.path);
      if(same(current,file.result))continue;
      if(!same(current,file.expected)){
        journal.state='conflict';await writeFile(journalPath,JSON.stringify(journal));
        throw new HttpError(409,'合并过程中来源发生变化；部分文件可能已写回，请核对：'+file.path);
      }
      const full=await safePath(w.source,file.path);
      if(file.payload!==undefined||file.data!==undefined){
        await mkdir(path.dirname(full),{recursive:true});await safePath(w.source,file.path);const temp=full+'.viewer-'+randomUUID();
        try{
          if(file.payload!==undefined)await cloneFile(await safePath(w.root,file.payload),temp,file.result!.mode);
          else {await writeFile(temp,Buffer.from(file.data!,'base64'));await chmod(temp,file.result!.mode);}
          if(await fileHash(temp)!==file.result!.hash)throw new HttpError(409,'合并载荷发生变化：'+file.path);
          await rename(temp,full);
        }finally{await rm(temp,{force:true});}
      }
      else await unlink(full);
    }
    journal.state='applied';await writeFile(journalPath,JSON.stringify(journal));
    return {state:'applied',revision,files:journal.writes.map(v=>v.path)};
  }
}
