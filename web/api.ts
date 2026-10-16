import type { ReferenceCapabilities } from "../shared/references.ts";
import type { Model, Notice, PendingRequest, Skill, Thread } from '../shared/protocol.ts';

export type Attachment = { id: string; name: string; mime: string; size: number };
export type Catalog = { capabilities?: { references?: ReferenceCapabilities }; models: Model[]; modes: { mode: string; name: string }[]; skills: Skill[]; errors: Record<string, string>; skillErrors: unknown[] };
export type Snapshot = { thread: Thread; requests: PendingRequest[]; uncertain?: boolean; seq: number };
export type Update = Notice & { seq?: number };
export type Directories = { roots: string[]; path: string | null; directories: string[] };
export type Preview = { path: string; line: number; start: number; lines: string[]; kind?: 'directory' };

// Each application owns its connection and pending reads; importing this module does nothing.
export function createClient() {
  const pending = new Set<AbortController>();
  let events: EventSource | undefined;
  let disposed = false;
  let unauthorized: Error | undefined;
  let report: (error: unknown) => void = () => {};
  let checkingConnection = false;
  async function request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    if (disposed) throw new DOMException('Client disposed', 'AbortError');
    if (unauthorized) throw unauthorized;
    const controller = new AbortController();
    pending.add(controller);
    try {
      const response = await fetch('/api' + path, { ...init, signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal });
      const result = await response.json();
      if (!response.ok) {
        const error = Object.assign(new Error(result.error || response.statusText), { status: response.status });
        if (response.status === 401 && !unauthorized) {
          unauthorized = error; events?.close(); report(error);
        }
        throw error;
      }
      return result;
    } finally { pending.delete(controller); }
  }
  return {
    request<T>(path: string, data?: unknown, signal?: AbortSignal) {
      return request<T>(path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }, signal);
    },
    upload(file: File) {
      return request<Attachment>('/attachments?name=' + encodeURIComponent(file.name), { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
    },
    subscribe(update: (notice: Update, eventId: string) => void, connection: (online: boolean) => void, error: (error: unknown) => void) {
      events?.close();
      report = error;
      if (disposed || unauthorized) return;
      events = new EventSource('/api/events');
      events.onopen = () => { if (!disposed && !unauthorized) connection(true); };
      events.onerror = () => {
        if (disposed || unauthorized) return;
        connection(false);
        // EventSource hides HTTP status. Probe an existing, cheap authenticated read.
        if (!checkingConnection) {
          checkingConnection = true;
          void request('/watchdogs').catch(() => {}).finally(() => { checkingConnection = false; });
        }
      };
      events.addEventListener('update', event => {
        if (disposed || unauthorized) return;
        try { const message = event as MessageEvent; update(JSON.parse(message.data), message.lastEventId); }
        catch (e) { error(e); }
      });
    },
    dispose() {
      disposed = true; events?.close(); events = undefined;
      for (const controller of pending) controller.abort();
      pending.clear();
    },
  };
}
