/**
 * 移动端核心 UI/UX 精修单测：
 * 1. isPhoneLandscapeViewport / usePhoneLandscape 横屏自适应判据
 * 2. syncBrowserChromeColor 与 useTheme 状态栏及外壳背景色实时同步
 * 3. UnifiedMobileHeader 4 层阶梯渐进模糊（MobileProgressiveBlurBar）与横屏 40px 紧凑高度
 * 4. computeSelectionToolbarPosition 桌面端上方、触屏下方优先避让与双夹逼
 * 5. useTextSelection 拖拽选区 30ms 延迟弹出、滚动立即隐藏、140ms 停稳重算及滚出/滚回可视区恢复
 */

import React, { useRef } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { MOBILE_LAYOUT } from '@/config/mobileLayout';
import {
  PHONE_LANDSCAPE_MEDIA_QUERY,
  isPhoneLandscapeViewport,
  usePhoneLandscape,
} from '@/hooks/useBreakpoint';
import { syncBrowserChromeColor, useTheme } from '@/hooks/useTheme';
import {
  MobileProgressiveBlurBar,
  UnifiedMobileHeader,
} from '@/components/layout/UnifiedMobileHeader';
import {
  SelectionToolbar,
  computeSelectionToolbarPosition,
} from '../SelectionToolbar';
import { useTextSelection } from '../useTextSelection';

vi.mock('@/utils/settingsApi', () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  saveSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/stores/viewStore', () => ({
  useViewStore: (selector: (s: { currentView: string }) => unknown) =>
    selector({ currentView: 'chat-v2' }),
}));

// 可控 matchMedia 模拟：支持动态触发媒体查询变更订阅
interface MockMediaController {
  setMatches: (query: string, matches: boolean) => void;
  restore: () => void;
}

function installMatchMediaMock(initial: Record<string, boolean> = {}): MockMediaController {
  const originalMatchMedia = window.matchMedia;
  const state = new Map<string, boolean>(Object.entries(initial));
  const listeners = new Map<string, Set<(e: MediaQueryListEvent) => void>>();

  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    if (!listeners.has(query)) {
      listeners.set(query, new Set());
    }
    const queryListeners = listeners.get(query)!;
    return {
      get matches() {
        return state.get(query) ?? false;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
        queryListeners.add(cb);
      },
      removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
        queryListeners.delete(cb);
      },
      addListener: (cb: (e: MediaQueryListEvent) => void) => {
        queryListeners.add(cb);
      },
      removeListener: (cb: (e: MediaQueryListEvent) => void) => {
        queryListeners.delete(cb);
      },
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
  });

  return {
    setMatches(query: string, matches: boolean) {
      state.set(query, matches);
      const queryListeners = listeners.get(query);
      if (queryListeners) {
        const event = { matches, media: query } as MediaQueryListEvent;
        queryListeners.forEach((cb) => cb(event));
      }
    },
    restore() {
      window.matchMedia = originalMatchMedia;
    },
  };
}

