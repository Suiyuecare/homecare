import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes,createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { renderSurveyQr,surveyLocalUrl,SURVEY_QR_OPTIONS } from '../src/server/survey-qr.mjs';
import { surveyFixture,tableFingerprint,totalChanges } from './surveys-fixture.mjs';
const require=createRequire(import.meta.url),qrcodeRequire=createRequire(require.resolve('qrcode')),{PNG}=qrcodeRequire('pngjs');
const sha=value=>createHash('sha256').update(value).digest('hex');
const base=path.dirname(fileURLToPath(new URL('../package.json',import.meta.url)));
test('real standards QR PNG independently decodes entire original local URL with four-module white quiet zone and zero DB writes',async()=>{
 const f=surveyFixture();try{const issued=f.issue(),origin='http://127.0.0.1:52341',before=[tableFingerprint(f.db),totalChanges(f.db)],png=await renderSurveyQr(f.db,f.ctx,issued.item.id,{token:issued.token},origin,f.deps);
 assert.deepEqual([tableFingerprint(f.db),totalChanges(f.db)],before);const url=surveyLocalUrl(origin,issued.token),parsed=PNG.sync.read(png),symbol=QRCode.create(url,{errorCorrectionLevel:'M'});
 const scale=SURVEY_QR_OPTIONS.scale,quietPixels=4*scale;assert.equal(parsed.width,(symbol.modules.size+8)*scale);assert.equal(parsed.height,parsed.width);
 for(let y=0;y<parsed.height;y++)for(let x=0;x<parsed.width;x++)if(x<quietPixels||y<quietPixels||x>=parsed.width-quietPixels||y>=parsed.height-quietPixels){const at=(y*parsed.width+x)*4;assert.deepEqual([...parsed.data.subarray(at,at+4)],[255,255,255,255]);}
 const decoded=jsQR(new Uint8ClampedArray(parsed.data),parsed.width,parsed.height,{inversionAttempts:'dontInvert'});assert.ok(decoded);assert.equal(decoded.data,url);
 const outputRoot=path.join(base,'outputs/software/survey-qr-qa');fs.mkdirSync(outputRoot,{recursive:true});const output=fs.mkdtempSync(path.join(outputRoot,'attempt-'));fs.writeFileSync(path.join(output,'synthetic-qr.png'),png);
 fs.writeFileSync(path.join(output,'proof.json'),JSON.stringify({syntheticOnly:true,tokenDbDestroyedAfterTest:true,library:'qrcode@1.5.4',decoder:'jsqr@1.4.0',originalUrlSha256:sha(url),decodedUrlSha256:sha(decoded.data),exactOriginalUrlRoundtrip:true,pngSha256:sha(png),width:parsed.width,height:parsed.height,moduleCount:symbol.modules.size,scale,quietZoneModules:4,quietZonePixels:quietPixels,allQuietZonePixelsOpaqueWhite:true,allElevenTablesUnchanged:true,totalChangesUnchanged:true,phoneReachability:'not verified; local loopback URL is not remotely reachable'},null,2)+'\n');
 }finally{f.close();}
});
test('QR requires manager current membership, exact same-org fresh active token and canonical server-supplied origin',async()=>{
 const f=surveyFixture();try{const issued=f.issue(),origin='http://127.0.0.1:52341',before=[tableFingerprint(f.db),totalChanges(f.db)];
 for(const badOrigin of [origin+'/',origin+'/other',origin+'?x=1',origin+'#x','https://user:pass@example.invalid','javascript:alert(1)'])assert.throws(()=>surveyLocalUrl(badOrigin,issued.token),error=>error.code==='SURVEY_ORIGIN_INVALID');
 await assert.rejects(renderSurveyQr(f.db,{...f.ctx,role:'finance'},issued.item.id,{token:issued.token},origin,f.deps),error=>error.status===403);
 await assert.rejects(renderSurveyQr(f.db,f.ctx,issued.item.id,{token:randomBytes(32).toString('base64url')},origin,f.deps),error=>error.status===404);
 assert.deepEqual([tableFingerprint(f.db),totalChanges(f.db)],before);f.disable(issued.item);
 await assert.rejects(renderSurveyQr(f.db,f.ctx,issued.item.id,{token:issued.token},origin,f.deps),error=>error.status===404);
 }finally{f.close();}
});

test('QR await race rechecks current manager role and disabled invitation before any PNG can escape',async()=>{
 for(const change of ['role','disable']){const f=surveyFixture(),original=QRCode.toBuffer;try{const issued=f.issue(),origin='http://127.0.0.1:52341';let guardedState;
  QRCode.toBuffer=async(...args)=>{const png=await original(...args);if(change==='role')f.db.prepare('UPDATE memberships SET role=? WHERE org_id=? AND user_id=?').run('finance',f.orgId,f.ctx.user.id);else f.disable(issued.item);guardedState=[tableFingerprint(f.db),totalChanges(f.db)];return png;};
  await assert.rejects(renderSurveyQr(f.db,f.ctx,issued.item.id,{token:issued.token},origin,f.deps),error=>error.status===(change==='role'?403:404));assert.ok(guardedState);assert.deepEqual([tableFingerprint(f.db),totalChanges(f.db)],guardedState);
 }finally{QRCode.toBuffer=original;f.close();}}
});
