/**
 * 桌面 WebView 合成器整面重绘 nudge（Windows/macOS + Tauri 运行时）
 *
 * 背景（2026-07-10 OS 模式整层错位事故）：WebView2 的 DirectComposition
 * 局部脏区跟踪，在「全客户区尺寸的合成层（最大化窗口/壁纸/桌面根）+
 * resize / 最大化 / 跨 DPI 显示器」组合下可能丢提交或保持陈旧偏移，
 * 表现为整个学习桌面垂直错位：顶部一条黑、内容整体下移、Dock 连同
 * 底栏画到窗框以外。Chromium 合成树本身是对的（DOM/布局无异常），
 * 坏在 WebView2 把合成输出呈现到宿主 HWND 的那一段。
 *
 * 自愈策略：OS 窗口 resize 尘埃落定 / 页面恢复可见时，把桌面根节点
 * 短暂提升为合成层再撤销（translateZ(0) 两帧开关）。层的创建与合并
 * 各触发一次子树全量光栅化 + 全面积 DComp 提交，冲掉任何陈旧呈现。
 *
 * 纪律：
 * - 只动 transform，两帧内完成；OS 模式下桌面根与视口同几何，
 *   fixed 后代（SnapPreview / 菜单栏弹层背板等）无视觉跳变；
 * - 拖拽中（<html data-wb-dragging>）跳过，不与跟手 translate3d 抢帧；
 * - 仅 Windows WebView2 / macOS WKWebView 的 Tauri 主窗口启用；浏览器与
 *   WebKitGTK 保持 no-op。
 *
 * Rust 侧不得在 Focused/Resized/ScaleFactorChanged 回调内同步进入
 * WebView2 COM；该路径会与 WebView 日志/IPC 锁反转并冻结 UI 消息循环。
 * 本 hook 是主窗口安全的呈现自愈路径。CI：platformPerformanceConfig.test.ts。
 */
import { useEffect, type RefObject } from 'react';
import { isMacOS, isWindows } from '@/utils/platform';
import { isShellGestureActive } from '../core/shellGestureFlags';

/** resize 连发的尾随防抖；与 WorkbenchDesktop 的 160ms settle 同数量级 */
const NUDGE_DEBOUNCE_MS = 200;

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    (Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__) ||
      Boolean((window as unknown as Record<string, unknown>).__TAURI_IPC__))
  );
}

export function useCompositorNudge(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if ((!isWindows() && !isMacOS()) || !isTauriRuntime()) return undefined;

    let timer = 0;
    let raf1 = 0;
    let raf2 = 0;

    const clearRafs = () => {
      if (raf1) cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
      raf1 = 0;
      raf2 = 0;
    };

    const nudge = () => {
      const el = rootRef.current;
      if (!el) return;
      // 拖拽/settle 热路径让行；桌面根若已有 inline transform（不应发生）也不碰
      if (isShellGestureActive() || document.documentElement.hasAttribute('data-wb-dragging')) {
        return;
      }
      if (el.style.transform) return;
      clearRafs();
      el.style.transform = 'translateZ(0)';
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          raf1 = 0;
          raf2 = 0;
          if (el.style.transform === 'translateZ(0)') el.style.transform = '';
        });
      });
    };

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(nudge, NUDGE_DEBOUNCE_MS);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') schedule();
    };

    window.addEventListener('resize', schedule);
    // macOS WKWebView 在应用切到后台再回来时，偶尔只提交部分 CALayer：
    // DOM 几何正确，但标题栏、Dock 等旧图层仍停在离屏位置。focus 不一定
    // 伴随 visibilitychange，因此必须独立触发一次整面提交。
    window.addEventListener('focus', schedule);
    document.addEventListener('visibilitychange', onVisibility);
    // 进入 OS 模式即校一次：挂载瞬间正是层结构大改的时刻
    schedule();

    return () => {
      window.clearTimeout(timer);
      clearRafs();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('focus', schedule);
      document.removeEventListener('visibilitychange', onVisibility);
      const el = rootRef.current;
      if (el && el.style.transform === 'translateZ(0)') el.style.transform = '';
    };
  }, [rootRef]);
}
