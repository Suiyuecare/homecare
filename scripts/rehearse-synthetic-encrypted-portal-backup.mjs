import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify, isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import * as portalBackup from '../src/server/synthetic-portal-backup.mjs';

const FORMAT = 'suiyue-synthetic-encrypted-portal-sqlite-v1';
const POLICY = 'clear-sessions-disable-bindings-rotate-key-v1';
const TABLES = ['attachment_files', 'audit', 'certification_attachment_files', 'demo_seeds', 'idempotency', 'memberships', 'organizations', 'portal_handoff_nonces', 'portal_identity_bindings', 'record_versions', 'records', 'sessions', 'users'];
const SECURITY_TABLES = ['sessions', 'portal_identity_bindings', 'portal_handoff_nonces'];
const PROOF_KEYS = ['format', 'tableCount', 'triggerCount', 'userVersion', 'applicationId', 'schemaSha256', 'tables', 'blobSha256', 'versionsSha256', 'billingSnapshotsSha256', 'fingerprint', 'mainFileSha256', 'mainFileBytes'];
const DB_LIMIT = 32 * 1024 * 1024, PROOF_LIMIT = 64 * 1024, ENVELOPE_LIMIT = 48 * 1024 * 1024;
const derive = promisify(scrypt), typedLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length').get, typedSet = Uint8Array.prototype.set;
const encode = value => Buffer.from(JSON.stringify(value), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error('Synthetic encrypted Portal operation refused.'), { name: 'SyntheticEncryptedPortalError', code }); };
const exactArity = (actual, wanted) => { if (actual !== wanted) fail('INVALID_ARGUMENT'); };
const safeInteger = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const hashValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function closed(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some(name => typeof name !== 'string' || !keys.includes(name))) fail(code);
  for (const key of keys) if (!descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value')) fail(code);
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function projectProof(value) {
  const proof = closed(value, PROOF_KEYS, 'PROOF_INVALID');
  if (proof.format !== 'suiyue-synthetic-portal-sqlite-inspection-v1' || proof.tableCount !== 13 || proof.triggerCount !== 6 ||
      !safeInteger(proof.userVersion) || !safeInteger(proof.applicationId) || !safeInteger(proof.mainFileBytes) || proof.mainFileBytes < 100 || proof.mainFileBytes > DB_LIMIT) fail('PROOF_INVALID');
  for (const key of ['schemaSha256', 'versionsSha256', 'billingSnapshotsSha256', 'fingerprint', 'mainFileSha256']) if (!hashValid(proof[key])) fail('PROOF_INVALID');
  const raw = closed(proof.tables, TABLES, 'PROOF_INVALID'), tables = {};
  for (const name of TABLES) { const row = closed(raw[name], ['count', 'sha256'], 'PROOF_INVALID'); if (!safeInteger(row.count) || !hashValid(row.sha256)) fail('PROOF_INVALID'); tables[name] = row; }
  const blobs = closed(proof.blobSha256, ['attachment_files', 'certification_attachment_files'], 'PROOF_INVALID');
  if (!hashValid(blobs.attachment_files) || !hashValid(blobs.certification_attachment_files)) fail('PROOF_INVALID');
  const body = { tableCount: 13, triggerCount: 6, userVersion: proof.userVersion, applicationId: proof.applicationId, schemaSha256: proof.schemaSha256, tables, blobSha256: blobs, versionsSha256: proof.versionsSha256, billingSnapshotsSha256: proof.billingSnapshotsSha256 };
  if (sha(encode(body)) !== proof.fingerprint) fail('PROOF_INVALID');
  return { format: proof.format, ...body, fingerprint: proof.fingerprint, mainFileSha256: proof.mainFileSha256, mainFileBytes: proof.mainFileBytes };
}
function copyBuffer(value, maximum, code) {
  if (!Buffer.isBuffer(value)) fail(code);
  const length = typedLength.call(value); if (length > maximum) fail('CAPACITY_EXCEEDED');
  const copy = Buffer.alloc(length); typedSet.call(copy, value); return copy;
}
function passwordCopy(value) {
  const copy = copyBuffer(value, 1024, 'PASSPHRASE_INVALID');
  try { if (copy.length < 16 || copy.includes(0) || copy.includes(10) || copy.includes(13)) fail('PASSPHRASE_INVALID'); new TextDecoder('utf-8', { fatal: true }).decode(copy); return copy; }
  catch (error) { copy.fill(0); if (error?.name === 'SyntheticEncryptedPortalError') throw error; fail('PASSPHRASE_INVALID'); }
}
function base64(text, length) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) fail('ENVELOPE_INVALID');
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text || length !== undefined && bytes.length !== length) fail('ENVELOPE_INVALID');
  return bytes;
}
const header = (kdf, cipher) => ({ format: FORMAT, version: 1, syntheticOnly: true, recoveryPolicy: POLICY, kdf, cipher: { name: 'aes-256-gcm', iv: cipher.iv } });
function parseEnvelope(bytes) {
  let raw; try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('ENVELOPE_INVALID'); }
  const envelope = closed(raw, ['format', 'version', 'syntheticOnly', 'recoveryPolicy', 'kdf', 'cipher', 'ciphertext'], 'ENVELOPE_INVALID');
  if (envelope.format !== FORMAT || envelope.version !== 1 || envelope.syntheticOnly !== true || envelope.recoveryPolicy !== POLICY) fail('ENVELOPE_INVALID');
  const kdf = closed(envelope.kdf, ['name', 'N', 'r', 'p', 'keyLength', 'salt'], 'ENVELOPE_INVALID');
  if (kdf.name !== 'scrypt' || kdf.N !== 32768 || kdf.r !== 8 || kdf.p !== 1 || kdf.keyLength !== 32) fail('ENVELOPE_INVALID');
  const cipher = closed(envelope.cipher, ['name', 'iv', 'tag'], 'ENVELOPE_INVALID');
  if (cipher.name !== 'aes-256-gcm') fail('ENVELOPE_INVALID');
  const salt = base64(kdf.salt, 32), iv = base64(cipher.iv, 12), tag = base64(cipher.tag, 16), ciphertext = base64(envelope.ciphertext);
  if (ciphertext.length < 104 || ciphertext.length > DB_LIMIT + PROOF_LIMIT + 4 || !encode({ ...header(kdf, cipher), cipher, ciphertext: envelope.ciphertext }).equals(bytes)) fail('ENVELOPE_INVALID');
  return { kdf, cipher, salt, iv, tag, ciphertext };
}

