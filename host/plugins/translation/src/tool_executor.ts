/**
 * Chat V2 translation domain tools (`src/chat_v2/tools/translation_executor.rs`).
 *
 * `translate_text` drives the streaming translation pipeline and keeps the
 * complete result in a bounded, process-local cache. Tool output is limited to
 * a Unicode-safe preview so long translations do not inflate chat history.
 * `translation_result_read` pages through a cached (possibly partial) result
 * without consuming it. `translation_save` is the explicit persistence step: a
 * cached result is consumed only after VFS persistence succeeds, and stale
 * claims become reclaimable so a crashed save can be retried instead of
 * poisoning the reference forever.
 *
 * The executor talks to the same seams the Rust code does: a `TranslationRunner`
 * (the streaming pipeline, which consumes `llm` through `../../llm/api.ts`) and
 * `vfs@1`'s shared `VfsDatabase` handle plus the per-call L11 translation owner.
 * The caller supplies both in TranslationToolContext; central roster composition
 * remains separate from this domain executor.
 */
import type { AgentToolCall, AgentToolResultInfo, ToolConcurrency, ToolSensitivity } from '../../../kernel/agent-api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { strip_tool_namespace } from '../../../platform/errors/api.ts';
import { translationToDstuNode, type DstuNode, type VfsDatabase } from '../../vfs/portable.ts';
import type { TranslationRepository, VfsTranslation, JsonValue } from '../../vfs-repos/api.ts';
import type { TranslationRequest, TranslationResponse } from '../api.ts';
import { charLength, trim } from './policy.ts';
import { logWarn } from './logging.ts';
import { MAX_PIPELINE_SEGMENT_CHARS, MAX_TOOL_TEXT_FIELD_CHARS, TranslationToolFailure, ensureNotCancelled,
  parseTranslateArgs, parseTranslationResultReadArgs, parseTranslationSaveArgs, translatedOutputLimit,
  translationErrorValue, translationFailure, unicodePreview, type TranslateArgs, type TranslationErrorPayload,
  type TranslationSaveArgs } from './tool_args.ts';
import { splitTranslationText } from './tool_segments.ts';
import { TRANSLATION_RESULT_TTL_MS, withTranslationCache, type CachedTranslationMeta } from './tool_result_cache.ts';
import { buildPersistedMetadata, persistTranslation, persistTranslationMetadata, resolveSaveSource,
  type ResolvedTranslation, type ResolveSaveResult, type TranslationMetadataOwner,
  type TranslationPersistenceOwner } from './tool_save.ts';

export * from './tool_args.ts';
export * from './tool_segments.ts';
export * from './tool_result_cache.ts';
export * from './tool_save.ts';

export const TRANSLATE_TEXT_TOOL = 'translate_text';
export const TRANSLATION_RESULT_READ_TOOL = 'translation_result_read';
export const TRANSLATION_SAVE_TOOL = 'translation_save';

export interface TranslationRunner {
  run(request: TranslationRequest, signal?: AbortSignal): Promise<TranslationResponse | null>;
}

export interface TranslateProgress {
  completedSegments: number;
  segmentCount: number;
  translatedChars: number;
}

/** Dependency seam for the executor (Rust `ExecutionContext` fields it uses). */
export interface TranslationToolContext {
  sessionId: string;
  isCancelled(): boolean;
  signal?: AbortSignal | null;
  runner?: TranslationRunner | null;
  /** Rust DEPENDENCY_UNAVAILABLE message naming the missing dependency when `runner` is absent. */
  runnerUnavailable?: string | null;
  vfs?: Pick<VfsDatabase, 'getConnSafe'> | null;
  /** Per-call L11 owner, paired with vfs; never stored in a module-global binder. */
  vfsTranslations?: TranslationPersistenceOwner | null;
  emitProgress?(progress: TranslateProgress): void;
  emitWatchCreated?(node: DstuNode): void;
}

export interface PartialTranslationState {
  sessionId: string;
  text: string;
  segments: readonly string[];
  completedSegments: number;
  translated: string;
  args: TranslateArgs;
}

/**
 * Checkpoint a multi-segment run so a failure after segment k returns the k
 * completed segments instead of discarding paid work.
 */
