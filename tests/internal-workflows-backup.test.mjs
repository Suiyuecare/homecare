import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createApp} from '../src/server/index.mjs';
import {createSyntheticWorkspace,syntheticDatabasePath,captureSyntheticBackup,restoreSyntheticBackup,promoteSyntheticRestore,disposeSyntheticWorkspace} from '../src/server/synthetic-backup.mjs';
import {readSyntheticRawState,syntheticClient} from './synthetic-backup-fixtures.mjs';

test('actual internal notification/self-reply/cancel, completed deadline and approved substitution survive exact eleven-table restore with actors/cache and byte-exact forced rollback',async()=>{
  const workspace=createSyntheticWorkspace();let source,live;
  try{
    source=createApp({dbPath:syntheticDatabasePath(workspace,'source'),port:0});const base=await source.listen(),admin=syntheticClient(base,'synthetic-internal-workflows-admin'),password='synthetic-internal-workflows-backup-password';
    const auth=await admin.json('POST','setup',{name:'合成內部流程備份管理員',email:'internal-workflows-admin@example.test',password,organizationName:'合成內部流程備份機構'},{status:201});admin.bindAuth(auth);const options={orgId:auth.organizations[0].id};
    const post=async(entity,body,client=admin,extra={})=>(await client.json('POST',entity,body,{...options,status:201,...extra})).item;
    const patch=async(entity,item,body,client=admin)=>(await client.json('PATCH',entity+'/'+item.id,{version:item.version,...body},options)).item;
    const parentCase=await post('cases',{name:'合成流程個案',caseNo:'INTERNAL-BACKUP-C1'}),employee=await post('employees',{name:'合成原班員工',employeeNo:'INTERNAL-BACKUP-E1'}),replacement=await post('employees',{name:'合成代班員工',employeeNo:'INTERNAL-BACKUP-E2'});
    const caregiverUser=await post('users',{name:'合成本人居服',email:'internal-workflows-caregiver@example.test',password,role:'caregiver',employeeId:employee.id}),supervisorUser=await post('users',{name:'合成審核督導',email:'internal-workflows-supervisor@example.test',password,role:'supervisor'});
    const caregiver=syntheticClient(base,'synthetic-internal-workflows-caregiver'),caregiverAuth=await caregiver.login('internal-workflows-caregiver@example.test',password),supervisor=syntheticClient(base,'synthetic-internal-workflows-supervisor'),supervisorAuth=await supervisor.login('internal-workflows-supervisor@example.test',password);

    const notificationBody={title:' 合成明確通知 ',body:' 合成通知全文\r\n完整尾端 ',note:' 合成管理備註\r\n保留空白 ',recipientUserIds:[caregiverUser.id]},notificationKey='synthetic-backup-notification-create';
    const initialNotification=await post('internal-notifications',notificationBody,admin,{idempotencyKey:notificationKey});let notification=await patch('internal-notifications',initialNotification,{status:'published'});
    const publication=structuredClone(notification.publication),receiptRoute='internal-notifications/'+notification.id+'/my-receipt',readPayload={publicationVersion:2,receiptVersion:0,action:'read',reply:''},readKey='synthetic-backup-notification-read';
    const firstRead=await caregiver.json('POST',receiptRoute,readPayload,{...options,idempotencyKey:readKey});
    const replyPayload={publicationVersion:2,receiptVersion:firstRead.receipt.version,action:'reply',reply:' 本人回覆原文\r\n完整尾端 '},replyKey='synthetic-backup-notification-reply';
    const replied=await caregiver.json('POST',receiptRoute,replyPayload,{...options,idempotencyKey:replyKey});
    assert.equal(replied.receipt.reply,replyPayload.reply);assert.equal(replied.receipt.readAt,firstRead.receipt.readAt);assert.equal(replied.receipt.recipientUserId,caregiverUser.id);
    notification=await patch('internal-notifications',notification,{status:'cancelled',cancellationReason:' 本次取消原因\r\n原文 '});assert.deepEqual(notification.publication,publication);

    let contract=await post('case-contracts',{caseId:parentCase.id,number:'INTERNAL-BACKUP-CONTRACT',title:'合成人工契約',startDate:'2026-10-01',endDate:'2026-12-31',note:' 合成契約\r\n原文 '});
    contract=await patch('case-contracts',contract,{status:'active',signedDate:'2026-09-20',statusDate:'2026-09-21',documentReference:'合成文件識別',sourceReference:' 合成核對來源\r\n原文 '});
    let reminder=await post('contract-deadline-reminders',{contractId:contract.id,contractVersion:contract.version,title:'合成人工期限提醒',content:' 合成期限內容\r\n原文 ',assigneeEmployeeId:employee.id,dueDate:'2026-12-10',note:' 合成提醒備註\r\n尾端 '});const contractSnapshot=structuredClone(reminder.contractSnapshot);
    reminder=await patch('contract-deadline-reminders',reminder,{status:'in_progress',statusDate:'2026-12-01'},supervisor);
    reminder=await patch('contract-deadline-reminders',reminder,{status:'completed',statusDate:'2026-12-02',result:' 本次人工完成結果\r\n完整原文 '},supervisor);assert.deepEqual(reminder.contractSnapshot,contractSnapshot);

    const service=await post('service-items',{code:'INTERNAL-BACKUP-S1',name:'合成內部流程服務',minutes:60,unitPriceCents:10001}),services=[{serviceItemId:service.id,quantity:1}],plan=await post('care-plans',{caseId:parentCase.id,validFrom:'2026-01-01',validTo:'2027-12-31',services,status:'active'});
    const shift=await post('shifts',{caseId:parentCase.id,employeeId:employee.id,carePlanId:plan.id,date:'2026-10-10',startTime:'09:00',endTime:'10:00',services,note:' 合成原班備註\r\n所有欄位保留 '});
    const substitutionBody={shiftId:shift.id,shiftVersion:shift.version,reason:' 本人請代班原因\r\n完整原文 ',note:' 本人代班備註\r\n原文 '};
    const substitution=await post('shift-substitution-requests',substitutionBody,caregiver,{idempotencyKey:'synthetic-backup-substitution-create'}),originalShiftSnapshot=structuredClone(substitution.shiftSnapshot),reviewBody={version:substitution.version,decision:'approve',shiftVersion:substitution.shiftVersion,replacementEmployeeId:replacement.id,reviewedOn:'2026-10-10',reviewReason:' 本次督導人工核准\r\n完整原文 '},reviewKey='synthetic-backup-substitution-review';
    const approved=await supervisor.json('POST','shift-substitution-requests/'+substitution.id+'/review',reviewBody,{...options,idempotencyKey:reviewKey});assert.equal(approved.item.status,'approved');assert.equal(approved.shift.employeeId,replacement.id);assert.deepEqual(approved.item.shiftSnapshot,originalShiftSnapshot);
    for(const key of Object.keys(shift).filter(key=>!['employeeId','version','updatedAt'].includes(key)))assert.deepEqual(approved.shift[key],shift[key]);

    const before=readSyntheticRawState(source.db),sourceChanges=source.db.prepare('SELECT total_changes() n').get().n;
    assert.equal(before.schema.filter(row=>row.type==='table').length,11);assert.equal(before.schema.filter(row=>row.type==='trigger').length,6);
    assert.equal(before.tables.records.filter(row=>row.entity==='internal-notification-receipts').length,1);
    assert.equal(before.tables.record_versions.filter(row=>row.entity==='internal-notification-receipts').length,2);
    assert.deepEqual(before.tables.audit.filter(row=>row.entity==='internal-notification-receipts').map(row=>row.user_id),[caregiverUser.id,caregiverUser.id]);
    assert.equal(before.tables.idempotency.filter(row=>[notificationKey,readKey,replyKey,reviewKey].includes(row.key)).length,4);
    const ref=captureSyntheticBackup(workspace);assert.deepEqual(readSyntheticRawState(source.db),before);assert.equal(source.db.prepare('SELECT total_changes() n').get().n,sourceChanges);
    restoreSyntheticBackup(workspace,ref,'live');live=createApp({dbPath:syntheticDatabasePath(workspace,'live'),port:0});const restoredBase=await live.listen(),restoredAdmin=syntheticClient(restoredBase,'synthetic-restored-internal-admin',{cookie:admin.cookie,auth}),restoredCaregiver=syntheticClient(restoredBase,'synthetic-restored-internal-caregiver',{cookie:caregiver.cookie,auth:caregiverAuth}),restoredSupervisor=syntheticClient(restoredBase,'synthetic-restored-internal-supervisor',{cookie:supervisor.cookie,auth:supervisorAuth});
    assert.deepEqual(readSyntheticRawState(live.db),before);assert.equal(live.db.prepare('SELECT total_changes() n').get().n,0);
    for(const [entity,item] of [['internal-notifications',notification],['contract-deadline-reminders',reminder],['shift-substitution-requests',approved.item],['shifts',approved.shift]])assert.deepEqual((await restoredAdmin.json('GET',entity+'/'+item.id,undefined,options)).item,item);
    const restoredOwn=await restoredCaregiver.json('GET',receiptRoute,undefined,options);assert.equal(restoredOwn.canRecord,false);assert.deepEqual(restoredOwn.receipt,replied.receipt);assert.ok(!Object.hasOwn(restoredOwn.notification,'note'));assert.ok(!Object.hasOwn(restoredOwn.notification,'recipientUserIds'));
    const selfHistory=await restoredCaregiver.json('GET',receiptRoute+'/history',undefined,options);assert.deepEqual(selfHistory.items.map(row=>row.snapshot.reply),[replyPayload.reply,'']);assert.ok(selfHistory.items.every(row=>row.snapshot.recipientUserId===caregiverUser.id));
    const notificationHistory=await restoredAdmin.json('GET','internal-notifications/'+notification.id+'/history?compare=previous',undefined,options);assert.equal(notificationHistory.total,3);assert.ok(notificationHistory.items.every(row=>row.actor.id===auth.user.id));
    const reminderHistory=await restoredAdmin.json('GET','contract-deadline-reminders/'+reminder.id+'/history?compare=previous',undefined,options);assert.deepEqual(reminderHistory.items.map(row=>row.actor.id),[supervisorUser.id,supervisorUser.id,auth.user.id]);assert.ok(reminderHistory.items.every(row=>JSON.stringify(row.snapshot.contractSnapshot)===JSON.stringify(contractSnapshot)));
    const substitutionHistory=await restoredCaregiver.json('GET','shift-substitution-requests/'+substitution.id+'/history?compare=previous',undefined,options);assert.deepEqual(substitutionHistory.items.map(row=>row.actor.id),[supervisorUser.id,caregiverUser.id]);assert.ok(substitutionHistory.items.every(row=>JSON.stringify(row.snapshot.shiftSnapshot)===JSON.stringify(originalShiftSnapshot)));
    const roster=await restoredAdmin.json('GET','internal-notifications/'+notification.id+'/receipts',undefined,options);assert.deepEqual(roster.items,[replied.receipt]);
    assert.deepEqual(await restoredSupervisor.json('POST','shift-substitution-requests/'+substitution.id+'/review',reviewBody,{...options,idempotencyKey:reviewKey}),approved);
    assert.deepEqual((await restoredAdmin.json('POST','internal-notifications',notificationBody,{...options,status:201,idempotencyKey:notificationKey})).item,initialNotification);
    assert.equal((await restoredCaregiver.response('POST',receiptRoute,replyPayload,{...options,idempotencyKey:replyKey})).status,409,'Cancellation remains authoritative even for old cached reply key');
    assert.deepEqual(readSyntheticRawState(live.db),before);assert.equal(live.db.prepare('SELECT total_changes() n').get().n,0,'Restored GETs and legitimate replay never rewrite restored records/history/audit/idem');

    await restoredAdmin.json('POST','internal-notifications',{title:'合成還原後新增草稿',body:' 合成新的B世代\r\n原文 ',recipientUserIds:[caregiverUser.id]},{...options,status:201,idempotencyKey:'synthetic-backup-generation-b'});
    const liveB=readSyntheticRawState(live.db);assert.notDeepEqual(liveB,before);await live.close();live=undefined;
    const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex'),livePath=syntheticDatabasePath(workspace,'live'),liveHash=digest(livePath);
    restoreSyntheticBackup(workspace,ref,'staged');assert.equal(promoteSyntheticRestore(workspace,{forceRollback:true}).status,'rolled_back');assert.equal(digest(livePath),liveHash,'Forced failed cutover restores exact closed generation B bytes');
    live=createApp({dbPath:livePath,port:0});assert.deepEqual(readSyntheticRawState(live.db),liveB);assert.equal(live.db.prepare('SELECT total_changes() n').get().n,0);await live.close();live=undefined;
    assert.equal(promoteSyntheticRestore(workspace,{forceRollback:false}).status,'promoted');assert.equal(digest(syntheticDatabasePath(workspace,'previous')),liveHash);
    live=createApp({dbPath:livePath,port:0});assert.deepEqual(readSyntheticRawState(live.db),before);assert.equal(live.db.prepare('SELECT total_changes() n').get().n,0);assert.deepEqual(readSyntheticRawState(source.db),before);assert.equal(source.db.prepare('SELECT total_changes() n').get().n,sourceChanges);
  }finally{await live?.close();await source?.close();disposeSyntheticWorkspace(workspace);}
});
