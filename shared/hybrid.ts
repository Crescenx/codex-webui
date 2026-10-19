import type { RuntimeId } from './runtime.ts';

export type HandoffRecord = { id:string; from:RuntimeId; to:RuntimeId; at:number; state:'preparing'|'accepted'|'unknown'|'failed'; error?:string; deliveredRecords:number; availableRecords:number };
export type AgentWorkspace = { root:string; cwd:string; source:string; excluded:string[] };
export type ManagedAgent = { parentId:string; task:string; workspace:AgentWorkspace; state:'pendingInit'|'running'|'completed'|'interrupted'|'errored'|'unknown'|'shutdown'; resultRevision:number; deliveredRevision:number; deliveryState?:'pending'|'sending'|'delivered'|'unknown'; applyState?:'applying'|'applied'|'conflict'|'unknown'; error?:string };
export type HybridInfo = { activeSessionId:string; bindings:{runtimeId:RuntimeId; sessionId:string}[]; handoffs:HandoffRecord[]; locked:boolean; agent?:ManagedAgent };
