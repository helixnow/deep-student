import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { prepareBilibiliAndroid } from '../ci/prepare-bilibili-android.mjs';

const source = readFileSync(new URL('../../src-tauri/resources/bilibili/deepstudent-bili-bridge.user.js', import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
function harness(responder, { autoCredit = true } = {}) {
  const sent = [];
  const requests = [];
  let aborted = 0;
  let cancelled = 0;
  let socket;
  class WebSocket {
    static OPEN = 1;
    readyState = 1;
    constructor() { socket = this; }
    send(value) {
      sent.push(typeof value === 'string' ? JSON.parse(value) : value);
      const item = sent.at(-1);
      if (autoCredit && (typeof value !== 'string' || item.type === 'response_head')) {
        queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: 'credit', id: 1 }) }));
      }
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const context = {
    location: { hostname: '127.0.0.1', pathname: '/deepstudent-bili-bridge/v1/', port: '12345', host: '127.0.0.1:12345', origin: 'http://127.0.0.1:12345', hash: `#${'a'.repeat(64)}` },
    history: { replaceState() {} },
    document: { getElementById: () => ({ textContent: '' }), addEventListener() {} },
    window: { addEventListener() {} }, WebSocket, URL, Uint8Array, DataView, BigInt, Map, Blob, setTimeout, clearTimeout,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    GM_xmlhttpRequest(options) {
      requests.push(options);
      const response = responder(options);
      queueMicrotask(() => {
        const stream = new ReadableStream({
        start(controller) { for (const bytes of [new Uint8Array([1,2]), new Uint8Array([3,4])]) controller.enqueue(bytes); controller.close(); },
        cancel() { cancelled++; },
        });
        if (response.splitHeaders) {
          options.onloadstart({ status: 0, readyState: 1, response: stream });
          queueMicrotask(() => options.onreadystatechange({ status: 206, readyState: 2, finalUrl: options.url, responseHeaders: 'Content-Range: bytes 0-3/4\r\nContent-Length: 4' }));
        } else {
          const result = { status: 206, finalUrl: options.url, responseHeaders: 'Content-Range: bytes 0-3/4\r\nContent-Length: 4', response: stream, ...response };
          options.onloadstart(result);
          if (response.response === null) options.onload(result);
        }
      });
      return { abort() { aborted++; } };
    },
  };
  context.window.self = context.window; context.window.top = context.window;
  vm.runInNewContext(source, context);
  const request = (overrides = {}) => socket.onmessage({ data: JSON.stringify({ type: 'request', id: 1, attemptId: 'attempt', kind: 'media', method: 'GET', url: 'https://a.bilivideo.com/video', headers: { range: 'bytes=0-3' }, body: '', maxBytes: 4, timeoutMs: 100, ...overrides }) });
  return { sent, requests, request, socket, get aborted() { return aborted; }, get cancelled() { return cancelled; } };
}

