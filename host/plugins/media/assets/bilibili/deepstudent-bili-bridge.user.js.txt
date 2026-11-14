// ==UserScript==
// @name         DeepStudent Bilibili Bridge
// @namespace    https://github.com/helixnow/deep-student
// @version      1.0.1
// @description  Paired, bounded Bilibili transport for the local DeepStudent app
// @match        http://127.0.0.1/deepstudent-bili-bridge/v1/*
// @connect      127.0.0.1
// @connect      api.bilibili.com
// @connect      app.biliapi.net
// @connect      b23.tv
// @connect      bili2233.cn
// @connect      bilibili.com
// @connect      hdslb.com
// @connect      bilivideo.com
// @connect      bilivideo.cn
// @connect      akamaized.net
// @connect      szbdyd.com
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  const BASE = '/deepstudent-bili-bridge/v1/';
  if (location.hostname !== '127.0.0.1' || location.pathname !== BASE || !location.port || window.top !== window.self) return;
  const challenge = location.hash.slice(1);
  if (!/^[a-f0-9]{64}$/.test(challenge)) return;
  history.replaceState(null, '', BASE);
  const state = (message) => {
    const el = document.getElementById('bridge-state');
    if (el) el.textContent = message;
    else document.addEventListener('DOMContentLoaded', () => state(message), { once: true });
  };
  let socket;
  let resumeToken = null;
  let stopped = false;
  let reconnects = 0;
  let reconnectTimer;
  const active = new Map();
  const send = (value) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
  const domain = (host, suffix) => host === suffix || host.endsWith(`.${suffix}`);
  function validate(request) {
    const url = new URL(request.url);
    if (request.probe && url.origin === location.origin && url.pathname.startsWith(`${BASE}probe/`)) return url;
    const hosts = {
      api: ['api.bilibili.com', 'app.biliapi.net'],
      short_link: ['b23.tv', 'www.b23.tv', 'bili2233.cn', 'www.bili2233.cn', 'www.bilibili.com', 'm.bilibili.com', 'bilibili.com'],
      subtitle: ['hdslb.com'], cover: ['hdslb.com'],
      media: ['bilivideo.com', 'bilivideo.cn', 'akamaized.net', 'szbdyd.com', 'hdslb.com'],
    };
    const suffix = ['subtitle', 'media', 'cover'].includes(request.kind);
    const portAllowed = !url.port || url.port === '443' || request.kind === 'media' && url.port === '4483' && url.hostname.endsWith('.mcdn.bilivideo.cn');
    if (url.protocol !== 'https:' || !portAllowed || url.username || url.password || url.hash ||
        !(hosts[request.kind] || []).some((host) => suffix ? domain(url.hostname, host) : url.hostname === host)) throw new Error('unsafe-url');
    return url;
  }
  function headers(raw) {
    const result = {};
    for (const line of (raw || '').split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon > 0) {
        const name = line.slice(0, colon).trim().toLowerCase();
        if (['content-length', 'content-type', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'location', 'grpc-status', 'grpc-message', 'grpc-encoding'].includes(name)) result[name] = line.slice(colon + 1).trim();
      }
    }
    return result;
  }
  const consumeCredit = (job) => new Promise((resolve, reject) => {
    if (job.cancelled) { reject(new Error('cancelled')); return; }
    if (job.credit) { job.credit = false; resolve(); return; }
    job.waiter = { resolve, reject };
  });
  async function run(request) {
    if (active.size >= 4 || !Number.isSafeInteger(request.id) || active.has(request.id)) return;
    const job = { handle: null, reader: null, cancelled: false, finished: false, credit: false, waiter: null, wakeReader: null };
    active.set(request.id, job);
    const finish = (code) => {
      if (job.finished) return;
      job.finished = true;
      clearTimeout(job.timer);
      if (code) send({ type: 'error', id: request.id, code });
      else send({ type: 'response_end', id: request.id });
      active.delete(request.id);
      if (code) { job.handle?.abort(); void job.reader?.cancel().catch(() => {}); }
      job.waiter?.reject(new Error(code || 'cancelled'));
      job.wakeReader?.();
    };
    job.cancel = () => { job.cancelled = true; finish('cancelled'); };
    try {
      const url = validate(request);
      if (!['GET', 'HEAD', 'POST'].includes(request.method) || request.maxBytes < 1 || request.maxBytes > (request.kind === 'media' ? 512 * 1024 : 20 * 1024 * 1024)) throw new Error('invalid-request');
      const outgoing = { Referer: 'https://www.bilibili.com/' };
      for (const [name, value] of Object.entries(request.headers || {})) {
        if (!['range', 'if-range', 'content-type', 'grpc-accept-encoding', 'te'].includes(name) || /[\r\n]/.test(value)) throw new Error('unsafe-header');
        outgoing[name] = value;
      }
      const body = request.body ? Uint8Array.from(atob(request.body), (c) => c.charCodeAt(0)).buffer : undefined;
      if (body?.byteLength > 65536) throw new Error('invalid-request');
      job.timer = setTimeout(() => finish('timeout'), Math.min(24000, Math.max(1, request.timeoutMs)));
      let responseHead = null;
      let stream = null;
      let pumping = false;
      let buffered = null;
      let produced = 0;
      let consumed = 0;
      let readerStarted = false;
      let readerDone = false;
      const readBounded = async () => {
        if (!stream || readerStarted || job.finished) return;
        readerStarted = true;
        job.reader = stream.getReader();
        buffered = new Uint8Array(request.maxBytes);
        try {
          // GM managers need not propagate ReadableStream backpressure to their network reader.
          // Drain into a byte-bounded request queue even while Rust withholds credit.
          while (!job.finished) {
            const { value, done } = await job.reader.read();
            if (done) break;
            if (produced + value.byteLength > request.maxBytes) throw new Error('response-too-large');
            buffered.set(value, produced);
            produced += value.byteLength;
            job.wakeReader?.();
          }
          readerDone = true;
          job.wakeReader?.();
        } catch (error) { finish(error.message); }
      };
      const pump = async () => {
        if (pumping || job.finished || !responseHead) return;
        const response = responseHead;
        const skipBody = request.method === 'HEAD' || response.status < 200 || response.status >= 300;
        if (!skipBody && !stream) return;
        pumping = true;
          try {
            if (response.finalUrl && response.finalUrl !== url.href) throw new Error('redirect-unsupported');
            const head = headers(response.responseHeaders);
            if (request.kind === 'media' && response.status === 200) throw new Error('range-unsupported');
            if (skipBody) delete head['content-length'];
            if (!skipBody && Number(head['content-length']) > request.maxBytes) throw new Error('response-too-large');
            send({ type: 'response_head', id: request.id, status: response.status, headers: head, finalUrl: response.finalUrl || url.href });
            await consumeCredit(job);
            if (skipBody) { finish(); job.handle?.abort(); return; }
            let sequence = 0;
            while (!job.finished) {
              if (produced === consumed && !readerDone) await new Promise((resolve) => { job.wakeReader = resolve; });
              job.wakeReader = null;
              if (job.finished) return;
              if (produced === consumed) { if (readerDone) break; continue; }
              const value = buffered.subarray(consumed, produced);
              consumed = produced;
              for (let offset = 0; offset < value.byteLength; offset += 65524) {
                const chunk = value.subarray(offset, offset + 65524);
                const frame = new Uint8Array(12 + chunk.byteLength);
                const view = new DataView(frame.buffer);
                view.setBigUint64(0, BigInt(request.id), false); view.setUint32(8, sequence++, false); frame.set(chunk, 12);
                socket.send(frame);
                await consumeCredit(job);
              }
            }
            finish();
          } catch (error) { finish(error.message); }
      };
      const observe = (response) => {
        if (job.finished) return;
        // Tampermonkey exposes the stream at OPENED (status=0), before HEADERS_RECEIVED.
        if (response.response && typeof response.response.getReader === 'function') stream = response.response;
        if (response.status >= 100 && !responseHead) responseHead = response;
        void readBounded();
        void pump();
      };
      job.handle = GM_xmlhttpRequest({
        method: request.method, url: url.href, headers: outgoing, data: body ? new Blob([body]) : undefined,
        anonymous: request.kind !== 'api',
        redirect: 'manual', responseType: 'stream', fetch: true, timeout: Math.min(24000, request.timeoutMs),
        onloadstart: observe,
        onreadystatechange: observe,
        onload: (response) => {
          observe(response);
          if (!pumping && !job.finished) finish('stream-unsupported');
        },
        onerror: () => finish('network'), ontimeout: () => finish('timeout'),
        onabort: () => { if (!job.finished) finish('cancelled'); },
      });
    } catch (error) { finish(error.message); }
  }
  function connect() {
  socket = new WebSocket(`ws://${location.host}${BASE}socket`);
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => { send({ type: 'hello', protocol: 1, scriptVersion: '1.0.1', ...(resumeToken ? { resumeToken } : { challenge }) }); state(resumeToken ? '验证浏览器桥重连' : '等待 DeepStudent 确认配对'); };
  socket.onmessage = (event) => {
    if (typeof event.data !== 'string' || event.data.length > 131072) return;
    let message;
    try { message = JSON.parse(event.data); } catch { socket.close(); return; }
    if (message.type === 'ping') { send({ type: 'pong' }); return; }
    if (message.type === 'authorized' && /^[a-f0-9]{64}$/.test(message.resumeToken)) { resumeToken = message.resumeToken; return; }
    if (message.type === 'ready') { reconnects = 0; state(message.media ? '解析和媒体已就绪' : '仅解析可用'); return; }
    if (message.type === 'revoked') { stopped = true; resumeToken = null; socket.close(); return; }
    if (message.type === 'request') { state('浏览器桥已连接'); void run(message); return; }
    const job = active.get(message.id);
    if (message.type === 'cancel') { job?.cancel(); return; }
    if (message.type === 'credit' && job) {
      if (job.waiter) { const waiter = job.waiter; job.waiter = null; waiter.resolve(); }
      else job.credit = true;
    }
  };
  socket.onclose = () => {
    for (const job of active.values()) job.cancel(); state('浏览器桥已断开');
    if (!stopped && resumeToken && reconnects++ < 15) reconnectTimer = setTimeout(connect, 5000);
  };
  socket.onerror = () => socket.close();
  }
  connect();
  window.addEventListener('pagehide', () => { stopped = true; resumeToken = null; clearTimeout(reconnectTimer); for (const job of active.values()) job.cancel(); socket.close(); }, { once: true });
})();
