/**
 * Local OpenAI-compatible LLM server for the desktop smoke (no external network).
 *
 * A test may set `fake.script` to drive multi-round tool loops (see {@link ScriptTurn}); otherwise
 * behaviour is chosen from the last user message:
 * - contains `[slow]`: streams {@link SLOW_CHUNKS} chunks, {@link SLOW_DELAY_MS} apart (cancel tests);
 * - contains `[agent]` and the request offers an `attempt_completion` tool: answers with that tool call;
 * - otherwise streams {@link REPLY_CHUNKS}.
 * Non-streaming requests get a short completion: the session-metadata prompt (`chat-pipeline/src/summary.ts`
 * `SESSION_METADATA_PROMPT`) is answered with {@link SMOKE_METADATA} as JSON, anything else with what
 * `fake.complete` returns for the prompt (raw-prompt roles such as the memory decision model) or plain text.
 * `POST /embeddings` returns one deterministic {@link EMBEDDING_DIM}-dimensional vector per input.
 * `POST /rerank` scores documents with {@link rerankScore}.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const REPLY_CHUNKS = ['你好，', '我是本地', '假模型。', ' SMOKE-REPLY-', 'OK'];
export const REPLY_TEXT = REPLY_CHUNKS.join('');
export const SLOW_CHUNKS = 200;
export const SLOW_DELAY_MS = 150;
export const AGENT_RESULT = 'SMOKE-AGENT-DONE';
export const SMOKE_METADATA = { title: '冒烟会话标题', tags: ['冒烟', '本地模型', '测试'] };
export const EMBEDDING_DIM = 64;
const METADATA_PROMPT_HEAD = 'You generate session metadata for a conversation.';

export interface RecordedRequest {
  readonly at: number;
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
  /** Set when the client disconnected before the response finished. */
  aborted: boolean;
  /** Chunks written before completion or disconnect. */
  chunksSent: number;
  finished: boolean;
}

export interface FakeLlm {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  /** Every `/chat/completions` request, streaming or not. */
  chatRequests(): RecordedRequest[];
  /** Streaming `/chat/completions` requests: one per tool-loop round. */
  streamRequests(): RecordedRequest[];
  /** Non-streaming requests carrying the session-metadata (title/tags) prompt. */
  metadataRequests(): RecordedRequest[];
  /** Non-streaming chat requests whose prompt ({@link promptText}) contains `head`. */
  completions(head: string): RecordedRequest[];
  embeddingRequests(): RecordedRequest[];
  rerankRequests(): RecordedRequest[];
  /** When set, consulted first for every streaming chat request; `undefined` falls back to the markers. */
  script: ((turn: ScriptTurn) => ScriptedReply | undefined) | null;
  /** When set, consulted for every non-metadata, non-streaming chat request; `undefined` falls back to plain text. */
  complete: ((prompt: string, body: ChatBody) => string | undefined) | null;
  close(): Promise<void>;
}

export interface ChatMessage {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

export interface ChatBody {
  model?: string;
  stream?: boolean;
  messages?: ChatMessage[];
  tools?: Array<{ function?: { name?: string } }>;
}

export interface ToolCallSpec {
  /** Suffix of an offered tool name (e.g. `qbank_batch_import`); resolved against `body.tools`. */
  tool: string;
  arguments: unknown;
  /** Call `tool` verbatim even if it was not offered (a model hallucinating a tool name). */
  unoffered?: boolean;
}

export type ScriptedReply = { text: string } | { toolCalls: ToolCallSpec[] };

export interface ScriptTurn {
  readonly body: ChatBody;
  /** Last user message text (the turn's prompt). */
  readonly user: string;
  /** Function names offered in this request. */
  readonly toolNames: string[];
  /**
   * Tool calls already made in this turn, oldest first, with their results (JSON-parsed when possible).
   * The Host replays every round of a turn as one assistant message (Rust `all_tool_results_to_messages`),
   * so rounds are not distinguishable — scripts branch on which tools were called.
   */
  readonly calls: ScriptCall[];
  /** Whether a tool whose name ends with `suffix` was already called in this turn. */
  called(suffix: string): ScriptCall | undefined;
}

export interface ScriptCall {
  readonly id: string | null;
  readonly name: string;
  readonly arguments: unknown;
  readonly result: unknown;
}

const parseJson = (text: string): unknown => {
  try { return JSON.parse(text); } catch { return text; }
};

/** Offered tool whose name ends with `suffix` (`builtin-qbank_list` / `builtin_qbank_list` / `qbank_list`). */
export function offeredTool(toolNames: readonly string[], suffix: string): string | null {
  return toolNames.find((name) => name === suffix || name.endsWith(`-${suffix}`) || name.endsWith(`_${suffix}`) || name.endsWith(`:${suffix}`)) ?? null;
}

export function toolNamesOf(body: unknown): string[] {
  return ((body as ChatBody | null)?.tools ?? []).map((t) => t.function?.name ?? '').filter((n) => n !== '');
}

function scriptTurn(body: ChatBody): ScriptTurn {
  const messages = body.messages ?? [];
  // Skills loaded mid-turn are injected as user messages after the tool result; they do not start a turn.
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.role === 'user' && !textOf(m.content).trimStart().startsWith('<skill_instructions')) lastUser = i;
  });
  const tail = messages.slice(lastUser + 1);
  const results = new Map<string, unknown>();
  for (const m of tail) if (m.role === 'tool' && m.tool_call_id) results.set(m.tool_call_id, parseJson(textOf(m.content)));
  const calls: ScriptCall[] = tail.flatMap((m) => (m.role === 'assistant' ? m.tool_calls ?? [] : [])).map((c) => ({
    id: c.id ?? null, name: c.function?.name ?? '', arguments: parseJson(c.function?.arguments ?? ''),
    result: c.id ? results.get(c.id) : undefined,
  }));
  return {
    body, user: lastUser < 0 ? '' : textOf(messages[lastUser]?.content), toolNames: toolNamesOf(body), calls,
    called: (suffix) => calls.findLast((c) => offeredTool([c.name], suffix) !== null),
  };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join('');
  }
  return '';
}

