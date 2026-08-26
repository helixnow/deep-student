/**
 * 输入栏能力三分离（Wave2-C R3 / P4）单测 + 源码契约
 *
 * 锁定三条语义边界：
 * 1. canCapturePhoto 是纯「平台/捕获能力」判定：Android/iOS 直接放行；
 *    其余平台必须 input capture 特性 + 移动壳同时成立，触摸/指针不参与。
 * 2. 触摸能力查询是 any-pointer: coarse（不是 pointer: coarse），
 *    且能力模块不碰 enumerateDevices（会触发权限弹窗）。
 * 3. InputBarUI 不再声明 pointer: coarse 版 isMobileEnv，下游 isMobileEnv
 *    prop（本轮独占锁不可改名）拿到的是 canCapturePhoto。
 *
 * 父代理本轮不跑测试，本文件只提交源码，未执行。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platformMocks = vi.hoisted(() => ({
  isAndroid: vi.fn(() => false),
  isIOS: vi.fn(() => false),
  isMobilePlatform: vi.fn(() => false),
}));

vi.mock('@/utils/platform', () => platformMocks);

import {
  TOUCH_CAPABILITY_MEDIA_QUERY,
  canCapturePhoto,
  supportsInputCapture,
} from '../inputBarCapabilities';

/** 在 HTMLInputElement 原型上模拟 HTML Media Capture 支持（jsdom 默认不实现） */
function withInputCaptureSupport(): () => void {
  const proto = HTMLInputElement.prototype as unknown as Record<string, unknown>;
  const hadOwn = Object.prototype.hasOwnProperty.call(proto, 'capture');
  if (!hadOwn && !('capture' in proto)) {
    Object.defineProperty(proto, 'capture', { value: '', configurable: true, writable: true });
    return () => {
      delete proto.capture;
    };
  }
  return () => {};
}

beforeEach(() => {
  platformMocks.isAndroid.mockReturnValue(false);
  platformMocks.isIOS.mockReturnValue(false);
  platformMocks.isMobilePlatform.mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('inputBarCapabilities.canCapturePhoto（平台/捕获能力）', () => {
  it('Android 平台直接判定可拍照（不依赖 capture 特性与指针）', () => {
    platformMocks.isAndroid.mockReturnValue(true);
    expect(canCapturePhoto()).toBe(true);
  });

  it('iOS 平台直接判定可拍照（不依赖 capture 特性与指针）', () => {
    platformMocks.isIOS.mockReturnValue(true);
    expect(canCapturePhoto()).toBe(true);
  });

  it('桌面平台即使 input 支持 capture 也不出现拍照入口（桌面浏览器会退化成文件选择器）', () => {
    const restore = withInputCaptureSupport();
    try {
      expect(supportsInputCapture()).toBe(true);
      // isMobilePlatform=false → 兜底分支被移动壳门控挡下
      expect(canCapturePhoto()).toBe(false);
    } finally {
      restore();
    }
  });

  it('非 Android/iOS 的移动壳：capture 特性 + 移动 UA 同时成立才放行', () => {
    platformMocks.isMobilePlatform.mockReturnValue(true);
    const restore = withInputCaptureSupport();
    try {
      expect(canCapturePhoto()).toBe(true);
    } finally {
      restore();
    }
  });
});

describe('inputBarCapabilities 触摸/相机语义边界', () => {
  const capabilitiesSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/inputBarCapabilities.ts'),
    'utf-8'
  );

  it('触摸能力查询是 any-pointer: coarse（不再用 pointer: coarse 兼职）', () => {
    expect(TOUCH_CAPABILITY_MEDIA_QUERY).toBe('(any-pointer: coarse)');
  });

  it('能力模块不使用 enumerateDevices（避免权限弹窗）也不使用指针媒体查询判相机', () => {
    expect(capabilitiesSource).not.toContain('enumerateDevices');
    expect(capabilitiesSource).not.toContain("'(pointer: coarse)'");
  });
});

describe('InputBarUI 能力三分离源码契约', () => {
  const inputBarSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/InputBarUI.tsx'),
    'utf-8'
  );

  it('不再声明 pointer: coarse 版 isMobileEnv', () => {
    expect(inputBarSource).not.toMatch(/const isMobileEnv\s*=/);
    expect(inputBarSource).not.toContain("useMediaQuery('(pointer: coarse)')");
  });

  it('下游 isMobileEnv prop（独占锁保留名）拿到的是相机能力布尔', () => {
    // AttachmentPanelBody 与 ComposerToolbar 两个消费点都必须传 canCapturePhoto
    expect(inputBarSource.match(/isMobileEnv=\{canCapturePhoto\}/g)?.length).toBe(2);
    expect(inputBarSource).toContain(
      'const canCapturePhoto = useMemo(() => detectCanCapturePhoto(), [])'
    );
  });

  it('布局分支仍由宽度断点驱动（isMobile 未被能力判定替换）', () => {
    expect(inputBarSource).toContain('const isMobile = mobileLayout?.isMobile ?? false');
  });
});
