/**
 * 🚀 性能优化：CSS 懒加载工具
 * 
 * 将大型 CSS 文件（如 KaTeX）改为按需加载，
 * 避免阻塞首帧渲染。
 */

// 已加载的 CSS 标记
const loadedStyles = new Set<string>();

/**
 * 懒加载 CSS 样式
 * @param id 唯一标识符，防止重复加载
 * @param loadFn 动态导入 CSS 的函数
 */
export async function loadStyleOnce(id: string, loadFn: () => Promise<unknown>): Promise<void> {
  if (loadedStyles.has(id)) {
    return;
  }
  
  try {
    await loadFn();
    loadedStyles.add(id);
  } catch (err: unknown) {
    console.warn(`[lazyStyles] Failed to load style "${id}":`, err);
  }
}

/**
 * 检查样式是否已加载
 */
export function isStyleLoaded(id: string): boolean {
  return loadedStyles.has(id);
}

// ============================================================================
// 预定义的样式加载器
// ============================================================================

let katexLoadPromise: Promise<void> | null = null;

/**
 * 懒加载 KaTeX CSS
 * 在渲染数学公式前调用
 */
export function loadKatexStyles(): Promise<void> {
  if (katexLoadPromise) {
    return katexLoadPromise;
  }
  
  katexLoadPromise = loadStyleOnce('katex', () => import('katex/dist/katex.min.css'));
  return katexLoadPromise;
}

/**
 * 确保 KaTeX 样式已加载（同步检查，异步加载）
 * 适用于组件初始化时调用
 */
export function ensureKatexStyles(): void {
  if (!isStyleLoaded('katex')) {
    loadKatexStyles();
  }
}
