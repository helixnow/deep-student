/** L02 translation@1. Request/response fields are the existing Rust wire types. */
import type { Context } from '@deepseek-ai/cordis';
import type {
  ChatTranslationRequest, TranslationRequest, TranslationResponse, TranslationCandidatesResponse,
} from '../../../contracts/ipc/generated/L02-llm-manager.ts';
import type { TranslationToolExecutor } from './src/tool_executor.ts';
export type {
  ChatTranslationRequest, ChatTranslationEvent, TranslationRequest, TranslationResponse,
  TranslationCandidate, TranslationCandidatesResponse, TranslationCandidatesEvent, TranslationEvent,
} from '../../../contracts/ipc/generated/L02-llm-manager.ts';
export type { Context };
/** Shared dstu-translation-core prompt builders for LLMManager's nonstream translation. */
export { buildSystemPrompt, buildUserPrompt } from './src/policy.ts';
export { inferExtensionFromBytes } from './src/ocr_payload.ts';
export type { OcrExtractRuntime } from './src/ocr_extract.ts';
export type { TranslationToolContext, TranslationPersistenceOwner, TranslationMetadataOwner } from './src/tool_executor.ts';

/** dstu-translation-core::TranslationHost effect boundary. */
export interface StreamFailure { message: string; code: string; retriable: boolean }
export type StreamStatus = 'completed' | 'cancelled' | 'incomplete';
export interface SegmentRequest { system_prompt: string; user_prompt: string; timeout_ms: number }
export interface TranslationHost {
  open(): Promise<void>;
  stream(request: SegmentRequest, onChunk: (chunk: string) => void): Promise<StreamStatus>;
  pendingCancel(): Promise<boolean>;
  cleanup(): Promise<void>;
  sleep(ms: number): Promise<void>;
  nowMs(): number;
  timestamp(): string;
  emit(event: import('../../../contracts/ipc/generated/L02-llm-manager.ts').TranslationEvent): void;
}

export interface TranslationService {
  translateTextStream(request: TranslationRequest): Promise<TranslationResponse | null>;
  translateTextCandidates(request: TranslationRequest, numCandidates: number | null): Promise<TranslationCandidatesResponse>;
  cancelTranslationCandidates(sessionId: string): Promise<boolean>;
  streamChatTranslationAligned(request: ChatTranslationRequest): Promise<void>;
  streamChatTranslationPlain(request: ChatTranslationRequest): Promise<void>;
  ocrExtractText(imagePath: string | null, imageBase64: string | null): Promise<string>;
  /** Chat V2 工具执行器（`translate_text` / `translation_result_read` / `translation_save`）。 */
  readonly toolExecutor: TranslationToolExecutor;
}

/** 服务版本描述（`docs/plugins/ARCHITECTURE.md` 附录 A）。 */
export const translationService = { name: 'translation', version: '1.0.0' } as const;

declare module '@deepseek-ai/cordis' {
  interface Context { translation: TranslationService }
}