describe('1. mobileLayout 配置常量与手机横屏判据 (usePhoneLandscape)', () => {
  afterEach(() => {
    cleanup();
  });

  it('导出约定的移动端布局与时序常量', () => {
    expect(MOBILE_LAYOUT.LANDSCAPE_HEADER_HEIGHT).toBe(40);
    expect(MOBILE_LAYOUT.PROGRESSIVE_BLUR_TAIL_PX).toBe(14);
    expect(MOBILE_LAYOUT.SELECTION_SETTLE_DELAY_MS).toBe(140);
    expect(MOBILE_LAYOUT.SELECTION_RELEASE_DELAY_MS).toBe(30);
    expect(PHONE_LANDSCAPE_MEDIA_QUERY).toBe(
      '(orientation: landscape) and (max-height: 500px) and (max-width: 960px)',
    );
  });

  it('isPhoneLandscapeViewport 准确识别手机横屏并排除竖屏、平板与宽矮桌面窗口', () => {
    // 典型手机横屏
    expect(isPhoneLandscapeViewport(844, 390)).toBe(true);
    expect(isPhoneLandscapeViewport(932, 430)).toBe(true);
    expect(isPhoneLandscapeViewport(667, 375)).toBe(true);
    // 边界值（960x500 仍满足横屏与双上限）
    expect(isPhoneLandscapeViewport(960, 500)).toBe(true);

    // 手机竖屏
    expect(isPhoneLandscapeViewport(390, 844)).toBe(false);
    // 正方形不算 landscape
    expect(isPhoneLandscapeViewport(500, 500)).toBe(false);
    // 平板横屏（高度 > 500）
    expect(isPhoneLandscapeViewport(1024, 768)).toBe(false);
    expect(isPhoneLandscapeViewport(900, 501)).toBe(false);
    // 宽矮桌面窗口（宽度 > 960）
    expect(isPhoneLandscapeViewport(961, 480)).toBe(false);
    expect(isPhoneLandscapeViewport(1440, 460)).toBe(false);
    // 非法视口尺寸
    expect(isPhoneLandscapeViewport(0, 0)).toBe(false);
    expect(isPhoneLandscapeViewport(-800, 390)).toBe(false);
    expect(isPhoneLandscapeViewport(Number.NaN, 390)).toBe(false);
  });

  it('usePhoneLandscape 实时响应媒体查询切换', () => {
    const media = installMatchMediaMock({ [PHONE_LANDSCAPE_MEDIA_QUERY]: false });
    try {
      const Probe: React.FC = () => {
        const isLandscape = usePhoneLandscape();
        return <span data-testid="landscape">{isLandscape ? 'landscape' : 'portrait'}</span>;
      };
      render(<Probe />);
      expect(screen.getByTestId('landscape').textContent).toBe('portrait');

      act(() => {
        media.setMatches(PHONE_LANDSCAPE_MEDIA_QUERY, true);
      });
      expect(screen.getByTestId('landscape').textContent).toBe('landscape');

      act(() => {
        media.setMatches(PHONE_LANDSCAPE_MEDIA_QUERY, false);
      });
      expect(screen.getByTestId('landscape').textContent).toBe('portrait');
    } finally {
      media.restore();
    }
  });
});

