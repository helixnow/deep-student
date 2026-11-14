/**
 * `dstu-storage/src/file_manager.rs::image_quality_tests::bytes_quality_matches_base64_policy_and_limits_dimensions`.
 *
 * 真实 `image` 0.24.9 wasm 编解码器（F7 `nativeImage` 的同一实现）提供 PNG 输入与 JPEG
 * 输出；策略层仍是 F3 的 `adjustImageQualityBytes/adjustImageQualityBase64`，不使用替身。
 */
import { describe, expect, it } from 'vitest';
import { image } from '../../native/image/index.ts';
import { adjustImageQualityBase64, adjustImageQualityBytes } from '../file-manager.ts';

function solidRgb(width: number, height: number): { width: number; height: number; rgba: Uint8Array } {
  const rgba = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba[offset + 3] = 255;
  return { width, height, rgba };
}

describe('file_manager.rs image_quality_tests', () => {
  it('bytes_quality_matches_base64_policy_and_limits_dimensions', async () => {
    const png = await image.encode(solidRgb(1200, 900), { format: 'png' });

    const bytes = await adjustImageQualityBytes(png, 'low', image);
    expect([...bytes.slice(0, 2)]).toEqual([255, 216]);
    expect(await image.dimensions(bytes)).toEqual({ width: 768, height: 576 });

    const baseline = Buffer.from(png).toString('base64');
    const encoded = await adjustImageQualityBase64(baseline, 'low', image);
    expect(new Uint8Array(Buffer.from(encoded, 'base64'))).toEqual(bytes);
  });
});
