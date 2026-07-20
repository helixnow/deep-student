/**
 * 软件渲染探测单测（materialTier auto 检测增补）
 * 覆盖：SwiftShader/WARP/llvmpipe/Software 特征命中 → reduced（大小写不敏感）、
 * 硬件渲染器不降档、探测结果模块级缓存（只探一次）、探测失败/异常/扩展缺失
 * 时保守不降档、移动端与已命中其他降档分支时不探、探测后释放 context、
 * 显式档位覆盖不受探测影响。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectAutoMaterialTier,
  getMaterialTier,
  resetMaterialTierForTests,
  setMaterialTier,
} from '../materialTier';

const UNMASKED_RENDERER_WEBGL = 0x9246;

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
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Mobile';

const loseContextMock = vi.fn();

/** 构造最小可用的 WebGL context stub：只实现探测所需的 getExtension/getParameter */
function makeGlStub(renderer: string | null): Partial<WebGLRenderingContext> {
  return {
    getExtension: vi.fn().mockImplementation((name: string) => {
      if (name === 'WEBGL_debug_renderer_info') {
        return renderer === null ? null : { UNMASKED_RENDERER_WEBGL };
      }
      if (name === 'WEBGL_lose_context') {
        return { loseContext: loseContextMock };
      }
      return null;
    }),
    getParameter: vi.fn().mockImplementation((pname: number) =>
      pname === UNMASKED_RENDERER_WEBGL ? renderer : null,
    ),
  };
}

/** mock canvas.getContext：返回指定渲染器字符串的 gl stub（null = 拿不到 context） */
function mockWebGl(renderer: string | null, options?: { noDebugExtension?: boolean }) {
  const gl = options?.noDebugExtension ? makeGlStub(null) : makeGlStub(renderer);
  const spy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(((kind: string) =>
      kind === 'webgl' && renderer !== null ? gl : null) as typeof HTMLCanvasElement.prototype.getContext);
  return { spy, gl };
}

beforeEach(() => {
  mockMatchMedia();
  stubUserAgent(WINDOWS_UA);
  loseContextMock.mockClear();
  resetMaterialTierForTests();
});

afterEach(() => {
  resetMaterialTierForTests();
  vi.restoreAllMocks();
});

describe('软件渲染探测 → reduced', () => {
  it.each([
    'Google SwiftShader',
    'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 WARP)',
    'llvmpipe (LLVM 15.0.7, 256 bits)',
    'Generic Software Rasterizer',
    'GOOGLE SWIFTSHADER', // 大小写不敏感
  ])('渲染器 "%s" → reduced', (renderer) => {
    mockWebGl(renderer);
    expect(detectAutoMaterialTier()).toBe('reduced');
  });

  it('硬件渲染器 → full（不降档）', () => {
    mockWebGl('ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0)');
    expect(detectAutoMaterialTier()).toBe('full');
  });

  it('探测后立即释放 context（WEBGL_lose_context.loseContext）', () => {
    mockWebGl('Google SwiftShader');
    detectAutoMaterialTier();
    expect(loseContextMock).toHaveBeenCalledTimes(1);
  });
});

describe('探测结果缓存（只探一次）', () => {
  it('多次检测只创建一次 context，reset 后重探', () => {
    const { spy } = mockWebGl('Google SwiftShader');
    expect(detectAutoMaterialTier()).toBe('reduced');
    expect(detectAutoMaterialTier()).toBe('reduced');
    detectAutoMaterialTier();
    expect(spy).toHaveBeenCalledTimes(1);

    resetMaterialTierForTests();
    detectAutoMaterialTier();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('缓存后即使渲染器 mock 改变，结果不变（会话内固定）', () => {
    mockWebGl('ANGLE (NVIDIA, hardware)');
    expect(detectAutoMaterialTier()).toBe('full');
    vi.restoreAllMocks();
    mockWebGl('Google SwiftShader');
    expect(detectAutoMaterialTier()).toBe('full');
  });
});

describe('探测失败/异常 → 保守不降档', () => {
  it('拿不到 WebGL context → full', () => {
    mockWebGl(null);
    expect(detectAutoMaterialTier()).toBe('full');
  });

  it('WEBGL_debug_renderer_info 扩展缺失 → full', () => {
    mockWebGl('Google SwiftShader', { noDebugExtension: true });
    expect(detectAutoMaterialTier()).toBe('full');
  });

  it('getContext 抛异常 → full', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(detectAutoMaterialTier()).toBe('full');
  });
});

describe('探测触发条件', () => {
  it('移动端（Android UA）不探测', () => {
    stubUserAgent(ANDROID_UA);
    const { spy } = mockWebGl('Google SwiftShader');
    expect(detectAutoMaterialTier()).toBe('full');
    expect(spy).not.toHaveBeenCalled();
  });

  it('已命中 prefers-reduced-motion（minimal）时不探测', () => {
    mockMatchMedia(['(prefers-reduced-motion: reduce)']);
    const { spy } = mockWebGl('Google SwiftShader');
    expect(detectAutoMaterialTier()).toBe('minimal');
    expect(spy).not.toHaveBeenCalled();
  });

  it('Linux 桌面 UA 已降 reduced 时不探测', () => {
    stubUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36');
    const { spy } = mockWebGl('llvmpipe');
    expect(detectAutoMaterialTier()).toBe('reduced');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('与显式档位（用户逃生口）的关系', () => {
  it('软渲染下 auto → reduced；显式 full 覆盖探测；恢复 auto 后重新跟随', () => {
    mockWebGl('Google SwiftShader');
    expect(getMaterialTier()).toBe('reduced');
    setMaterialTier('full');
    expect(getMaterialTier()).toBe('full');
    setMaterialTier('auto');
    expect(getMaterialTier()).toBe('reduced');
  });
});
