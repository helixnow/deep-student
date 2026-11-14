import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { AnchorEdgeRecord, ExcerptDragInput } from '@/ui-kernel/contracts/interop';
import type { TranscriptCue } from '../mediaInteropBridge';
import {
  MINERAL_DARK_BRANCH_PALETTE,
  MAX_KEYFRAME_DATA_URL_LENGTH,
  MINERAL_LIGHT_BRANCH_PALETTE,
  captureVideoKeyframeDataUrl,
  computeKeyframeDimensions,
  enrichMediaExcerptWithKeyframe,
  resolveCueBranchTintMap,
  useMediaTintDarkTheme,
  type CueTintEdgeInput,
} from '../mediaKeyframeExcerpt';

function makeMockVideo(params: {
  videoWidth?: number;
  videoHeight?: number;
  readyState?: number;
}): HTMLVideoElement {
  return {
    videoWidth: params.videoWidth ?? 1920,
    videoHeight: params.videoHeight ?? 1080,
    readyState: params.readyState ?? 3,
  } as unknown as HTMLVideoElement;
}

function makeEdge(overrides: Partial<CueTintEdgeInput> = {}): CueTintEdgeInput {
  const base: AnchorEdgeRecord = {
    edgeId: 'edge-1',
    sourceKind: 'mindmap',
    sourceResourceId: 'mm-calculus',
    sourceSubId: 'node-branch-a',
    sourceAnchorUri: 'ds-anchor://v1/mindmap/mm-calculus?node=node-branch-a',
    sourceLabel: '泰勒公式展开条件',
    targetKind: 'media',
    targetResourceId: 'video-lec-03',
    targetAnchorUri: 'ds-anchor://v1/media/video-lec-03?t=12000&end=18000',
    targetLocatorKey: 'ms:12000',
    targetStartMs: 12000,
    targetEndMs: 18000,
    createdAt: 1000,
    updatedAt: 1000,
  };
  return { ...base, ...overrides };
}

describe('mediaKeyframeExcerpt — video keyframe snapshot & cross-origin safety (C7 §2.2)', () => {
  it('falls back to text for zero-size video, drawImage SecurityError, or an oversized thumbnail', () => {
    const createCanvas = vi.fn(() => ({
      getContext: () => ({ drawImage: () => { throw new DOMException('CORS', 'SecurityError'); } }),
      toDataURL: vi.fn(),
    }) as unknown as HTMLCanvasElement);
    expect(captureVideoKeyframeDataUrl(makeMockVideo({ videoWidth: 0 }), { createCanvas })).toBeNull();
    expect(createCanvas).not.toHaveBeenCalled();
    expect(captureVideoKeyframeDataUrl(makeMockVideo({}), { createCanvas })).toBeNull();
    const oversized = `data:image/jpeg;base64,${'A'.repeat(MAX_KEYFRAME_DATA_URL_LENGTH)}`;
    const excerpt: ExcerptDragInput = { excerptKind: 'transcript-cue', text: '字幕', anchor: { kind: 'media', resourceId: 'm', startMs: 0 } };
    expect(enrichMediaExcerptWithKeyframe(excerpt, null, { keyframeDataUrl: oversized })).toBe(excerpt);
    expect(captureVideoKeyframeDataUrl(makeMockVideo({}), { createCanvas: () => ({
      getContext: () => ({ drawImage: vi.fn() }), toDataURL: () => oversized,
    }) as unknown as HTMLCanvasElement })).toBeNull();
  });
  it('scales keyframe dimensions preserving aspect ratio within maxWidth/maxHeight', () => {
    expect(computeKeyframeDimensions(1920, 1080, 320)).toEqual({ width: 320, height: 180 });
    expect(computeKeyframeDimensions(240, 180, 320)).toEqual({ width: 240, height: 180 });
    expect(computeKeyframeDimensions(1000, 2000, 320, 200)).toEqual({ width: 100, height: 200 });
    expect(computeKeyframeDimensions(0, 1080, 320)).toBeNull();
  });

  it('captures scaled JPEG data URL from a ready video element', () => {
    const drawImage = vi.fn();
    const toDataURL = vi.fn(
      () => 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgID',
    );
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toDataURL,
    } as unknown as HTMLCanvasElement;

    const video = makeMockVideo({ videoWidth: 1280, videoHeight: 720, readyState: 4 });
    const dataUrl = captureVideoKeyframeDataUrl(video, {
      maxWidth: 320,
      quality: 0.78,
      createCanvas: () => canvas,
    });

    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(180);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 320, 180);
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.78);
    expect(dataUrl).toContain('data:image/jpeg;base64,');
  });

  it('returns null cleanly without throwing on unready video, missing 2D context, or tainted cross-origin SecurityError', () => {
    expect(captureVideoKeyframeDataUrl(null)).toBeNull();
    expect(
      captureVideoKeyframeDataUrl(makeMockVideo({ readyState: 1 })),
    ).toBeNull();

    const noCtxCanvas = {
      width: 0,
      height: 0,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    expect(
      captureVideoKeyframeDataUrl(makeMockVideo({ readyState: 3 }), {
        createCanvas: () => noCtxCanvas,
      }),
    ).toBeNull();

    const taintedCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toDataURL: () => {
        throw new DOMException('Tainted canvases may not be exported.', 'SecurityError');
      },
    } as unknown as HTMLCanvasElement;
    expect(() =>
      captureVideoKeyframeDataUrl(makeMockVideo({ readyState: 3 }), {
        createCanvas: () => taintedCanvas,
      }),
    ).not.toThrow();
    expect(
      captureVideoKeyframeDataUrl(makeMockVideo({ readyState: 3 }), {
        createCanvas: () => taintedCanvas,
      }),
    ).toBeNull();
  });

  it('enriches media cue excerpt with keyframe or falls back non-destructively to transcript-cue', () => {
    const baseExcerpt: ExcerptDragInput = {
      excerptKind: 'transcript-cue',
      text: '利用佩亚诺余项求极限时需注意阶数匹配。',
      anchor: {
        kind: 'media',
        resourceId: 'video-lec-03',
        startMs: 12000,
        endMs: 18000,
      },
    };

    const validThumb =
      'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgID';
    const enriched = enrichMediaExcerptWithKeyframe(baseExcerpt, null, {
      keyframeDataUrl: validThumb,
    });
    expect(enriched.excerptKind).toBe('region-image');
    expect(enriched.imageDataUrl).toBe(validThumb);
    expect(enriched.text).toBe(baseExcerpt.text);

    // Disabled keyframe or cross-origin null capture preserves original transcript-cue payload.
    const disabled = enrichMediaExcerptWithKeyframe(baseExcerpt, null, {
      includeKeyframe: false,
      keyframeDataUrl: validThumb,
    });
    expect(disabled).toBe(baseExcerpt);

    const fallback = enrichMediaExcerptWithKeyframe(baseExcerpt, null);
    expect(fallback).toBe(baseExcerpt);
    expect(fallback.excerptKind).toBe('transcript-cue');
  });
});

