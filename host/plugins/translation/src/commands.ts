/**
 * 翻译命令实现（移植 `dstu-tutor/src/translation/{mod,pipeline,candidates,chat_popover}.rs`）。
 *
 * 事件名、payload 形状、错误文案、取消事件名与 Rust 完全一致；模型解析经由
 * `llm@1`（`getTranslationModelConfig` 优先翻译模型、回退 model2）。
 */
import { CommandError } from '../../../platform/errors/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import type { LLMManager } from '../../llm/api.ts';
import type {
  ChatTranslationEvent, ChatTranslationRequest, StreamStatus, TranslationCandidate,
  TranslationCandidatesEvent, TranslationCandidatesResponse, TranslationEvent, TranslationHost,
  TranslationRequest, TranslationResponse, StreamFailure,
} from '../api.ts';
import { runTranslation } from './engine.ts';
import { logInfo, logWarn } from './logging.ts';
import {
  buildSystemPrompt, buildUserPrompt, charLength, detectSourceLang, langFullName, tailChars, trim,
  trimEnd,
} from './policy.ts';
import {
  defaultStreamOptions, streamTranslate, StreamError, type StreamOptions, type StreamRuntime,
  type TransportControl,
} from './transport.ts';

export const MAX_CANDIDATES = 3;
export const MAX_CANDIDATE_TEXT_CHARS = 8_000;
export const MAX_CHAT_SOURCE_CHARS = 8_000;
export const MAX_CONTEXT_CHARS = 200;
const POPOVER_IDLE_TIMEOUT_MS = 30_000;
const POPOVER_TOTAL_TIMEOUT_MS = 120_000;
const POPOVER_MAX_REQUEST_ATTEMPTS = 2;
const POPOVER_TEMPERATURE = 0.2;

export interface EventSink {
  emit(channel: string, payload: unknown): void;
}

/** Rust `window.emit`（translation/events.rs:56-154）：Tauri 2 `Window::emit` 是全局广播（target Any）。 */
function emitEvent(sink: EventSink, channel: string, payload: unknown): void {
  try {
    sink.emit(channel, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (channel.startsWith('translation_candidates_')) logWarn(`[TranslationCandidates] 发送事件失败 (${channel}): ${message}`);
    else if (channel.startsWith('chat_translation_')) logWarn(`[ChatTranslation] 发送事件失败 (${channel}): ${message}`);
    else logWarn(`[Translation] event delivery failed: ${message}`);
  }
}

export const CANDIDATE_PROFILES = [
  {
    label: 'precise',
    temperature: 0.2,
    instruction: 'For this version: prioritize accuracy and faithfulness to the source. Keep terminology exact and stay close to the original sentence structure.',
  },
  {
    label: 'natural',
    temperature: 0.7,
    instruction: 'For this version: prioritize natural, idiomatic fluency in the target language. You may freely restructure sentences as a native writer would.',
  },
  {
    label: 'concise',
    temperature: 0.5,
    instruction: 'For this version: prefer concise, polished phrasing while preserving the full meaning. Trim redundancy where the source allows.',
  },
] as const;

export function candidatesEventName(sessionId: string): string {
  return `translation_candidates_${sessionId}`;
}
export function candidateStreamEvent(sessionId: string, index: number): string {
  return `translation_candidates_${sessionId}__c${index}`;
}
export function translationStreamEvent(sessionId: string): string {
  return `translation_stream_${sessionId}`;
}
export function chatTranslationEvent(requestId: string): string {
  return `chat_translation_${requestId}`;
}

function messageOf(error: unknown): string {
  if (error instanceof CommandError) {
    const value = error.value;
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value !== null && 'message' in value) {
      return String((value as { message: unknown }).message);
    }
  }
  return error instanceof Error ? error.message : String(error);
}

