/**
 * W06 PDF 跨插件互操作桥 + C6 交互顺滑度门槛：
 * 1. 选区包围盒归一化（多行合并、浮点漂移夹逼、无效页面）
 * 2. 摘录载荷 / 语义锚点（coordVersion 2 rect + 1-based page）与按页聚合反向链接
 * 3. 拖拽进行中抑制自动摘录、400ms 去重、dragend / drop / blur / visibilitychange / Escape 全路径复位
 * 4. revealSeq 单调令牌：A → B 连点只有 B 生效；虚拟化页挂载等待；脉冲层 pointer-events: none
 * 5. <PdfPageMarginBacklinks />：等宽计数、6px 点、零 emoji、点击条目走 anchors.reveal
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { revealMock } = vi.hoisted(() => ({ revealMock: vi.fn() }));
vi.mock('@/ui-kernel/bootstrap', () => ({
  getAppKernel: () => ({ anchors: { reveal: revealMock } }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => {
      const labels: Record<string, string> = {
        'pdf:interop.backlink_mindmap': '{{count}} 导图',
        'pdf:interop.backlink_flashcard': '{{count}} 闪卡',
        'pdf:interop.backlink_note': '{{count}} 笔记',
        'pdf:interop.backlinks_popover_title': '本页关联引用',
      };
      const template = labels[key] ?? key;
      return template.replace('{{count}}', String(options?.count ?? ''));
    },
  }),
}));

import {
  AUTO_EXCERPT_DEDUPE_WINDOW_MS,
  buildPdfExcerptPayload,
  buildPdfSemanticAnchor,
  clampRevealPage,
  computeNormalizedSelectionBounds,
  createExcerptInteractionGuard,
  createRevealSequencer,
  groupPdfAnchorEdgesByPage,
  pdfAutoExcerptKey,
  rotateNormalizedRect,
  setCompactDragImage,
  waitForPdfPageElement,
} from '../interop/pdfInteropBridge';
import { PdfPageMarginBacklinks } from '../components/PdfPageMarginBacklinks';
import {
  buildAnchorEdgeRecord,
  sanitizeExcerptDragPayload,
  serializeSemanticAnchor,
  type AnchorEdgeRecord,
  type AnchorEdgeSourceKind,
} from '@/ui-kernel/contracts/interop';

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/u;

function edge(
  sourceKind: AnchorEdgeSourceKind,
  page: number,
  sourceResourceId: string,
  label = '',
): AnchorEdgeRecord {
  const record = buildAnchorEdgeRecord({
    sourceKind,
    sourceResourceId,
    sourceSubId: `${sourceResourceId}_sub`,
    sourceAnchor:
      sourceKind === 'mindmap'
        ? { kind: 'mindmap', resourceId: sourceResourceId, nodeId: 'node_1' }
        : { kind: 'note', resourceId: sourceResourceId, blockId: 'blk_1' },
    sourceLabel: label,
    targetAnchor: { kind: 'pdf', resourceId: 'tb_bio', page },
  }, 1_000);
  if (!record) throw new Error('fixture edge invalid');
  return record;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('computeNormalizedSelectionBounds', () => {
  const page = { left: 100, top: 200, width: 400, height: 800 };

  it('unions multi-line client rects into [0, 1] page coordinates', () => {
    const rect = computeNormalizedSelectionBounds(
      [
        { left: 140, top: 280, width: 200, height: 16 },
        { left: 120, top: 300, width: 300, height: 16 },
        { left: 120, top: 320, width: 80, height: 16 },
      ],
      page,
    );
    expect(rect).toBeDefined();
    expect(rect!.x).toBeCloseTo(0.05, 6);
    expect(rect!.y).toBeCloseTo(0.1, 6);
    expect(rect!.w).toBeCloseTo(0.75, 6);
    expect(rect!.h).toBeCloseTo(0.07, 6);
  });

  it('clamps float drift and rects bleeding past the page edge', () => {
    const rect = computeNormalizedSelectionBounds(
      [{ left: 99.9999, top: 199.9999, width: 400.0003, height: 50 }],
      page,
    );
    expect(rect).toEqual({ x: 0, y: 0, w: 1, h: expect.closeTo(0.0625, 3) });
    expect(rect!.x + rect!.w).toBeLessThanOrEqual(1);
  });

  it('returns undefined for invalid pages or empty unions', () => {
    expect(computeNormalizedSelectionBounds([{ left: 0, top: 0, width: 10, height: 10 }], { ...page, width: 0 })).toBeUndefined();
    expect(computeNormalizedSelectionBounds([], page)).toBeUndefined();
    expect(computeNormalizedSelectionBounds([{ left: 120, top: 220, width: 0, height: 12 }], page)).toBeUndefined();
  });

  it('ignores other pages before unioning columns instead of filling empty page whitespace', () => {
    expect(computeNormalizedSelectionBounds([
      { left: 0, top: 0, width: 80, height: 100 },
      { left: 520, top: 1100, width: 80, height: 100 },
    ], page)).toBeUndefined();
    expect(computeNormalizedSelectionBounds([{ left: 100, top: 200, width: 20, height: 20 }], { ...page, width: Infinity })).toBeUndefined();
  });

  it.each([0, 90, 180, 270])('round-trips canonical coordinates under %s degree rotation and zoom', (rotation) => {
    const original = { x: 0.1, y: 0.2, w: 0.3, h: 0.1 };
    const displayed = rotateNormalizedRect(original, rotation)!;
    const restored = rotateNormalizedRect(displayed, -rotation)!;
    for (const key of ['x', 'y', 'w', 'h'] as const) expect(restored[key]).toBeCloseTo(original[key]);
    expect(rotateNormalizedRect({ x: -0.0001, y: 0, w: 1.0002, h: 0.2 }, rotation)).toBeDefined();
  });
});

describe('PDF excerpt payload and anchors', () => {
  it('builds a valid PdfSemanticAnchor (1-based page + coordVersion 2 rect) that survives sanitization', () => {
    const anchor = buildPdfSemanticAnchor({
      resourceId: 'tb_bio',
      aliasResourceId: 'res_vfs_1',
      page: 12,
      rect: { x: 0.12, y: 0.24, w: 0.55, h: 0.08 },
      quote: '  有丝分裂\n是真核细胞的分裂方式  ',
      documentTitle: '生物必修一.pdf',
    });
    expect(anchor).toEqual({
      kind: 'pdf',
      resourceId: 'tb_bio',
      aliasResourceId: 'res_vfs_1',
      label: '生物必修一.pdf',
      page: 12,
      rect: { x: 0.12, y: 0.24, w: 0.55, h: 0.08 },
      quote: '有丝分裂 是真核细胞的分裂方式',
    });
    const payload = buildPdfExcerptPayload({ excerptKind: 'text', text: '有丝分裂', anchor, documentTitle: '生物必修一.pdf' });
    const sanitized = sanitizeExcerptDragPayload(payload);
    expect(sanitized).not.toBeNull();
    expect(sanitized!.anchorUri).toBe(serializeSemanticAnchor(anchor));
    expect(sanitized!.anchorUri).toContain('page=12');
    expect(sanitized!.anchorUri).toContain('rect=0.1200,0.2400,0.5500,0.0800');
    expect(sanitized!.sourceTitle).toBe('生物必修一.pdf');
  });

  it('floors invalid pages to 1 and drops identical alias ids', () => {
    expect(buildPdfSemanticAnchor({ resourceId: 'tb_x', aliasResourceId: 'tb_x', page: 0 })).toEqual({
      kind: 'pdf',
      resourceId: 'tb_x',
      page: 1,
    });
  });

  it('carries image data for region excerpts', () => {
    const anchor = buildPdfSemanticAnchor({ resourceId: 'tb_bio', page: 3 });
    const payload = buildPdfExcerptPayload({
      excerptKind: 'region-image',
      text: '',
      imageDataUrl: 'data:image/png;base64,AAAA',
      anchor,
    });
    expect(payload).toMatchObject({ excerptKind: 'region-image', imageDataUrl: 'data:image/png;base64,AAAA' });
  });
});

describe('groupPdfAnchorEdgesByPage', () => {
  it('aggregates mindmap / flashcard / note counts per page and dedupes edge ids', () => {
    const e1 = edge('mindmap', 12, 'mm_1');
    const edges = [
      e1,
      edge('mindmap', 12, 'mm_2'),
      edge('flashcard', 12, 'card_1'),
      edge('note', 40, 'note_1'),
      e1,
    ];
    const byPage = groupPdfAnchorEdgesByPage(edges);
    expect(byPage.get(12)).toMatchObject({ total: 3, mindmapCount: 2, flashcardCount: 1, noteCount: 0 });
    expect(byPage.get(40)).toMatchObject({ total: 1, noteCount: 1 });
    expect(byPage.has(1)).toBe(false);
  });

  it('falls back to parsing targetAnchorUri when targetPage is null and ignores non-pdf edges', () => {
    const fromUri = { ...edge('flashcard', 218, 'card_x'), targetPage: null };
    const media: AnchorEdgeRecord = { ...edge('note', 1, 'note_m'), edgeId: 'edge_media', targetKind: 'media' };
    const byPage = groupPdfAnchorEdgesByPage([fromUri, media]);
    expect([...byPage.keys()]).toEqual([218]);
    expect(byPage.get(218)?.flashcardCount).toBe(1);
  });
});

describe('C6 drag hygiene: excerpt interaction guard', () => {
  it('does not let a cancelled viewer drag cleanup end a newer viewer drag', () => {
    const guard = createExcerptInteractionGuard();
    const disposeA = guard.beginDrag();
    window.dispatchEvent(new Event('blur'));
    const disposeB = guard.beginDrag();
    disposeA();
    expect(guard.isDragging()).toBe(true);
    disposeB();
    expect(guard.isDragging()).toBe(false);
  });

  it('suppresses auto-excerpt while an explicit drag is active', () => {
    const guard = createExcerptInteractionGuard();
    guard.beginDrag();
    expect(guard.isDragging()).toBe(true);
    expect(guard.shouldEmitAuto(pdfAutoExcerptKey('tb_bio', 3, '光合作用'))).toBe(false);
    guard.endDrag();
    expect(guard.shouldEmitAuto(pdfAutoExcerptKey('tb_bio', 3, '光合作用'))).toBe(true);
    guard.reset();
  });

  it('dedupes identical (resourceId, page, quote) within 400ms but allows other or later excerpts', () => {
    let now = 10_000;
    const guard = createExcerptInteractionGuard({ now: () => now });
    const key = pdfAutoExcerptKey('tb_bio', 3, '光合 作用\n');
    expect(key).toBe(pdfAutoExcerptKey('tb_bio', 3, '光合作用'));
    expect(guard.shouldEmitAuto(key)).toBe(true);
    now += 120;
    expect(guard.shouldEmitAuto(key)).toBe(false);
    expect(guard.shouldEmitAuto(pdfAutoExcerptKey('tb_bio', 4, '光合作用'))).toBe(true);
    expect(guard.shouldEmitAuto(key)).toBe(false);
    now += AUTO_EXCERPT_DEDUPE_WINDOW_MS - 1;
    expect(guard.shouldEmitAuto(key)).toBe(true);
    now += AUTO_EXCERPT_DEDUPE_WINDOW_MS;
    expect(guard.shouldEmitAuto(key)).toBe(true);
  });

  it.each([
    ['dragend', () => window.dispatchEvent(new Event('dragend'))],
    ['drop', () => window.dispatchEvent(new Event('drop'))],
    ['window.blur', () => window.dispatchEvent(new Event('blur'))],
    ['Escape', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))],
    ['visibilitychange', () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    }],
  ])('resets drag state on %s', (_name, fire) => {
    const guard = createExcerptInteractionGuard();
    guard.beginDrag();
    fire();
    expect(guard.isDragging()).toBe(false);
  });

  it('ignores unrelated keys and detaches listeners after reset', () => {
    const guard = createExcerptInteractionGuard();
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    guard.beginDrag();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(guard.isDragging()).toBe(true);
    guard.reset();
    expect(guard.isDragging()).toBe(false);
    expect(removeSpy.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(['dragend', 'drop', 'blur', 'keydown']));
    removeSpy.mockRestore();
  });

  it('sets a compact offscreen drag image instead of the default container snapshot', () => {
    vi.useFakeTimers();
    const setDragImage = vi.fn();
    setCompactDragImage({ setDragImage } as unknown as DataTransfer, 'P.12 · 有丝分裂');
    expect(setDragImage).toHaveBeenCalledTimes(1);
    const ghost = setDragImage.mock.calls[0][0] as HTMLElement;
    expect(ghost.textContent).toBe('P.12 · 有丝分裂');
    expect(ghost.style.pointerEvents).toBe('none');
    expect(document.body.contains(ghost)).toBe(true);
    vi.runAllTimers();
    expect(document.body.contains(ghost)).toBe(false);
  });
});

describe('C6 reveal stability: revealSeq + virtualized pages', () => {
  it('only the latest reveal token stays current (rapid Node A -> Node B never ping-pongs)', () => {
    const seq = createRevealSequencer();
    const a = seq.next();
    const b = seq.next();
    expect(seq.isCurrent(a)).toBe(false);
    expect(seq.isCurrent(b)).toBe(true);
    seq.cancel();
    expect(seq.isCurrent(b)).toBe(false);
  });

  it('clamps target pages into the document range', () => {
    expect(clampRevealPage(218, 120)).toBe(120);
    expect(clampRevealPage(0, 120)).toBe(1);
    expect(clampRevealPage(42, 0)).toBe(42);
  });

  it('waits for a virtualized page to mount after scrolling, then resolves deterministically', async () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    const seq = createRevealSequencer();
    const token = seq.next();
    const pending = waitForPdfPageElement(root, 218, { isCurrent: () => seq.isCurrent(token), intervalMs: 40 });
    await vi.advanceTimersByTimeAsync(80);
    const page = document.createElement('div');
    page.setAttribute('data-page-number', '218');
    page.getBoundingClientRect = () => ({ height: 900, width: 600, top: 0, left: 0, right: 600, bottom: 900, x: 0, y: 0, toJSON: () => ({}) });
    root.appendChild(page);
    await vi.advanceTimersByTimeAsync(40);
    await expect(pending).resolves.toBe(page);
  });

  it('abandons a superseded reveal (A) as soon as B starts, leaving no pending pulse for A', async () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    const seq = createRevealSequencer();
    const tokenA = seq.next();
    const waitA = waitForPdfPageElement(root, 12, { isCurrent: () => seq.isCurrent(tokenA), intervalMs: 40 });
    seq.next();
    await vi.advanceTimersByTimeAsync(40);
    await expect(waitA).resolves.toBeNull();
  });

  it('renders the pulse overlay with pointer-events: none so text underneath stays selectable', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/features/pdf/styles/pdf-viewer.css'), 'utf8');
    const block = css.slice(css.indexOf('.ds-pdf__anchor-pulse {'), css.indexOf('}', css.indexOf('.ds-pdf__anchor-pulse {')));
    expect(block).toContain('pointer-events: none');
    expect(block).toContain('1800ms');
    const viewer = readFileSync(resolve(process.cwd(), 'src/features/pdf/components/EnhancedPdfViewer.tsx'), 'utf8');
    expect(viewer).toContain("import '../styles/pdf-viewer.css'");
    expect(viewer).toContain('usePdfAnchorReveal({');
  });

  it('never hijacks native text-layer mousedown for excerpt dragging', () => {
    const actions = readFileSync(resolve(process.cwd(), 'src/features/pdf/components/PdfSelectionActions.tsx'), 'utf8');
    expect(actions).not.toMatch(/textLayer[^\n]*addEventListener\('mousedown'/);
    expect(actions).toContain('draggable');
    expect(actions).toContain('sharedPdfExcerptGuard.beginDrag()');
    expect(actions).toContain('setCompactDragImage(');
  });
});

describe('<PdfPageMarginBacklinks />', () => {
  beforeEach(() => revealMock.mockReset());

  const summary = groupPdfAnchorEdgesByPage([
    edge('mindmap', 7, 'mm_1', '细胞周期'),
    edge('mindmap', 7, 'mm_2', '分裂期'),
    edge('flashcard', 7, 'card_1', '有丝分裂 >> 定义'),
  ]).get(7)!;

  it('renders a mono tabular-nums count pill with a 6px Mineral dot and zero emojis', () => {
    const { container } = render(React.createElement(PdfPageMarginBacklinks, { summary, page: 7 }));
    const count = screen.getByTestId('pdf-margin-backlinks-count');
    expect(count.textContent).toBe('2 导图 · 1 闪卡');
    expect(count.className).toContain('font-mono');
    expect(count.className).toContain('tabular-nums');
    const dot = container.querySelector('span.rounded-full.bg-primary');
    expect(dot?.className).toContain('h-1.5');
    expect(dot?.className).toContain('w-1.5');
    expect(EMOJI_RE.test(container.textContent ?? '')).toBe(false);
  });

  it('opens the popover and reveals the consumer with splitIfClosed + pulse', () => {
    const { container } = render(React.createElement(PdfPageMarginBacklinks, { summary, page: 7 }));
    fireEvent.click(screen.getByRole('button', { name: /本页关联引用/ }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('border-border/35');
    expect(dialog.querySelector('.font-mono.tabular-nums')?.textContent).toBe('P.7');
    const items = screen.getAllByTestId('pdf-margin-backlink-item');
    expect(items).toHaveLength(3);
    expect(container.querySelectorAll('.h-px.bg-border\\/35').length).toBeGreaterThanOrEqual(1);
    fireEvent.click(items[2]);
    expect(revealMock).toHaveBeenCalledWith(summary.edges[2].sourceAnchorUri, { splitIfClosed: true, pulse: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(EMOJI_RE.test(container.textContent ?? '')).toBe(false);
  });

  it('stops pointer events from reaching the page (no zoom / selection side effects)', () => {
    const onPageMouseDown = vi.fn();
    render(
      React.createElement(
        'div',
        { onMouseDown: onPageMouseDown, onPointerDown: onPageMouseDown },
        React.createElement(PdfPageMarginBacklinks, { summary, page: 7 }),
      ),
    );
    fireEvent.pointerDown(screen.getByTestId('pdf-margin-backlinks-count'));
    fireEvent.mouseDown(screen.getByTestId('pdf-margin-backlinks-count'));
    expect(onPageMouseDown).not.toHaveBeenCalled();
  });

  it('renders nothing for an empty summary', () => {
    const { container } = render(
      React.createElement(PdfPageMarginBacklinks, {
        summary: { total: 0, mindmapCount: 0, flashcardCount: 0, noteCount: 0, edges: [] },
        page: 1,
      }),
    );
    expect(container.firstChild).toBeNull();
  });

  it('closes on outside pointerdown and Escape without leaking page gestures', () => {
    render(React.createElement(PdfPageMarginBacklinks, { summary, page: 7 }));
    const trigger = screen.getByRole('button', { name: /本页关联引用/ });
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(trigger);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