// Pure byte helpers never access a path or environment. They are profile-closed:
// the eleven-table encrypted facade and its capability contract remain unchanged.
export async function sealSyntheticPortalBackupBytes(bytes, proof, password) {
  exactArity(arguments.length, 3); let owned, proofBytes, passwordBytes, key, plaintext;
  try {
    owned = copyBuffer(bytes, DB_LIMIT, 'INVALID_ARGUMENT'); const projected = projectProof(proof); proofBytes = encode(projected);
    if (proofBytes.length > PROOF_LIMIT || owned.length !== projected.mainFileBytes || sha(owned) !== projected.mainFileSha256) fail('PROOF_INVALID');
    passwordBytes = passwordCopy(password); const salt = randomBytes(32), iv = randomBytes(12);
    const kdf = { name: 'scrypt', N: 32768, r: 8, p: 1, keyLength: 32, salt: salt.toString('base64') }, cipherMeta = { name: 'aes-256-gcm', iv: iv.toString('base64') };
    plaintext = Buffer.alloc(4 + proofBytes.length + owned.length); plaintext.writeUInt32BE(proofBytes.length); proofBytes.copy(plaintext, 4); owned.copy(plaintext, 4 + proofBytes.length);
    key = await derive(passwordBytes, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(encode(header(kdf, cipherMeta)));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return encode({ ...header(kdf, cipherMeta), cipher: { ...cipherMeta, tag: cipher.getAuthTag().toString('base64') }, ciphertext: encrypted.toString('base64') });
  } finally { for (const bytes of [owned, proofBytes, passwordBytes, key, plaintext]) bytes?.fill(0); }
}

export async function openSyntheticPortalBackupBytes(envelopeBytes, password) {
  exactArity(arguments.length, 2); let owned, passwordBytes, key, unverified, plaintext;
  try {
    owned = copyBuffer(envelopeBytes, ENVELOPE_LIMIT, 'ENVELOPE_INVALID'); const envelope = parseEnvelope(owned); passwordBytes = passwordCopy(password);
    key = await derive(passwordBytes, envelope.salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    try {
      const cipher = createDecipheriv('aes-256-gcm', key, envelope.iv); cipher.setAAD(encode(header(envelope.kdf, envelope.cipher))); cipher.setAuthTag(envelope.tag);
      unverified = cipher.update(envelope.ciphertext); const final = cipher.final();
      try { plaintext = Buffer.concat([unverified, final]); } finally { final.fill(0); }
    } catch { fail('AUTHENTICATION_FAILED'); }
    if (plaintext.length < 104) fail('PROOF_INVALID'); const length = plaintext.readUInt32BE(0);
    if (length < 1 || length > PROOF_LIMIT || plaintext.length - length - 4 < 100 || plaintext.length - length - 4 > DB_LIMIT) fail('PROOF_INVALID');
    const proofBytes = plaintext.subarray(4, 4 + length); let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(proofBytes)); } catch { fail('PROOF_INVALID'); }
    const proof = projectProof(parsed); if (!encode(proof).equals(proofBytes)) fail('PROOF_INVALID');
    const bytes = plaintext.subarray(4 + length); if (bytes.length !== proof.mainFileBytes || sha(bytes) !== proof.mainFileSha256) fail('PROOF_INVALID');
    return { bytes: Buffer.from(bytes), proof };
  } finally { for (const bytes of [owned, passwordBytes, key, unverified, plaintext]) bytes?.fill(0); }
}

