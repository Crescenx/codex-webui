import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './security.ts';

export type PermissionMode = 'auto' | 'manual' | 'bypass';
export function permissionMode(value: unknown): PermissionMode | null {
  if (value === null || value === 'auto' || value === 'manual' || value === 'bypass') return value;
  throw new HttpError(400, '审批模式须为 auto、manual、bypass 或 null（跟随配置）');
}
export async function readPermissionMode(dataDir: string, id: string): Promise<PermissionMode | null> {
  try {
    return permissionMode(JSON.parse(await readFile(path.join(dataDir, 'thread-permissions', encodeURIComponent(id) + '.json'), 'utf8')).mode);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function savePermissionMode(dataDir: string, id: string, mode: PermissionMode | null) {
  const dir = path.join(dataDir, 'thread-permissions');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, encodeURIComponent(id) + '.json');
  await writeFile(file + '.tmp', JSON.stringify({ mode }) + '\n', { mode: 0o600 });
  await rename(file + '.tmp', file);
}
export function permissionPolicy(mode: PermissionMode | null, cwd: string) {
  return mode === 'bypass'
    ? { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } }
    : { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } };
}
