import type { Item, Turn } from '../shared/protocol.ts';
export function activityState(item:Item,turn:Turn) {
  const failed = item.status === 'failed' || item.status === 'declined' || typeof item.exitCode === 'number' && item.exitCode !== 0;
  let state = item.viewerState || 'unknown';
  if (failed) state = 'failed';
  else if (item.status === 'inProgress') state = 'running';
  else if (item.status === 'completed') state = 'completed';
  if(state==='running' && turn.status!=='inProgress')state=turn.status==='completed'?'unknown':turn.status==='failed'?'failed':'cancelled';
  if(state==='unknown' && turn.status==='completed')state='completed';
  return state;
}
export function activity(item:Item,turn:Turn) {
  const state = activityState(item, turn);

  const action=item.action as {type?:string;query?:string;queries?:string[];url?:string}|undefined;
  const title=item.type==='reasoning'?(state==='running'?'思考中':'思考'):
    item.type==='webSearch'?(action?.type==='openPage'?'打开网页：'+(action.url||''):'搜索：'+(item.query||action?.query||action?.queries?.join('、')||'网页')):
    item.type==='commandExecution'?'执行命令：'+(item.command||''):
    item.type==='fileChange'?'修改文件':item.type==='mcpToolCall'?`工具：${item.server||''} / ${item.tool||''}`:
    item.type==='contextCompaction'?'压缩上下文':item.type==='collabAgentToolCall'?`子代理调用：${item.tool || ''}`:item.type==='subAgentActivity'?`子代理活动：${item.agentPath || item.agentThreadId || ''}`:String(item.tool||item.type);
  let detail=item.type==='reasoning'?(item.summary||[]).filter(Boolean).join('\n\n'):
    item.type==='commandExecution'?String(item.aggregatedOutput||''):
    item.type==='webSearch'?(action?Object.entries(action).filter(([k,v])=>k!=='type'&&v).map(([k,v])=>`${k}: ${Array.isArray(v)?v.join('\n'):v}`).join('\n'):''):
    item.type==='collabAgentToolCall'?[item.prompt, Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.join('、') : '', '调用状态不代表子代理执行状态，请查看右侧面板。'].filter(Boolean).join('\n\n'):
    item.type==='fileChange'?'':JSON.stringify(item.result||item.error||item.changes||'',null,2);
  if(detail==='""')detail='';
  const resultSummary = item.result && typeof item.result === 'object' ? (item.result as {summary?:unknown}).summary : undefined;
  const toolSummary = typeof resultSummary === 'string' ? resultSummary.trim() : '';
  const [label,subject]=item.type==='commandExecution'?['命令',String(item.command||'')]:
    item.type==='webSearch'?[action?.type==='openPage'?'网页':'搜索',String(item.query||action?.query||action?.queries?.join('、')||action?.url||'网页')]:[String(title),toolSummary];
  return {state,title:String(title),label,subject,detail};
}
