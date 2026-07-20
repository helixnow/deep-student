/**
 * KaTeX 懒加载器
 *
 * ★ 加载性能（P1）：katex + katex/contrib/mhchem 约数百 KB JS，
 * 旧实现在 MarkdownRenderer 顶层静态导入，进入 chat chunk 后
 * 打开聊天页即解析执行——即使会话没有任何公式。
 *
 * 现改为动态 import：
 * - 首个 MarkdownRenderer 挂载后在空闲期预取（不阻塞首屏可交互）
 * - 遇到 math 节点而模块未就绪时，先渲染原文降级，加载完成后自动补渲
 */

type KatexModule = typeof import('katex').default;

let loadedKatex: KatexModule | null = null;
let loadPromise: Promise<KatexModule> | null = null;

/** 同步获取已加载的 katex；未加载完成时返回 null */
export function getLoadedKatex(): KatexModule | null {
  return loadedKatex;
}

/** 触发加载（幂等）。mhchem 扩展随主模块一并加载。 */
export function ensureKatexLoaded(): Promise<KatexModule> {
  if (loadedKatex) return Promise.resolve(loadedKatex);
  if (!loadPromise) {
    loadPromise = Promise.all([
      import('katex'),
      // mhchem 以副作用方式向 katex 注册 \ce / \pu 宏
      import('katex/contrib/mhchem'),
    ])
      .then(([katexModule]) => {
        loadedKatex = katexModule.default;
        return loadedKatex;
      })
      .catch((error) => {
        // 失败后允许重试（网络抖动 / dev server 重启）
        loadPromise = null;
        throw error;
      });
  }
  return loadPromise;
}

/** 空闲期预取：首个 markdown 渲染器挂载后调用，避免首条公式出现原文闪烁 */
let idlePrefetchScheduled = false;
export function scheduleKatexIdlePrefetch(): void {
  if (idlePrefetchScheduled || loadedKatex) return;
  idlePrefetchScheduled = true;
  const run = () => {
    ensureKatexLoaded().catch(() => {
      idlePrefetchScheduled = false;
    });
  };
  const win = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  };
  if (typeof win.requestIdleCallback === 'function') {
    win.requestIdleCallback(run, { timeout: 3000 });
  } else {
    window.setTimeout(run, 1000);
  }
}
