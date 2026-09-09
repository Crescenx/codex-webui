import type { Item, Turn } from '../server/protocol.ts';
export function activity(item:Item,turn:Turn) {
  let state=item.status==='failed'||item.status==='declined'||typeof item.exitCode==='number'&&item.exitCode!==0?'failed':item.status==='inProgress'?'running':item.status==='completed'?'completed':item.viewerState||'unknown';
  if(state==='running' && turn.status!=='inProgress')state=turn.status==='completed'?'unknown':turn.status==='failed'?'failed':'cancelled';
  if(state==='unknown' && turn.status==='completed')state='completed';
  const action=item.action as {type?:string;query?:string;queries?:string[];url?:string}|undefined;
  const title=item.type==='reasoning'?(state==='running'?'思考中':'思考结束'):
    item.type==='webSearch'?(action?.type==='openPage'?'打开网页：'+(action.url||''):'搜索：'+(item.query||action?.query||action?.queries?.join('、')||'网页')):
    item.type==='commandExecution'?'执行命令：'+(item.command||''):
    item.type==='fileChange'?'修改文件':item.type==='mcpToolCall'?`工具：${item.server||''} / ${item.tool||''}`:
    item.type==='contextCompaction'?'压缩上下文':String(item.tool||item.type);
  let detail=item.type==='reasoning'?(item.summary||[]).filter(Boolean).join('\n\n'):
    item.type==='commandExecution'?String(item.aggregatedOutput||''):
    item.type==='webSearch'?(action?Object.entries(action).filter(([k,v])=>k!=='type'&&v).map(([k,v])=>`${k}: ${Array.isArray(v)?v.join('\n'):v}`).join('\n'):''):
    JSON.stringify(item.result||item.error||item.changes||'',null,2);
  if(detail==='""')detail='';
  const [label,subject]=item.type==='commandExecution'?['命令',String(item.command||'')]:
    item.type==='webSearch'?[action?.type==='openPage'?'网页':'搜索',String(item.query||action?.query||action?.queries?.join('、')||action?.url||'网页')]:[String(title),''];
  return {state,title:String(title),label,subject,detail};
}
