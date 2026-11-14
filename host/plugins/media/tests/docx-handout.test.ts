import { expect, it } from 'vitest';
import {
  EMU_PER_PX, EMU_PER_TWIP, HANDOUT_CONTENT_W, decodeImageData, fitEmu,
} from '../src/docx-handout.ts';

it('decode_accepts_data_url_and_raw', () => {
  const raw = Buffer.from('abc', 'utf8').toString('base64');
  expect(Buffer.from(decodeImageData(raw)!).toString('utf8')).toBe('abc');
  expect(Buffer.from(decodeImageData(`data:image/png;base64,${raw}`)!).toString('utf8')).toBe('abc');
  expect(decodeImageData('%%%')).toBeNull();
});

it('fit_emu_scales_wide_images_to_content_width', () => {
  let [w, h] = fitEmu(100, 50, HANDOUT_CONTENT_W);
  expect([w, h]).toEqual([100 * EMU_PER_PX, 50 * EMU_PER_PX]);
  [w, h] = fitEmu(4000, 2000, HANDOUT_CONTENT_W);
  expect(w).toBe(HANDOUT_CONTENT_W * EMU_PER_TWIP);
  expect(h).toBe(Math.trunc(w / 2));
});
