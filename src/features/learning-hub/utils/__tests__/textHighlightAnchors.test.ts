import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  arbitrateAnnotationPointerInput,
  computeContentSignature,
  createTextHighlightAnchor,
  formatHighlightCitationForPrompt,
  resetSharedPalmRejectedPointers,
  resolveTextHighlightAnchor,
} from '../textHighlightAnchors';
import {
  createSourceImageLoadScheduler,
  parseSourceImageHref,
  SourceImageViewer,
  type SourceImageLoadPayload,
} from '../../components/SourceImageViewer';

describe('textHighlightAnchors (W3C TextPositionSelector + TextQuoteSelector)', () => {
  beforeEach(() => {
    resetSharedPalmRejectedPointers();
  });

  it('hits immediately when character range [start, end] matches exact text', () => {
    const text = '第一章 极限与连续：当自变量趋近于零时，无穷小的阶数比较是求极限的核心工具。';
    const start = text.indexOf('无穷小的阶数比较');
    const end = start + '无穷小的阶数比较'.length;

    const anchor = createTextHighlightAnchor(text, start, end, {
      format: 'pdf',
      pageOrSegment: 4,
    });

    expect(anchor.exact).toBe('无穷小的阶数比较');
    expect(anchor.start).toBe(start);
    expect(anchor.end).toBe(end);

    const resolved = resolveTextHighlightAnchor(text, anchor, anchor.contentSignature);
    expect(resolved).toEqual({
      status: 'resolved',
      start,
      end,
      exact: '无穷小的阶数比较',
      relocated: false,
    });
  });

  it('relocates shifted text and disambiguates multiple exact matches using prefix + suffix', () => {
    const originalText =
      '甲段说明：收敛数列必有界。乙段深入：在实数完备性体系下，收敛数列必有界这一性质尤为关键。';
    const secondOccurrence = originalText.lastIndexOf('收敛数列必有界');
    const anchor = createTextHighlightAnchor(
      originalText,
      secondOccurrence,
      secondOccurrence + '收敛数列必有界'.length,
      {
        format: 'markdown',
        pageOrSegment: 2,
        contextLength: 10,
      }
    );

    // 模拟排版重排后在开头插入了前置页眉空白，但保持锚点记录的签名以触发重定位逻辑
    const reflowedText = `【章节导读】\n${originalText}`;
    const expectedNewStart = reflowedText.lastIndexOf('收敛数列必有界');

    const resolved = resolveTextHighlightAnchor(
      reflowedText,
      anchor,
      anchor.contentSignature
    );

    expect(resolved).toEqual({
      status: 'resolved',
      start: expectedNewStart,
      end: expectedNewStart + '收敛数列必有界'.length,
      exact: '收敛数列必有界',
      relocated: true,
    });
  });

  it('returns status="ambiguous" without guessing when multiple occurrences have identical context', () => {
    const repeatedUnit = '定理：一致连续必连续。';
    const fullText = `前文：${repeatedUnit}中间过渡：${repeatedUnit}后文`;
    const firstIdx = fullText.indexOf('一致连续必连续');

    const anchor = createTextHighlightAnchor(
      fullText,
      firstIdx,
      firstIdx + '一致连续必连续'.length,
      {
        format: 'docx',
        pageOrSegment: 1,
        contextLength: 3, // prefix 均为 "定理："，suffix 均为 "。中间" / "。后文" 中的 "。"
      }
    );
    // 将 suffix 收缩为相同句号并令 start 偏移，构造完全对称的多处候选
    const ambiguousAnchor = {
      ...anchor,
      start: firstIdx + 3,
      end: firstIdx + 3 + anchor.exact.length,
      prefix: '定理：',
      suffix: '。',
    };

    const resolved = resolveTextHighlightAnchor(
      fullText,
      ambiguousAnchor,
      ambiguousAnchor.contentSignature
    );
    expect(resolved.status).toBe('ambiguous');
    if (resolved.status === 'ambiguous') {
      expect(resolved.candidates).toHaveLength(2);
    }
  });

  it('isolates modified content by returning status="detached" with reason="content_modified"', () => {
    const v1Text = '原始段落：梯度方向是函数值增长最快的方向。';
    const start = v1Text.indexOf('梯度方向');
    const anchor = createTextHighlightAnchor(v1Text, start, start + 4, {
      format: 'html',
      pageOrSegment: 5,
    });

    const v2Text = '修订后段落：负梯度方向是函数值下降最快的方向。';
    const v2Signature = computeContentSignature(v2Text);

    const resolved = resolveTextHighlightAnchor(v2Text, anchor, v2Signature);
    expect(resolved).toEqual({
      status: 'detached',
      reason: 'content_modified',
      exact: '梯度方向',
    });
  });

  it('arbitrates pen, touch, mouse and enforces palm rejection until pointerup/pointercancel', () => {
    const palmSet = new Set<number>();

    // 1. 智能批注模式下：pen 书写、mouse 选字、普通 touch 滚动
    expect(
      arbitrateAnnotationPointerInput(
        { pointerId: 1, pointerType: 'pen', type: 'pointerdown' },
        { smartAnnotation: true, palmRejectedPointerIds: palmSet }
      )
    ).toBe('draw');

    expect(
      arbitrateAnnotationPointerInput(
        { pointerId: 2, pointerType: 'mouse', type: 'pointerdown' },
        { smartAnnotation: true, palmRejectedPointerIds: palmSet }
      )
    ).toBe('select');

    expect(
      arbitrateAnnotationPointerInput(
        { pointerId: 3, pointerType: 'touch', type: 'pointerdown', width: 10, height: 10 },
        { smartAnnotation: true, palmRejectedPointerIds: palmSet }
      )
    ).toBe('scroll');

    // 2. 触控笔落笔期间（activePenStroke=true）或大面积接触（width>=28）被标记为掌触黑名单
    expect(
      arbitrateAnnotationPointerInput(
        { pointerId: 89, pointerType: 'touch', type: 'pointerdown', width: 42, height: 36 },
        { smartAnnotation: true, activePenStroke: true, palmRejectedPointerIds: palmSet }
      )
    ).toBe('ignore-palm');
    expect(palmSet.has(89)).toBe(true);

    // 3. 即使笔已抬起（activePenStroke=false）且接触面积缩小，只要 pointerId=89 未离屏，仍保持 ignore-palm
    expect(
      arbitrateAnnotationPointerInput(
        { pointerId: 89, pointerType: 'touch', type: 'pointermove', width: 8, height: 8 },
        { smartAnnotation: true, activePenStroke: false, palmRejectedPointerIds: palmSet }
      )
    ).toBe('ignore-palm');
    expect(palmSet.has(89)).toBe(true);

    // 4. pointerup 离屏后才从黑名单移除
    expect(
      arbitrateAnnotationPointerInput(
        { pointerId: 89, pointerType: 'touch', type: 'pointerup' },
        { smartAnnotation: true, activePenStroke: false, palmRejectedPointerIds: palmSet }
      )
    ).toBe('ignore-palm');
    expect(palmSet.has(89)).toBe(false);

    // 5. 离屏后再次落指，恢复正常滚动手势
    expect(
      arbitrateAnnotationPointerInput(
        { pointerId: 89, pointerType: 'touch', type: 'pointerdown', width: 10, height: 10 },
        { smartAnnotation: true, activePenStroke: false, palmRejectedPointerIds: palmSet }
      )
    ).toBe('scroll');
  });

  it('escapes <, >, & in exact text and wraps citation with <mark> and page/segment label', () => {
    const citation = formatHighlightCitationForPrompt(
      {
        format: 'pdf',
        pageOrSegment: 3,
        exact: '当 0 < x < 1 & y > 0 时成立 <script>alert(1)</script>',
      },
      { materialTitle: '高等数学讲义.pdf' }
    );

    expect(citation).toBe(
      '[高等数学讲义.pdf · 第 3 页] <mark>当 0 &lt; x &lt; 1 &amp; y &gt; 0 时成立 &lt;script&gt;alert(1)&lt;/script&gt;</mark>'
    );
  });
});

