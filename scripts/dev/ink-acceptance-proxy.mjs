#!/usr/bin/env node
/**
 * Dev-only loopback acceptance proxy. Enforces the approved hard budget at the
 * HTTP boundary: exactly `limit` (max 20) actual upstream requests; request 21
 * is rejected before any upstream socket. POST only, path allowlisted, no
 * query/fragment/absolute/protocol-relative target, bounded JSON body with an
 * exact `model` match, origin-pinned upstream with no credentials/query/path.
 * Redirect responses are blocked, no retries. Logs are metadata only; headers
 * and bodies are never logged. Counter increments synchronously immediately
 * before each upstream request; failed requests still consume their slot.
 * No reset endpoint. Nothing under src/ or src-tauri/ references this file.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MAX_LIMIT = 20;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'upgrade']);
const DEFAULT_PATHS = [
  /^\/(?:v1\/)?chat\/completions$/,
  /^\/(?:v1\/)?responses$/,
  /^\/(?:v1\/)?messages$/,
  /^\/(?:v1beta?\/)?models\/[^/]+:(?:streamGenerateContent|generateContent)$/,
];

function parseUpstream(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('upstreamBaseUrl is required');
  let upstream;
  try { upstream = new URL(value); } catch { throw new Error('upstreamBaseUrl must be an absolute URL'); }
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') throw new Error('upstreamBaseUrl must use http or https');
  if (upstream.username || upstream.password) throw new Error('upstreamBaseUrl must not contain credentials');
  if (upstream.search || upstream.hash) throw new Error('upstreamBaseUrl must not contain query or fragment');
  if (upstream.pathname !== '/' && upstream.pathname !== '') throw new Error('upstreamBaseUrl must be an origin without a path');
  return upstream;
}

function pathAllowed(pathname, rules) {
  const list = rules ?? DEFAULT_PATHS;
  if (typeof list === 'function') return Boolean(list(pathname));
  if (!Array.isArray(list)) throw new Error('allowedPaths must be an array or function');
  return list.some((rule) => (typeof rule === 'string' ? pathname === rule : rule.test(pathname)));
}

function cleanHeaders(headers, isRequest = false) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP.has(lower)) continue;
    if (isRequest && (lower === 'cookie' || lower === 'proxy-authorization')) continue;
    out[name] = value;
  }
  return out;
}

function reply(res, status, type, message) {
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { type, message } }));
}

function emit(log, record) {
  try { log(record); } catch { /* logging must not change admission */ }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (error) => {
      if (settled) return;
      settled = true;
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAborted);
      return error ? reject(error) : resolve(Buffer.concat(chunks));
    };
    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { done(Object.assign(new Error('body too large'), { code: 'body_too_large' })); req.resume(); return; }
      chunks.push(chunk);
    };
    const onEnd = () => done();
    const onError = (error) => done(error);
    const onAborted = () => done(Object.assign(new Error('request aborted'), { code: 'aborted' }));
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('aborted', onAborted);
  });
}

