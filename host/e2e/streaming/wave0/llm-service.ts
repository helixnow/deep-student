/**
 * WAVE0 deterministic LLM service (OpenAI wire format: chat completions, embeddings, audio
 * transcriptions) over `node:http`.
 *
 * Both backends (A = Tauri+Rust, B = Electron+TS) point an ApiConfig `baseUrl` at
 * `${service.url}/s/<scriptId>/v1`. What a request answers and logs is decided by the llm-replay
 * core (`host/plugins/llm-providers/src/replay/answer.ts`, scripts in `builtin.ts`): the same code
 * answers the in-process replay, so both give identical status, content type, bytes and request
 * log for the same script and request. Built-in responses are a pure function of (scriptId,
 * request body): the round index is the number of assistant `tool_calls` messages after the last
 * user message, so parallel instances, retries and the two backends never share cursor state;
 * `w0.directive` derives its rounds from the request (replay/directive.ts); `/embeddings` answers
 * from the body alone (replay/embeddings.ts); `/audio/transcriptions` answers with the script's
 * text (replay/transcriptions.ts). This file only moves bytes: it writes the reply, tracks open
 * streams, logs client closes, and serves `/__x5/requests`. No response reads the clock or
 * randomness, and none carries a Date header. Every request is logged in arrival order; nothing
 * is dropped when a script is cancelled, errors or is not matched.
 *
 * Changing this file or anything it imports changes the G3 `llm` input closure
 * (scripts/electron-migration/record/g3-inputs.mjs), which makes every A recording that uses
 * the service stale.
 *
 * Plain Node TS (type-stripping safe): no enums, no parameter properties.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import {
  answerReplayRequest, logReplayServiceError, type ReplayRequestLog, type ReplayState,
} from '../../../plugins/llm-providers/src/replay/answer.ts';
import { LLM_REPLAY_SCRIPTS } from '../../../plugins/llm-providers/src/replay/builtin.ts';
import type {
  ReplayDerivedRound, ReplayDerivedScript, ReplayFrame, ReplayResponse, ReplayResponseScript, ReplayRound, ReplayRoundScript, ReplayScript,
} from '../../../plugins/llm-providers/src/replay/wire.ts';

export type Frame = ReplayFrame;
export type Round = ReplayRound;
export type Script = ReplayRoundScript;
/** A round derived from the request body instead of a fixed list (`w0.directive`). */
export type DerivedRound = ReplayDerivedRound;
export type DerivedScript = ReplayDerivedScript;
/** Owner-authored provider sidecars: literal UTF-8 chunks, then HTTP EOF. */
export type RawResponse = ReplayResponse;
export type ResponseScript = ReplayResponseScript;
export type ExtraScript = Script | ResponseScript;

/** L14 .provider.json format. No SSE parsing, folding, or invented completion frames. */
export function providerScripts(value: unknown): Record<string, ResponseScript> {
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!object(value)) throw new Error('x5 provider sidecar: expected an object');
  const result: Record<string, ResponseScript> = {};
  for (const [id, responses] of Object.entries(value)) {
    if (id === 'note' && typeof responses === 'string') continue;
    if (!Array.isArray(responses) || responses.length === 0) throw new Error(`x5 provider sidecar: ${id} needs responses`);
    const decoded = responses.map((r: unknown, index): RawResponse => {
      if (!object(r) || typeof r.status !== 'number' || !Number.isInteger(r.status) || r.status < 200 || r.status > 599
        || !object(r.headers) || !Object.values(r.headers).every(v => typeof v === 'string')
        || !Array.isArray(r.chunks) || !r.chunks.every((v: unknown) => typeof v === 'string')) {
        throw new Error(`x5 provider sidecar: invalid response ${id}[${index}]`);
      }
      return { status: r.status, headers: Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k, String(v)])),
        chunks: r.chunks.slice() };
    });
    Object.defineProperty(result, id, { value: { description: `provider sidecar: ${id}`, responses: decoded }, enumerable: true });
  }
  return result;
}

/** Script ids are part of the URL, so a scenario selects behaviour only through public ApiConfig. */
export const scripts = LLM_REPLAY_SCRIPTS;

export type ScriptId = keyof typeof scripts;

/** Field meanings: `ReplayRequestLog` in replay/answer.ts. */
export type LoggedRequest = ReplayRequestLog;

export interface LlmServiceConfig {
  /** Default `127.0.0.1`; never bind a public interface. */
  host?: string;
  /** Default 0 (ephemeral). Give each backend/instance its own service for isolated request logs. */
  port?: number;
  /** Extra scripts for one run; ids must not shadow the built-ins. */
  extraScripts?: Record<string, ExtraScript>;
}