export function checkpointFailure(
  code: string,
  message: string,
  hint: string,
  retryable: boolean,
  state: PartialTranslationState,
  nowMs: number = Date.now(),
): TranslationToolFailure {
  const payload: TranslationErrorPayload & { partial?: Record<string, unknown> } =
    translationErrorValue(code, message, hint, retryable);
  if (state.completedSegments === 0) return new TranslationToolFailure(payload);
  const completedSource = state.segments.slice(0, state.completedSegments).join('');
  const completedSourceChars = charLength(completedSource);
  const translatedChars = charLength(state.translated);
  const [translatedPreview] = unicodePreview(state.translated, MAX_TOOL_TEXT_FIELD_CHARS);
  const partial: Record<string, unknown> = {
    partial: true,
    completed_segments: state.completedSegments,
    segment_count: state.segments.length,
    failed_segment_index: state.completedSegments + 1,
    completed_source_chars: completedSourceChars,
    translated_chars: translatedChars,
    translated_preview: translatedPreview,
    resume_hint: `The first ${completedSourceChars} source characters are already translated. To resume, call translate_text again with the remaining source text (from character offset ${completedSourceChars}). The partial result can be read with translation_result_read or saved with translation_save; it covers only the completed segments.`,
  };
  try {
    const resultId = withTranslationCache(cache => cache.insertAt({
      ownerSessionId: state.sessionId,
      source: completedSource,
      translated: state.translated,
      sourceLang: state.args.sourceLang,
      targetLang: state.args.targetLang,
      meta: {
        formality: state.args.formality,
        domain: state.args.domain,
        terms: state.args.terms,
        promptOverride: state.args.promptOverride,
        partial: true,
        completedSegments: state.completedSegments,
        segmentCount: state.segments.length,
      },
      nowMs,
    }));
    partial.translation_result_id = resultId;
    partial.expires_in_seconds = Math.trunc(TRANSLATION_RESULT_TTL_MS / 1000);
  } catch (error) {
    if (!(error instanceof TranslationToolFailure)) throw error;
    // Same text as translation_executor.rs:928.
    logWarn(`[TranslationToolExecutor] Failed to checkpoint partial translation: ${error.message}`);
    partial.checkpoint_unavailable = true;
  }
  payload.partial = partial;
  return new TranslationToolFailure(payload);
}

/** First-match executor dispatch (`ToolExecutorRegistry::get_executor`). */
export function resolveToolExecutor<T extends { canHandle(toolName: string): boolean }>(
  executors: readonly T[],
  toolName: string,
): T | undefined {
  return executors.find(executor => executor.canHandle(toolName));
}

export class TranslationToolExecutor {
  canHandle(toolName: string): boolean {
    return [TRANSLATE_TEXT_TOOL, TRANSLATION_RESULT_READ_TOOL, TRANSLATION_SAVE_TOOL]
      .includes(strip_tool_namespace(toolName));
  }

  sensitivityLevel(toolName: string): ToolSensitivity {
    return strip_tool_namespace(toolName) === TRANSLATION_SAVE_TOOL ? 'medium' : 'low';
  }

  concurrencyClass(toolName: string): ToolConcurrency {
    return strip_tool_namespace(toolName) === TRANSLATION_RESULT_READ_TOOL ? 'read_only' : 'serial';
  }

  name(): string {
    return 'TranslationToolExecutor';
  }

  async execute(call: AgentToolCall, ctx: TranslationToolContext): Promise<AgentToolResultInfo> {
    const started = Date.now();
    let result: AgentToolResultInfo;
    try {
      const output = await this.runTool(call, ctx);
      result = { toolCallId: call.id, toolName: call.name, input: call.arguments, output, success: true };
    } catch (error) {
      if (!(error instanceof TranslationToolFailure)) throw error;
      result = {
        toolCallId: call.id,
        toolName: call.name,
        input: call.arguments,
        output: error.payload,
        success: false,
        error: error.message,
      };
    }
    result.durationMs = Date.now() - started;
    return result;
  }

  private async runTool(call: AgentToolCall, ctx: TranslationToolContext): Promise<Record<string, unknown>> {
    switch (strip_tool_namespace(call.name)) {
      case TRANSLATE_TEXT_TOOL: return this.translate(call.arguments, ctx);
      case TRANSLATION_RESULT_READ_TOOL: return this.readResult(call.arguments, ctx);
      case TRANSLATION_SAVE_TOOL: return this.save(call.arguments, ctx);
      default:
        throw translationFailure(
          'UNKNOWN_TOOL',
          `Unknown translation tool: ${strip_tool_namespace(call.name)}`,
          'Use translate_text, translation_result_read, or translation_save.',
          false,
        );
    }
  }

