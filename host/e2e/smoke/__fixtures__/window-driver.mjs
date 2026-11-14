import { _electron } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseSourceJson } from './source-json.ts';

export const repo = resolve(import.meta.dirname, '../../../..');
export function artifactRoot(prefix) {
  mkdirSync('/tmp/opencode', { recursive: true });
  return mkdtempSync(`/tmp/opencode/${prefix}-`);
}
export const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
export function traceAt(root) {
  return readFileSync(join(root, 'wire.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export async function launchWindow(root, { harness = false, seed, recordProcessHooks = false } = {}) {
  for (const dir of ['home', 'tmp', 'data', 'config', 'cache', 'local', 'userdata', 'runtime']) {
    mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  }
  const env = { ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
    XDG_DATA_HOME: join(root, 'local'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'), APPDATA: join(root, 'config'), LOCALAPPDATA: join(root, 'local'),
    DS_APP_DATA_DIR: join(root, 'data'), DS_ELECTRON_USER_DATA: join(root, 'userdata'),
    DEEP_STUDENT_KEY_SEED_FILE_ONLY: '1', X1_TRACE: join(root, 'wire.jsonl'),
  };
  if (seed !== undefined) {
    env.HOME = env.USERPROFILE = join(seed.directory, 'home');
    env.DS_APP_DATA_DIR = seed.dataDir;
    env.XDG_DATA_HOME = env.LOCALAPPDATA = seed.dataLocalDir;
    mkdirSync(env.HOME, { recursive: true });
  }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DS_ELECTRON_DEV_URL', 'DS_HOST_ENTRY', 'DS_HOST_PROFILE', 'DS_ELECTRON_CAPTURE', 'X1_RECORD_PROCESS_HOOKS']) delete env[key];
  if (recordProcessHooks) env.X1_RECORD_PROCESS_HOOKS = '1';
  let server;
  if (harness) {
    server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><meta charset="utf-8"><title>X1 v0 B invoke harness</title><h1>Real Electron B invoke harness</h1>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    env.DS_ELECTRON_DEV_URL = `http://127.0.0.1:${server.address().port}/`;
  }
  save(join(root, 'launch.json'), { tip: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    mode: harness ? 'v0-harness' : 'real-dist', entry: 'electron/main.ts:start()', profile: 'host/profiles/desktop.json',
    home: env.HOME, dataDir: env.DS_APP_DATA_DIR, dataLocalDir: env.XDG_DATA_HOME,
    userData: env.DS_ELECTRON_USER_DATA, display: env.DISPLAY,
    devUrl: env.DS_ELECTRON_DEV_URL ?? null, node: process.version, processHooks: recordProcessHooks ? 'recorded (start({ processHooks }))' : 'production' });
  let application;
  try {
    application = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
      args: ['--no-sandbox', '--disable-gpu', join(import.meta.dirname, 'window-main.mjs')],
      cwd: root, env, timeout: 60_000 });
  } catch (error) {
    server?.close();
    writeFileSync(join(root, 'launch-error.txt'), String(error));
    throw error;
  }
  let stdout = '', stderr = '';
  const electronProcess = application.process();
  electronProcess.stdout.on('data', chunk => { stdout += chunk; });
  electronProcess.stderr.on('data', chunk => { stderr += chunk; });
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push({ phase: currentPhase, message: error.message, stack: error.stack }));
  let currentPhase = 'boot';
  return {
    application, page, root, errors,
    async mark(phase) {
      currentPhase = phase;
      return application.evaluate((_electron, name) => globalThis.__x1Mark(name), phase);
    },
    async close() {
      try {
        await application.close();
        return { pid: electronProcess.pid, code: electronProcess.exitCode, signal: electronProcess.signalCode };
      }
      finally {
        server?.close();
        writeFileSync(join(root, 'stdout.log'), stdout);
        writeFileSync(join(root, 'stderr.log'), stderr);
        save(join(root, 'page-errors.json'), errors);
      }
    },
  };
}

// Each invocation goes through the unmodified renderer -> preload -> shell -> Host.
// Result/error is a tagged union: missing/undefined must not become JSON null.
export async function invoke(page, cmd, args = {}, timeoutMs = 10_000) {
  return evaluateInvoke(page, cmd, { args }, timeoutMs);
}

