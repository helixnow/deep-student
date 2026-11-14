/**
 * WAVE0 deterministic MCP service for A/B differential runs (X7 recorder, X1 driver).
 *
 * One service instance = one isolated take: its own loopback port, its own record log,
 * its own stdio log file. Transports:
 *   - stdio: `stdioLaunch(script)` → command/args/env/cwd/framing; the backend under test
 *     spawns `stdio-server.ts` itself (through `mcp_stdio_start` / `test_mcp_connection`).
 *   - legacy SSE: `GET  {url}/sse/<script>` opens the stream and sends
 *     `event: endpoint` with `/sse/<script>/messages?sessionId=sN`; replies go on the stream.
 *   - streamable HTTP: `POST {url}/mcp/<script>`, JSON reply, `Mcp-Session-Id: http-1` on initialize.
 *   - WebSocket: `GET {url}/ws/<script>` upgrade (`ws://…`), one JSON-RPC text per message, `ws1, ws2, …` per reset.
 *   - OAuth 2.1 authorization server on a second loopback port (`__fixtures__/oauth-server.ts`), and
 *     `<logDir>/bin/xdg-open` that visits authorization URLs in place of a browser (`__fixtures__/oauth-browser.ts`).
 * Replies come from `protocol.ts` only. Nothing here decides whether A and B agree.
 *
 * Plain Node TS (type-stripping safe).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { chmodSync, copyFileSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BrowserRecord } from './__fixtures__/oauth-browser.ts';
import { startOAuthServer, type OAuthRecord } from './__fixtures__/oauth-server.ts';
import {
  closePayload, createFrameDecoder, createMessageAssembler, encodeFrame, handshakeProblem, handshakeResponse, OPCODES,
} from './__fixtures__/websocket.ts';
import {
  handleMessage, isScriptId, replyText, SCRIPT_IDS, scripts,
  type FixtureRecord, type LifecycleRecord, type MessageRecord, type ScriptId,
} from './protocol.ts';
import { currentStdioRuntime, type StdioRuntime } from './runtime.ts';

export interface McpServiceConfig {
  /** Default `127.0.0.1`; never bind a public interface. */
  host?: string;
  /** Default 0 (ephemeral). Use one service per backend take. */
  port?: number;
  /**
   * Port of the OAuth authorization server. Default `port + 1` for a fixed `port` (G3: 47131 next
   * to 47130), else 0. Its origin must differ from `url`: a token is bound to the resource origin.
   */
  oauthPort?: number;
  /** Directory for the stdio log and the stdio cwd; default a fresh `mkdtemp` under the OS temp dir. */
  logDir?: string;
  /** Node executable for the stdio child (needs type stripping); default resolved by `runtime.ts`. */
  nodeCommand?: string | null;
  /**
   * Launch a copy of the stdio server under `<logDir>/fixture/` instead of this checkout's file.
   * Launch values reach events, error texts and the `mcp.tools.list` row in the DB snapshot, so a
   * G3 take needs them run-independent: with a fixed `logDir`, `port` and `nodeCommand` every
   * placeholder is the same on A, A2 and B whatever checkout or temp dir each side runs from.
   */
  selfContained?: boolean;
}

export interface StdioLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  framing: 'jsonl';
  runtime: StdioRuntime['kind'];
  nodeVersion: string;
}

export interface McpRecords {
  /** SSE/HTTP/WebSocket records in arrival order. */
  network: FixtureRecord[];
  /** stdio records in append order across all children of this service. */
  stdio: FixtureRecord[];
  /** OAuth authorization server requests in arrival order. */
  oauth: OAuthRecord[];
  /** What `<logDir>/bin/xdg-open` visited, in append order. */
  browser: BrowserRecord[];
}

/** The stand-in browser: put `pathDir` first on the app's PATH so the opener runs `command`. */
export interface BrowserLaunch {
  pathDir: string;
  command: string;
  logFile: string;
}

