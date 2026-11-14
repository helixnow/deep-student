/** Progressive execution phase of exam_engine.rs:1063–1208. */
import type { LLMManager, LlmOcrModels, LlmOcrHedge, LlmStreamingService, PreparedOcrCandidate } from '../api.ts';
import { OcrAdapterFactory, performSystemOcr, type JsonValue } from '../../llm-providers/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';
import { defaultSingleShotOptions } from './single_shot_stream.ts';
import { OCR_CIRCUIT_BREAKER, type OcrCircuitBreaker } from './ocr_circuit_breaker.ts';
import { LocalOcrRequests, nextOcrResult, buildOcrRequestBody, hedgeEngineOptions, hedgeEngineOuterDeadline, runOcrWithDeadline,
  runSingleOcrRequest, type OcrTransport, type OcrRequestResult, type OcrResultChannel } from './exam_engine.ts';
import { logDebug, logInfo, logWarn } from './logging.ts';
import { applyReasoningConfig, type JsonObject } from './question_authoring.ts';
import { ZhipuAdapter } from './adapters/zhipu.ts';
import { effectiveApiProtocolForConfig } from './protocol.ts';
import { prepareProviderRequest } from './prepared_request.ts';
import { isOfficialDeepseekOcr } from './deepseek_ocr_api.ts';

/** Internal owner surface: `executeAcquired` is only for callers that already passed allowRequest. */
export interface OcrHedgeOwner extends LlmOcrHedge {
  executeAcquired(candidates: readonly PreparedOcrCandidate[], cancellation?: AbortSignal): Promise<string>;
}

class Results implements OcrResultChannel {
  private queue: OcrRequestResult[] = [];
  private waiting: ((value: OcrRequestResult | null) => void) | null = null;
  private active = 0;
  private spawning = true;
  add(idx: number, operation: Promise<string>): void {
    this.active++;
    void operation.then(value => this.finish([idx, { ok: true, value }]),
      (error: unknown) => this.finish([idx, { ok: false, error: messageOf(error) }]));
  }
  private finish(result: OcrRequestResult): void {
    this.active--;
    if (this.waiting) { const waiting = this.waiting; this.waiting = null; waiting(result); }
    else this.queue.push(result);
  }
  endSpawning(): void {
    this.spawning = false;
    if (this.active === 0 && this.waiting !== null) { this.waiting(null); this.waiting = null; }
  }
  async next(): Promise<OcrRequestResult | null> {
    const value = this.queue.shift();
    if (value !== undefined) return value;
    if (!this.spawning && !this.active) return null;
    return new Promise(resolve => { this.waiting = resolve; });
  }
}

function messageOf(error: unknown): string {
  return error !== null && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
}

async function systemRequest(idx: number, bytes: Uint8Array, signal: AbortSignal): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new Error('OCR cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    timeout = setTimeout(() => reject(new Error(`Engine #${idx} (system_ocr) timed out after 60s`)), 60_000);
  });
  const operation = performSystemOcr(bytes).then(text => {
    if (rustTrim(text) === '') throw new Error(`Engine #${idx} (system_ocr) returned no text`);
    return text;
  }, (error: unknown) => { throw new Error(`Engine #${idx} (system_ocr) failed: ${messageOf(error)}`); });
  try { return await Promise.race([deadline, operation]); }
  finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); }
}

