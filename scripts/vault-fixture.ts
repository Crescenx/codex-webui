import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';
const root='/mnt/d/plugins/yaoshi/test-vault';
const app=await serve({roots:[root],dataDir:'/tmp/vault-assistant-fixture/data',runtimeDir:'/tmp/vault-assistant-fixture/run',port:8788,adapter:new AppServer({command:process.execPath,args:[new URL('../test/fake-codex.ts',import.meta.url).pathname]})});
console.log('Vault Assistant fixture on '+app.origin);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>void app.stop().then(()=>process.exit()));
