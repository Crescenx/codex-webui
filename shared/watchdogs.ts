import type { Settings } from './protocol.ts';

export type WatchdogState = 'enabled' | 'paused' | 'completed' | 'needs_input' | 'deleted';
export type WatchdogConfig = { name: string; prompt: string; intervalMinutes: number; model: string; effort: string | null };
export type Watchdog = WatchdogConfig & { id: string; threadId: string; cwd: string; revision: number; state: WatchdogState; createdAt: number; updatedAt: number; nextRunAt: number | null; lastRunAt: number | null; lastSummary: string; running: boolean };
export type WatchdogReport = { outcome: 'continue' | 'complete' | 'needs_input'; summary: string };
export type WatchdogRun = { id: string; watchdogId: string; threadId: string; revision: number; config: WatchdogConfig; foreground: Settings; dueAt: number; startedAt: number; endedAt: number | null; turnId: string | null; status: 'running' | 'completed' | 'failed' | 'uncertain' | 'interrupted'; report: WatchdogReport | null; summary: string };
export const watchdogLabels: Record<WatchdogState, string> = { enabled: '已启用', paused: '已暂停', completed: '已完成', needs_input: '需要处理', deleted: '已删除' };
