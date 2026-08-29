import React from 'react';
import {
  createOwnedOverlayStore,
  isEventInsideOwnedOverlay,
  listOwnedOverlayOwnerIds as listStoreOwnerIds,
  registerOwnedOverlayEntry,
  type OwnedOverlayRegistration,
} from './overlayOwnership';

export type { OwnedOverlayRegistration, OwnedOverlaySpec } from './overlayOwnership';

export interface OverlayCoordinatorValue {
  activeInteractiveOverlayCount: number;
  tooltipsSuppressed: boolean;
  tooltipDismissVersion: number;
  dismissTooltips: () => void;
  registerInteractiveOverlay: () => () => void;
  /**
   * 浮层归属登记（与上面的 tooltip 抑制彼此独立，互不影响）：
   * 面板（owner）登记自己拥有、但 DOM 上 portal 到面板容器之外的浮层
   * （element 引用或 selector 二选一/皆可）。返回幂等的注销函数。
   * 登记/注销走 ref，不触发任何 re-render，也不改变 tooltipsSuppressed。
   */
  registerOwnedOverlay: (registration: OwnedOverlayRegistration) => () => void;
  /**
   * 外点关闭 / back 处理时查询：事件 target 是否落在 ownerId 登记的浮层内。
   * true ⇒ 视为"面板内"，不要关闭该面板。
   */
  isOwnedOverlayTarget: (ownerId: string, target: EventTarget | null) => boolean;
  /** 当前有登记浮层的 ownerId 列表（调试 / back 分发用）。 */
  listOwnedOverlayOwnerIds: () => string[];
}

// 无 Provider 时的回退语义（fail-empty，写清）：
// - tooltip 侧维持原状：不抑制、注册为 noop。
// - 归属侧视为"空登记表"：registerOwnedOverlay 为 noop，
//   isOwnedOverlayTarget 恒 false，listOwnedOverlayOwnerIds 恒 []。
//   即无 Provider 时查询不到任何归属，调用方必须保留自己原有的
//   contains/closest 兜底判断（fail-open 到旧行为），不会因缺 Provider 抛错。
const fallbackOverlayCoordinator: OverlayCoordinatorValue = {
  activeInteractiveOverlayCount: 0,
  tooltipsSuppressed: false,
  tooltipDismissVersion: 0,
  dismissTooltips: () => {},
  registerInteractiveOverlay: () => () => {},
  registerOwnedOverlay: () => () => {},
  isOwnedOverlayTarget: () => false,
  listOwnedOverlayOwnerIds: () => [],
};

const OverlayCoordinatorContext = React.createContext<OverlayCoordinatorValue>(fallbackOverlayCoordinator);

export function OverlayCoordinatorProvider({ children }: { children: React.ReactNode }) {
  const [activeInteractiveOverlayCount, setActiveInteractiveOverlayCount] = React.useState(0);
  const [tooltipDismissVersion, setTooltipDismissVersion] = React.useState(0);
  // 归属登记表放 ref：登记/查询都发生在事件时刻，不需要（也不应该）驱动渲染。
  const ownedOverlayStoreRef = React.useRef(createOwnedOverlayStore());

  const dismissTooltips = React.useCallback(() => {
    setTooltipDismissVersion((version) => version + 1);
  }, []);

  const registerInteractiveOverlay = React.useCallback(() => {
    let released = false;

    setActiveInteractiveOverlayCount((count) => count + 1);
    setTooltipDismissVersion((version) => version + 1);

    return () => {
      if (released) return;
      released = true;
      setActiveInteractiveOverlayCount((count) => Math.max(0, count - 1));
    };
  }, []);

  const registerOwnedOverlay = React.useCallback(
    (registration: OwnedOverlayRegistration) => registerOwnedOverlayEntry(ownedOverlayStoreRef.current, registration),
    [],
  );

  const isOwnedOverlayTarget = React.useCallback(
    (ownerId: string, target: EventTarget | null) => isEventInsideOwnedOverlay(ownedOverlayStoreRef.current, ownerId, target),
    [],
  );

  const listOwnedOverlayOwnerIds = React.useCallback(
    () => listStoreOwnerIds(ownedOverlayStoreRef.current),
    [],
  );

  const value = React.useMemo<OverlayCoordinatorValue>(() => ({
    activeInteractiveOverlayCount,
    tooltipsSuppressed: activeInteractiveOverlayCount > 0,
    tooltipDismissVersion,
    dismissTooltips,
    registerInteractiveOverlay,
    registerOwnedOverlay,
    isOwnedOverlayTarget,
    listOwnedOverlayOwnerIds,
  }), [
    activeInteractiveOverlayCount,
    dismissTooltips,
    registerInteractiveOverlay,
    registerOwnedOverlay,
    isOwnedOverlayTarget,
    listOwnedOverlayOwnerIds,
    tooltipDismissVersion,
  ]);

  return (
    <OverlayCoordinatorContext.Provider value={value}>
      {children}
    </OverlayCoordinatorContext.Provider>
  );
}

export function useOverlayCoordinator(): OverlayCoordinatorValue {
  return React.useContext(OverlayCoordinatorContext);
}
