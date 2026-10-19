import { realpath, stat, mkdir, readdir, open, unlink, writeFile } from 'node:fs/promises';
import { constants, statSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
export const secret = () => randomBytes(32).toString('base64url');
export function equal(a: string, b: string) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export function inside(root: string, target: string) {
  root = path.resolve(root); target = path.resolve(target);
  const r = path.relative(root, target);
  if (!r || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r))) return true;
  // DrvFS preserves input casing; accept aliases only when the filesystem confirms the same root.
  const prefix = target.slice(0, root.length);
  if (prefix.toLowerCase() !== root.toLowerCase() || (target.length > root.length && target[root.length] !== path.sep)) return false;
  try {
    const a = statSync(root, { bigint: true }), b = statSync(prefix, { bigint: true });
    return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}
export async function directory(value: string, roots: string[]) {
  const p = await realpath(value).catch(() => { throw new HttpError(404, '目录不存在'); });
  if (!roots.some(root => inside(root, p))) throw new HttpError(403, '目录未在 --root 中授权');
  if (!(await stat(p)).isDirectory()) throw new HttpError(400, '请选择目录');
  return p;
}
export async function bytes(req: IncomingMessage, max: number) {
  if (Number(req.headers['content-length']) > max) throw new HttpError(413, '上传过大');
  const chunks: Buffer[] = []; let size = 0;
  for await (const data of req) {
    const chunk = Buffer.from(data); size += chunk.length;
    if (size > max) throw new HttpError(413, '请求过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function imageMime(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8,12).toString() === 'WEBP') return 'image/webp';
}
export type Attachment = { id: string; name: string; size: number; mime: string; path: string; created: number };
export class Uploads {
  private busy = false;
  constructor(root: string) { this.root = root; }
  root: string;
  async init() { await mkdir(this.root, { recursive: true, mode: 0o700 }); await this.cleanup(); }
  async get(id: string): Promise<Attachment> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, '无效附件');
    const metadata = path.join(this.root, id + '.json');
    const handle = await open(metadata, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new HttpError(404, '附件已失效'); });
    let a: Attachment;
    try { a = JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
    if (a.id !== id || path.dirname(a.path) !== this.root || !path.basename(a.path).startsWith(id + '.')) throw new HttpError(400, '附件元数据无效');
    const p = await realpath(a.path);
    if (!inside(this.root, p) || p !== a.path) throw new HttpError(403, '无效附件路径');
    return a;
  }
  async save(req: IncomingMessage, name: string): Promise<Attachment> {
    // ponytail: serialize uploads for exact quota accounting; stream reservations if multi-user is added.
    if (this.busy) throw new HttpError(409, '另一个文件正在上传，请稍后重试');
    this.busy = true;
    try {
      const data = await bytes(req, 25 * 1024 * 1024);
      const files = await readdir(this.root);
      let total = 0;
      for (const file of files) total += (await stat(path.join(this.root, file))).size;
      if (total + data.length > 512 * 1024 * 1024) throw new HttpError(413, '附件空间已达到 512 MB，请清理旧附件');
      name = path.basename(name.replaceAll('\\', '/')).replace(/[\x00-\x1f]/g, '').slice(0, 200) || 'attachment';
      const id = randomUUID();
      const ext = /^\.[a-z0-9]{1,12}$/i.test(path.extname(name)) ? path.extname(name).toLowerCase() : '.bin';
      const mime = imageMime(data) || 'application/octet-stream';
      const a: Attachment = { id, name, mime, size: data.length, path: path.join(this.root, id + ext), created: Date.now() };
      const f = await open(a.path, 'wx', 0o600);
      try { await f.writeFile(data); } finally { await f.close(); }
      const m = await open(path.join(this.root, id + '.json'), 'wx', 0o600);
      try { await m.writeFile(JSON.stringify(a)); } finally { await m.close(); }
      return a;
    } finally { this.busy = false; }
  }
  async cleanup() {
    const files=await readdir(this.root),retained=new Set(files.filter(n=>/^[0-9a-f-]{36}\.retained$/.test(n)).map(n=>n.slice(0,36)));
    for (const name of files) {
      if (!/^[0-9a-f-]{36}\.[a-z0-9]+$/.test(name)) continue;
      if(retained.has(name.slice(0,36)))continue;
      const p = path.join(this.root, name);
      if (Date.now() - (await stat(p)).mtimeMs > 30 * 86400_000) await unlink(p);
    }
  }
  async retainIn(records:unknown) {
    const text=JSON.stringify(records);
    for(const name of await readdir(this.root)) {
      if(!/^[0-9a-f-]{36}\.json$/.test(name))continue;
      const id=name.slice(0,36);
      if(!text.includes(id))continue;
      const file=await this.get(id);
      if(text.includes(file.path))await writeFile(path.join(this.root,id+'.retained'),'Referenced by a hybrid conversation\n',{flag:'wx',mode:0o600}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    }
  }
}
