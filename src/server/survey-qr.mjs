import QRCode from 'qrcode';
import { surveySecret } from '../../public/data/survey-core.js';
import { formFailure } from '../../public/data/custom-form-engine.js';
import { verifySurveyQrToken } from './surveys.mjs';
export const SURVEY_QR_OPTIONS=Object.freeze({type:'png',errorCorrectionLevel:'M',margin:4,scale:8,color:{dark:'#000000ff',light:'#ffffffff'}});
/** The root supplies the already Host/Origin-guarded origin, never a request body or arbitrary return URL. */
export function surveyLocalUrl(trustedOrigin,token,fail=formFailure) {
 let parsed;try{parsed=new URL(trustedOrigin);}catch{fail(422,'SURVEY_ORIGIN_INVALID','本機填答網址來源無法確認。');}
 if(typeof trustedOrigin!=='string'||trustedOrigin.length>1800||parsed.origin!==trustedOrigin||!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash||!surveySecret(token))fail(422,'SURVEY_ORIGIN_INVALID','本機填答網址來源無法確認。');
 return trustedOrigin+'/survey/#'+token;
}
export async function renderSurveyQr(db,ctx,id,payload,trustedOrigin,deps={}) {
 verifySurveyQrToken(db,ctx,id,payload,deps);
 const url=surveyLocalUrl(trustedOrigin,payload.token,deps.fail??formFailure);
 const png=await QRCode.toBuffer(url,SURVEY_QR_OPTIONS);
 // Permission, invitation, template and expiry may have changed while encoding; recheck before returning bytes.
 verifySurveyQrToken(db,ctx,id,payload,deps);
 return png;
}
