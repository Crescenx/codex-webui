import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { Model, Obj } from '../shared/protocol.ts';

export const contextKey = 'features.context_management.experimental_mode';

export async function contextModels(models: Model[], codexHome: string): Promise<Model[]> {
  let capabilities = new Map<string, boolean>();
  try {
    // ponytail: model/list omits this capability in CLI 0.154; use its local catalog until RPC exposes it.
    const cache = JSON.parse(await readFile(path.join(codexHome, 'models_cache.json'), 'utf8'));
    const age = Date.now() - Date.parse(cache.fetched_at);
    if (age >= -60_000 && age < 86400_000 && Array.isArray(cache.models)) capabilities = new Map(cache.models
      .filter((m: Obj) => typeof m.slug === 'string' && typeof m.supports_experimental_context === 'boolean')
      .map((m: Obj) => [m.slug, m.supports_experimental_context]));
  } catch { /* Missing, stale or invalid capability data means unknown, never supported. */ }
  return models.map(m => ({ ...m, supportsExperimentalContext: typeof m.supportsExperimentalContext === 'boolean' ? m.supportsExperimentalContext : capabilities.get(m.model) ?? null }));
}

export function contextReason(account: Obj, config: Obj): string {
  const a = account.account as Obj | null;
  if (a?.type !== 'chatgpt') return '实验上下文管理需要 ChatGPT 登录';
  if (!['plus', 'pro', 'prolite'].includes(String(a.planType))) return '实验上下文管理需要 Plus、Pro 或 Pro Lite 订阅';
  if (config.model_provider && config.model_provider !== 'openai') return '当前项目使用的模型提供方不支持实验上下文管理';
  return '';
}

// Persist per thread, so simultaneous creations cannot overwrite each other's choices.
export async function readContextChoice(dataDir: string, id: string): Promise<boolean | undefined> {
  try {
    const value = JSON.parse(await readFile(path.join(dataDir, 'thread-settings', encodeURIComponent(id) + '.json'), 'utf8'));
    if (typeof value.contextManagement !== 'boolean') throw new Error('会话上下文设置损坏');
    return value.contextManagement;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}

export async function saveContextChoice(dataDir: string, id: string, enabled: boolean) {
  const dir = path.join(dataDir, 'thread-settings'); await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, encodeURIComponent(id) + '.json');
  await writeFile(file + '.tmp', JSON.stringify({ contextManagement: enabled }) + '\n', { mode: 0o600 });
  await rename(file + '.tmp', file);
}
