/** dstu-media/media/decoder.rs; PCM is signed 16-bit mono at 16 kHz. */
export interface AudioProbe { duration_ms: number | null; codec: string; sample_rate: number | null }
export interface AudioDecodeReport {
  samples: number; duration_ms: number; source_rate: number; source_channels: number;
  codec: string; corrupt_packets: number; filled_silence_ms: number;
}
export interface NativeAudio {
  probe(path: string, extensionHint?: string | null): Promise<AudioProbe>;
  decodeToMono16k(path: string, options: {
    extensionHint?: string | null;
    signal?: AbortSignal;
    onProgress(fraction: number): void;
    sink(pcm: Int16Array): void | Promise<void>;
  }): Promise<AudioDecodeReport>;
}
export interface AudioResampler {
  inputPosition(): number;
  outputPosition(): number;
  push(input: Float32Array, output: number[]): void;
  pushSilence(frames: number, output: number[]): void;
  finish(output: number[]): void;
}
export { Resampler, TARGET_RATE } from './resample.ts';

/**
 * `dstu-media` `MediaError` with the stable Rust `code()` values.  The message
 * is the Rust `Display` text (decoder failures include the "请先转为 …" hint).
 */
export class AudioDecodeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AudioDecodeError';
    this.code = code;
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { nativeAudio: NativeAudio }
}
