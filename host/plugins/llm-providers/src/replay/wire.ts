/**
 * llm-replay 与 G3 模拟 LLM 服务（host/e2e/streaming/wave0/llm-service.ts）共用的脚本格式与 OpenAI
 * chat-completions 渲染。两边用同一份代码，同一脚本、同一请求体得到逐字节相同的响应。
 * - 轮次脚本：按请求体推导轮次（最后一条 user 消息之后带 `tool_calls` 的 assistant 消息数），帧渲染为
 *   固定 `id`/`created` 的 chunk，`model` 回显请求；非流式请求把同一轮折叠成一个 completion。
 * - 推导脚本：轮次由 `derive(请求体)` 直接给出（`w0.directive`）。
 * - 应答脚本：`<套件>.provider.json` 旁车，按到达顺序逐条返回原样的 status、headers、chunks。
 */

export type ReplayFrame =
  | { content: string }
  | { reasoning: string }
  /** `index` 是这一轮 tool_calls 中的位置（缺省 0）；没有 `name` 时用请求提供的第一个工具名。 */
  | { toolCall: { id: string; arguments: string; name?: string; index?: number } }
  | { finish: 'stop' | 'tool_calls' | 'length' }
  | { usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; completion_tokens_details?: { reasoning_tokens: number } } };

export type ReplayRound =
  /** `end`：`done` = `[DONE]` 后结束；`eof` = 不发 `[DONE]` 直接结束；`hold` = 保持打开直到客户端关闭。 */
  | { kind: 'sse'; frames: ReplayFrame[]; end: 'done' | 'eof' | 'hold' }
  | { kind: 'http-error'; status: number; body: string };

export interface ReplayRoundScript { description: string; rounds: ReplayRound[] }

/** 推导脚本的一轮；失败是显式的 HTTP 错误（`outcome` 记入请求日志）。 */
export type ReplayDerivedRound =
  | { ok: true; index: number; round: ReplayRound }
  | { ok: false; index: number | null; outcome: string; status: number; message: string };
export interface ReplayDerivedScript { description: string; derive(body: unknown): ReplayDerivedRound }

export interface ReplayResponse { status: number; headers: Record<string, string>; chunks: string[] }
export interface ReplayResponseScript { description: string; responses: ReplayResponse[] }

export type ReplayScript = ReplayRoundScript | ReplayDerivedScript | ReplayResponseScript;

const FIXED_ID = 'chatcmpl-x5-fixed';
const FIXED_CREATED = 1_700_000_000;

/** 最后一条 user 消息之后、带非空 `tool_calls` 的 assistant 消息数。 */
export function replayRoundIndex(body: unknown): number {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return 0;
  let lastUser = -1;
  messages.forEach((message, index) => { if ((message as { role?: unknown } | null)?.role === 'user') lastUser = index; });
  return messages.slice(lastUser + 1).filter(message => {
    const m = message as { role?: unknown; tool_calls?: unknown } | null;
    return m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
  }).length;
}

/** 请求里第一个工具的函数名；没有工具时为 null。 */
export function firstOfferedTool(body: unknown): string | null {
  const tools = (body as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const name = (tools[0] as { function?: { name?: unknown } } | null)?.function?.name;
  return typeof name === 'string' ? name : null;
}

function chunk(model: unknown, delta: Record<string, unknown>, finish: string | null) {
  return { id: FIXED_ID, object: 'chat.completion.chunk', created: FIXED_CREATED, model, choices: [{ index: 0, delta, finish_reason: finish }] };
}

/** 一帧的 SSE `data:` 载荷（未含 `data: ` 前缀与空行）。 */
export function replayFrameJson(frame: ReplayFrame, model: unknown, toolName: string): unknown {
  if ('content' in frame) return chunk(model, { content: frame.content }, null);
  if ('reasoning' in frame) return chunk(model, { reasoning_content: frame.reasoning }, null);
  if ('toolCall' in frame) {
    return chunk(model, { tool_calls: [{ index: frame.toolCall.index ?? 0, id: frame.toolCall.id, type: 'function',
      function: { name: frame.toolCall.name ?? toolName, arguments: frame.toolCall.arguments } }] }, null);
  }
  if ('finish' in frame) return chunk(model, {}, frame.finish);
  return { id: FIXED_ID, object: 'chat.completion.chunk', created: FIXED_CREATED, model, choices: [], usage: frame.usage };
}

/** 非流式请求：同一轮折叠成一个 `chat.completion`。 */
export function replayCompletionJson(round: Extract<ReplayRound, { kind: 'sse' }>, model: unknown, toolName: string): unknown {
  let content = '';
  let reasoning = '';
  const toolCalls: unknown[] = [];
  let finish: string | null = null;
  let usage: unknown;
  for (const frame of round.frames) {
    if ('content' in frame) content += frame.content;
    else if ('reasoning' in frame) reasoning += frame.reasoning;
    else if ('toolCall' in frame) {
      toolCalls.push({ id: frame.toolCall.id, type: 'function', function: { name: frame.toolCall.name ?? toolName, arguments: frame.toolCall.arguments } });
    } else if ('finish' in frame) finish = frame.finish;
    else usage = frame.usage;
  }
  const message: Record<string, unknown> = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  return { id: FIXED_ID, object: 'chat.completion', created: FIXED_CREATED, model,
    choices: [{ index: 0, message, finish_reason: finish }], ...(usage ? { usage } : {}) };
}

/** 一个 `sse` 轮会流出的正文，用于不是 chat completion 的应答（转写）。 */
export function replayRoundText(round: Extract<ReplayRound, { kind: 'sse' }>): string {
  return round.frames.map(frame => ('content' in frame ? frame.content : '')).join('');
}
