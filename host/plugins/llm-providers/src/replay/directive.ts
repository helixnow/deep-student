/**
 * `w0.directive` 推导脚本（host/plugins/chatanki/equivalence/README.md「确定性 LLM」）。应答只由 chat
 * 请求体推出，录制器替换进指令的运行时值（`${3}`、`${7.items.0.version}`）因此能到达工具调用参数，
 * A、A2、B 之间也不共享游标。规则（作用于解析后的请求体）：
 *
 *  1. 指令消息：文本含 `W0_DIRECTIVE ` 的最后一条 `role:"user"` 消息。文本是字符串 `content`，或按顺序
 *     拼接每个 `{type:"text"}` 片段的 `text`。前缀在这段文本里必须恰好出现一次。
 *  2. 指令：紧跟前缀、到配对的 `}` 为止的 JSON 对象（识别字符串）。其后的文本忽略：B 发送
 *     `<user_query>\n…\n</user_query>` 再接 `<injected_context>`。形状必须是
 *     `{"v":1,"rounds":[[{"id","name","arguments"},…],…],"final":…}`：不得有其他键，每轮非空，
 *     `id`/`name` 为非空字符串，`final` 为字符串，`arguments` 可以是任意 JSON 值。
 *  3. k = 指令消息之后带非空 `tool_calls` 的 assistant 消息数。
 *  4. k < rounds.length → rounds[k] 作为工具调用：index 为在该轮中的位置，id、name 原样，arguments 为
 *     `arguments` 的 JSON 文本（数字保留原写法）；k = rounds.length → 内容 `final`；k > rounds.length →
 *     409 `unscripted-round`。
 *
 * 失败是显式的 HTTP 错误，绝不猜一个应答：没有匹配的 user 消息 → 400 `no-directive`；同一消息里前缀出现
 * 两次 → 400 `ambiguous-directive`；解析不了或形状不对 → 400 `bad-directive`。请求提供的工具不参与判断
 * （与 provider-from-directives.mjs 的静态旁车相同）。会话标题请求不特殊处理：用这个脚本的场景都创建
 * 带标题的会话，不会发出标题请求。
 */
import type { ReplayDerivedRound, ReplayFrame, ReplayRound } from './wire.ts';

export const DIRECTIVE_PREFIX = 'W0_DIRECTIVE ';

export type DirectiveStep =
  | { kind: 'tools'; calls: Array<{ id: string; name: string; arguments: string }> }
  | { kind: 'final'; content: string };

export type DirectiveAnswer =
  | { ok: true; index: number; step: DirectiveStep }
  | { ok: false; index: number | null; outcome: 'no-directive' | 'ambiguous-directive' | 'bad-directive' | 'unscripted-round';
    status: number; message: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const nativeJson = JSON as typeof JSON & { rawJSON(text: string): unknown };
type SourceReviver = (key: string, value: unknown, context: { source?: string }) => unknown;
/** JSON.parse，但最短往返写法与源文本不同的数字保留源文本。 */
const parseKeepingNumbers = (text: string): unknown => (JSON.parse as (text: string, reviver: SourceReviver) => unknown)(text,
  (_key, value, context) => typeof value === 'number' && context.source !== undefined && JSON.stringify(value) !== context.source
    ? nativeJson.rawJSON(context.source) : value);

function messageText(message: Record<string, unknown>): string | null {
  const { content } = message;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content.filter((part): part is { type: 'text'; text: string } =>
    isObject(part) && part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
}

/** 从 `start` 开始的 JSON 对象的结束位置（不含），按字符串之外的括号深度；没闭合时为 -1。 */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) return i + 1;
  }
  return -1;
}

