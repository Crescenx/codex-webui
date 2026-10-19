import { mkdir, readdir, lstat, readFile, writeFile, chmod, realpath, unlink, rename, rm } from 'node:fs/promises';
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
type Journal={id:string;revision:string;state:'applying'|'applied'|'conflict';writes:{path:string;expected?:FileState;result?:FileState;data?:string}[]};
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const same=(a?:FileState,b?:FileState)=>a?.hash===b?.hash && a?.mode===b?.mode;
const missing=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';

async function scan(root:string, excluded:string[]=[], copy?:string, excludedRoot?:string,rejectLinks=false):Promise<Manifest> {
  const files:Manifest={};let total=0,count=0;
  async function walk(dir:string) {
    for(const entry of await readdir(path.join(root,dir),{withFileTypes:true})) {
      const name=path.join(dir,entry.name),full=path.join(root,name);
      if(omit.has(entry.name) || excludedRoot && inside(excludedRoot,full)){excluded.push(name);continue;}
      const info=await lstat(full);
      // Links may escape the independent copy; report omissions instead of following them.
      if(info.isSymbolicLink() || !info.isDirectory() && !info.isFile()){if(rejectLinks)throw new HttpError(409,'副本包含不支持合并的链接或特殊文件：'+name);excluded.push(name);continue;}
      if(info.isDirectory()){if(copy)await mkdir(path.join(copy,name),{recursive:true});await walk(name);continue;}
      total+=info.size;if(++count>50000 || total>2*1024**3)throw new HttpError(413,'工作副本超过 50,000 文件或 2 GiB，请缩小任务目录');
      const data=await readFile(full);const after=await lstat(full);
      if(info.size!==after.size || info.mtimeMs!==after.mtimeMs)throw new HttpError(409,'创建副本时文件变化，请重试：'+name);
      files[name]={hash:hash(data),mode:info.mode&0o777};
      if(copy){await mkdir(path.dirname(path.join(copy,name)),{recursive:true});await writeFile(path.join(copy,name),data,{mode:files[name].mode});}
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
  return {hash:hash(await readFile(full)),mode:info.mode&0o777};
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
    const current=await scan(path.join(w.root,'work'),[],undefined,undefined,true);
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
      const writes:Journal['writes']=[],conflicts:string[]=[];
      for(const change of diff.changes){
        const current=await state(w.source,change.path),work=path.join(w.root,'work',change.path);
        let data=change.after?await readFile(work):undefined,result=change.after;
        if(data&&hash(data)!==change.after?.hash)throw new HttpError(409,'准备合并时子任务文件发生变化');
        if(!same(current,change.before) && !same(current,change.after)) {
          if(!current||!change.before||!change.after){conflicts.push(change.path);continue;}
          const parentData=await readFile(await safePath(w.source,change.path)),baseData=await readFile(path.join(w.root,'base',change.path));
          if([parentData,baseData,data!].some(v=>v.includes(0)||v.length>2_000_000)){conflicts.push(change.path);continue;}
          const temp=path.join(w.root,'merge-'+randomUUID());await mkdir(temp);
          try {
            await Promise.all([writeFile(temp+'/current',parentData),writeFile(temp+'/base',baseData),writeFile(temp+'/child',data!)]);
            const merged=await exec('git',['merge-file','-p',temp+'/current',temp+'/base',temp+'/child'],{maxBuffer:8_000_000,encoding:'buffer'});
            data=merged.stdout;result={hash:hash(data),mode:change.after.mode===change.before.mode?current.mode:change.after.mode};
          }catch{conflicts.push(change.path);continue;}finally{await rm(temp,{recursive:true,force:true});}
        }
        writes.push({path:change.path,expected:current,result,data:data?.toString('base64')});
      }
      if(conflicts.length)throw new HttpError(409,'合并冲突，尚未写回：'+conflicts.join('、'));
      journal={id,revision,state:'applying',writes};await writeFile(journalPath,JSON.stringify(journal),{mode:0o600});
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
      if(file.data!==undefined){await mkdir(path.dirname(full),{recursive:true});await safePath(w.source,file.path);const temp=full+'.viewer-'+randomUUID();await writeFile(temp,Buffer.from(file.data,'base64'),{mode:file.result!.mode});await chmod(temp,file.result!.mode);await rename(temp,full);}
      else await unlink(full);
    }
    journal.state='applied';await writeFile(journalPath,JSON.stringify(journal));
    return {state:'applied',revision,files:journal.writes.map(v=>v.path)};
  }
}
