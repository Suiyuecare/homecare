import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { audit, fail, initDb, now } from './model.mjs';

export const PORTAL_ORIGIN = 'https://login.suiyuecare.com';
export const PORTAL_ONLY_PASSWORD = '!portal-only!';
export const HANDOFF_PATH = '/api/auth/handoff';
export const HANDOFF_DESTINATION = '/#/';
export const MAX_HANDOFF_BODY_BYTES = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUBJECT = /^[A-Za-z0-9_-]{8,255}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = new Set(['admin', 'supervisor', 'caregiver', 'finance']);
const CLAIM_KEYS = Object.freeze(['aud', 'moduleId', 'iss', 'googleSubject', 'authUserId', 'email', 'iat', 'exp', 'jti']);
const configurationError = () => { throw new Error('HOME_CARE_PORTAL_CONFIGURATION_INVALID'); };
const invalid = () => fail(401, 'HANDOFF_INVALID', '模組登入聲明無效，請從公司模組頁重新開啟');
const identityDenied = () => fail(403, 'PORTAL_IDENTITY_DENIED', '此公司身分尚未開通居家機構權限');
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validEmail = value => typeof value === 'string' && value.length <= 254 && value === value.trim().toLowerCase() && EMAIL.test(value);

// createApp defaults to local mode. Only its executable startup reads environment
// variables; tests and imported consumers must explicitly opt into Portal mode.
export function normalizePortalConfig(input = null) {
  if (input === null || input === undefined) return Object.freeze({ mode: 'local' });
  if (!plain(input) || !['local', 'portal'].includes(input.mode)) configurationError();
  if (input.mode === 'local') return Object.freeze({ mode: 'local' });
  if (input.portalOrigin !== PORTAL_ORIGIN || typeof input.publicOrigin !== 'string') configurationError();
  let origin;
  try { origin = new URL(input.publicOrigin); } catch { configurationError(); }
  const localHttp = origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !localHttp) || (origin.port === '0' && !localHttp) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || origin.origin !== input.publicOrigin || origin.origin === PORTAL_ORIGIN) configurationError();
  if (typeof input.signingSecret !== 'string' || Buffer.byteLength(input.signingSecret, 'utf8') < 32 || /[\r\n\0]/.test(input.signingSecret)) configurationError();
  return Object.freeze({ mode: 'portal', publicOrigin: origin.origin, publicHost: origin.host, dynamicLoopbackPort: localHttp && origin.port === '0', secureCookie: origin.protocol === 'https:', portalOrigin: PORTAL_ORIGIN, signingSecret: input.signingSecret });
}

export function portalConfigFromEnv(environment = {}) {
  const mode = environment.HOME_CARE_AUTH_MODE || 'local';
  return normalizePortalConfig(mode === 'local' ? { mode } : {
    mode,
    publicOrigin: environment.HOME_CARE_PUBLIC_ORIGIN,
    portalOrigin: environment.HOME_CARE_PORTAL_ORIGIN,
    signingSecret: environment.HOME_CARE_PORTAL_SIGNING_SECRET,
  });
}

export function hasPortalStorage(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name IN ('portal_identity_bindings','portal_handoff_nonces') LIMIT 1").get());
}

