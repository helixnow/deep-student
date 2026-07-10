/**
 * O1 — materialTier 单测
 * 覆盖：auto 检测（reduced-motion / reduced-transparency / Linux UA）、
 * html 属性写入、切档平滑过渡标记（data-wb-material-switching）的挂载与
 * 定时移除、快速连切重置计时器、'auto' 恢复跟随检测、首次初始化不走过渡。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectAutoMaterialTier,
  getMaterialTier,
  resetMaterialTierForTests,
  setMaterialTier,
} from '../materialTier';

const HTML_ATTR = 'data-wb-material';
const SWITCHING_ATTR = 'data-wb-material-switching';

/** matchMedia mock：matchingQueries 中的查询返回 matches:true */
function mockMatchMedia(matchingQueries: string[] = []): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: matchingQueries.includes(query),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function stubUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    get: () => ua,
  });
}

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';

beforeEach(() => {
  vi.useFakeTimers();
  mockMatchMedia();
  stubUserAgent(WINDOWS_UA);
  resetMaterialTierForTests();
});

afterEach(() => {
  resetMaterialTierForTests();
  vi.useRealTimers();
});

describe('detectAutoMaterialTier — 平台/系统偏好检测', () => {
  it('无偏好 + 非 Linux → full', () => {
    expect(detectAutoMaterialTier()).toBe('full');
  });

  it('prefers-reduced-motion → minimal（优先级最高）', () => {
    mockMatchMedia(['(prefers-reduced-motion: reduce)', '(prefers-reduced-transparency: reduce)']);
    expect(detectAutoMaterialTier()).toBe('minimal');
  });

  it('prefers-reduced-transparency → reduced', () => {
    mockMatchMedia(['(prefers-reduced-transparency: reduce)']);
    expect(detectAutoMaterialTier()).toBe('reduced');
  });

  it('Linux 桌面 UA → reduced；Android 不算', () => {
    stubUserAgent(LINUX_UA);
    expect(detectAutoMaterialTier()).toBe('reduced');
    stubUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36');
    expect(detectAutoMaterialTier()).toBe('full');
  });
});

describe('档位写入与切档平滑过渡', () => {
  it('首次初始化写入 html 属性，但不挂过渡标记', () => {
    expect(getMaterialTier()).toBe('full');
    expect(document.documentElement.getAttribute(HTML_ATTR)).toBe('full');
    expect(document.documentElement.hasAttribute(SWITCHING_ATTR)).toBe(false);
  });

  it('运行期切档：挂 switching 标记，约 300ms 后自动移除', () => {
    getMaterialTier();
    setMaterialTier('reduced');
    expect(document.documentElement.getAttribute(HTML_ATTR)).toBe('reduced');
    expect(document.documentElement.hasAttribute(SWITCHING_ATTR)).toBe(true);

    vi.advanceTimersByTime(310);
    expect(document.documentElement.hasAttribute(SWITCHING_ATTR)).toBe(false);
    expect(document.documentElement.getAttribute(HTML_ATTR)).toBe('reduced');
  });

  it('快速连切重置计时器（第二次切换后重新计满再移除）', () => {
    getMaterialTier();
    setMaterialTier('reduced');
    vi.advanceTimersByTime(150);
    setMaterialTier('minimal');
    vi.advanceTimersByTime(200);
    // 距第二次切换仅 200ms（< 300ms），标记仍在
    expect(document.documentElement.hasAttribute(SWITCHING_ATTR)).toBe(true);
    vi.advanceTimersByTime(150);
    expect(document.documentElement.hasAttribute(SWITCHING_ATTR)).toBe(false);
    expect(document.documentElement.getAttribute(HTML_ATTR)).toBe('minimal');
  });

  it('设为相同档位不重复挂过渡标记', () => {
    getMaterialTier();
    setMaterialTier('full');
    expect(document.documentElement.hasAttribute(SWITCHING_ATTR)).toBe(false);
  });

  it("setMaterialTier('auto') 恢复跟随检测", () => {
    mockMatchMedia(['(prefers-reduced-transparency: reduce)']);
    setMaterialTier('minimal');
    expect(getMaterialTier()).toBe('minimal');
    setMaterialTier('auto');
    expect(getMaterialTier()).toBe('reduced');
    expect(document.documentElement.getAttribute(HTML_ATTR)).toBe('reduced');
  });
});
