import { renderMarkdown } from './markdown.ts';
import type { MarkdownContext } from './markdown.ts';

const caches=new Map<string,Map<string,string>>();
self.onmessage=(event:MessageEvent<{id:number;key:string;source:string;threadId?:string;context:MarkdownContext}>)=>{
  const {id,key,source,threadId,context}=event.data;
  const cache=caches.get(key)||new Map<string,string>();
  caches.delete(key);caches.set(key,cache);
  while(caches.size>8)caches.delete(caches.keys().next().value!);
  try{self.postMessage({id,result:renderMarkdown(source,threadId,cache,context)});}
  catch(error){self.postMessage({id,error:String(error)});}
};
