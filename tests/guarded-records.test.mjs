import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { guardedStoredGet, guardedStoredRows, isGuardedStoredEntity } from '../src/server/guarded-records.mjs';
import { createApp } from '../src/server/index.mjs';

test('closed record readers hide malformed SQL versions and JSON without changing the existing storage schema or data',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE records(id TEXT,org_id TEXT,entity TEXT,data TEXT,version INTEGER,created_at TEXT,updated_at TEXT)');
  const insert=db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)');
  for(const entity of ['claim-batches','shift-series','shift-series-occurrences','case-contracts','internal-tasks','form-templates','form-records']){
    for(const [id,data,version] of [['valid','{"name":"合成資料"}',1],['broken','{bad',2],['array','[]',1],['metadata','{"orgId":"other"}',1],['unsafe','{}',9007199254740993n],['zero','{}',0],['negative','{}',-1]])insert.run(id,'synthetic-org',entity,data,version,'created','updated');
    insert.run('foreign','other-org',entity,'{}',1,'created','updated');
  }
  const raw=db.prepare('SELECT * FROM records ORDER BY entity,id');raw.setReadBigInts(true);const before=raw.all(),changes=db.prepare('SELECT total_changes() n').get();
  for(const entity of ['claim-batches','shift-series','shift-series-occurrences','case-contracts','internal-tasks','form-templates','form-records']){
    assert.equal(guardedStoredRows(db,'synthetic-org',entity).length,1);assert.equal(guardedStoredGet(db,'synthetic-org',entity,'valid').version,1);
    for(const id of ['broken','array','metadata','unsafe','zero','negative','foreign'])assert.equal(guardedStoredGet(db,'synthetic-org',entity,id),null);
  }assert.deepEqual(raw.all(),before);assert.deepEqual(db.prepare('SELECT total_changes() n').get(),changes);assert(!isGuardedStoredEntity('cases'));
});
test('malformed current claim rows return no list item or current/history/edit access rather than 500 or repair',async t=>{
  const app=createApp({dbPath:':memory:',port:0}),base=await app.listen();t.after(()=>app.close());
  const setup=await fetch(base+'/api/setup',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({name:'合成讀取驗收',organizationName:'合成隔離',email:'guarded@example.test',password:'synthetic-guarded-password'})});assert.equal(setup.status,201);
  const session=await setup.json(),orgId=session.organizations[0].id,headers={Origin:base,'Content-Type':'application/json',Cookie:setup.headers.get('set-cookie').split(';')[0],'X-Org-Id':orgId,'X-CSRF-Token':session.csrfToken};
  const id='00000000-0000-4000-8000-000000000001',insert=app.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)');insert.run(id,orgId,'claim-batches','{broken',1,'created','updated');
  const changes=()=>app.db.prepare('SELECT total_changes() n').get();const before=changes();
  const list=await fetch(base+'/api/claim-batches',{headers});assert.equal(list.status,200);assert.equal((await list.json()).total,0);
  for(const suffix of ['', '/history?compare=previous']){const r=await fetch(base+'/api/claim-batches/'+id+suffix,{headers});assert.equal(r.status,404);}
  const patch=await fetch(base+'/api/claim-batches/'+id,{method:'PATCH',headers,body:JSON.stringify({version:1,note:'合成修改'})});assert.equal(patch.status,404);
  assert.deepEqual(changes(),before);assert.equal(app.db.prepare('SELECT data FROM records WHERE id=?').get(id).data,'{broken');
});
