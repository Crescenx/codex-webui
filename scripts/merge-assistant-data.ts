import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readdir, readFile, copyFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run after the old assistant is stopped and both backends have finished their tasks.
export async function mergeAssistantData(source: string, target: string, backupDir: string) {
  source=path.resolve(source);target=path.resolve(target);
  if(source===target)throw new Error('Source and target must differ');
  const databases: {name:string;tables:string[]}[]=[
    {name:'vault-assistant.sqlite',tables:['vaults','sessions']},
    {name:'references.sqlite',tables:['refs','reference_deliveries']},
    {name:'watchdogs.sqlite',tables:['watchdogs','watchdog_runs']},
  ];
  const exists=async(file:string)=>{try{await readFile(file);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}};
  const copies:{from:string;to:string;data?:Buffer}[]=[],merges:{name:string;tables:string[];present:boolean}[]=[];
  // Preflight every collision before changing any existing data. Never choose a winner silently.
  for(const {name,tables} of databases){
    if(!await exists(path.join(source,name)))continue;
    const from=new DatabaseSync(path.join(source,name),{readOnly:true}),present=await exists(path.join(target,name));
    const to=present?new DatabaseSync(path.join(target,name),{readOnly:true}):undefined;
    try{
      for(const table of tables){
        const columns=from.prepare(`PRAGMA table_info(${table})`).all();
        if(!columns.length)throw new Error('Missing source table: '+table);
        if(!to)continue;
        const targetColumns=to.prepare(`PRAGMA table_info(${table})`).all();
        if(JSON.stringify(columns)!==JSON.stringify(targetColumns))throw new Error('Schema conflict: '+table);
        const keys=columns.filter(c=>c.pk).map(c=>String(c.name));
        if(!keys.length)throw new Error('Missing primary key: '+table);
        for(const row of from.prepare(`SELECT * FROM ${table}`).all()){
          const old=to.prepare(`SELECT * FROM ${table} WHERE ${keys.map(k=>k+'=?').join(' AND ')}`).get(...keys.map(k=>row[k]));
          if(old && JSON.stringify(old)!==JSON.stringify(row))throw new Error('Data conflict: '+name+'/'+table);
        }
      }
    }finally{from.close();to?.close();}
    merges.push({name,tables,present});
  }
  for(const folder of ['attachments','thread-settings']){
    const entries=await readdir(path.join(source,folder),{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    for(const entry of entries){
      if(!entry.isFile())throw new Error('Unexpected data entry: '+folder+'/'+entry.name);
      const from=path.join(source,folder,entry.name),to=path.join(target,folder,entry.name);
      let data:Buffer|undefined;
      if(folder==='attachments' && entry.name.endsWith('.json')){
        const metadata=JSON.parse(await readFile(from,'utf8'));
        if(typeof metadata.path!=='string' || path.dirname(metadata.path)!==path.join(source,folder))throw new Error('Invalid attachment metadata');
        metadata.path=path.join(target,folder,path.basename(metadata.path));data=Buffer.from(JSON.stringify(metadata));
      }
      if(await exists(to)){if(!(data || await readFile(from)).equals(await readFile(to)))throw new Error('File conflict: '+folder+'/'+entry.name);}
      else copies.push({from,to,data});
    }
  }
  await mkdir(backupDir,{recursive:true,mode:0o700});await mkdir(target,{recursive:true,mode:0o700});
  // SQLite backup includes committed WAL data; copying only the .sqlite file would lose it.
  for(const {name,present} of merges){
    const from=new DatabaseSync(path.join(source,name),{readOnly:true});
    try{
      await backup(from,path.join(backupDir,'assistant-'+name));
      if(!present){await backup(from,path.join(target,name));}
      else{
        const to=new DatabaseSync(path.join(target,name));
        try{
          await backup(to,path.join(backupDir,'viewer-'+name));
          to.exec('PRAGMA busy_timeout=5000');
          to.prepare('ATTACH DATABASE ? AS assistant').run(path.join(source,name));
          to.exec('BEGIN IMMEDIATE');
          try{
            // A write arriving after preflight must fail rather than overwrite or disappear.
            for(const table of merges.find(m=>m.name===name)!.tables){
              to.exec(`INSERT INTO main.${table} SELECT * FROM assistant.${table} EXCEPT SELECT * FROM main.${table}`);
            }
            to.exec('COMMIT');
          }catch(e){to.exec('ROLLBACK');throw e;}
        }finally{to.close();}
      }
      await chmod(path.join(target,name),0o600);
    }finally{from.close();}
  }
  for(const {from,to,data} of copies){await mkdir(path.dirname(to),{recursive:true,mode:0o700});if(data)await writeFile(to,data,{flag:'wx',mode:0o600});else await copyFile(from,to,1);await chmod(to,0o600);}
  return {databases:merges.map(m=>m.name),files:copies.length};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const [source,target,backupDir]=process.argv.slice(2);
  if(!source||!target||!backupDir)throw new Error('Usage: node scripts/merge-assistant-data.ts <old-data-dir> <viewer-data-dir> <backup-dir>');
  console.log(await mergeAssistantData(source,target,backupDir));
}
