import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { object, string } from './protocol.ts';
import type { Obj } from './protocol.ts';

export class AppServer extends EventEmitter {
  child?: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<number, { resolve: (v: Obj) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private starting?: Promise<void>;
  private buffer = '';
  private closed = false;
  constructor(privateOptions: { command?: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
    super(); this.options = privateOptions;
  }
  private options: { command?: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv };
  async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.closed) throw new Error('App Server stopped');
    this.starting = this.launch();
    try { await this.starting; } catch (error) { this.child?.kill(); this.starting = undefined; throw error; }
  }
  private async launch(): Promise<void> {
    this.buffer = '';
    const child = spawn(this.options.command || 'codex', this.options.args || ['app-server', '--listen', 'stdio://'], {
      cwd: this.options.cwd, env: this.options.env || process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return;
      this.buffer += chunk;
      if (this.buffer.length > 32_000_000) { child.kill(); return; }
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (line.trim()) this.receive(line);
      }
    });
    // Never send stderr (which may contain host paths or credentials) to the browser.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    const failed = (error: Error) => {
      if (this.child !== child) return;
      this.child = undefined; this.starting = undefined;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear(); this.emit('offline');
    };
    child.once('error', failed);
    child.once('exit', () => failed(new Error('Codex process exited; previous actions will not be replayed')));
    await this.raw('initialize', { clientInfo: { name: 'codex_viewer', title: 'Codex Viewer', version: '0.2.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized' });
    this.emit('online');
  }
  private receive(line: string) {
    try {
      const m = object(JSON.parse(line));
      if (typeof m.method === 'string') {
        const params = object(m.params ?? {});
        this.emit(m.id !== undefined ? 'request' : 'notice', { ...m, params });
      } else if (typeof m.id === 'number') {
        const p = this.pending.get(m.id); if (!p) return;
        clearTimeout(p.timer); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(string(object(m.error).message)));
        else p.resolve(object(m.result ?? {}));
      }
    } catch { this.emit('protocolError'); this.child?.kill(); }
  }
  private send(value: unknown) {
    if (!this.child?.stdin.writable) throw new Error('Codex is offline');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  private raw(method: string, params: Obj): Promise<Obj> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex request timed out; check state before retrying')); }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async call(method: string, params: Obj = {}): Promise<Obj> { await this.start(); return this.raw(method, params); }
  respond(id: unknown, result: Obj) { this.send({ id, result }); }
  unsupported(id: unknown) { this.send({ id, error: { code: -32601, message: 'This client does not support this request' } }); }
  stop() { this.closed = true; this.child?.kill(); }
}
