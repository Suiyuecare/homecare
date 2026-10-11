import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.mjs';
import { syntheticClient, readSyntheticRawState } from './synthetic-backup-fixtures.mjs';

test('a valid current record at maximum safe SQL version stays readable but cannot advance or partially write',async()=>{
  const app=createApp({dbPath:':memory:',port:0});
  try{
    const client=syntheticClient(await app.listen(),'synthetic-manual-version-boundary');
    const auth=await client.json('POST','setup',{name:'合成版次管理員',email:'manual-version@example.test',password:'synthetic-manual-version-password',organizationName:'合成版次機構'},{status:201});client.bindAuth(auth);
    const options={orgId:auth.organizations[0].id};
    const item=(await client.json('POST','institution-holidays',{date:'2026-10-10',title:'合成版次界限',kind:'other'},{...options,status:201})).item;
    app.db.prepare('UPDATE records SET version=? WHERE id=?').run(BigInt(Number.MAX_SAFE_INTEGER),item.id);
    const before=readSyntheticRawState(app.db),changes=app.db.prepare('SELECT total_changes() n').get().n;
    const current=(await client.json('GET','institution-holidays/'+item.id,undefined,options)).item;
    assert.equal(current.version,Number.MAX_SAFE_INTEGER);
    await client.json('PATCH','institution-holidays/'+item.id,{version:Number.MAX_SAFE_INTEGER,title:'不可保存的更正'},{...options,status:409});
    assert.deepEqual(readSyntheticRawState(app.db),before);assert.equal(app.db.prepare('SELECT total_changes() n').get().n,changes);
  }finally{await app.close();}
});
