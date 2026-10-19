import type { Thread } from './protocol.ts';

export type RuntimeId = 'codex' | 'antigravity';
export type RuntimeState = { id: RuntimeId; name: string; available: boolean; online: boolean; error?: string };
export type RuntimeCapabilities = { steer: boolean; goals: boolean; skills: boolean; subagents: boolean; watchdogs: boolean; handoff?: boolean };
export const codexCapabilities: RuntimeCapabilities = { steer: true, goals: true, skills: true, subagents: true, watchdogs: true, handoff: false };
export const runtimeOf = (t: Pick<Thread, 'runtimeId'>): RuntimeId => t.runtimeId || 'codex';
export const runtimeName = (t: Pick<Thread, 'runtimeId'>) => runtimeOf(t) === 'codex' ? 'Codex' : 'Antigravity';
export const runtimeForModel = (model: unknown): RuntimeId => typeof model === 'string' && model.startsWith('antigravity/') ? 'antigravity' : 'codex';
export const runtimeForThread = (id: string): RuntimeId => id.startsWith('agy:') ? 'antigravity' : 'codex';
export const runtimeCapabilities = (id: RuntimeId): RuntimeCapabilities => id === 'codex' ? codexCapabilities : { steer: true, goals: true, skills: true, subagents: true, watchdogs: true, handoff: false };