export interface McpService {
  /** e.g. `http://127.0.0.1:41234` */
  readonly url: string;
  /** OAuth authorization server origin, e.g. `http://127.0.0.1:41235` */
  readonly oauthUrl: string;
  readonly logDir: string;
  readonly stdioLogFile: string;
  sseUrl(script: ScriptId): string;
  httpUrl(script: ScriptId): string;
  wsUrl(script: ScriptId): string;
  stdioLaunch(script: ScriptId): StdioLaunch;
  browserLaunch(): BrowserLaunch;
  /** An enabled `mcp.tools.list` entry that `validate_stdio_start_against_entries` accepts for this launch. */
  toolsListEntry(script: ScriptId, id?: string): Record<string, unknown>;
  /** `${mcp.*}` placeholder values for scenario files (see README). */
  placeholders(): Record<string, unknown>;
  /** `placeholders()` without the `mcp.` prefix as a nested object: `${mcp.success.args}` is `bindings().success.args`. */
  bindings(): Record<string, unknown>;
  records(): McpRecords;
  /** Open SSE streams, WebSocket connections and HTTP requests (OAuth included) that have not finished. */
  openCount(): number;
  /** stdio children with a start record, no exit record and a live pid. */
  liveStdio(): number[];
  /** Resolves true once nothing is open and no stdio child is alive; false after `timeoutMs` (a finding). */
  whenIdle(timeoutMs: number): Promise<boolean>;
  /** Ends open streams and connections (`server-reset`), clears records, session counters and OAuth state, truncates the stdio and browser logs. */
  reset(): Promise<{ closedStreams: number; liveStdio: number[] }>;
  /** Ends open streams (`server-stopped`) and closes both ports. Records stay readable. */
  stop(): Promise<void>;
}

const STDIO_SERVER = fileURLToPath(new URL('./stdio-server.ts', import.meta.url));
/** Imports only `node:` modules, so it is copied alone. */
const BROWSER_SCRIPT = fileURLToPath(new URL('./__fixtures__/oauth-browser.ts', import.meta.url));
/** The stdio server and everything it imports outside `node:`. */
const STDIO_SERVER_FILES = ['stdio-server.ts', 'protocol.ts'];

function materializeFixture(logDir: string): { stdioServer: string; browserScript: string } {
  const dir = join(logDir, 'fixture');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  for (const name of STDIO_SERVER_FILES) copyFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), join(dir, name));
  copyFileSync(BROWSER_SCRIPT, join(dir, 'oauth-browser.ts'));
  return { stdioServer: join(dir, 'stdio-server.ts'), browserScript: join(dir, 'oauth-browser.ts') };
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** `<logDir>/bin/xdg-open`: runs the stand-in browser with the stdio runtime (node with type stripping). */
function writeBrowserLauncher(logDir: string, runtime: StdioRuntime, script: string): BrowserLaunch {
  const pathDir = join(logDir, 'bin');
  const command = join(pathDir, 'xdg-open');
  const logFile = join(logDir, 'browser-records.jsonl');
  mkdirSync(pathDir, { recursive: true });
  const env = Object.entries(runtime.env).map(([key, value]) => `${key}=${shellQuote(value)} `).join('');
  writeFileSync(command, `#!/bin/sh\n${env}exec ${shellQuote(runtime.command)} ${shellQuote(script)} --log ${shellQuote(logFile)} "$@"\n`);
  chmodSync(command, 0o755);
  writeFileSync(logFile, '');
  return { pathDir, command, logFile };
}

function nest(flat: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const path = key.slice(prefix.length).split('.');
    let node = root;
    for (const part of path.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
    node[path[path.length - 1] ?? ''] = value;
  }
  return root;
}

function sortedHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const key of Object.keys(request.headers).sort()) {
    const value = request.headers[key];
    headers[key] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  }
  return headers;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    request.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
    request.on('error', reject);
  });
}

function parseLines(text: string): FixtureRecord[] {
  return text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as FixtureRecord);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

interface SseSession { id: string; script: ScriptId; response: ServerResponse; generation: number }
interface WsSession { id: string; script: ScriptId; socket: Socket; generation: number; closed: boolean }