export async function invokeSourceJson(page, cmd, argsJson, timeoutMs = 10_000) {
  // Playwright structured cloning strips JSON.rawJSON's native brand. Carry
  // text, then rebuild numeric atoms in the renderer before production invoke.
  // Ordinary caller Numbers have already been serialized as-is, not repaired.
  return evaluateInvoke(page, cmd, { argsJson }, timeoutMs);
}

export async function invokeRawBody(page, cmd, bytes, headers = {}, timeoutMs = 10_000) {
  // Base64 is only Playwright's carrier; the actual production invoke receives
  // a renderer Uint8Array, never a JSON array or base64 string.
  return evaluateInvoke(page, cmd, { rawBase64: Buffer.from(bytes).toString('base64'), headers }, timeoutMs);
}

async function evaluateInvoke(page, cmd, payload, timeoutMs) {
  return page.evaluate(async ({ cmd, payload, timeoutMs }) => {
    const args = payload.rawBase64 !== undefined ? Uint8Array.from(atob(payload.rawBase64), char => char.charCodeAt(0))
      : payload.argsJson === undefined ? payload.args
      : JSON.parse(payload.argsJson, (_key, value, context) =>
        typeof value === 'number' ? JSON.rawJSON(context.source) : value);
    if (payload.argsJson !== undefined && Array.isArray(args)) {
      throw new Error('v0 JSON source replay does not support top-level raw binary invoke arrays');
    }
    const tag = value => value === undefined ? { type: 'undefined' }
      : value instanceof ArrayBuffer ? { type: 'bytes', value: [...new Uint8Array(value)] }
      : { type: 'json', value };
    let timer;
    const outcome = await Promise.race([
      window.__TAURI_INTERNALS__.invoke(cmd, args, payload.rawBase64 === undefined ? undefined : { headers: payload.headers }).then(
        value => ({ kind: 'result', ...tag(value) }),
        error => ({ kind: 'error', ...tag(error) })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ kind: 'timeout', timeoutMs }), timeoutMs); }),
    ]);
    clearTimeout(timer);
    return outcome;
  }, { cmd, payload, timeoutMs });
}

// Correlate the observed production response by webContents/callback, not by
// command name alone. The renderer projection is retained separately because
// production decodeBody currently uses ordinary JSON.parse.
export function sourceResult(trace, phase, cmd, projected) {
  if (projected.kind === 'timeout' || projected.type !== 'json') return projected;
  const calls = callsFromTrace(trace).filter(call => call.phase === phase && call.cmd === cmd);
  if (calls.length !== 1 || calls[0].outcome !== projected.kind || calls[0].body?.kind !== 'json') {
    throw new Error(`missing correlated JSON response: ${phase} ${cmd}`);
  }
  const call = calls[0];
  return { ...projected, value: parseSourceJson(call.body.data), rendererValue: projected.value,
    rawJson: call.body.data, wire: { invokeSeq: call.seq, responseSeq: call.responseSeq, webContents: call.webContents } };
}

export function callsFromTrace(trace) {
  const pending = new Map();
  const calls = [];
  for (const row of trace) {
    const m = row.message;
    if (row.kind === 'renderer-invoke' && m.type === 'invoke') {
      const call = { phase: row.phase, seq: row.seq, webContents: row.webContents, cmd: m.cmd,
        payload: m.payload, callback: m.callback, errorCallback: m.error, outcome: 'pending' };
      calls.push(call);
      pending.set(`${row.webContents}:${m.callback}`, { call, ok: true });
      pending.set(`${row.webContents}:${m.error}`, { call, ok: false });
    } else if (row.kind === 'renderer-result' && m.type === 'result') {
      const found = pending.get(`${row.webContents}:${m.callbackId}`);
      if (found) {
        Object.assign(found.call, { outcome: found.ok ? 'result' : 'error', responseSeq: row.seq, body: m.body });
        pending.delete(`${row.webContents}:${found.call.callback}`);
        pending.delete(`${row.webContents}:${found.call.errorCallback}`);
      }
    }
  }
  return calls;
}