  async translate(argumentsValue: unknown, ctx: TranslationToolContext): Promise<Record<string, unknown>> {
    const args = parseTranslateArgs(argumentsValue);
    ensureNotCancelled(ctx.isCancelled());
    if (!ctx.runner) {
      throw translationFailure(
        'DEPENDENCY_UNAVAILABLE',
        ctx.runnerUnavailable ?? 'Translation model is not available.',
        'Retry after application initialization completes.',
        true,
      );
    }
    const segments = splitTranslationText(args.text, MAX_PIPELINE_SEGMENT_CHARS);
    const segmentCount = segments.length;
    const sourceChars = charLength(args.text);
    const outputLimit = translatedOutputLimit(sourceChars);
    const state: PartialTranslationState = {
      text: args.text, segments, sessionId: ctx.sessionId, completedSegments: 0, translated: '', args,
    };
    let translatedCharsTotal = 0;

    const TRANSLATION_CONCURRENCY = 4;
    const controller = new AbortController();
    const externalSignal = ctx.signal ?? null;
    const onExternalAbort = (): void => { controller.abort(); };
    if (externalSignal !== null) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const segmentTexts = new Array<string | undefined>(segmentCount);
    const segmentCharCounts = new Array<number>(segmentCount);
    let committed = 0;
    let nextIndex = 0;
    let failureError: Error | null = null;

    const isAborted = (): boolean => ctx.isCancelled() || controller.signal.aborted;

    const recordFailure = (error: Error): void => {
      if (failureError === null) failureError = error;
      controller.abort();
    };

    const advanceCommitted = (): void => {
      while (committed < segmentCount && segmentTexts[committed] !== undefined) {
        const textPart = segmentTexts[committed]!;
        const chars = segmentCharCounts[committed]!;
        if (translatedCharsTotal + chars > outputLimit) {
          recordFailure(checkpointFailure(
            'TRANSLATION_OUTPUT_TOO_LARGE',
            `The translation model produced more than ${outputLimit} output characters for ${sourceChars} input characters; aborting to protect memory and the result cache.`,
            'Translate a smaller source range, or check the translation model for runaway output.',
            false,
            state,
          ));
          return;
        }
        state.translated += textPart;
        translatedCharsTotal += chars;
        committed += 1;
        state.completedSegments = committed;
        ctx.emitProgress?.({
          completedSegments: state.completedSegments,
          segmentCount,
          translatedChars: translatedCharsTotal,
        });
      }
    };

    const runWorker = async (): Promise<void> => {
      while (failureError === null) {
        if (isAborted()) {
          recordFailure(checkpointFailure(
            'TRANSLATION_CANCELLED', 'Translation was cancelled.',
            'Retry when translation is still needed.', true, state,
          ));
          return;
        }
        const index = nextIndex;
        nextIndex += 1;
        if (index >= segmentCount) return;

        const request: TranslationRequest = {
          text: segments[index]!,
          src_lang: args.sourceLang,
          tgt_lang: args.targetLang,
          prompt_override: args.promptOverride ?? null,
          session_id: `chat_tool_${index + 1}_${segmentCount}_${globalThis.crypto.randomUUID().replaceAll('-', '')}`,
          formality: args.formality ?? null,
          glossary: args.terms.length > 0 ? args.terms : null,
          domain: args.domain ?? null,
        };
        let response: TranslationResponse | null;
        try {
          response = await ctx.runner!.run(request, controller.signal);
        } catch (error) {
          recordFailure(checkpointFailure(
            isAborted() ? 'TRANSLATION_CANCELLED' : 'TRANSLATION_FAILED',
            isAborted()
              ? 'Translation was cancelled.'
              : error instanceof Error ? error.message : String(error),
            isAborted()
              ? 'Retry when translation is still needed.'
              : 'Check the translation model configuration and retry.',
            true,
            state,
          ));
          return;
        }
        if (isAborted() || response === null) {
          recordFailure(checkpointFailure(
            'TRANSLATION_CANCELLED',
            response === null && !isAborted()
              ? 'The translation pipeline cancelled the request.'
              : 'Translation was cancelled.',
            'Retry when translation is still needed.',
            true,
            state,
          ));
          return;
        }
        segmentTexts[index] = response.translated_text;
        segmentCharCounts[index] = charLength(response.translated_text);
        advanceCommitted();
      }
    };

    const workerCount = Math.min(TRANSLATION_CONCURRENCY, segmentCount);
    const workersPromise = Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    workersPromise.catch(error => { void error; });

    let onAbortRace: (() => void) | undefined;
    try {
      if (externalSignal !== null) {
        const abortPromise = new Promise<never>((_resolve, reject) => {
          onAbortRace = () => {
            reject(checkpointFailure(
              'TRANSLATION_CANCELLED', 'Translation was cancelled.',
              'Retry when translation is still needed.', true, state,
            ));
          };
          if (externalSignal.aborted) onAbortRace();
          else externalSignal.addEventListener('abort', onAbortRace, { once: true });
        });
        await Promise.race([workersPromise, abortPromise]);
      } else {
        await workersPromise;
      }
    } finally {
      if (externalSignal !== null) {
        externalSignal.removeEventListener('abort', onExternalAbort);
        if (onAbortRace !== undefined) externalSignal.removeEventListener('abort', onAbortRace);
      }
    }

    if (failureError !== null) {
      throw failureError;
    }

    const translated = state.translated;
    if (trim(translated) === '') {
      throw translationFailure(
        'EMPTY_TRANSLATION',
        'The translation model returned an empty result.',
        'Retry or choose another translation model.',
        true,
      );
    }
    const translatedChars = charLength(translated);
    const [translatedPreview, translatedTruncated] = unicodePreview(translated, MAX_TOOL_TEXT_FIELD_CHARS);
    const resultId = withTranslationCache(cache => cache.insertAt({
      ownerSessionId: ctx.sessionId,
      source: args.text,
      translated,
      sourceLang: args.sourceLang,
      targetLang: args.targetLang,
      meta: {
        formality: args.formality,
        domain: args.domain,
        terms: args.terms,
        promptOverride: args.promptOverride,
        partial: false,
        completedSegments: segmentCount,
        segmentCount,
      },
      nowMs: Date.now(),
    }));
    const output: Record<string, unknown> = {
      translation_result_id: resultId,
      source_lang: args.sourceLang,
      target_lang: args.targetLang,
      translated_preview: translatedPreview,
      translated_truncated: translatedTruncated,
      source_chars: sourceChars,
      translated_chars: translatedChars,
      segment_count: segmentCount,
      formality: args.formality ?? null,
      domain: args.domain ?? null,
      terms_count: args.terms.length,
      prompt_override_applied: args.promptOverride !== undefined,
      expires_in_seconds: Math.trunc(TRANSLATION_RESULT_TTL_MS / 1000),
      consumed_after_successful_save: true,
    };
    if (translatedTruncated) {
      output.full_text_access = 'Use builtin-translation_result_read with this translation_result_id to page through the full translation, or persist it with builtin-translation_save.';
    } else {
      output.translated = translated;
    }
    return output;
  }