export async function startMcpService(config: McpServiceConfig = {}): Promise<McpService> {
  const host = config.host ?? '127.0.0.1';
  const ownedLogDir = config.logDir === undefined;
  const logDir = realpathSync(config.logDir ?? mkdtempSync(join(tmpdir(), 'mcp-wave0-')));
  const stdioLogFile = join(logDir, 'stdio-records.jsonl');
  writeFileSync(stdioLogFile, '');
  const runtime = currentStdioRuntime(config.nodeCommand);
  const fixture = config.selfContained === true ? materializeFixture(logDir) : { stdioServer: realpathSync(STDIO_SERVER), browserScript: realpathSync(BROWSER_SCRIPT) };
  const stdioServer = fixture.stdioServer;
  const browser = writeBrowserLauncher(logDir, runtime, fixture.browserScript);

  let network: FixtureRecord[] = [];
  let generation = 0;
  let sseCounter = 0;
  let httpCounter = 0;
  let wsCounter = 0;
  let stopped = false;
  const sse = new Map<string, SseSession>();
  const websockets = new Set<WsSession>();
  const inflight = new Set<ServerResponse>();
  const sockets = new Set<Socket>();

  const lifecycle = (record: Omit<LifecycleRecord, 'kind'>): void => { network.push({ kind: 'lifecycle', ...record }); };
  const message = (record: Omit<MessageRecord, 'kind'>): void => { network.push({ kind: 'message', ...record }); };

  const endSession = (session: SseSession, reason: string): void => {
    if (!sse.delete(session.id)) return;
    if (session.generation === generation) {
      lifecycle({ transport: 'sse', script: session.script, session: session.id, event: 'stream-close', reason, detail: null });
    }
    session.response.end();
  };

  const handleSse = async (request: IncomingMessage, response: ServerResponse, script: ScriptId, rest: string, url: URL): Promise<void> => {
    if (request.method === 'GET' && rest === '') {
      sseCounter += 1;
      const session: SseSession = { id: `s${sseCounter}`, script, response, generation };
      sse.set(session.id, session);
      lifecycle({ transport: 'sse', script, session: session.id, event: 'stream-open', reason: null, detail: { headers: sortedHeaders(request) } });
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.write(`event: endpoint\ndata: /sse/${script}/messages?sessionId=${session.id}\n\n`);
      response.on('close', () => { endSession(session, 'client-closed'); });
      return;
    }
    if (request.method === 'POST' && rest === '/messages') {
      const raw = await readBody(request);
      const sessionId = url.searchParams.get('sessionId');
      const session = sessionId === null ? undefined : sse.get(sessionId);
      if (session === undefined || session.script !== script) {
        lifecycle({ transport: 'sse', script, session: sessionId, event: 'not-found', reason: 'unknown-session', detail: { raw, headers: sortedHeaders(request) } });
        response.writeHead(404, { 'content-type': 'text/plain' }).end('unknown session');
        return;
      }
      const handled = handleMessage(script, raw);
      message({ transport: 'sse', script, session: session.id, method: handled.method, id: handled.id, params: handled.params, raw, outcome: handled.outcome, replies: handled.replies.map(replyText), headers: sortedHeaders(request) });
      response.writeHead(202).end();
      for (const reply of handled.replies) {
        if (reply.kind === 'disconnect') { endSession(session, 'disconnect-script'); return; }
        session.response.write(`event: message\ndata: ${replyText(reply) ?? ''}\n\n`);
      }
      return;
    }
    lifecycle({ transport: 'sse', script, session: null, event: 'not-found', reason: `${request.method ?? ''} ${url.pathname}`, detail: { headers: sortedHeaders(request) } });
    response.writeHead(404).end();
  };

  const handleHttp = async (request: IncomingMessage, response: ServerResponse, script: ScriptId, url: URL): Promise<void> => {
    const session = typeof request.headers['mcp-session-id'] === 'string' ? request.headers['mcp-session-id'] : null;
    if (request.method === 'DELETE') {
      lifecycle({ transport: 'http', script, session, event: 'session-delete', reason: null, detail: { headers: sortedHeaders(request) } });
      response.writeHead(200).end();
      return;
    }
    if (request.method !== 'POST') {
      lifecycle({ transport: 'http', script, session, event: 'not-found', reason: `${request.method ?? ''} ${url.pathname}`, detail: { headers: sortedHeaders(request) } });
      response.writeHead(405, { allow: 'POST, DELETE' }).end();
      return;
    }
    const raw = await readBody(request);
    const handled = handleMessage(script, raw);
    message({ transport: 'http', script, session, method: handled.method, id: handled.id, params: handled.params, raw, outcome: handled.outcome, replies: handled.replies.map(replyText), headers: sortedHeaders(request) });
    const [first] = handled.replies;
    if (first === undefined) {
      if (handled.outcome === 'held') return; // stays open until the client aborts, reset or stop
      response.writeHead(202).end();
      return;
    }
    if (first.kind === 'disconnect') { request.socket.destroy(); return; }
    const headers: Record<string, string> = { 'content-type': first.kind === 'message' ? 'application/json' : 'text/plain' };
    if (handled.method === 'initialize' && first.kind === 'message' && 'result' in first.message) {
      httpCounter += 1;
      headers['mcp-session-id'] = `http-${httpCounter}`;
    }
    const body = replyText(first) ?? '';
    if (handled.replies[1]?.kind === 'disconnect') {
      response.writeHead(200, headers);
      response.write(body, () => { request.socket.destroy(); });
      return;
    }
    response.writeHead(200, headers).end(body);
  };

  /** Close frame (unless the socket is gone), end the socket, one `stream-close` record for the current generation. */
  const closeWs = (session: WsSession, reason: string, code: number): void => {
    if (session.closed) return;
    session.closed = true;
    websockets.delete(session);
    if (session.generation === generation) {
      lifecycle({ transport: 'websocket', script: session.script, session: session.id, event: 'stream-close', reason, detail: { code } });
    }
    if (session.socket.writable) session.socket.end(encodeFrame(OPCODES.close, closePayload(code)));
    else session.socket.destroy();
  };

  const handleUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    const match = /^\/ws\/([^/]+)$/.exec(url.pathname);
    const script = match?.[1] ?? '';
    const refuse = (status: string, reason: string, detail: Record<string, unknown>): void => {
      lifecycle({ transport: 'websocket', script, session: null, event: 'not-found', reason, detail: { ...detail, headers: sortedHeaders(request) } });
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`);
    };
    if (match === null) { refuse('404 Not Found', `${request.method ?? ''} ${url.pathname}`, {}); return; }
    if (!isScriptId(script)) { refuse('404 Not Found', 'unknown-script', { known: SCRIPT_IDS }); return; }
    const problem = handshakeProblem(request);
    if (problem !== null) { refuse('400 Bad Request', 'bad-handshake', { problem }); return; }
    wsCounter += 1;
    const session: WsSession = { id: `ws${wsCounter}`, script, socket, generation, closed: false };
    websockets.add(session);
    socket.write(handshakeResponse(String(request.headers['sec-websocket-key'])));
    lifecycle({ transport: 'websocket', script, session: session.id, event: 'stream-open', reason: null, detail: { headers: sortedHeaders(request) } });
    const decode = createFrameDecoder();
    const assemble = createMessageAssembler();
    const onData = (chunk: Buffer): void => {
      if (session.closed) return;
      let frames;
      try { frames = decode(chunk); }
      catch (e) { closeWs(session, `protocol-error: ${String(e)}`, 1009); return; }
      for (const frame of frames) {
        if (session.closed) return;
        // RFC 6455 §5.1: a server closes the connection on an unmasked client frame.
        if (!frame.masked) { closeWs(session, 'protocol-error: unmasked client frame', 1002); return; }
        if (frame.opcode === OPCODES.ping) { socket.write(encodeFrame(OPCODES.pong, frame.payload)); continue; }
        if (frame.opcode === OPCODES.pong) continue;
        if (frame.opcode === OPCODES.close) {
          closeWs(session, 'client-close-frame', frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000);
          return;
        }
        let message;
        try { message = assemble(frame); }
        catch (e) { closeWs(session, `protocol-error: ${String(e)}`, 1002); return; }
        if (message === null) continue;
        const raw = message.payload.toString('utf8');
        const handled = handleMessage(script, raw);
        if (session.generation === generation) {
          network.push({ kind: 'message', transport: 'websocket', script, session: session.id, method: handled.method, id: handled.id, params: handled.params, raw, outcome: handled.outcome, replies: handled.replies.map(replyText), headers: null });
        }
        for (const reply of handled.replies) {
          if (reply.kind === 'disconnect') { closeWs(session, 'disconnect-script', 1000); return; }
          socket.write(encodeFrame(OPCODES.text, Buffer.from(replyText(reply) ?? '', 'utf8')));
        }
      }
    };
    socket.on('data', onData);
    socket.on('error', () => { /* the close handler records it */ });
    socket.on('close', () => {
      if (session.closed) return;
      session.closed = true;
      websockets.delete(session);
      if (session.generation === generation) lifecycle({ transport: 'websocket', script, session: session.id, event: 'stream-close', reason: 'client-closed', detail: null });
    });
    if (head.length > 0) onData(head);
  };

  const server: Server = createServer((request, response) => {
    inflight.add(response);
    response.on('close', () => { inflight.delete(response); });
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    const match = /^\/(sse|mcp)\/([^/]+)(\/messages)?$/.exec(url.pathname);
    const script = match?.[2] ?? '';
    const fail = (e: unknown): void => {
      lifecycle({ transport: 'http', script, session: null, event: 'config-error', reason: 'handler-error', detail: { error: String(e) } });
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy();
    };
    if (match === null || !isScriptId(script)) {
      lifecycle({ transport: match?.[1] === 'sse' ? 'sse' : 'http', script, session: null, event: 'not-found', reason: match === null ? `${request.method ?? ''} ${url.pathname}` : 'unknown-script', detail: { known: SCRIPT_IDS } });
      response.writeHead(404, { 'content-type': 'text/plain' }).end(match === null ? 'not found' : `unknown script ${script}`);
      return;
    }
    const work = match[1] === 'sse'
      ? handleSse(request, response, script, match[3] ?? '', url)
      : match[3] === undefined ? handleHttp(request, response, script, url) : Promise.resolve().then(() => {
        lifecycle({ transport: 'http', script, session: null, event: 'not-found', reason: `${request.method ?? ''} ${url.pathname}`, detail: null });
        response.writeHead(404).end();
      });
    work.catch(fail);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); });
  });
  server.on('upgrade', (request: IncomingMessage, socket, head: Buffer) => { handleUpgrade(request, socket as Socket, head); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port ?? 0, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  const url = `http://${host}:${address.port}`;
  const oauth = await startOAuthServer({ host, port: config.oauthPort ?? (config.port ? config.port + 1 : 0) }).catch(async (e: unknown) => {
    await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
    throw e;
  });

  // A self-created logDir is removed by stop(); records stay readable afterwards from this snapshot.
  let removedLogRecords: { stdio: FixtureRecord[]; browser: BrowserRecord[] } | null = null;
  const stdioRecords = (): FixtureRecord[] => removedLogRecords === null
    ? parseLines(readFileSync(stdioLogFile, 'utf8')) : structuredClone(removedLogRecords.stdio);
  const liveStdio = (): number[] => {
    const started = new Set<number>();
    for (const record of stdioRecords()) {
      if (record.kind !== 'lifecycle' || typeof record.session !== 'number') continue;
      if (record.event === 'start') started.add(record.session);
      if (record.event === 'exit') started.delete(record.session);
    }
    return [...started].filter(alive);
  };
  const openCount = (): number => inflight.size + websockets.size + oauth.openCount();
  const closeAll = (reason: string): number => {
    const open = [...sse.values()];
    for (const session of open) endSession(session, reason);
    const ws = [...websockets];
    for (const session of ws) closeWs(session, reason, 1001);
    for (const response of [...inflight]) response.destroy();
    return open.length + ws.length;
  };
  const browserRecords = (): BrowserRecord[] => removedLogRecords === null
    ? readFileSync(browser.logFile, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as BrowserRecord)
    : structuredClone(removedLogRecords.browser);

  const stdioLaunch = (script: ScriptId): StdioLaunch => ({
    command: runtime.command,
    args: [stdioServer, script, '--log', stdioLogFile],
    env: { ...runtime.env },
    cwd: logDir,
    framing: 'jsonl',
    runtime: runtime.kind,
    nodeVersion: runtime.nodeVersion,
  });
  const toolsListEntry = (script: ScriptId, id = `wave0-${script}`): Record<string, unknown> => {
    const launch = stdioLaunch(script);
    return { id, name: id, transportType: 'stdio', enabled: true, command: launch.command, args: launch.args, env: launch.env, cwd: launch.cwd, framing: launch.framing };
  };

  const wsUrl = (script: ScriptId): string => `ws://${host}:${address.port}/ws/${script}`;
  const placeholders = (): Record<string, unknown> => {
    const values: Record<string, unknown> = { 'mcp.url': url };
    for (const script of SCRIPT_IDS) {
      const launch = stdioLaunch(script);
      values[`mcp.${script}.command`] = launch.command;
      values[`mcp.${script}.args`] = launch.args;
      values[`mcp.${script}.env`] = launch.env;
      values[`mcp.${script}.cwd`] = launch.cwd;
      values[`mcp.${script}.framing`] = launch.framing;
      values[`mcp.${script}.sseUrl`] = `${url}/sse/${script}`;
      values[`mcp.${script}.httpUrl`] = `${url}/mcp/${script}`;
      values[`mcp.${script}.wsUrl`] = wsUrl(script);
      values[`mcp.${script}.toolsList`] = JSON.stringify([toolsListEntry(script)]);
    }
    values['mcp.oauth.url'] = oauth.url;
    values['mcp.oauth.resourceUrl'] = oauth.resourceUrl('dcr');
    values['mcp.oauth.noRegistrationResourceUrl'] = oauth.resourceUrl('no-registration');
    return values;
  };

  return {
    url, oauthUrl: oauth.url, logDir, stdioLogFile,
    sseUrl: script => `${url}/sse/${script}`,
    httpUrl: script => `${url}/mcp/${script}`,
    wsUrl,
    stdioLaunch,
    browserLaunch: () => ({ ...browser }),
    toolsListEntry,
    placeholders,
    bindings: () => nest(placeholders(), 'mcp.'),
    records: () => ({ network: structuredClone(network), stdio: stdioRecords(), oauth: oauth.records(), browser: browserRecords() }),
    openCount,
    liveStdio,
    async whenIdle(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (openCount() === 0 && liveStdio().length === 0) return true;
        if (Date.now() >= deadline) return false;
        await new Promise(resolve => { setTimeout(resolve, 25); });
      }
    },
    async reset() {
      const closedStreams = closeAll('server-reset');
      const live = liveStdio();
      generation += 1;
      network = [];
      sseCounter = 0;
      httpCounter = 0;
      wsCounter = 0;
      oauth.reset();
      writeFileSync(stdioLogFile, '');
      writeFileSync(browser.logFile, '');
      return { closedStreams, liveStdio: live };
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      closeAll('server-stopped');
      await Promise.all([
        new Promise<void>(resolve => {
          server.close(() => { resolve(); });
          for (const socket of sockets) socket.destroy();
        }),
        oauth.stop(),
      ]);
      if (ownedLogDir) {
        removedLogRecords = { stdio: stdioRecords(), browser: browserRecords() };
        rmSync(logDir, { recursive: true, force: true });
      }
    },
  };
}