function decodeDirective(json: string): { rounds: Array<Array<{ id: string; name: string; arguments: string }>>; final: string } | string {
  let value: unknown;
  try { value = parseKeepingNumbers(json); } catch (error) { return `directive is not JSON: ${(error as Error).message}`; }
  if (!isObject(value) || Object.keys(value).sort().join(',') !== 'final,rounds,v') return 'directive keys must be exactly v, rounds, final';
  if (value.v !== 1) return 'directive v must be 1';
  if (typeof value.final !== 'string') return 'directive final must be a string';
  if (!Array.isArray(value.rounds)) return 'directive rounds must be an array';
  const rounds: Array<Array<{ id: string; name: string; arguments: string }>> = [];
  for (const [r, round] of value.rounds.entries()) {
    if (!Array.isArray(round) || round.length === 0) return `directive rounds[${r}] must be a non-empty array`;
    const calls: Array<{ id: string; name: string; arguments: string }> = [];
    for (const [c, call] of round.entries()) {
      if (!isObject(call) || Object.keys(call).sort().join(',') !== 'arguments,id,name'
        || typeof call.id !== 'string' || call.id === '' || typeof call.name !== 'string' || call.name === '') {
        return `directive rounds[${r}][${c}] must be {id, name, arguments} with non-empty id and name`;
      }
      calls.push({ id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
    }
    rounds.push(calls);
  }
  return { rounds, final: value.final };
}

/** `w0.directive` 上一个 chat 请求的应答步骤（规则见文件头）。 */
export function directiveAnswer(body: unknown): DirectiveAnswer {
  const fail = (outcome: Extract<DirectiveAnswer, { ok: false }>['outcome'], status: number, message: string, index: number | null = null): DirectiveAnswer =>
    ({ ok: false, index, outcome, status, message: `x5 llm service: w0.directive: ${message}` });
  const messages = isObject(body) && Array.isArray(body.messages) ? body.messages : [];
  let at = -1;
  let text = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isObject(message) || message.role !== 'user') continue;
    const candidate = messageText(message);
    if (candidate !== null && candidate.includes(DIRECTIVE_PREFIX)) { at = i; text = candidate; break; }
  }
  if (at < 0) return fail('no-directive', 400, `no user message contains ${JSON.stringify(DIRECTIVE_PREFIX)}`);
  const first = text.indexOf(DIRECTIVE_PREFIX);
  if (text.indexOf(DIRECTIVE_PREFIX, first + 1) >= 0) return fail('ambiguous-directive', 400, `messages[${at}] contains ${JSON.stringify(DIRECTIVE_PREFIX)} more than once`);
  const start = first + DIRECTIVE_PREFIX.length;
  const end = text[start] === '{' ? objectEnd(text, start) : -1;
  if (end < 0) return fail('bad-directive', 400, `messages[${at}]: no JSON object after the prefix`);
  const directive = decodeDirective(text.slice(start, end));
  if (typeof directive === 'string') return fail('bad-directive', 400, `messages[${at}]: ${directive}`);
  const index = messages.slice(at + 1).filter(message => isObject(message) && message.role === 'assistant'
    && Array.isArray(message.tool_calls) && message.tool_calls.length > 0).length;
  if (index < directive.rounds.length) return { ok: true, index, step: { kind: 'tools', calls: directive.rounds[index]! } };
  if (index === directive.rounds.length) return { ok: true, index, step: { kind: 'final', content: directive.final } };
  return fail('unscripted-round', 409, `${index} tool rounds answered, the directive has ${directive.rounds.length}`, index);
}

const usage = (prompt: number, completion: number): ReplayFrame =>
  ({ usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } });

/** `w0.directive` 的一轮：帧与 chatanki/equivalence/__fixtures__/provider-from-directives.mjs 逐字节一致。 */
export function directiveRound(body: unknown): ReplayDerivedRound {
  const answer = directiveAnswer(body);
  if (answer.ok === false) return answer;
  const { step } = answer;
  const round: ReplayRound = step.kind === 'tools'
    ? { kind: 'sse', end: 'done', frames: [
      ...step.calls.map((call, index): ReplayFrame => ({ toolCall: { id: call.id, name: call.name, arguments: call.arguments, index } })),
      { finish: 'tool_calls' }, usage(9, 3)] }
    : { kind: 'sse', end: 'done', frames: [{ content: step.content }, { finish: 'stop' }, usage(12, 4)] };
  return { ok: true, index: answer.index, round };
}