// Additive, opt-in schema. The deliberately eleven-table synthetic backup format
// does not support these tables and must continue rejecting this schema.
export function initPortalStorage(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS portal_identity_bindings (
      issuer TEXT NOT NULL,
      google_subject TEXT NOT NULL,
      portal_auth_user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_at TEXT NOT NULL,
      PRIMARY KEY(issuer,google_subject),
      UNIQUE(issuer,portal_auth_user_id)
    );
    CREATE TABLE IF NOT EXISTS portal_handoff_nonces (
      jti TEXT PRIMARY KEY,
      issuer TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      consumed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS portal_nonces_expiry ON portal_handoff_nonces(expires_at);
  `);
}

function validateClaims(claims, config, nowSeconds) {
  if (!exactKeys(claims, CLAIM_KEYS) || claims.aud !== 'home-care' || claims.moduleId !== 'home-care' || claims.iss !== config.portalOrigin || typeof claims.googleSubject !== 'string' || !SUBJECT.test(claims.googleSubject) || typeof claims.authUserId !== 'string' || !UUID.test(claims.authUserId) || !validEmail(claims.email) || typeof claims.jti !== 'string' || !UUID.test(claims.jti) || !Number.isSafeInteger(claims.iat) || claims.iat < 0 || !Number.isSafeInteger(claims.exp) || claims.exp <= claims.iat || claims.exp - claims.iat > 600 || claims.iat > nowSeconds + 30) invalid();
  if (claims.exp <= nowSeconds) fail(401, 'HANDOFF_EXPIRED', '模組登入聲明已逾時，請從公司模組頁重新開啟');
  return Object.freeze({ ...claims });
}

export function verifyPortalHandoffEnvelope(envelope, config, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (config?.mode !== 'portal' || config.portalOrigin !== PORTAL_ORIGIN || typeof config.signingSecret !== 'string' || Buffer.byteLength(config.signingSecret, 'utf8') < 32 || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0) configurationError();
  if (!exactKeys(envelope, ['payload', 'signature']) || typeof envelope.payload !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(envelope.payload) || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(envelope.signature)) invalid();
  const supplied = Buffer.from(envelope.signature, 'base64url');
  if (supplied.length !== 32 || supplied.toString('base64url') !== envelope.signature) invalid();
  const expected = createHmac('sha256', config.signingSecret).update(envelope.payload, 'ascii').digest();
  if (!timingSafeEqual(supplied, expected)) invalid();
  const decoded = Buffer.from(envelope.payload, 'base64url');
  if (decoded.toString('base64url') !== envelope.payload) invalid();
  let claims;
  try { claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded)); } catch { invalid(); }
  return validateClaims(claims, config, nowSeconds);
}

export async function readPortalForm(req) {
  if (typeof req.headers['content-type'] !== 'string' || !/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) fail(415, 'HANDOFF_CONTENT_TYPE', '模組登入須使用表單 POST');
  if (req.headers['content-length'] && Number(req.headers['content-length']) > MAX_HANDOFF_BODY_BYTES) { req.resume(); fail(413, 'HANDOFF_BODY_TOO_LARGE', '模組登入表單過大'); }
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_HANDOFF_BODY_BYTES) { req.resume(); fail(413, 'HANDOFF_BODY_TOO_LARGE', '模組登入表單過大'); }
    chunks.push(chunk);
  }
  let raw;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { invalid(); }
  if (!/^[\x20-\x7e]*$/.test(raw) || raw.split('&').length !== 2 || raw.split('&').some(part => !part || !part.includes('='))) invalid();
  const entries = [...new URLSearchParams(raw).entries()];
  if (entries.length !== 2 || new Set(entries.map(([key]) => key)).size !== 2 || !entries.every(([key]) => ['payload', 'signature'].includes(key))) invalid();
  return Object.fromEntries(entries);
}

export function guardPortalHandoffRequest(req, config) {
  if (req.method !== 'POST' || req.url !== HANDOFF_PATH || config?.mode !== 'portal') fail(405, 'HANDOFF_METHOD', '模組登入僅接受指定 POST 入口');
  if (req.headers.host !== config.publicHost) fail(403, 'HOST_FORBIDDEN', '不接受此主機名稱');
  if (req.headers.origin !== config.portalOrigin) fail(403, 'HANDOFF_ORIGIN_FORBIDDEN', '請從公司模組頁開啟居家系統');
}

export function portalMembershipForUser(db, userId) {
  const row = db.prepare(`SELECT b.*,u.name,u.email AS current_email,m.role,m.employee_id
    FROM portal_identity_bindings b
    JOIN users u ON u.id=b.user_id
    JOIN organizations o ON o.id=b.org_id
    JOIN memberships m ON m.user_id=b.user_id AND m.org_id=b.org_id
    WHERE b.user_id=? AND b.active=1`).get(userId);
  return row && row.issuer === PORTAL_ORIGIN && row.email === row.current_email && ROLES.has(row.role) ? row : null;
}

function resolveBoundIdentity(db, claims) {
  const binding = db.prepare('SELECT * FROM portal_identity_bindings WHERE issuer=? AND google_subject=?').get(claims.iss, claims.googleSubject);
  if (!binding || binding.active !== 1 || binding.portal_auth_user_id !== claims.authUserId || binding.email !== claims.email) identityDenied();
  const current = portalMembershipForUser(db, binding.user_id);
  if (!current || current.org_id !== binding.org_id || current.email !== claims.email) identityDenied();
  if (current.role === 'caregiver') {
    const employee = db.prepare("SELECT data FROM records WHERE org_id=? AND id=? AND entity='employees'").get(current.org_id, current.employee_id || '');
    if (!employee || JSON.parse(employee.data).status !== 'active') identityDenied();
  }
  return { user: { id: current.user_id, name: current.name, email: current.email }, orgId: current.org_id, role: current.role };
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

// Session insertion, nonce consumption, prior-session rotation and audit share
// one synchronous SQLite transaction. The caller publishes its cookie only after
// this function commits; a failure leaves no token, nonce or audit behind.
export function consumePortalHandoff(db, config, envelope, createSession, nowSeconds = Math.floor(Date.now() / 1000)) {
  const claims = verifyPortalHandoffEnvelope(envelope, config, nowSeconds);
  return transaction(db, () => {
    const ctx = resolveBoundIdentity(db, claims);
    if (db.prepare('SELECT 1 FROM portal_handoff_nonces WHERE jti=?').get(claims.jti)) fail(409, 'HANDOFF_REPLAYED', '此模組登入聲明已使用，請從公司模組頁重新開啟');
    db.prepare('DELETE FROM portal_handoff_nonces WHERE expires_at<=?').run(nowSeconds * 1000);
    db.prepare('INSERT INTO portal_handoff_nonces VALUES(?,?,?,?,?,?)').run(claims.jti, claims.iss, ctx.user.id, ctx.orgId, nowSeconds * 1000, claims.exp * 1000);
    const result = createSession(ctx.user);
    audit(db, ctx, 'portal.login', 'users', ctx.user.id, { identityVerified: true, role: ctx.role });
    return result;
  });
}

export function provisionPortalAccount(db, input, { initializeSchema = false } = {}) {
  const keys = ['organizationName', 'name', 'email', 'issuer', 'googleSubject', 'authUserId', 'role'];
  const shortText = value => typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
  if (!exactKeys(input, keys) || !shortText(input.organizationName) || !shortText(input.name) || !validEmail(input.email) || input.issuer !== PORTAL_ORIGIN || typeof input.googleSubject !== 'string' || !SUBJECT.test(input.googleSubject) || typeof input.authUserId !== 'string' || !UUID.test(input.authUserId) || !['admin', 'supervisor', 'finance'].includes(input.role)) fail(422, 'PORTAL_PROVISION_INVALID', '帳號開通參數必須明確且有效');
  return transaction(db, () => {
    // CLI migration and any baseline versions share this transaction with the
    // binding decision. Journal mode is persistent and cannot be rolled back,
    // so this path deliberately preserves it; normal application startup still
    // uses initDb's default WAL configuration.
    if (initializeSchema) initDb(db, { configureJournalMode: false });
    initPortalStorage(db);
    const organizations = db.prepare('SELECT * FROM organizations').all();
    if (organizations.length > 1 || (organizations.length === 1 && organizations[0].name !== input.organizationName)) fail(409, 'PORTAL_PROVISION_CONFLICT', '機構或帳號綁定衝突，未變更既有權限');
    let org = organizations[0];
    let user = db.prepare('SELECT * FROM users WHERE lower(email)=?').get(input.email);
    const conflicting = db.prepare('SELECT * FROM portal_identity_bindings WHERE google_subject=? OR portal_auth_user_id=? OR email=?').all(input.googleSubject, input.authUserId, input.email);
    if (conflicting.some(binding => binding.issuer !== input.issuer || binding.google_subject !== input.googleSubject || binding.portal_auth_user_id !== input.authUserId || binding.email !== input.email || binding.active !== 1 || !org || binding.org_id !== org.id || !user || binding.user_id !== user.id)) fail(409, 'PORTAL_PROVISION_CONFLICT', '機構或帳號綁定衝突，未變更既有權限');
    if (user) {
      const existingBinding = db.prepare('SELECT * FROM portal_identity_bindings WHERE user_id=?').get(user.id);
      if (existingBinding && (existingBinding.issuer !== input.issuer || existingBinding.google_subject !== input.googleSubject || existingBinding.portal_auth_user_id !== input.authUserId || existingBinding.email !== input.email)) fail(409, 'PORTAL_PROVISION_CONFLICT', '機構或帳號綁定衝突，未變更既有權限');
      const memberships = db.prepare('SELECT * FROM memberships WHERE user_id=?').all(user.id);
      if (!org || user.name !== input.name || user.email !== input.email || user.password_hash !== PORTAL_ONLY_PASSWORD || memberships.length !== 1 || memberships[0].org_id !== org.id || memberships[0].role !== input.role || memberships[0].employee_id !== null) fail(409, 'PORTAL_PROVISION_CONFLICT', '機構或帳號綁定衝突，未變更既有權限');
      if (conflicting.length === 1) return { status: 'already-provisioned', organizationId: org.id, userId: user.id, role: input.role, identityBound: true };
    }
    if (!org) { org = { id: randomUUID(), name: input.organizationName }; db.prepare('INSERT INTO organizations VALUES(?,?,?)').run(org.id, org.name, now()); }
    if (!user) {
      user = { id: randomUUID(), name: input.name, email: input.email };
      db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(user.id, user.name, user.email, PORTAL_ONLY_PASSWORD, now());
      db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(org.id, user.id, input.role, null);
    }
    db.prepare('INSERT INTO portal_identity_bindings VALUES(?,?,?,?,?,?,?,?)').run(input.issuer, input.googleSubject, input.authUserId, input.email, user.id, org.id, 1, now());
    audit(db, { orgId: org.id, user }, 'portal.account.provision', 'users', user.id, { role: input.role, identityBound: true });
    return { status: 'created', organizationId: org.id, userId: user.id, role: input.role, identityBound: true };
  });
}
