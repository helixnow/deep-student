/**
 * llm-replay：进程内的确定性 LLM 回放 provider。对外是一个 `fetch`，按脚本直接构造 `Response`，
 * 不开端口、不触网；请求日志、`whenIdle`、`stop` 与 G3 模拟服务（llm-service.ts）的 `LlmService` 同形，
 * 可以直接替换它交给 wave0 runner。
 *
 * 应答由 answer.ts 给出，与 HTTP 服务是同一份代码：路由（chat completions、embeddings、音频转写）、
 * 轮次与旁车游标、推导脚本、各类失败的状态码与响应体、日志里每个字段。这里只负责传输：服务端“写出”在建
 * 响应时一次记完（HTTP 服务也是不等客户端读就写完），响应体再按宏任务逐块交给读取方；`hold` 保持打开，
 * 直到客户端中止、取消读取或 `stop()`。
 * 传输层的差别：日志 `raw.requestHeaders` 是应用给的请求头（Headers 规范化为小写），没有 undici 自动补的
 * 连接类请求头；响应头也没有 `date`、`connection`、`transfer-encoding`。
 */
import {
  answerReplayRequest, logReplayServiceError, type ReplayRequestEnd, type ReplayRequestLog, type ReplayState, type ReplayWrite,
} from './answer.ts';
import { LLM_REPLAY_SCRIPTS } from './builtin.ts';
import { NULL_BODY_STATUS, validateReplayScripts } from './scripts.ts';
import type { ReplayScript } from './wire.ts';

export type { ReplayRequestEnd, ReplayRequestLog } from './answer.ts';

/** 回放源。`.invalid` 是保留顶级域（RFC 6761），未挂载回放时这类请求照常交给真实客户端，也解析不到任何主机。 */
export const LLM_REPLAY_ORIGIN = 'http://llm-replay.invalid';

/** 请求是否发往回放源。 */
export function isLlmReplayUrl(input: Parameters<typeof fetch>[0]): boolean {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return URL.canParse(href) && new URL(href).origin === LLM_REPLAY_ORIGIN;
}

export interface LlmReplayConfig {
  /** 脚本表；缺省为内置脚本 {@link LLM_REPLAY_SCRIPTS}（与 G3 模拟服务相同，含推导脚本 `w0.directive`）。 */
  scripts?: Record<string, ReplayScript>;
  /** 追加脚本（例如 `providerSidecarScripts(<套件>.provider.json)`），id 不得与 `scripts` 重名。 */
  extraScripts?: Record<string, ReplayScript>;
}

export interface LlmReplayService {
  /** 恒为 {@link LLM_REPLAY_ORIGIN}。 */
  readonly url: string;
  /** 某脚本对应的 ApiConfig.baseUrl（`apiProtocol` 为 OpenAI chat completions）。 */
  baseUrl(scriptId: string): string;
  /** 按到达顺序的请求日志，失败、取消、未匹配的请求都在。 */
  readonly requests: readonly ReplayRequestLog[];
  /** 仍打开的流（hold）。 */
  openCount(): number;
  /** 没有打开的流时为 true；超过 `timeoutMs` 仍有则为 false（这是发现，不是重试）。 */
  whenIdle(timeoutMs: number): Promise<boolean>;
  /** 中止所有打开的流（`end: 'server-stopped'`）；之后的请求以网络错误失败且不记日志。 */
  stop(): Promise<void>;
  fetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response>;
}

/** 载入时取得的计时器：测试里装了假计时器也不会让回放的流停住。 */
const timer = globalThis.setTimeout.bind(globalThis);
const tick = () => new Promise<void>(resolve => { timer(resolve, 0); });

interface OpenStream { entry: ReplayRequestLog; finish(end: ReplayRequestEnd, error: unknown): void }

