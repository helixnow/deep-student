/**
 * 内置脚本：G3 模拟服务（wave0/llm-service.ts）与进程内回放的缺省脚本表。脚本 id 是 URL 的一部分，
 * 场景只通过公开的 ApiConfig（`baseUrl`）选择行为。
 */
import { directiveRound } from './directive.ts';
import type { ReplayDerivedScript, ReplayFrame, ReplayRoundScript } from './wire.ts';

const usage = (prompt: number, completion: number): ReplayFrame =>
  ({ usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } });

export const LLM_REPLAY_SCRIPTS = {
  'success.answer': { description: 'two content chunks, finish=stop, usage, [DONE]', rounds: [
    { kind: 'sse', end: 'done', frames: [{ content: '固定' }, { content: '回答' }, { finish: 'stop' }, usage(7, 3)] },
  ] },
  'success.thinking': { description: 'reasoning then content, reasoning_tokens=2, [DONE]', rounds: [
    { kind: 'sse', end: 'done', frames: [{ reasoning: '先分析' }, { content: '再回答' }, { finish: 'stop' },
      { usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 2 } } }] },
  ] },
  'success.empty': { description: 'no content, finish=stop, usage, [DONE] (an empty answer / empty transcript)', rounds: [
    { kind: 'sse', end: 'done', frames: [{ finish: 'stop' }, usage(7, 0)] },
  ] },
  'error.eof-after-partial': { description: 'one content chunk then EOF without finish or [DONE]', rounds: [
    { kind: 'sse', end: 'eof', frames: [{ content: '部分回答' }] },
  ] },
  'error.http-500': { description: 'HTTP 500 before any stream byte', rounds: [
    { kind: 'http-error', status: 500, body: '{"error":{"message":"x5 deterministic upstream failure","type":"server_error"}}' },
  ] },
  'interrupt.hold-after-partial': { description: 'one content chunk, then the response stays open until the client closes it (user cancel)', rounds: [
    { kind: 'sse', end: 'hold', frames: [{ content: '取消前内容' }] },
  ] },
  'tool.second-round': { description: 'round 0 calls the first offered tool; round 1 (after the tool result) answers', rounds: [
    { kind: 'sse', end: 'done', frames: [{ toolCall: { id: 'call_x5_fixed', arguments: '{"text":"hello"}' } }, { finish: 'tool_calls' }, usage(9, 3)] },
    { kind: 'sse', end: 'done', frames: [{ content: '工具结果已收到' }, { finish: 'stop' }, usage(12, 4)] },
  ] },
  'w0.directive': { description: 'chatanki W0_DIRECTIVE: tool rounds, then the final answer, derived from the last user message (directive.ts)',
    derive: directiveRound },
} satisfies Record<string, ReplayRoundScript | ReplayDerivedScript>;

export type LlmReplayScriptId = keyof typeof LLM_REPLAY_SCRIPTS;