/** Every message text of a chat request, in order (raw-prompt roles send their prompt as one message). */
export function promptText(body: unknown): string {
  return ((body as ChatBody | null)?.messages ?? []).map((m) => textOf(m.content)).join('\n\n');
}

function lastUserText(body: ChatBody): string {
  const users = (body.messages ?? []).filter((m) => m.role === 'user');
  return textOf(users.at(-1)?.content);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text === '') return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(text);
      }
    });
    req.on('error', reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function chunk(id: string, model: string, delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

let callSeq = 0;
const MAX_SCRIPTED_CALLS = 30;

async function streamChat(res: ServerResponse, rec: RecordedRequest, body: ChatBody,
  script: FakeLlm['script']): Promise<void> {
  const model = body.model ?? 'fake-chat';
  const id = `chatcmpl-smoke-${Date.now()}`;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const write = (data: string) => {
    if (rec.aborted) return false;
    res.write(data);
    rec.chunksSent += 1;
    return true;
  };
  const user = lastUserText(body);
  const offersCompletion = (body.tools ?? []).some((t) => t.function?.name?.endsWith('attempt_completion'));
  write(chunk(id, model, { role: 'assistant', content: '' }));
  const turn = scriptTurn(body);
  let scripted: ScriptedReply | undefined;
  try {
    scripted = script !== null && turn.calls.length >= MAX_SCRIPTED_CALLS
      ? { text: `FAKE-LLM-RUNAWAY: ${turn.calls.length} tool calls in one turn` }
      : script?.(turn);
  } catch (error) {
    scripted = { text: `FAKE-LLM-SCRIPT-ERROR: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (scripted !== undefined && 'toolCalls' in scripted) {
    const calls = scripted.toolCalls.map((call) => ({ call, name: call.unoffered ? call.tool : offeredTool(turn.toolNames, call.tool) }));
    const missing = calls.filter((c) => c.name === null).map((c) => c.call.tool);
    if (missing.length > 0) {
      write(chunk(id, model, { content: `FAKE-LLM-TOOL-NOT-OFFERED: ${missing.join(', ')}` }));
      write(chunk(id, model, {}, 'stop'));
    } else {
      calls.forEach(({ call, name }, index) => {
        callSeq += 1;
        write(chunk(id, model, { tool_calls: [{ index, id: `call_smoke_${callSeq}`, type: 'function', function: { name, arguments: '' } }] }));
        write(chunk(id, model, { tool_calls: [{ index, function: { arguments: JSON.stringify(call.arguments) } }] }));
      });
      write(chunk(id, model, {}, 'tool_calls'));
    }
  } else if (scripted !== undefined) {
    write(chunk(id, model, { content: scripted.text }));
    write(chunk(id, model, {}, 'stop'));
  } else if (user.includes('[agent]') && offersCompletion) {
    const name = (body.tools ?? []).find((t) => t.function?.name?.endsWith('attempt_completion'))?.function?.name ?? 'attempt_completion';
    write(chunk(id, model, { tool_calls: [{ index: 0, id: 'call_smoke_1', type: 'function', function: { name, arguments: '' } }] }));
    write(chunk(id, model, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ result: AGENT_RESULT }) } }] }));
    write(chunk(id, model, {}, 'tool_calls'));
  } else if (user.includes('[slow]')) {
    for (let i = 0; i < SLOW_CHUNKS && !rec.aborted; i += 1) {
      write(chunk(id, model, { content: `片段${i} ` }));
      await sleep(SLOW_DELAY_MS);
    }
    write(chunk(id, model, {}, 'stop'));
  } else {
    for (const piece of REPLY_CHUNKS) {
      write(chunk(id, model, { content: piece }));
      await sleep(40);
    }
    write(chunk(id, model, {}, 'stop'));
  }
  write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  write('data: [DONE]\n\n');
  if (!rec.aborted) {
    res.end();
    rec.finished = true;
  }
}

const isMetadataRequest = (body: unknown): boolean => {
  const chat = body as ChatBody | null;
  return chat?.stream !== true && (chat?.messages ?? []).some((m) => textOf(m.content).trimStart().startsWith(METADATA_PROMPT_HEAD));
};

function jsonChat(res: ServerResponse, body: ChatBody, complete: FakeLlm['complete']): void {
  const content = isMetadataRequest(body) ? JSON.stringify(SMOKE_METADATA) : complete?.(promptText(body), body) ?? '冒烟标题';
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: `chatcmpl-smoke-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model ?? 'fake-chat',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  }));
}

/** Deterministic unit-length vector derived from the text, so equal inputs embed equally. */
function embed(text: string): number[] {
  const vector = Array.from({ length: EMBEDDING_DIM }, (_, i) => {
    let h = 2166136261 ^ i;
    for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
    return ((h >>> 0) % 1000) / 1000 + 0.001;
  });
  const norm = Math.hypot(...vector);
  return vector.map((v) => v / norm);
}

function embeddings(res: ServerResponse, body: unknown): void {
  const request = (body ?? {}) as { model?: string; input?: unknown };
  const inputs = Array.isArray(request.input) ? request.input.map(String) : [String(request.input ?? '')];
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    object: 'list', model: request.model ?? 'fake-embed',
    data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: embed(text) })),
    usage: { prompt_tokens: inputs.length * 8, total_tokens: inputs.length * 8 },
  }));
}

