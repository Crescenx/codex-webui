import MarkdownWorker from '@markdown-worker';
import { materialVault, materialVaultRoot } from './environment.ts';
import type { Rendered, MarkdownContext } from './markdown.ts';
import type { MathDefinitions } from '../shared/tex-macros.ts';

let worker:Worker|undefined,sequence=0;
type Job={id:number;key:string;source:string;threadId?:string;context:MarkdownContext;resolve:(value:Rendered)=>void;reject:(error:Error)=>void};
const queued=new Map<string,Job>();
const owners=new Set<string>();
let active:Job|undefined;
export function markdownContextKey(mathDefinitions?:MathDefinitions){return JSON.stringify([materialVault(),materialVaultRoot(),mathDefinitions||{}]);}
function pump(){
  if(active||!queued.size)return;
  if(!worker){
    worker=new MarkdownWorker();
    worker.onmessage=event=>{
      const {id,result,error}=event.data,job=active;if(!job||job.id!==id)return;
      active=undefined;if(error)job.reject(new Error(error));else job.resolve(result);pump();
    };
    worker.onerror=event=>{
      const error=new Error(event.message||'Markdown worker failed');
      active?.reject(error);active=undefined;
      for(const job of queued.values())job.reject(error);
      queued.clear();worker?.terminate();worker=undefined;
    };
  }
  active=queued.values().next().value!;queued.delete(active.key);
  const {resolve,reject,...message}=active;
  try{worker.postMessage(message);}
  catch(error){active=undefined;reject(error as Error);pump();}
}
function cancelJob(key:string){
  const error=new DOMException('Superseded Markdown render','AbortError');
  queued.get(key)?.reject(error);queued.delete(key);
  if(active?.key===key)active.reject(error);
}
export function cancelMarkdown(key:string){
  cancelJob(key);owners.delete(key);
  if(!owners.size){worker?.terminate();worker=undefined;active=undefined;}
}
export function renderMarkdownAsync(key:string,source:string,threadId?:string,mathDefinitions?:MathDefinitions):Promise<Rendered>{
  cancelJob(key);owners.add(key);
  const id=++sequence;
  return new Promise((resolve,reject)=>{
    queued.set(key,{id,key,source,threadId,context:{vault:materialVault(),vaultRoot:materialVaultRoot(),mathDefinitions},resolve,reject});
    try{pump();}catch(error){queued.delete(key);reject(error);}
  });
}
