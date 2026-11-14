import type { TranslationHost } from '../../plugin-runtime/contracts/translationHost.js';
import type { StreamFailure, TranslationEvent, TranslationRequest, TranslationResponse } from '../../plugin-runtime/contracts/translation.js';
import { buildSegments, buildSegmentPrompt, buildSystemPrompt, buildUserPrompt, charLength, detectSourceLang, isWhitespace, tailChars, trim, trimEnd } from './policy.js';

export class TranslationFailure extends Error implements StreamFailure {
  constructor(message: string, public code: string, public retriable: boolean) { super(message); }
}

export async function runTranslation(request: TranslationRequest, host: TranslationHost): Promise<TranslationResponse | null> {
  let failure: StreamFailure | undefined;
  try { return await runInner(request, host); }
  catch (error) {
    if (isFailure(error)) failure = error;
    else failure = { message: error instanceof Error ? error.message : String(error), code: 'internal', retriable: false };
    throw new TranslationFailure(failure.message, failure.code, failure.retriable);
  } finally {
    await host.cleanup();
    if (failure) host.emit({ type: 'error', message: failure.message, code: failure.code, retriable: failure.retriable });
  }
}

function isFailure(error: unknown): error is StreamFailure {
  return typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    && 'code' in error && typeof error.code === 'string' && 'retriable' in error && typeof error.retriable === 'boolean';
}

async function runInner(request: TranslationRequest, host: TranslationHost): Promise<TranslationResponse | null> {
  if (!trim(request.text)) throw new TranslationFailure('翻译文本不能为空', 'empty_text', false);
  const chars = charLength(request.text);
  if (chars > 100_000) throw new TranslationFailure(`翻译文本过长（当前 ${chars} 字符，最大 100000 字符）`, 'text_too_long', false);
  const detected = request.src_lang === 'auto' ? detectSourceLang(request.text) : undefined;
  const system = buildSystemPrompt(request);
  await host.open();
  const segments = chars >= 4000 ? buildSegments(request.text, 2000) : [{ content: request.text, separator: '' }];
  const total = segments.length;
  const segmented = total > 1;
  const parts: Array<{ text: string; separator: string }> = [];
  let charCount = 0;
  let wordCount = 0;
  let lastNonwhite = false;
  let first = true;
  const deadline = host.nowMs() + 600_000;
  function emitChunk(chunk: string, index: number, detectedLang?: string): void {
    for (const ch of chunk) {
      charCount++;
      const nonwhite = !isWhitespace(ch);
      if (nonwhite && !lastNonwhite) wordCount++;
      lastNonwhite = nonwhite;
    }
    const event: TranslationEvent = { type: 'data', chunk, delta: chunk, char_count: charCount, word_count: wordCount };
    if (detectedLang !== undefined) event.detected_lang = detectedLang;
    if (segmented) { event.segment_index = index + 1; event.segment_total = total; }
    host.emit(event);
  }
  for (let index = 0; index < total; index++) {
    if (await host.pendingCancel()) { host.emit({ type: 'cancelled' }); return null; }
    const segment = segments[index];
    const previous = parts.length ? tailChars(trimEnd(parts[parts.length - 1].text), 240) : undefined;
    const user = segmented ? buildSegmentPrompt(request, segment.content, index + 1, total, previous || undefined)
      : buildUserPrompt(request, request.text);
    let attempt = 0;
    let translated = '';
    for (;;) {
      attempt++;
      const remaining = Math.max(0, deadline - host.nowMs());
      if (!remaining) throw new TranslationFailure('翻译总时长超限，请缩短文本或稍后重试', 'timeout_total', true);
      let accumulated = '';
      let failure: StreamFailure;
      try {
        const status = await host.stream({ system_prompt: system, user_prompt: user, timeout_ms: remaining }, (chunk) => {
          accumulated += chunk;
          emitChunk(chunk, index, first ? detected : undefined);
          first = false;
        });
        if (status === 'cancelled') { host.emit({ type: 'cancelled' }); return null; }
        if (status === 'completed' && trim(accumulated)) { translated = accumulated; break; }
        failure = status === 'completed'
          ? new TranslationFailure('翻译服务返回空结果，请重试', 'empty_result', true)
          : new TranslationFailure('翻译流式响应异常中断，结果不完整。请检查网络连接后重试。', 'stream_incomplete', true);
      } catch (error) {
        if (!isFailure(error)) throw error;
        failure = error;
      }
      if (!failure.retriable || accumulated !== '' || attempt >= 2 || host.nowMs() >= deadline) throw failure;
      await host.sleep(800);
    }
    parts.push({ text: translated, separator: segment.separator });
    if (segmented && index + 1 < total && segment.separator) emitChunk(segment.separator, index);
  }
  const text = segmented ? parts.map((part, i) => trimEnd(part.text) + (i + 1 < total ? part.separator : '')).join('')
    : parts[0]?.text ?? '';
  const createdAt = host.timestamp();
  const complete: TranslationEvent = { type: 'complete', id: request.session_id, translated_text: text, created_at: createdAt };
  if (detected !== undefined) complete.detected_lang = detected;
  host.emit(complete);
  return { id: request.session_id, translated_text: text, created_at: createdAt, session_id: request.session_id };
}
