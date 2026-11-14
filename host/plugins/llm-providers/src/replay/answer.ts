/**
 * 回放应答的唯一实现：一个请求（方法、路径、content-type、正文字节）→ 请求日志项 + 应答。不涉及传输，
 * 进程内回放（service.ts，`fetch`）和 G3 模拟服务（wave0/llm-service.ts，`node:http`）各自只负责把
 * 应答写出去，所以两边的状态码、内容类型、响应字节与请求日志逐项相同。
 *
 * 路由：`POST /s/<脚本 id>/v1/` 之后接 `chat/completions`、`embeddings` 或 `audio/transcriptions`。
 * - chat：轮次脚本按请求体推导轮次；推导脚本由 `derive` 给出；应答脚本按到达顺序取下一条。
 * - embeddings：向量只由请求体决定（embeddings.ts），脚本可以不存在；只有第 0 轮是 HTTP 错误的轮次脚本
 *   改变应答。
 * - audio/transcriptions：先解码 multipart（transcriptions.ts），轮次脚本用第 0 轮的正文应答，应答脚本
 *   按到达顺序取下一条，推导脚本不应答这个路由（409 `unscripted-route`）。
 * 各类失败都是显式的 HTTP 错误，响应体 `{"error":{"message":…,"type":"x5_llm_service"}}`。
 *
 * 本文件及其相对导入（与 builtin.ts）属于 G3 `llm` 输入闭包（scripts/electron-migration/record/g3-inputs.mjs）：
 * 改动会让用到模拟 LLM 服务的 A 录制过期，需要重录（目前经 g3-services.mjs 的动态导入也在 `recorder` 闭包里，
 * 即全部 A 录制）。
 */
import { embeddingResponse } from './embeddings.ts';
import { decodeTranscription, transcriptionResponse } from './transcriptions.ts';
import {
  firstOfferedTool, replayCompletionJson, replayFrameJson, replayRoundIndex, replayRoundText,
  type ReplayResponseScript, type ReplayRound, type ReplayScript,
} from './wire.ts';

export type ReplayRequestEnd = 'done' | 'eof' | 'http-error' | 'client-closed' | 'server-stopped';

/** 一个请求的日志项（llm-service.ts 的 `LoggedRequest` 即此类型）。 */
export interface ReplayRequestLog {
  seq: number;
  method: string;
  path: string;
  scriptId: string | null;
  round: number | null;
  /** chat：请求的 `stream`；embeddings 与转写：false。 */
  stream: boolean | null;
  /**
   * 解析后的 JSON 请求体；不是 JSON 时为原文。转写：`{ parts }`（字段文本，或文件名、类型、大小、sha256），
   * multipart 解析不了时为原文。
   */
  body: unknown;
  /**
   * `served` | `unknown-script` | `unscripted-round` | `no-tool-offered` | `bad-json` | `not-found` | `service-error`；
   * embeddings：`bad-embedding-request` | `unknown-embedding-model`；转写：`bad-multipart` |
   * `bad-transcription-request` | `unsupported-response-format` | `unscripted-route`；
   * w0.directive：`no-directive` | `ambiguous-directive` | `bad-directive`。
   */
  outcome: string;
  status: number;
  framesWritten: number;
  /** 连接如何结束。`client-closed` 且是 hold 轮，就是取消路径。 */
  end: ReplayRequestEnd | null;
  /** 应答脚本：原始请求文本与请求头、给出的响应头与逐块写出的 chunk（不是解析后的投影）。 */
  raw?: { requestBody: string; requestHeaders: string[]; responseHeaders: Record<string, string>; chunks: string[] };
}

/** 一个回放实例的状态：脚本表、应答脚本的游标（按“脚本 × 实例”计）、请求日志。 */
export interface ReplayState {
  readonly table: Readonly<Record<string, ReplayScript>>;
  readonly cursors: Map<string, number>;
  readonly requests: ReplayRequestLog[];
}