describe('2. syncBrowserChromeColor 状态栏与浏览器外壳色实时同步', () => {
  afterEach(() => {
    cleanup();
    document.head.querySelectorAll('meta[name="theme-color"], style[data-test-theme]').forEach((el) => el.remove());
    document.documentElement.style.removeProperty('background-color');
    document.body.style.removeProperty('background-color');
    localStorage.clear();
  });

  it('移除已有 <meta name="theme-color"> 的 media 属性并同步真实计算背景色到 meta、html 与 body', () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('media', '(prefers-color-scheme: light)');
    meta.setAttribute('content', '#ffffff');
    document.head.appendChild(meta);

    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-test-theme', 'true');
    styleEl.textContent = `
      html { background-color: rgb(247, 248, 250); }
      html[data-theme="dark"] { background-color: rgb(15, 19, 23); }
    `;
    document.head.appendChild(styleEl);

    document.documentElement.setAttribute('data-theme', 'light');
    const lightSynced = syncBrowserChromeColor(document);
    expect(lightSynced).toBe('rgb(247, 248, 250)');
    expect(meta.hasAttribute('media')).toBe(false);
    expect(meta.getAttribute('content')).toBe('rgb(247, 248, 250)');
    expect(document.documentElement.style.backgroundColor).toBe('rgb(247, 248, 250)');
    expect(document.body.style.backgroundColor).toBe('rgb(247, 248, 250)');

    // 切换暗色后再次调用：自动剥离上次内联值并采样新的暗色规则
    document.documentElement.setAttribute('data-theme', 'dark');
    const darkSynced = syncBrowserChromeColor(document);
    expect(darkSynced).toBe('rgb(15, 19, 23)');
    expect(meta.getAttribute('content')).toBe('rgb(15, 19, 23)');
    expect(document.documentElement.style.backgroundColor).toBe('rgb(15, 19, 23)');
    expect(document.body.style.backgroundColor).toBe('rgb(15, 19, 23)');
  });

  it('缺失 <meta name="theme-color"> 时自动创建，并在 useTheme 切换主题时自动触发同步', () => {
    const media = installMatchMediaMock({ '(prefers-color-scheme: dark)': false });
    try {
      expect(document.head.querySelector('meta[name="theme-color"]')).toBeNull();

      const styleEl = document.createElement('style');
      styleEl.setAttribute('data-test-theme', 'true');
      styleEl.textContent = `
        html[data-theme="light"] { background-color: rgb(255, 255, 255); }
        html[data-theme="dark"] { background-color: rgb(18, 18, 22); }
      `;
      document.head.appendChild(styleEl);

      const ThemeHarness: React.FC = () => {
        const { isDarkMode, setThemeMode } = useTheme();
        return (
          <button
            type="button"
            data-testid="toggle-dark"
            onClick={() => setThemeMode(isDarkMode ? 'light' : 'dark')}
          >
            {isDarkMode ? 'dark' : 'light'}
          </button>
        );
      };

      render(<ThemeHarness />);
      const createdMeta = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      expect(createdMeta).not.toBeNull();
      expect(createdMeta?.getAttribute('content')).toBe('rgb(255, 255, 255)');

      fireEvent.click(screen.getByTestId('toggle-dark'));
      expect(createdMeta?.getAttribute('content')).toBe('rgb(18, 18, 22)');
      expect(document.body.style.backgroundColor).toBe('rgb(18, 18, 22)');
    } finally {
      media.restore();
    }
  });

  it('window.matchMedia 未定义时 useTheme 安全降级不抛异常', () => {
    const originalMatchMedia = window.matchMedia;
    // @ts-expect-error 模拟无 matchMedia 环境
    window.matchMedia = undefined;
    try {
      const SafeThemeProbe: React.FC = () => {
        const { isDarkMode, setThemeMode } = useTheme();
        return (
          <button
            type="button"
            data-testid="safe-theme-btn"
            onClick={() => setThemeMode(isDarkMode ? 'light' : 'dark')}
          >
            {isDarkMode ? 'dark' : 'light'}
          </button>
        );
      };
      render(<SafeThemeProbe />);
      expect(screen.getByTestId('safe-theme-btn').textContent).toBe('light');
      fireEvent.click(screen.getByTestId('safe-theme-btn'));
      expect(screen.getByTestId('safe-theme-btn').textContent).toBe('dark');
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});

describe('3. UnifiedMobileHeader 4 层渐进模糊与横屏 40px 紧凑高度', () => {
  afterEach(() => {
    cleanup();
  });

  it('默认启用 4 层阶梯渐进模糊（1px/2px/4px/8px saturate(140%)）与 14px 羽化尾迹', () => {
    const media = installMatchMediaMock({ [PHONE_LANDSCAPE_MEDIA_QUERY]: false });
    try {
      const { container } = render(<UnifiedMobileHeader fallbackTitle="会话" />);
      const header = container.querySelector<HTMLElement>('header[data-mobile-shell="header"]');
      expect(header).not.toBeNull();
      expect(header?.style.height).toBe('var(--mobile-header-total-height, 56px)');
      expect(header?.className).not.toContain('h-10');

      const blurBar = container.querySelector<HTMLElement>('[data-mobile-progressive-blur="top"]');
      expect(blurBar).not.toBeNull();
      expect(blurBar?.className).toContain('pointer-events-none');
      expect(blurBar?.style.top).toBe('0px');
      expect(blurBar?.style.bottom).toBe('-14px');

      const layers = blurBar!.querySelectorAll<HTMLElement>('[data-blur-layer]');
      expect(layers).toHaveLength(4);
      expect(layers[0].style.backdropFilter).toBe('blur(1px)');
      expect(layers[1].style.backdropFilter).toBe('blur(2px)');
      expect(layers[2].style.backdropFilter).toBe('blur(4px)');
      expect(layers[3].style.backdropFilter).toBe('blur(8px) saturate(140%)');
      expect(layers[0].style.maskImage).toContain('linear-gradient(to bottom');
      expect(layers[3].style.maskImage).toContain('42%');

      const tint = blurBar!.querySelector<HTMLElement>('[data-blur-tint]');
      expect(tint?.style.backgroundImage).toContain('hsl(var(--background)');
    } finally {
      media.restore();
    }
  });

  it('MobileProgressiveBlurBar 支持 position="bottom" 向上延伸 14px 羽化尾迹', () => {
    const { container } = render(<MobileProgressiveBlurBar position="bottom" />);
    const blurBar = container.querySelector<HTMLElement>('[data-mobile-progressive-blur="bottom"]');
    expect(blurBar).not.toBeNull();
    expect(blurBar?.style.bottom).toBe('0px');
    expect(blurBar?.style.top).toBe('-14px');
    const firstLayer = blurBar!.querySelector<HTMLElement>('[data-blur-layer="1"]');
    expect(firstLayer?.style.maskImage).toContain('linear-gradient(to top');
  });

  it('手机横屏下自动切换为 40px 紧凑高度（h-10）并设置左右安全区内边距', () => {
    const media = installMatchMediaMock({ [PHONE_LANDSCAPE_MEDIA_QUERY]: true });
    try {
      const { container } = render(<UnifiedMobileHeader fallbackTitle="课程笔记" />);
      const header = container.querySelector<HTMLElement>('header[data-mobile-shell="header"]');
      expect(header).not.toBeNull();
      expect(header?.className).toContain('h-10');
      expect(header?.style.height).toBe('40px');
      expect(header?.style.minHeight).toBe('40px');
      expect(header?.style.paddingLeft).toBe('max(12px, env(safe-area-inset-left))');
      expect(header?.style.paddingRight).toBe('max(12px, env(safe-area-inset-right))');
    } finally {
      media.restore();
    }
  });
});

describe('4. computeSelectionToolbarPosition 桌面与触屏定位及双夹逼', () => {
  afterEach(() => {
    cleanup();
  });

  it('桌面端（精细指针）默认置于选区上方 rect.top - 46px', () => {
    const pos = computeSelectionToolbarPosition(
      { top: 200, left: 300, width: 100, height: 20, bottom: 220 },
      { isCoarsePointer: false, innerWidth: 1280, innerHeight: 800 },
    );
    expect(pos.placement).toBe('above');
    expect(pos.top).toBe(154); // 200 - 46
    expect(pos.left).toBe(350); // 300 + 100 / 2
  });

  it('触屏端（isCoarsePointer === true）优先置于选区下方 rect.bottom + 12px，距底部不足 56px 时翻到上方', () => {
    // 视口下方空间充裕：844 - 220 = 624 >= 56 -> 下方 220 + 12 = 232
    const belowPos = computeSelectionToolbarPosition(
      { top: 200, left: 140, width: 80, height: 20, bottom: 220 },
      { isCoarsePointer: true, innerWidth: 390, innerHeight: 844 },
    );
    expect(belowPos.placement).toBe('below');
    expect(belowPos.top).toBe(232);
    expect(belowPos.left).toBe(180);

    // 距视口底部不足 56px：844 - 800 = 44 < 56 -> 翻转至选区上方 780 - 46 = 734
    const flippedPos = computeSelectionToolbarPosition(
      { top: 780, left: 140, width: 80, height: 20, bottom: 800 },
      { isCoarsePointer: true, innerWidth: 390, innerHeight: 844 },
    );
    expect(flippedPos.placement).toBe('above');
    expect(flippedPos.top).toBe(734);
  });

  it('严格执行水平 [100, innerWidth - 100] 与垂直 [8, innerHeight - 52] 双夹逼', () => {
    // 左上超界：rawCenterX = 30 -> 100；rawTop = 20 - 46 = -26 -> 8
    const topLeftClamped = computeSelectionToolbarPosition(
      { top: 20, left: 10, width: 40, height: 20, bottom: 40 },
      { isCoarsePointer: false, innerWidth: 390, innerHeight: 844 },
    );
    expect(topLeftClamped.left).toBe(100);
    expect(topLeftClamped.top).toBe(8);

    // 右下超界：rawCenterX = 365 -> 390 - 100 = 290；rawTop = 842 - 46 = 796 -> 844 - 52 = 792
    const bottomRightClamped = computeSelectionToolbarPosition(
      { top: 842, left: 345, width: 40, height: 18, bottom: 860 },
      { isCoarsePointer: false, innerWidth: 390, innerHeight: 844 },
    );
    expect(bottomRightClamped.left).toBe(290);
    expect(bottomRightClamped.top).toBe(792);
  });

  it('SelectionToolbar 组件在粗指针视口下实际渲染到选区下方', () => {
    const media = installMatchMediaMock({ '(pointer: coarse)': true });
    const prevWidth = window.innerWidth;
    const prevHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });

    try {
      const Host: React.FC = () => {
        const containerRef = useRef<HTMLDivElement>(null);
        return (
          <div ref={containerRef} style={{ position: 'relative' }}>
            <SelectionToolbar
              selectedText="量子纠缠"
              selectionRect={{ top: 180, left: 120, width: 90, height: 22, bottom: 202 }}
              isVisible
              containerRef={containerRef}
              onClear={() => {}}
            />
          </div>
        );
      };
      const { container } = render(<Host />);
      const toolbar = container.querySelector<HTMLElement>('[data-selection-toolbar]');
      expect(toolbar).not.toBeNull();
      expect(toolbar?.dataset.placement).toBe('below');
      expect(toolbar?.style.top).toBe('214px'); // 202 + 12
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: prevWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: prevHeight });
      media.restore();
    }
  });
});

