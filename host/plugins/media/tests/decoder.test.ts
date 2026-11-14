/**
 * Rust oracle: `dstu-media/src/media/decoder.rs` tests. The decoder itself is
 * published by F7 as `nativeAudio` (the same symphonia 0.5.5 code compiled to
 * WASI); these tests assert the Rust decoder facts through that production
 * engine plus this lane's error mapping in `pipeline.ts`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { audio as nativeAudio } from '../../../platform/native/audio/index.ts';
import { MediaError } from '../src/errors.ts';
import { decodeAndPlan } from '../src/pipeline.ts';
import { tone, writeWav } from './helpers/wav-fixture.ts';

let dir: string;

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'media-decoder-')); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function pcmOf(chunks: readonly Int16Array[]): Int16Array {
  const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Int16Array(samples);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

it('decodes_stereo_44k_wav_to_mono_16k_on_grid', async () => {
  const path = join(dir, 'a.wav');
  // 立体声：左声道 440 Hz，右声道静音 → 单声道幅度减半
  const mono = tone(44_100, 2.5, 440, 0.6);
  const stereo: number[] = [];
  for (const sample of mono) { stereo.push(sample); stereo.push(0); }
  writeWav(path, 44_100, 2, stereo);

  const chunks: Int16Array[] = [];
  const report = await nativeAudio.decodeToMono16k(path, {
    extensionHint: 'wav',
    onProgress: () => {},
    sink: (pcm) => { chunks.push(pcm); },
  });
  expect(report.source_rate).toBe(44_100);
  expect(report.source_channels).toBe(2);
  const pcm = pcmOf(chunks);
  expect(pcm.length).toBe(report.samples);
  // 2.5 s → 恰好 40000 个 16 kHz 采样（网格长度 = ceil(n_in * 16000 / 44100)）
  expect(pcm.length).toBe(40_000);
  expect(report.duration_ms).toBe(2_500);
  let peak = 0;
  for (let i = 1_000; i < 39_000; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
  expect(Math.abs(peak - Math.trunc(0.3 * 32767))).toBeLessThan(600);
});

it('probe_reports_duration_without_decoding', async () => {
  const path = join(dir, 'b.wav');
  writeWav(path, 8_000, 1, tone(8_000, 3.0, 300, 0.5));
  const info = await nativeAudio.probe(path, 'wav');
  expect(info.duration_ms).toBe(3_000);
  expect(info.sample_rate).toBe(8_000);
});

it('garbage_is_reported_as_unsupported', async () => {
  const path = join(dir, 'c.bin');
  writeFileSync(path, Buffer.alloc(4_096, 0x5a));
  const error = await decodeAndPlan(nativeAudio, path, null, null, undefined, () => {})
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(MediaError);
  expect((error as MediaError).code).toBe('media-unsupported');
  expect((error as Error).message).toContain('MP4');
});

it('cancellation_stops_decoding', async () => {
  const path = join(dir, 'd.wav');
  writeWav(path, 16_000, 1, tone(16_000, 5.0, 300, 0.5));
  const controller = new AbortController();
  controller.abort();
  const error = await decodeAndPlan(nativeAudio, path, 'wav', null, controller.signal, () => {})
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(MediaError);
  expect((error as MediaError).code).toBe('cancelled');
  expect((error as Error).message).toBe('已取消');
});
