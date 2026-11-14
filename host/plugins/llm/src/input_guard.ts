/**
 * 请求输入预算预检（model2_pipeline.rs effective_request_input_limit /
 * estimate_request_input_tokens / check_request_input_budget）与图片 token 投影。
 *
 * 预检只读：任何路径都不得改写请求体；历史图片只有 ChatV2 编排器在压缩时
 * 才能替换为摘要。
 */
import { AppError } from '../../../platform/errors/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { ApiConfig } from '../api.ts';
import { estimateTokens } from './tokens.ts';
import {
  LLM_ERROR_CODE_COMPACTION_REQUIRED, LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED,
  attachLlmErrorCode,
} from './routing.ts';
import { usesDeepseekV41ImageTokens } from './adapters/deepseek.ts';
import { fromBase64 } from '../../../platform/crypto/encoding.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';

/** compaction_budget.rs TRIGGER_RATIO */
export const TRIGGER_RATIO = 0.85;
export const COMPACTION_CHECKED_CONTEXT_KEY = 'chat_v2_compaction_checked';
/** 未知/损坏内联图片的保守预留（与 Rust 一致）。 */
export const UNKNOWN_IMAGE_TOKEN_RESERVE = 8_192;

export interface LegacyChatMessageLike {
  role: string;
  content: string;
  metadata?: JsonValue | null;
  image_paths?: string[] | null;
  image_base64?: string[] | null;
  multimodal_content?: Array<
    { type: 'text'; text: string }
    | { type: 'image_url'; mediaType: string; base64: string }
  > | null;
}

type JsonObject = { [key: string]: JsonValue };

function asObject(value: JsonValue): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : null;
}

function asArray(value: JsonValue): JsonValue[] | null {
  return Array.isArray(value) ? value : null;
}

/** 有效输入上限：供应商窗口减输出预留，输出预留最多占窗口一半。 */
export function effectiveRequestInputLimit(
  config: Pick<ApiConfig, 'contextWindow' | 'maxOutputTokens' | 'maxTokensLimit'>,
  overrideLimit?: number | null,
): number | null {
  const configuredWindow = config.contextWindow ?? null;
  const window = configuredWindow !== null && configuredWindow > 0 ? configuredWindow : 32_768;
  const requested = config.maxOutputTokens > 0 ? config.maxOutputTokens : 8_192;
  const configuredLimit = config.maxTokensLimit ?? null;
  const maxOutput = configuredLimit !== null && configuredLimit > 0
    ? Math.min(requested, configuredLimit) : requested;
  const outputReserve = Math.min(maxOutput, Math.floor(window / 2));
  const providerLimit = window - outputReserve;
  const override = overrideLimit ?? null;
  return override !== null ? Math.min(override, providerLimit) : providerLimit;
}

/** 把内联图片替换为占位符并返回替换数量；仅用于估算副本。 */
export function redactImagePayloadsForBudget(value: unknown): number {
  if (typeof value === 'string') {
    return value.trimStart().startsWith('data:image/') ? 1 : 0;
  }
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += redactImagePayloadsForBudget(item);
    return total;
  }
  if (value !== null && typeof value === 'object') {
    const object = value as JsonObject;
    const mime = [object.media_type, object.mime_type, object.mimeType]
      .find((candidate): candidate is string => typeof candidate === 'string') ?? '';
    let images = 0;
    if (mime.startsWith('image/') && typeof object.data === 'string' && object.data !== '') {
      object.data = '[image payload]';
      images += 1;
    }
    for (const item of Object.values(object)) images += redactImagePayloadsForBudget(item);
    return images;
  }
  return 0;
}

const PATCH_SIZE = 14;
const DOWNSAMPLE_RATIO = 3;
const MAX_IMAGE_TOKENS = 1_024;
const MIN_PIXELS = 544 * 544;
const CELL_SIZE = PATCH_SIZE * DOWNSAMPLE_RATIO;

interface GridResize {
  gridHeight: number;
  gridWidth: number;
  bestHeight: number;
  bestWidth: number;
  numTokens: number;
}

function ceilDiv(value: number, divisor: number): number {
  return Math.ceil(value / divisor);
}

