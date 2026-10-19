import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm, writeFile, readFile, utimes } from 'node:fs/promises';
import { inside, directory, Uploads } from '../server/security.ts';

test('case aliases require filesystem identity and preserve directory boundaries', async () => {
  const base = await mkdtemp('/tmp/viewer-path-case-');
  try {
    const root = base + '/Vault', alias = base + '/vault', other = base + '/VAULT';
    await mkdir(root); await mkdir(root + '/notes'); await mkdir(other);
    await symlink(root, alias);
    assert.equal(inside(root, alias), true);
    assert.equal(inside(root, alias + '/notes'), true);
    assert.equal(inside(root, alias + '-private'), false);
    assert.equal(inside(root, other), false);
    assert.equal(inside(root, other + '/notes'), false);
    assert.equal(inside(root, alias + '/../VAULT'), false);
    await symlink(other, root + '/escape');
    await assert.rejects(directory(alias + '/escape', [root]), /授权/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('hybrid context retains only referenced uploads across age cleanup',async()=>{
  const root=await mkdtemp('/tmp/viewer-retained-');
  try{
    const uploads=new Uploads(root),ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
    for(const id of ids){const file=root+'/'+id+'.txt';await writeFile(file,'original input');await writeFile(root+'/'+id+'.json',JSON.stringify({id,path:file,name:'input.txt',mime:'text/plain',size:14,created:0}));}
    await uploads.retainIn([{content:[{type:'localImage',path:root+'/'+ids[0]+'.txt'}]}]);
    for(const id of ids)for(const ext of ['txt','json'])await utimes(root+'/'+id+'.'+ext,new Date(0),new Date(0));
    await uploads.cleanup();assert.equal(await readFile((await uploads.get(ids[0])).path,'utf8'),'original input');
    await assert.rejects(uploads.get(ids[1]),/失效/);
  }finally{await rm(root,{recursive:true,force:true});}
});
