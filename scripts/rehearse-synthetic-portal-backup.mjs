import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {createSyntheticPortalWorkspace,syntheticDatabasePath,inspectSyntheticDatabase,captureSyntheticBackup,restoreSyntheticBackup,promoteSyntheticRestore,disposeSyntheticWorkspace} from '../src/server/synthetic-portal-backup.mjs';
import {createSyntheticPortalBackupFixture,readPortalSyntheticRawState} from '../tests/portal-synthetic-backup-fixtures.mjs';
import {syntheticClient} from '../tests/synthetic-backup-fixtures.mjs';

// Synthetic scratch rehearsal only. No environment, existing DB, input path or credential.
if(process.argv.length!==2){
  console.error('Synthetic Portal backup rehearsal accepts no arguments.');process.exitCode=2;
}else{
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const same=(a,b,message)=>assert(isDeepStrictEqual(a,b),message);
  let workspace,fixture,liveApp,report,failureCode,disposed=false;
  try{
    workspace=createSyntheticPortalWorkspace();
    fixture=await createSyntheticPortalBackupFixture({workspace});
    const rawA=fixture.readRawState(),sourceChanges=fixture.app.db.prepare('SELECT total_changes() AS n').get().n;
    const reference=captureSyntheticBackup(workspace);
    same(fixture.readRawState(),rawA,'Capture preserves all thirteen saved tables');
    assert.equal(fixture.app.db.prepare('SELECT total_changes() AS n').get().n,sourceChanges);
    restoreSyntheticBackup(workspace,reference,'live');
    const restored=inspectSyntheticDatabase(workspace,'live');
    assert.equal(restored.tableCount,13);assert.equal(restored.triggerCount,6);
    liveApp=fixture.createAppForSlot('live');
    same(readPortalSyntheticRawState(liveApp.db),rawA,'Portal restore startup preserves complete point-in-time state');
    assert.equal(liveApp.db.prepare('SELECT total_changes() AS n').get().n,0);
    const base=await liveApp.listen();
    const actor=fixture.actors.admin;
    const client=syntheticClient(base,'restored-synthetic-portal-admin',{cookie:actor.cookie,auth:actor.auth});
    for(const kind of ['fees','payroll'])same(await client.json('GET',`reports/${kind}?month=${fixture.month}&spanMode=calendar-two-day-v1`,undefined,{orgId:fixture.orgId}),fixture.expected.frozenReports[kind],'Saved approved pricing survives Portal restore');
    const afterReads=readPortalSyntheticRawState(liveApp.db);
    same(afterReads,rawA,'Report reads preserve all thirteen saved tables, including sessions');
    const readCleanupChanges=liveApp.db.prepare('SELECT total_changes() AS n').get().n;
    assert.equal(readCleanupChanges,0,'Report reads have no session cleanup or other logical writes');
    const changed=await client.json('PATCH',`cases/${fixture.items.case.id}`,{version:fixture.items.case.version,note:'合成Portal live第二代，closed rollback保留'},{orgId:fixture.orgId});
    assert.equal(changed.item.version,fixture.items.case.version+1);
    const rawB=readPortalSyntheticRawState(liveApp.db),liveBusinessChanges=liveApp.db.prepare('SELECT total_changes() AS n').get().n-readCleanupChanges;
    assert(liveBusinessChanges>0);await liveApp.close();liveApp=null;
    const livePath=syntheticDatabasePath(workspace,'live'),liveHash=hash(readFileSync(livePath));
    restoreSyntheticBackup(workspace,reference,'staged');
    const rollback=promoteSyntheticRestore(workspace,{forceRollback:true});assert.equal(rollback.status,'rolled_back');
    assert.equal(hash(readFileSync(livePath)),liveHash,'Rollback retains exact closed original Portal bytes');
    liveApp=fixture.createAppForSlot('live');same(readPortalSyntheticRawState(liveApp.db),rawB,'Rollback preserves all original live values');
    assert.equal(liveApp.db.prepare('SELECT total_changes() AS n').get().n,0);await liveApp.close();liveApp=null;
    const promotion=promoteSyntheticRestore(workspace,{forceRollback:false});assert.equal(promotion.status,'promoted');
    assert.equal(hash(readFileSync(syntheticDatabasePath(workspace,'previous'))),liveHash,'Previous generation retains original closed bytes');
    liveApp=fixture.createAppForSlot('live');same(readPortalSyntheticRawState(liveApp.db),rawA,'Promotion restores the snapshot, including its auth state');
    assert.equal(liveApp.db.prepare('SELECT total_changes() AS n').get().n,0);await liveApp.close();liveApp=null;
    same(fixture.readRawState(),rawA,'Synthetic source remains unchanged');
    assert.equal(fixture.app.db.prepare('SELECT total_changes() AS n').get().n,sourceChanges);
    await fixture.close();fixture=null;disposeSyntheticWorkspace(workspace);disposed=true;
    report={version:'0.45.0',status:'passed',syntheticOnly:true,runtime:process.version,tableCount:13,triggerCount:6,typedThirteenTablesExact:true,blobsHistoryPricingBindingSessionNonceExact:true,restoredStartupLogicalChanges:0,readExpiredSessionCleanupChanges:readCleanupChanges,liveBusinessChanges,rollbackStatus:rollback.status,promotionStatus:promotion.status,previousClosedGenerationRetained:true,pointInTimeOnly:true,postSnapshotRevocationsPreservedClaimed:false,operatorRestoreAvailable:false,existingDatabaseAccessed:false,actual4310Accessed:false,disposed,restoredSummary:restored,formalDeployment:false};
  }catch(error){failureCode=typeof error?.code==='string'&&/^[A-Z_]+$/.test(error.code)?error.code:'REHEARSAL_FAILED';}
  finally{
    for(const resource of [liveApp,fixture])if(resource)try{await resource.close();}catch{failureCode='REHEARSAL_CLEANUP_FAILED';}
    if(workspace&&!disposed)try{disposeSyntheticWorkspace(workspace);disposed=true;}catch{failureCode='REHEARSAL_CLEANUP_FAILED';}
  }
  if(failureCode){console.error(JSON.stringify({status:'failed',syntheticOnly:true,code:failureCode}));process.exitCode=1;}
  else console.log(JSON.stringify(report));
}