/** Score of document `index` in a `/rerank` reply; the last document ranks first. */
export const rerankScore = (index: number, count: number): number => 0.9 * (index + 1) / count;

function rerank(res: ServerResponse, body: unknown): void {
  const request = (body ?? {}) as { model?: string; documents?: unknown[] };
  const count = Array.isArray(request.documents) ? request.documents.length : 0;
  const results = Array.from({ length: count }, (_, index) => ({ index, relevance_score: rerankScore(index, count) }))
    .sort((a, b) => b.relevance_score - a.relevance_score);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ model: request.model ?? 'fake-rerank', results, usage: { tokens: count * 8 } }));
}

export async function startFakeLlm(): Promise<FakeLlm> {
  const requests: RecordedRequest[] = [];
  const fake = { script: null as FakeLlm['script'], complete: null as FakeLlm['complete'] };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const rec: RecordedRequest = {
        at: Date.now(), method: req.method ?? 'GET', path, authorization: req.headers.authorization ?? null,
        body, aborted: false, chunksSent: 0, finished: false,
      };
      requests.push(rec);
      res.on('close', () => {
        if (!rec.finished) rec.aborted = true;
      });
      if (req.method === 'GET' && path.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-chat', object: 'model', owned_by: 'smoke' }] }));
        rec.finished = true;
        return;
      }
      if (req.method === 'POST' && path.endsWith('/chat/completions')) {
        const chat = (body ?? {}) as ChatBody;
        if (chat.stream === true) await streamChat(res, rec, chat, fake.script);
        else {
          jsonChat(res, chat, fake.complete);
          rec.finished = true;
        }
        return;
      }
      if (req.method === 'POST' && path.endsWith('/embeddings')) {
        embeddings(res, body);
        rec.finished = true;
        return;
      }
      if (req.method === 'POST' && path.endsWith('/rerank')) {
        rerank(res, body);
        rec.finished = true;
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `fake-llm: no route for ${req.method} ${path}` } }));
      rec.finished = true;
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    chatRequests: () => requests.filter((r) => r.path.endsWith('/chat/completions')),
    streamRequests: () => requests.filter((r) => r.path.endsWith('/chat/completions') && (r.body as ChatBody | null)?.stream === true),
    metadataRequests: () => requests.filter((r) => r.path.endsWith('/chat/completions') && isMetadataRequest(r.body)),
    completions: (head) => requests.filter((r) => r.path.endsWith('/chat/completions')
      && (r.body as ChatBody | null)?.stream !== true && promptText(r.body).includes(head)),
    embeddingRequests: () => requests.filter((r) => r.path.endsWith('/embeddings')),
    rerankRequests: () => requests.filter((r) => r.path.endsWith('/rerank')),
    get script() { return fake.script; },
    set script(value) { fake.script = value; },
    get complete() { return fake.complete; },
    set complete(value) { fake.complete = value; },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
