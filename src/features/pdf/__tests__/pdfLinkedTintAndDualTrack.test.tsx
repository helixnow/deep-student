/**
 * W15 (`C7 §2.1` + `C6`) 验证套件：
 * 1. `<PdfLinkedExcerptTintLayer />`：订阅 `AnchorEdge[]`、页级 `rectNorm` 过滤、Mineral 分支语义微染
 *    （亮色 `0.14` / 暗色 `0.18`）、`pointer-events: none` 不破坏 `.textLayer` 选词、角部 `6px` 微胶囊悬停标题与点击 `anchors.reveal`、
 *    删边与改 `branchColor` 实时联动响应。
 * 2. `pdfDualTrackRegionExtractor` + `<PdfRegionCapture />`：
 *    - Track 1（0ms 原生几何提取）：单栏与双栏（水平空隙聚类）学术阅读序、跨行连字符还原、CJK 无多余空格；
 *    - Track 2（扫描版 PDF / `[识别文字/公式]` 异步视觉回退）：可注入识别器、宿主 OCR/LLM 通道降级、
 *      超时无阻塞回退（拖拽胶囊 0ms 就绪永不卡死）、`DS_EXCERPT_MIME` 同时携带 `imageDataUrl` + `text` + `latex`。
 */
import React, { useRef } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, captureMock, notifyMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  captureMock: vi.fn(),
  notifyMock: vi.fn(),
}));

import { AnchorRegistry } from '@/ui-kernel/services/anchors';
import { ExcerptDndHub, clearActiveExcerptDrag } from '@/ui-kernel/services/excerpt-dnd';

let testAnchors = new AnchorRegistry();
let testDnd = new ExcerptDndHub();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/ui-kernel/bootstrap', () => ({
  getAppKernel: () => ({
    anchors: testAnchors,
    dnd: testDnd,
  }),
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const zhMap: Record<string, string> = {
        'pdf:interop.drag_region': '拖出摘录',
        'pdf:interop.create_occlusion_card': '遮挡制卡',
        'pdf:interop.recognize_region': '识别文字/公式',
        'pdf:interop.recognizing_region': '正在识别文字与公式…',
        'pdf:interop.extracted_text_placeholder': '框选文本或公式（可编辑，随摘录一同拖入）',
        'pdf:interop.track_native_badge': '原生文本',
        'pdf:interop.track_vision_badge': '视觉识别',
        'pdf:interop.track_image_only_badge': '仅原图',
        'pdf:interop.tint_jump_to_source': `定位引用：${String(options?.title ?? '')}`,
        'pdf:interop.tint_source_mindmap': '导图节点',
        'pdf:interop.tint_source_flashcard': '闪卡',
        'pdf:interop.tint_source_note': '笔记段落',
        'pdf:interop.tint_source_qbank': '题目',
        'pdf:capture.mode_ask': '框选提问',
        'pdf:capture.mode_latex': '提取 LaTeX',
        'pdf:capture.mode_table': '提取表格',
        'pdf:capture.reselect': '重新框选',
        'pdf:capture.untitled': 'PDF',
        'pdf:toolbar.capture_ask': '框选提问',
        'common:cancel': '取消',
      };
      return zhMap[key] ?? key;
    },
  }),
}));

vi.mock('../regionCapture', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../regionCapture')>()),
  capturePdfRegion: captureMock,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: notifyMock,
}));

import {
  DS_EXCERPT_MIME,
  buildAnchorEdgeRecord,
  type AnchorEdgeRecord,
} from '@/ui-kernel/contracts/interop';
import {
  MINERAL_BRANCH_COLOR_TOKENS,
  MINERAL_TINT_OPACITY_DARK,
  MINERAL_TINT_OPACITY_LIGHT,
  MINERAL_TINT_PALETTE,
  PdfLinkedExcerptTintLayer,
  resolveEdgeBranchColor,
  usePdfResourceAnchorEdges,
  type PdfTintEdgeInput,
} from '../interop/PdfLinkedExcerptTintLayer';
import {
  defaultHostPdfVisionRecognizer,
  extractDualTrackPdfRegion,
  extractNativeRegionTextFromPage,
  recognizeRegionWithVisionFallback,
  sortTextSpansInAcademicReadingOrder,
  type PdfRegionVisionRecognizer,
  type PositionedTextSpan,
} from '../interop/pdfDualTrackRegionExtractor';
import { PdfRegionCapture } from '../components/PdfRegionCapture';
import { rotateNormalizedRect, sharedPdfExcerptGuard } from '../interop/pdfInteropBridge';

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/u;