class LazyTranslationHost implements TranslationHost {
  readonly sessionId: string;
  readonly streamEvent: string;
  private readonly llm: LLMManager;
  private readonly events: EventSink;
  private readonly started = performance.now();
  private readonly control: TransportControl;
  private readonly runtime: StreamRuntime | undefined;
  private modelPromise: Promise<{ config: Awaited<ReturnType<LLMManager['getTranslationModelConfig']>>; apiKey: string }> | null = null;

  constructor(llm: LLMManager, events: EventSink, sessionId: string, runtime?: StreamRuntime) {
    this.llm = llm;
    this.events = events;
    this.sessionId = sessionId;
    this.streamEvent = translationStreamEvent(sessionId);
    this.control = llm;
    this.runtime = runtime;
  }

  private model(): Promise<{ config: Awaited<ReturnType<LLMManager['getTranslationModelConfig']>>; apiKey: string }> {
    this.modelPromise ??= (async () => {
      const config = await this.llm.getTranslationModelConfig();
      const apiKey = await this.llm.decryptApiKey(config.apiKey);
      return { config, apiKey };
    })();
    return this.modelPromise;
  }

  async open(): Promise<void> {
    try {
      await this.model();
    } catch (error) {
      throw new StreamError(messageOf(error), 'internal', false);
    }
  }

  async stream(
    request: { system_prompt: string; user_prompt: string; timeout_ms: number },
    onChunk: (chunk: string) => void,
  ): Promise<StreamStatus> {
    const { config, apiKey } = await this.model();
    const options: StreamOptions = {
      ...defaultStreamOptions(),
      totalTimeoutMs: request.timeout_ms,
    };
    try {
      return await streamTranslate({
        config, apiKey, systemPrompt: request.system_prompt, userPrompt: request.user_prompt,
        streamEvent: this.streamEvent, control: this.control, onChunk, options,
        runtime: this.runtime,
      });
    } catch (error) {
      if (error instanceof StreamError) {
        throw new StreamError(error.message, error.code, error.retriable);
      }
      throw new StreamError(messageOf(error), 'internal', false);
    }
  }

