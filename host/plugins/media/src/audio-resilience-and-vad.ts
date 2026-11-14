/** 纯 PCM / 时间轴算法；解码后端通过 AudioTrackSource 注入。 */
export const PCM_SAMPLE_RATE = 16000;
export function mixPlanarToMono(channels: readonly Float32Array[]): Float32Array {
  const first = channels[0];
  if (first === undefined) return new Float32Array(0);
  if (channels.length === 1) return first;
  const out = new Float32Array(first.length);
  for (const channel of channels) for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) + (channel[i] ?? 0);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / channels.length;
  return out;
}
/** 每段拥有 [ceil(start*16000), ceil(end*16000))，绝不逐帧 floor 长度。 */
export function resampleTo16kS16GlobalGrid(channels: readonly Float32Array[], srcSampleRate: number, srcStartSeconds = 0): Int16Array {
  if (!Number.isFinite(srcSampleRate) || srcSampleRate <= 0) throw new RangeError('采样率必须为正数');
  const input = mixPlanarToMono(channels);
  const grid = srcStartSeconds * PCM_SAMPLE_RATE;
  const start = Math.ceil(grid);
  const end = Math.ceil((srcStartSeconds + input.length / srcSampleRate) * PCM_SAMPLE_RATE);
  const out = new Int16Array(Math.max(0, end - start));
  const ratio = srcSampleRate / PCM_SAMPLE_RATE;
  for (let i = 0; i < out.length; i++) {
    const position = (start + i - grid) * ratio;
    const index = Math.floor(position), fraction = position - index;
    const a = input[index] ?? 0, b = input[index + 1] ?? a;
    const value = Math.max(-1, Math.min(1, a + (b - a) * fraction));
    out[i] = value < 0 ? value * 32768 : value * 32767;
  }
  return out;
}
export function concatS16(chunks: readonly Int16Array[], total: number): Int16Array {
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}
export interface DecodedAudioFrame {
  timestamp: number;
  sampleRate: number;
  channels: readonly Float32Array[];
  close?: () => void;
}
export interface AudioTrackSource {
  /** 每次调用必须重建解码流；失败的解码器不可复用。时间戳始终是媒体绝对时间。 */
  samples(startSeconds: number): AsyncIterable<DecodedAudioFrame>;
}
export interface RecoverInfo { at: number; seconds: number; attempt: number }
export interface ExtractAudioOptions {
  duration?: number;
  onProgress?: (ratio: number) => void;
  onRecover?: (info: RecoverInfo) => void;
}
export interface ExtractAudioResult { pcm: Int16Array; duration: number; skipped: number; recoveries: number }
export class AudioCorruptFrameError extends Error {
  readonly at: number;
  readonly recoveries: number;
  override readonly cause: unknown;
  constructor(at: number, recoveries: number, cause: unknown) {
    const s = Math.max(0, Math.floor(at));
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    super(`音轨第 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} 处有损坏的音频帧（${detail}），已尝试续解 ${recoveries} 次，超过坏帧容忍上限。建议重新下载视频，或用 ffmpeg 转码音轨。`);
    this.name = 'AudioCorruptFrameError';
    this.at = at; this.recoveries = recoveries; this.cause = cause;
  }
}
export function isDecoderFailure(error: unknown): boolean {
  const value = error as { name?: unknown; message?: unknown } | null;
  if (value?.name === 'InputDisposedError' || value?.name === 'AbortError') return false;
  return value?.name === 'EncodingError' || (typeof value?.message === 'string' && /decod/i.test(value.message));
}
const RESUME_GAPS = [0.05, 0.2, 0.5, 1, 2, 5, 10] as const;
export async function extractAudioWithCorruptFrameTolerance(trackSource: AudioTrackSource, options: ExtractAudioOptions = {}): Promise<ExtractAudioResult> {
  const { duration = 0, onProgress, onRecover } = options;
  const chunks: Int16Array[] = [];
  let total = 0, cursor = 0, resumeAt = 0, stuck = 0, recoveries = 0, silentSamples = 0, gapIndex = 0;
  for (;;) {
    let progressed = false;
    try {
      for await (const frame of trackSource.samples(resumeAt)) {
        try {
          const end = frame.timestamp + (frame.channels[0]?.length ?? 0) / frame.sampleRate;
          if (end <= cursor) continue;
          const startIndex = Math.ceil(frame.timestamp * PCM_SAMPLE_RATE);
          const missing = Math.max(0, startIndex - total);
          if ((silentSamples + missing) / PCM_SAMPLE_RATE > 30) {
            throw new AudioCorruptFrameError(cursor, recoveries, new Error('累计补零静音超过 30 秒'));
          }
          if (missing) {
            chunks.push(new Int16Array(missing)); total += missing; silentSamples += missing;
          }
          const pcm = resampleTo16kS16GlobalGrid(frame.channels, frame.sampleRate, frame.timestamp);
          // seek 可能返回覆盖 cursor 的旧帧；只保留尚未写出的网格。
          const fresh = pcm.subarray(Math.max(0, total - startIndex));
          chunks.push(fresh); total += fresh.length;
          cursor = end; progressed = true;
          if (duration > 0) onProgress?.(Math.min(0.99, cursor / duration));
        } finally { frame.close?.(); }
      }
      break;
    } catch (error) {
      if (error instanceof AudioCorruptFrameError || !isDecoderFailure(error)) throw error;
      stuck = progressed ? 0 : stuck + 1;
      gapIndex = progressed || recoveries === 0 ? 0 : Math.min(gapIndex + 1, RESUME_GAPS.length - 1);
      const gap = RESUME_GAPS[gapIndex] ?? 0;
      const next = cursor + gap;
      if (stuck > 7 || recoveries >= 24 || silentSamples / PCM_SAMPLE_RATE + gap > 30 || (duration > 0 && next >= duration)) {
        throw new AudioCorruptFrameError(cursor, recoveries, error);
      }
      recoveries++; resumeAt = next;
      onRecover?.({ at: cursor, seconds: gap, attempt: recoveries });
    }
  }
  onProgress?.(1);
  return { pcm: concatS16(chunks, total), duration: total / PCM_SAMPLE_RATE, skipped: silentSamples / PCM_SAMPLE_RATE, recoveries };
}

