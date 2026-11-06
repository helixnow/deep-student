// ============================================================================
// Ink acceptance guard — behavior regression (RED until the proxy enforces).
//
// Run: node --test scripts/__tests__/ink-acceptance-proxy.test.mjs
//
// The suite targets the stable contract exported by
// scripts/dev/ink-acceptance-proxy.mjs. That file is currently a deliberately
// NON-ENFORCING pass-through scaffold: it forwards every request so these tests
// fail on observed behavior (21st request reaches the fixture upstream, a
// mismatched model is forwarded, limit > 20 is accepted). That is the intended
// RED for the missing guard, not a compile error.
//
// Cases map to closure-plan Task 2:
//   - first 20 actual requests allowed, 21st rejected before the upstream;
//   - retries are counted because every HTTP attempt crosses the proxy;
//   - wrong model/provider is rejected before any network send;
//   - the proxy never logs auth headers or request bodies;
//   - no production/release wiring is introduced by the dev-only seam.
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startAcceptanceProxy } from '../dev/ink-acceptance-proxy.mjs';

const PINNED_MODEL = 'fixture-vision-model';
const CHAT_PATH = '/v1/chat/completions';
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../..');

function chatBody(marker, model = PINNED_MODEL) {
  return {
    model,
    messages: [{ role: 'user', content: `fixture-${marker}` }],
  };
}

function closeServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

async function startUpstream(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = undefined;
    }
    const record = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      bodyText,
      json,
    };
    requests.push(record);
    try {
      await handler(req, res, record, requests.length);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  };
}

function jsonResponse(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}