const same = (first, second, label) => assert(isDeepStrictEqual(first, second), label);
const identity = filename => { const stat = lstatSync(filename); return { dev: stat.dev, ino: stat.ino, uid: stat.uid }; };
function ownedRead(filename, lease) {
  const stat = lstatSync(filename);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600); same(identity(filename), lease, 'Only original owned file identity is read');
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const opened = fstatSync(fd); same({ dev: opened.dev, ino: opened.ino, uid: opened.uid }, lease, 'Opened FD retains owned identity'); const bytes = readFileSync(fd); assert.equal(bytes.length, stat.size); same(identity(filename), lease, 'Read retains identity'); return bytes; }
  finally { closeSync(fd); }
}
function writeNew(filename, bytes) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) assert(!readdirSync(path.dirname(filename)).includes(path.basename(filename) + suffix), 'New scratch target has no existing identity or sidecar');
  const fd = openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  return identity(filename);
}
function businessExact(raw, original) {
  same(raw.typedSchema, original.typedSchema, 'Complete schema retains bytes');
  assert.equal(raw.userVersion, original.userVersion); assert.equal(raw.applicationId, original.applicationId);
  for (const table of TABLES.filter(name => !SECURITY_TABLES.includes(name))) same(raw.typedTables[table], original.typedTables[table], 'Every nonsecurity table and stored field remains exact');
}

