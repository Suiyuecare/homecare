import { api, getContext } from '../ui.js';
import { surveyIdentity } from '../data/survey-ui.js';
import { surveySecret } from '../data/survey-core.js';

const MAX_BYTES = 2097152;
const aborted = () => new DOMException('本機填答操作已取消。', 'AbortError');
const unavailable = status => Object.assign(new Error('此本機填答連結目前無法使用。'), { status, code: 'SURVEY_UNAVAILABLE' });
async function decode(response, guard) {
  const bytes = await response.arrayBuffer(); guard();
  if (bytes.byteLength > MAX_BYTES) throw new Error('完整填答回應超過本機上限；未截斷保存內容。');
  let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('回應未確認；請保留輸入並以原識別重試。'); }
  return value;
}
function responseError(value, status) {
  const error = new Error(value?.error?.message || `本機操作未完成（${status}）。`);
  Object.assign(error, { status, code: value?.error?.code, fields: value?.error?.fields }); return error;
}
function requestSignal(signal) {
  if (!signal) throw new TypeError('Shared owner signal is required');
  return AbortSignal.any([signal, AbortSignal.timeout(15000)]);
}
/** PNG stays in this dialog's memory; data: is permitted by the existing CSP. */
export async function surveyPngDataUrl(png, { signal, isCurrent = () => true } = {}) {
  const guard = () => { if (signal?.aborted || !isCurrent()) throw aborted(); }; guard();
  if (!(png instanceof Blob) || png.type !== 'image/png') throw new Error('QR圖檔格式未確認。');
  const bytes = new Uint8Array(await png.arrayBuffer()); guard();
  if (bytes.length > MAX_BYTES || bytes.length < 8 || ![137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value)) throw new Error('QR圖檔未完整確認。');
  let encoded = ''; for (let start=0;start<bytes.length;start+=4096) encoded += String.fromCharCode(...bytes.subarray(start,start+4096));
  guard(); return 'data:image/png;base64,' + btoa(encoded);
}
/** Public transport deliberately never calls ui.api or reads/clears private session context. */
export async function publicSurveyRequest(action, payload, { signal, isCurrent = () => true, fetchImpl = globalThis.fetch } = {}) {
  if (!['open', 'submit'].includes(action)) throw new Error('本機填答操作不合法。');
  const guard = () => { if (signal?.aborted || !isCurrent()) throw aborted(); }; guard();
  const body = JSON.stringify(payload); if (new TextEncoder().encode(body).byteLength > MAX_BYTES) throw new Error('完整填答超過本機上限。');
  try {
    const response = await fetchImpl('/api/public-surveys/' + action, { method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: requestSignal(signal), headers: { 'Content-Type': 'application/json' }, body });
    guard();
    if (!response.ok && [401, 403, 404].includes(response.status)) throw unavailable(response.status);
    const value = await decode(response, guard); if (!response.ok) throw responseError(value, response.status); return value;
  } catch (error) {
    guard(); if (error.name === 'TimeoutError') throw new Error('連線逾時，請保留原答案與提交識別重試。');
    if (error instanceof TypeError) throw new Error('目前無法連線，請保留原答案並重試。'); throw error;
  }
}
/** Only token-header and PNG branches need a thin private transport; shared dialog/form owns cancellation. */
export async function privateSurveyRequest(action, payload, { id, idempotencyKey, confirmAcknowledgement, signal, isCurrent = () => true, fetchImpl = globalThis.fetch } = {}) {
  const context = getContext(), identity = surveyIdentity(context), orgId = context.organizationId ?? context.orgId;
  const guard = () => { if (signal?.aborted || !isCurrent() || getContext() !== context || surveyIdentity(getContext()) !== identity) throw aborted(); }; guard();
  if (!['admin', 'supervisor'].includes(context.role) || !orgId || !context.csrfToken) throw Object.assign(new Error('只有原機構管理者或督導可操作。'), { status: 403 });
  if (!['create', 'qr'].includes(action) || action === 'create' && (typeof idempotencyKey !== 'string' || !idempotencyKey || typeof confirmAcknowledgement !== 'function') || action === 'qr' && (typeof id !== 'string' || !id)) throw new Error('本機填答請求識別未確認。');
  const target = action === 'create' ? '/api/survey-invitations/create' : `/api/survey-invitations/${encodeURIComponent(id)}/qr`;
  const body = JSON.stringify(payload); if (new TextEncoder().encode(body).byteLength > MAX_BYTES) throw new Error('本次完整開通資料超過上限。');
  const response = await fetchImpl(target, { method: 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', signal: requestSignal(signal), headers: { 'Content-Type': 'application/json', 'X-Org-Id': orgId, 'X-CSRF-Token': context.csrfToken, ...(action === 'create' ? { 'Idempotency-Key': idempotencyKey } : {}) }, body });
  guard();
  if (!response.ok) {
    const value = await decode(response, guard);
    if (response.status === 401) { try { await api('/api/session', { signal }); } catch { /* Existing shared expiry handler owns private session invalidation. */ } }
    guard(); throw responseError(value, response.status);
  }
  if (action === 'qr') {
    const type = response.headers.get('Content-Type'); if (!type || type.split(';')[0].trim().toLowerCase() !== 'image/png') throw new Error('QR回應格式未確認，沒有顯示連結。');
    const bytes = await response.arrayBuffer(); guard();
    if (bytes.byteLength > MAX_BYTES || bytes.byteLength < 8 || ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => new Uint8Array(bytes)[i] === n)) throw new Error('QR圖檔未完整確認。');
    return { png: new Blob([bytes], { type: 'image/png' }) };
  }
  const data = await decode(response, guard);
  await confirmAcknowledgement(data); guard();
  // A one-time header is read only after the complete saved ACK was confirmed.
  const raw = response.headers.get('X-Survey-Token');
  return { data, issuedToken: surveySecret(raw) ? raw : null };
}
