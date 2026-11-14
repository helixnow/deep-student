import type { OcrEngineType, OcrMode } from '../../api.ts';
import { AppError, type AppError as AppErrorValue } from '../../../../platform/errors/api.ts';

/** ocr_adapters/types.rs:66 `OcrEngineType::from_str` (unknown falls back to PaddleOCR-VL). */
export function ocrEngineTypeFromStr(text: string): OcrEngineType {
  return tryOcrEngineTypeFromStr(text) ?? 'paddle_ocr_vl';
}

/** ocr_adapters/types.rs:72 `OcrEngineType::try_from_str`. */
export function tryOcrEngineTypeFromStr(text: string): OcrEngineType | undefined {
  switch (text.toLowerCase()) {
    case 'deepseek_ocr': case 'deepseek-ocr': case 'deepseek': return 'deepseek_ocr';
    case 'paddle_ocr_vl': case 'paddleocr-vl': case 'paddleocr_vl': case 'paddle': return 'paddle_ocr_vl';
    case 'paddle_ocr_vl_v1': case 'paddleocr-vl-v1': case 'paddleocr_vl_v1': return 'paddle_ocr_vl_v1';
    case 'glm4v_ocr': case 'glm-4.6v': case 'glm4v': case 'glm-4v': return 'glm4v_ocr';
    case 'generic_vlm': case 'generic': case 'vlm': return 'generic_vlm';
    case 'system_ocr': case 'system': case 'native': return 'system_ocr';
    default: return undefined;
  }
}

/** ocr_adapters/types.rs:103 `OcrEngineType::display_name`. */
export function ocrEngineDisplayName(engine: OcrEngineType): string {
  switch (engine) {
    case 'deepseek_ocr': return 'DeepSeek-OCR';
    case 'paddle_ocr_vl': return 'PaddleOCR-VL-1.5';
    case 'paddle_ocr_vl_v1': return 'PaddleOCR-VL';
    case 'glm4v_ocr': return 'GLM-4.6V';
    case 'generic_vlm': return '通用多模态模型';
    case 'system_ocr': return '系统 OCR';
  }
}

/** ocr_adapters/types.rs:116 `OcrEngineType::recommended_model`. */
export function ocrEngineRecommendedModel(engine: OcrEngineType): string {
  switch (engine) {
    case 'deepseek_ocr': return 'deepseek-ai/DeepSeek-OCR';
    case 'paddle_ocr_vl': return 'PaddlePaddle/PaddleOCR-VL-1.5';
    case 'paddle_ocr_vl_v1': return 'PaddlePaddle/PaddleOCR-VL';
    case 'glm4v_ocr': return 'zai-org/GLM-4.6V';
    case 'generic_vlm': return 'Qwen/Qwen2.5-VL-7B-Instruct';
    case 'system_ocr': return 'system';
  }
}

/** ocr_adapters/types.rs:127 `is_native_ocr`. */
export function isNativeOcrEngine(engine: OcrEngineType): boolean { return engine === 'system_ocr'; }

/** ocr_adapters/types.rs:135 `is_dedicated_ocr`. */
export function isDedicatedOcrEngine(engine: OcrEngineType): boolean {
  return engine === 'deepseek_ocr' || engine === 'paddle_ocr_vl' || engine === 'paddle_ocr_vl_v1' || engine === 'system_ocr';
}

/** ocr_adapters/types.rs:146 `is_import_preferred`. */
export function isImportPreferredOcrEngine(engine: OcrEngineType): boolean { return engine === 'glm4v_ocr'; }

/** ocr_adapters/types.rs:185 `OcrMode::from_str` (unknown falls back to Grounding). */
export function ocrModeFromStr(text: string): OcrMode {
  switch (text.toLowerCase()) {
    case 'grounding': return 'grounding';
    case 'free_ocr': case 'free': case 'markdown': return 'free_ocr';
    case 'formula': return 'formula';
    case 'table': return 'table';
    case 'chart': return 'chart';
    default: return 'grounding';
  }
}

