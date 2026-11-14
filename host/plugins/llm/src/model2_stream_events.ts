/** Event-dispatch phase of model2_pipeline.rs. Network/termination/usage are outer phases. */
import type { LlmStreamEvents, LlmStreamHooks, Model2EventCollector, Model2EventOptions,
  Model2EventSnapshot, Model2ToolCall } from '../api.ts';
import type { JsonValue, StreamEvent } from '../../llm-providers/api.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';
import { StreamHookRegistry } from './stream_hooks.ts';
import { convertOpenaiToolCall } from './tool_calls.ts';
import { numberedWebSearchSources } from './replay.ts';
import { providerStreamFailureMessage } from './stream_validation.ts';
import { logDebug, logError, logInfo, logWarn } from './logging.ts';

type JsonObject = { [key: string]: JsonValue };
const object = (value: JsonValue | undefined): JsonObject | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
const text = (value: JsonValue | undefined): string | null => typeof value === 'string' ? value : null;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

class Collector implements Model2EventCollector {
  private readonly options: Model2EventOptions;
  private readonly registry: StreamHookRegistry;
  private readonly pending = new Map<number, { id: string; name: string; args: string }>();
  private readonly state: Model2EventSnapshot = { content: '', reasoning: '', chunkCount: 0, usage: null,
    toolCalls: [], terminalSuccess: false, terminalFailure: null, ended: false };
  constructor(options: Model2EventOptions, registry: StreamHookRegistry) { this.options = options; this.registry = registry; }
  private hook(): LlmStreamHooks | null { return this.registry.getHook(this.options.streamEvent) as LlmStreamHooks | null; }
  private emit(suffix: string, value: JsonValue, failure: string, severity: 'warn' | 'error' = 'warn'): void {
    try { this.options.sink.emit(this.options.streamEvent + suffix, value); }
    catch (error) { (severity === 'warn' ? logWarn : logError)(`${failure}: ${message(error)}`); }
  }
  snapshot(): Model2EventSnapshot { return structuredClone(this.state); }
  get ended(): boolean { return this.state.ended; }
  dispatch(events: readonly StreamEvent[]): void {
    for (const event of events) {
      const hook = this.hook();
      switch (event.type) {
        case 'ContentChunk':
          this.state.content += event.value; this.state.chunkCount++;
          if (hook !== null) hook.onContentChunk?.(event.value);
          else this.emit('', { content: event.value, is_complete: false,
            chunk_id: `${this.options.requestId}_chunk_${this.state.chunkCount}` }, '发送内容块失败');
          break;
        case 'ReasoningChunk':
          this.state.reasoning += event.value;
          if (hook !== null) hook.onReasoningChunk?.(event.value);
          else this.emit('_reasoning', { content: event.value, is_complete: false,
            chunk_id: `${this.options.requestId}_reasoning_chunk_${this.state.chunkCount}` }, '发送思维链块失败');
          break;
        case 'ResponseReasoningItem': hook?.onResponseReasoningItem?.(event.value); break;
        case 'ThoughtSignature':
          logDebug(`[ThoughtSignature] 收到 Gemini 3 思维签名: 长度=${utf8ByteLength(event.value)}`);
          hook?.onThoughtSignature?.(event.value); break;
        case 'ToolCall': this.toolDelta(event.value); break;
        case 'Usage':
          this.state.usage = structuredClone(event.value);
          this.emit('_usage', event.value, '发送用量事件失败', 'error');
          this.hook()?.onUsage?.(event.value); break;
        case 'WebSearchCall':
          hook?.onWebSearch?.(event.value);
          this.emit('_web_search', { sources: numberedWebSearchSources(event.value),
            stage: text(object(event.value)?.stage) ?? 'completed', tool_name: 'web_search' }, '发送服务端 web_search 事件失败');
          break;
        case 'SafetyBlocked': {
          this.state.terminalFailure = providerStreamFailureMessage(event.value, this.options.requireTerminalSuccess, this.options.isCodex);
          this.state.ended = true;
          this.emit('_safety_blocked', event.value, '发送安全阻断事件失败', 'error');
          const provider = object(event.value)?.type === 'provider_error';
          this.emit('_error', { type: provider ? 'provider_error' : 'safety_error',
            message: provider ? 'LLM provider reported a stream failure' : 'Request blocked due to safety policies',
            details: event.value }, '发送安全错误事件失败', 'error');
          break;
        }
        case 'Done':
          this.state.terminalSuccess = true; this.state.ended = true;
          if (this.pending.size) logDebug('工具调用序列结束');
          this.finalize(false); return;
      }
    }
  }

