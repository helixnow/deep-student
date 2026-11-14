/**
 * llm-replay 脚本表的校验与 `<套件>.provider.json` 旁车读取。格式与渲染见 wire.ts。
 */
import type { ReplayDerivedRound, ReplayFrame, ReplayResponse, ReplayResponseScript, ReplayRound, ReplayScript } from './wire.ts';

const FINISH = new Set(['stop', 'tool_calls', 'length']);
const END = new Set(['done', 'eof', 'hold']);
/** `Response` 不允许带响应体的状态码。 */
export const NULL_BODY_STATUS = new Set([204, 205, 304]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isStatus = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 200 && value <= 599;
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));

function validFrame(frame: unknown): frame is ReplayFrame {
  if (!isObject(frame) || Object.keys(frame).length !== 1) return false;
  if ('content' in frame) return typeof frame.content === 'string';
  if ('reasoning' in frame) return typeof frame.reasoning === 'string';
  if ('finish' in frame) return typeof frame.finish === 'string' && FINISH.has(frame.finish);
  if ('toolCall' in frame) {
    const call = frame.toolCall;
    return isObject(call) && hasOnly(call, ['id', 'arguments', 'name', 'index']) && typeof call.id === 'string'
      && typeof call.arguments === 'string' && (call.name === undefined || typeof call.name === 'string')
      && (call.index === undefined || isCount(call.index));
  }
  if ('usage' in frame) {
    const usage = frame.usage;
    if (!isObject(usage) || !hasOnly(usage, ['prompt_tokens', 'completion_tokens', 'total_tokens', 'completion_tokens_details'])) return false;
    const details = usage.completion_tokens_details;
    return isCount(usage.prompt_tokens) && isCount(usage.completion_tokens) && isCount(usage.total_tokens)
      && (details === undefined || (isObject(details) && hasOnly(details, ['reasoning_tokens']) && isCount(details.reasoning_tokens)));
  }
  return false;
}

function validRound(round: unknown): round is ReplayRound {
  if (!isObject(round)) return false;
  if (round.kind === 'http-error') return hasOnly(round, ['kind', 'status', 'body']) && isStatus(round.status) && typeof round.body === 'string';
  return round.kind === 'sse' && hasOnly(round, ['kind', 'frames', 'end']) && Array.isArray(round.frames)
    && round.frames.every(validFrame) && typeof round.end === 'string' && END.has(round.end);
}

function validDerived(derived: unknown): derived is ReplayDerivedRound {
  if (!isObject(derived)) return false;
  if (derived.ok === true) return hasOnly(derived, ['ok', 'index', 'round']) && isCount(derived.index) && validRound(derived.round);
  return derived.ok === false && hasOnly(derived, ['ok', 'index', 'outcome', 'status', 'message'])
    && (derived.index === null || isCount(derived.index)) && typeof derived.outcome === 'string' && derived.outcome !== ''
    && isStatus(derived.status) && typeof derived.message === 'string';
}

function validResponse(response: unknown): response is ReplayResponse {
  return isObject(response) && isStatus(response.status) && isObject(response.headers)
    && Object.values(response.headers).every(value => typeof value === 'string')
    && Array.isArray(response.chunks) && response.chunks.every(chunk => typeof chunk === 'string')
    && (!NULL_BODY_STATUS.has(response.status) || response.chunks.length === 0);
}

function copyResponse(response: ReplayResponse): ReplayResponse {
  return { status: response.status, headers: Object.fromEntries(Object.entries(response.headers)), chunks: response.chunks.slice() };
}

/**
 * 校验并深拷贝一张脚本表；任一脚本不合法即抛错（挂载时失败，不在请求时才暴露）。推导脚本的 `derive`
 * 按引用保留：它必须只由请求体决定应答，不读时钟、随机数或外部状态。
 */
export function validateReplayScripts(value: unknown, label = 'scripts'): Record<string, ReplayScript> {
  if (!isObject(value)) throw new Error(`llm-replay: ${label} must be an object of scripts`);
  const table: Record<string, ReplayScript> = {};
  for (const [id, script] of Object.entries(value)) {
    if (!isObject(script) || typeof script.description !== 'string') throw new Error(`llm-replay: ${label}.${id} needs a description`);
    const kinds = ['rounds', 'responses', 'derive'].filter(key => key in script);
    let copy: ReplayScript;
    if (kinds.length !== 1) {
      throw new Error(`llm-replay: ${label}.${id} needs exactly one of rounds / responses / derive`);
    } else if (kinds[0] === 'rounds') {
      if (!Array.isArray(script.rounds) || script.rounds.length === 0) throw new Error(`llm-replay: ${label}.${id} needs rounds`);
      const bad = script.rounds.findIndex(round => !validRound(round));
      if (bad >= 0) throw new Error(`llm-replay: invalid round ${label}.${id}[${bad}]`);
      copy = { description: script.description, rounds: structuredClone(script.rounds as ReplayRound[]) };
    } else if (kinds[0] === 'responses') {
      if (!Array.isArray(script.responses) || script.responses.length === 0) throw new Error(`llm-replay: ${label}.${id} needs responses`);
      const bad = script.responses.findIndex(response => !validResponse(response));
      if (bad >= 0) throw new Error(`llm-replay: invalid response ${label}.${id}[${bad}]`);
      copy = { description: script.description, responses: (script.responses as ReplayResponse[]).map(copyResponse) };
    } else {
      const derive = script.derive;
      if (typeof derive !== 'function') throw new Error(`llm-replay: ${label}.${id} derive must be a function`);
      copy = { description: script.description, derive: body => {
        const derived: unknown = derive(body);
        if (!validDerived(derived)) throw new Error(`llm-replay: ${label}.${id} derive returned an invalid round`);
        return derived;
      } };
    }
    Object.defineProperty(table, id, { value: copy, enumerable: true });
  }
  return table;
}

/**
 * 读取 `<套件>.provider.json` 旁车（与 llm-service.ts `providerScripts` 同一格式与规则）：
 * 顶层 `note` 字符串是说明，其余每个键是脚本 id，值为非空的 `{status, headers, chunks}` 数组。
 */
export function providerSidecarScripts(value: unknown): Record<string, ReplayResponseScript> {
  if (!isObject(value)) throw new Error('llm-replay provider sidecar: expected an object');
  const result: Record<string, ReplayResponseScript> = {};
  for (const [id, responses] of Object.entries(value)) {
    if (id === 'note' && typeof responses === 'string') continue;
    if (!Array.isArray(responses) || responses.length === 0) throw new Error(`llm-replay provider sidecar: ${id} needs responses`);
    const bad = responses.findIndex(response => !validResponse(response));
    if (bad >= 0) throw new Error(`llm-replay provider sidecar: invalid response ${id}[${bad}]`);
    Object.defineProperty(result, id, {
      value: { description: `provider sidecar: ${id}`, responses: (responses as ReplayResponse[]).map(copyResponse) }, enumerable: true,
    });
  }
  return result;
}
