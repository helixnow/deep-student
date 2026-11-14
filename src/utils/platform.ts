/**
 * 平台判定的唯一实现（FE-A5）：外壳桥（`globalThis.__DS_PLATFORM__`，见 ui-kernel/services/shell-platform.ts）
 * 给出平台时以它为准；没有外壳桥（浏览器开发、单元测试）时按 userAgent 判定。UI 内核的平台服务读同一份外壳信息。
 * userAgent / navigator.platform 只允许在这里和 src/platform/ 读取（ui-boundaries 门禁的 ua-sniffing 棘轮）。
 */
import { readShellPlatform } from '../ui-kernel/services/shell-platform';

const navigatorText = (): [ua: string, pf: string] | undefined =>
  typeof navigator === 'undefined'
    ? undefined
    : [(navigator.userAgent || '').toLowerCase(), (navigator.platform || '').toLowerCase()];

export const getPlatform = (): string => {
  const shellOs = readShellPlatform()?.os;
  if (shellOs && shellOs !== 'unknown') return shellOs;
  // 检测运行环境
  if (typeof window !== 'undefined') {
    // 在浏览器环境中，使用userAgent检测
    const userAgent = navigator.userAgent.toLowerCase();

    if (userAgent.includes('macintosh') || userAgent.includes('mac os x')) {
      return 'macos';
    } else if (userAgent.includes('windows')) {
      return 'windows';
    } else if (userAgent.includes('linux')) {
      return 'linux';
    }
  }

  // 默认返回windows
  return 'windows';
};

export const isMacOS = (): boolean => getPlatform() === 'macos';
export const isWindows = (): boolean => getPlatform() === 'windows';
export const isLinux = (): boolean => getPlatform() === 'linux';
export const isAndroid = (): boolean => {
  const shell = readShellPlatform();
  if (shell) return shell.os === 'android';
  const text = navigatorText();
  return !!text && (text[0].includes('android') || text[1].includes('android'));
};

export const isIOS = (): boolean => {
  const shell = readShellPlatform();
  if (shell) return shell.os === 'ios';
  const text = navigatorText();
  if (!text) return false;
  const [ua, pf] = text;
  // iPadOS 13+ 桌面站点模式伪装成 Macintosh / MacIntel，
  // 与 isMobilePlatform 同款 maxTouchPoints 区分（真 Mac 触点数为 0）
  const isIPadOS = pf === 'macintel' && (navigator.maxTouchPoints ?? 0) > 1;
  return /iphone|ipad|ipod/.test(ua) || /iphone|ipad|ipod/.test(pf) || isIPadOS;
};

/**
 * 检测是否在 Android WebView 中运行
 * WebView 的 userAgent 通常包含 "wv" 或 "WebView" 字样
 */
export const isAndroidWebView = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const uaLower = ua.toLowerCase();

  // 必须是 Android
  if (!uaLower.includes('android')) return false;

  // 检测 WebView 特征：
  // 1. 包含 "wv" 标识（Android WebView 标准标识）
  // 2. 包含 "WebView" 字样
  // 3. Version/x.x 格式（旧版 WebView）
  // 4. 不包含 "Chrome" 或 Chrome 版本较低（嵌入式 WebView）
  return (
    uaLower.includes('; wv)') ||
    uaLower.includes('webview') ||
    /version\/\d+\.\d+/.test(uaLower) ||
    (!uaLower.includes('chrome') && uaLower.includes('mobile'))
  );
};

/**
 * 初始化平台检测相关的 CSS 类
 * 在应用启动时调用，为 html 元素添加平台相关类名
 */
export const initPlatformClasses = (): void => {
  if (typeof document === 'undefined') return;

  const html = document.documentElement;

  // Android WebView 检测
  if (isAndroidWebView()) {
    html.classList.add('is-android-webview');
  }

  // Android 通用检测
  if (isAndroid()) {
    html.classList.add('is-android');
    // 初始化 Android 安全区域 CSS 变量
    initAndroidSafeArea();
  }

  // 桌面平台检测
  if (isMacOS()) {
    html.classList.add('is-macos');
  }
  if (isWindows()) {
    html.classList.add('is-windows');
  }

  // 移动端检测
  if (isMobilePlatform()) {
    html.classList.add('is-mobile');
  }
};

declare global {
  interface Window {
    /** SA-1: 原生层（MainActivity）注入真实安全区的入口，参数为 CSS px */
    __DEEP_STUDENT_SET_SAFE_AREA__?: (top: number, bottom: number, left: number, right: number) => void;
    /** SA-1: 原生注入早于本模块初始化时的暂存值 [top, bottom, left, right] */
    __DEEP_STUDENT_PENDING_SAFE_AREA__?: number[];
  }
}