export interface ReplayIncoming {
  method: string;
  /** 路径加查询串。 */
  path: string;
  contentType: string | null | undefined;
  bytes: Uint8Array;
  /** 原始请求头（名、值交替），只有应答脚本写日志时才取。 */
  rawHeaders(): string[];
}

/** `counted` 的写出计入 `framesWritten`（应答脚本同时记进 `raw.chunks`）；`[DONE]` 不计。 */
export interface ReplayWrite { text: string; counted: boolean }

export type ReplayReply =
  /** 一次写完；日志的 `end` 已记好。 */
  | { kind: 'whole'; status: number; headers: Record<string, string>; body: string }
  /** 先给状态与头，再逐块写出；全部写出后 `end` 记入日志，null 表示 hold（保持打开直到客户端关闭）。 */
  | { kind: 'stream'; status: number; headers: Record<string, string>; writes: ReplayWrite[]; end: 'done' | 'eof' | 'http-error' | null };

const ROUTE = /^\/s\/([^/]+)\/v1\/(chat\/completions|embeddings|audio\/transcriptions)(?:\?.*)?$/;
/** 与 Node `Buffer#toString('utf8')` 相同：非法序列替换为 U+FFFD，保留开头的 BOM。 */
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * 记入日志并给出应答。日志项在任何解析之前入列：应答途中抛错（例如脚本 id 的百分号编码非法）时它以
 * not-found 留在日志里，传输层随后用 {@link logReplayServiceError} 追加一条 service-error。
 */
export function answerReplayRequest(state: ReplayState, incoming: ReplayIncoming): { entry: ReplayRequestLog; reply: ReplayReply } {
  const text = utf8.decode(incoming.bytes);
  const entry: ReplayRequestLog = { seq: state.requests.length, method: incoming.method, path: incoming.path, scriptId: null, round: null,
    stream: null, body: text, outcome: 'not-found', status: 404, framesWritten: 0, end: null };
  state.requests.push(entry);
  return { entry, reply: answer(state, incoming, entry, text) };
}

/** 应答自身出错时的日志项（随后连接以网络错误断开）。 */
export function logReplayServiceError(requests: ReplayRequestLog[], method: string, path: string, error: unknown): void {
  requests.push({ seq: requests.length, method, path, scriptId: null, round: null, stream: null, body: String(error),
    outcome: 'service-error', status: 500, framesWritten: 0, end: null });
}