test('userscript exports no cookies, no global fetch, no blanket host grants', () => {
  assert.doesNotMatch(source, /@(?:match|connect)\s+\*/);
  assert.doesNotMatch(source, /GM_cookie|document\.cookie|localStorage|unsafeWindow/);
});
test('media bytes use binary frames and CDN requests are anonymous', async () => {
  const h = harness(() => ({}));
  h.socket.onopen(); h.request();
  await tick(); await tick();
  assert.equal(h.sent[0].type, 'hello');
  assert.equal(h.requests[0].anonymous, true);
  assert.equal(h.requests[0].redirect, 'manual');
  assert.equal(h.requests[0].responseType, 'stream');
  const frames = h.sent.filter((value) => value instanceof Uint8Array);
  assert.equal(frames.length, 2);
  assert.equal(new DataView(frames[0].buffer).getBigUint64(0), 1n);
  assert.equal(new DataView(frames[1].buffer).getUint32(8), 1);
  assert.equal(h.sent.at(-1).type, 'response_end');
  h.socket.close();
});
test('lack of ACK prevents frame delivery; cancel aborts upstream and settles once', async () => {
  const h = harness(() => ({}), { autoCredit: false });
  h.request(); await tick();
  assert.equal(h.sent.filter((v) => v instanceof Uint8Array).length, 0);
  h.socket.onmessage({ data: JSON.stringify({ type: 'cancel', id: 1 }) });
  await tick();
  assert.ok(h.aborted > 0);
  assert.equal(h.sent.filter((v) => v.type === 'error').length, 1);
  h.socket.close();
});
test('Tampermonkey OPENED stream waits for separately delivered response headers', async () => {
  const h = harness(() => ({ splitHeaders: true }));
  h.request(); await tick(); await tick();
  const heads = h.sent.filter((value) => value.type === 'response_head');
  assert.equal(heads.length, 1);
  assert.equal(heads[0].status, 206);
  assert.equal(h.sent.filter((value) => value instanceof Uint8Array).length, 2);
  assert.equal(h.sent.at(-1).type, 'response_end');
  h.socket.close();
});
test('an uncooperative manager cannot buffer an unbounded response while Rust withholds ACK', async () => {
  const h = harness(() => ({ responseHeaders: '', response: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4096)); controller.close(); } }) }), { autoCredit: false });
  h.request(); await tick();
  assert.ok(h.sent.some((value) => value.type === 'error' && value.code === 'response-too-large'));
  assert.ok(h.aborted > 0);
  h.socket.close();
});
test('ignored Range, streaming overflow, redirected target and unsupported stream fail closed', async () => {
  for (const [response, code] of [
    [{ status: 200, responseHeaders: 'Content-Length: 1000000000' }, 'range-unsupported'],
    [{ status: 200, responseHeaders: '' }, 'range-unsupported'],
    [{ finalUrl: 'http://127.0.0.1/private' }, 'redirect-unsupported'],
    [{ response: null }, 'stream-unsupported'],
    [{ responseHeaders: '', response: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4096)); c.close(); } }) }, 'response-too-large'],
  ]) {
    const h = harness(() => response); h.request(); await tick(); await tick();
    assert.ok(h.sent.some((v) => v.type === 'error' && v.code === code), code);
    assert.ok(h.aborted > 0, code); h.socket.close();
  }
});
test('unsafe target and credentials never reach GM; watchdog aborts a stalled manager', async () => {
  const h = harness(() => ({})); h.request({ url: 'https://api.bilibili.com.evil.test/' }); await tick();
  assert.equal(h.requests.length, 0); h.socket.close();
  const slow = harness(() => ({ response: new ReadableStream({ pull() { return new Promise(() => {}); } }) }));
  slow.request({ timeoutMs: 20 }); await new Promise((r) => setTimeout(r, 40));
  assert.ok(slow.sent.some((v) => v.code === 'timeout'));
  assert.ok(slow.aborted > 0); slow.socket.close();
});
test('managed Android service preparation is idempotent and non-exported', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ds-bili-android-'));
  try {
    const base = path.join(root, 'src-tauri/gen/android/app/src/main');
    mkdirSync(path.join(base, 'java/com/deepstudent/app'), { recursive: true });
    mkdirSync(path.join(root, 'src-tauri/mobile/android'), { recursive: true });
    writeFileSync(path.join(root, 'src-tauri/mobile/android/BiliBridgePlugin.kt'), 'service');
    writeFileSync(path.join(root, 'src-tauri/mobile/android/BilibiliRangeResponse.kt'), 'range adapter');
    writeFileSync(path.join(root, 'src-tauri/mobile/android/bilibili-range.gradle.kts'), 'range build hook');
    mkdirSync(path.join(root, 'src-tauri/mobile/android/tests'), { recursive: true });
    writeFileSync(path.join(root, 'src-tauri/mobile/android/tests/BilibiliRangeInputStreamTest.kt'), 'range tests');
    writeFileSync(path.join(root, 'src-tauri/gen/android/app/build.gradle.kts'), 'plugins {}');
    writeFileSync(path.join(base, 'AndroidManifest.xml'), '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application></application></manifest>');
    prepareBilibiliAndroid(root); prepareBilibiliAndroid(root);
    const manifest = readFileSync(path.join(base, 'AndroidManifest.xml'), 'utf8');
    assert.equal(manifest.match(/android.permission.FOREGROUND_SERVICE"/g).length, 1);
    assert.equal(manifest.match(/BiliBridgeSessionService/g).length, 1);
    assert.match(manifest, /android:exported="false" android:foregroundServiceType="dataSync"/);
    const gradle = readFileSync(path.join(root, 'src-tauri/gen/android/app/build.gradle.kts'), 'utf8');
    assert.equal(gradle.match(/apply\(from = "bilibili-range.gradle.kts"\)/g).length, 1);
    assert.equal(readFileSync(path.join(base, 'java/com/deepstudent/app/BilibiliRangeResponse.kt'), 'utf8'), 'range adapter');
    assert.equal(readFileSync(path.join(root, 'src-tauri/gen/android/app/src/test/java/com/deepstudent/app/BilibiliRangeInputStreamTest.kt'), 'utf8'), 'range tests');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
