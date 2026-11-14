import { useCallback, useEffect, useRef, useState } from 'react';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

// P2-13：防抖工具提到组件外，避免每次渲染重建
function debounce(func: (...args: unknown[]) => void, wait: number) {
  let timeout: ReturnType<typeof setTimeout>;
  return function (...args: unknown[]) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

/**
 * 设置页标签指示器的位置计算（rAF 节流，避免同步强制回流）。
 *
 * 桌面左侧分区导航已由 App 外壳侧栏承载，这里的指示器只服务保留的
 * 分区内容层；调用方（useSettingsConfig.handleTabChange）仍按原时序触发，
 * 因此状态与副作用保持与改造前一致。
 */
export function useSettingsTabIndicator({ loading, activeTab }: { loading: boolean; activeTab: string }) {
  const [, setIndicatorStyle] = useState({ transform: 'translateX(0)', width: 0 });
  const tabsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const tabButtonsContainerRef = useRef<HTMLDivElement | null>(null);
  const indicatorRafId = useRef<number | null>(null);

  const updateIndicatorRaf = useCallback((tabId: string) => {
    if (indicatorRafId.current != null) return;
    // OS 模式拖/缩/settle：禁止读 layout（offsetLeft）抢跟手帧
    if (
      typeof document !== 'undefined' &&
      (document.documentElement.hasAttribute('data-wb-dragging') ||
        document.documentElement.hasAttribute('data-wb-settling'))
    ) {
      return;
    }
    indicatorRafId.current = requestAnimationFrame(() => {
      indicatorRafId.current = null;
      try {
        if (
          document.documentElement.hasAttribute('data-wb-dragging') ||
          document.documentElement.hasAttribute('data-wb-settling')
        ) {
          return;
        }
        const tabElement = tabsRef.current.get(tabId);
        const buttonsEl = tabButtonsContainerRef.current;
        if (tabElement && buttonsEl) {
          const left = Math.max(0, tabElement.offsetLeft + buttonsEl.offsetLeft - buttonsEl.scrollLeft);
          setIndicatorStyle({
            transform: `translateX(${left}px)`,
            width: tabElement.offsetWidth,
          });
        }
      } catch (e) {
        console.warn('[Settings] updateIndicator skipped:', e);
      }
    });
  }, []);

  // 初始化和窗口大小变化时更新指示器（使用 rAF 代替 setTimeout 延迟）
  useEffect(() => {
    if (!loading && activeTab) {
      // 使用双 rAF，等待布局稳定（下一帧之后再计算）
      let raf1 = 0, raf2 = 0;
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => updateIndicatorRaf(activeTab));
      });

      const handleResize = debounce(() => updateIndicatorRaf(activeTab), 100);
      window.addEventListener('resize', handleResize);

      // 横向滚动时保持指示器与选中标签对齐
      const buttonsEl = tabButtonsContainerRef.current;
      const handleScroll = () => updateIndicatorRaf(activeTab);
      if (buttonsEl) buttonsEl.addEventListener('scroll', handleScroll, { passive: true });

      return () => {
        window.removeEventListener('resize', handleResize);
        if (buttonsEl) buttonsEl.removeEventListener('scroll', handleScroll);
        if (raf1) cancelAnimationFrame(raf1);
        if (raf2) cancelAnimationFrame(raf2);
      };
    }
  }, [loading, activeTab, updateIndicatorRaf]);

  return updateIndicatorRaf;
}