class TestPointerEvent extends MouseEvent {
  pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

Object.defineProperty(window, 'PointerEvent', { configurable: true, value: TestPointerEvent });

function makeDomRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function appendMockSpan(
  textLayer: HTMLElement,
  text: string,
  box: { left: number; top: number; width: number; height: number },
  className?: string,
): HTMLSpanElement {
  const span = document.createElement('span');
  if (className) span.className = className;
  span.textContent = text;
  span.getBoundingClientRect = () => makeDomRect(box.left, box.top, box.width, box.height);
  textLayer.appendChild(span);
  return span;
}

function makePdfEdge(params: {
  edgeId?: string;
  sourceKind?: 'mindmap' | 'flashcard' | 'note';
  sourceResourceId: string;
  nodeOrCardId: string;
  sourceLabel: string;
  pdfResourceId?: string;
  page: number;
  rect?: { x: number; y: number; w: number; h: number };
  branchColor?: string;
}): PdfTintEdgeInput {
  const sourceKind = params.sourceKind ?? 'mindmap';
  const base = buildAnchorEdgeRecord(
    {
      edgeId: params.edgeId,
      sourceKind,
      sourceResourceId: params.sourceResourceId,
      sourceSubId: params.nodeOrCardId,
      sourceAnchor:
        sourceKind === 'mindmap'
          ? {
              kind: 'custom',
              namespace: 'mindmap',
              resourceId: params.sourceResourceId,
              locator: params.nodeOrCardId,
              label: params.sourceLabel,
              ...(params.branchColor ? { params: { branchColor: params.branchColor } } : {}),
            }
          : {
              kind: 'note',
              resourceId: params.sourceResourceId,
              blockId: params.nodeOrCardId,
              label: params.sourceLabel,
            },
      sourceLabel: params.sourceLabel,
      targetAnchor: {
        kind: 'pdf',
        resourceId: params.pdfResourceId ?? 'tb_linear_algebra',
        page: params.page,
        ...(params.rect ? { rect: params.rect } : {}),
      },
    },
    1_700_000_000_000,
  );
  if (!base) throw new Error('Invalid test edge fixture');
  return base;
}

beforeEach(() => {
  testAnchors = new AnchorRegistry();
  testDnd = new ExcerptDndHub();
  invokeMock.mockReset();
  captureMock.mockReset();
  notifyMock.mockReset();
  clearActiveExcerptDrag();
  sharedPdfExcerptGuard.reset();
  document.documentElement.classList.remove('dark');
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  cleanup();
  testAnchors.dispose();
  testDnd.dispose();
  clearActiveExcerptDrag();
  sharedPdfExcerptGuard.reset();
  vi.useRealTimers();
});

// ============================================================================
// 1. Persistent Linked Excerpt Tint Layer
// ============================================================================

describe('<PdfLinkedExcerptTintLayer /> & Mineral branch tinting', () => {
  it.each([0, 90, 180, 270])('projects persistent normalized tint coordinates at %s degrees', (rotation) => {
    const rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.1 };
    const edge = makePdfEdge({ sourceResourceId: 'mm', nodeOrCardId: 'n', sourceLabel: '节点', page: 1, rect });
    render(<PdfLinkedExcerptTintLayer edges={[edge]} page={1} rotation={rotation} />);
    const item = screen.getByTestId('pdf-linked-excerpt-tint-item');
    const expected = rotateNormalizedRect(rect, rotation)!;
    expect(parseFloat(item.style.left)).toBeCloseTo(expected.x * 100);
    expect(parseFloat(item.style.top)).toBeCloseTo(expected.y * 100);
    expect(parseFloat(item.style.width)).toBeCloseTo(expected.w * 100);
    expect(parseFloat(item.style.height)).toBeCloseTo(expected.h * 100);
  });

  it('ignores late tint queries after a resource switch and unsubscribes on unmount', async () => {
    let resolveOld!: (edges: AnchorEdgeRecord[]) => void;
    const query = vi.spyOn(testAnchors, 'queryAnchorEdgesByTarget')
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue([]);
    const unsubscribe = vi.fn();
    vi.spyOn(testAnchors, 'subscribeAnchorEdgesChanged').mockReturnValue(unsubscribe);
    const hook = renderHook(({ ids }) => usePdfResourceAnchorEdges(ids), { initialProps: { ids: ['old'] } });
    hook.rerender({ ids: ['new'] });
    await act(async () => { resolveOld([makePdfEdge({ sourceResourceId: 'mm', nodeOrCardId: 'n', sourceLabel: '旧边', page: 1 })]); });
    expect(hook.result.current).toEqual([]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    hook.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
  it('resolves explicit MindMap branchColor tokens/hexes and deterministic Mineral fallback palette', () => {
    const amberEdge = makePdfEdge({
      sourceResourceId: 'mm_1',
      nodeOrCardId: 'node_amber',
      sourceLabel: '特征值分解',
      page: 5,
      rect: { x: 0.1, y: 0.2, w: 0.6, h: 0.08 },
      branchColor: 'amber',
    });
    expect(resolveEdgeBranchColor(amberEdge, false)).toEqual({
      token: 'amber',
      cssColor: MINERAL_TINT_PALETTE.amber.light,
      isExplicit: true,
    });
    expect(resolveEdgeBranchColor(amberEdge, true)).toEqual({
      token: 'amber',
      cssColor: MINERAL_TINT_PALETTE.amber.dark,
      isExplicit: true,
    });

    // MindMap Mineral hex 值自动对齐对应语义令牌
    const roseHexEdge: PdfTintEdgeInput = {
      ...makePdfEdge({
        sourceResourceId: 'mm_1',
        nodeOrCardId: 'node_rose',
        sourceLabel: '奇异值定理',
        page: 5,
        rect: { x: 0.1, y: 0.35, w: 0.6, h: 0.08 },
      }),
      branchColor: '#A85D74',
    };
    expect(resolveEdgeBranchColor(roseHexEdge, false).token).toBe('rose');
    expect(resolveEdgeBranchColor(roseHexEdge, true).cssColor).toBe(MINERAL_TINT_PALETTE.rose.dark);

    // 缺失 branchColor 时确定性落入 Mineral 五色色板（celadon / amber / indigo / rose / slate）
    const fallbackA = makePdfEdge({
      sourceResourceId: 'mm_2',
      nodeOrCardId: 'node_det_42',
      sourceLabel: '正交投影',
      page: 5,
      rect: { x: 0.1, y: 0.5, w: 0.5, h: 0.06 },
    });
    const fallbackB = makePdfEdge({
      sourceResourceId: 'mm_2',
      nodeOrCardId: 'node_det_42',
      sourceLabel: '正交投影（同节点二处摘录）',
      page: 6,
      rect: { x: 0.2, y: 0.4, w: 0.4, h: 0.05 },
    });
    const resolvedA = resolveEdgeBranchColor(fallbackA, false);
    const resolvedB = resolveEdgeBranchColor(fallbackB, false);
    expect(resolvedA.isExplicit).toBe(false);
    expect(MINERAL_BRANCH_COLOR_TOKENS).toContain(resolvedA.token);
    expect(resolvedA.token).toBe(resolvedB.token);
  });

  it('subscribes to resource AnchorEdges, filters visible page rectNorms, enforces 0.14/0.18 opacity & pointer-events hygiene, and reveals citing node on pill click', async () => {
    const revealSpy = vi.spyOn(testAnchors, 'reveal').mockResolvedValue({
      ok: true,
      outcome: 'revealed-in-open-pane',
      elapsedMs: 4,
    });

    await testAnchors.upsertAnchorEdges([
      {
        sourceKind: 'mindmap',
        sourceResourceId: 'mm_svd',
        sourceSubId: 'node_svd_1',
        sourceAnchor: {
          kind: 'custom',
          namespace: 'mindmap',
          resourceId: 'mm_svd',
          locator: 'node_svd_1',
          label: 'SVD 核心定理',
          params: { branchColor: 'celadon' },
        },
        sourceLabel: 'SVD 核心定理',
        targetAnchor: {
          kind: 'pdf',
          resourceId: 'tb_linear_algebra',
          page: 12,
          rect: { x: 0.12, y: 0.25, w: 0.72, h: 0.1 },
        },
      },
      // 同页但无 rectNorm 的整页回链：不应生成正文框微染
      {
        sourceKind: 'note',
        sourceResourceId: 'note_1',
        sourceSubId: 'blk_1',
        sourceAnchor: { kind: 'note', resourceId: 'note_1', blockId: 'blk_1' },
        sourceLabel: '整页笔记引用',
        targetAnchor: {
          kind: 'pdf',
          resourceId: 'tb_linear_algebra',
          page: 12,
        },
      },
      // 其他页带 rectNorm 的边：当前第 12 页不渲染
      {
        sourceKind: 'flashcard',
        sourceResourceId: 'fc_99',
        sourceSubId: 'card_99',
        sourceAnchor: { kind: 'note', resourceId: 'fc_99', blockId: 'card_99' },
        sourceLabel: '第 18 页闪卡',
        targetAnchor: {
          kind: 'pdf',
          resourceId: 'tb_linear_algebra',
          page: 18,
          rect: { x: 0.2, y: 0.3, w: 0.5, h: 0.12 },
        },
      },
    ]);

    const onPagePointerDown = vi.fn();
    const { container, rerender } = render(
      <div onPointerDown={onPagePointerDown} onMouseDown={onPagePointerDown}>
        <PdfLinkedExcerptTintLayer resourceId="tb_linear_algebra" page={12} isDark={false} />
      </div>,
    );

    const layer = await screen.findByTestId('pdf-linked-excerpt-tint-layer');
    expect(layer.style.pointerEvents).toBe('none');

    const items = screen.getAllByTestId('pdf-linked-excerpt-tint-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.style.pointerEvents).toBe('none');
    expect(items[0]!.style.left).toBe('12%');
    expect(items[0]!.style.top).toBe('25%');
    expect(items[0]!.style.width).toBe('72%');
    expect(items[0]!.style.height).toBe('10%');

    const tintRect = screen.getByTestId('pdf-linked-excerpt-tint-rect');
    expect(tintRect.style.pointerEvents).toBe('none');
    expect(Number(tintRect.style.opacity)).toBeCloseTo(MINERAL_TINT_OPACITY_LIGHT, 4);

    // 切换暗色阅读：微染不透明度切换为 0.18，色阶切至暗色青瓷
    rerender(
      <div onPointerDown={onPagePointerDown} onMouseDown={onPagePointerDown}>
        <PdfLinkedExcerptTintLayer resourceId="tb_linear_algebra" page={12} isDark={true} />
      </div>,
    );
    expect(Number(screen.getByTestId('pdf-linked-excerpt-tint-rect').style.opacity)).toBeCloseTo(
      MINERAL_TINT_OPACITY_DARK,
      4,
    );

    // 角部微胶囊：pointer-events: auto + nodrag + 6px 圆点 + 悬停预览标题 + 点击反向跳转
    const pill = screen.getByTestId('pdf-linked-excerpt-tint-pill');
    expect(pill.style.pointerEvents).toBe('auto');
    expect(pill.className).toContain('nodrag');
    expect(pill.getAttribute('title')).toBe('SVD 核心定理');

    const dot = screen.getByTestId('pdf-linked-excerpt-tint-dot');
    expect(dot.className).toContain('h-1.5');
    expect(dot.className).toContain('w-1.5');

    fireEvent.mouseEnter(pill);
    const tooltip = screen.getByTestId('pdf-linked-excerpt-tint-tooltip');
    expect(tooltip.textContent).toBe('SVD 核心定理');
    expect(tooltip.style.pointerEvents).toBe('none');
    expect(tooltip.className).toContain('border-border/35');

    fireEvent.pointerDown(pill);
    fireEvent.mouseDown(pill);
    fireEvent.click(pill);
    expect(onPagePointerDown).not.toHaveBeenCalled();
    expect(revealSpy).toHaveBeenCalledTimes(1);
    expect(revealSpy.mock.calls[0]?.[1]).toEqual({ splitIfClosed: true, pulse: true });
    expect(EMOJI_RE.test(container.textContent ?? '')).toBe(false);
  });

  it('reactively updates tint branchColor when MindMap recolors a branch and disappears when the edge is deleted', async () => {
    const edgeId = 'edge_reactive_branch_1';
    await testAnchors.upsertAnchorEdges([
      {
        edgeId,
        sourceKind: 'mindmap',
        sourceResourceId: 'mm_calc',
        sourceSubId: 'node_taylor',
        sourceAnchor: {
          kind: 'custom',
          namespace: 'mindmap',
          resourceId: 'mm_calc',
          locator: 'node_taylor',
          label: '泰勒展开余项',
          params: { branchColor: 'celadon' },
        },
        sourceLabel: '泰勒展开余项',
        targetAnchor: {
          kind: 'pdf',
          resourceId: 'tb_calc',
          page: 8,
          rect: { x: 0.15, y: 0.2, w: 0.7, h: 0.12 },
        },
      },
    ]);

    render(<PdfLinkedExcerptTintLayer resourceId="tb_calc" page={8} isDark={false} />);

    const item = await screen.findByTestId('pdf-linked-excerpt-tint-item');
    expect(item.getAttribute('data-branch-token')).toBe('celadon');

    // MindMap 修改分支颜色为 indigo：PDF 微染层自动同步更新
    await act(async () => {
      await testAnchors.upsertAnchorEdges([
        {
          edgeId,
          sourceKind: 'mindmap',
          sourceResourceId: 'mm_calc',
          sourceSubId: 'node_taylor',
          sourceAnchor: {
            kind: 'custom',
            namespace: 'mindmap',
            resourceId: 'mm_calc',
            locator: 'node_taylor',
            label: '泰勒展开余项',
            params: { branchColor: 'indigo' },
          },
          sourceLabel: '泰勒展开余项',
          targetAnchor: {
            kind: 'pdf',
            resourceId: 'tb_calc',
            page: 8,
            rect: { x: 0.15, y: 0.2, w: 0.7, h: 0.12 },
          },
        },
      ]);
    });

    await waitFor(() => {
      expect(screen.getByTestId('pdf-linked-excerpt-tint-item').getAttribute('data-branch-token')).toBe(
        'indigo',
      );
    });

    // MindMap 删除该节点引用边：PDF 微染底色自动消退卸载
    await act(async () => {
      await testAnchors.pruneAnchorEdgesBySource({
        sourceKind: 'mindmap',
        sourceResourceId: 'mm_calc',
        keepEdgeIds: [],
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('pdf-linked-excerpt-tint-layer')).toBeNull();
    });
  });

  it('keeps CSS pointer-events: none contract on tint layer and rects in pdf-viewer.css & mounts inside EnhancedPdfViewer', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/features/pdf/styles/pdf-viewer.css'), 'utf8');
    expect(css).toContain('.ds-pdf__excerpt-tint-layer');
    expect(css).toContain('--ds-pdf-tint-opacity: 0.14');
    expect(css).toContain('--ds-pdf-tint-opacity: 0.18');
    expect(css).toContain('.ds-pdf__excerpt-tint-pill');

    const viewer = readFileSync(
      resolve(process.cwd(), 'src/features/pdf/components/EnhancedPdfViewer.tsx'),
      'utf8',
    );
    expect(viewer).toContain('<PdfLinkedExcerptTintLayer');
    expect(viewer).toContain('isDark={isDarkMode || isDarkReading}');
  });
});

// ============================================================================
// 2. Dual-Track Region Capture (Track 1 Geometry + Track 2 Vision/OCR Fallback)
// ============================================================================

describe('pdfDualTrackRegionExtractor — Track 1 native geometry & Track 2 vision fallback', () => {
  it.each([0, 90, 180, 270])('restores native text reading order at %s degrees and 2x zoom', (rotation) => {
    const page = document.createElement('div');
    page.dataset.pageRotation = String(rotation);
    const width = rotation % 180 ? 1600 : 1000;
    const height = rotation % 180 ? 1000 : 1600;
    page.getBoundingClientRect = () => makeDomRect(20, 40, width, height);
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    page.appendChild(layer);
    for (const [text, x, y] of [['Second line.', 0.1, 0.2], ['First line.', 0.1, 0.1]] as const) {
      const rect = rotateNormalizedRect({ x, y, w: 0.5, h: 0.02 }, rotation)!;
      appendMockSpan(layer, text, { left: 20 + rect.x * width, top: 40 + rect.y * height, width: rect.w * width, height: rect.h * height });
    }
    expect(extractNativeRegionTextFromPage(page, { left: 20, top: 40, width, height }).extractedText).toMatch(/First line\.[\s\S]*Second line\./);
  });

  it('does not start OCR for an already aborted request and promptly settles an in-flight abort', async () => {
    const controller = new AbortController();
    const recognizer = vi.fn<PdfRegionVisionRecognizer>(() => new Promise(() => {}));
    const input = { blob: new Blob(), imageDataUrl: '', page: 1, nativeText: '原生文本', recognizer, signal: controller.signal };
    const pending = recognizeRegionWithVisionFallback(input);
    await Promise.resolve();
    controller.abort();
    expect(await pending).toEqual({ status: 'fallback-image-only', text: '原生文本' });
    recognizer.mockClear();
    expect(await recognizeRegionWithVisionFallback(input)).toMatchObject({ status: 'fallback-image-only' });
    expect(recognizer).not.toHaveBeenCalled();
  });
  it('sorts single-column spans top-to-bottom, left-to-right, fixing ligatures, hyphenation, and CJK joins', () => {
    const spans: PositionedTextSpan[] = [
      { text: 'former', left: 60, top: 120, width: 48, height: 14 },
      { text: 'models', left: 113, top: 120, width: 50, height: 14 },
      { text: 'achieve', left: 168, top: 120, width: 54, height: 14 },
      { text: 'ﬁne-grained', left: 227, top: 120, width: 80, height: 14 },
      { text: 'Theorem 1.', left: 60, top: 100, width: 82, height: 14 },
      { text: 'Trans-', left: 148, top: 100, width: 46, height: 14 },
      { text: '注意力', left: 60, top: 156, width: 42, height: 14 },
      { text: '机制收敛性。', left: 103, top: 156, width: 84, height: 14 },
    ];

    const result = sortTextSpansInAcademicReadingOrder(spans);
    expect(result.layout).toBe('single-column');
    expect(result.extractedText).toBe(
      'Theorem 1. Transformer models achieve fine-grained\n\n注意力机制收敛性。',
    );
  });

  it('detects two-column academic layout via horizontal gap clustering (spanning header -> left col -> right col)', () => {
    // 故意打乱输入顺序：跨栏小节标题 + 左栏 3 行 + 右栏 3 行
    const spans: PositionedTextSpan[] = [
      { text: 'Right col line 1:', left: 290, top: 140, width: 180, height: 14 },
      { text: 'Left col line 2', left: 50, top: 160, width: 190, height: 14 },
      { text: 'Right col line 3.', left: 290, top: 180, width: 180, height: 14 },
      { text: '3. Convergence Analysis', left: 50, top: 104, width: 420, height: 16 },
      { text: 'Left col line 1:', left: 50, top: 140, width: 190, height: 14 },
      { text: 'Right col line 2', left: 290, top: 160, width: 180, height: 14 },
      { text: 'Left col line 3.', left: 50, top: 180, width: 190, height: 14 },
    ];

    const result = sortTextSpansInAcademicReadingOrder(spans);
    expect(result.layout).toBe('two-column');
    expect(result.extractedText).toBe(
      [
        '3. Convergence Analysis',
        'Left col line 1: Left col line 2 Left col line 3.',
        'Right col line 1: Right col line 2 Right col line 3.',
      ].join('\n\n'),
    );
  });

  it('extracts only intersecting .textLayer leaf spans inside the crop rect in 0ms', () => {
    const pageEl = document.createElement('div');
    pageEl.setAttribute('data-page-number', '4');
    const textLayer = document.createElement('div');
    textLayer.className = 'react-pdf__Page__textContent textLayer';
    pageEl.appendChild(textLayer);

    // 框外上方行
    appendMockSpan(textLayer, 'Header outside crop', { left: 40, top: 20, width: 200, height: 14 });
    // 仅擦边 2px 的相邻行（< 35% 纵向重叠，应排除）
    appendMockSpan(textLayer, 'Grazing neighbor line', { left: 40, top: 88, width: 200, height: 14 });
    // 框内目标行
    appendMockSpan(textLayer, 'Lemma 2.1 (Cauchy-Schwarz).', { left: 40, top: 108, width: 210, height: 14 });
    appendMockSpan(textLayer, 'For all vectors u, v in V.', { left: 40, top: 128, width: 200, height: 14 });
    // PDF.js 辅助空白标记（应忽略）
    appendMockSpan(textLayer, 'ignored', { left: 40, top: 110, width: 100, height: 14 }, 'endOfContent');

    const extracted = extractNativeRegionTextFromPage(pageEl, {
      left: 35,
      top: 100,
      width: 240,
      height: 50,
    });

    expect(extracted.spanCount).toBe(2);
    expect(extracted.extractedText).toBe('Lemma 2.1 (Cauchy-Schwarz). For all vectors u, v in V.');
  });

  it('falls back cleanly to image-only on Vision/OCR timeout or error without throwing', async () => {
    vi.useFakeTimers();
    const hangingRecognizer: PdfRegionVisionRecognizer = ({ signal }) =>
      new Promise((resolvePromise) => {
        signal?.addEventListener('abort', () => resolvePromise(null), { once: true });
      });

    const blob = new Blob(['scanned'], { type: 'image/png' });
    const pending = recognizeRegionWithVisionFallback({
      blob,
      imageDataUrl: 'data:image/png;base64,AAAA',
      page: 2,
      recognizer: hangingRecognizer,
      timeoutMs: 120,
    });

    await vi.advanceTimersByTimeAsync(130);
    const outcome = await pending;
    expect(outcome).toEqual({ status: 'timeout', text: '' });

    vi.useRealTimers();
    const rejectingRecognizer: PdfRegionVisionRecognizer = async () => {
      throw new Error('vision backend unavailable');
    };
    const rejected = await extractDualTrackPdfRegion({
      pageElement: document.createElement('div'),
      page: 2,
      cropRect: { left: 10, top: 10, width: 120, height: 60 },
      blob,
      imageDataUrl: 'data:image/png;base64,AAAA',
      recognizer: rejectingRecognizer,
      timeoutMs: 200,
    });
    expect(rejected).toEqual({
      track: 'image-only',
      extractedText: '',
      spanCount: 0,
      layout: 'single-column',
    });
  });

  it('wires defaultHostPdfVisionRecognizer to host OCR + LLM formula formatting and degrades gracefully', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'chat_v2_perform_ocr') {
        return { ocr_text: 'Theorem 3: sum_{i=1}^n lambda_i = tr(A)' };
      }
      if (cmd === 'call_llm_for_boundary') {
        return {
          assistant_message: 'Theorem 3:\n$$\\sum_{i=1}^{n} \\lambda_i = \\operatorname{tr}(A)$$',
        };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const res = await defaultHostPdfVisionRecognizer({
      blob: new Blob(['png'], { type: 'image/png' }),
      imageDataUrl: 'data:image/png;base64,AAAA',
      page: 9,
      preferFormula: true,
    });

    expect(res?.source).toBe('vision');
    expect(res?.text).toContain('Theorem 3:');
    expect(res?.latex).toContain('\\sum_{i=1}^{n} \\lambda_i');
  });
});

// ============================================================================
// 3. <PdfRegionCapture /> Dual-Track Excerpt Drag Integration
// ============================================================================

function RegionCaptureHarness({
  setupPage,
  visionRecognizer,
  visionTimeoutMs,
}: {
  setupPage: (pageEl: HTMLDivElement) => void;
  visionRecognizer?: PdfRegionVisionRecognizer;
  visionTimeoutMs?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    vp.innerHTML = '';
    vp.getBoundingClientRect = () => makeDomRect(0, 0, 600, 900);
    if (containerRef.current) {
      containerRef.current.getBoundingClientRect = () => makeDomRect(0, 0, 600, 900);
    }
    const pageEl = document.createElement('div');
    pageEl.setAttribute('data-page-number', '6');
    pageEl.getBoundingClientRect = () => makeDomRect(0, 0, 500, 800);
    setupPage(pageEl);
    vp.appendChild(pageEl);
  }, [setupPage]);

  return (
    <div ref={containerRef}>
      <div ref={viewportRef} data-testid="pdf-viewport" />
      <PdfRegionCapture
        containerRef={containerRef}
        viewportRef={viewportRef}
        documentTitle="矩阵分析.pdf"
        isTouch={false}
        interopResourceId="tb_matrix"
        interopAliasResourceId="vfs_matrix_1"
        visionRecognizer={visionRecognizer}
        visionTimeoutMs={visionTimeoutMs}
        onExit={() => {}}
      />
    </div>
  );
}

function dragCropBox(from: { x: number; y: number }, to: { x: number; y: number }) {
  const layer = screen.getByTestId('pdf-region-capture');
  fireEvent.pointerDown(layer, { pointerId: 1, button: 0, clientX: from.x, clientY: from.y });
  fireEvent.pointerMove(layer, { pointerId: 1, clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(layer, { pointerId: 1, clientX: to.x, clientY: to.y });
}

function createMockDataTransfer() {
  const store = new Map<string, string>();
  return {
    store,
    dt: {
      setData: vi.fn((mime: string, val: string) => {
        store.set(mime, val);
      }),
      getData: vi.fn((mime: string) => store.get(mime) ?? ''),
      setDragImage: vi.fn(),
      get types() {
        return Array.from(store.keys());
      },
      effectAllowed: 'all',
    } as unknown as DataTransfer,
  };
}

describe('<PdfRegionCapture /> dual-track excerpt drag & non-blocking scanned fallback', () => {
  it('preserves user text edited while explicit formula recognition is pending', async () => {
    captureMock.mockResolvedValue({ kind: 'ok', blob: new Blob(['png']), page: 6 });
    let resolveOcr!: (value: { text: string }) => void;
    const recognizer: PdfRegionVisionRecognizer = () => new Promise((resolve) => { resolveOcr = resolve; });
    render(<RegionCaptureHarness visionRecognizer={recognizer} setupPage={(page) => {
      const layer = document.createElement('div');
      layer.className = 'textLayer';
      appendMockSpan(layer, '原生内容', { left: 40, top: 100, width: 160, height: 14 });
      page.appendChild(layer);
    }} />);
    fireEvent.click(screen.getByRole('radio', { name: '拖出摘录' }));
    dragCropBox({ x: 30, y: 90 }, { x: 440, y: 160 });
    const textarea = await screen.findByTestId('pdf-region-excerpt-text');
    fireEvent.click(screen.getByTestId('pdf-region-recognize-btn'));
    fireEvent.change(textarea, { target: { value: '用户修订的内容' } });
    await waitFor(() => expect(resolveOcr).toBeTypeOf('function'));
    await act(async () => { resolveOcr({ text: '迟到的识别结果' }); });
    expect(textarea).toHaveValue('用户修订的内容');
    expect(screen.getByTestId('pdf-region-recognize-btn')).not.toBeDisabled();
  });
  it('populates BOTH imageDataUrl and geometric two-column extractedText in DS_EXCERPT_MIME on native PDFs, and enriches latex on [识别文字/公式]', async () => {
    captureMock.mockResolvedValue({
      kind: 'ok',
      blob: new Blob(['png-bytes'], { type: 'image/png' }),
      page: 6,
    });

    const visionMock = vi.fn<PdfRegionVisionRecognizer>(async () => ({
      text: '定理 6.1（谱分解）',
      latex: '$$A = Q \\Lambda Q^T$$',
      source: 'vision',
    }));

    render(
      <RegionCaptureHarness
        visionRecognizer={visionMock}
        setupPage={(pageEl) => {
          const textLayer = document.createElement('div');
          textLayer.className = 'textLayer';
          appendMockSpan(textLayer, '左栏第一行', { left: 40, top: 100, width: 160, height: 14 });
          appendMockSpan(textLayer, '左栏第二行', { left: 40, top: 122, width: 160, height: 14 });
          appendMockSpan(textLayer, '右栏第一行', { left: 260, top: 100, width: 160, height: 14 });
          appendMockSpan(textLayer, '右栏第二行', { left: 260, top: 122, width: 160, height: 14 });
          pageEl.appendChild(textLayer);
        }}
      />,
    );

    fireEvent.click(screen.getByRole('radio', { name: '拖出摘录' }));
    dragCropBox({ x: 30, y: 90 }, { x: 440, y: 160 });

    const card = await screen.findByTestId('pdf-region-excerpt-card');
    expect(card.getAttribute('data-track')).toBe('native-text');
    expect(visionMock).not.toHaveBeenCalled();

    const textarea = screen.getByTestId('pdf-region-excerpt-text') as HTMLTextAreaElement;
    expect(textarea.value).toBe('左栏第一行左栏第二行\n\n右栏第一行右栏第二行');

    // 点击 [识别文字/公式] 主动补充公式识别结果
    fireEvent.click(screen.getByTestId('pdf-region-recognize-btn'));
    await waitFor(() => expect(visionMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(textarea.value).toContain('A = Q \\Lambda Q^T'));

    // 拖拽摘录胶囊：DS_EXCERPT_MIME 同时包含原图证据、可检索文本与 LaTeX 公式
    const { store, dt } = createMockDataTransfer();
    const dragChip = screen.getByTestId('pdf-region-drag-chip');
    fireEvent.dragStart(dragChip, { dataTransfer: dt });
    fireEvent.dragEnd(dragChip);

    const rawMime = store.get(DS_EXCERPT_MIME);
    expect(rawMime).toBeTruthy();
    const parsed = JSON.parse(rawMime!) as Record<string, unknown>;
    expect(parsed.excerptKind).toBe('region-image');
    expect(String(parsed.imageDataUrl)).toMatch(/^data:image\/png;base64,/);
    expect(String(parsed.text)).toContain('定理 6.1（谱分解）');
    expect(String(parsed.text)).toContain('A = Q \\Lambda Q^T');
    expect(parsed.latex).toBe('$$\nA = Q \\Lambda Q^T\n$$');

    // 同时验证通过标准 kernel.dnd.readExcerptDrag 读取完整合法
    const kernelRead = testDnd.readExcerptDrag({ dataTransfer: dt });
    expect(kernelRead).not.toBeNull();
    expect(kernelRead?.imageDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(kernelRead?.text).toContain('定理 6.1（谱分解）');
    expect(kernelRead?.anchor).toMatchObject({
      kind: 'pdf',
      resourceId: 'tb_matrix',
      aliasResourceId: 'vfs_matrix_1',
      page: 6,
    });
  });

  it('never stalls dragging on scanned PDF pages (0 native spans): drag chip is ready immediately while async OCR resolves or times out', async () => {
    captureMock.mockResolvedValue({
      kind: 'ok',
      blob: new Blob(['scanned-page'], { type: 'image/png' }),
      page: 6,
    });

    let resolveOcr!: (out: { text: string; latex: string }) => void;
    const deferredOcr = vi.fn<PdfRegionVisionRecognizer>(
      () =>
        new Promise((res) => {
          resolveOcr = res;
        }),
    );

    const { container } = render(
      <RegionCaptureHarness
        visionRecognizer={deferredOcr}
        visionTimeoutMs={2000}
        setupPage={() => {
          // 扫描版 PDF：无 .textLayer 节点
        }}
      />,
    );

    fireEvent.click(screen.getByRole('radio', { name: '拖出摘录' }));
    dragCropBox({ x: 50, y: 100 }, { x: 350, y: 260 });

    // OCR 尚未返回时，卡片与拖拽胶囊已立即可拖拽（绝不阻塞拖拽手势）
    const dragChip = await screen.findByTestId('pdf-region-drag-chip');
    expect(deferredOcr).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('pdf-region-track-badge').textContent).toContain('正在识别文字与公式');

    const earlyTransfer = createMockDataTransfer();
    fireEvent.dragStart(dragChip, { dataTransfer: earlyTransfer.dt });
    fireEvent.dragEnd(dragChip);
    const earlyPayload = JSON.parse(earlyTransfer.store.get(DS_EXCERPT_MIME)!) as Record<
      string,
      unknown
    >;
    expect(String(earlyPayload.imageDataUrl)).toMatch(/^data:image\/png;base64,/);

    // 异步 OCR 随后完成：卡片无缝升级为视觉识别文本 + 公式
    await act(async () => {
      resolveOcr({
        text: '扫描页柯西积分公式',
        latex: '$$f(z_0) = \\frac{1}{2\\pi i} \\oint_\\gamma \\frac{f(z)}{z - z_0} dz$$',
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId('pdf-region-excerpt-card').getAttribute('data-track')).toBe(
        'vision-ocr',
      ),
    );

    const enrichedTransfer = createMockDataTransfer();
    fireEvent.dragStart(dragChip, { dataTransfer: enrichedTransfer.dt });
    fireEvent.dragEnd(dragChip);
    const enrichedPayload = JSON.parse(enrichedTransfer.store.get(DS_EXCERPT_MIME)!) as Record<
      string,
      unknown
    >;
    expect(String(enrichedPayload.imageDataUrl)).toMatch(/^data:image\/png;base64,/);
    expect(String(enrichedPayload.text)).toContain('扫描页柯西积分公式');
    expect(String(enrichedPayload.latex)).toContain('\\oint_\\gamma');
    expect(EMOJI_RE.test(container.textContent ?? '')).toBe(false);
  });
});
