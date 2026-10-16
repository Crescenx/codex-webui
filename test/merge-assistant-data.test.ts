import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { mergeAssistantData } from '../scripts/merge-assistant-data.ts';

test('assistant migration retains WAL records, viewer records and files; reruns are idempotent and conflicts fail',async()=>{
 const root=await mkdtemp('/tmp/viewer-merge-'),a=root+'/assistant',b=root+'/viewer';
 await mkdir(a);await mkdir(b);
 const init=(dir:string)=>{const db=new DatabaseSync(dir+'/references.sqlite');db.exec('PRAGMA journal_mode=WAL; CREATE TABLE refs(id TEXT PRIMARY KEY,target TEXT,data TEXT); CREATE TABLE reference_deliveries(target TEXT,id TEXT,data TEXT,PRIMARY KEY(target,id));');return db;};
 const source=init(a),target=init(b);
 try{
  source.prepare('INSERT INTO refs VALUES(?,?,?)').run('a','project','source');target.prepare('INSERT INTO refs VALUES(?,?,?)').run('b','vault','existing');
  await mkdir(a+'/attachments');await writeFile(a+'/attachments/file','attachment');
  await writeFile(a+'/attachments/meta.json',JSON.stringify({path:a+'/attachments/file'}));
  await mergeAssistantData(a,b,root+'/backup');
  assert.equal(target.prepare('SELECT COUNT(*) AS n FROM refs').get()!.n,2);
  assert.equal(await readFile(b+'/attachments/file','utf8'),'attachment');
  assert.equal(JSON.parse(await readFile(b+'/attachments/meta.json','utf8')).path,b+'/attachments/file');
  await mergeAssistantData(a,b,root+'/backup-again');assert.equal(target.prepare('SELECT COUNT(*) AS n FROM refs').get()!.n,2);
  target.prepare('UPDATE refs SET data=? WHERE id=?').run('different','a');
  await assert.rejects(mergeAssistantData(a,b,root+'/conflict'),/Data conflict/);
  assert.equal(target.prepare('SELECT data FROM refs WHERE id=?').get('a')!.data,'different');
 }finally{source.close();target.close();await rm(root,{recursive:true,force:true});}
});
