/**
 * CSS 自定义属性时长单源读取 — ACR 演出优化轮
 *
 * 背景：多处 JS 兜底/TTL 时长与 CSS 动画时长「注释约定对齐」（如
 * --acr-flash-ms 750 vs FLASH_FALLBACK_MS 800），任何一侧调整都会静默失配。
 * 本工具让 JS 从 CSS 变量读取真值，CSS 成为唯一时长来源；
 * jsdom / CSS 未加载 / 解析失败时回退调用方给的 fallback（与旧常量等值）。
 *
 * 读取结果按变量名缓存（主题切换不改这些结构性时长，无需失效）。
 */

const cache = new Map<string, number>();

/** 解析 CSS <time> 字面量（"750ms" / "0.75s"）为毫秒；无法解析返回 null */
export function parseCssTimeMs(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  const match = /^(-?\d*\.?\d+)(ms|s)$/i.exec(value);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return null;
  return match[2]!.toLowerCase() === 's' ? num * 1000 : num;
}

/**
 * 读取 :root 上的 CSS 时长变量（毫秒）。
 * @param varName 形如 '--acr-flash-ms'
 * @param fallbackMs 读取失败时的回退值（保持与 CSS 中声明值一致）
 */
export function readCssTimeMs(varName: string, fallbackMs: number): number {
  const cached = cache.get(varName);
  if (cached != null) return cached;
  let resolved = fallbackMs;
  try {
    if (typeof document !== 'undefined' && typeof getComputedStyle === 'function') {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(varName);
      const parsed = parseCssTimeMs(raw);
      if (parsed != null && parsed >= 0) resolved = parsed;
    }
  } catch {
    /* jsdom / 早期调用等异常一律回退 */
  }
  cache.set(varName, resolved);
  return resolved;
}

/** 测试用：清空缓存 */
export function __resetCssTimeCacheForTest(): void {
  cache.clear();
}
