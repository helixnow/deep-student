/**
 * `pluginModel`: the one model entry opened to community / workshop plugins (`docs/plugins/SDK.md` §3.5).
 * No Rust counterpart (Rust had no community plugins).
 *
 * A plugin declares `service:pluginModel` and calls the user's configured dialogue model (model2) through the same
 * raw-prompt / streaming exits, failover and usage ledger as the app's own utility calls: text (and optionally images)
 * in, text out, either at once (`complete`) or in pieces as the model writes (`stream`). It never sees provider
 * configs, API keys, model routing or other conversations: those stay behind `llm`.
 */
import type { ImagePayload, LlmModel2Streaming, LlmRawPrompt, LlmStreamEvents } from '../api.ts';

/** Longest prompt (characters) a plugin may send; a selection or a short document, not a corpus. */
export const PLUGIN_MODEL_MAX_PROMPT_CHARS = 8000;
export const PLUGIN_MODEL_MAX_SYSTEM_CHARS = 2000;
/** Calls in flight across all plugins; further calls are refused instead of queued behind the user's own chat. */
export const PLUGIN_MODEL_MAX_CONCURRENT = 2;
export const PLUGIN_MODEL_TIMEOUT_MS = 60_000;
/** A streamed answer may run longer: the user sees it arrive. */
export const PLUGIN_MODEL_STREAM_TIMEOUT_MS = 180_000;
/** Images a plugin may attach (the user's dialogue model must accept images). */
export const PLUGIN_MODEL_MAX_IMAGES = 4;
/** Base64 characters per image (about 6 MB of image bytes). */
export const PLUGIN_MODEL_MAX_IMAGE_BASE64 = 8 * 1024 * 1024;

export interface PluginModelImage {
  /** e.g. `image/png`, `image/jpeg`. */
  mime: string;
  /** Base64 of the image bytes (a `data:…;base64,` prefix is removed). */
  base64: string;
}

export interface PluginModelRequest {
  /** What the model should answer. */
  prompt: string;
  /** Optional instructions placed before the prompt. */
  system?: string;
  /** Up to 4 images sent with the prompt (a photo of a page, a diagram, a screenshot). */
  images?: readonly PluginModelImage[];
}

export interface PluginModelResult {
  text: string;
}

export interface PluginModelStreamOptions {
  signal?: AbortSignal;
  /** Called with each new piece of the answer as it arrives. */
  onText?: (delta: string) => void;
}

export interface PluginModelService {
  /**
   * One non-streaming completion on the user's dialogue model. Rejects with an `Error` whose message starts with
   * `PLUGIN_MODEL_INVALID` (bad request), `PLUGIN_MODEL_BUSY` (too many calls in flight), `PLUGIN_MODEL_CANCELLED`
   * or `PLUGIN_MODEL_FAILED` (no model configured, provider error, timeout; the provider's message follows).
   */
  complete(request: PluginModelRequest, options?: { signal?: AbortSignal }): Promise<PluginModelResult>;
  /**
   * Same as `complete`, but the answer arrives in pieces through `options.onText` while the model writes it; the
   * promise resolves with the whole text. Where streaming is unavailable the whole answer arrives as one piece.
   */
  stream(request: PluginModelRequest, options?: PluginModelStreamOptions): Promise<PluginModelResult>;
}

export interface PluginModelStreaming {
  model2: Pick<LlmModel2Streaming, 'callUnifiedModel2Stream'>;
  events: Pick<LlmStreamEvents, 'registerStreamHooks' | 'unregisterStreamHooksIfOwner'>;
  cancel(streamEvent: string): Promise<void>;
}

export interface PluginModelDeps {
  rawPrompt: Pick<LlmRawPrompt, 'callModel2RawPromptOpts'> & Partial<Pick<LlmRawPrompt, 'callModel2RawPrompt'>>;
  streaming?: PluginModelStreaming;
  timeoutMs?: number;
  streamTimeoutMs?: number;
  /** Where a failing plugin onText callback is reported. */
  log?: (message: string) => void;
}

function failureText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  const value = (error as { value?: unknown } | null)?.value ?? error;
  const message = (value as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && message !== '') return message;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

function checkImages(images: unknown): ImagePayload[] {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw new Error('PLUGIN_MODEL_INVALID: images must be an array');
  if (images.length > PLUGIN_MODEL_MAX_IMAGES) throw new Error(`PLUGIN_MODEL_INVALID: at most ${PLUGIN_MODEL_MAX_IMAGES} images`);
  return images.map((image, index) => {
    const value = image as Partial<PluginModelImage> | null;
    if (!value || typeof value.mime !== 'string' || !value.mime.startsWith('image/') || typeof value.base64 !== 'string') {
      throw new Error(`PLUGIN_MODEL_INVALID: images[${index}] needs an image/* mime and base64 data`);
    }
    const base64 = value.base64.replace(/^data:[^,]*,/, '');
    if (base64 === '') throw new Error(`PLUGIN_MODEL_INVALID: images[${index}] has no data`);
    if (base64.length > PLUGIN_MODEL_MAX_IMAGE_BASE64) throw new Error(`PLUGIN_MODEL_INVALID: images[${index}] is larger than about 6 MB`);
    return { mime: value.mime, base64 };
  });
}

