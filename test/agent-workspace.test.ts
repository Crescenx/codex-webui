import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,open,stat,chmod} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AgentWorkspaces} from '../server/agent-workspace.ts';

test('new copies omit run history but retain task data and executable modes',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-history-'));
  try{
    const source=dir+'/source';
    await mkdir(source+'/.runs/old',{recursive:true});await writeFile(source+'/.runs/old/data','history');
    await mkdir(source+'/data',{recursive:true});await writeFile(source+'/data/input','task input');
    await writeFile(source+'/run.sh','echo hello\n');await chmod(source+'/run.sh',0o751);
    const manager=new AgentWorkspaces(dir+'/copies'),w=await manager.create(source,source);
    assert.ok(w.excluded.includes('.runs'));
    await assert.rejects(stat(w.cwd+'/.runs'),{code:'ENOENT'});
    assert.equal(await readFile(w.cwd+'/data/input','utf8'),'task input');
    assert.equal((await stat(w.cwd+'/run.sh')).mode&0o777,0o751);
    await mkdir(w.cwd+'/.runs/generated',{recursive:true});await writeFile(w.cwd+'/.runs/generated/output','new history');
    assert.deepEqual((await manager.changes(w)).changes,[]);

    // An older baseline may include history; upgrading must not delete it from the source.
    await mkdir(w.cwd+'/.runs/old',{recursive:true});await writeFile(w.cwd+'/.runs/old/data','history');
    const baseline=JSON.parse(await readFile(w.root+'/baseline.json','utf8'));
    baseline['.runs/old/data']={hash:createHash('sha256').update('history').digest('hex'),mode:(await stat(w.cwd+'/.runs/old/data')).mode&0o777};
    await writeFile(w.root+'/baseline.json',JSON.stringify(baseline));
    await rm(w.cwd+'/.runs/generated',{recursive:true});
    assert.deepEqual((await manager.changes(w)).changes,[]);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('file-backed apply journals recover independently of child files and detect altered payloads',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-payload-'));
  try{
    const source=dir+'/source';await mkdir(source);await writeFile(source+'/a','before');
    const manager=new AgentWorkspaces(dir+'/copies'),w=await manager.create(source,source);
    await writeFile(w.cwd+'/a','after');const diff=await manager.changes(w);
    await manager.apply(w,'first',diff.revision);
    const journal=JSON.parse(await readFile(w.root+'/apply-first.json','utf8'));
    assert.ok(journal.writes[0].payload);assert.equal(journal.writes[0].data,undefined);
    await writeFile(w.cwd+'/a','later child edit');await writeFile(source+'/a','before');
    journal.state='applying';await writeFile(w.root+'/apply-recover.json',JSON.stringify({...journal,id:'recover'}));
    await manager.apply(w,'recover',diff.revision);assert.equal(await readFile(source+'/a','utf8'),'after');
    await writeFile(source+'/a','before');await writeFile(w.root+'/'+journal.writes[0].payload,'tampered');
    await writeFile(w.root+'/apply-tampered.json',JSON.stringify({...journal,id:'tampered'}));
    await assert.rejects(manager.apply(w,'tampered',diff.revision),/载荷发生变化/);
    assert.equal(await readFile(source+'/a','utf8'),'before');
    assert.deepEqual(await readdir(source),['a']);

    const data=Buffer.from('legacy').toString('base64'),result={hash:createHash('sha256').update('legacy').digest('hex'),mode:0o644};
    await writeFile(w.root+'/apply-legacy.json',JSON.stringify({id:'legacy',state:'applying',revision:'legacy',writes:[{path:'a',expected:journal.writes[0].expected,result,data}]}));
    await manager.apply(w,'legacy','legacy');assert.equal(await readFile(source+'/a','utf8'),'legacy');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('three-way merging text above the old size threshold preserves both edits',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-large-merge-'));
  try{
    const source=dir+'/source';await mkdir(source);
    const base='first\n'+'unchanged line\n'.repeat(150000)+'last\n';
    await writeFile(source+'/a',base);
    const manager=new AgentWorkspaces(dir+'/copies'),w=await manager.create(source,source);
    await writeFile(w.cwd+'/a',base.replace('first','child'));await writeFile(source+'/a',base.replace('last','parent'));
    const diff=await manager.changes(w);await manager.apply(w,'merge',diff.revision);
    assert.equal(await readFile(source+'/a','utf8'),base.replace('first','child').replace('last','parent'));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('conflicting binary edits leave the source intact and remove unused apply payloads',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-binary-conflict-'));
  try{
    const source=dir+'/source';await mkdir(source);await writeFile(source+'/a',Buffer.from([0,1]));
    const manager=new AgentWorkspaces(dir+'/copies'),w=await manager.create(source,source);
    await writeFile(w.cwd+'/a',Buffer.from([0,2]));await writeFile(source+'/a',Buffer.from([0,3]));
    const diff=await manager.changes(w);await assert.rejects(manager.apply(w,'binary',diff.revision),/冲突/);
    assert.deepEqual(await readFile(source+'/a'),Buffer.from([0,3]));
    assert.deepEqual((await readdir(w.root)).filter(name=>name.startsWith('payload-')||name.startsWith('merge-')),[]);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('copies over 50000 files and 2 GiB support isolated edits and file-backed apply',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'viewer-large-copy-'));
  try{
    const source=dir+'/source';await mkdir(source);
    const size=2*1024**3+1,file=await open(source+'/large.bin','w');
    try{await file.truncate(size);}finally{await file.close();}
    // Directory batches bound active filesystem operations, without truncating the input.
    for(let first=0;first<50001;first+=100){
      await Promise.all(Array.from({length:Math.min(100,50001-first)},(_,i)=>writeFile(source+'/file-'+(first+i),'')));
    }
    const manager=new AgentWorkspaces(dir+'/copies'),w=await manager.create(source,source);
    assert.equal((await readdir(w.cwd)).filter(name=>name!=='.git').length,50002);
    assert.equal((await stat(w.cwd+'/large.bin')).size,size);
    const child=await open(w.cwd+'/large.bin','r+');
    try{await child.write(Buffer.from([42]),0,1,size-1);}finally{await child.close();}
    const parent=await open(source+'/large.bin','r');
    try{const buffer=Buffer.alloc(1);await parent.read(buffer,0,1,size-1);assert.equal(buffer[0],0);}finally{await parent.close();}
    const diff=await manager.changes(w);assert.deepEqual(diff.changes.map(c=>c.path),['large.bin']);
    await manager.apply(w,'large',diff.revision);
    const applied=await open(source+'/large.bin','r');
    try{const buffer=Buffer.alloc(1);await applied.read(buffer,0,1,size-1);assert.equal(buffer[0],42);}finally{await applied.close();}
    assert.equal((await stat(w.root+'/apply-large.json')).size<1024,true);
    t.diagnostic('Peak RSS: '+Math.round(process.resourceUsage().maxRSS/1024)+' MiB; journal: '+(await stat(w.root+'/apply-large.json')).size+' bytes');
  }finally{await rm(dir,{recursive:true,force:true});}
});