/**
 * Android 安全区域初始化（SA-1 升级：固定 fallback + 原生真实 inset 注入）
 *
 * Android WebView 对 env(safe-area-inset-*) 的支持不完整，启用 edge-to-edge 后
 * 需要手动处理系统栏高度。流程：
 * 1. 本函数先写入固定 fallback（top 24 / bottom 15，历史行为），保证原生注入
 *    到达前底部内容不被手势指示条遮挡；
 * 2. 同时安装 window.__DEEP_STUDENT_SET_SAFE_AREA__，MainActivity 监听真实
 *    WindowInsets（旋转/导航模式切换/刘海屏）后调用它覆盖为真实值;
 * 3. 若原生注入先于本模块执行（值暂存在 __DEEP_STUDENT_PENDING_SAFE_AREA__），
 *    初始化时直接消费暂存值,跳过 fallback。
 */
export interface AndroidSafeAreaInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** true = MainActivity 注入的真实 WindowInsets；false = 原生值到达前的固定猜测 */
  native: boolean;
}

/** `env(safe-area-inset-*)` 的当前值（CSS px）。Android 15/16 的 edge-to-edge WebView 只在这里给出真实值。 */
export interface EnvironmentSafeAreaInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * 读取当前页面环境里的安全区：
 * 1. 优先用 `env(safe-area-inset-*)`（`viewport-fit=cover` 时 Android 15/16 edge-to-edge 有值；iOS 一直有）；
 * 2. 其次读 `:root` 上原生/壳写入的 `--safe-area-inset-*`；
 * 3. 顶栏兜底用 `visualViewport.offsetTop`（浏览器 UI 占位时）。
 * 四项全为 0 时返回 `null`：说明环境没有提供信息，保留调用方的固定 fallback。
 */
export const readEnvironmentSafeAreaInsets = (): EnvironmentSafeAreaInsets | null => {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  const parse = (value: string): number => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const env = { top: 0, bottom: 0, left: 0, right: 0 };
  const host = document.documentElement;
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'width:0',
    'height:0',
    'visibility:hidden',
    'pointer-events:none',
    'padding-top:env(safe-area-inset-top,0px)',
    'padding-bottom:env(safe-area-inset-bottom,0px)',
    'padding-left:env(safe-area-inset-left,0px)',
    'padding-right:env(safe-area-inset-right,0px)',
  ].join(';');
  try {
    host.appendChild(probe);
    const style = window.getComputedStyle(probe);
    env.top = parse(style.paddingTop);
    env.bottom = parse(style.paddingBottom);
    env.left = parse(style.paddingLeft);
    env.right = parse(style.paddingRight);
  } catch {
    // 取证失败时退回下面的 CSS 变量 / visualViewport。
  } finally {
    probe.remove();
  }

  const rootStyle = window.getComputedStyle(host);
  const cssVar = (name: string): number => parse(rootStyle.getPropertyValue(name));
  const top = Math.max(env.top, cssVar('--safe-area-inset-top'), cssVar('--safe-area-inset-block-start'), window.visualViewport?.offsetTop ?? 0);
  const bottom = Math.max(env.bottom, cssVar('--safe-area-inset-bottom'), cssVar('--safe-area-inset-block-end'));
  const left = Math.max(env.left, cssVar('--safe-area-inset-left'));
  const right = Math.max(env.right, cssVar('--safe-area-inset-right'));
  if (top === 0 && bottom === 0 && left === 0 && right === 0) return null;
  return { top, bottom, left, right };
};

let androidSafeAreaInsets: AndroidSafeAreaInsets | null = null;
const androidSafeAreaListeners = new Set<() => void>();

/**
 * #472: 当前 Android 安全区（CSS px）。非 Android 或尚未初始化时为 null。
 * 返回值引用在 inset 变化前保持稳定，可直接作为 useSyncExternalStore 快照。
 */
export const getAndroidSafeAreaInsets = (): AndroidSafeAreaInsets | null => androidSafeAreaInsets;

/** 订阅 Android 安全区变化（旋转、系统栏显隐/沉浸式切换、导航模式切换） */
export const subscribeAndroidSafeArea = (listener: () => void): (() => void) => {
  androidSafeAreaListeners.add(listener);
  return () => {
    androidSafeAreaListeners.delete(listener);
  };
};

