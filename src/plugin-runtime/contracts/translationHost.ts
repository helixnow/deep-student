import type { SegmentRequest, StreamStatus, TranslationEvent } from './translation.js';

/** Run-scoped ports. Credentials, SQL connections and Window never cross this boundary. */
export interface TranslationHost {
  open(): Promise<void>;
  stream(request: SegmentRequest, onChunk: (chunk: string) => void): Promise<StreamStatus>;
  pendingCancel(): Promise<boolean>;
  cleanup(): Promise<void>;
  sleep(ms: number): Promise<void>;
  nowMs(): number;
  timestamp(): string;
  emit(event: TranslationEvent): void;
}