function stdinIsPipe(): boolean {
  try { const stat = fstatSync(0); return stat.isFIFO() || stat.isSocket(); }
  catch { return false; }
}

async function main(argv: string[]): Promise<void> {
  const option = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const port = option('port');
  const oauthPort = option('oauth-port');
  const service = await startMcpService({
    host: option('host'), port: port === undefined ? undefined : Number(port),
    oauthPort: oauthPort === undefined ? undefined : Number(oauthPort),
    logDir: option('log-dir'), nodeCommand: option('node') ?? null, selfContained: argv.includes('--self-contained'),
  });
  // Control routes live on a second loopback port so they never appear in the fixture records.
  const control = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://control.invalid').pathname;
    const json = (value: unknown): void => { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value)); };
    if (request.method === 'GET' && path === '/records') { json(service.records()); return; }
    if (request.method === 'GET' && path === '/placeholders') { json(service.placeholders()); return; }
    if (request.method === 'GET' && path === '/idle') { json({ openCount: service.openCount(), liveStdio: service.liveStdio() }); return; }
    if (request.method === 'POST' && path === '/reset') { void service.reset().then(json); return; }
    const launch = /^\/launch\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && launch !== null && isScriptId(launch[1] ?? '')) { json(service.stdioLaunch(launch[1] as ScriptId)); return; }
    if (request.method === 'GET' && path === '/browser') { json(service.browserLaunch()); return; }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => { control.listen(0, '127.0.0.1', resolve); });
  const controlUrl = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;
  process.stdout.write(`${JSON.stringify({ url: service.url, oauthUrl: service.oauthUrl, control: controlUrl, pid: process.pid, logDir: service.logDir, stdioLogFile: service.stdioLogFile, scripts })}\n`);
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await service.stop();
    await new Promise<void>(resolve => { control.close(() => { resolve(); }); control.closeAllConnections(); });
    process.stdout.write(`${JSON.stringify({ stopped: true, records: service.records() })}\n`, () => { process.exit(0); });
  };
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
  if (stdinIsPipe()) {
    process.stdin.resume();
    process.stdin.on('end', () => { void stop(); });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`mcp equivalence service failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  });
}