function answer(state: ReplayState, incoming: ReplayIncoming, entry: ReplayRequestLog, text: string): ReplayReply {
  const whole = (status: number, contentType: string, body: string, end: 'done' | 'http-error'): ReplayReply => {
    entry.status = status; entry.end = end;
    return { kind: 'whole', status, headers: { 'content-type': contentType }, body };
  };
  const fail = (outcome: string, status: number, message: string): ReplayReply => {
    entry.outcome = outcome;
    return whole(status, 'application/json', JSON.stringify({ error: { message, type: 'x5_llm_service' } }), 'http-error');
  };
  const httpError = (round: Extract<ReplayRound, { kind: 'http-error' }>): ReplayReply => {
    entry.outcome = 'served';
    return whole(round.status, 'application/json', round.body, 'http-error');
  };
  const serve = (contentType: string, body: string): ReplayReply => {
    entry.outcome = 'served';
    return whole(200, contentType, body, 'done');
  };
  /** 应答脚本：按到达顺序给出下一条原样应答。游标在写出之前占用，取消的请求也消耗一条。 */
  const literal = (scriptId: string, script: ReplayResponseScript): ReplayReply => {
    const index = state.cursors.get(scriptId) ?? 0;
    entry.round = index;
    entry.raw = { requestBody: text, requestHeaders: incoming.rawHeaders(), responseHeaders: {}, chunks: [] };
    const scripted = script.responses[index];
    if (!scripted) return fail('unscripted-round', 409, `x5 llm service: script ${scriptId} has no response ${index}`);
    state.cursors.set(scriptId, index + 1);
    entry.outcome = 'served'; entry.status = scripted.status;
    entry.raw.responseHeaders = { ...scripted.headers };
    // `eof` 说的是 HTTP 结束；有没有 [DONE] 完全由脚本字节决定。
    return { kind: 'stream', status: scripted.status, headers: { ...scripted.headers },
      writes: scripted.chunks.map(chunk => ({ text: chunk, counted: true })), end: scripted.status >= 400 ? 'http-error' : 'eof' };
  };

  const match = ROUTE.exec(incoming.path);
  if (!match || incoming.method !== 'POST') return fail('not-found', 404, `x5 llm service: no route for ${incoming.method} ${incoming.path}`);
  const scriptId = decodeURIComponent(match[1]!);
  const route = match[2]!;
  entry.scriptId = scriptId;
  const script = Object.hasOwn(state.table, scriptId) ? state.table[scriptId] : undefined;
  if (route === 'audio/transcriptions') {
    entry.stream = false;
    const decoded = decodeTranscription(incoming.contentType, incoming.bytes);
    if (decoded.parts !== null) entry.body = { parts: decoded.parts };
    if (decoded.ok === false) return fail(decoded.outcome, decoded.status, decoded.message);
    if (!script) return fail('unknown-script', 404, `x5 llm service: unknown script ${scriptId}`);
    if ('responses' in script) return literal(scriptId, script);
    if ('derive' in script) return fail('unscripted-route', 409, `x5 llm service: script ${scriptId} does not answer audio/transcriptions`);
    entry.round = 0;
    const round = script.rounds[0];
    if (!round) return fail('unscripted-round', 409, `x5 llm service: script ${scriptId} has no round 0`);
    if (round.kind === 'http-error') return httpError(round);
    const answer = transcriptionResponse(decoded.request, replayRoundText(round));
    return serve(answer.contentType, answer.body);
  }
  try { entry.body = text ? JSON.parse(text) : null; } catch { return fail('bad-json', 400, 'x5 llm service: request body is not JSON'); }
  if (route === 'embeddings') {
    entry.stream = false;
    const first = script && 'rounds' in script ? script.rounds[0] : undefined;
    if (first?.kind === 'http-error') {
      entry.round = 0;
      return httpError(first);
    }
    const answer = embeddingResponse(entry.body);
    if (answer.ok === false) return fail(answer.outcome, answer.status, answer.message);
    return serve('application/json', JSON.stringify(answer.json));
  }
  if (!script) return fail('unknown-script', 404, `x5 llm service: unknown script ${scriptId}`);
  entry.stream = (entry.body as { stream?: unknown } | null)?.stream === true;
  if ('responses' in script) return literal(scriptId, script);
  let round: ReplayRound;
  if ('derive' in script) {
    const derived = script.derive(entry.body);
    entry.round = derived.index;
    if (derived.ok === false) return fail(derived.outcome, derived.status, derived.message);
    round = derived.round;
  } else {
    entry.round = replayRoundIndex(entry.body);
    const scripted = script.rounds[entry.round];
    if (!scripted) return fail('unscripted-round', 409, `x5 llm service: script ${scriptId} has no round ${entry.round}`);
    round = scripted;
  }
  const index = entry.round;
  if (round.kind === 'http-error') return httpError(round);
  const needsTool = round.frames.some(frame => 'toolCall' in frame && frame.toolCall.name === undefined);
  const toolName = firstOfferedTool(entry.body);
  if (needsTool && toolName === null) {
    return fail('no-tool-offered', 400, `x5 llm service: script ${scriptId} round ${index} needs a tool but the request offered none`);
  }
  const model = (entry.body as { model?: unknown } | null)?.model ?? null;
  if (!entry.stream) return serve('application/json', JSON.stringify(replayCompletionJson(round, model, toolName ?? '')));
  entry.outcome = 'served'; entry.status = 200;
  const writes = round.frames.map(frame => ({ text: `data: ${JSON.stringify(replayFrameJson(frame, model, toolName ?? ''))}\n\n`, counted: true }));
  if (round.end === 'done') writes.push({ text: 'data: [DONE]\n\n', counted: false });
  return { kind: 'stream', status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, writes,
    end: round.end === 'hold' ? null : round.end };
}