describe('SourceImageViewer reference parser & 2-way concurrency queue', () => {
  it('parses valid #source-image references and formats page/region labels', () => {
    const regionRef = parseSourceImageHref(
      '#source-image/calc-101/page-3-region-0-120-1000-360'
    );
    expect(regionRef).toBeDefined();
    expect(regionRef?.resourceId).toBe('calc-101');
    expect(regionRef?.page).toBe(3);
    expect(regionRef?.region).toEqual({ x: 0, y: 120, width: 1000, height: 360 });
    expect(regionRef?.label).toBe('第 3 页 · 区域 12%–48%');

    const digestRef = parseSourceImageHref(
      '#source-image/docx-note/image-2-a1b2c3d4e5f60718'
    );
    expect(digestRef).toBeDefined();
    expect(digestRef?.unit).toBe(2);
    expect(digestRef?.versionDigest).toBe('a1b2c3d4e5f60718');
    expect(digestRef?.label).toBe('第 2 段');

    // 非法引用全部拒绝
    expect(parseSourceImageHref('#source-image/calc-101/page-0')).toBeUndefined();
    expect(
      parseSourceImageHref('#source-image/calc-101/page-2-region-999-0-2-100')
    ).toBeUndefined();
    expect(parseSourceImageHref('https://example.com/a.png')).toBeUndefined();
    expect(parseSourceImageHref('#source-image/%XX/page-1')).toBeUndefined();
  });

  it('caps concurrent loads at 2, queues excess tasks, and deduplicates identical in-flight requests', async () => {
    const scheduler = createSourceImageLoadScheduler(2);
    const resolvers: Array<(payload: SourceImageLoadPayload) => void> = [];
    const startedKeys: string[] = [];

    const makeTask = (key: string) =>
      vi.fn(
        () =>
          new Promise<SourceImageLoadPayload>((resolve) => {
            startedKeys.push(key);
            resolvers.push(resolve);
          })
      );

    const taskA1 = makeTask('A');
    const taskA2 = makeTask('A-dup');
    const taskB = makeTask('B');
    const taskC = makeTask('C');

    const pA1 = scheduler.load('res::img-1', taskA1);
    const pA2 = scheduler.load('res::img-1', taskA2); // 相同引用合并
    const pB = scheduler.load('res::img-2', taskB);
    const pC = scheduler.load('res::img-3', taskC); // 第 3 路进入排队

    expect(pA1).toBe(pA2);
    expect(taskA1).toHaveBeenCalledTimes(1);
    expect(taskA2).not.toHaveBeenCalled();
    expect(startedKeys).toEqual(['A', 'B']);
    expect(scheduler.getStats()).toEqual({
      activeCount: 2,
      queuedCount: 1,
      inFlightKeys: ['res::img-1', 'res::img-2', 'res::img-3'],
    });

    // 完成第一路后，排队的 C 自动启动
    resolvers[0]({ status: 'ok', src: 'data:image/png;base64,AAA=' });
    await pA1;
    await new Promise((r) => setTimeout(r, 0));

    expect(startedKeys).toEqual(['A', 'B', 'C']);
    expect(scheduler.getStats().activeCount).toBe(2);
    expect(scheduler.getStats().queuedCount).toBe(0);

    resolvers[1]({ status: 'ok', src: 'data:image/png;base64,BBB=' });
    resolvers[2]({ status: 'ok', src: 'data:image/png;base64,CCC=' });
    await Promise.all([pB, pC]);

    expect(scheduler.getStats()).toEqual({
      activeCount: 0,
      queuedCount: 0,
      inFlightKeys: [],
    });
  });

  it('waits for IntersectionObserver viewport entry before loading, renders zoom controls, revokes Blob URL on unmount, and shows fallback actions on version digest mismatch', async () => {
    if (typeof URL.createObjectURL !== 'function') {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: () => 'blob:default',
      });
    }
    if (typeof URL.revokeObjectURL !== 'function') {
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: () => {},
      });
    }

    let ioCallback: IntersectionObserverCallback | null = null;
    const OriginalIO = globalThis.IntersectionObserver;
    class MockIntersectionObserver {
      constructor(cb: IntersectionObserverCallback) {
        ioCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    globalThis.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof IntersectionObserver;

    const triggerIntersect = () => {
      act(() => {
        ioCallback?.(
          [{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
          {} as IntersectionObserver
        );
      });
    };

    const createObjectURLSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:mock-source-image-1');
    const revokeObjectURLSpy = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {});

    const onReturnToSource = vi.fn();
    const loader = vi.fn().mockResolvedValue({
      status: 'ok',
      blob: new Blob(['png-bytes'], { type: 'image/png' }),
    });

    const { unmount } = render(
      React.createElement(SourceImageViewer, {
        href: '#source-image/course-math/page-3-region-0-120-1000-360',
        loader,
        onReturnToSource,
      })
    );

    // 未进入视口前不触发加载
    expect(screen.getByTestId('source-image-lazy-placeholder')).toBeInTheDocument();
    expect(loader).not.toHaveBeenCalled();

    // 触发进入视口
    triggerIntersect();

    await waitFor(() => {
      expect(screen.getByTestId('source-image-element')).toBeInTheDocument();
    });

    expect(screen.getByTestId('source-image-location-label')).toHaveTextContent(
      '第 3 页 · 区域 12%–48%'
    );
    expect(screen.getByTestId('source-image-zoom-value')).toHaveTextContent('100%');

    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    expect(screen.getByTestId('source-image-zoom-value')).toHaveTextContent('125%');

    fireEvent.click(screen.getByRole('button', { name: '适应宽度' }));
    expect(screen.getByTestId('source-image-zoom-value')).toHaveTextContent('100%');

    fireEvent.click(screen.getByTestId('source-image-return-btn'));
    expect(onReturnToSource).toHaveBeenCalledTimes(1);

    unmount();
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:mock-source-image-1');

    // 测试版本摘要不匹配时的克制就地提示卡
    const mismatchLoader = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'ok',
        versionDigest: 'deadbeef00000000',
        blob: new Blob(['old'], { type: 'image/png' }),
      })
      .mockResolvedValueOnce({
        status: 'ok',
        versionDigest: 'a1b2c3d4e5f60718',
        src: 'data:image/png;base64,iVBORw0KGgo=',
      });

    render(
      React.createElement(SourceImageViewer, {
        href: '#source-image/course-math/image-2-a1b2c3d4e5f60718',
        loader: mismatchLoader,
        onOpenSource: onReturnToSource,
      })
    );

    triggerIntersect();

    await waitFor(() => {
      expect(screen.getByTestId('source-image-error-card')).toBeInTheDocument();
    });
    expect(screen.getByTestId('source-image-error-card')).toHaveTextContent(
      '材料内容已更新，原图版本摘要不匹配'
    );
    expect(screen.getByTestId('source-image-open-source-btn')).toHaveTextContent('打开原文');

    await act(async () => {
      fireEvent.click(screen.getByTestId('source-image-retry-btn'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('source-image-element')).toBeInTheDocument();
    });

    globalThis.IntersectionObserver = OriginalIO;
    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
  });
});