describe('5. useTextSelection 拖拽抑制、30ms 松手延迟、滚动隐藏与 140ms 停稳重现', () => {
  let currentRangeRect = {
    top: 160,
    left: 120,
    width: 100,
    height: 20,
    bottom: 180,
    right: 220,
    x: 120,
    y: 160,
    toJSON: () => ({}),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    window.getSelection()?.removeAllRanges();
    currentRangeRect = {
      top: 160,
      left: 120,
      width: 100,
      height: 20,
      bottom: 180,
      right: 220,
      x: 120,
      y: 160,
      toJSON: () => ({}),
    };
    (Range.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
      () => currentRangeRect as DOMRect;
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    vi.useRealTimers();
    cleanup();
  });

  function SelectionProbe({ containerBounds }: { containerBounds?: Partial<DOMRect> }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const sel = useTextSelection(containerRef);

    React.useLayoutEffect(() => {
      if (containerRef.current && containerBounds) {
        containerRef.current.getBoundingClientRect = () =>
          ({
            top: 0,
            left: 0,
            right: 390,
            bottom: 600,
            width: 390,
            height: 600,
            x: 0,
            y: 0,
            toJSON: () => ({}),
            ...containerBounds,
          }) as DOMRect;
      }
    }, [containerBounds]);

    return (
      <div ref={containerRef} data-testid="selection-host">
        <p data-testid="selectable-paragraph">深度求索移动端划词与渐进模糊体验验证文本</p>
        <span data-testid="visible">{sel.isVisible ? 'yes' : 'no'}</span>
        <span data-testid="scrolling">{sel.isScrolling ? 'yes' : 'no'}</span>
        <span data-testid="dragging">{sel.isDraggingSelection ? 'yes' : 'no'}</span>
        <span data-testid="rect-top">{sel.selectionRect ? String(sel.selectionRect.top) : 'none'}</span>
      </div>
    );
  }

  function createSelectionInParagraph() {
    const p = screen.getByTestId('selectable-paragraph');
    const textNode = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 8);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  it('pointerdown 拖拽选区期间抑制弹出，pointerup 后满 30ms 才定位显示', () => {
    render(<SelectionProbe />);
    const p = screen.getByTestId('selectable-paragraph');

    act(() => {
      fireEvent.pointerDown(p, { button: 0, pointerType: 'touch' });
    });
    expect(screen.getByTestId('dragging').textContent).toBe('yes');

    // 拖拽中途选区变化且超过防抖时长，仍被抑制不弹出
    act(() => {
      createSelectionInParagraph();
      document.dispatchEvent(new Event('selectionchange'));
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByTestId('visible').textContent).toBe('no');

    // 松手瞬间及 29ms 内保持隐藏（避开系统放大镜退场），满 30ms 显示
    act(() => {
      fireEvent.pointerUp(document, { button: 0, pointerType: 'touch' });
    });
    expect(screen.getByTestId('dragging').textContent).toBe('no');
    expect(screen.getByTestId('visible').textContent).toBe('no');

    act(() => {
      vi.advanceTimersByTime(29);
    });
    expect(screen.getByTestId('visible').textContent).toBe('no');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('visible').textContent).toBe('yes');
    expect(screen.getByTestId('rect-top').textContent).toBe('160');
  });

  it('滚动开始立即隐藏工具栏，停稳 140ms 后重算新坐标并恢复；滚出容器可视区保持隐藏，滚回后恢复', () => {
    render(
      <SelectionProbe
        containerBounds={{ top: 50, bottom: 500, left: 0, right: 390, width: 390, height: 450 }}
      />,
    );

    // 初始划词成功显示
    act(() => {
      createSelectionInParagraph();
      fireEvent.pointerUp(document, { button: 0, pointerType: 'touch' });
      vi.advanceTimersByTime(30);
    });
    expect(screen.getByTestId('visible').textContent).toBe('yes');
    expect(screen.getByTestId('rect-top').textContent).toBe('160');

    // 第一次滚动：向上滚了 40px（仍在容器 [50, 500] 可视区内）
    currentRangeRect = { ...currentRangeRect, top: 120, bottom: 140, y: 120 };
    act(() => {
      fireEvent.scroll(screen.getByTestId('selection-host'));
    });
    // 滚动开始立即置 isScrolling = true 并隐藏工具栏
    expect(screen.getByTestId('scrolling').textContent).toBe('yes');
    expect(screen.getByTestId('visible').textContent).toBe('no');

    // 连续滚动续期定时器：100ms 时再滚一次，满 140ms 后才停稳恢复
    act(() => {
      vi.advanceTimersByTime(100);
      fireEvent.scroll(screen.getByTestId('selection-host'));
      vi.advanceTimersByTime(139);
    });
    expect(screen.getByTestId('visible').textContent).toBe('no');
    expect(screen.getByTestId('scrolling').textContent).toBe('yes');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('scrolling').textContent).toBe('no');
    expect(screen.getByTestId('visible').textContent).toBe('yes');
    expect(screen.getByTestId('rect-top').textContent).toBe('120');

    // 第二次滚动：选区滚出容器上边缘（bottom = 40 <= container.top = 50）
    currentRangeRect = { ...currentRangeRect, top: 20, bottom: 40, y: 20 };
    act(() => {
      fireEvent.scroll(screen.getByTestId('selection-host'));
      vi.advanceTimersByTime(140);
    });
    expect(screen.getByTestId('scrolling').textContent).toBe('no');
    expect(screen.getByTestId('visible').textContent).toBe('no');

    // 第三次滚动：选区重新滚回容器可视区（top = 210, bottom = 230）-> 自动恢复显示
    currentRangeRect = { ...currentRangeRect, top: 210, bottom: 230, y: 210 };
    act(() => {
      fireEvent.scroll(screen.getByTestId('selection-host'));
      vi.advanceTimersByTime(140);
    });
    expect(screen.getByTestId('scrolling').textContent).toBe('no');
    expect(screen.getByTestId('visible').textContent).toBe('yes');
    expect(screen.getByTestId('rect-top').textContent).toBe('210');

    // 第四步：容器外 pointerdown + mousedown 正常顺序触发时完整清空选区状态
    act(() => {
      fireEvent.pointerDown(document.body, { button: 0, pointerType: 'mouse' });
      fireEvent.mouseDown(document.body, { button: 0 });
    });
    expect(screen.getByTestId('visible').textContent).toBe('no');
    expect(screen.getByTestId('rect-top').textContent).toBe('none');
  });
});
