import { request as httpRequest } from 'node:http';
import type { createClient, Attachment, Update } from '../web/api.ts';
import type { VaultBinding } from '../shared/vault.ts';
import type { Obj } from '../shared/protocol.ts';
export type DesktopHost = {
  endpoint: string; token: string; binding: VaultBinding;
  open(target:string):Promise<void>;
};
export function desktopClient(host: DesktopHost): ReturnType<typeof createClient> {
  let disposed=false, stream: ReturnType<typeof httpRequest>|undefined, retry:ReturnType<typeof setTimeout>|undefined, lastId='';
  const requests=new Set<ReturnType<typeof httpRequest>>();
  async function raw<T>(pathname:string,data?:unknown,signal?:AbortSignal,binary?:Buffer):Promise<T> {
    if(disposed)throw new Error('连接已关闭');
    return new Promise<T>((resolve,reject)=>{
      const url=new URL('/api'+pathname,host.endpoint), payload=binary || (data===undefined?undefined:Buffer.from(JSON.stringify(data)));
      const req=httpRequest(url,{method:payload?'POST':'GET',headers:{Authorization:'Bearer '+host.token,...(payload?{'Content-Type':binary?'application/octet-stream':'application/json','Content-Length':String(payload.length)}:{})},signal},res=>{
        let body='';res.setEncoding('utf8');res.on('data',chunk=>{body+=chunk;if(body.length>12000000)req.destroy(new Error('响应过大'));});
        res.on('end',()=>{try{const value=JSON.parse(body);if(res.statusCode!==200)reject(Object.assign(new Error(value.error||'请求失败'),{status:res.statusCode}));else resolve(value);}catch(e){reject(e);}});
        res.on('error',reject);
      });
      requests.add(req);req.on('close',()=>requests.delete(req));req.on('error',reject);req.setTimeout(60000,()=>req.destroy(new Error('请求超时；请核实状态，不要重复写入')));req.end(payload);
    });
  }
  return {
    async request<T>(pathname:string,data?:unknown,signal?:AbortSignal,method: 'POST' | 'PUT' = 'POST'):Promise<T>{
      if(method==='PUT')throw new Error('请在浏览器 Viewer 中调整审批方式');
      if(pathname==='/files/open' && data){
        const {threadId,target}=data as Obj;
        const fragment=/#(?!L\d+$).*$/.exec(String(target))?.[0] || '';
        const resolvedTarget=fragment?String(target).slice(0,-fragment.length):String(target);
        const file=await raw<{path:string;line:number;kind:string}>('/files/open',{threadId,target:resolvedTarget,resolveOnly:true},signal);
        if(file.kind!=='directory' && file.path.startsWith(host.binding.root+'/')){
          const suffix=fragment || (file.line>1?':'+file.line:'');
          await host.open(file.path+suffix);return {ok:true} as T;
        }
        return raw<T>(pathname,{...(data as Obj),target:resolvedTarget},signal);
      }
      return raw<T>(pathname,data,signal);
    },
    async upload(file:File){return raw<Attachment>('/attachments?name='+encodeURIComponent(file.name),undefined,undefined,Buffer.from(await file.arrayBuffer()));},
    subscribe(update,connection,error){
      stream?.destroy();clearTimeout(retry);
      const connect=()=>{
        if(disposed)return;
        const req=httpRequest(new URL('/api/events',host.endpoint),{headers:{Authorization:'Bearer '+host.token,...(lastId?{'Last-Event-ID':lastId}:{})}},res=>{
          if(res.statusCode!==200){res.resume();error(new Error('助手连接失效，请重新配对'));return;}
          connection(true);let buffer='';
          res.setEncoding('utf8');
          res.on('data',chunk=>{
            buffer+=chunk;if(buffer.length>10000000){req.destroy(new Error('事件过大'));return;}
            let i:number;
            while((i=buffer.indexOf('\n\n'))>=0){
              const frame=buffer.slice(0,i);buffer=buffer.slice(i+2);
              // SSE fields end at LF; Unicode line/paragraph separators belong to the JSON text.
              const lines=frame.split('\n'),id=lines.find(line=>line.startsWith('id: '))?.slice(4),data=lines.filter(line=>line.startsWith('data: ')).map(line=>line.slice(6)).join('\n');if(!data)continue;
              try{const n=JSON.parse(data) as Update;if(id)lastId=id;update(n,lastId);}catch(e){error(e);}
            }
          });
          res.on('error',e=>error(e));
          res.on('end',()=>{connection(false);if(!disposed)retry=setTimeout(connect,1500);});
        });
        stream=req;req.on('error',e=>{if(disposed)return;connection(false);error(e);retry=setTimeout(connect,1500);});req.end();
      };connect();
    },
    dispose(){disposed=true;clearTimeout(retry);stream?.destroy();for(const r of requests)r.destroy();requests.clear();},
  };
}
