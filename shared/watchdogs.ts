import type { Settings } from './protocol.ts';

export type WatchdogState = 'enabled' | 'paused' | 'completed' | 'needs_input' | 'deleted';
export type WatchdogSchedule =
  | { kind: 'daily'; everyDays: number; startDate: string; time: string }
  | { kind: 'weekly'; weekdays: readonly number[]; time: string }
  | { kind: 'once'; at: string };
export type WatchdogConfig = { name: string; prompt: string; model: string; effort: string | null } & (
  | { intervalMinutes: number; schedule?: never }
  | { schedule: WatchdogSchedule; intervalMinutes?: never }
);
export type Watchdog = WatchdogConfig & { id: string; threadId: string; cwd: string; revision: number; state: WatchdogState; createdAt: number; updatedAt: number; nextRunAt: number | null; lastRunAt: number | null; lastSummary: string; running: boolean };
export type WatchdogNext = { revision: number; delayMinutes?: number; intervalMinutes?: number; schedule?: WatchdogSchedule; prompt?: string };
export type WatchdogReport = { outcome: 'continue' | 'complete' | 'needs_input'; summary?: string; next?: WatchdogNext };
export type WatchdogRun = { id: string; watchdogId: string; threadId: string; revision: number; config: WatchdogConfig; foreground: Settings; dueAt: number; startedAt: number; endedAt: number | null; turnId: string | null; status: 'running' | 'completed' | 'failed' | 'uncertain' | 'interrupted'; report: WatchdogReport | null; summary: string };
export const watchdogLabels: Record<WatchdogState, string> = { enabled: '已启用', paused: '已暂停', completed: '已完成', needs_input: '需要处理', deleted: '已删除' };
