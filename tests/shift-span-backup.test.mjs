import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/server/index.mjs';
import { createSyntheticWorkspace,syntheticDatabasePath,captureSyntheticBackup,restoreSyntheticBackup,promoteSyntheticRestore,disposeSyntheticWorkspace } from '../src/server/synthetic-backup.mjs';
import { readSyntheticRawState,syntheticClient } from './synthetic-backup-fixtures.mjs';
import { filePayload,PDF_BYTES,PNG_BYTES } from './attachment-fixtures.mjs';

test('explicit two-day complete eleven-table/six-trigger restore, cached replay and failed cutover preserve legacy raw ISO, markers, Source13 origins, snapshot8 and immutable moved/rescheduled series',async()=>{
  const workspace=createSyntheticWorkspace();let source,live;
  try {
    source=createApp({dbPath:syntheticDatabasePath(workspace,'source'),port:0});const base=await source.listen(),admin=syntheticClient(base,'synthetic-span-source-admin');
    const password='synthetic-two-day-backup-password',auth=await admin.json('POST','setup',{name:'合成完整兩日備份管理員',email:'two-day-backup@example.test',password,organizationName:'合成兩日完整備份機構'},{status:201});admin.bindAuth(auth);const opts={orgId:auth.organizations[0].id},mode='calendar-two-day-v1';
    let serial=0;const post=async(entity,data,client=admin)=>(await client.json('POST',entity,data,{...opts,status:201,idempotencyKey:'span-backup-fixture-'+(++serial)})).item;
    const parent=await post('cases',{name:'合成備份個案',caseNo:'SPAN-BACKUP-C'}),employee=await post('employees',{name:'合成備份原員工',employeeNo:'SPAN-BACKUP-E',hourlyRateCents:2467}),replacement=await post('employees',{name:'合成備份替代員工',employeeNo:'SPAN-BACKUP-R'}),item=await post('service-items',{code:'SPAN-BACKUP-S',name:'合成服務原文',minutes:60,unitPriceCents:37}),services=[{serviceItemId:item.id,quantity:2}],plan=await post('care-plans',{caseId:parent.id,validFrom:'2026-01-01',validTo:'2027-12-31',status:'active',services});
    await post('users',{name:'合成备份居服員',email:'two-day-caregiver@example.test',password,role:'caregiver',employeeId:employee.id});const caregiver=syntheticClient(base,'synthetic-span-source-caregiver');const ownAuth=await caregiver.login('two-day-caregiver@example.test',password);
    const attachment=await post('case-attachments/upload',{caseId:parent.id,title:'合成跨日備份PDF',category:'other',...filePayload(PDF_BYTES,'合成跨日備份.pdf','application/pdf')}),certification=await post('employee-certifications',{employeeId:employee.id,name:'合成備份證照',issuedOn:'2026-01-01'}),certAttachment=await post('certification-attachments/upload',{certificationId:certification.id,title:'合成跨日備份PNG',...filePayload(PNG_BYTES,'合成跨日備份.png','image/png')});
    source.db.prepare('INSERT INTO demo_seeds VALUES(?,?)').run(opts.orgId,'2026-10-11T00:00:00.000Z');
    const shifts=(date,startTime,endTime,extra={})=>({caseId:parent.id,employeeId:employee.id,carePlanId:plan.id,date,startTime,endTime,services,status:'scheduled',note:' 合成原文\r\n完整末行 ',...extra});
    const legacy=await post('shifts',shifts('2026-12-20','2026-12-20T08:00:59+08:00','2026-12-20T09:00:37+08:00'));
    let legacyRecord=await post('service-records',{shiftId:legacy.id,caseId:parent.id,employeeId:employee.id,date:legacy.date,actualStart:legacy.startTime,actualEnd:legacy.endTime,services,status:'submitted'});
    legacyRecord=(await admin.json('POST','service-records/'+legacyRecord.id+'/review',{version:legacyRecord.version,decision:'approved',reviewNote:'合成原同日核閱'},{...opts,idempotencyKey:'span-backup-legacy-review'})).item;
    const night=await post('shifts',shifts('2026-12-31','23:30','01:00',{endDate:'2027-01-01'}));
    let record=await post('service-records',{shiftId:night.id,caseId:parent.id,employeeId:employee.id,date:night.date,actualStart:'23:30',actualEnd:'01:00',actualEndDate:'2027-01-01',services,status:'submitted',note:' 合成跨年服務\r\n末行 '},caregiver);
    const reviewBody={version:record.version,decision:'approved',reviewNote:'合成跨年人工核閱'},reviewKey='span-backup-review';record=(await admin.json('POST','service-records/'+record.id+'/review',reviewBody,{...opts,idempotencyKey:reviewKey})).item;assert.equal(record.billingSnapshot.serviceMinutes,90);
    const replayJobs=[];
    const origins=[];
    for(const [type,parentKey,parentId,amount] of [['service-billing','caseId',parent.id,13],['service-payroll','employeeId',employee.id,17]]) {
      const body={[parentKey]:parentId,month:'2026-12',number:'SPAN-BACKUP-'+type,sourceReference:' 人工共同依據\r\n末行 ',note:' 人工原文\r\n末行 ',spanMode:mode,lines:[{serviceRecordId:record.id,version:record.version,label:'人工原文逐筆金額',amountCents:amount,sourceReference:' 人工逐筆依據\r\n末行 '}]};
      const preview=await admin.json('POST',type+'/preview',body,opts),createBody={...body,previewHash:preview.previewHash},key='span-backup-'+type;
      const created=await admin.json('POST',type+'/create',createBody,{...opts,status:201,idempotencyKey:key});assert.equal(Object.keys(created.origin.sourceSnapshots[0]).length,13);assert.equal(created.origin.sourceSnapshots[0].actualEndDate,'2027-01-01');
      origins.push({type,created,detail:await admin.json('GET',type+'/origins/'+created.item.id+'?spanMode='+mode,undefined,opts)});replayJobs.push({route:type+'/create',body:createBody,key,status:201,value:created});
    }
    const substituteShift=await post('shifts',shifts('2027-01-05','23:00','01:00',{endDate:'2027-01-06'}));
    const request=await post('shift-substitution-requests',{shiftId:substituteShift.id,shiftVersion:substituteShift.version,reason:'合成人工夜間代班',note:' 人工申請原文\r\n末行 '},caregiver);assert.equal(Object.keys(request.shiftSnapshot).length,8);assert.ok(!Object.hasOwn(request.shiftSnapshot,'caseId'));
    const substitutionBody={version:request.version,decision:'approve',shiftVersion:substituteShift.version,replacementEmployeeId:replacement.id,reviewedOn:'2027-01-04',reviewReason:'人工核對理由'},substitutionKey='span-backup-substitution';
    const substitution=await admin.json('POST','shift-substitution-requests/'+request.id+'/review',substitutionBody,{...opts,idempotencyKey:substitutionKey});assert.equal(Object.keys(substitution.item.replacementShiftSnapshot).length,8);replayJobs.push({route:'shift-substitution-requests/'+request.id+'/review',body:substitutionBody,key:substitutionKey,status:200,value:substitution});
    const series=await post('shift-series',{name:'合成永久跨日備份',caseId:parent.id,employeeId:employee.id,carePlanId:plan.id,startDate:'2027-01-10',endDate:'2027-01-11',weekdays:[1,2,3,4,5,6,7],intervalWeeks:1,startTime:'23:30',endTime:'01:00',endDay:'next',services,note:' 合成週期原文\r\n末行 '});
    const prefix='shift-series/'+series.id,range={version:series.version,fromDate:series.startDate,toDate:series.endDate},generationKey='span-backup-generation';
    const generated=await admin.json('POST',prefix+'/generation/commit',range,{...opts,idempotencyKey:generationKey});assert.equal(generated.total,2);replayJobs.push({route:prefix+'/generation/commit',body:range,key:generationKey,status:200,value:generated});
    const move={...range,action:'move',daysOffset:3,reason:' 合成整組人工移日\r\n末行 ',items:generated.items.map(v=>({id:v.occurrence.shift.id,version:v.occurrence.shift.version}))},moveKey='span-backup-move';
    const movePreview=await admin.json('POST',prefix+'/adjustments/preview',move,opts);assert.equal(movePreview.preview.canCommit,true);const moved=await admin.json('POST',prefix+'/adjustments/commit',move,{...opts,idempotencyKey:moveKey});assert.deepEqual(moved.result.items.map(v=>[v.date,v.endDate]),[['2027-01-13','2027-01-14'],['2027-01-14','2027-01-15']]);replayJobs.push({route:prefix+'/adjustments/commit',body:move,key:moveKey,status:200,value:moved});
    const reschedule={...range,action:'reschedule',startTime:'23:00',endTime:'02:00',endDay:'next',reason:' 合成整組人工調時\r\n末行 ',items:moved.result.items.map(v=>({id:v.id,version:v.version}))},rescheduleKey='span-backup-reschedule';
    const rescheduled=await admin.json('POST',prefix+'/adjustments/commit',reschedule,{...opts,idempotencyKey:rescheduleKey});assert.ok(rescheduled.result.items.every(v=>v.startTime==='23:00'&&Object.hasOwn(v,'endDate')));replayJobs.push({route:prefix+'/adjustments/commit',body:reschedule,key:rescheduleKey,status:200,value:rescheduled});
    const occurrencePath=prefix+'/occurrences?'+new URLSearchParams(range),occurrences=await admin.json('GET',occurrencePath,undefined,opts);assert.ok(occurrences.items.every(v=>v.seriesSnapshot.endDay==='next'&&v.shift.version===3));
    const routes=['shifts/'+night.id+'/history?compare=previous','service-records/'+record.id+'/history?compare=previous','shift-substitution-requests/'+request.id+'/history?compare=previous',prefix+'/history?compare=previous',...rescheduled.result.items.map(v=>'shifts/'+v.id+'/history?compare=previous')],histories=new Map();for(const route of routes)histories.set(route,await admin.json('GET',route,undefined,opts));
    const ownHistory=await caregiver.json('GET','shift-substitution-requests/'+request.id+'/history?compare=previous',undefined,opts);assert.equal(ownHistory.items.length,2);
    const ownServiceHistory=await caregiver.json('GET','service-records/'+record.id+'/history?compare=previous',undefined,opts);assert.ok(ownServiceHistory.items.every(v=>!Object.hasOwn(v.snapshot,'billingSnapshot')));
    const before=readSyntheticRawState(source.db),sourceChanges=source.db.prepare('SELECT total_changes() n').get().n;
    assert.equal(Object.keys(before.tables).length,11);assert.equal(before.schema.filter(v=>v.type==='trigger').length,6);assert.ok(before.tables.record_versions.some(v=>v.source==='span-create'));assert.ok(before.tables.record_versions.some(v=>v.source==='span-update'));
    assert.ok(Object.values(before.tables).every(rows=>rows.length>0),'Every one of the fixed eleven tables has synthetic saved data');assert.deepEqual(before.tables.attachment_files[0].content,PDF_BYTES);assert.deepEqual(before.tables.certification_attachment_files[0].content,PNG_BYTES);
    const legacySaved=before.tables.records.find(v=>v.id===legacy.id);assert.equal(JSON.parse(legacySaved.data).startTime,legacy.startTime);assert.ok(!Object.hasOwn(JSON.parse(legacySaved.data),'endDate'));assert.equal(before.tables.records.filter(v=>v.entity==='shift-series-occurrences').length,2);
    const reference=captureSyntheticBackup(workspace);assert.deepEqual(readSyntheticRawState(source.db),before);assert.equal(source.db.prepare('SELECT total_changes() n').get().n,sourceChanges);
    restoreSyntheticBackup(workspace,reference,'live');live=createApp({dbPath:syntheticDatabasePath(workspace,'live'),port:0});const restoredBase=await live.listen(),restored=syntheticClient(restoredBase,'synthetic-span-restored-admin',{cookie:admin.cookie,auth}),restoredOwn=syntheticClient(restoredBase,'synthetic-span-restored-caregiver',{cookie:caregiver.cookie,auth:ownAuth});
    assert.deepEqual(readSyntheticRawState(live.db),before);assert.equal(live.db.prepare('SELECT total_changes() n').get().n,0);
    for(const origin of origins)assert.deepEqual(await restored.json('GET',origin.type+'/origins/'+origin.created.item.id+'?spanMode='+mode,undefined,opts),origin.detail);
    assert.deepEqual(await restored.json('GET',occurrencePath,undefined,opts),occurrences);for(const [route,value] of histories)assert.deepEqual(await restored.json('GET',route,undefined,opts),value);
    assert.deepEqual(await restoredOwn.json('GET','shift-substitution-requests/'+request.id+'/history?compare=previous',undefined,opts),ownHistory);assert.deepEqual(await restoredOwn.json('GET','service-records/'+record.id+'/history?compare=previous',undefined,opts),ownServiceHistory);
    for(const [entity,file,expected] of [['case-attachments',attachment,PDF_BYTES],['certification-attachments',certAttachment,PNG_BYTES]]){const response=await restored.response('GET',entity+'/'+file.id+'/download',undefined,opts);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),expected);}
    for(const job of replayJobs)assert.deepEqual(await restored.json('POST',job.route,job.body,{...opts,status:job.status,idempotencyKey:job.key}),job.value);
    const restoredLegacy=(await restored.json('GET','shifts/'+legacy.id,undefined,opts)).item;assert.equal(restoredLegacy.startTime,legacy.startTime);assert.equal(restoredLegacy.endTime,legacy.endTime);assert.ok(!Object.hasOwn(restoredLegacy,'endDate'));assert.deepEqual((await restored.json('GET','service-records/'+legacyRecord.id,undefined,opts)).item,legacyRecord);
    assert.deepEqual(readSyntheticRawState(live.db),before);assert.equal(live.db.prepare('SELECT total_changes() n').get().n,0,'Read/replay restored phase is wholly zero-write');
    await restored.json('POST','cases',{name:'合成切回完整B世代',caseNo:'SPAN-BACKUP-B'},{...opts,status:201});const generationB=readSyntheticRawState(live.db);await live.close();live=undefined;
    const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex'),livePath=syntheticDatabasePath(workspace,'live'),liveSHA=sha(livePath);restoreSyntheticBackup(workspace,reference,'staged');assert.equal(promoteSyntheticRestore(workspace,{forceRollback:true}).status,'rolled_back');assert.equal(sha(livePath),liveSHA);
    live=createApp({dbPath:livePath,port:0});assert.deepEqual(readSyntheticRawState(live.db),generationB);await live.close();live=undefined;
    assert.equal(promoteSyntheticRestore(workspace,{forceRollback:false}).status,'promoted');assert.equal(sha(syntheticDatabasePath(workspace,'previous')),liveSHA);live=createApp({dbPath:livePath,port:0});assert.deepEqual(readSyntheticRawState(live.db),before);assert.equal(live.db.prepare('SELECT total_changes() n').get().n,0);
    assert.deepEqual(readSyntheticRawState(source.db),before);assert.equal(source.db.prepare('SELECT total_changes() n').get().n,sourceChanges);
  } finally {await live?.close();await source?.close();disposeSyntheticWorkspace(workspace);}
});
