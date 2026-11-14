import { describe, expect, it } from 'vitest';
import {
  logicalRectContains, maskSignatureFromBoundsAndOcclusions, maskSignaturesEqual,
  type LogicalRect,
} from '../src/macos-surface-clip.ts';

const BOUNDS: LogicalRect = { x: 0, y: 0, width: 800, height: 600 };
const RESIZED_BOUNDS: LogicalRect = { ...BOUNDS, width: 1000 };
const OCCLUSION: LogicalRect = { x: 10, y: 20, width: 30, height: 40 };

describe('crates/dstu-browser/src/browser/window/macos_surface_clip.rs::tests', () => {
  it('clear_mask_signature_ignores_host_bounds', () => {
    expect(maskSignaturesEqual(
      maskSignatureFromBoundsAndOcclusions(BOUNDS, []),
      maskSignatureFromBoundsAndOcclusions(RESIZED_BOUNDS, []),
    )).toBe(true);
  });

  it('shaped_mask_signature_tracks_bounds_and_occlusions', () => {
    const initial = maskSignatureFromBoundsAndOcclusions(BOUNDS, [OCCLUSION]);
    expect(maskSignaturesEqual(initial, maskSignatureFromBoundsAndOcclusions(RESIZED_BOUNDS, [OCCLUSION])))
      .toBe(false);
    expect(maskSignaturesEqual(initial, maskSignatureFromBoundsAndOcclusions(BOUNDS, [{ ...OCCLUSION, width: 31 }])))
      .toBe(false);
  });
});

describe('macos surface clip helpers beyond the Rust unit tests', () => {
  it('compares clear/shaped kinds and containment edges', () => {
    expect(maskSignaturesEqual(
      maskSignatureFromBoundsAndOcclusions(BOUNDS, []),
      maskSignatureFromBoundsAndOcclusions(BOUNDS, [OCCLUSION]),
    )).toBe(false);
    expect(maskSignaturesEqual(
      maskSignatureFromBoundsAndOcclusions(BOUNDS, [OCCLUSION]),
      maskSignatureFromBoundsAndOcclusions(BOUNDS, [{ ...OCCLUSION }]),
    )).toBe(true);
    expect(logicalRectContains(OCCLUSION, { x: 10, y: 20 })).toBe(true);
    expect(logicalRectContains(OCCLUSION, { x: 39.9, y: 59.9 })).toBe(true);
    expect(logicalRectContains(OCCLUSION, { x: 40, y: 60 })).toBe(false);
    expect(logicalRectContains(OCCLUSION, { x: 9.9, y: 20 })).toBe(false);
  });
});