/** ocr_adapters/types.rs:292 `ImageSource`. */
export type OcrImageSource =
  | { type: 'path'; value: string }
  | { type: 'base64'; mime: string; data: string }
  | { type: 'data_url'; value: string };

export const OcrImageSource = {
  fromPath(path: string): OcrImageSource { return { type: 'path', value: path }; },
  fromBase64(mime: string, data: string): OcrImageSource { return { type: 'base64', mime, data }; },
  fromDataUrl(url: string): OcrImageSource { return { type: 'data_url', value: url }; },
  /** ocr_adapters/types.rs:331 `to_data_url`; paths need external file reads. */
  toDataUrl(source: OcrImageSource): string | null {
    if (source.type === 'data_url') return source.value;
    if (source.type === 'base64') return `data:${source.mime};base64,${source.data}`;
    return null;
  },
};

/** ocr_adapters/types.rs:377 `OcrError` plus its Display prefixes. */
export type OcrErrorKind =
  | 'configuration' | 'network' | 'api' | 'parse' | 'rate_limit' | 'image_processing' | 'unsupported';

export class OcrError extends Error {
  readonly kind: OcrErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(kind: OcrErrorKind, message: string, extras: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'OcrError';
    this.kind = kind;
    this.status = extras.status;
    this.retryAfterMs = extras.retryAfterMs;
  }

  static configuration(message: string): OcrError { return new OcrError('configuration', message); }
  static network(message: string): OcrError { return new OcrError('network', message); }
  static api(status: number, message: string): OcrError { return new OcrError('api', message, { status }); }
  static parse(message: string): OcrError { return new OcrError('parse', message); }
  static rateLimit(retryAfterMs?: number): OcrError { return new OcrError('rate_limit', 'rate limit', { retryAfterMs }); }
  static imageProcessing(message: string): OcrError { return new OcrError('image_processing', message); }
  static unsupported(message: string): OcrError { return new OcrError('unsupported', message); }

  /** ocr_adapters/types.rs:385 Display. */
  display(): string {
    switch (this.kind) {
      case 'configuration': return `配置错误: ${this.message}`;
      case 'network': return `网络错误: ${this.message}`;
      case 'api': return `API 错误 (${this.status ?? 0}): ${this.message}`;
      case 'parse': return `解析错误: ${this.message}`;
      case 'rate_limit': return this.retryAfterMs === undefined ? '速率限制' : `速率限制，请在 ${this.retryAfterMs}ms 后重试`;
      case 'image_processing': return `图片处理错误: ${this.message}`;
      case 'unsupported': return `不支持的功能: ${this.message}`;
    }
  }

  /** ocr_adapters/types.rs:405 `From<OcrError> for AppError`. */
  toAppError(): AppErrorValue {
    switch (this.kind) {
      case 'configuration': return AppError.configuration(this.message);
      case 'network': return AppError.network(this.message);
      case 'api': return AppError.llm(`API 错误 (${this.status ?? 0}): ${this.message}`);
      case 'parse': return AppError.llm(`解析错误: ${this.message}`);
      case 'rate_limit': return AppError.llm(this.display());
      case 'image_processing': return AppError.file_system(`图片处理错误: ${this.message}`);
      case 'unsupported': return AppError.configuration(`不支持的功能: ${this.message}`);
    }
  }
}

/** ocr_adapters/types.rs:263 `OcrAdapterConfig` (reserved for the unified OCR service). */
export interface OcrAdapterConfig {
  engine_type: OcrEngineType;
  base_url: string;
  api_key: string;
  model: string;
  /** types.rs:280 `default_adapter`: "openai". */
  model_adapter?: string;
  /** types.rs:277 `#[serde(default)]`: false. */
  verbose_logging?: boolean;
}

/** Request carried by future unified OCR entry points (ocr_adapters/types.rs:202 `OcrRequest`). */
export interface OcrRequest {
  image_source: OcrImageSource;
  /** `OcrMode::default()` is Grounding (types.rs:117, first variant). */
  mode?: OcrMode;
  page_index?: number;
  custom_prompt?: string;
  /** types.rs:213 `default_max_tokens`: 4096. */
  max_tokens?: number;
  temperature?: number;
}