  readResult(argumentsValue: unknown, ctx: TranslationToolContext): Record<string, unknown> {
    const args = parseTranslationResultReadArgs(argumentsValue);
    ensureNotCancelled(ctx.isCancelled());
    const nowMs = Date.now();
    const cached = withTranslationCache(cache => cache.peekAt(args.resultId, ctx.sessionId, nowMs));
    if (cached === undefined) {
      throw translationFailure(
        'TRANSLATION_RESULT_NOT_FOUND',
        'The translation result is expired, already consumed, or belongs to another chat session.',
        'Run translate_text again, then read the new result promptly.',
        false,
      );
    }
    const chars = Array.from(cached.translated);
    const chunk = chars.slice(args.offsetChars, args.offsetChars + args.limitChars).join('');
    const chunkChars = charLength(chunk);
    const nextOffset = args.offsetChars + chunkChars;
    const hasMore = nextOffset < chars.length;
    const expiresInSeconds = Math.trunc(
      Math.max(0, TRANSLATION_RESULT_TTL_MS - (nowMs - cached.insertedAtMs)) / 1000,
    );
    const output: Record<string, unknown> = {
      translation_result_id: cached.resultId,
      source_lang: cached.sourceLang,
      target_lang: cached.targetLang,
      offset_chars: args.offsetChars,
      chunk,
      chunk_chars: chunkChars,
      total_translated_chars: chars.length,
      has_more: hasMore,
      partial: cached.meta.partial,
      expires_in_seconds: expiresInSeconds,
    };
    if (hasMore) output.next_offset_chars = nextOffset;
    if (cached.meta.partial) {
      output.completed_segments = cached.meta.completedSegments;
      output.segment_count = cached.meta.segmentCount;
    }
    return output;
  }

