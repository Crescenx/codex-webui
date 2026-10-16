// Display grouping only. Filesystem access remains validated by the server.
export function workspacePath(path: string): string {
  const clean = path.replace(/\/+$/, '') || '/';
  return /^\/mnt\/[a-z]\//i.test(clean) ? clean.toLowerCase() : clean;
}
export function inWorkspace(root: string, cwd: string): boolean {
  root = workspacePath(root); cwd = workspacePath(cwd);
  return cwd === root || cwd.startsWith(root === '/' ? root : root + '/');
}