describe('resolveCueBranchTintMap — Mineral Zen branch accent & wash tints (C7 §2.2)', () => {
  afterEach(() => { cleanup(); document.documentElement.classList.remove('dark'); });

  it('reacts to document theme changes and adapts the wash contrast', async () => {
    const { result } = renderHook(useMediaTintDarkTheme);
    expect(result.current).toBe(false);
    await act(async () => { document.documentElement.classList.add('dark'); });
    expect(result.current).toBe(true);
    expect(resolveCueBranchTintMap([makeEdge({ branchColorToken: 'celadon' })], { dark: result.current }).get('ms:12000'))
      .toMatchObject({ accentColor: MINERAL_DARK_BRANCH_PALETTE[3], tintBackground: 'rgba(94, 168, 147, 0.14)' });
  });

  it('tints all overlapping point cues and excludes touching endMs boundaries', () => {
    const overlapping = [{ idx: 1, startMs: 1000, endMs: 3000 }, { idx: 2, startMs: 1500, endMs: 4000 }, { idx: 3, startMs: 4000, endMs: 5000 }];
    const point = makeEdge({ targetStartMs: 2000, targetEndMs: undefined, targetAnchorUri: 'ds-anchor://v1/media/m?t=2000' });
    expect([...resolveCueBranchTintMap([point], overlapping).keys()]).toEqual([1, 2]);
    const window = { ...point, targetEndMs: 4000 };
    expect([...resolveCueBranchTintMap([window], overlapping).keys()]).toEqual([1, 2]);
  });

  it('uses newest duplicate edge and breaks equal-timestamp branch priority by edgeId, not query order', () => {
    const a = makeEdge({ edgeId: 'a', updatedAt: 10, branchColorToken: 'amber' });
    const b = makeEdge({ edgeId: 'b', updatedAt: 10, branchColorToken: 'purple' });
    for (const edges of [[a, b], [b, a]]) {
      expect(resolveCueBranchTintMap(edges).get('ms:12000'))
        .toMatchObject({ branchColorToken: 'amber', edgeCount: 2 });
    }
    const newerA = { ...a, updatedAt: 20, branchColorToken: 'rose' };
    expect(resolveCueBranchTintMap([a, newerA, b]).get('ms:12000'))
      .toMatchObject({ branchColorToken: 'rose', edgeCount: 2 });
  });
  const cues: TranscriptCue[] = [
    { idx: 0, startMs: 0, endMs: 5000, text: '课程导引' },
    { idx: 1, startMs: 10000, endMs: 15000, text: '泰勒展开式定义' },
    { idx: 2, startMs: 15000, endMs: 20000, text: '拉格朗日余项估计' },
    { idx: 3, startMs: 30000, endMs: 35000, text: '典型反例分析' },
  ];

  it('resolves locator-keyed Map<string, CueBranchTint> with Mineral tokens and dark-mode adaptation', () => {
    const celadonEdge = makeEdge({
      edgeId: 'edge-celadon',
      branchColorToken: 'celadon',
      targetLocatorKey: 'ms:12000',
      targetStartMs: 12000,
    });
    const uriColoredEdge = makeEdge({
      edgeId: 'edge-uri-slate',
      sourceAnchorUri:
        'ds-anchor://v1/mindmap/mm-calculus?node=node-2&p.branchColorToken=slate',
      targetLocatorKey: 'ms:30500',
      targetStartMs: 30500,
      targetEndMs: undefined,
    });

    const lightMap = resolveCueBranchTintMap([celadonEdge, uriColoredEdge]);
    expect(lightMap.get('ms:12000')).toMatchObject({
      accentColor: MINERAL_LIGHT_BRANCH_PALETTE[3],
      branchColorToken: 'celadon',
      tintBackground: 'rgba(42, 111, 94, 0.1)',
      edgeCount: 1,
    });
    expect(lightMap.get('ms:30500')?.accentColor).toBe(MINERAL_LIGHT_BRANCH_PALETTE[4]);

    const darkMap = resolveCueBranchTintMap([celadonEdge], { dark: true });
    expect(darkMap.get('ms:12000')?.accentColor).toBe(MINERAL_DARK_BRANCH_PALETTE[3]);
  });

  it('resolves cue-indexed Map<number, CueBranchTint> across [startMs, endMs) spans, +/-2000ms tolerance, and branch color updates', () => {
    // Span [12000, 18000) overlaps cues 1 ([10000, 15000)) and 2 ([15000, 20000)).
    const spanEdgeOlder = makeEdge({
      edgeId: 'edge-span-1',
      branchColorToken: 'amber',
      targetStartMs: 12000,
      targetEndMs: 18000,
      updatedAt: 100,
    });
    // Newer edge on cue 2 updates primary accent color when MindMap branch color changes.
    const cue2Newer = makeEdge({
      edgeId: 'edge-span-2',
      sourceSubId: 'node-branch-b',
      branchColorToken: 'purple',
      targetStartMs: 16000,
      targetEndMs: 19000,
      updatedAt: 250,
    });
    // Point timestamp 28800ms (no endMs) lands within +/-2000ms tolerance of cue 3 ([30000, 35000)).
    const pointNearCue3 = makeEdge({
      edgeId: 'edge-point-3',
      targetAnchorUri: 'ds-anchor://v1/media/video-lec-03?t=28800',
      targetLocatorKey: 'ms:28800',
      targetStartMs: 28800,
      targetEndMs: undefined,
    });

    const cueTintMap = resolveCueBranchTintMap(
      [spanEdgeOlder, cue2Newer, pointNearCue3],
      cues,
    );

    expect(cueTintMap.has(0)).toBe(false);
    expect(cueTintMap.get(1)?.accentColor).toBe(MINERAL_LIGHT_BRANCH_PALETTE[2]);
    expect(cueTintMap.get(2)?.accentColor).toBe(MINERAL_LIGHT_BRANCH_PALETTE[5]);
    expect(cueTintMap.get(2)?.edgeCount).toBe(2);
    expect(cueTintMap.get(2)?.allAccentColors).toEqual([
      MINERAL_LIGHT_BRANCH_PALETTE[2],
      MINERAL_LIGHT_BRANCH_PALETTE[5],
    ]);
    // Deterministic FNV-1a Mineral palette fallback on cue 3
    expect(MINERAL_LIGHT_BRANCH_PALETTE).toContain(
      cueTintMap.get(3)?.accentColor as (typeof MINERAL_LIGHT_BRANCH_PALETTE)[number],
    );
  });
});
