/**
 * `dstu-media/src/media/asr.rs`: the HTTP ASR backend used by the transcription
 * pipeline. It shares the voice-input request kernel (`post_asr_form` /
 * `post_asr_chat_input_audio`) and parses `json`/`verbose_json` results.
 *
 * Usage accounting (`record_asr_usage(CallerType::MediaTranscription, ...)`)
 * is injected as a recorder so the plugin can bind it to the `llm_usage` store.
 */
import {
  AsrEndpoint,
  type AsrClipResult,
  type AsrHttpError,
  formatAsrHttpError,
  modelSupportsVerboseJson,
  parseChatTranscript,
  parseTranscriptionBody,
} from './asr.ts';
import { rustTrim } from './transcript.ts';
import {
  buildChatInputAudioBody, sendAsrRequest, type AsrFetch, type AsrHttpOutcome, type AsrHttpRequest,
  type VoiceInputUsage,
} from './voice-input.ts';

/** `ASR_REQUEST_TIMEOUT`：媒体转写的 HTTP 客户端超时（语音输入为 90s）。 */
export const ASR_REQUEST_TIMEOUT_MS = 120_000;

export type AsrUsageRecorder = (record: VoiceInputUsage) => void;

function malformedResponse(message: string): AsrHttpError {
  return { kind: 'status', status: 502, retryAfterSeconds: null, body: message };
}

function toAsrHttpError(outcome: Exclude<AsrHttpOutcome, { ok: true }>): AsrHttpError {
  if ('status' in outcome) {
    return {
      kind: 'status', status: outcome.status,
      retryAfterSeconds: outcome.retryAfterSeconds, body: outcome.body,
    };
  }
  return { kind: 'transport', timeout: outcome.timeout, message: outcome.message };
}

export class HttpAsrBackend {
  readonly endpoint: AsrEndpoint;
  private readonly language: string | null;
  private readonly fetcher: AsrFetch;
  private readonly usage: AsrUsageRecorder | null;
  private verboseEnabled: boolean;

  constructor(
    endpoint: AsrEndpoint,
    language: string | null,
    fetcher: AsrFetch,
    usage: AsrUsageRecorder | null = null,
  ) {
    this.endpoint = endpoint;
    this.language = language;
    this.fetcher = fetcher;
    this.usage = usage;
    this.verboseEnabled = endpoint.protocol === 'transcriptions'
      && modelSupportsVerboseJson(endpoint.model);
  }

  modelLabel(): string {
    return this.endpoint.model;
  }

  /** `build_form`：`segment.wav` + 可选 `response_format=verbose_json` + language。 */
  buildForm(wav: Uint8Array, verbose: boolean): AsrHttpRequest {
    const form = new FormData();
    const deepseek = this.endpoint.protocol === 'deepseek_asr';
    if (!deepseek) form.append('model', this.endpoint.model);
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'segment.wav');
    if (!deepseek && verbose) form.append('response_format', 'verbose_json');
    const language = this.language === null ? '' : rustTrim(this.language);
    if (!deepseek && language !== '') form.append('language', language);
    return {
      url: this.endpoint.transcriptionUrl(),
      headers: [['authorization', `Bearer ${this.endpoint.apiKey}`], ...this.endpoint.headers],
      body: form,
    };
  }

  private async transcribeMultipart(wav: Uint8Array): Promise<AsrClipResult> {
    let verbose = this.verboseEnabled;
    for (;;) {
      const outcome = await sendAsrRequest(this.fetcher, this.buildForm(wav, verbose), ASR_REQUEST_TIMEOUT_MS);
      // 服务端不认 verbose_json → 本任务后续一律降级为段级时间戳
      if (verbose && !outcome.ok && 'status' in outcome
        && outcome.status === 400
        && outcome.body.toLowerCase().includes('response_format')) {
        this.verboseEnabled = false;
        verbose = false;
        continue;
      }
      if (!outcome.ok) throw toAsrHttpError(outcome);
      try { return parseTranscriptionBody(outcome.body); }
      catch (error) { throw malformedResponse((error as Error).message); }
    }
  }

  private async transcribeChat(wav: Uint8Array): Promise<AsrClipResult> {
    const outcome = await sendAsrRequest(this.fetcher, {
      url: this.endpoint.url('chat/completions'),
      headers: [
        ['authorization', `Bearer ${this.endpoint.apiKey}`],
        ['content-type', 'application/json'],
        ...this.endpoint.headers,
      ],
      body: JSON.stringify(buildChatInputAudioBody(
        this.endpoint, wav, 'audio/wav', this.language)),
    }, ASR_REQUEST_TIMEOUT_MS);
    if (!outcome.ok) throw toAsrHttpError(outcome);
    let text: string;
    try { [text] = parseChatTranscript(outcome.body); }
    catch (error) { throw malformedResponse((error as Error).message); }
    return { text, speechBoundsMs: null };
  }

  async transcribe(wav: Uint8Array): Promise<AsrClipResult> {
    const started = performance.now();
    let parsed: AsrClipResult | null = null;
    let failure: AsrHttpError | null = null;
    try {
      parsed = this.endpoint.protocol !== 'chat_input_audio'
        ? await this.transcribeMultipart(wav)
        : await this.transcribeChat(wav);
    } catch (error) {
      failure = error as AsrHttpError;
    }
    this.usage?.({
      providerId: this.endpoint.providerId,
      model: this.endpoint.model,
      configId: this.endpoint.configId,
      latencyMs: Math.max(0, Math.floor(performance.now() - started)),
      success: failure === null,
      errorMessage: failure === null ? null : formatAsrHttpError(failure),
    });
    if (failure !== null) throw failure;
    return parsed!;
  }
}