  pendingCancel(): Promise<boolean> {
    return this.llm.consumePendingCancel(this.streamEvent);
  }
  async cleanup(): Promise<void> {
    await this.llm.clearCancelArtifacts(this.streamEvent);
  }
  sleep(ms: number): Promise<void> {
    return this.runtime?.sleep(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }
  nowMs(): number {
    return performance.now() - this.started;
  }
  timestamp(): string {
    return toRfc3339();
  }
  emit(event: TranslationEvent): void {
    emitEvent(this.events, this.streamEvent, event);
  }
}

export interface TranslationCommands {
  translateTextStream(request: TranslationRequest): Promise<TranslationResponse | null>;
  translateTextCandidates(
    request: TranslationRequest, numCandidates: number | null,
  ): Promise<TranslationCandidatesResponse>;
  cancelTranslationCandidates(sessionId: string): Promise<boolean>;
  streamChatTranslationAligned(request: ChatTranslationRequest): Promise<null>;
  streamChatTranslationPlain(request: ChatTranslationRequest): Promise<null>;
}

export function createTranslationCommands(
  llm: LLMManager, events: EventSink, runtime?: StreamRuntime,
): TranslationCommands {
  return {
    async translateTextStream(request) {
      const host = new LazyTranslationHost(llm, events, request.session_id, runtime);
      const response = await runTranslation(request, host).catch((error: unknown) => {
        if (error instanceof StreamError || (error as StreamFailure).code !== undefined) {
          throw new CommandError(AppError.llm(error instanceof Error ? error.message : String(error)));
        }
        throw error;
      });
      return response;
    },

    async translateTextCandidates(request, numCandidates) {
      if (trim(request.session_id) === '') {
        throw new CommandError(AppError.validation('session_id 不能为空'));
      }
      if (trim(request.text) === '') {
        throw new CommandError(AppError.validation('翻译文本不能为空'));
      }
      const textChars = charLength(request.text);
      if (textChars > MAX_CANDIDATE_TEXT_CHARS) {
        throw new CommandError(AppError.validation(
          `多候选翻译文本过长（${textChars} 字符，最大 ${MAX_CANDIDATE_TEXT_CHARS}）`,
        ));
      }
      const count = Math.min(Math.max(numCandidates ?? 2, 1), MAX_CANDIDATES);
      const sessionId = request.session_id;
      logInfo(`[TranslationCandidates] start session=${sessionId} src=${request.src_lang} tgt=${request.tgt_lang} chars=${textChars} n=${count}`);
      const channel = candidatesEventName(sessionId);
      const emit = (payload: TranslationCandidatesEvent): void => {
        emitEvent(events, channel, payload);
      };
      const detectedLang = request.src_lang === 'auto' ? detectSourceLang(request.text) : undefined;
      let config;
      try {
        config = await llm.getTranslationModelConfig();
      } catch (error) {
        const message = `翻译模型未配置：${messageOf(error)}`;
        emit({ type: 'error', message, code: 'model_not_configured' } satisfies TranslationCandidatesEvent);
        throw new CommandError(AppError.llm(message));
      }
      let apiKey: string;
      try {
        apiKey = await llm.decryptApiKey(config.apiKey);
      } catch (error) {
        const message = `API 密钥解密失败：${messageOf(error)}`;
        emit({ type: 'error', message, code: 'api_key_error' } satisfies TranslationCandidatesEvent);
        throw new CommandError(AppError.llm(message));
      }
      const baseSystem = buildSystemPrompt(request);
      const userPrompt = buildUserPrompt(request, request.text);
      const results = await Promise.all(
        Array.from({ length: count }, async (_unused, index) => {
          const profile = CANDIDATE_PROFILES[index]!;
          const streamEvent = candidateStreamEvent(sessionId, index);
          let accumulated = '';
          let status: StreamStatus;
          let failure: StreamFailure | undefined;
          try {
            status = await streamTranslate({
              config,
              apiKey,
              systemPrompt: `${baseSystem}\n\n${profile.instruction}`,
              userPrompt,
              streamEvent,
              control: llm,
              options: { temperature: profile.temperature },
              runtime,
              onChunk: (chunk) => {
                accumulated += chunk;
                emit({
                  type: 'candidate_data', candidate_index: index, label: profile.label, delta: chunk,
                } satisfies TranslationCandidatesEvent);
              },
            });
          } catch (error) {
            status = 'incomplete';
            failure = error instanceof StreamError
              ? error
              : new StreamError(messageOf(error), 'internal', false);
          }
          await llm.clearCancelArtifacts(streamEvent);
          if (status === 'completed') {
            if (trim(accumulated) === '') {
              const message = '翻译服务返回空结果';
              emit({
                type: 'candidate_error', candidate_index: index, label: profile.label,
                message, code: 'empty_result',
              } satisfies TranslationCandidatesEvent);
              return { index, label: profile.label, kind: 'failed' as const, message, code: 'empty_result' };
            }
            emit({
              type: 'candidate_complete', candidate_index: index, label: profile.label, text: accumulated,
            } satisfies TranslationCandidatesEvent);
            return { index, label: profile.label, kind: 'done' as const, text: accumulated };
          }
          if (status === 'cancelled') {
            return { index, label: profile.label, kind: 'cancelled' as const };
          }
          const message = failure?.message ?? '候选译文流式响应异常中断，结果不完整';
          const code = failure?.code ?? 'stream_incomplete';
          emit({
            type: 'candidate_error', candidate_index: index, label: profile.label, message, code,
          } satisfies TranslationCandidatesEvent);
          return { index, label: profile.label, kind: 'failed' as const, message, code };
        }),
      );
      const candidates: TranslationCandidate[] = [];
      let cancelled = false;
      let successCount = 0;
      let firstFailure: { message: string; code?: string | null } | null = null;
      for (const result of results) {
        if (result.kind === 'done') {
          successCount++;
          candidates.push({ index: result.index, label: result.label, text: result.text, error: null });
        } else if (result.kind === 'failed') {
          firstFailure ??= { message: result.message, code: result.code };
          candidates.push({ index: result.index, label: result.label, text: '', error: result.message });
        } else {
          cancelled = true;
        }
      }
      candidates.sort((left, right) => left.index - right.index);
      const createdAt = toRfc3339();
      if (cancelled) {
        emit({ type: 'cancelled' } satisfies TranslationCandidatesEvent);
        return {
          session_id: sessionId, candidates, detected_lang: detectedLang ?? null,
          cancelled: true, created_at: createdAt,
        };
      }
      if (successCount === 0) {
        const failure = firstFailure ?? { message: '多候选翻译失败，请重试', code: null };
        emit({
          type: 'error', message: failure.message, code: failure.code,
        } satisfies TranslationCandidatesEvent);
        throw new CommandError(AppError.llm(failure.message));
      }
      emit({
        type: 'complete', candidates, detected_lang: detectedLang ?? null,
      } satisfies TranslationCandidatesEvent);
      return {
        session_id: sessionId, candidates, detected_lang: detectedLang ?? null,
        cancelled: false, created_at: createdAt,
      };
    },

    async cancelTranslationCandidates(sessionId) {
      for (let index = 0; index < MAX_CANDIDATES; index++) {
        await llm.requestCancelStream(candidateStreamEvent(sessionId, index));
      }
      return true;
    },

    streamChatTranslationAligned: (request) =>
      runChatTranslation(request, 'aligned', llm, events, runtime),
    streamChatTranslationPlain: (request) =>
      runChatTranslation(request, 'plain', llm, events, runtime),
  };
}

function truncateContext(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = trim(value);
  if (text === '') return '';
  return charLength(text) > MAX_CONTEXT_CHARS ? Array.from(text).slice(0, MAX_CONTEXT_CHARS).join('') : text;
}

export function buildAlignedPrompts(request: ChatTranslationRequest): { system: string; user: string } {
  const sourceName = langFullName(request.src_lang);
  const targetName = langFullName(request.tgt_lang);
  const before = truncateContext(request.context_before);
  const after = truncateContext(request.context_after);
  const system = `You are a professional translator. Translate text from ${sourceName} to ${targetName}.\n\n`
    + 'Output rules:\n'
    + '- Output one JSON object per line. No markdown fences, no commentary, no preamble.\n'
    + '- Each object: {"src":"...","tgt":"..."}\n'
    + '- Concatenating all "src" fields must reproduce the source text exactly (including whitespace and punctuation).\n'
    + '- Break the source into natural phrase-level chunks (noun phrases, verb phrases, clauses). Aim for 3-8 segments depending on length.\n'
    + '- When you finish all segments, end with one final line: {"done":true}\n'
    + '- Do NOT translate the context. Use it only to choose the right meaning of ambiguous words.';
  let user = '';
  if (before !== '' || after !== '') {
    user += 'Context (do NOT translate, for disambiguation only):\n';
    user += before + '«' + request.source + '»' + after + '\n\n';
  }
  user += 'Source to translate:\n' + request.source;
  return { system, user };
}

export function buildPlainPrompts(request: ChatTranslationRequest): { system: string; user: string } {
  const sourceName = langFullName(request.src_lang);
  const targetName = langFullName(request.tgt_lang);
  const before = truncateContext(request.context_before);
  const after = truncateContext(request.context_after);
  const system = `You are a professional translator. Translate text from ${sourceName} to ${targetName}.\n\n`
    + 'Output rules:\n'
    + '- Output ONLY the translation. No source text, no commentary, no markdown.\n'
    + "- Preserve the source's tone, formatting cues (line breaks, punctuation), and proper nouns.\n"
    + '- Use the surrounding context (if provided) only to disambiguate words; do not translate the context itself.';
  let user = '';
  if (before !== '' || after !== '') {
    user += 'Context (do NOT translate):\n';
    user += before + '«' + request.source + '»' + after + '\n\n';
  }
  user += 'Source to translate:\n' + request.source;
  return { system, user };
}

export function popoverStreamOptions(): StreamOptions {
  return {
    temperature: POPOVER_TEMPERATURE,
    maxTokens: null,
    idleTimeoutMs: POPOVER_IDLE_TIMEOUT_MS,
    totalTimeoutMs: POPOVER_TOTAL_TIMEOUT_MS,
    maxRequestAttempts: POPOVER_MAX_REQUEST_ATTEMPTS,
    enableThinking: false,
  };
}

async function runChatTranslation(
  request: ChatTranslationRequest, mode: 'aligned' | 'plain', llm: LLMManager,
  events: EventSink, runtime?: StreamRuntime,
): Promise<null> {
  if (trim(request.request_id) === '') throw new CommandError(AppError.validation('request_id 不能为空'));
  if (trim(request.source) === '') throw new CommandError(AppError.validation('待翻译文本为空'));
  const sourceChars = charLength(request.source);
  if (sourceChars > MAX_CHAT_SOURCE_CHARS) {
    throw new CommandError(AppError.validation(
      `聊天翻译文本过长（${sourceChars} 字符，最大 ${MAX_CHAT_SOURCE_CHARS}）`,
    ));
  }
  const eventName = chatTranslationEvent(request.request_id);
  logInfo(`[ChatTranslation] start mode=${mode === 'aligned' ? 'Aligned' : 'Plain'} src=${request.src_lang} tgt=${request.tgt_lang} chars=${sourceChars} event=${eventName}`);
  const emit = (payload: ChatTranslationEvent): void => {
    emitEvent(events, eventName, payload);
  };
  let config;
  try {
    config = await llm.getTranslationModelConfig();
  } catch (error) {
    const message = `翻译模型未配置：${messageOf(error)}`;
    emit({ type: 'error', message });
    throw new CommandError(AppError.llm(message));
  }
  let apiKey: string;
  try {
    apiKey = await llm.decryptApiKey(config.apiKey);
  } catch (error) {
    const message = `API 密钥解密失败：${messageOf(error)}`;
    emit({ type: 'error', message });
    throw new CommandError(AppError.llm(message));
  }
  const prompts = mode === 'aligned' ? buildAlignedPrompts(request) : buildPlainPrompts(request);
  let accumulatedChars = 0;
  let status: StreamStatus;
  let failure: StreamError | undefined;
  try {
    status = await streamTranslate({
      config, apiKey, systemPrompt: prompts.system, userPrompt: prompts.user,
      streamEvent: eventName, control: llm, options: popoverStreamOptions(), runtime,
      onChunk: (chunk) => {
        accumulatedChars += charLength(chunk);
        emit({ type: 'chunk', delta: chunk });
      },
    });
  } catch (error) {
    status = 'incomplete';
    failure = error instanceof StreamError
      ? error
      : new StreamError(messageOf(error), 'internal', false);
  }
  if (status === 'completed') {
    if (accumulatedChars === 0) {
      const message = '翻译服务返回空结果，请重试。';
      emit({ type: 'error', message });
      throw new CommandError(AppError.llm(message));
    }
    emit({ type: 'complete' });
    return null;
  }
  if (status === 'cancelled') {
    emit({ type: 'cancelled' });
    return null;
  }
  const message = failure?.message ?? '翻译流式响应异常中断，结果不完整。请重试。';
  emit({ type: 'error', message });
  throw new CommandError(AppError.llm(message));
}

/** chat_popover.rs 的 `truncate_context` 供测试使用。 */
export { truncateContext as truncateChatContext, tailChars };
