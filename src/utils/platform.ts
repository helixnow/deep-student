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

  // 移动端检测
  if (isMobilePlatform()) {
    html.classList.add('is-mobile');
  }
};

/**
 * Android 安全区域初始化
 * 
 * Android WebView 对 env(safe-area-inset-*) 的支持不完整，
 * 启用 edge-to-edge 后需要手动处理系统导航栏高度。
 * 
 * 此函数设置 CSS 变量作为 fallback，确保底部内容不被系统手势指示条遮挡。
 */
export const initAndroidSafeArea = (): void => {
  if (typeof document === 'undefined') return;
  
  const root = document.documentElement;
  
  // Android 系统导航栏/手势指示条的典型高度：
  // - 三键导航：48dp
  // - 手势导航（小横条）：20-24dp
  // - 全面屏手势：约 34dp
  // 
  // 使用 15px 作为安全值，平衡视觉效果和系统栏遮挡
  const DEFAULT_ANDROID_BOTTOM_INSET = 15;
  const DEFAULT_ANDROID_TOP_INSET = 24; // 状态栏高度
  
  // 设置 CSS 变量，供组件使用
  root.style.setProperty('--android-safe-area-bottom', `${DEFAULT_ANDROID_BOTTOM_INSET}px`);
  root.style.setProperty('--android-safe-area-top', `${DEFAULT_ANDROID_TOP_INSET}px`);
  
  // 同时设置标准 safe-area 变量的 fallback 值
  // 这样使用 var(--safe-area-inset-bottom, 0px) 的地方可以正确获取值
  root.style.setProperty('--safe-area-inset-bottom-fallback', `${DEFAULT_ANDROID_BOTTOM_INSET}px`);
  root.style.setProperty('--safe-area-inset-top-fallback', `${DEFAULT_ANDROID_TOP_INSET}px`);
  
  console.log('[Platform] Android safe area initialized:', {
    bottom: DEFAULT_ANDROID_BOTTOM_INSET,
    top: DEFAULT_ANDROID_TOP_INSET,
  });
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