export const initAndroidSafeArea = (): void => {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;

  const publish = (next: AndroidSafeAreaInsets): void => {
    const prev = androidSafeAreaInsets;
    if (
      prev &&
      prev.top === next.top &&
      prev.bottom === next.bottom &&
      prev.left === next.left &&
      prev.right === next.right &&
      prev.native === next.native
    ) {
      return;
    }
    androidSafeAreaInsets = next;
    androidSafeAreaListeners.forEach((listener) => {
      try {
        listener();
      } catch (error: unknown) {
        console.error('[Platform] safe area listener failed:', error);
      }
    });
  };

  const applySafeArea = (
    top: number,
    bottom: number,
    left: number,
    right: number,
    native = true,
  ): void => {
    // 防御异常注入值：限制在 [0, 200] CSS px
    const clamp = (v: number): number =>
      Number.isFinite(v) ? Math.min(200, Math.max(0, Math.round(v))) : 0;
    const t = clamp(top);
    const b = clamp(bottom);
    const l = clamp(left);
    const r = clamp(right);

    root.style.setProperty('--android-safe-area-top', `${t}px`);
    root.style.setProperty('--android-safe-area-bottom', `${b}px`);
    root.style.setProperty('--android-safe-area-left', `${l}px`);
    root.style.setProperty('--android-safe-area-right', `${r}px`);

    // 同时设置标准 safe-area 变量的 fallback 值
    // 这样使用 var(--safe-area-inset-bottom-fallback, 0px) 的地方可以正确获取值
    root.style.setProperty('--safe-area-inset-top-fallback', `${t}px`);
    root.style.setProperty('--safe-area-inset-bottom-fallback', `${b}px`);

    console.log('[Platform] Android safe area applied:', { top: t, bottom: b, left: l, right: r, native });
    publish({ top: t, bottom: b, left: l, right: r, native });
  };

  // 安装原生注入入口（后续 inset 变化由 MainActivity 持续调用）
  // 原生入口只收 4 个参数，native 恒为 true
  window.__DEEP_STUDENT_SET_SAFE_AREA__ = (top, bottom, left, right) =>
    applySafeArea(top, bottom, left, right, true);

  const pending = window.__DEEP_STUDENT_PENDING_SAFE_AREA__;
  if (Array.isArray(pending) && pending.length === 4) {
    delete window.__DEEP_STUDENT_PENDING_SAFE_AREA__;
    applySafeArea(pending[0], pending[1], pending[2], pending[3]);
    return;
  }

  // 原生值未到达前的固定 fallback：
  // - 三键导航：48dp;手势导航（小横条）：20-24dp;全面屏手势：约 34dp
  // 使用 15px 作为安全值，平衡视觉效果和系统栏遮挡;状态栏取 24px
  applySafeArea(24, 15, 0, 0, false);

  // Android 15/16 的 edge-to-edge 屏幕由 WebView 的 env(safe-area-inset-*) 给出真实值；没有原生
  // MainActivity 注入时（Capacitor 外壳）用它覆盖固定 fallback。四项全 0 说明环境还没准备好，
  // 保留 fallback，并在下一帧再试一次（样式表/视口可能晚于脚本）。
  const applyEnvironment = (env: EnvironmentSafeAreaInsets | null): void => {
    if (env === null) return;
    window.__DEEP_STUDENT_SET_SAFE_AREA__?.(
      env.top > 0 ? env.top : 24,
      env.bottom > 0 ? env.bottom : 15,
      env.left,
      env.right,
    );
  };
  const environment = readEnvironmentSafeAreaInsets();
  if (environment !== null) {
    applyEnvironment(environment);
    return;
  }
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => applyEnvironment(readEnvironmentSafeAreaInsets()));
  }
};

// 统一的移动端检测（供前端功能降级使用）：Android 或 iOS / iPadOS（含伪装成 MacIntel 的 iPadOS 桌面站点模式）。
export const isMobilePlatform = (): boolean => isAndroid() || isIOS();

/**
 * 是否运行在 WebUI（浏览器 / PWA）外壳里。
 *
 * `web/client/bootstrap.ts` 启动时写入 `globalThis.__DS_WEBUI__ = true`；
 * `src/` 禁止 import `web/`，这是唯一的跨层信号。
 */
export const isWebUiShell = (): boolean =>
  Boolean((globalThis as { __DS_WEBUI__?: unknown }).__DS_WEBUI__ === true);

/**
 * 能否用自定义流式协议读文件（`pdfstream://` / `filestream://`）。
 *
 * 移动端原生外壳（iOS WKWebView / Android WebView）没有这些协议；
 * 但 WebUI 里它们落到标准 HTTP 206 端点（`/api/protocol/<scheme>/<path>`），
 * 移动浏览器同样支持 Range 流式播放/预览。
 */
export const supportsStreamProtocol = (): boolean => !isMobilePlatform() || isWebUiShell();

/**
 * 原样的 navigator.userAgent / navigator.platform（不转小写、不经外壳桥），只用于诊断报告记录运行环境；
 * 平台判定一律用上面的函数。没有 navigator 时两项都是空串。
 */
export const getRawUserAgentInfo = (): { userAgent: string; platform: string } =>
  typeof navigator === 'undefined'
    ? { userAgent: '', platform: '' }
    : { userAgent: navigator.userAgent ?? '', platform: navigator.platform ?? '' };
