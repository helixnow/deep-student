export const getPlatform = (): string => {
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
  if (typeof navigator === 'undefined') return false;
  const ua = (navigator.userAgent || '').toLowerCase();
  const pf = (navigator.platform || '').toLowerCase();
  return ua.includes('android') || pf.includes('android');
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
export const initAndroidSafeArea = (): void => {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;

  const applySafeArea = (top: number, bottom: number, left: number, right: number): void => {
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

    console.log('[Platform] Android safe area applied:', { top: t, bottom: b, left: l, right: r });
  };

  // 安装原生注入入口（后续 inset 变化由 MainActivity 持续调用）
  window.__DEEP_STUDENT_SET_SAFE_AREA__ = applySafeArea;

  const pending = window.__DEEP_STUDENT_PENDING_SAFE_AREA__;
  if (Array.isArray(pending) && pending.length === 4) {
    delete window.__DEEP_STUDENT_PENDING_SAFE_AREA__;
    applySafeArea(pending[0], pending[1], pending[2], pending[3]);
    return;
  }

  // 原生值未到达前的固定 fallback：
  // - 三键导航：48dp;手势导航（小横条）：20-24dp;全面屏手势：约 34dp
  // 使用 15px 作为安全值，平衡视觉效果和系统栏遮挡;状态栏取 24px
  applySafeArea(24, 15, 0, 0);
};

// 统一的移动端检测（供前端功能降级使用）
export const isMobilePlatform = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const ua = (navigator.userAgent || '').toLowerCase();
  const pf = (navigator.platform || '').toLowerCase();
  return (
    ua.includes('android') ||
    ua.includes('iphone') ||
    ua.includes('ipad') ||
    ua.includes('ipod') ||
    pf.includes('android') ||
    pf.includes('iphone') ||
    pf.includes('ipad') ||
    pf.includes('ipod')
  );
};
