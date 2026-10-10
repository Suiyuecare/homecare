import http from 'node:http';
import assert from 'node:assert/strict';

// Test fixture: real authenticated synthetic loopback reads use a one-use
// transport, while the intercepted browser fetch retains its actual cancellation.
const outcome = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const unwrap = result => { if (!result.ok) throw result.error; return result.value; };

export async function authenticatedLoopbackHistoryRead(request, base) {
  const target = new URL(request.url());
  assert.equal(target.origin, new URL(base).origin, 'Delayed read stays on the actual synthetic server');
  assert.equal(target.protocol, 'http:');
  assert.equal(target.hostname, '127.0.0.1');
  assert.equal(request.method(), 'GET');
  assert.match(target.pathname, /^\/api\/employee-(?:certifications|training)\/[a-f0-9-]+\/history$/);
  const headers = await request.allHeaders();
  assert.ok(headers.cookie && headers['x-org-id'] && headers['x-csrf-token'], 'Use the actual browser session and scope');
  return new Promise((resolve, reject) => {
    // New one-use Agent: never shares Playwright's keep-alive socket pool. No
    // retries and no browser AbortSignal. 30000 matches route.fetch's default.
    const req = http.request(target, { method: 'GET', agent: false, signal: AbortSignal.timeout(30000), headers: { ...headers, connection: 'close' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('aborted', () => reject(new Error('UPSTREAM_HISTORY_RESPONSE_ABORTED')));
      res.on('error', reject);
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks);
          assert.equal(res.statusCode, 200, 'The unchanged actual server must authorize the upstream read');
          const data = JSON.parse(body.toString('utf8'));
          assert.ok(Array.isArray(data.items) && Number.isSafeInteger(data.total), 'Require actual history JSON');
          const responseHeaders = Object.fromEntries(Object.entries(res.headers).filter(([key, value]) => value !== undefined && !['connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(key)).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value]));
          resolve({ status: res.statusCode, headers: responseHeaders, body });
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

export async function createDelayedHistoryRead(page, pattern, base) {
  const ready = outcome(), release = outcome(), handled = outcome();
  let browserRequest, cancellation;
  await page.route(pattern, async route => {
    browserRequest = route.request();
    let response;
    try {
      response = await authenticatedLoopbackHistoryRead(browserRequest, base);
      ready.resolve({ ok: true });
    } catch (error) {
      // Deliver transport/auth errors to the main test's catch and receipt path;
      // never turn ECONNRESET into ready or leak an unhandled route rejection.
      ready.resolve({ ok: false, error });
      handled.resolve({ ok: false, error });
      return;
    }
    await release.promise;
    try { await route.fulfill(response); handled.resolve({ ok: true }); }
    catch (error) {
      try {
        if (!cancellation) throw error;
        const cancelled = await cancellation;
        assert.match(cancelled.failure()?.errorText || '', /abort|cancel/i, 'Only observed cancellation of this exact browser request permits failed late fulfilment');
        handled.resolve({ ok: true });
      } catch (failure) { handled.resolve({ ok: false, error: failure }); }
    }
  });
  return {
    async waitReady() { unwrap(await ready.promise); },
    expectCancellation() {
      assert.ok(browserRequest && !cancellation, 'Arm after the actual read and before invalidation');
      cancellation = page.waitForEvent('requestfailed', { predicate: request => request === browserRequest, timeout: 10000 });
      // This attaches a handler while the test is performing UI invalidation.
      // waitHandled still awaits and rethrows any rejection below.
      cancellation.catch(() => {});
    },
    release() { release.resolve(); },
    async waitHandled() {
      unwrap(await handled.promise);
      if (cancellation) assert.match((await cancellation).failure()?.errorText || '', /abort|cancel/i, 'UI invalidation must really abort the intercepted browser fetch');
    },
  };
}
