import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { surveyFixture } from './surveys-fixture.mjs';
import { openPublicSurvey,submitPublicSurvey,readSurveyInvitationHistory,listSurveyResponses,confirmSurveyCreateResponse,guardSurveyManager } from '../src/server/surveys.mjs';
const sourceUrl=relative=>{const formal=new URL('../'+relative,import.meta.url);return fs.existsSync(formal)?formal:new URL('../../../../'+relative,import.meta.url);};
const {initDb}=await import(sourceUrl('src/server/model.mjs'));
const {createSyntheticWorkspace,syntheticDatabasePath,captureSyntheticBackup,restoreSyntheticBackup,promoteSyntheticRestore,disposeSyntheticWorkspace}=await import(sourceUrl('src/server/synthetic-backup.mjs'));
const {readSyntheticRawState}=await import(sourceUrl('tests/synthetic-backup-fixtures.mjs'));
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const changes=db=>db.prepare('SELECT total_changes() n').get().n;
const transaction=db=>fn=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};

test('owned synthetic 11-table/6-trigger backup restores immutable survey schema/answers/hash-only state and idem; failed cutover preserves B then successful cutover restores A without read/replay writes',()=>{
 const workspace=createSyntheticWorkspace();let source,live;
 try{
  source=surveyFixture({dbPath:syntheticDatabasePath(workspace,'source')});
  const preview=source.preview(),createBody={...source.input,previewHash:preview.previewHash};let token;
  // source.issue uses the same server save/version/audit callbacks; store only its projected original ACK in the baseline shared cache.
  const issued=source.issue();token=issued.token;
  source.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?,?,?,?)').run(source.orgId,source.ctx.user.id,'synthetic-survey-original-create','POST /api/survey-invitations/create',createHash('sha256').update(JSON.stringify(createBody)).digest('hex'),JSON.stringify({item:issued.item}),201,new Date().toISOString());
  const body={token,nonce:source.nonce(),formHash:issued.item.formHash,answers:source.answers};submitPublicSurvey(source.db,body,source.deps);
  const stopped=source.issue({publicTitle:'合成已停用第二公開表單'});source.disable(stopped.item);
  const baseline=readSyntheticRawState(source.db),sourceChanges=changes(source.db),reference=captureSyntheticBackup(workspace);assert.equal(baseline.schema.filter(row=>row.type==='table').length,11);assert.equal(baseline.schema.filter(row=>row.type==='trigger').length,6);
  assert.deepEqual(readSyntheticRawState(source.db),baseline);assert.equal(changes(source.db),sourceChanges);
  restoreSyntheticBackup(workspace,reference,'live');live=new DatabaseSync(syntheticDatabasePath(workspace,'live'));initDb(live);assert.equal(changes(live),0);assert.deepEqual(readSyntheticRawState(live),baseline);
  const liveDeps={...source.deps,transaction:transaction(live)};guardSurveyManager(live,source.ctx);
  const opened=openPublicSurvey(live,{token},liveDeps);assert.equal(opened.formHash,body.formHash);assert.deepEqual(submitPublicSurvey(live,body,liveDeps),{accepted:true});
  const cached=live.prepare('SELECT response FROM idempotency WHERE org_id=? AND user_id=? AND key=?').get(source.orgId,source.ctx.user.id,'synthetic-survey-original-create');assert.deepEqual(confirmSurveyCreateResponse(live,source.ctx,createBody,JSON.parse(cached.response),liveDeps),{item:issued.item});
  const stoppedHistory=readSurveyInvitationHistory(live,source.ctx,stopped.item.id,new URLSearchParams('compare=previous'),liveDeps);assert.equal(stoppedHistory.currentVersion,2);assert.deepEqual(stoppedHistory.items.map(item=>item.snapshot.status),['disabled','active']);
  assert.deepEqual(listSurveyResponses(live,source.ctx,issued.item.id,new URLSearchParams(),liveDeps).items[0].answers,source.answers);assert.equal(changes(live),0);assert.deepEqual(readSyntheticRawState(live),baseline);
  assert.throws(()=>live.prepare('UPDATE record_versions SET snapshot=? WHERE record_id=?').run('{}',issued.item.id),/immutable/);
  submitPublicSurvey(live,{...body,nonce:source.nonce(),answers:{...source.answers,text:'切換前B世代合成原值'}},liveDeps);const generationB=readSyntheticRawState(live);live.close();live=undefined;
  const livePath=syntheticDatabasePath(workspace,'live'),generationBHash=sha(livePath);restoreSyntheticBackup(workspace,reference,'staged');assert.equal(promoteSyntheticRestore(workspace,{forceRollback:true}).status,'rolled_back');assert.equal(sha(livePath),generationBHash);
  live=new DatabaseSync(livePath);initDb(live);assert.deepEqual(readSyntheticRawState(live),generationB);live.close();live=undefined;
  assert.equal(promoteSyntheticRestore(workspace,{forceRollback:false}).status,'promoted');assert.equal(sha(syntheticDatabasePath(workspace,'previous')),generationBHash);
  live=new DatabaseSync(livePath);initDb(live);assert.deepEqual(readSyntheticRawState(live),baseline);assert.equal(changes(live),0);assert.deepEqual(submitPublicSurvey(live,body,{...source.deps,transaction:transaction(live)}),{accepted:true});assert.equal(changes(live),0);
  assert.deepEqual(readSyntheticRawState(source.db),baseline);assert.equal(changes(source.db),sourceChanges);
 }finally{live?.close();source?.close();disposeSyntheticWorkspace(workspace);}
});