export const VAD_OPTIONS = { minSpeechMs: 200, redemptionMs: 300 } as const;
export interface VadSegment { start: number; end: number }
export function mergeVadSegments(raw: readonly VadSegment[]): VadSegment[] {
  const out: VadSegment[] = [];
  for (const segment of raw) {
    const last = out.at(-1);
    if (last && segment.start - last.end < 0.4 && segment.end - last.start <= 8) last.end = segment.end;
    else out.push({ ...segment });
  }
  const merged: VadSegment[] = [];
  for (const segment of out) {
    const last = merged.at(-1);
    // 短尾段也受绝对跨度 8 秒限制，不能只计算两段语音长度而忽略中间空白。
    if (segment.end - segment.start < 0.5 && last && segment.end - last.start <= 8) last.end = segment.end;
    else merged.push({ ...segment });
  }
  return merged;
}
/** Silero legacy：1536 / 16000 = 96ms；正阈值 .3、负阈值 .25。 */
export class SileroTimeline {
  private index = 0;
  private start = 0;
  private count = 0;
  private redemption = 0;
  private speaking = false;
  readonly ranges: VadSegment[] = [];
  accept(probability: number): void {
    const speech = probability >= 0.3;
    if (speech) { this.count++; this.redemption = 0; }
    if (speech && !this.speaking) { this.speaking = true; this.start = this.index * 1536 / 16000; }
    if (probability < 0.25 && this.speaking && ++this.redemption >= Math.ceil(VAD_OPTIONS.redemptionMs / 96)) {
      if (this.count >= Math.ceil(VAD_OPTIONS.minSpeechMs / 96)) this.ranges.push({ start: this.start, end: (this.index + 1) * 1536 / 16000 });
      this.speaking = false; this.count = 0; this.redemption = 0;
    }
    if (!this.speaking) this.count = 0;
    this.index++;
  }
  finish(): VadSegment[] {
    if (this.speaking && this.count >= Math.ceil(VAD_OPTIONS.minSpeechMs / 96)) this.ranges.push({ start: this.start, end: this.index * 1536 / 16000 });
    this.speaking = false;
    return mergeVadSegments(this.ranges);
  }
}
