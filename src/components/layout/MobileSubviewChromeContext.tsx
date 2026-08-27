/**
 * MobileSubviewChromeContext - 移动端「页内全屏子屏」的统一顶栏接管通道
 *
 * 场景：learning-hub 右屏 app 内的全屏内联子屏（题库导出向导 / 题目历史 /
 * 原图裁剪等，absolute inset-0 覆盖宿主内容区），以及中屏 finder 的内联子屏
 * （移动到… FolderPickerDialog inline，经 chrome.screen 标记按屏位匹配接管）。
 * 这些子屏此前在小屏上自绘 h-12 顶栏 + ArrowLeft，与 App 级
 * UnifiedMobileHeader 叠成双 chrome。
 *
 * 机制（保持「每个 viewId 单一写者」的注册表契约）：
 * - 拥有统一顶栏 viewId 的宿主页面（当前为 LearningHubPage）通过
 *   useMobileSubviewChromeHost() 建立子屏 chrome 栈并渲染 Provider；
 * - 子屏打开时通过 useMobileSubviewChrome(chrome, deps, enabled) 把
 *   标题 / 返回 / 右侧动作推给宿主；宿主把栈顶 chrome 并入自己
 *   useMobileHeader(viewId) 的配置 —— 不引入第二个 useMobileHeader 写者，
 *   子屏关闭（enabled=false）或卸载时自动出栈，宿主配置随 deps 复原。
 * - hook 返回是否存在宿主：有宿主时子屏隐藏页内自绘顶栏；无宿主
 *   （桌面分栏 / workbench 窗口等无统一顶栏的承载）保持自绘顶栏，行为不变。
 *
 * 保活约束：publisher 必须用 enabled 参数 gate 宿主标签页活跃性
 * （isActive !== false），display:none 的保活实例不得接管活跃标签页的顶栏
 * （对照 Android 返回键 handler 的可见性守卫，Round 12）。
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/** 子屏推给宿主统一顶栏的配置 */
export interface MobileSubviewChrome {
  /** 子屏标题（顶栏中间区域） */
  title: string;
  /** 顶栏返回箭头回调（必须与子屏已注册的系统返回 handler 同语义） */
  onBack: () => void;
  /**
   * 顶栏右侧动作（约定 ≤2 个、每个 ≥44px 触控目标，
   * 与 MobileHeaderConfig.rightActions 同约束）
   */
  rightActions?: ReactNode;
  /**
   * 子屏归属的滑动屏位：宿主只在当前 screenPosition 与之匹配时接管顶栏，
   * 滑到其他屏位后顶栏立即恢复该屏位原语义（子屏保持打开等待返回）。
   * 缺省 'right'，兼容既有右屏 app 子屏（题库导出/历史/裁剪等）。
   */
  screen?: 'center' | 'right';
}

interface MobileSubviewChromeHostValue {
  /** chrome 为 null 表示出栈（子屏关闭 / 失活 / 卸载） */
  setSubviewChrome: (ownerId: string, chrome: MobileSubviewChrome | null) => void;
}

const MobileSubviewChromeContext = createContext<MobileSubviewChromeHostValue | null>(null);

export const MobileSubviewChromeProvider = MobileSubviewChromeContext.Provider;

interface ChromeEntry {
  ownerId: string;
  chrome: MobileSubviewChrome;
}

/**
 * 宿主侧：维护子屏 chrome 栈（后开的子屏接管顶栏，关闭后回落到前一个）。
 *
 * @returns activeSubviewChrome - 栈顶 chrome（无子屏时为 null），由宿主并入
 *   自己 useMobileHeader 的配置；subviewChromeHost - 传给
 *   MobileSubviewChromeProvider 的稳定 value
 */
export function useMobileSubviewChromeHost(): {
  activeSubviewChrome: MobileSubviewChrome | null;
  subviewChromeHost: MobileSubviewChromeHostValue;
} {
  const [entries, setEntries] = useState<ChromeEntry[]>([]);

  const setSubviewChrome = useCallback(
    (ownerId: string, chrome: MobileSubviewChrome | null) => {
      setEntries((prev) => {
        const idx = prev.findIndex((entry) => entry.ownerId === ownerId);
        if (chrome === null) {
          if (idx < 0) return prev;
          const next = prev.slice();
          next.splice(idx, 1);
          return next;
        }
        if (idx < 0) return [...prev, { ownerId, chrome }];
        if (prev[idx].chrome === chrome) return prev;
        const next = prev.slice();
        next[idx] = { ownerId, chrome };
        return next;
      });
    },
    [],
  );

  const subviewChromeHost = useMemo(() => ({ setSubviewChrome }), [setSubviewChrome]);
  const activeSubviewChrome = entries.length > 0 ? entries[entries.length - 1].chrome : null;

  return { activeSubviewChrome, subviewChromeHost };
}

/**
 * 子屏侧：向宿主统一顶栏发布本子屏的 标题/返回/右侧动作。
 *
 * @param chrome - 顶栏配置（每次渲染重建即可，effect 触发时取最新值）
 * @param deps - 依赖数组，变化时向宿主重发配置（enabled 自动纳入依赖）
 * @param enabled - 是否接管。必须包含子屏打开态与宿主标签页活跃性
 *   （isActive !== false），保活隐藏实例不得接管活跃标签页的顶栏
 * @returns 是否存在宿主（存在时子屏应隐藏页内自绘顶栏）
 */
export function useMobileSubviewChrome(
  chrome: MobileSubviewChrome,
  deps: React.DependencyList,
  enabled: boolean,
): boolean {
  const host = useContext(MobileSubviewChromeContext);
  const ownerId = useId();
  const chromeRef = useRef(chrome);
  chromeRef.current = chrome;

  useLayoutEffect(() => {
    if (!host) return;
    host.setSubviewChrome(ownerId, enabled ? chromeRef.current : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, host, ownerId]);

  // 卸载时出栈（不能只依赖 enabled=false 分支：卸载不会再跑上面的 effect）
  useLayoutEffect(() => {
    return () => {
      host?.setSubviewChrome(ownerId, null);
    };
  }, [host, ownerId]);

  return host !== null;
}

export default MobileSubviewChromeProvider;
