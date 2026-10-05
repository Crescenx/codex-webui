import { writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { serve, restartProcess } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';

const dir = process.argv[2];
const marker = await readFile(dir + '/version', 'utf8');
const app = await serve({ roots: [dir], dataDir: dir + '/data', runtimeDir: dir + '/run', port: 0,
  staticDir: dir + '/static',
  adapter: new AppServer({ command: process.execPath, args: [path.resolve('test/fake-codex.ts')], env: { ...process.env, VIEWER_RESTART_STATE: undefined, VIEWER_FAKE_STATE: dir + '/state.json' } }),
  restart: state => restartProcess(app, state),
});
await app.adapter.start();
await writeFile(dir + '/boot.json', JSON.stringify({ instance: randomUUID(), marker, pid: process.pid, codexPid: app.adapter.child!.pid, launchUrl: app.launchUrl, origin: app.origin }));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.stop().then(() => process.exit()); });