/** Rejects when `signal` aborts, for provider calls that take no signal of their own. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function createPluginModelService(deps: PluginModelDeps): PluginModelService {
  let inFlight = 0;
  let streams = 0;
  const run = async (request: PluginModelRequest, options: PluginModelStreamOptions | undefined, streamed: boolean): Promise<PluginModelResult> => {
    const prompt = typeof request?.prompt === 'string' ? request.prompt.trim() : '';
    const system = request?.system === undefined ? '' : typeof request.system === 'string' ? request.system.trim() : null;
    if (prompt === '') throw new Error('PLUGIN_MODEL_INVALID: prompt must be a non-empty string');
    if (system === null) throw new Error('PLUGIN_MODEL_INVALID: system must be a string when given');
    if (prompt.length > PLUGIN_MODEL_MAX_PROMPT_CHARS) throw new Error(`PLUGIN_MODEL_INVALID: prompt exceeds ${PLUGIN_MODEL_MAX_PROMPT_CHARS} characters`);
    if (system.length > PLUGIN_MODEL_MAX_SYSTEM_CHARS) throw new Error(`PLUGIN_MODEL_INVALID: system exceeds ${PLUGIN_MODEL_MAX_SYSTEM_CHARS} characters`);
    const images = checkImages(request?.images);
    const caller = options?.signal;
    if (caller?.aborted) throw new Error('PLUGIN_MODEL_CANCELLED: the request was cancelled');
    if (inFlight >= PLUGIN_MODEL_MAX_CONCURRENT) throw new Error('PLUGIN_MODEL_BUSY: too many plugin model calls are running; try again shortly');
    inFlight++;
    const timeout = AbortSignal.timeout(streamed ? deps.streamTimeoutMs ?? PLUGIN_MODEL_STREAM_TIMEOUT_MS : deps.timeoutMs ?? PLUGIN_MODEL_TIMEOUT_MS);
    const signal = caller === undefined ? timeout : AbortSignal.any([caller, timeout]);
    const fullPrompt = system === '' ? prompt : `${system}\n\n${prompt}`;
    try {
      let text: string;
      if (streamed && deps.streaming) {
        text = await streamModel2(deps.streaming, deps.log, `plugin_model_${Date.now().toString(36)}_${++streams}`, prompt, system, images, signal, options?.onText);
      } else if (images.length > 0) {
        if (!deps.rawPrompt.callModel2RawPrompt) throw new Error('PLUGIN_MODEL_FAILED: image input is not available');
        const output = await abortable(deps.rawPrompt.callModel2RawPrompt(fullPrompt, images, { other: 'plugin' }), signal);
        if (output.cancelled) throw new Error('PLUGIN_MODEL_CANCELLED: the request was cancelled');
        text = output.assistant_message;
      } else {
        const output = await deps.rawPrompt.callModel2RawPromptOpts(fullPrompt, false, { other: 'plugin' }, 'utility', signal);
        if (output.cancelled) throw new Error('PLUGIN_MODEL_CANCELLED: the request was cancelled');
        text = output.assistant_message;
      }
      if (caller?.aborted) throw new Error('PLUGIN_MODEL_CANCELLED: the request was cancelled');
      if (streamed && !deps.streaming) emitText(options?.onText, text, deps.log);
      return { text };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('PLUGIN_MODEL_')) throw error;
      if (caller?.aborted) throw new Error('PLUGIN_MODEL_CANCELLED: the request was cancelled');
      if (timeout.aborted) throw new Error('PLUGIN_MODEL_FAILED: the model did not answer in time');
      throw new Error(`PLUGIN_MODEL_FAILED: ${failureText(error)}`);
    } finally { inFlight--; }
  };
  return Object.freeze({
    complete: (request: PluginModelRequest, options?: { signal?: AbortSignal }) => run(request, options, false),
    stream: (request: PluginModelRequest, options?: PluginModelStreamOptions) => run(request, options, true),
  });
}

/** A plugin's display callback must not break the stream. */
function emitText(onText: ((delta: string) => void) | undefined, text: string, log?: (message: string) => void): void {
  if (!onText || text === '') return;
  try { onText(text); } catch (error) { log?.(`plugin onText callback threw: ${failureText(error)}`); }
}

/** One streamed answer on the dialogue model: content chunks reach `onText` through the stream hooks. */
async function streamModel2(streaming: PluginModelStreaming, log: ((message: string) => void) | undefined, streamEvent: string, prompt: string, system: string,
  images: readonly ImagePayload[], signal: AbortSignal, onText: ((delta: string) => void) | undefined): Promise<string> {
  let received = '';
  const hooks = {
    onContentChunk(text: string) {
      received += text;
      emitText(onText, text, log);
    },
  };
  streaming.events.registerStreamHooks(streamEvent, hooks);
  let cancellation: Promise<void> | undefined;
  const cancel = () => { cancellation ??= streaming.cancel(streamEvent).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const output = await streaming.model2.callUnifiedModel2Stream({
      context: {}, subject: '', enableChainOfThought: false, enableThinking: false, taskContext: 'plugin',
      chatHistory: [{
        role: 'user', content: prompt,
        ...(images.length > 0 ? { multimodal_content: [{ type: 'text' as const, text: prompt },
          ...images.map((image) => ({ type: 'image_url' as const, mediaType: image.mime, base64: image.base64 }))] } : {}),
      }],
      sink: { emit() {} }, streamEvent, disableTools: true, systemPromptOverride: system === '' ? null : system,
    });
    if (output.cancelled || signal.aborted) throw new Error('PLUGIN_MODEL_CANCELLED: the request was cancelled');
    return output.assistant_message || received;
  } finally {
    signal.removeEventListener('abort', cancel);
    streaming.events.unregisterStreamHooksIfOwner(streamEvent, hooks);
    await cancellation;
  }
}