function gridTokens(gridHeight: number, gridWidth: number): number {
  return gridHeight * (gridWidth + 1) + 2;
}

function gridCells(paddedLength: number): number {
  return ceilDiv(Math.floor(paddedLength / PATCH_SIZE), DOWNSAMPLE_RATIO);
}

function solveResizeRatio(height: number, width: number, budget: number): GridResize {
  const aspect = height / width;
  const idealGridWidth = Math.sqrt((budget - 2) / aspect + 0.25) - 0.5;
  const idealGridHeight = idealGridWidth * aspect;
  let bestHeight: number;
  let bestWidth: number;
  if (idealGridWidth < 1.0) {
    const gridWidth = 1;
    const gridHeight = Math.trunc((budget - 2) / (gridWidth + 1));
    bestHeight = gridHeight * CELL_SIZE;
    bestWidth = gridWidth * CELL_SIZE;
  } else if (idealGridHeight < 1.0) {
    const gridHeight = 1;
    const gridWidth = Math.trunc((budget - 2) / gridHeight) - 1;
    bestHeight = gridHeight * CELL_SIZE;
    bestWidth = gridWidth * CELL_SIZE;
  } else {
    const gridWidth = Math.trunc(idealGridWidth);
    const gridHeight = Math.trunc(idealGridHeight);
    const scale = Math.min(
      (gridWidth * CELL_SIZE) / width,
      (gridHeight * CELL_SIZE) / height,
    );
    bestHeight = Math.trunc(Math.trunc(height * scale) / PATCH_SIZE) * PATCH_SIZE;
    bestWidth = Math.trunc(Math.trunc(width * scale) / PATCH_SIZE) * PATCH_SIZE;
  }
  const gridHeight = gridCells(bestHeight);
  const gridWidth = gridCells(bestWidth);
  return {
    gridHeight, gridWidth, bestHeight, bestWidth,
    numTokens: gridTokens(gridHeight, gridWidth),
  };
}

function resizeOnce(width: number, height: number): GridResize {
  let scaledWidth = width;
  let scaledHeight = height;
  if (width * height < MIN_PIXELS) {
    const scale = Math.sqrt(MIN_PIXELS / (width * height));
    scaledWidth = Math.trunc(width * scale);
    scaledHeight = Math.trunc(height * scale);
  }
  const paddedWidth = ceilDiv(scaledWidth, PATCH_SIZE) * PATCH_SIZE;
  const paddedHeight = ceilDiv(scaledHeight, PATCH_SIZE) * PATCH_SIZE;
  const direct: GridResize = {
    gridHeight: gridCells(paddedHeight),
    gridWidth: gridCells(paddedWidth),
    bestHeight: paddedHeight,
    bestWidth: paddedWidth,
    numTokens: gridTokens(gridCells(paddedHeight), gridCells(paddedWidth)),
  };
  if (direct.numTokens <= MAX_IMAGE_TOKENS) return direct;
  return solveResizeRatio(scaledHeight, scaledWidth, MAX_IMAGE_TOKENS);
}

/** DeepSeek V4.1 Flash 官方图片投影（14px patch，3 patch 合并，1024 上限）。 */
export function deepseekV41ImageTokens(width: number, height: number): number {
  let result = resizeOnce(Math.max(1, width), Math.max(1, height));
  for (let iteration = 1; iteration < 10; iteration += 1) {
    const next = resizeOnce(result.bestWidth, result.bestHeight);
    if (next.gridHeight === result.gridHeight
      && next.gridWidth === result.gridWidth
      && next.bestHeight === result.bestHeight
      && next.bestWidth === result.bestWidth
      && next.numTokens === result.numTokens) {
      return result.numTokens;
    }
    result = next;
  }
  return MAX_IMAGE_TOKENS;
}

