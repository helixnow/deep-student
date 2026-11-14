/**
 * HPIAS research pipeline service — `dstu-research/src/hpias/{service,orchestrator}.rs`.
 *
 * L13 `GenerativeUiExecutor` calls `startFromIntent` after it emitted the static
 * intent. This owner selects the backend from the process environment, emits
 * `session_started` synchronously. Stub uses the 350ms timeline; retrieval uses
 * the real VFS search / L02 synthesis pipeline.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { WindowRef } from '../../../kernel/api.ts';
import type { LlmRawPrompt } from '../../llm/api.ts';
import type { RetrievalService } from '../../vfs-index/api.ts';
import {
  HPIAS_EVENT_CHANNEL, buildPipelineTimeline, buildSessionStartedPayload,
  extractQuestionFromIntent, type JsonRecord,
} from './hpias-payloads.ts';
import { backendKindFromConfig, canRunRetrieval, shouldStartResearchSession } from './hpias-research.ts';
import { runHpiasRetrieval } from './hpias-retrieval.ts';
import { errorText } from './memory-utils.ts';

/** Rust `DEFAULT_PIPELINE_INTERVAL_MS`. */
export const DEFAULT_PIPELINE_INTERVAL_MS = 350;
export const HPIAS_LOG_TARGET = 'dstu_research::hpias';

export interface HpiasTimelineDeps {
  emit(payload: JsonRecord): void;
  delay(milliseconds: number): Promise<void>;
  intervalMs?: number;
  shouldStop?: () => boolean;
  warn?: (message: string) => void;
}

/**
 * Rust `HpiasPipelineOrchestrator::run_timeline`.
 *
 * `skipFirst` mirrors the executor having already sent `session_started`; the
 * first delay therefore starts before timeline item 1.
 */
export async function runHpiasTimeline(timeline: readonly JsonRecord[],
  deps: HpiasTimelineDeps, skipFirst = true): Promise<void> {
  const interval = deps.intervalMs ?? DEFAULT_PIPELINE_INTERVAL_MS;
  for (const [index, payload] of timeline.entries()) {
    if (skipFirst && index === 0) continue;
    if (deps.shouldStop?.()) return;
    await deps.delay(interval);
    if (deps.shouldStop?.()) return;
    try {
      deps.emit(payload);
    } catch (error) {
      deps.warn?.(`[HpiasPipelineOrchestrator] emit failed at index ${index}: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }
}

export interface GenerativeResearchRequest {
  window: WindowRef;
  sessionId: string;
  title: string | null;
  intent: unknown;
}

export interface HpiasResearchService {
  /** Backend selection + initial event; non-research / disabled = no-op. */
  startFromIntent(request: GenerativeResearchRequest): void;
}

export interface HpiasResearchServiceOptions {
  /** Overridable for tests; production uses Rust's 350ms. */
  intervalMs?: number;
  /** Rust reads `DEEP_STUDENT_HPIAS_BACKEND` on every call; the Host passes it as plugin config. */
  backend?: () => string | null | undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/** Provides L13's `GenerativeResearchPort` as the Cordis service `hpiasResearch`. */
export function createHpiasResearchService(ctx: Context,
  options: HpiasResearchServiceOptions = {}): HpiasResearchService {
  let disposed = false;
  const lifetime = new AbortController();
  ctx.effect(() => () => { disposed = true; lifetime.abort(); });
  const warn = (message: string): void => ctx.log.logger(HPIAS_LOG_TARGET).warn(message);

  return {
    startFromIntent(request) {
      if (disposed) return;
      if (!shouldStartResearchSession(request.intent)) return;
      const backend = backendKindFromConfig(options.backend?.(), warn);
      if (backend === 'disabled') return;
      const llm = ctx.get('llmRawPrompt') as LlmRawPrompt | undefined;
      const retrieval = ctx.get('retrieval') as RetrievalService | undefined;
      if (backend === 'retrieval') {
        if (!canRunRetrieval({ vfsDb: ctx.get('vfsDatabase'), llmManager: llm })
          || typeof llm?.callWithConfigIdRawPrompt !== 'function' || typeof retrieval?.search !== 'function') {
          warn('[HpiasResearchService] retrieval backend requested but VFS/LLM unavailable; pipeline disabled');
          return;
        }
      }
      // Rust Option::or: Some("") wins over the extracted question.
      const question = request.title ?? extractQuestionFromIntent(request.intent);
      const emit = (payload: JsonRecord): void => ctx.backendEvents.emit(HPIAS_EVENT_CHANNEL, payload);
      try {
        emit(buildSessionStartedPayload(request.sessionId, question, null));
      } catch (error) {
        warn(`[GenerativeUiExecutor] hpias_event session_started emit failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (backend === 'retrieval' && retrieval && llm) {
        void runHpiasRetrieval({ sessionId: request.sessionId, question, intent: request.intent }, {
          retrieval, llm, emit, delay, warn, signal: lifetime.signal,
        }).catch(error => {
          if (!disposed) warn(`[HpiasRetrieval] pipeline failed: ${errorText(error)}`);
        });
        return;
      }
      const timeline = buildPipelineTimeline(request.sessionId, question, request.intent);
      void runHpiasTimeline(timeline, {
        emit,
        delay,
        warn,
        shouldStop: () => disposed,
        ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
      });
    },
  };
}
