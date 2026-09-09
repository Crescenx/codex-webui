import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..',import.meta.url));
const root = process.argv[2] || path.join(os.homedir(),'projects');
const quote = (s:string) => '"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%').replaceAll('\n','\\n')+'"';
const dir = path.join(os.homedir(),'.config/systemd/user');
await mkdir(dir,{recursive:true});
// Explicit installation only; never enable/start services as a side effect of npm install.
await writeFile(path.join(dir,'codex-viewer.service'),`[Unit]\nDescription=Local Codex Viewer\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${quote(project)}\nExecStart=${quote(process.execPath)} ${quote(path.join(project,'server/main.ts'))} --root ${quote(root)}\nEnvironment=${quote('PATH='+process.env.PATH)}\nRestart=on-failure\nRestartSec=3\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`,{flag:'wx',mode:0o600});
const result=spawnSync('systemctl',['--user','daemon-reload'],{stdio:'inherit'});
if(result.status!==0) process.exitCode=1;
console.log('Service created, not started. Run: systemctl --user enable --now codex-viewer');