function rawRequest(proxy, requestPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: proxy.host,
        port: proxy.port,
        method: 'POST',
        path: requestPath,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

async function withProxy(upstream, options, run) {
  const proxy = await startAcceptanceProxy({
    upstreamBaseUrl: upstream.url,
    model: PINNED_MODEL,
    limit: 20,
    ...options,
  });
  try {
    return await run(proxy);
  } finally {
    await proxy.close();
  }
}

// ---------------------------------------------------------------------------
// 1. Exact count: first 20 reach the upstream, 21st is rejected locally.
// ---------------------------------------------------------------------------
test('allows exactly 20 actual requests and rejects the 21st before the upstream', async () => {
  const upstream = await startUpstream((_req, res) => jsonResponse(res, 200, { ok: true }));
  try {
    await withProxy(upstream, {}, async (proxy) => {
      assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/, 'proxy must bind loopback');

      for (let i = 1; i <= 20; i += 1) {
        const result = await postJson(`${proxy.url}${CHAT_PATH}`, chatBody(i));
        assert.equal(result.status, 200, `request ${i} should be allowed`);
      }
      assert.equal(proxy.count, 20);
      assert.equal(upstream.requests.length, 20);

      const rejected = await postJson(`${proxy.url}${CHAT_PATH}`, chatBody(21));
      assert.equal(rejected.status, 429, '21st request must fail closed');
      assert.match(
        JSON.stringify(rejected.json ?? rejected.text),
        /budget|exhausted/i,
        '21st response must identify budget exhaustion',
      );
      assert.equal(proxy.count, 20, 'rejected request must not consume budget');
      assert.equal(proxy.attempts, 21, 'the rejected attempt still counts as an admission attempt');
      assert.equal(upstream.requests.length, 20, 'upstream must never see request 21');
      assert.ok(
        !upstream.requests.some((request) => request.bodyText.includes('fixture-21')),
        'fixture-21 must not be forwarded',
      );
    });
  } finally {
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Retries are actual HTTP sends and share the same budget.
// ---------------------------------------------------------------------------
test('counts transport retries against the same 20-request budget', async () => {
  const upstream = await startUpstream((_req, res, _record, sequence) => {
    // First attempt of each logical round fails transiently; the retry succeeds.
    if (sequence % 2 === 1) {
      jsonResponse(res, 503, { error: { type: 'fixture_transient' } });
      return;
    }
    jsonResponse(res, 200, { ok: true, sequence });
  });
  try {
    await withProxy(upstream, {}, async (proxy) => {
      for (let round = 1; round <= 10; round += 1) {
        const first = await postJson(`${proxy.url}${CHAT_PATH}`, chatBody(`retry-${round}`));
        assert.equal(first.status, 503, 'fixture first attempt must be transient');
        const retry = await postJson(`${proxy.url}${CHAT_PATH}`, chatBody(`retry-${round}`));
        assert.equal(retry.status, 200, 'retry should succeed');
      }
      assert.equal(proxy.count, 20, '10 rounds x 2 HTTP attempts = 20');
      assert.equal(upstream.requests.length, 20);

      const rejected = await postJson(`${proxy.url}${CHAT_PATH}`, chatBody('retry-21'));
      assert.equal(rejected.status, 429, 'the next retry must be rejected before the upstream');
      assert.equal(upstream.requests.length, 20);
      assert.ok(!upstream.requests.some((request) => request.bodyText.includes('fixture-retry-21')));
    });
  } finally {
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Wrong model is rejected before any upstream request (and costs no budget).
// ---------------------------------------------------------------------------
test('rejects a mismatched model before the upstream and does not consume budget', async () => {
  const upstream = await startUpstream((_req, res) => jsonResponse(res, 200, { ok: true }));
  try {
    await withProxy(upstream, {}, async (proxy) => {
      const wrong = await postJson(`${proxy.url}${CHAT_PATH}`, chatBody('wrong', 'other-model'));
      assert.equal(wrong.status, 403, 'mismatched model must fail closed');
      assert.match(JSON.stringify(wrong.json ?? wrong.text), /model|mismatch/i);
      assert.equal(proxy.count, 0, 'rejected model must not consume budget');
      assert.equal(upstream.requests.length, 0, 'mismatched model must never reach upstream');

      const malformed = await postJson(`${proxy.url}${CHAT_PATH}`, { messages: [] });
      assert.equal(malformed.status, 400, 'missing model must fail closed');
      assert.equal(upstream.requests.length, 0);

      const allowed = await postJson(`${proxy.url}${CHAT_PATH}`, chatBody('ok'));
      assert.equal(allowed.status, 200, 'a valid request is still allowed after a pin violation');
      assert.equal(proxy.count, 1);
      assert.equal(upstream.requests.length, 1);
    });
  } finally {
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Provider pinning: startup host pin, request path allowlist, hard cap.
// ---------------------------------------------------------------------------
test('rejects wrong provider/host and refuses a limit above 20', async () => {
  const upstream = await startUpstream((_req, res) => jsonResponse(res, 200, { ok: true }));
  try {
    await assert.rejects(
      () =>
        startAcceptanceProxy({
          upstreamBaseUrl: 'https://wrong.example',
          expectedUpstreamHost: 'api.deepseek.com',
          model: PINNED_MODEL,
          limit: 20,
        }),
      /host|upstream/i,
      'startup must refuse an upstream host that does not match the pin',
    );

    await withProxy(upstream, { allowedPaths: [CHAT_PATH] }, async (proxy) => {
      const wrongPath = await postJson(`${proxy.url}/v1/embeddings`, {
        model: PINNED_MODEL,
        input: 'fixture',
      });
      assert.equal(wrongPath.status, 403, 'non-chat protocol path must fail closed');
      assert.equal(upstream.requests.length, 0, 'wrong path must never reach upstream');
    });

    let oversized;
    let startupError;
    try {
      oversized = await startAcceptanceProxy({
        upstreamBaseUrl: upstream.url,
        model: PINNED_MODEL,
        limit: 21,
      });
    } catch (error) {
      startupError = error;
    } finally {
      await oversized?.close();
    }
    assert.ok(startupError, 'limit above the user-approved 20 must be rejected at startup');
    assert.match(String(startupError), /20|limit/i);
  } finally {
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Security regressions: concurrency, URL override, malformed body, redirect.
// ---------------------------------------------------------------------------
test('concurrent 21 requests never exceed 20 upstream sends', async () => {
  const upstream = await startUpstream((_req, res) => jsonResponse(res, 200, { ok: true }));
  try {
    await withProxy(upstream, {}, async (proxy) => {
      const results = await Promise.all(
        Array.from({ length: 21 }, (_, index) =>
          postJson(`${proxy.url}${CHAT_PATH}`, chatBody(`concurrent-${index + 1}`)),
        ),
      );
      assert.equal(upstream.requests.length, 20, 'upstream must see at most 20');
      assert.ok(upstream.requests.length <= 20);
      assert.equal(proxy.count, 20);
      assert.equal(proxy.attempts, 21);
      assert.equal(results.filter((result) => result.status === 200).length, 20);
      assert.equal(results.filter((result) => result.status === 429).length, 1);
    });
  } finally {
    await upstream.close();
  }
});

test('rejects absolute, protocol-relative and query request targets', async () => {
  const upstream = await startUpstream((_req, res) => jsonResponse(res, 200, { ok: true }));
  try {
    await withProxy(upstream, {}, async (proxy) => {
      for (const target of [
        'http://evil.example/v1/chat/completions',
        '//evil.example/v1/chat/completions',
        '/v1/chat/completions?x=1',
      ]) {
        const result = await rawRequest(proxy, target, JSON.stringify(chatBody('target')));
        assert.equal(result.status, 400, `target must be rejected: ${target}`);
      }
      assert.equal(proxy.count, 0);
      assert.equal(upstream.requests.length, 0);
    });
  } finally {
    await upstream.close();
  }
});

test('rejects malformed JSON before the upstream', async () => {
  const upstream = await startUpstream((_req, res) => jsonResponse(res, 200, { ok: true }));
  try {
    await withProxy(upstream, {}, async (proxy) => {
      const result = await rawRequest(proxy, CHAT_PATH, '{not-json');
      assert.equal(result.status, 400);
      assert.match(result.text, /json/i);
      assert.equal(proxy.count, 0);
      assert.equal(upstream.requests.length, 0);
    });
  } finally {
    await upstream.close();
  }
});

test('blocks upstream redirects instead of returning them to the app', async () => {
  const upstream = await startUpstream((_req, res, _record, sequence) => {
    if (sequence === 1) {
      res.writeHead(302, { location: 'https://evil.example/steal' });
      res.end();
      return;
    }
    jsonResponse(res, 200, { ok: true });
  });
  try {
    await withProxy(upstream, {}, async (proxy) => {
      const result = await rawRequest(proxy, CHAT_PATH, JSON.stringify(chatBody('redirect')));
      assert.equal(result.status, 502);
      assert.equal(result.headers.location, undefined, 'Location must never be returned');
      assert.equal(proxy.count, 1, 'the upstream attempt still consumes a slot');
      assert.equal(proxy.attempts, 1);

      const next = await postJson(`${proxy.url}${CHAT_PATH}`, chatBody('after-redirect'));
      assert.equal(next.status, 200, 'redirect slot is consumed but later slots remain');
      assert.equal(proxy.count, 2);
    });
  } finally {
    await upstream.close();
  }
});

test('refuses upstream credentials, query or non-origin paths', async () => {
  await assert.rejects(
    () =>
      startAcceptanceProxy({
        upstreamBaseUrl: 'https://user:pass@api.example',
        model: PINNED_MODEL,
        limit: 20,
      }),
    /credentials/i,
  );
  await assert.rejects(
    () =>
      startAcceptanceProxy({
        upstreamBaseUrl: 'https://api.example?token=fixture',
        model: PINNED_MODEL,
        limit: 20,
      }),
    /query|fragment/i,
  );
  await assert.rejects(
    () =>
      startAcceptanceProxy({
        upstreamBaseUrl: 'https://api.example/v1',
        model: PINNED_MODEL,
        limit: 20,
      }),
    /origin|path/i,
  );
});

// ---------------------------------------------------------------------------
// 6. No secret/body logging, and no production/release wiring.
// ---------------------------------------------------------------------------
test('never logs auth headers or request bodies and stays out of production wiring', async () => {
  const records = [];
  const upstream = await startUpstream((_req, res) => jsonResponse(res, 200, { ok: true }));
  const secretKey = 'sk-test-SECRET-KEY-MUST-NOT-APPEAR';
  const secretBody = 'BODY-SECRET-MARKER-MUST-NOT-APPEAR';
  try {
    await withProxy(upstream, { log: (record) => records.push(record) }, async (proxy) => {
      const result = await rawRequest(
        proxy,
        CHAT_PATH,
        JSON.stringify({ model: PINNED_MODEL, messages: [{ role: 'user', content: secretBody }] }),
        {
          authorization: `Bearer ${secretKey}`,
          cookie: 'session=must-not-be-forwarded',
          'proxy-authorization': 'Basic must-not-be-forwarded',
        },
      );
      assert.equal(result.status, 200);
      assert.equal(records[0]?.event, 'admitted', 'slot must be journaled before the upstream request');
      assert.ok(records.some((record) => record.event === 'forwarded'));
      assert.equal(upstream.requests.length, 1);
      assert.equal(
        upstream.requests[0].headers.authorization,
        `Bearer ${secretKey}`,
        'normal provider auth must be forwarded unchanged',
      );
      assert.equal(upstream.requests[0].headers.cookie, undefined, 'cookie must be stripped');
      assert.equal(
        upstream.requests[0].headers['proxy-authorization'],
        undefined,
        'proxy-authorization must be stripped',
      );
      const logged = JSON.stringify(records);
      assert.ok(!logged.includes(secretKey), 'authorization token leaked into logs');
      assert.ok(!logged.includes(secretBody), 'request body leaked into logs');
      assert.ok(!logged.includes('cookie'), 'cookie header name must not be logged');
      assert.ok(!logged.includes('authorization'), 'header names must not be logged');
    });
  } finally {
    await upstream.close();
  }

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  );
  assert.ok(
    !JSON.stringify(packageJson.scripts ?? {}).includes('ink-acceptance-proxy'),
    'dev acceptance proxy must not be wired into package scripts',
  );
  const libRs = fs.readFileSync(path.join(REPO_ROOT, 'src-tauri/src/lib.rs'), 'utf8');
  assert.ok(
    !libRs.includes('ink-acceptance-proxy'),
    'production app must not reference the dev acceptance proxy',
  );
});
