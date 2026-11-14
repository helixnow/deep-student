import type { BiliError } from '../api.ts';
import type { AppError } from '../../../platform/errors/api.ts';

/** `ExamSheetSessionService` failures: `appError` is the Rust `AppError` wire value. */
export class ExamSheetSessionError extends Error {
  readonly appError: AppError;

  constructor(appError: AppError) {
    super(appError.message);
    this.name = 'ExamSheetSessionError';
    this.appError = appError;
  }
}

const codes = {
  Unsupported: 'media-unsupported', NoAudioTrack: 'media-no-audio-track', Decode: 'media-decode-failed',
  Cancelled: 'cancelled', Io: 'io-failed', Database: 'database-failed', NotFound: 'not-found',
  InvalidInput: 'invalid-input', LinkOnly: 'media-link-only',
} as const;

export class MediaError extends Error {
  readonly code: string;
  readonly transport: BiliError | null;
  constructor(kind: keyof typeof codes | 'AsrFatal' | 'Bilibili' | 'Transport', message: string, detail?: string | BiliError) {
    super(kind === 'Cancelled' ? '已取消' : message);
    this.name = 'MediaError';
    this.transport = kind === 'Transport' ? detail as BiliError : null;
    this.code = kind === 'Transport' ? this.transport!.code : kind === 'AsrFatal' || kind === 'Bilibili'
      ? detail as string : codes[kind];
  }
  toPayloadString(): string {
    return JSON.stringify(this.transport ?? { code: this.code, message: this.message });
  }
}
