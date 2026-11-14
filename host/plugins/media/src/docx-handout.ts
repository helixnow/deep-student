/**
 * `dstu-docs/src/docx_handout.rs`: image decoding and EMU fitting for the handout
 * docx layout. Actual DOCX rendering needs the docx-rs/macro package writers and
 * native image re-encoding, so the handout export commands stay unregistered.
 */
import { decodeBase64Standard } from './base64.ts';

export const PAGE_W = 11906;
export const PAGE_H = 16838;
export const MARGIN_TOP = 2098;
export const MARGIN_BOTTOM = 1984;
export const MARGIN_LEFT = 1587;
export const MARGIN_RIGHT = 1474;
export const HANDOUT_CONTENT_W = PAGE_W - MARGIN_LEFT - MARGIN_RIGHT;
export const DEFAULT_CONTENT_W = 11906 - 1701 * 2;
export const LINE_EXACT_28 = 560;
export const EMU_PER_TWIP = 635;
export const EMU_PER_PX = 9525;

/** 解码 base64（容忍 data URL 前缀与空白）。 */
export function decodeImageData(data: string): Uint8Array | null {
  const index = data.indexOf('base64,');
  const raw = index >= 0 && data.startsWith('data:') ? data.slice(index + 'base64,'.length) : data;
  const compact = raw.replace(/\p{White_Space}/gu, '');
  try { return decodeBase64Standard(compact); }
  catch { return null; }
}

/** 按版心宽等比缩放后的显示尺寸（EMU）。 */
export function fitEmu(widthPx: number, heightPx: number, contentWTWips: number): [number, number] {
  const maxW = Math.max(contentWTWips, 1) * EMU_PER_TWIP;
  const w = Math.max(widthPx, 1) * EMU_PER_PX;
  const h = Math.max(heightPx, 1) * EMU_PER_PX;
  if (w <= maxW) return [w, h];
  const scaledH = Math.trunc((h * maxW) / w);
  return [maxW, Math.max(scaledH, 1)];
}
