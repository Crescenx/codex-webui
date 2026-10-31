import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..',import.meta.url));
if (/[\r\n]/.test(project)) throw new Error('The service project path cannot contain line breaks');
const root = path.resolve(process.argv[2] || path.join(os.homedir(),'projects'));
const quote = (s:string) => '"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%').replaceAll('\n','\\n')+'"';
// WSL_INTEROP is a per-session socket; only persist the distro and environment forwarding rules.
const environment = ['PATH','CODEX_HOME','XDG_DATA_HOME','VIEWER_PWSH','VIEWER_AGY_BINARY','AGY_APP_CORE_BINARY','AGY_APP_AUTH_HOME','WSL_DISTRO_NAME','WSLENV','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy']
  .filter(key => process.env[key] !== undefined).map(key => `Environment=${quote(key+'='+process.env[key])}`).join('\n');
const dir = path.join(os.homedir(),'.config/systemd/user');
await mkdir(dir,{recursive:true});
// Explicit installation only; never enable/start services as a side effect of npm install.
await writeFile(path.join(dir,'codex-viewer.service'),`[Unit]\nDescription=Local Codex Viewer\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${project.replaceAll('%','%%')}\nExecStart=${quote(process.execPath)} ${quote(path.join(project,'server/main.ts'))} --root ${quote(root)}\n${environment}\nRestart=on-failure\nRestartSec=3\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`,{flag:'wx',mode:0o600});
const result=spawnSync('systemctl',['--user','daemon-reload'],{stdio:'inherit'});
if(result.status!==0) process.exitCode=1;
console.log('Service created, not started. Run: systemctl --user enable --now codex-viewer');