export async function rehearseSyntheticEncryptedPortalBackup() {
  exactArity(arguments.length, 0); let workspace, fixture, restoredApp, plaintext, cipherBytes, opened, password, disposed = false;
  try {
    const unchangedFiles = ['synthetic-backup.mjs', 'synthetic-portal-backup.mjs', 'synthetic-encrypted-backup.mjs', 'synthetic-backup-core.mjs'];
    const facadeHashes = () => unchangedFiles.map(name => sha(readFileSync(new URL('../src/server/' + name, import.meta.url))));
    const facadesBefore = facadeHashes();
    const { createSyntheticPortalBackupFixture, readPortalSyntheticRawState } = await import('../tests/portal-synthetic-backup-fixtures.mjs');
    const { syntheticClient } = await import('../tests/synthetic-backup-fixtures.mjs');
    const { createApp } = await import('../src/server/index.mjs');
    const { PORTAL_ORIGIN } = await import('../src/server/portal-handoff.mjs');
    const { commitAccountChange, accountMembershipActive } = await import('../src/server/account-administration.mjs');
    workspace = portalBackup.createSyntheticPortalWorkspace(); fixture = await createSyntheticPortalBackupFixture({ workspace });
    const ctx = { orgId: fixture.orgId, role: 'admin', user: { id: fixture.identities.admin.userId } };
    const suspend = (role, reason) => {
      fixture.app.db.exec('BEGIN IMMEDIATE');
      try { const result = commitAccountChange(fixture.app.db, ctx, fixture.identities[role].userId, { version: 0, role: fixture.identities[role].role, employeeId: null, status: 'suspended', reason }); fixture.app.db.exec('COMMIT'); return result; }
      catch (error) { fixture.app.db.exec('ROLLBACK'); throw error; }
    };
    suspend('inactive', '合成快照前停用，生命週期歷程須完整保留');
    const admin = fixture.actors.admin.client;
    const draftRule = (await admin.json('POST', 'business-rules', { kind: 'pricing', code: 'SYNTHETIC-ENCRYPTED-PORTAL', name: '合成明確核定規則', validFrom: '2026-01-01', validTo: '2026-12-31', parameters: { unitPriceCents: 27183, copayBasisPoints: 1234, monthlyCapCents: 987654 }, sourceReference: '僅合成還原規則，不是正式支付規範', note: '完整規則與歷程須保留' }, { orgId: fixture.orgId, status: 201 })).item;
    const rule = (await admin.json('PATCH', `business-rules/${draftRule.id}`, { version: draftRule.version, status: 'approved' }, { orgId: fixture.orgId })).item;
    const ruleHistory = await admin.json('GET', `business-rules/${rule.id}/history`, undefined, { orgId: fixture.orgId });
    const original = fixture.readRawState(), beforeChanges = fixture.app.db.prepare('SELECT total_changes() AS n').get().n;
    portalBackup.captureSyntheticBackup(workspace); const proof = portalBackup.inspectSyntheticDatabase(workspace, 'backup');
    const backup = portalBackup.syntheticDatabasePath(workspace, 'backup'), backupLease = identity(backup), root = path.dirname(backup), manifest = path.join(root, 'backup.manifest.json'), manifestLease = identity(manifest);
    plaintext = ownedRead(backup, backupLease); password = Buffer.from(randomBytes(48).toString('hex'));
    cipherBytes = await sealSyntheticPortalBackupBytes(plaintext, proof, password);
    const encryptedPath = path.join(root, 'encrypted-portal.json'), cipherLease = writeNew(encryptedPath, cipherBytes);
    const reread = ownedRead(encryptedPath, cipherLease); assert.equal(sha(reread), sha(cipherBytes)); reread.fill(0);
    same(identity(backup), backupLease, 'Plaintext removal only uses original capture identity'); same(identity(manifest), manifestLease, 'Manifest removal only uses original capture identity');
    rmSync(backup); rmSync(manifest); plaintext.fill(0); plaintext = null;
    assert(!readdirSync(root).includes('backup.sqlite') && !readdirSync(root).includes('backup.manifest.json'));
    same(fixture.readRawState(), original, 'Encryption and capture have zero logical source changes'); assert.equal(fixture.app.db.prepare('SELECT total_changes() AS n').get().n, beforeChanges);
    const revoked = suspend('supervisor', '合成快照後停用，還原不能復活此身份'); assert.equal(revoked.item.status, 'suspended');
    const postSnapshotLogin = await fixture.normalHandoff('finance'), postSource = fixture.readRawState(), postChanges = fixture.app.db.prepare('SELECT total_changes() AS n').get().n;
    const staged = portalBackup.syntheticDatabasePath(workspace, 'staged'), beforeFiles = readdirSync(root).sort();
    const wrongPassword = Buffer.from(randomBytes(48).toString('hex'));
    try { await assert.rejects(openSyntheticPortalBackupBytes(cipherBytes, wrongPassword), error => error.code === 'AUTHENTICATION_FAILED'); }
    finally { wrongPassword.fill(0); }
    const bad = JSON.parse(cipherBytes.toString()); const tamperedTag = Buffer.from(bad.cipher.tag, 'base64'); tamperedTag[0] ^= 1; bad.cipher.tag = tamperedTag.toString('base64');
    await assert.rejects(openSyntheticPortalBackupBytes(encode(bad), password), error => error.code === 'AUTHENTICATION_FAILED'); same(readdirSync(root).sort(), beforeFiles, 'Failed decryption has no filesystem writes');
    opened = await openSyntheticPortalBackupBytes(cipherBytes, password); same(opened.proof, proof, 'Authenticated complete13-table proof retained');
    writeNew(staged, opened.bytes); opened.bytes.fill(0); opened = null;
    const restoredProof = portalBackup.inspectSyntheticDatabase(workspace, 'staged'); same(restoredProof, proof, 'Actual independent Portal SQLite inspection retains all schema/typed rows/bytes');
    let candidate = new DatabaseSync(staged);
    try {
      same(readPortalSyntheticRawState(candidate), original, 'Complete13-table independent typed fixture oracle matches snapshot');
      candidate.exec('BEGIN IMMEDIATE');
      try { candidate.exec('DELETE FROM sessions; UPDATE portal_identity_bindings SET active=0;'); candidate.exec('COMMIT'); } catch (error) { candidate.exec('ROLLBACK'); throw error; }
      const quarantined = readPortalSyntheticRawState(candidate); businessExact(quarantined, original); same(quarantined.typedTables.portal_handoff_nonces, original.typedTables.portal_handoff_nonces, 'All captured consumed/expired nonces retained');
      assert.equal(quarantined.tables.sessions.length, 0); assert(quarantined.tables.portal_identity_bindings.every(binding => binding.active === 0));
    } finally { candidate.close(); candidate = null; }
    const newKey = randomBytes(48).toString('hex'); assert.notEqual(newKey, fixture.portalConfig.signingSecret);
    restoredApp = createApp({ dbPath: staged, host: '127.0.0.1', port: 0, portalConfig: { ...fixture.portalConfig, signingSecret: newKey } });
    assert.equal(restoredApp.db.prepare('SELECT total_changes() AS n').get().n, 0);
    const base = await restoredApp.listen(), baseUrl = new URL(base); assert.equal(baseUrl.hostname, '127.0.0.1'); assert(baseUrl.port && baseUrl.port !== '4310');
    const mint = (role, overrides = {}) => {
      const person = fixture.identities[role], seconds = Math.floor(Date.now() / 1000), claims = { aud: 'home-care', moduleId: 'home-care', iss: person.issuer, googleSubject: person.googleSubject, authUserId: person.authUserId, email: person.email, iat: seconds, exp: seconds + 300, jti: randomUUID(), ...overrides };
      const payload = encode(claims).toString('base64url'); return { payload, signature: createHmac('sha256', newKey).update(payload, 'ascii').digest('base64url') };
    };
    const handoff = async (envelope, expected) => {
      const response = await fetch(base + '/api/auth/handoff', { method: 'POST', redirect: 'manual', headers: { Origin: PORTAL_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(envelope).toString() });
      assert.equal(response.status, expected); return response;
    };
    const deniedBefore = readPortalSyntheticRawState(restoredApp.db), denyChanges = restoredApp.db.prepare('SELECT total_changes() AS n').get().n;
    for (const cookie of Object.values(fixture.sourceCookies)) {
      const response = await fetch(base + '/api/session', { headers: { Cookie: cookie }, redirect: 'manual' }); assert.equal(response.status, 200);
      same(await response.json(), { user: null, organizations: [], csrfToken: null }, 'Existing session discovery contract confirms anonymous old cookie');
      const protectedResponse = await fetch(base + '/api/cases', { headers: { Cookie: cookie, 'X-Org-Id': fixture.orgId }, redirect: 'manual' }); assert.equal(protectedResponse.status, 401);
    }
    await handoff(fixture.snapshotReplayEnvelope, 401); await handoff(postSnapshotLogin.envelope, 401);
    for (const role of ['admin', 'supervisor', 'finance', 'caregiver', 'inactive']) await handoff(mint(role), 403);
    same(readPortalSyntheticRawState(restoredApp.db), deniedBefore, 'All old sessions and disabled grants reject with zero writes'); assert.equal(restoredApp.db.prepare('SELECT total_changes() AS n').get().n, denyChanges);
    const explicitGrants = ['admin', 'finance', 'caregiver'];
    for (const role of explicitGrants) {
      const person = fixture.identities[role], current = fixture.app.db.prepare('SELECT role,employee_id FROM memberships WHERE org_id=? AND user_id=?').get(fixture.orgId, person.userId);
      assert.equal(current.role, person.role); assert.equal(role === 'caregiver' ? current.employee_id : null, role === 'caregiver' ? fixture.items.employee.id : null);
      assert.equal(accountMembershipActive(fixture.app.db, fixture.orgId, person.userId), true, 'Current source lifecycle explicitly permits each grant');
      assert(!['supervisor', 'inactive'].includes(role));
      const changed = restoredApp.db.prepare('UPDATE portal_identity_bindings SET active=1 WHERE issuer=? AND google_subject=? AND portal_auth_user_id=? AND email=? AND user_id=? AND org_id=? AND active=0').run(person.issuer, person.googleSubject, person.authUserId, person.email, person.userId, fixture.orgId);
      assert.equal(changed.changes, 1, 'Each synthetic approved identity is explicitly rebound, never by email alone');
    }
    const snapshotJti = JSON.parse(Buffer.from(fixture.snapshotReplayEnvelope.payload, 'base64url').toString()).jti;
    const replayBefore = readPortalSyntheticRawState(restoredApp.db); await handoff(mint('admin', { jti: snapshotJti }), 409); same(readPortalSyntheticRawState(restoredApp.db), replayBefore, 'Captured consumed nonce still rejects under new key without writes');
    for (const role of ['supervisor', 'inactive']) await handoff(mint(role), 403);
    const actors = {};
    for (const role of explicitGrants) {
      const response = await handoff(mint(role), 303), cookie = response.headers.get('set-cookie')?.split(';')[0]; assert(cookie);
      const client = syntheticClient(base, 'encrypted-portal-' + role, { cookie }), auth = await client.json('GET', 'session'); client.bindAuth(auth); assert.equal(auth.user.role, role); actors[role] = client;
    }
    const readBefore = readPortalSyntheticRawState(restoredApp.db), readChanges = restoredApp.db.prepare('SELECT total_changes() AS n').get().n;
    for (const role of ['admin', 'finance']) for (const kind of ['fees', 'payroll']) same(await actors[role].json('GET', `reports/${kind}?month=${fixture.month}&spanMode=calendar-two-day-v1`, undefined, { orgId: fixture.orgId }), fixture.expected.frozenReports[kind], 'Saved financial DTO remains exact after failclosed authentication');
    same((await actors.admin.json('GET', `business-rules/${rule.id}`, undefined, { orgId: fixture.orgId })).item, rule, 'Approved parameters stay exact'); same(await actors.admin.json('GET', `business-rules/${rule.id}/history`, undefined, { orgId: fixture.orgId }), ruleHistory, 'Rule versions stay exact');
    for (const [endpoint, expected] of [[`case-attachments/${fixture.items.caseAttachment.id}/download`, fixture.expected.caseBytes], [`certification-attachments/${fixture.items.certAttachment.id}/download`, fixture.expected.certBytes]]) { const response = await actors.admin.response('GET', endpoint, undefined, { orgId: fixture.orgId }); assert.equal(response.status, 200); assert.equal(sha(Buffer.from(await response.arrayBuffer())), sha(expected)); }
    assert.equal((await actors.admin.response('GET', 'cases', undefined, { orgId: fixture.foreignOrgId })).status, 403);
    assert.equal((await actors.caregiver.response('GET', `cases/${fixture.items.foreignCase.id}`, undefined, { orgId: fixture.orgId })).status, 404);
    assert.equal((await actors.caregiver.response('GET', `reports/fees?month=${fixture.month}`, undefined, { orgId: fixture.orgId })).status, 403);
    same(readPortalSyntheticRawState(restoredApp.db), readBefore, 'Scoped report/rules/attachment reads have zero logical writes'); assert.equal(restoredApp.db.prepare('SELECT total_changes() AS n').get().n, readChanges);
    await restoredApp.close(); restoredApp = null; same(fixture.readRawState(), postSource, 'Dryrun never changes the current post-snapshot source'); assert.equal(fixture.app.db.prepare('SELECT total_changes() AS n').get().n, postChanges);
    same(facadeHashes(), facadesBefore, 'Existing11/13-table and encrypted facades remain unchanged');
    const summary = { format: 'suiyue-synthetic-encrypted-portal-rehearsal-v1', status: 'passed', syntheticOnly: true, tableCount: 13, triggerCount: 6, plaintextBackupDeletedBeforeRestore: true, cipherOnlyRestore: true, exactSchemaAndTypedSnapshot: true, snapshotLifecycleAndRulesExact: true, immutableBlobFamiliesExact: true, postSnapshotSourcePreserved: true, sessionsClearedBeforeStartup: true, allBindingsDisabledBeforeStartup: true, capturedNonceLedgerRetained: true, oldKeyRejectedIncludingPostSnapshotTokens: true, restoredOldCookieRejected: true, capturedNonceReplayRejectedAfterNewKey: true, explicitGrantCount: 3, postSnapshotRevokedSupervisorRemainsDenied: true, unknownGrantInactiveRemainsDenied: true, scopedReadsLogicalWrites: 0, financialSnapshotAndRuleHistoryExact: true, technicalCapacityBytes: DB_LIMIT, encryptedSha256: sha(cipherBytes), snapshotFingerprint: proof.fingerprint, securityReconciliationChangesSnapshot: true, originalFacadesChanged: false, promotionPerformed: false, actual4310Accessed: false, formalDrAccepted: false, formalDeployment: false, disposed: true };
    await fixture.close(); fixture = null; portalBackup.disposeSyntheticWorkspace(workspace); disposed = true; return summary;
  } finally {
    for (const bytes of [plaintext, cipherBytes, opened?.bytes, password]) bytes?.fill(0);
    for (const resource of [restoredApp, fixture]) if (resource) await resource.close();
    if (workspace && !disposed) portalBackup.disposeSyntheticWorkspace(workspace);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) { console.error(JSON.stringify({ status: 'failed', syntheticOnly: true, code: 'CLI_ARGUMENTS_REJECTED' })); process.exitCode = 2; }
  else try { console.log(JSON.stringify(await rehearseSyntheticEncryptedPortalBackup())); }
  catch (error) { console.error(JSON.stringify({ status: 'failed', syntheticOnly: true, code: error?.name === 'SyntheticEncryptedPortalError' ? error.code : 'ENCRYPTED_PORTAL_REHEARSAL_FAILED' })); process.exitCode = 1; }
}
