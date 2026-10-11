import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/server/index.mjs';
import { createSyntheticWorkspace, syntheticDatabasePath, captureSyntheticBackup, restoreSyntheticBackup, promoteSyntheticRestore, disposeSyntheticWorkspace } from '../src/server/synthetic-backup.mjs';
import { readSyntheticRawState, syntheticClient } from './synthetic-backup-fixtures.mjs';

test('manual holiday/contact/credit backup restores exact records, immutable versions, decimal text, actual actor and idempotency; failed promotion rolls back byte-exact', async () => {
  const workspace=createSyntheticWorkspace(); let source, live;
  try {
    source=createApp({dbPath:syntheticDatabasePath(workspace,'source'),port:0});
    const client=syntheticClient(await source.listen(),'synthetic-manual-backup');
    const auth=await client.json('POST','setup',{name:'合成人工紀錄備份管理員',email:'manual-backup@example.test',password:'synthetic-manual-backup-password',organizationName:'合成人工紀錄備份機構'},{status:201});client.bindAuth(auth);
    const options={orgId:auth.organizations[0].id}, post=async(entity,body,extra={})=>(await client.json('POST',entity,body,{...options,status:201,...extra})).item;
    const caseRecord=await post('cases',{name:'合成足跡個案',caseNo:'SYN-MANUAL-C1'}), related=await post('cases',{name:'合成相關個案',caseNo:'SYN-MANUAL-C2'}),employee=await post('employees',{name:'合成積分員工',employeeNo:'SYN-MANUAL-E1'});
    let holiday=await post('institution-holidays',{date:'2026-10-10',title:'合成人工指定日',kind:'holiday',sourceReference:' 指定來源\r\n保留邊界 ',note:' 原備註\r\n完整尾端 '});
    holiday=(await client.json('PATCH','institution-holidays/'+holiday.id,{version:1,date:'2026-10-11'},options)).item;
    holiday=(await client.json('PATCH','institution-holidays/'+holiday.id,{version:2,status:'inactive'},options)).item;
    let footprint=await post('case-contact-footprints',{caseId:caseRecord.id,date:'2026-10-10',time:'',location:' 合成地點 ',contactDescription:' 原接觸描述\r\n尾端 ',relatedCaseId:related.id,source:' 人工來源 ',note:' 多行備註\r\n保留 '});
    footprint=(await client.json('PATCH','case-contact-footprints/'+footprint.id,{version:1,time:'09:05'},options)).item;
    footprint=(await client.json('PATCH','case-contact-footprints/'+footprint.id,{version:2,status:'inactive'},options)).item;
    const creditBody={employeeId:employee.id,date:'2026-10-10',activityName:'合成人工課程',provider:'合成單位',creditValue:'0.100000',creditUnit:'人工原值單位',sourceReference:' 原證明\r\n原文保留 ',note:' 兩行備註\r\n保存尾端 '},creditKey='synthetic-manual-credit-original';
    const originalCredit=await post('employee-training-credits',creditBody,{idempotencyKey:creditKey});
    let credit=(await client.json('PATCH','employee-training-credits/'+originalCredit.id,{version:1,status:'verified',verifiedOn:'2026-10-11',verificationBasis:' 本次人工核對\r\n依據 '},options)).item;
    credit=(await client.json('PATCH','employee-training-credits/'+credit.id,{version:2,status:'voided',voidedOn:'2026-10-12',voidReason:' 本次作廢\r\n原紀錄保留 '},options)).item;
    const before=readSyntheticRawState(source.db), changes=source.db.prepare('SELECT total_changes() n').get().n;
    assert.equal(before.schema.filter(row=>row.type==='table').length,11);assert.equal(before.schema.filter(row=>row.type==='trigger').length,6);
    const ref=captureSyntheticBackup(workspace);assert.deepEqual(readSyntheticRawState(source.db),before);assert.equal(source.db.prepare('SELECT total_changes() n').get().n,changes);
    restoreSyntheticBackup(workspace,ref,'live');live=createApp({dbPath:syntheticDatabasePath(workspace,'live'),port:0});
    assert.deepEqual(readSyntheticRawState(live.db),before);assert.equal(live.db.prepare('SELECT total_changes() n').get().n,0);
    const restored=syntheticClient(await live.listen(),'synthetic-manual-restored',{cookie:client.cookie,auth});
    for(const [entity,item] of [['institution-holidays',holiday],['case-contact-footprints',footprint],['employee-training-credits',credit]]){
      assert.deepEqual((await restored.json('GET',entity+'/'+item.id,undefined,options)).item,item);
      const history=await restored.json('GET',entity+'/'+item.id+'/history?compare=previous',undefined,options);
      assert.equal(history.items.length,3);assert.ok(history.items.every(row=>row.actor.id===auth.user.id));
      assert.equal(history.items[0].snapshot.note,item.note);
    }
    const replay=await restored.json('POST','employee-training-credits',creditBody,{...options,idempotencyKey:creditKey,status:201});assert.deepEqual(replay.item,originalCredit);
    assert.equal(credit.creditValue,'0.100000');assert.equal(live.db.prepare('SELECT total_changes() n').get().n,0);
    await restored.json('PATCH','institution-holidays/'+holiday.id,{version:3,title:'合成還原後新版'},options);
    const liveState=readSyntheticRawState(live.db);await live.close();live=undefined;
    const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex'), livePath=syntheticDatabasePath(workspace,'live'),liveHash=digest(livePath);
    restoreSyntheticBackup(workspace,ref,'staged');assert.equal(promoteSyntheticRestore(workspace,{forceRollback:true}).status,'rolled_back');assert.equal(digest(livePath),liveHash);
    live=createApp({dbPath:livePath,port:0});assert.deepEqual(readSyntheticRawState(live.db),liveState);await live.close();live=undefined;
    assert.equal(promoteSyntheticRestore(workspace,{forceRollback:false}).status,'promoted');assert.equal(digest(syntheticDatabasePath(workspace,'previous')),liveHash);
    live=createApp({dbPath:livePath,port:0});assert.deepEqual(readSyntheticRawState(live.db),before);assert.equal(live.db.prepare('SELECT total_changes() n').get().n,0);
    assert.deepEqual(readSyntheticRawState(source.db),before);
  } finally {if(live)await live.close();if(source)await source.close();disposeSyntheticWorkspace(workspace);}
});
