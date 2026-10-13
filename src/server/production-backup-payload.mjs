import { failProductionBackup as fail } from './production-backup-errors.mjs';

// This sink only separates untrusted binary framing. It never parses the
// proof or opens SQLite. Its caller must authenticate and verify the source
// before calling finishAuthenticated(). Malformed framing is deferred so a
// wrong key/tag still reports AUTHENTICATION_FAILED first.
export function createProductionPayloadSink({ maximum, proofLimit, writeDatabase }) {
  const prefix = Buffer.alloc(4);
  let prefixBytes = 0, proof, proofBytes = 0, databaseBytes = 0;
  let invalid = false, finished = false, destroyed = false;
  return {
    push(bytes) {
      if (finished || destroyed) fail('INVALID_ARGUMENT');
      if (invalid || bytes.length === 0) return;
      let offset = 0;
      if (prefixBytes < 4) {
        const count = Math.min(4 - prefixBytes, bytes.length);
        bytes.copy(prefix, prefixBytes, 0, count); prefixBytes += count; offset += count;
        if (prefixBytes < 4) return;
        const length = prefix.readUInt32BE();
        if (!length || length > proofLimit) { invalid = true; return; }
        proof = Buffer.alloc(length);
      }
      if (proofBytes < proof.length) {
        const count = Math.min(proof.length - proofBytes, bytes.length - offset);
        bytes.copy(proof, proofBytes, offset, offset + count); proofBytes += count; offset += count;
      }
      if (offset < bytes.length) {
        const count = bytes.length - offset;
        if (databaseBytes + count > maximum) { invalid = true; return; }
        writeDatabase(bytes.subarray(offset)); databaseBytes += count;
      }
    },
    finishAuthenticated() {
      if (finished || destroyed) fail('INVALID_ARGUMENT');
      finished = true;
      if (invalid || prefixBytes !== 4 || !proof || proofBytes !== proof.length || databaseBytes < 100) fail('ENVELOPE_INVALID');
      return { proofBytes: proof, databaseBytes };
    },
    destroy() {
      prefix.fill(0); proof?.fill(0); destroyed = true;
    },
  };
}
