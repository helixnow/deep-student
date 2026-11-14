import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';
import { AudioDecodeError, audio } from '../audio/index.ts';

/** `decoder.rs::tests::write_wav/tone` — same interleaved 16-bit PCM layout. */
function wav(rate: number, channels: number, seconds: number, frequency: number, amplitude: number): Buffer {
  const frames = Math.trunc(rate * seconds);
  const data = Buffer.alloc(frames * channels * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.trunc(amplitude * 32767 * Math.sin(2 * Math.PI * frequency * frame / rate));
    for (let channel = 0; channel < channels; channel += 1) {
      data.writeInt16LE(channel === 0 ? value : 0, (frame * channels + channel) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

let directory: string;
let stereo44k: string;
let mono8k: string;
let garbage: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'f7-audio-test-'));
  stereo44k = join(directory, 'a.wav');
  mono8k = join(directory, 'b.wav');
  garbage = join(directory, 'c.bin');
  await writeFile(stereo44k, wav(44_100, 2, 2.5, 440, 0.6));
  await writeFile(mono8k, wav(8_000, 1, 3, 300, 0.5));
  await writeFile(garbage, Buffer.alloc(4096, 0x5a));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/**
 * Rust oracle: `dstu-media/src/media/decoder.rs` tests.  The engine is the same
 * `symphonia 0.5.5` + `Resampler` code compiled to WASI.
 */
describe('nativeAudio (symphonia 0.5.5 / decoder.rs)', () => {
  it('probe_reports_duration_without_decoding: probes duration without decoding', async () => {
    expect(await audio.probe(mono8k, 'wav')).toEqual({
      duration_ms: 3_000,
      codec: 'pcm_s16le',
      sample_rate: 8_000,
    });
  });

  it('decodes_stereo_44k_wav_to_mono_16k_on_grid: decodes stereo 44.1 kHz to the exact 16 kHz grid', async () => {
    const chunks: Int16Array[] = [];
    const progress: number[] = [];
    const report = await audio.decodeToMono16k(stereo44k, {
      extensionHint: 'wav',
      onProgress: (fraction) => progress.push(fraction),
      sink: (pcm) => { chunks.push(pcm); },
    });
    expect(report).toEqual({
      samples: 40_000,
      duration_ms: 2_500,
      source_rate: 44_100,
      source_channels: 2,
      codec: 'pcm_s16le',
      corrupt_packets: 0,
      filled_silence_ms: 0,
    });
    const pcm = new Int16Array(report.samples);
    let offset = 0;
    for (const chunk of chunks) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }
    expect(offset).toBe(40_000);
    expect(chunks.map((chunk) => chunk.length)).toEqual([16_000, 16_000, 8_000]);
    let peak = 0;
    for (let index = 1_000; index < 39_000; index += 1) {
      peak = Math.max(peak, Math.abs(pcm[index]!));
    }
    expect(Math.abs(peak - 0.3 * 32767)).toBeLessThan(600);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((fraction) => fraction >= 0 && fraction <= 1)).toBe(true);
  });

  it('garbage_is_reported_as_unsupported: reports garbage input as media-unsupported with the MP4 hint', async () => {
    const error = await audio.decodeToMono16k(garbage, {
      onProgress: () => {},
      sink: () => {},
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AudioDecodeError);
    expect(error).toMatchObject({ code: 'media-unsupported' });
    expect((error as Error).message).toContain('MP4');
  });

  it('reports missing files as io-failed with the real host path', async () => {
    const missing = join(directory, 'missing.wav');
    const error = await audio.probe(missing).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'io-failed' });
    expect((error as Error).message).toContain(`无法打开媒体文件 ${missing}:`);
  });

  it('cancellation_stops_decoding: honours an already-aborted signal with the Rust cancellation error', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(audio.decodeToMono16k(stereo44k, {
      signal: controller.signal,
      onProgress: () => {},
      sink: () => {},
    })).rejects.toMatchObject({ code: 'cancelled', message: '已取消' });
  });

  it('is published on the dstu.native plugin together with the other WASI engines', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      expect(host.ctx.nativeAudio).toBe(audio);
      expect(await host.ctx.nativeStarlark.evaluate('1 + 1', {
        limits: { max_callstack_size: 256, max_heap_bytes: 32 * 1024 * 1024, max_tick_count: 1_000_000 },
        signal: new AbortController().signal,
        deadlineMs: Date.now() + 30_000,
        call: async () => null,
        objectRead: async () => null,
        objectWrite: async () => null,
      })).toBe(2);
      const pattern = await host.ctx.nativeRegex.compile('(?i)ok');
      expect(await host.ctx.nativeRegex.isMatch(pattern, 'OK')).toBe(true);
    } finally {
      await host.dispose();
    }
  });
});
