/**
 * 块级渲染跳过（content-visibility）的开关与 WebKit 前台恢复兜底
 *
 * 已完成块 / 空闲代码块用 content-visibility:auto 跳过离屏 layout/paint，这是
 * 直渲模式下"单条消息巨长"的主解（见 decisions/2026-09-25-long-context-jank-zcode-study.md）。
 *
 * 虚拟滚动行里不能用（#470）：虚拟器用行的 offsetHeight 定位，而行内离屏块按
 * contain-intrinsic-size 占位值参与布局——行每次（重新）挂载都先按占位高度
 * 被测量，块滚进视口真正渲染后行高再变一次，虚拟器反复修正行高；向上滚动时
 * 这些修正不做滚动补偿，可见内容随之跳动（"上滚回弹"）。虚拟化本身已把
 * DOM 限制在视口附近几行，行内再跳过渲染没有收益，只有测量污染。
 */

import { createContext } from 'react';

/**
 * 当前子树是否允许块级 content-visibility 渲染跳过。
 * 默认开启（直渲模式）；MessageList 的虚拟行内置为 false。
 */
export const BlockRenderSkipContext = createContext(true);

/**
 * WebKit 内核（macOS WKWebView / Linux WebKitGTK / Safari）。
 * Chromium 系（含 WebView2）UA 也带 AppleWebKit，按 Chrome/Chromium/Edg 排除。
 */
export function isWebKitEngine(userAgent: string): boolean {
  return /AppleWebKit/i.test(userAgent) && !/Chrome|Chromium|CriOS|Edg/i.test(userAgent);
}

/**
 * 视口内（含上下 margin 余量）仍带 content-visibility 的块。
 * 只有这些块会出现"该绘制却没绘制"的空框；视口外的块本来就该跳过渲染。
 */
export function collectBlocksInViewport(
  root: ParentNode,
  viewportHeight: number,
  margin = 0,
): HTMLElement[] {
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>('.stream-block[style*="content-visibility"]'),
  );
  return blocks.filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.bottom >= -margin && rect.top <= viewportHeight + margin;
  });
}

const installedWindows = new WeakSet<Window>();

/**
 * WebKit（macOS WKWebView）里，窗口不在前台 / 被切走期间挂载的 content-visibility:auto
 * 块，回到前台后可能一直被判为「视口外」而不绘制——视口里的消息只剩一个空灰框
 * （实测：发送后切去别的应用，回来用户气泡是空的）。窗口重新可见或获得焦点时
 * 让视口内的这些块重新判定一次：先 visible 再下一帧恢复 auto。
 *
 * #470：旧实现不分平台、对整段会话全部块翻转，Windows/WebView2 每次最小化恢复
 * 都要对全会话做两遍强制布局 + 绘制（图片全部重新解码），恢复后白屏很久。
 * 现在只在 WebKit 内核安装，只处理视口内的块，同一帧内的 visibilitychange +
 * focus 合并为一次。
 */
export function installContentVisibilityRefresh(
  win: Window | undefined = typeof window === 'undefined' ? undefined : window,
): (() => void) | null {
  if (!win || !win.document || !isWebKitEngine(win.navigator?.userAgent ?? '')) return null;
  // 模块热替换会重复求值调用方，同一窗口只装一次
  if (installedWindows.has(win)) return null;
  installedWindows.add(win);
  const doc = win.document;
  let scheduled = false;

  const refresh = () => {
    if (doc.visibilityState !== 'visible' || scheduled) return;
    scheduled = true;
    win.requestAnimationFrame(() => {
      scheduled = false;
      const blocks = collectBlocksInViewport(doc, win.innerHeight, win.innerHeight / 2);
      if (blocks.length === 0) return;
      blocks.forEach((el) => { el.style.contentVisibility = 'visible'; });
      win.requestAnimationFrame(() => {
        blocks.forEach((el) => { el.style.contentVisibility = 'auto'; });
      });
    });
  };

  doc.addEventListener('visibilitychange', refresh);
  win.addEventListener('focus', refresh);
  return () => {
    doc.removeEventListener('visibilitychange', refresh);
    win.removeEventListener('focus', refresh);
    installedWindows.delete(win);
  };
}
