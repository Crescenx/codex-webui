import {AppServer} from './adapter.ts';
import {object} from '../shared/protocol.ts';
import type {Obj} from '../shared/protocol.ts';
import {runtimeCapabilities, runtimeForModel, runtimeForThread} from '../shared/runtime.ts';
import type {RuntimeId, RuntimeState} from '../shared/runtime.ts';

const threadPrefix='agy:', modelPrefix='antigravity/', cursorPrefix='viewer-runtimes:';
const bareThread=(id:unknown)=>typeof id==='string'&&id.startsWith(threadPrefix)?id.slice(threadPrefix.length):id;
const bareModel=(model:unknown)=>typeof model==='string'&&model.startsWith(modelPrefix)?model.slice(modelPrefix.length):model;

/** Both providers speak app-server. Only identifiers and transport ownership differ here. */
export class RuntimeServers extends AppServer {
  private codex:AppServer;
  private google?:AppServer;
  private live=new Set<RuntimeId>();
  private usedGoogle=false;
  private requests=new Map<string,{runtime:RuntimeId;id:unknown}>();
  private requestSequence=0;
  private errors=new Map<RuntimeId,string>();
  private catalogReads=new Map<string,{promise:Promise<Obj>;timedOut:boolean}>();
  private lateCatalogResults=new Map<string,{result:Obj;expires:number}>();
  constructor(codex:AppServer,google?:AppServer){
    super();this.codex=codex;this.google=google;
    for(const [runtime,client] of [['codex',codex],['antigravity',google]] as const){
      if(!client)continue;
      client.on('online',()=>{this.live.add(runtime);this.errors.delete(runtime);if(runtime==='codex'){this.child=codex.child;this.emit('online');}else this.emit('runtimeOnline',runtime);});
      client.on('offline',()=>{this.live.delete(runtime);for(const map of [this.catalogReads,this.lateCatalogResults])for(const key of map.keys())if(key.startsWith(`["${runtime}",`))map.delete(key);for(const [key,r] of this.requests)if(r.runtime===runtime)this.requests.delete(key);if(runtime==='codex'){this.child=undefined;this.emit('offline');}else this.emit('runtimeOffline',runtime);});
      client.on('protocolError',()=>this.emit('protocolError',runtime));
      client.on('notice',n=>{
        if(n.method==='native/event')return; // Raw diagnostics stay in the provider journal.
        const params=this.output(n.params,runtime);
        if(runtime==='antigravity'&&n.method==='account/rateLimits/updated'){
          const buckets=object(params.rateLimitsByLimitId||{}),primary=object(params.rateLimits||{});
          if(typeof primary.limitId==='string')buckets[primary.limitId]=primary;
          params.rateLimitsByLimitId=Object.fromEntries(Object.entries(buckets).filter(([id])=>id==='antigravity-google'||id==='antigravity-external'));
          delete params.rateLimits;delete params.rateLimitResetCredits;
        }
        if(n.method==='serverRequest/resolved')for(const [key,r] of this.requests)if(r.runtime===runtime&&r.id===params.requestId){params.requestId=key;this.requests.delete(key);break;}
        this.emit('notice',{...n,params});
      });
      client.on('request',r=>{const id='runtime-request-'+(++this.requestSequence);this.requests.set(id,{runtime,id:r.id});this.emit('request',{...r,id,params:this.output(r.params,runtime)});});
    }
  }
  states():RuntimeState[]{return [{id:'codex',name:'Codex',available:true,online:this.live.has('codex'),error:this.errors.get('codex')},...(this.google?[{id:'antigravity' as const,name:'Antigravity',available:true,online:this.live.has('antigravity'),error:this.errors.get('antigravity')}]:[])];}
  available(runtime:RuntimeId){return runtime==='codex'||!!this.google;}
  override configureLaunch(options:{args?:string[];env?:NodeJS.ProcessEnv}){
    this.codex.configureLaunch(options);
    this.google?.configureLaunch({...options,env:{...options.env,AGY_CLIENT_THREAD_PREFIX:threadPrefix}});
  }
  override async start(){await this.codex.start();this.child=this.codex.child;}
  private client(runtime:RuntimeId){if(runtime==='codex')return this.codex;if(!this.google)throw Object.assign(Error('Antigravity app-server 未配置'),{codexRejected:true});this.usedGoogle=true;return this.google;}
  private thread(raw:unknown):Obj{
    const t=object(raw);
    const parent=typeof t.source==='object'&&t.source?object(object(t.source).subAgent||{}).thread_spawn:undefined;
    const executionUncertain=object(t.status||{}).type==='systemError';
    return {...t,id:threadPrefix+String(t.id),nativeSessionId:t.id,runtimeId:'antigravity',capabilities:runtimeCapabilities('antigravity'),executionUncertain,
      ...(executionUncertain?{runtimeError:'Antigravity 已断开，上次执行结果未知。旧消息不会自动重发；请核对历史后确认恢复。'}:{}),...(typeof t.model==='string'?{model:modelPrefix+t.model}:{}),
      ...(parent && typeof object(parent).parent_thread_id==='string'?{parentThreadId:threadPrefix+object(parent).parent_thread_id}:{}),
      ...(Array.isArray(t.turns)?{turns:t.turns.map(v=>this.turn(v))}:{})};
  }
  private item(raw:unknown):Obj{
    const item=object(raw);
    if(item.type!=='collabAgentToolCall')return item;
    return {...item,
      ...(typeof item.senderThreadId==='string'?{senderThreadId:threadPrefix+item.senderThreadId}:{}),
      ...(Array.isArray(item.receiverThreadIds)?{receiverThreadIds:item.receiverThreadIds.map(id=>threadPrefix+id)}:{}),
      ...(item.agentsStates?{agentsStates:Object.fromEntries(Object.entries(object(item.agentsStates)).map(([id,state])=>[threadPrefix+id,state]))}:{})};
  }
  private turn(raw:unknown):Obj{
    const turn=object(raw),stop=turn.nativeStop as Obj|undefined,nativeError=stop?.error as Obj|undefined;
    const message=nativeError?.modelErrorMessage||nativeError?.shortError;
    return {...turn,
      ...(turn.status==='failed'&&typeof message==='string'?{error:{...(turn.error&&typeof turn.error==='object'?turn.error:{}),message}}:{}),
      ...(Array.isArray(turn.items)?{items:turn.items.map(i=>this.item(i))}:{})};
  }
  private output(raw:Obj,runtime:RuntimeId):Obj{
    if(runtime==='codex')return raw;
    const result={...raw};
    if(typeof result.threadId==='string')result.threadId=threadPrefix+result.threadId;
    if(result.thread)result.thread=this.thread(result.thread);
    if(result.turn)result.turn=this.turn(result.turn);
    if(result.item)result.item=this.item(result.item);
    if(result.goal&&typeof result.goal==='object')result.goal={...object(result.goal),threadId:threadPrefix+String(object(result.goal).threadId)};
    if(typeof result.model==='string')result.model=modelPrefix+result.model;
    if(result.threadSettings){const settings=object(result.threadSettings);result.threadSettings={...settings,...(typeof settings.model==='string'?{model:modelPrefix+settings.model}:{})};}
    return result;
  }
  private async routed(method:string,params:Obj,runtime:RuntimeId):Promise<Obj>{
    const client=this.client(runtime),p={...params};delete p.runtimeId;
    if(runtime==='antigravity'){
      for(const key of ['threadId','ancestorThreadId'])if(key in p)p[key]=bareThread(p[key]);
      if('model' in p)p.model=bareModel(p.model);
      if(p.collaborationMode){const mode=object(p.collaborationMode),settings=object(mode.settings);p.collaborationMode={...mode,settings:{...settings,model:bareModel(settings.model)}};}
    }
    try {
      const result=await client.call(method,p);this.errors.delete(runtime);
      const out=this.output(result,runtime);
      if(runtime==='antigravity'&&method==='thread/list')out.data=(result.data as unknown[]||[]).map(t=>this.thread(t));
      if(runtime==='antigravity'&&method==='thread/loaded/list')out.data=(result.data as string[]||[]).map(id=>threadPrefix+id);
      return out;
    }catch(error){this.errors.set(runtime,error instanceof Error?error.message:String(error));throw error;}
  }
  private async catalogRead(method:string,params:Obj,runtime:RuntimeId):Promise<Obj>{
    const key=JSON.stringify([runtime,method,params]);
    const cached=this.lateCatalogResults.get(key);
    if(cached && cached.expires>Date.now())return cached.result;
    this.lateCatalogResults.delete(key);
    let pending=this.catalogReads.get(key);
    if(!pending){
      pending={promise:this.routed(method,params,runtime),timedOut:false};
      this.catalogReads.set(key,pending);
      const read=pending;
      void read.promise.then(result=>{
        if(this.catalogReads.get(key)!==read)return;
        this.catalogReads.delete(key);
        if(read.timedOut && ['model/list','account/rateLimits/read'].includes(method)){
          // Keep late successes for the refresh they announce, instead of starting another slow read.
          this.lateCatalogResults.set(key,{result,expires:Date.now()+60_000});
          this.emit('notice',{method:'viewer/catalogUpdated',params:{runtimeId:runtime,method}});
        }
      },()=>{if(this.catalogReads.get(key)===read)this.catalogReads.delete(key);});
    }
    const read=pending;
    let timer:NodeJS.Timeout|undefined;
    try{
      return await Promise.race([read.promise,new Promise<Obj>((_,reject)=>{
        timer=setTimeout(()=>{read.timedOut=true;reject(Error(`${runtime} 响应过慢，已先返回其他后端的结果`));},2000);
      })]);
    }catch(error){this.errors.set(runtime,error instanceof Error?error.message:String(error));throw error;}
    finally{clearTimeout(timer);}
  }
  override async call(method:string,params:Obj={}):Promise<Obj>{
    if(method==='account/rateLimits/read'&&!params.runtimeId&&!params.threadId){
      if(!this.google)return this.routed(method,params,'codex');
      const [c,g]=await Promise.allSettled([this.catalogRead(method,params,'codex'),this.catalogRead(method,{},'antigravity')]);
      const codex=c.status==='fulfilled'?c.value:{},google=g.status==='fulfilled'?g.value:{};
      const runtimeErrors:Record<string,string>={};
      for(const [id,result] of [['codex',c],['antigravity',g]] as const)if(result.status==='rejected')runtimeErrors[id]=result.reason instanceof Error?result.reason.message:String(result.reason);
      const original=codex.rateLimitsByLimitId as Obj|null|undefined,primary=codex.rateLimits as Obj|undefined;
      const groups=google.rateLimitsByLimitId as Obj|undefined;
      // Only merge the provider-owned buckets; never replace Codex credits or limits.
      return {...codex,runtimeErrors,rateLimitsByLimitId:{...(!original&&primary?{[String(primary.limitId||'codex')]:primary}:original||{}),
        ...(groups?.['antigravity-google']?{'antigravity-google':groups['antigravity-google']}:{}),
        ...(groups?.['antigravity-external']?{'antigravity-external':groups['antigravity-external']}: {})}};
    }
    if(method==='model/list'){
      const [c,g]=await Promise.allSettled([
        this.catalogRead(method,params,'codex'),
        this.google&&!params.cursor?this.catalogRead(method,{...params,cursor:null},'antigravity'):Promise.resolve({data:[]} as Obj),
      ]);
      if(c.status==='rejected'&&(!this.google||params.cursor||g.status==='rejected'))throw c.reason;
      const codex=c.status==='fulfilled'?c.value:{},runtimeErrors:Record<string,string>={};
      for(const [id,result] of [['codex',c],['antigravity',g]] as const)if(result.status==='rejected')runtimeErrors[id]=result.reason instanceof Error?result.reason.message:String(result.reason);
      const data=(codex.data as Obj[]||[]).map(m=>({...m,runtimeId:'codex'}));
      if(g.status==='fulfilled'){
        let page=g.value;
        do{
          data.push(...(page.data as Obj[]||[]).map(m=>({...m,id:modelPrefix+String(m.id||m.model),model:modelPrefix+String(m.model),displayName:'Antigravity · '+String(m.displayName||m.model),runtimeId:'antigravity',isDefault:false,supportedModes:['default','plan']})));
          if(!page.nextCursor||data.length>=1000)break;
          try{page=await this.catalogRead(method,{...params,cursor:page.nextCursor},'antigravity');}
          catch(error){runtimeErrors.antigravity=error instanceof Error?error.message:String(error);break;}
        }while(true);
      }
      return {...codex,data,runtimeErrors};
    }
    if(['thread/list','thread/loaded/list'].includes(method)&&!params.ancestorThreadId&&this.google){
      if(params.cursor&&!String(params.cursor).startsWith(cursorPrefix))throw Error('Invalid runtime page cursor');
      const page=params.cursor?JSON.parse(Buffer.from(String(params.cursor).slice(cursorPrefix.length),'base64url').toString()):{codex:null,antigravity:null};
      if(params.cursor&&!String(params.cursor).startsWith(cursorPrefix))throw Error('Invalid runtime page cursor');
      if(!page||typeof page!=='object'||!['codex','antigravity'].every(k=>page[k]===null||page[k]===false||typeof page[k]==='string'))throw Error('Invalid runtime page cursor');
      const all:unknown[]=[];const next:Record<string,unknown>={};const runtimeErrors:Record<string,string>={};
      await Promise.all((['codex','antigravity'] as const).map(async runtime=>{
        if(page[runtime]===false){next[runtime]=false;return;}
        try{const r=await this.catalogRead(method,{...params,cursor:page[runtime]},runtime);all.push(...r.data as unknown[]||[]);next[runtime]=r.nextCursor??false;}
        catch(error){next[runtime]=page[runtime];runtimeErrors[runtime]=error instanceof Error?error.message:String(error);}
      }));
      const cursor={codex:next.codex,antigravity:next.antigravity};
      if(method==='thread/list')all.sort((a,b)=>Number(object(b).updatedAt||0)-Number(object(a).updatedAt||0));
      return {data:all,runtimeErrors,nextCursor:Object.values(next).every(v=>v===false)?null:cursorPrefix+Buffer.from(JSON.stringify(cursor)).toString('base64url')};
    }
    const runtime=typeof params.threadId==='string'?runtimeForThread(params.threadId):typeof params.ancestorThreadId==='string'?runtimeForThread(params.ancestorThreadId):params.runtimeId==='antigravity'?'antigravity':runtimeForModel(params.model);
    const model=params.collaborationMode?object(object(params.collaborationMode).settings).model:params.model;
    if(typeof params.threadId==='string'&&typeof model==='string'&&runtimeForModel(model)!==runtime)throw Object.assign(Error('切换后端需要先选择会话绑定'),{codexRejected:true});
    return this.routed(method,params,runtime);
  }
  override respond(id:unknown,result:Obj){const request=this.requests.get(String(id));if(!request)throw Error('Unknown native approval');this.requests.delete(String(id));this.client(request.runtime).respond(request.id,result);}
  override unsupported(id:unknown){const request=this.requests.get(String(id));if(!request)return;this.requests.delete(String(id));this.client(request.runtime).unsupported(request.id);}
  override fork(runtime:RuntimeId='codex'){return this.client(runtime).fork();}
  override async restart(){await Promise.all([this.codex.restart(),...(this.usedGoogle&&this.google?[this.google.restart()]:[])]);this.child=this.codex.child;}
  override stop(){this.codex.stop();this.google?.stop();this.requests.clear();}
}
