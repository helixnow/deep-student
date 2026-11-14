import path from 'node:path';
import { expect, it } from 'vitest';
import type { AppError } from '../../errors/api.ts';
import {
  adjustImageQualityBase64,
  adjustImageQualityBytes,
  portableRelativePath,
  resolveNoteAssetsDir,
  validateNoteAssetPathSegment,
  type ImageQualityCodec,
} from '../file-manager.ts';

function errorOf(fn: () => void): AppError {
  try { fn(); }
  catch (error) { return error as AppError; }
  throw new Error('expected validation error');
}

interface CodecCall {
  bytes: Uint8Array;
  maxDimension: number;
  quality: number;
}

function recordingCodec(
  size: { width: number; height: number },
  output = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
): { codec: ImageQualityCodec; calls: CodecCall[]; dimensionsCalls: number } {
  const calls: CodecCall[] = [];
  const state = { dimensionsCalls: 0 };
  return {
    calls,
    get dimensionsCalls() { return state.dimensionsCalls; },
    codec: {
      async dimensions() {
        state.dimensionsCalls++;
        return size;
      },
      async resizeAndEncodeJpeg(bytes, options) {
        calls.push({ bytes, ...options });
        return output;
      },
    },
  };
}

it('rejects_traversal_subject_and_note_id', () => {
  expect(errorOf(() => validateNoteAssetPathSegment('subject', '..')).message).toContain('subject 非法');
  expect(errorOf(() => validateNoteAssetPathSegment('subject', '../x')).message).toContain('不允许包含路径分隔符');
  expect(errorOf(() => validateNoteAssetPathSegment('note_id', 'a/b')).message).toContain('note_id 不允许包含路径分隔符');
  expect(errorOf(() => validateNoteAssetPathSegment('note_id', 'a\\b')).message).toContain('note_id 不允许包含路径分隔符');
  expect(errorOf(() => validateNoteAssetPathSegment('subject', 'C:')).message).toContain('subject 含盘符前缀');
  expect(errorOf(() => validateNoteAssetPathSegment('subject', '/abs')).message).toContain('subject 不允许包含路径分隔符');
});

it('accepts_plain_segments', () => {
  expect(() => validateNoteAssetPathSegment('subject', 'math')).not.toThrow();
  expect(() => validateNoteAssetPathSegment('note_id', '550e8400-e29b-41d4-a716-446655440000')).not.toThrow();
});

it('serializes_relative_asset_paths_with_forward_slashes', () => {
  const value = 'notes_assets\\_global\\note-1\\image.png';
  expect(portableRelativePath(value)).toBe('notes_assets/_global/note-1/image.png');
  expect(resolveNoteAssetsDir('/tmp/app-data', 'math', 'note-1')).toBe(path.join('/tmp/app-data', 'notes_assets', 'math', 'note-1'));
});

it('resolve_note_assets_dir accepts segments that merely start with ".." (only ".." itself climbs out)', () => {
  expect(resolveNoteAssetsDir('/tmp/app-data', '..math', 'note-1')).toBe(path.join('/tmp/app-data', 'notes_assets', '..math', 'note-1'));
  expect(() => resolveNoteAssetsDir('/tmp/app-data', '..', 'note-1')).toThrow();
  expect(() => resolveNoteAssetsDir('/tmp/app-data', 'math', '../x')).toThrow();
});

it('image_quality_policy_returns_original_on_noop_invalid_or_encode_failure', async () => {
  const image = Uint8Array.from([1, 2, 3, 4]);
  const recorder = recordingCodec({ width: 64, height: 32 });
  for (const quality of ['high', 'low', 'medium', 'auto', 'unknown']) {
    await expect(adjustImageQualityBytes(image, quality, recorder.codec)).resolves.toBe(image);
  }
  // `high` returns before decode; the other four qualities decode, then no-op.
  expect(recorder.dimensionsCalls).toBe(4);
  expect(recorder.calls).toEqual([]);

  const invalid = new TextEncoder().encode('not an image');
  const invalidCodec: ImageQualityCodec = {
    async dimensions() { throw new Error('image decode failed'); },
    async resizeAndEncodeJpeg() { throw new Error('must not encode invalid input'); },
  };
  await expect(adjustImageQualityBytes(invalid, 'low', invalidCodec)).resolves.toBe(invalid);

  const encodeInput = Uint8Array.from([4, 3, 2, 1]);
  const encodeFailure: ImageQualityCodec = {
    async dimensions() { return { width: 1200, height: 900 }; },
    async resizeAndEncodeJpeg() { throw new Error('jpeg encode failed'); },
  };
  await expect(adjustImageQualityBytes(encodeInput, 'low', encodeFailure)).resolves.toBe(encodeInput);

  const base64 = Buffer.from(image).toString('base64');
  await expect(adjustImageQualityBase64('not base64!', 'low', recorder.codec)).resolves.toBe('not base64!');
  await expect(adjustImageQualityBase64(base64, 'high', recorder.codec)).resolves.toBe(base64);
});

it('auto_quality_uses_rust_megapixel_thresholds', async () => {
  const cases = [
    { size: { width: 2048, height: 2048 }, expected: { maxDimension: 768, quality: 60 } },
    { size: { width: 2000, height: 2000 }, expected: { maxDimension: 1024, quality: 75 } },
    { size: { width: 1600, height: 1600 }, expected: { maxDimension: 1024, quality: 75 } },
    { size: { width: 2000, height: 1000 }, expected: null },
    { size: { width: 1400, height: 1400 }, expected: null },
  ];
  for (const { size, expected } of cases) {
    const input = Uint8Array.from([7, 8, 9]);
    const output = Uint8Array.from([0xff, 0xd8, 0xff]);
    const recorder = recordingCodec(size, output);
    const result = await adjustImageQualityBytes(input, 'auto', recorder.codec);
    if (expected === null) {
      expect(result).toBe(input);
      expect(recorder.calls).toEqual([]);
    } else {
      expect(result).toBe(output);
      expect(recorder.calls).toEqual([{ bytes: input, ...expected }]);
    }
  }
});

it('image_quality_policy_forwards_max_dimension_and_quality_before_encoding', async () => {
  const input = new Uint8Array(1200 * 900).fill(1);
  const output = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  const recorder = recordingCodec({ width: 1200, height: 900 }, output);
  await expect(adjustImageQualityBytes(input, 'low', recorder.codec)).resolves.toBe(output);
  expect(recorder.calls).toHaveLength(1);
  expect(recorder.calls[0]!.bytes).toBe(input);
  expect(recorder.calls[0]!.maxDimension).toBe(768);
  expect(recorder.calls[0]!.quality).toBe(60);

  const base64Input = Buffer.from([9, 8, 7]).toString('base64');
  const base64Recorder = recordingCodec({ width: 1200, height: 900 }, output);
  await expect(adjustImageQualityBase64(base64Input, 'low', base64Recorder.codec))
    .resolves.toBe(Buffer.from(output).toString('base64'));
  expect(base64Recorder.calls[0]!.bytes).toEqual(Uint8Array.from([9, 8, 7]));
});