  save(argumentsValue: unknown, ctx: TranslationToolContext): Record<string, unknown> {
    const args = parseTranslationSaveArgs(argumentsValue);
    ensureNotCancelled(ctx.isCancelled());
    if (!ctx.vfs || !ctx.vfsTranslations) {
      throw translationFailure(
        'DEPENDENCY_UNAVAILABLE',
        'VFS database is not available.',
        'Retry after application initialization completes.',
        true,
      );
    }
    const conn = ctx.vfs.getConnSafe();
    const { resolved, cachedResultId } = resolveSaveSource(args, ctx.sessionId);
    const sourceChars = charLength(resolved.source);
    const translatedChars = charLength(resolved.translated);
    const sourceMode = cachedResultId === undefined ? 'inline' : 'cached_result';

    let translation;
    try {
      translation = persistTranslation(ctx.vfsTranslations, conn, resolved, args);
    } catch (error) {
      if (cachedResultId !== undefined) {
        withTranslationCache(cache => cache.releaseClaim(cachedResultId, ctx.sessionId));
      }
      throw error;
    }

    // Consume the cache reference immediately after successful VFS
    // persistence; a crash in between is recovered by stale-claim reclaim.
    let cachedResultConsumed = false;
    if (cachedResultId !== undefined) {
      cachedResultConsumed = withTranslationCache(cache => cache.remove(cachedResultId, ctx.sessionId));
      if (!cachedResultConsumed) logWarn(`[TranslationToolExecutor] Cached result ${cachedResultId} vanished before consumption; the VFS translation ${translation.id} was still persisted`);
    }

    const persistedMetadata = buildPersistedMetadata(resolved.meta, sourceMode);
    let metadataPersisted: boolean;
    try {
      persistTranslationMetadata(ctx.vfsTranslations, conn, translation.id, persistedMetadata);
      metadataPersisted = true;
    } catch (error) {
      logWarn(`[TranslationToolExecutor] Failed to persist translation metadata for ${translation.id}: ${error instanceof Error ? error.message : String(error)}`);
      metadataPersisted = false;
    }

    const node = translationToDstuNode({
      ...translation,
      sourceText: null,
      translatedText: null,
    });
    ctx.emitWatchCreated?.(node);

    const output: Record<string, unknown> = {
      translation_id: translation.id,
      resource_id: translation.resourceId,
      path: node.path,
      title: translation.title ?? null,
      folder_id: args.folderId ?? null,
      source_lang: translation.srcLang,
      target_lang: translation.tgtLang,
      engine: translation.engine ?? null,
      model: translation.model ?? null,
      created_at: translation.createdAt,
      updated_at: translation.updatedAt ?? null,
      source_chars: sourceChars,
      translated_chars: translatedChars,
      source_mode: sourceMode,
      translation_result_consumed: cachedResultConsumed,
      metadata: persistedMetadata,
      metadata_persisted: metadataPersisted,
      reversible: true,
      undo: {
        tool_name: 'builtin-dstu_delete',
        arguments: { path: node.path },
        effect: 'soft_delete_to_trash',
      },
    };
    if (resolved.meta.partial) output.partial = true;
    return output;
  }

  static resolveSaveSource(
    args: TranslationSaveArgs,
    ownerSessionId: string,
    nowMs?: number,
  ): ResolveSaveResult {
    return resolveSaveSource(args, ownerSessionId, nowMs);
  }

  static buildPersistedMetadata(
    meta: CachedTranslationMeta,
    sourceMode: 'cached_result' | 'inline',
  ): Record<string, JsonValue> {
    return buildPersistedMetadata(meta, sourceMode);
  }

  static persistTranslation(
    owner: Pick<TranslationRepository, 'createTranslationInFolder'>,
    conn: SqlExecutor,
    resolved: ResolvedTranslation,
    args: TranslationSaveArgs,
  ): VfsTranslation {
    return persistTranslation(owner, conn, resolved, args);
  }

  static persistTranslationMetadata(owner: TranslationMetadataOwner, conn: SqlExecutor, translationId: string, metadata: JsonValue): void {
    persistTranslationMetadata(owner, conn, translationId, metadata);
  }
}
