import { DatabaseSync } from 'node:sqlite';
import { realpath, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { VaultBinding } from '../shared/vault.ts';
import { HttpError, inside, secret } from './security.ts';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function windowsPath(value: string) {
  if (!/^[a-z]:\\/i.test(value) || /[\x00-\x1f]/.test(value)) throw new HttpError(400, '需要 Windows vault 路径');
  return '/mnt/' + value[0].toLowerCase() + '/' + value.slice(3).replaceAll('\\', '/');
}
export class VaultAssistant {
  db: DatabaseSync;
  constructor(dataDir: string) {
    this.db = new DatabaseSync(path.join(dataDir, 'vault-assistant.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS vaults(id TEXT PRIMARY KEY,name TEXT NOT NULL,root TEXT UNIQUE NOT NULL,windowsRoot TEXT NOT NULL,tokenHash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions(threadId TEXT PRIMARY KEY,vaultId TEXT NOT NULL);');
  }
  all() { return this.db.prepare('SELECT id,name,root,windowsRoot FROM vaults').all() as VaultBinding[]; }
  authenticate(token: string): VaultBinding | undefined { return this.db.prepare('SELECT id,name,root,windowsRoot FROM vaults WHERE tokenHash=?').get(hash(token)) as VaultBinding | undefined; }
  async pair(name: string, windowsRoot: string) {
    if (!name.trim() || name.length > 200 || /[\x00-\x1f]/.test(name)) throw new HttpError(400, '无效 vault 名称');
    const root = await realpath(windowsPath(windowsRoot));
    if (!(await stat(path.join(root, '.obsidian'))).isDirectory()) throw new HttpError(400, '目录不是 Obsidian vault');
    const previous = this.all().find(v => v.root === root), id = previous?.id || randomUUID(), token = secret();
    this.db.prepare('INSERT INTO vaults VALUES(?,?,?,?,?) ON CONFLICT(root) DO UPDATE SET name=excluded.name,windowsRoot=excluded.windowsRoot,tokenHash=excluded.tokenHash').run(id, name, root, windowsRoot, hash(token));
    return { binding: { id, name, root, windowsRoot }, token };
  }
  binding(threadId: string) { return this.db.prepare('SELECT v.id,v.name,v.root,v.windowsRoot FROM vaults v JOIN sessions s ON s.vaultId=v.id WHERE s.threadId=?').get(threadId) as VaultBinding | undefined; }
  bind(threadId: string, vaultId: string) { this.db.prepare('INSERT INTO sessions VALUES(?,?) ON CONFLICT(threadId) DO UPDATE SET vaultId=excluded.vaultId').run(threadId, vaultId); }
  owns(vault: VaultBinding, cwd: string) { return inside(vault.root, cwd); }
  close(){this.db.close();}
}