export function createOcrHedgeService(transport: OcrTransport, streaming: LlmStreamingService,
  llm: Pick<LLMManager, 'decryptApiKey'>, models: Pick<LlmOcrModels, 'isOcrThinkingEnabled'>,
  breaker: OcrCircuitBreaker = OCR_CIRCUIT_BREAKER, hedgeIntervalMs = 10_000): OcrHedgeOwner {
  return {
    async prepareCandidates(dataUrl, candidates, systemImage) {
      const prepared: PreparedOcrCandidate[] = [];
      for (const [idx, candidate] of candidates.entries()) {
        if (candidate.kind === 'systemOcr') {
          if (systemImage !== null) prepared.push({ kind: 'systemOcr', idx, imageBytes: systemImage.slice() });
          continue;
        }
        const { config, engineType } = candidate;
        let apiKey: string;
        try { apiKey = await llm.decryptApiKey(config.apiKey); }
        catch (error) { logWarn(`[OCR-Hedge] Engine #${idx} (${engineType}) key decrypt failed: ${messageOf(error)}`); continue; }
        if (isOfficialDeepseekOcr(config)) {
          prepared.push({ kind: 'remote', request: { idx, engineName: engineType, modelName: config.model,
            config: structuredClone(config), apiKey, requestBody: {}, isCodex: false, deepseekImage: dataUrl } });
          continue;
        }
        const adapter = OcrAdapterFactory.create(engineType);
        const body = buildOcrRequestBody(config, [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: dataUrl, detail: adapter.requiresHighDetail() ? 'high' : 'low' } },
          { type: 'text', text: adapter.buildPrompt('free_ocr') },
        ] }], adapter.recommendedTemperature()) as JsonObject;
        applyReasoningConfig(body, config, null);
        const extra = adapter.getExtraRequestParams();
        if (extra !== null && typeof extra === 'object' && !Array.isArray(extra)) Object.assign(body, extra);
        if (ZhipuAdapter.supportsThinkingStatic(config.model)) body.thinking = { type: models.isOcrThinkingEnabled() ? 'enabled' : 'disabled' };
        const penalty = adapter.recommendedRepetitionPenalty();
        if (penalty !== null) body.repetition_penalty = penalty;
        const protocol = effectiveApiProtocolForConfig(config);
        const provider = transport.adapters.createAdapter(protocol === 'anthropic_messages' ? 'anthropic'
          : protocol === 'google_generate_content' ? 'gemini' : protocol === 'openai_responses' ? 'openai_responses' : 'openai');
        let codex: boolean;
        try { codex = (await prepareProviderRequest(transport.adapters, transport.codex, provider,
          config, body, apiKey, null, 'OCR 对冲请求构建失败')).request.codex; }
        catch (error) { logWarn(`[OCR-Hedge] Engine #${idx} (${engineType}) request build failed: ${messageOf(error)}`); continue; }
        prepared.push({ kind: 'remote', request: { idx, engineName: engineType, modelName: config.model,
          config: structuredClone(config), apiKey, requestBody: body, isCodex: codex } });
      }
      if (!prepared.length) throw AppError.configuration('所有 OCR 引擎配置异常，无法构建请求');
      return prepared;
    },
    async runPrepared(candidates, cancellation) {
      if (!breaker.allowRequest()) throw AppError.llm('OCR 服务暂时不可用（连续失败触发熔断），请稍后重试');
      return executeAcquired(candidates, cancellation);
    },
    executeAcquired: (candidates, cancellation) => executeAcquired(candidates, cancellation),
  };

  /** Phase 2 of exam_engine.rs:1063–1208; the caller already holds the circuit probe
   * (allow_request); the probe is always released on exit (OcrCircuitProbeGuard). */
  async function executeAcquired(candidates: readonly PreparedOcrCandidate[], cancellation?: AbortSignal): Promise<string> {
    const race = new AbortController();
    let rejectCancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancel = () => { race.abort(); reject(AppError.llm('OCR cancelled')); };
    });
    // Attach before preparation/launch; cancelling a rejected race always has an observer.
    void cancelled.catch(() => null);
    cancellation?.addEventListener('abort', rejectCancel, { once: true });
    if (cancellation?.aborted) rejectCancel();
    const remote = new Results(), local = new LocalOcrRequests();
    let spawned = 0, completed = 0;
    let lastError: string | null = null;
    let next: Promise<OcrRequestResult | null> | null = null;
    const receive = (): Promise<OcrRequestResult | null> => next ??= nextOcrResult(remote, local);
    const consume = (result: OcrRequestResult | null, waitingForHedge: boolean): string | null => {
      next = null;
      if (result === null) return null;
      const [idx, outcome] = result;
      if (outcome.ok) {
        logInfo(waitingForHedge
          ? `[OCR-Hedge] Engine #${idx} won the race (${utf8ByteLength(outcome.value)} chars), ${spawned - completed - 1} other(s) may still be running`
          : `[OCR-Hedge] Engine #${idx} succeeded (${utf8ByteLength(outcome.value)} chars)`);
        breaker.recordSuccess(); return outcome.value;
      }
      completed++; lastError = outcome.error;
      logWarn(`[OCR-Hedge] Engine #${idx} failed: ${outcome.error}`);
      return null;
    };
    const start = (candidate: PreparedOcrCandidate): void => {
      if (candidate.kind === 'systemOcr') remote.add(candidate.idx, systemRequest(candidate.idx, candidate.imageBytes, race.signal));
      else if (candidate.request.isCodex) {
        const request = candidate.request, options = hedgeEngineOptions(request);
        local.add(request.idx, runOcrWithDeadline(request.idx, request.engineName, hedgeEngineOuterDeadline(options), async signal => {
          try {
            const result = await streaming.singleShotCompletion(request.config, request.requestBody as JsonValue, request.apiKey,
              null, 'OCR 对冲请求构建失败', { ...defaultSingleShotOptions(options.label), ...options, cancel: signal });
            return result.content;
          } catch (error) { throw new Error(`Engine #${request.idx} (${request.engineName}) Codex request failed: ${messageOf(error)}`); }
        }, race.signal));
      } else remote.add(candidate.request.idx, runSingleOcrRequest(transport, candidate.request, { cancel: race.signal }));
    };
    try {
      if (!candidates.length) throw AppError.configuration('所有 OCR 引擎配置异常，无法构建请求');
      if (cancellation?.aborted) throw AppError.llm('OCR cancelled');
      for (let seq = 0; seq < candidates.length; seq++) {
        const candidate = candidates[seq]!;
        start(candidate); spawned++;
        const idx = candidate.kind === 'remote' ? candidate.request.idx : candidate.idx;
        const engine = candidate.kind === 'remote' ? candidate.request.engineName : 'system_ocr';
        const model = candidate.kind === 'remote' ? candidate.request.modelName : 'native';
        logInfo(`[OCR-Hedge] Spawned engine #${idx} (${engine}, model=${model}) [${seq + 1}/${candidates.length}]`);
        if (seq === candidates.length - 1) break;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const elapsed = new Promise<'elapsed'>(resolve => { timer = setTimeout(() => resolve('elapsed'), hedgeIntervalMs); });
        try {
          for (;;) {
            const result = await Promise.race([cancelled, receive(), elapsed]);
            if (cancellation?.aborted) throw AppError.llm('OCR cancelled');
            if (result === 'elapsed') { logDebug('[OCR-Hedge] 10s elapsed with no result, hedging with next engine'); break; }
            const success = consume(result, true);
            if (success !== null) return success;
            if (result === null || completed >= spawned) break;
          }
        } finally { clearTimeout(timer); }
      }
      remote.endSpawning();
      while (completed < spawned) {
        const result = await Promise.race([cancelled, receive()]);
        if (cancellation?.aborted) throw AppError.llm('OCR cancelled');
        const success = consume(result, false);
        if (success !== null) return success;
        if (result === null) break;
      }
      breaker.recordFailure();
      throw AppError.llm(lastError ?? '所有 OCR 引擎均失败');
    } finally {
      race.abort(); breaker.cancelProbe(); cancellation?.removeEventListener('abort', rejectCancel);
      remote.endSpawning();
    }
  }
}