export function createLlmReplay(config: LlmReplayConfig = {}): LlmReplayService {
  const table = validateReplayScripts(config.scripts === undefined ? LLM_REPLAY_SCRIPTS : config.scripts);
  const extra = validateReplayScripts(config.extraScripts ?? {}, 'extraScripts');
  for (const [id, script] of Object.entries(extra)) {
    if (Object.hasOwn(table, id)) throw new Error(`llm-replay: extra script ${id} shadows a script`);
    Object.defineProperty(table, id, { value: script, enumerable: true });
  }
  const state: ReplayState = { table, cursors: new Map(), requests: [] };
  const open = new Set<OpenStream>();
  let stopped = false;

  /**
   * 状态与头立即给出；`writes` 在这里一次记入日志（`counted` 的计入 framesWritten），读取方每个宏任务拿到一块。
   * `end` 为 null 表示 hold：交完数据后保持打开。
   */
  const streamed = (entry: ReplayRequestLog, signal: AbortSignal, status: number, headers: Record<string, string>,
    writes: readonly ReplayWrite[], end: ReplayRequestEnd | null): Response => {
    const encoder = new TextEncoder();
    const pending = writes.map(write => encoder.encode(write.text));
    for (const write of writes) {
      if (!write.counted) continue;
      entry.raw?.chunks.push(write.text);
      entry.framesWritten++;
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let settled = false;
    let wake: (() => void) | null = null;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      return true;
    };
    const stream: OpenStream = {
      entry,
      finish(how, error) {
        if (!open.delete(stream)) return;
        if (entry.end === null) entry.end = how;
        if (settle() && error !== null) controller.error(error);
        wake?.();
      },
    };
    // 与 fetch 一致：读完之前被中止，响应体以中止原因出错。
    const onAbort = () => {
      if (open.has(stream)) stream.finish('client-closed', signal.reason);
      else if (settle()) controller.error(signal.reason);
    };
    if (end === null) open.add(stream);
    else entry.end = end;
    signal.addEventListener('abort', onAbort, { once: true });
    const body = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
      async pull(c) {
        await tick();
        if (settled) return;
        const next = pending.shift();
        if (next !== undefined) { c.enqueue(next); return; }
        if (end !== null) { settle(); c.close(); return; }
        await new Promise<void>(resolve => { wake = resolve; if (!open.has(stream)) resolve(); });
      },
      cancel() { stream.finish('client-closed', null); settle(); },
    });
    return new Response(NULL_BODY_STATUS.has(status) ? null : body, { status, headers });
  };

  const handle = async (request: Request): Promise<Response> => {
    const signal = request.signal;
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (signal.aborted) throw signal.reason;
    const url = new URL(request.url);
    const { entry, reply } = answerReplayRequest(state, { method: request.method, path: url.pathname + url.search,
      contentType: request.headers.get('content-type'), bytes, rawHeaders: () => [...request.headers].flat() });
    if (reply.kind === 'whole') return new Response(NULL_BODY_STATUS.has(reply.status) ? null : reply.body, { status: reply.status, headers: reply.headers });
    return streamed(entry, signal, reply.status, reply.headers, reply.writes, reply.end);
  };

  return {
    url: LLM_REPLAY_ORIGIN,
    baseUrl: scriptId => `${LLM_REPLAY_ORIGIN}/s/${encodeURIComponent(scriptId)}/v1`,
    requests: state.requests,
    openCount: () => open.size,
    async whenIdle(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (open.size > 0) {
        if (Date.now() > deadline) return false;
        await new Promise(resolve => { timer(resolve, 5); });
      }
      return true;
    },
    async stop() {
      stopped = true;
      for (const stream of [...open]) stream.finish('server-stopped', new TypeError('terminated'));
    },
    async fetch(input, init) {
      if (stopped) throw new TypeError('fetch failed', { cause: new Error('llm-replay: stopped') });
      const request = new Request(input, init);
      if (request.signal.aborted) throw request.signal.reason;
      try {
        return await handle(request);
      } catch (error) {
        if (request.signal.aborted && error === request.signal.reason) throw error;
        // 回放自身出错：记一条 service-error，并像连接被对端断开一样以网络错误失败，绝不转去真实网络。
        const url = new URL(request.url);
        logReplayServiceError(state.requests, request.method, url.pathname + url.search, error);
        throw new TypeError('fetch failed', { cause: error });
      }
    },
  };
}