  private toolDelta(value: JsonValue): void {
    const call = object(value), rawIndex = call?.index;
    if (typeof rawIndex !== 'number' || !Number.isInteger(rawIndex) || rawIndex < -0x8000_0000_0000_0000 || rawIndex >= 0x8000_0000_0000_0000) return;
    const index = rawIndex | 0;
    const fn = object(call?.function);
    const id = rustTrim(text(call?.id) ?? ''), name = rustTrim(text(fn?.name) ?? '');
    const rawArgs = fn?.arguments;
    const args = typeof rawArgs === 'string' ? rawArgs : rawArgs == null ? null : JSON.stringify(rawArgs);
    if (id !== '') {
      if (rawArgs != null && typeof rawArgs !== 'string') logWarn(`[llm_manager] 工具调用 arguments 不是字符串而是 JSON 值 (tool=${name || 'unknown'}), 自动序列化`);
      this.pending.set(index, { id, name: name || 'unknown', args: args ?? '' });
      this.hook()?.onToolCallStart?.(id, name || 'unknown');
      logInfo('🔧');
    } else {
      const previous = this.pending.get(index);
      if (previous !== undefined) {
        if (args === null) return;
        if (previous.name === 'unknown' && name !== '') previous.name = name;
        previous.args += args;
        this.hook()?.onToolCallArgsDelta?.(previous.id, args);
        if (utf8ByteLength(previous.args) % 200 < utf8ByteLength(args)) logInfo('/');
      } else if (name !== '') {
        const syntheticId = `stream_call_${index}`;
        this.pending.set(index, { id: syntheticId, name, args: args ?? '' });
        this.hook()?.onToolCallStart?.(syntheticId, name);
      }
    }
  }
  finishPending(): void {
    if (!this.pending.size) return;
    logInfo(`[llm_manager] Finalizing ${this.pending.size} pending tool calls after stream end (no Done event received)`);
    this.finalize(true);
  }
  complete(wasCancelled: boolean, enableChainOfThought: boolean): void {
    if (this.state.toolCalls.length) logInfo(`[llm_manager] Notifying hooks of ${this.state.toolCalls.length} tool calls`);
    for (const call of this.state.toolCalls) this.hook()?.onToolCall?.({ role: 'assistant', content: '', tool_call: call });
    if (wasCancelled) return;
    const hook = this.hook();
    if (hook !== null) {
      hook.onComplete?.(this.state.content, this.state.reasoning || null);
      logDebug(`通过 hook 处理完成信号，内容长度: ${utf8ByteLength(this.state.content)}`);
    } else this.emit('', { content: this.state.content, is_complete: true,
      chunk_id: `${this.options.requestId}_final_chunk_${this.state.chunkCount + 1}` }, '发送最终主内容完成信号失败', 'error');
    if (enableChainOfThought && this.state.reasoning !== '') {
      this.emit('_reasoning', { content: this.state.reasoning, is_complete: true,
        chunk_id: `${this.options.requestId}_reasoning_final_chunk_${this.state.chunkCount + 1}` }, '发送思维链完成信号失败', 'error');
    } else if (enableChainOfThought) logWarn('[思维链总结] 启用了思维链但 reasoning_content 为空!');
  }
  private finalize(fallback: boolean): void {
    for (const { id, name, args } of this.pending.values()) {
      const length = utf8ByteLength(args);
      if (rustTrim(name) === '' || name === 'unknown') {
        logWarn(`[llm_manager] 跳过 malformed tool call ${fallback ? 'fallback finalize' : 'finalize'}: id='${id}', name='${name}', args_len=${length}`);
        continue;
      }
      let result: Model2ToolCall;
      try {
        const converted = convertOpenaiToolCall({ id, type: 'function', function: { name, arguments: args } });
        result = { id: converted.toolCallId, tool_name: converted.toolName, args_json: converted.argsJson };
      } catch (error) {
        logWarn(`[llm_manager] 工具调用解析失败${fallback ? '(fallback)' : ''}: ${message(error)}, args_len=${length}`);
        result = { id, tool_name: name, args_json: { _truncation_error: true,
          _error_message: `工具调用参数 JSON 被截断（已生成 ${length} 字符但未完成）。原因：模型输出 token 达到上限。`, _args_len: length } };
      }
      this.state.toolCalls.push(result);
    }
    if (this.state.toolCalls.length) (fallback ? logInfo : logDebug)(fallback
      ? `[llm_manager] Fallback tool call finalize completed: ${JSON.stringify(this.state.toolCalls.map(call => call.tool_name))}`
      : `工具调用聚合完成: ${JSON.stringify(this.state.toolCalls.map(call => call.tool_name))}`);
    this.pending.clear();
  }
}

export function createStreamEventsService(): LlmStreamEvents {
  const registry = new StreamHookRegistry();
  return {
    registerStreamHooks: (event, hooks) => registry.registerStreamHooks(event, hooks),
    unregisterStreamHooks: event => registry.unregisterStreamHooks(event),
    unregisterStreamHooksIfOwner: (event, owner) => registry.unregisterStreamHooksIfOwner(event, owner),
    create: options => new Collector(options, registry),
  };
}
