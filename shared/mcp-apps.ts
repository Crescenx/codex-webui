import type { McpUiResourceCsp } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { Item, Obj } from './protocol.ts';

export const appMime = 'text/html;profile=mcp-app';
export type AppTarget = { threadId: string; turnId: string; itemId: string };
export type AppDescription = { title: string; resourceUri: string };
export type AppView = AppDescription & { id: string; sandboxUrl: string; html: string; csp: McpUiResourceCsp; readonly: boolean };
// Encoded images share a thread budget below the existing 8 MB SSE event ceiling.
export const appContextLimit = 6 * 1024 * 1024;
export type AppContext = { content?: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; structuredContent?: Record<string, unknown> };
export type AppContextInput = AppTarget & { context: AppContext };
export function record(value: unknown): Obj {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
}
export function toolResource(tool: unknown): string | undefined {
  const meta = record(record(tool)._meta), uri = record(meta.ui).resourceUri ?? meta['ui/resourceUri'];
  return typeof uri === 'string' && uri.startsWith('ui://') ? uri : undefined;
}
export function itemResource(item: Item): string | undefined {
  const uri = record(item.appContext).resourceUri ?? item.mcpAppResourceUri;
  return typeof uri === 'string' && uri.startsWith('ui://') ? uri : undefined;
}
export function appPath(target: AppTarget) {
  return `/threads/${encodeURIComponent(target.threadId)}/mcp-apps/${encodeURIComponent(target.turnId)}/${encodeURIComponent(target.itemId)}`;
}
export function elicitationFields(params: Obj) {
  if (params.mode !== 'form') return null;
  const schema = record(params.requestedSchema), fields = Object.entries(record(schema.properties));
  if (schema.type !== 'object' || fields.length > 64 || fields.some(([, raw]) => !['string', 'number', 'integer', 'boolean', 'array'].includes(String(record(raw).type)))) return null;
  return fields.map(([name, raw]) => {
    const field = record(raw), options = field.type === 'array' ? record(field.items) : field;
    const choices = Array.isArray(options.enum) ? options.enum.map((value, i) => ({ value: String(value), title: String((options.enumNames as unknown[] | undefined)?.[i] ?? value) }))
      : Array.isArray(options.oneOf) ? options.oneOf.map(raw => ({ value: String(record(raw).const), title: String(record(raw).title ?? record(raw).const) })) : [];
    return { name, type: String(field.type), title: String(field.title || name), description: String(field.description || ''), choices, default: field.default };
  });
}
export function externalUrl(value: unknown): string | undefined {
  try { const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
