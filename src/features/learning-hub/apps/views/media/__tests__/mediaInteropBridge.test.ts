/**
 * W06 音视频跨插件互操作桥 + C6 交互顺滑度门槛：
 * 1. buildMediaSemanticAnchor（startMs / endMs 夹逼）与 formatAnchorShortLocator（862000 -> 14:22）
 * 2. groupMediaAnchorEdgesByCue：精确落段 + ±2000ms 最近段容差
 * 3. 拖拽闸门（拖拽中不自动摘录、400ms 去重、退出路径复位）与 revealSeq
 * 4. TranscriptPanel：拖拽把手走 startExcerptDrag、自动摘录点选去重、
 *    反向链接胶囊（等宽、6px 点）、定位脉冲只命中最新请求
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { AnchorRegistry, type AnchorRevealHandler } from '@/ui-kernel/services/anchors';

const { revealMock, startExcerptDragMock, emitAutoExcerptMock, registerRevealMock } = vi.hoisted(() => ({
  revealMock: vi.fn(),
  startExcerptDragMock: vi.fn((_event: unknown, input: unknown) => input),
  emitAutoExcerptMock: vi.fn(),
  registerRevealMock: vi.fn<(kind: 'media', handler: AnchorRevealHandler<'media'>) => () => void>(() => () => {}),
}));
vi.mock('@/ui-kernel/bootstrap', () => ({
  getAppKernel: () => ({
    anchors: { reveal: revealMock, registerAnchorRevealHandler: registerRevealMock },
    dnd: { startExcerptDrag: startExcerptDragMock, emitAutoExcerpt: emitAutoExcerptMock },
  }),
}));
vi.mock('@/utils/clipboardUtils', () => ({ copyTextToClipboard: vi.fn(async () => true) }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('react-i18next', async (importOriginal) => {
  const labels: Record<string, string> = {
    'mediaStudio:interop.backlink_mindmap': '{{count}} 导图',
    'mediaStudio:interop.backlink_flashcard': '{{count}} 闪卡',
    'mediaStudio:interop.backlink_note': '{{count}} 笔记',
  };
  const t = (key: string, options?: { count?: number; time?: string }) => {
    const template = labels[key];
    if (template) return template.replace('{{count}}', String(options?.count ?? ''));
    return options?.time ? `${key} ${options.time}` : key;
  };
  return {
    ...(await importOriginal<typeof import('react-i18next')>()),
    useTranslation: () => ({ t, i18n: { language: 'zh-CN' } }),
  };
});

import {
  AUTO_EXCERPT_DEDUPE_WINDOW_MS,
  backlinkCountParts,
  buildMediaExcerptPayload,
  buildMediaSemanticAnchor,
  createExcerptInteractionGuard,
  createRevealSequencer,
  findCueIndexForMs,
  groupMediaAnchorEdgesByCue,
  mediaAutoExcerptKey,
  sharedMediaExcerptGuard,
  setCompactCueDragImage,
  useMediaAnchorReveal,
} from '../mediaInteropBridge';
import { TranscriptPanel } from '../TranscriptPanel';
import type { TranscriptSegment } from '../mediaTranscriptApi';
import {
  buildAnchorEdgeRecord,
  formatAnchorShortLocator,
  sanitizeExcerptDragPayload,
  type AnchorEdgeRecord,
  type AnchorEdgeSourceKind,
} from '@/ui-kernel/contracts/interop';

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/u;

const cues = [
  { idx: 0, startMs: 0, endMs: 4000 },
  { idx: 1, startMs: 4000, endMs: 9000 },
  { idx: 4, startMs: 65_000, endMs: 70_000 },
];

function edge(sourceKind: AnchorEdgeSourceKind, startMs: number, sourceResourceId: string, label = ''): AnchorEdgeRecord {
  const record = buildAnchorEdgeRecord({
    sourceKind,
    sourceResourceId,
    sourceSubId: 'sub',
    sourceAnchor: sourceKind === 'mindmap'
      ? { kind: 'mindmap', resourceId: sourceResourceId, nodeId: 'node_1' }
      : { kind: 'note', resourceId: sourceResourceId, blockId: 'blk_1' },
    sourceLabel: label,
    targetAnchor: { kind: 'media', resourceId: 'file_lecture', startMs },
  }, 1_000);
  if (!record) throw new Error('fixture edge invalid');
  return record;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  sharedMediaExcerptGuard.reset();
  window.getSelection()?.removeAllRanges();
});

describe('buildMediaSemanticAnchor / payload', () => {
  it('builds startMs / endMs anchors and clamps endMs >= startMs', () => {
    expect(buildMediaSemanticAnchor({
      resourceId: 'file_lecture',
      aliasResourceId: 'src_lecture',
      startMs: 862_000,
      endMs: 869_500,
      quote: '梯度下降的直觉',
      mediaTitle: '机器学习第三讲.mp4',
    })).toEqual({
      kind: 'media',
      resourceId: 'file_lecture',
      aliasResourceId: 'src_lecture',
      label: '机器学习第三讲.mp4',
      startMs: 862_000,
      endMs: 869_500,
      quote: '梯度下降的直觉',
    });
    const clamped = buildMediaSemanticAnchor({ resourceId: 'file_lecture', startMs: 5000.4, endMs: 1000 });
    expect(clamped.startMs).toBe(5000);
    expect(clamped.endMs).toBe(5000);
    expect(buildMediaSemanticAnchor({ resourceId: 'file_lecture', startMs: -20 }).startMs).toBe(0);
  });

  it('formats 862000 ms as 14:22 and hour-long offsets as hh:mm:ss', () => {
    expect(formatAnchorShortLocator(buildMediaSemanticAnchor({ resourceId: 'f', startMs: 862_000 }))).toBe('14:22');
    expect(formatAnchorShortLocator(buildMediaSemanticAnchor({ resourceId: 'f', startMs: 3_725_000 }))).toBe('01:02:05');
  });

  it('produces a transcript-cue payload that passes sanitizeExcerptDragPayload', () => {
    const anchor = buildMediaSemanticAnchor({ resourceId: 'file_lecture', startMs: 4000, endMs: 9000 });
    const payload = buildMediaExcerptPayload({ text: '学习率太大会震荡', anchor, mediaTitle: '第三讲' });
    expect(payload.excerptKind).toBe('transcript-cue');
    const sanitized = sanitizeExcerptDragPayload(payload);
    expect(sanitized?.anchorUri).toContain('t=4000');
    expect(sanitized?.anchorUri).toContain('end=9000');
  });
});

describe('groupMediaAnchorEdgesByCue', () => {
  it('maps edges to the containing cue (start inclusive, end exclusive)', () => {
    expect(findCueIndexForMs(cues, 0)).toBe(0);
    expect(findCueIndexForMs(cues, 4000)).toBe(1);
    expect(findCueIndexForMs(cues, 8999)).toBe(1);
  });

  it('falls back to the nearest cue within ±2000ms and drops edges further away', () => {
    expect(findCueIndexForMs(cues, 10_500)).toBe(1);
    expect(findCueIndexForMs(cues, 63_500)).toBe(4);
    expect(findCueIndexForMs(cues, 30_000)).toBeNull();
  });

  it('aggregates mindmap / flashcard / note counts per cue and dedupes edges', () => {
    const e1 = edge('mindmap', 4500, 'mm_1');
    const grouped = groupMediaAnchorEdgesByCue(cues, [
      e1,
      e1,
      edge('flashcard', 6000, 'card_1'),
      edge('flashcard', 10_800, 'card_2'),
      edge('note', 66_000, 'note_1'),
      edge('note', 40_000, 'note_far'),
    ]);
    expect(grouped.get(1)).toMatchObject({ total: 3, mindmapCount: 1, flashcardCount: 2, noteCount: 0 });
    expect(grouped.get(4)).toMatchObject({ total: 1, noteCount: 1 });
    expect(grouped.has(0)).toBe(false);
    expect(backlinkCountParts(grouped.get(1)!)).toEqual([
      { kind: 'mindmap', count: 1 },
      { kind: 'flashcard', count: 2 },
    ]);
  });

  it('parses targetAnchorUri when targetStartMs is missing', () => {
    const fromUri = { ...edge('mindmap', 66_500, 'mm_uri'), targetStartMs: null };
    expect([...groupMediaAnchorEdgesByCue(cues, [fromUri]).keys()]).toEqual([4]);
  });
});

describe('C6 hygiene for media excerpts', () => {
  it('isolates drag cleanup across cancelled and newly started viewer drags', () => {
    const guard = createExcerptInteractionGuard();
    const disposeA = guard.beginDrag();
    window.dispatchEvent(new Event('blur'));
    const disposeB = guard.beginDrag();
    disposeA();
    expect(guard.isDragging()).toBe(true);
    disposeB();
    expect(guard.isDragging()).toBe(false);
  });

  it('suppresses auto-excerpt during drag and dedupes identical cue excerpts within 400ms', () => {
    let now = 0;
    const guard = createExcerptInteractionGuard({ now: () => now });
    const key = mediaAutoExcerptKey('file_lecture', 4000, '学习率 太大');
    guard.beginDrag();
    expect(guard.shouldEmitAuto(key)).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(guard.isDragging()).toBe(false);
    expect(guard.shouldEmitAuto(key)).toBe(true);
    now += AUTO_EXCERPT_DEDUPE_WINDOW_MS - 1;
    expect(guard.shouldEmitAuto(mediaAutoExcerptKey('file_lecture', 4000, '学习率太大'))).toBe(false);
    now += 2;
    expect(guard.shouldEmitAuto(key)).toBe(true);
  });

  it('keeps only the latest reveal token current', () => {
    const seq = createRevealSequencer();
    const a = seq.next();
    const b = seq.next();
    expect(seq.isCurrent(a)).toBe(false);
    expect(seq.isCurrent(b)).toBe(true);
  });

  it('removes a cancelled drag ghost without needing dragend', () => {
    vi.useFakeTimers();
    const setDragImage = vi.fn();
    setCompactCueDragImage({ setDragImage } as unknown as DataTransfer, '00:04 · excerpt');
    const ghost = setDragImage.mock.calls[0][0] as HTMLElement;
    expect(ghost.isConnected).toBe(true);
    vi.runAllTimers();
    expect(ghost.isConnected).toBe(false);
  });
});

describe('media reveal before loadedmetadata', () => {
  let registry: AnchorRegistry;
  beforeEach(() => {
    registry = new AnchorRegistry();
    registerRevealMock.mockImplementation((kind, handler) => registry.registerAnchorRevealHandler(kind, handler));
  });
  function options(resourceId = 'lecture_a', canSeek = false) {
    return {
      resourceId,
      resourceIds: [resourceId],
      rootRef: { current: document.createElement('div') },
      canSeek,
      isActive: true,
      onRequest: vi.fn(),
      onSeek: vi.fn(() => true),
    };
  }
  it('keeps the last pending timestamp/pulse until metadata permits seeking', async () => {
    const initial = options();
    const view = renderHook((props) => useMediaAnchorReveal(props), { initialProps: initial });
    await act(async () => {
      await registry.reveal({ kind: 'media', resourceId: 'lecture_a', startMs: 1000 });
      await registry.reveal({ kind: 'media', resourceId: 'lecture_a', startMs: 65000 });
    });
    expect(initial.onRequest).toHaveBeenCalledTimes(2);
    expect(initial.onSeek).not.toHaveBeenCalled();
    expect(view.result.current).toBeNull();
    view.rerender({ ...initial, canSeek: true });
    expect(initial.onSeek).toHaveBeenCalledExactlyOnceWith(65);
    expect(view.result.current).toMatchObject({ startMs: 65000 });
  });
  it('isolates mounted media resources, rejects mismatches and drops pending intent on resource switch', async () => {
    const initial = options();
    const first = renderHook((props) => useMediaAnchorReveal(props), { initialProps: initial });
    const secondOptions = options('lecture_b', true);
    renderHook(() => useMediaAnchorReveal(secondOptions));
    await act(async () => {
      await registry.reveal({ kind: 'media', resourceId: 'lecture_a', startMs: 5000 });
      await registry.reveal({ kind: 'media', resourceId: 'lecture_b', startMs: 9000 });
    });
    expect(secondOptions.onSeek).toHaveBeenCalledExactlyOnceWith(9);
    first.rerender({ ...initial, resourceId: 'lecture_c', resourceIds: ['lecture_c'], canSeek: true });
    expect(initial.onSeek).not.toHaveBeenCalled();
    expect((await registry.reveal({ kind: 'media', resourceId: 'lecture_a', startMs: 100 }, { splitIfClosed: false })).ok).toBe(false);
    first.unmount();
    await act(async () => { await registry.reveal({ kind: 'media', resourceId: 'lecture_b', startMs: 10000 }); });
    expect(secondOptions.onSeek).toHaveBeenLastCalledWith(10);
  });
});

describe('TranscriptPanel interop', () => {
  const segments: TranscriptSegment[] = [
    { idx: 0, startMs: 0, endMs: 4000, text: '梯度下降的直觉', status: 'done' },
    { idx: 1, startMs: 4000, endMs: 9000, text: '学习率太大会震荡', status: 'done' },
    { idx: 4, startMs: 65_000, endMs: 70_000, text: '动量法加速收敛', status: 'done' },
  ];

  beforeEach(() => {
    revealMock.mockReset();
    startExcerptDragMock.mockClear();
    emitAutoExcerptMock.mockReset();
  });

  function renderPanel(props: Partial<React.ComponentProps<typeof TranscriptPanel>> = {}) {
    const onSeek = vi.fn();
    const utils = render(React.createElement(TranscriptPanel, {
      segments,
      activeSegmentIdx: -1,
      onSeek,
      status: 'completed',
      progress: null,
      layout: 'side',
      interop: { resourceId: 'file_lecture', aliasResourceId: 'src_lecture', mediaTitle: '第三讲' },
      ...props,
    }));
    return { ...utils, onSeek };
  }

  it('starts an excerpt drag from the cue handle with a compact drag image and resets on dragend', () => {
    renderPanel();
    const handles = screen.getAllByTestId('cue-drag-handle');
    expect(handles).toHaveLength(3);
    const setDragImage = vi.fn();
    fireEvent.dragStart(handles[1], { dataTransfer: { setDragImage, setData: vi.fn(), types: [] } });
    expect(startExcerptDragMock).toHaveBeenCalledTimes(1);
    const input = startExcerptDragMock.mock.calls[0][1] as { anchor: { startMs: number; endMs: number }; text: string };
    expect(input.text).toBe('学习率太大会震荡');
    expect(input.anchor).toMatchObject({ kind: 'media', resourceId: 'file_lecture', startMs: 4000, endMs: 9000 });
    expect(setDragImage).toHaveBeenCalledTimes(1);
    expect(sharedMediaExcerptGuard.isDragging()).toBe(true);
    fireEvent.dragEnd(handles[1]);
    expect(sharedMediaExcerptGuard.isDragging()).toBe(false);
  });

  it('emits auto-excerpt on cue click only when enabled, deduping rapid double clicks', () => {
    const { onSeek, rerender } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /00:04/ }));
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(emitAutoExcerptMock).not.toHaveBeenCalled();

    rerender(React.createElement(TranscriptPanel, {
      segments,
      activeSegmentIdx: -1,
      onSeek,
      status: 'completed',
      progress: null,
      layout: 'side',
      interop: { resourceId: 'file_lecture', mediaTitle: '第三讲', autoExcerptActive: true },
    }));
    const row = screen.getByRole('button', { name: /00:04/ });
    fireEvent.click(row);
    fireEvent.click(row);
    expect(onSeek).toHaveBeenCalledTimes(3);
    expect(emitAutoExcerptMock).toHaveBeenCalledTimes(1);
    expect(emitAutoExcerptMock.mock.calls[0][0]).toMatchObject({
      excerptKind: 'transcript-cue',
      anchor: { kind: 'media', startMs: 4000 },
    });
  });

  it('keeps the full time window when selected transcript rows overlap', () => {
    renderPanel({
      segments: [
        { idx: 0, startMs: 0, endMs: 20000, text: '较长字幕第一行', status: 'done' },
        { idx: 1, startMs: 5000, endMs: 8000, text: '重叠字幕第二行', status: 'done' },
      ],
      interop: { resourceId: 'file_lecture', autoExcerptActive: true },
    });
    const texts = screen.getAllByTestId('cue-drag-handle').map((handle) => handle.closest('[data-cue-index]')!.querySelector('[data-cue-text]')!);
    const range = document.createRange();
    range.setStart(texts[0].firstChild!, 0);
    range.setEnd(texts[1].firstChild!, texts[1].textContent!.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.mouseUp(texts[1]);
    expect(emitAutoExcerptMock).toHaveBeenCalledTimes(1);
    expect(emitAutoExcerptMock.mock.calls[0][0].anchor).toMatchObject({ startMs: 0, endMs: 20000 });
  });

  it('suppresses auto-excerpt while an explicit cue drag is in flight', () => {
    renderPanel({ interop: { resourceId: 'file_lecture', autoExcerptActive: true } });
    fireEvent.dragStart(screen.getAllByTestId('cue-drag-handle')[0], { dataTransfer: { setDragImage: vi.fn(), setData: vi.fn(), types: [] } });
    fireEvent.click(screen.getByRole('button', { name: /00:00/ }));
    expect(emitAutoExcerptMock).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('blur'));
    expect(sharedMediaExcerptGuard.isDragging()).toBe(false);
  });

  it('renders a mono backlink pill with a 6px dot that reveals the consumer', () => {
    const grouped = groupMediaAnchorEdgesByCue(segments, [edge('mindmap', 4200, 'mm_1', '学习率'), edge('flashcard', 30, 'card_1')]);
    const { container } = renderPanel({ cueBacklinks: grouped });
    const pills = screen.getAllByTestId('cue-backlink-pill');
    expect(pills).toHaveLength(2);
    const label = pills[1].querySelector('.font-mono.tabular-nums');
    expect(label?.textContent).toBe('1 导图');
    expect(pills[1].querySelector('.h-1\\.5.w-1\\.5.rounded-full.bg-primary')).not.toBeNull();
    fireEvent.click(pills[1]);
    expect(revealMock).toHaveBeenCalledWith(grouped.get(1)!.edges[0].sourceAnchorUri, { splitIfClosed: true, pulse: true });
    expect(EMOJI_RE.test(container.textContent ?? '')).toBe(false);
  });

  it('pulses only the latest reveal target and clears after 1600ms', () => {
    vi.useFakeTimers();
    const { rerender, container } = renderPanel({ pulsedCue: { startMs: 500, nonce: 1 } });
    const base = {
      segments,
      activeSegmentIdx: -1,
      onSeek: vi.fn(),
      status: 'completed' as const,
      progress: null,
      layout: 'side' as const,
    };
    expect(container.querySelector('[data-cue-index="0"]')?.getAttribute('data-cue-pulse')).toBe('true');
    rerender(React.createElement(TranscriptPanel, { ...base, pulsedCue: { startMs: 66_000, nonce: 2 } }));
    expect(container.querySelector('[data-cue-index="0"]')?.getAttribute('data-cue-pulse')).toBeNull();
    expect(container.querySelector('[data-cue-index="4"]')?.getAttribute('data-cue-pulse')).toBe('true');
    expect(container.querySelector('[data-cue-index="4"]')?.className).toContain('ring-primary/30');
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(container.querySelector('[data-cue-pulse="true"]')).toBeNull();
  });

  it('keeps cue timestamps in font-mono tabular-nums', () => {
    const { container } = renderPanel();
    const stamp = container.querySelector('[data-cue-index="1"] .font-mono.tabular-nums');
    expect(stamp?.textContent).toBe('00:04');
  });

  it('preserves an unresolved pulse until asynchronously loaded transcript cues arrive and clears it on cancellation', () => {
    vi.useFakeTimers();
    const base = { segments: [] as TranscriptSegment[], activeSegmentIdx: -1, onSeek: vi.fn(), status: 'completed' as const, progress: null, layout: 'side' as const };
    const pulsedCue = { startMs: 66000, nonce: 1 };
    const view = render(React.createElement(TranscriptPanel, { ...base, pulsedCue }));
    expect(view.container.querySelector('[data-cue-pulse="true"]')).toBeNull();
    view.rerender(React.createElement(TranscriptPanel, { ...base, segments, pulsedCue }));
    expect(view.container.querySelector('[data-cue-index="4"]')?.getAttribute('data-cue-pulse')).toBe('true');
    view.rerender(React.createElement(TranscriptPanel, { ...base, segments, pulsedCue: null }));
    expect(view.container.querySelector('[data-cue-pulse="true"]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never auto-excerpts a failed cue or one-character cue', () => {
    renderPanel({ interop: { resourceId: 'file_lecture', autoExcerptActive: true }, segments: [
      { ...segments[0], text: '字' },
      { ...segments[1], status: 'failed', text: 'junk error text' },
    ] });
    fireEvent.click(screen.getByRole('button', { name: /00:00/ }));
    fireEvent.click(screen.getByRole('button', { name: /00:04/ }));
    expect(emitAutoExcerptMock).not.toHaveBeenCalled();
  });

  it('does not emit a stale selection when clicking copy or backlink controls', () => {
    renderPanel({ interop: { resourceId: 'file_lecture', autoExcerptActive: true } });
    const text = screen.getByRole('button', { name: /00:04/ }).querySelector('[data-cue-text]')!;
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()!.addRange(range);
    fireEvent.mouseUp(screen.getAllByRole('button', { name: 'learningHub:mediaTranscript.copySegment' })[1]);
    expect(emitAutoExcerptMock).not.toHaveBeenCalled();
    fireEvent.mouseUp(text);
    expect(emitAutoExcerptMock).toHaveBeenCalledTimes(1);
  });

  it('unmounting an unrelated transcript does not cancel another viewer drag', () => {
    const view = renderPanel();
    sharedMediaExcerptGuard.beginDrag();
    view.unmount();
    expect(sharedMediaExcerptGuard.isDragging()).toBe(true);
  });
});
