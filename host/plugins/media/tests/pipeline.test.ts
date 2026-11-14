/**
 * `dstu-media/src/media/pipeline.rs` tests: decode → VAD planning through the
 * production `decodeAndPlan` helper (nativeAudio decoder + lane VAD/spool).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { audio as nativeAudio } from '../../../platform/native/audio/index.ts';
import { decodeAndPlan, estimateSegments } from '../src/pipeline.ts';
import { lectureWav } from './helpers/wav-fixture.ts';

let dir: string;

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'media-pipeline-')); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('decode_and_plan_produces_spans', async () => {
  const path = join(dir, 'lecture.wav');
  lectureWav(path, [
    [0.5, false],
    [2.0, true],
    [1.5, false],
    [3.0, true],
    [0.5, false],
  ], 44_100);

  const decoded = await decodeAndPlan(nativeAudio, path, 'wav', null, undefined, () => {});
  try {
    expect(decoded.durationMs).toBe(7_500);
    expect(decoded.spans.length).toBe(2);
    expect(decoded.spool.durationMs()).toBe(7_500);
  } finally {
    decoded.spool.close();
  }
});

it('estimate_segments_matches_decode_and_plan', async () => {
  const path = join(dir, 'estimate.wav');
  lectureWav(path, [
    [0.5, false],
    [2.0, true],
    [2.0, false],
    [2.0, true],
  ], 22_050);

  const [durationMs, planned] = await estimateSegments(nativeAudio, path, 'wav', undefined);
  expect(durationMs).toBe(6_500);
  expect(planned).toBe(2);
});
