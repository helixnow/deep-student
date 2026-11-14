// X5 wait semantics (host/e2e/streaming/wave0/runner.ts matches/waitFor) over the G3
// event record shape `{event, payloadRaw}`, shared by the A and B runners. Spec keys (all
// given keys must hold; at least one of event / channel / channelPrefix):
//   event          X5 name: payload.eventType or "<type>:<phase>"; "a|b" lists alternatives
//   channel        exact event name, e.g. "backup-job-progress", "mcp-stdio-${2}-message"; "a|b" lists alternatives
//   channelPrefix  event name prefix (X5)
//   payload        { "dot.path": value | [alternatives] }: exact JSON equality per path
//   jsonrpcId      payload.message (JSON-RPC text, MCP stdio) carries this id
//   messageId / variantId   chat sidecar shape (chat-pipeline/equivalence/README.md): payload field equals
//   sessionId      chat sidecar shape: the channel is `${channelPrefix}${sessionId}` (chat_v2_session_<id>)
// Only events recorded after `since` count: an event that arrived before the step's invoke
// never satisfies its wait (two sends in one MCP session, a second backup job).
import { parseExact, stringifyExact } from './json.mjs';

export const WAIT_DEADLINE_MS = 15_000;
/**
 * Default X5 mock LLM port (g3-services startScenarioServices `llmPort`, g3-run-b runScenarioB `llmPort`).
 * G3 takes keep it, so `${llm.baseUrl}` resolves to identical input bytes on A1, A2 and B; scenarios
 * read the address only through `${llm.baseUrl}` / `${provider.url}`. Tests outside a worker
 * namespace pass 0.
 */
export const LLM_PORT = 47110;
const KEYS = ['event', 'channel', 'channelPrefix', 'payload', 'jsonrpcId', 'messageId', 'variantId', 'sessionId'];
const isRaw = value => value !== null && typeof value === 'object' && JSON.isRawJSON(value);
const scalar = value => value === null || ['string', 'boolean', 'number', 'bigint'].includes(typeof value) || isRaw(value);
const same = (actual, expected) => actual !== undefined && stringifyExact(actual) === stringifyExact(expected);

/** Throws on unknown keys or malformed matchers; placeholders inside strings are resolved later. */
export function validateWaitSpec(spec, label = 'wait') {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`${label}: a wait is an object`);
  const unknown = Object.keys(spec).filter(key => !KEYS.includes(key));
  if (unknown.length) throw new Error(`${label}: unknown wait key(s) ${unknown.join(', ')} (known: ${KEYS.join(', ')})`);
  for (const key of ['event', 'channel', 'channelPrefix', 'messageId', 'variantId', 'sessionId']) {
    if (spec[key] !== undefined && (typeof spec[key] !== 'string' || !spec[key])) throw new Error(`${label}: ${key} must be a non-empty string`);
  }
  if (spec.sessionId !== undefined && spec.channelPrefix === undefined) throw new Error(`${label}: sessionId needs channelPrefix (the channel is prefix + session id)`);
  for (const key of ['event', 'channel']) if (spec[key]?.split('|').some(name => !name)) throw new Error(`${label}: empty alternative in ${key} "${spec[key]}"`);
  if (spec.payload !== undefined) {
    if (!spec.payload || typeof spec.payload !== 'object' || Array.isArray(spec.payload) || isRaw(spec.payload) || !Object.keys(spec.payload).length) {
      throw new Error(`${label}: payload must be a non-empty object of dot paths`);
    }
    for (const [path, expected] of Object.entries(spec.payload)) {
      if (path.split('.').some(segment => !segment)) throw new Error(`${label}: payload path "${path}" has an empty segment`);
      const list = Array.isArray(expected) ? expected : [expected];
      if (!list.length || !list.every(scalar)) throw new Error(`${label}: payload.${path} must be a scalar or a non-empty list of scalars`);
    }
  }
  if (spec.jsonrpcId !== undefined && !(typeof spec.jsonrpcId === 'string' || typeof spec.jsonrpcId === 'number' || typeof spec.jsonrpcId === 'bigint' || isRaw(spec.jsonrpcId))) {
    throw new Error(`${label}: jsonrpcId must be a string or a number`);
  }
  if (spec.event === undefined && spec.channel === undefined && spec.channelPrefix === undefined) throw new Error(`${label}: needs event, channel or channelPrefix`);
  return spec;
}

function at(value, path) {
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || isRaw(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

export function eventMatches(spec, event) {
  if (spec.channel !== undefined && !spec.channel.split('|').includes(event.event)) return false;
  if (spec.channelPrefix !== undefined && !event.event.startsWith(spec.channelPrefix)) return false;
  if (spec.sessionId !== undefined && event.event !== `${spec.channelPrefix}${spec.sessionId}`) return false;
  let payload;
  try { payload = parseExact(event.payloadRaw); } catch { return false; }
  if (spec.event !== undefined) {
    const names = new Set(spec.event.split('|'));
    if (!names.has(payload?.eventType) && !names.has(`${String(payload?.type)}:${String(payload?.phase)}`)) return false;
  }
  for (const key of ['messageId', 'variantId']) if (spec[key] !== undefined && payload?.[key] !== spec[key]) return false;
  for (const [path, expected] of Object.entries(spec.payload ?? {})) {
    const value = at(payload, path);
    if (!(Array.isArray(expected) ? expected : [expected]).some(alternative => same(value, alternative))) return false;
  }
  if (spec.jsonrpcId !== undefined) {
    let message = payload?.message;
    if (typeof message === 'string') { try { message = parseExact(message); } catch { return false; } }
    if (!same(at(message, 'id'), spec.jsonrpcId)) return false;
  }
  return true;
}

/**
 * Poll the recorded events (from index `since`) until one matches and resolve with the first
 * match (scenario-v0 `${wait.N…}` reads its payload); a deadline is a recording failure, not a result.
 */
export async function waitForEvent(spec, events, label, { since = 0 } = {}) {
  validateWaitSpec(spec, label);
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  for (;;) {
    const recorded = events();
    const matched = recorded.slice(since).find(event => eventMatches(spec, event));
    if (matched) return matched;
    if (Date.now() > deadline) {
      throw new Error(`${label}: wait for ${stringifyExact(spec)} exceeded ${WAIT_DEADLINE_MS}ms; ${recorded.length} events recorded, ${Math.max(0, recorded.length - since)} after the anchor`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