export interface LlmService {
  /** e.g. `http://127.0.0.1:41234` */
  readonly url: string;
  /** ApiConfig.baseUrl for a script. */
  baseUrl(scriptId: string): string;
  readonly requests: readonly LoggedRequest[];
  /** Streams still open (held or in flight). */
  openCount(): number;
  /** Resolves true once no stream is open, false after `timeoutMs` (a finding, not a retry). */
  whenIdle(timeoutMs: number): Promise<boolean>;
  stop(): Promise<void>;
}

export async function startLlmService(config: LlmServiceConfig = {}): Promise<LlmService> {
  const table: Record<string, ReplayScript> = { ...scripts };
  for (const [id, script] of Object.entries(config.extraScripts ?? {})) {
    if (Object.hasOwn(table, id)) throw new Error(`x5 llm service: extra script ${id} shadows a built-in script`);
    Object.defineProperty(table, id, { value: structuredClone(script), enumerable: true });
  }
  // Sidecar request order is per script AND per service/take, never module-global.
  const state: ReplayState = { table, cursors: new Map(), requests: [] };
  const requests = state.requests;
  const sockets = new Set<Socket>();
  const open = new Set<{ entry: LoggedRequest; response: ServerResponse }>();
  let stopping = false;

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const received: Buffer[] = [];
    for await (const part of request) received.push(part as Buffer);
    const bytes = Buffer.concat(received);
    const path = request.url ?? '';
    // A Date header would make the same request answer different bytes.
    response.sendDate = false;
    // Introspection for out-of-process callers is not part of the recorded provider traffic.
    if (request.method === 'GET' && path === '/__x5/requests') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(requests));
      return;
    }
    const { entry, reply } = answerReplayRequest(state, { method: request.method ?? '', path,
      contentType: request.headers['content-type'], bytes, rawHeaders: () => request.rawHeaders.slice() });
    response.writeHead(reply.status, reply.headers);
    if (reply.kind === 'whole') {
      response.end(reply.body);
      return;
    }
    response.flushHeaders();
    const active = { entry, response };
    open.add(active);
    response.once('close', () => {
      open.delete(active);
      if (entry.end === null) entry.end = stopping ? 'server-stopped' : 'client-closed';
    });
    for (const write of reply.writes) {
      if (response.destroyed) return;
      const ok = await new Promise<boolean>(resolve => response.write(write.text, error => resolve(!error)));
      if (!ok) return;
      if (!write.counted) continue;
      entry.raw?.chunks.push(write.text);
      entry.framesWritten++;
    }
    // `null` = hold: stay open until the client closes or the service stops.
    if (reply.end === null || response.destroyed) return;
    entry.end = reply.end;
    response.end();
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(error => {
      logReplayServiceError(requests, request.method ?? '', request.url ?? '', error);
      response.destroy();
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port ?? 0, config.host ?? '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  const url = `http://${address.address}:${address.port}`;
  return {
    url,
    baseUrl: scriptId => `${url}/s/${encodeURIComponent(scriptId)}/v1`,
    requests,
    openCount: () => open.size,
    async whenIdle(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (open.size > 0) {
        if (Date.now() > deadline) return false;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return true;
    },
    async stop() {
      stopping = true;
      for (const { entry, response } of open) {
        if (entry.end === null) entry.end = 'server-stopped';
        response.destroy();
      }
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

/**
 * CLI for out-of-process callers (X7 Tauri recorder, X1 Electron driver):
 *   node host/e2e/streaming/wave0/llm-service.ts [--port N] [--host 127.0.0.1] [--provider-script FILE]
 * Prints one JSON line `{"url":...,"pid":...,"scripts":[...]}` to stdout; stops on SIGTERM/SIGINT
 * or when stdin closes, then prints `{"stopped":true,"requests":[...]}` (the full request log).
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const port = arg('--port');
  const sidecar = arg('--provider-script');
  const extraScripts = sidecar === undefined ? {} : providerScripts(JSON.parse(await readFile(sidecar, 'utf8')));
  const service = await startLlmService({ host: arg('--host'), port: port === undefined ? 0 : Number(port), extraScripts });
  process.stdout.write(`${JSON.stringify({ url: service.url, pid: process.pid, scripts: [...Object.keys(scripts), ...Object.keys(extraScripts)] })}\n`);
  let done = false;
  const shutdown = async () => {
    if (done) return;
    done = true;
    await service.stop();
    process.stdout.write(`${JSON.stringify({ stopped: true, requests: service.requests })}\n`);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdin.on('end', shutdown);
  process.stdin.resume();
}