function base64Bytes(data: string): Uint8Array | null {
  const trimmed = data.trim();
  if (trimmed === '' || trimmed.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed)) return null;
  try {
    const bytes = fromBase64(trimmed);
    return bytes.length > 0 ? bytes : null;
  } catch { // boundary-allow empty-catch: Rust base64 解码 `.ok()?` 失败返回 None，不记录日志
    return null;
  }
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end).map(byte => byte & 0x7f));
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function pngDimensions(bytes: Uint8Array): [number, number] | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return null;
  }
  if (ascii(bytes, 12, 16) !== 'IHDR') return null;
  const width = dataView(bytes).getUint32(16);
  const height = dataView(bytes).getUint32(20);
  return [width, height];
}

function jpegDimensions(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = dataView(bytes).getUint16(offset + 2);
    if (length < 2) return null;
    const isSof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      const height = dataView(bytes).getUint16(offset + 5);
      const width = dataView(bytes).getUint16(offset + 7);
      return [width, height];
    }
    offset += 2 + length;
  }
  return null;
}

function gifDimensions(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 10) return null;
  const header = ascii(bytes, 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') return null;
  return [dataView(bytes).getUint16(6, true), dataView(bytes).getUint16(8, true)];
}

function webpDimensions(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 30) return null;
  if (ascii(bytes, 0, 4) !== 'RIFF') return null;
  if (ascii(bytes, 8, 12) !== 'WEBP') return null;
  const chunk = ascii(bytes, 12, 16);
  if (chunk === 'VP8X') {
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return [width, height];
  }
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const width = dataView(bytes).getUint16(26, true) & 0x3fff;
    const height = dataView(bytes).getUint16(28, true) & 0x3fff;
    return [width, height];
  }
  if (chunk === 'VP8L') {
    const bits = dataView(bytes).getUint32(21, true);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return [width, height];
  }
  return null;
}

/** 解码图片头得到像素尺寸；无法识别返回 null。 */
export function decodeImageDimensions(data: string): [number, number] | null {
  const bytes = base64Bytes(data);
  if (bytes === null) return null;
  const dimensions = pngDimensions(bytes)
    ?? jpegDimensions(bytes)
    ?? gifDimensions(bytes)
    ?? webpDimensions(bytes);
  if (dimensions === null) return null;
  const [width, height] = dimensions;
  return width > 0 && height > 0 ? [width, height] : null;
}

/** base64 图片正文的 V4.1 投影 token。 */
export function encodedImageTokens(data: string): number | null {
  const dimensions = decodeImageDimensions(data);
  return dimensions === null ? null : deepseekV41ImageTokens(dimensions[0], dimensions[1]);
}

/** data URL 的 V4.1 投影 token。 */
export function dataUrlImageTokens(value: string): number | null {
  const comma = value.indexOf(',');
  if (comma < 0) return null;
  const header = value.slice(0, comma);
  if (!header.trimStart().startsWith('data:image/') || !header.includes(';base64')) return null;
  return encodedImageTokens(value.slice(comma + 1));
}

/** 已知投影 token + 几何未知的保守图片数量。 */
export function inlineImageTokenBudget(value: unknown): [number, number] {
  if (typeof value === 'string') {
    if (!value.trimStart().startsWith('data:image/')) return [0, 0];
    const tokens = dataUrlImageTokens(value);
    return tokens === null ? [0, 1] : [tokens, 0];
  }
  if (Array.isArray(value)) {
    let known = 0;
    let unknown = 0;
    for (const item of value) {
      const [itemKnown, itemUnknown] = inlineImageTokenBudget(item);
      known += itemKnown;
      unknown += itemUnknown;
    }
    return [known, unknown];
  }
  if (value !== null && typeof value === 'object') {
    const object = value as JsonObject;
    const mime = [object.media_type, object.mime_type, object.mimeType]
      .find((candidate): candidate is string => typeof candidate === 'string') ?? '';
    if (mime.startsWith('image/') && typeof object.data === 'string') {
      const tokens = encodedImageTokens(object.data);
      return tokens === null ? [0, 1] : [tokens, 0];
    }
    let known = 0;
    let unknown = 0;
    for (const item of Object.values(object)) {
      const [itemKnown, itemUnknown] = inlineImageTokenBudget(item);
      known += itemKnown;
      unknown += itemUnknown;
    }
    return [known, unknown];
  }
  return [0, 0];
}