/** Start the proxy. Returns {url, host, port, count, rejected, attempts, close}. */
export async function startAcceptanceProxy(options = {}) {
  const {
    upstreamBaseUrl, model, limit, expectedUpstreamHost, allowedPaths,
    host = '127.0.0.1', port = 0, log = () => {},
  } = options;
  const upstream = parseUpstream(upstreamBaseUrl);
  if (typeof model !== 'string' || !model.trim()) throw new Error('model must be a non-empty pinned model string');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') throw new Error(`refusing to bind non-loopback host: ${host}`);
  if (expectedUpstreamHost !== undefined) {
    const expected = String(expectedUpstreamHost).toLowerCase();
    if (upstream.hostname.toLowerCase() !== expected && upstream.host.toLowerCase() !== expected) {
      throw new Error(`upstream host ${upstream.hostname} does not match pinned host ${expectedUpstreamHost}`);
    }
  }
  const transport = upstream.protocol === 'https:' ? https : http;
  let forwarded = 0;
  let rejected = 0;
  let attempts = 0;

  const handle = async (req, res) => {
    const rawUrl = req.url ?? '';
    const pathname = rawUrl.split('?')[0];
    const reject = (status, type, reason) => {
      rejected += 1;
      reply(res, status, type, reason);
      emit(log, { event: 'rejected', reason, method: req.method, path: pathname });
    };
    if (req.method !== 'POST') return reject(405, 'acceptance_method_mismatch', 'only POST is allowed');
    if (!rawUrl.startsWith('/') || rawUrl.startsWith('//')) return reject(400, 'acceptance_url_override', 'absolute/protocol-relative request target');
    if (rawUrl.includes('?') || rawUrl.includes('#') || rawUrl.includes('\\')) return reject(400, 'acceptance_url_override', 'query/fragment/backslash is not allowed');
    if (!pathAllowed(pathname, allowedPaths)) return reject(403, 'acceptance_provider_mismatch', 'request path is not allowed');

    let body;
    try { body = await readBody(req); } catch (error) {
      if (error.code === 'aborted') return;
      if (error.code === 'body_too_large') return reject(413, 'acceptance_body_too_large', `body exceeds ${MAX_BODY_BYTES} bytes`);
      return reject(400, 'acceptance_invalid_body', 'unreadable request body');
    }
    let json;
    try { json = JSON.parse(body.toString('utf8')); } catch { return reject(400, 'acceptance_invalid_json', 'request body is not valid JSON'); }
    if (!json || typeof json !== 'object' || Array.isArray(json) || typeof json.model !== 'string' || !json.model) {
      return reject(400, 'acceptance_missing_model', 'request body must contain a model string');
    }
    if (json.model !== model) return reject(403, 'acceptance_model_mismatch', 'request model is not the pinned model');

    // Synchronous admission: no await between this increment and transport.request.
    const slot = (attempts += 1);
    if (slot > limit) {
      rejected += 1;
      reply(res, 429, 'acceptance_budget_exhausted', `limit ${limit} reached`);
      emit(log, { event: 'rejected', reason: 'budget', method: req.method, path: pathname, attempt: slot });
      return;
    }
    forwarded += 1;
    const startedAt = Date.now();
    const target = new URL(pathname, upstream);
    const headers = cleanHeaders(req.headers, true);
    headers.host = target.host;
    headers['content-length'] = String(body.length);
    // Journal the slot before opening the upstream request: a killed process
    // must not erase an already-attempted request from the evidence trail.
    emit(log, { event: 'admitted', seq: slot, method: 'POST', path: target.pathname, model, bodyBytes: body.length });

    let upstreamRequest;
    try {
      upstreamRequest = transport.request(
        { protocol: target.protocol, hostname: target.hostname, port: target.port, method: 'POST', path: target.pathname, headers },
        (upstreamResponse) => {
          const status = upstreamResponse.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            upstreamResponse.resume();
            reply(res, 502, 'acceptance_redirect_blocked', `upstream status ${status}`);
            emit(log, { event: 'redirect_blocked', seq: slot, method: 'POST', path: target.pathname, status });
            return;
          }
          const responseHeaders = cleanHeaders(upstreamResponse.headers);
          delete responseHeaders.location;
          if (!res.headersSent && !res.destroyed) {
            res.writeHead(status, responseHeaders);
            upstreamResponse.pipe(res);
          } else {
            upstreamResponse.resume();
          }
          emit(log, { event: 'forwarded', seq: slot, method: 'POST', path: target.pathname, status, model, durationMs: Date.now() - startedAt });
        },
      );
    } catch (error) {
      reply(res, 502, 'acceptance_upstream_error', error.message);
      emit(log, { event: 'upstream_error', seq: slot, method: 'POST', path: target.pathname });
      return;
    }
    upstreamRequest.on('error', (error) => {
      reply(res, 502, 'acceptance_upstream_error', error.message);
      emit(log, { event: 'upstream_error', seq: slot, method: 'POST', path: target.pathname });
    });
    upstreamRequest.end(body);
  };

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => reply(res, 500, 'acceptance_internal_error', 'internal error'));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    url: `http://${host}:${actualPort}`, host, port: actualPort,
    get count() { return forwarded; },
    get rejected() { return rejected; },
    get attempts() { return attempts; },
    async close() { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); },
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) throw new Error(`unexpected argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    args[flag.slice(2)] = value;
    index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) throw new Error('--config <path> is required');
  const config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  for (const key of Object.keys(config)) {
    if (/key|token|secret|auth|password|cookie/i.test(key)) throw new Error(`config must not contain secrets: ${key}`);
  }
  if (args.log && fs.existsSync(args.log) && fs.statSync(args.log).size > 0) {
    throw new Error(`--log ${args.log} already contains evidence; use a new path`);
  }
  const logStream = args.log ? fs.createWriteStream(args.log, { flags: 'a' }) : null;
  const proxy = await startAcceptanceProxy({
    upstreamBaseUrl: config.upstreamBaseUrl,
    model: config.model,
    limit: config.limit,
    host: args.host ?? '127.0.0.1',
    port: args.port === undefined ? 0 : Number(args.port),
    log: (record) => { if (logStream) logStream.write(`${JSON.stringify(record)}\n`); },
  });
  process.stdout.write(`${JSON.stringify({ event: 'listening', url: proxy.url, host: proxy.host, port: proxy.port, model: config.model, limit: config.limit })}\n`);
  const shutdown = async (signal) => {
    await proxy.close();
    if (logStream) await new Promise((resolve) => logStream.end(resolve));
    const summary = { event: 'summary', signal, forwarded: proxy.count, rejected: proxy.rejected, attempts: proxy.attempts };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
}

export default startAcceptanceProxy;