/** 请求输入 token 估算：文本启发式 + 图片投影/保守预留。 */
export function estimateRequestInputTokens(body: unknown, config: ApiConfig): number {
  const textOnly = structuredClone(body);
  const imageCount = redactImagePayloadsForBudget(textOnly);
  const serialized = JSON.stringify(textOnly);
  const heuristic = estimateTokens(serialized);
  const textFloor = Math.floor(utf8ByteLength(serialized) / 4);
  const imageTokens = usesDeepseekV41ImageTokens(config)
    ? (() => {
      const [known, unknown] = inlineImageTokenBudget(body);
      return known + unknown * UNKNOWN_IMAGE_TOKEN_RESERVE;
    })()
    : imageCount * UNKNOWN_IMAGE_TOKEN_RESERVE;
  return Math.max(heuristic, textFloor) + imageTokens;
}

/** 只读预检；超限返回带 llm_error_code 的 AppError，不改写请求体。 */
export function checkRequestInputBudget(
  requestBody: unknown,
  maxInputTokens: number | null | undefined,
  config: ApiConfig,
  allowCompaction: boolean,
): AppError | null {
  const limit = maxInputTokens ?? null;
  if (limit === null) return null;
  const used = estimateRequestInputTokens(requestBody, config);
  const needsCompaction = allowCompaction
    && limit > 0
    && used >= Math.trunc(limit * TRIGGER_RATIO);
  if (!needsCompaction && used <= limit && limit > 0) return null;

  const code = needsCompaction
    ? LLM_ERROR_CODE_COMPACTION_REQUIRED
    : LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED;
  const message = needsCompaction
    ? `context compaction required before sending: estimated_input_tokens=${used} limit=${limit}`
    : `上下文预算不足（估算 ${used} tokens，上限 ${limit}）。自动压缩未能释放足够空间，已停止发送且未丢弃历史消息；请减少当前附件或工具输出、手动压缩，或选择更大上下文的模型。`;
  const tagged = attachLlmErrorCode(AppError.llm(message), code);
  const details = asObject(tagged.details) ?? {};
  details.estimated_input_tokens = used;
  details.input_limit = limit;
  details.compaction_model_id = config.id;
  details.budget = {
    stage: 'input_guard',
    estimatedInputTokens: used,
    limit,
    removedHistoryImages: 0,
    removedMessages: 0,
    trimmedTailChars: 0,
  };
  return { ...tagged, details };
}

/** ChatMessage 历史是否携带任何图片输入。 */
export function chatMessagesRequireMultimodal(messages: LegacyChatMessageLike[]): boolean {
  return messages.some((message) => (
    (message.image_paths !== null && message.image_paths !== undefined
      && message.image_paths.length > 0)
    || (message.image_base64 !== null && message.image_base64 !== undefined
      && message.image_base64.length > 0)
    || (message.multimodal_content ?? []).some((part) => part.type === 'image_url')
  ));
}

export function ensureModelAcceptsMessageModalities(
  config: Pick<ApiConfig, 'id' | 'isMultimodal'>,
  messages: LegacyChatMessageLike[],
): AppError | null {
  if (chatMessagesRequireMultimodal(messages) && !config.isMultimodal) {
    return AppError.configuration(
      `当前请求包含图片，但模型配置 ${config.id} 不支持多模态输入`,
    );
  }
  return null;
}

/** 可取消的未来：取消时必须执行 drop 回调（对应 Rust future drop）。 */
export interface CancellableFuture<T> {
  promise: Promise<T>;
  cancel: () => void;
}

/**
 * 视觉观察与取消竞争，取消优先（Rust `tokio::select! biased`）。
 * 取消时调用 `cancel()` 丢弃供应商 future，再返回 cancelled 错误。
 */
export function awaitVisualObservationOrCancel<T>(
  signal: AbortSignal,
  future: CancellableFuture<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      future.cancel();
      reject(AppError.llm('visual observation cancelled'));
      return;
    }
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      try {
        future.cancel();
      } catch { // boundary-allow empty-catch: Rust 取消时丢弃 future（tokio::select 分支），无日志
      }
      reject(AppError.llm('visual observation cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void future.promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : AppError.llm(String(error)));
      },
    );
  });
}

export { asArray };
