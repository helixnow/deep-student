export type BackHandler = () => boolean;

/** 优先级约定：数值越大越先处理 */
export const BACK_PRIORITY = {
  /**
   * 模态层：Dialog/Sheet/抽屉等。
   *
   * 同档共存登记（2026-08 Wave2-C back 链静态核对）：
   * AppMenu（AppMenu.tsx，菜单打开时注册）与 Chat 组合面板
   * （InputBarUI.tsx，附件/模型/技能/MCP/对话控制等面板打开时注册）
   * 都以 overlay 档注册，不靠数值区分先后——同优先级后注册者先执行
   * （栈语义，见 getBackHandlersSnapshot 对 seq 的降序比较）。因此
   * 「面板开 → 再开菜单 → back 先关菜单（面板仍开）→ 再 back 关面板」
   * 由注册时序天然保证。新增同档浮层沿用该约定即可，
   * 不要为个别浮层引入 overlay±1 之类的魔法数值。
   */
  overlay: 100,
  /** 视图内部导航（如 Learning Hub 内部历史） */
  view: 50,
  /** 应用级视图历史 fallback */
  navigation: 0,
} as const;

interface RegisteredHandler {
  readonly handler: BackHandler;
  readonly priority: number;
  readonly seq: number;
}

let seqCounter = 0;
const handlers: RegisteredHandler[] = [];

/**
 * 注册返回键处理器。
 * handler 返回 true 表示事件已消费（native 不再处理）。
 * 同优先级后注册者先执行（栈语义，符合「最后打开的 overlay 最先关闭」）。
 */
export function registerBackHandler(handler: BackHandler, priority: number = BACK_PRIORITY.overlay): () => void {
  const entry: RegisteredHandler = { handler, priority, seq: seqCounter++ };
  handlers.push(entry);
  return () => {
    const idx = handlers.indexOf(entry);
    if (idx >= 0) handlers.splice(idx, 1);
  };
}

export function getBackHandlersSnapshot(): readonly RegisteredHandler[] {
  return [...handlers].sort((a, b) => (b.priority - a.priority) || (b.seq - a.seq));
}

/** 与 React ref 兼容的元素容器（框架无关，只要求 .current） */
export interface BackHandlerElementRef {
  readonly current: Element | null;
}

/**
 * 元素可见性守卫（2026-08 Wave2-C R5，扫描台账 03 V1 机制化）：
 * 保活但不可见的实例（ViewLayerRenderer keep-alive 隐藏层 / 后台标签页）
 * 不得吞掉当前活跃页面的系统返回键。注意 visibility:hidden 不清除布局盒
 * （getClientRects 仍有返回值），必须单独查 computed visibility。
 */
export function isElementVisibleForBack(el: Element | null): boolean {
  if (!el || !el.isConnected) return false;
  if (el.getClientRects().length === 0) return false;
  if (window.getComputedStyle(el).visibility === 'hidden') return false;
  return true;
}

/**
 * 带可见性守卫的返回键注册：宿主元素（通常是组件根 containerRef）不可见时
 * handler 直接让行（返回 false），事件继续沿栈下发。
 *
 * 供挂在同一保活视图体系内的浮层组件共用（EnhancedPdfViewer /
 * PdfSelectionActions 等），避免各处手抄 isConnected/getClientRects/visibility
 * 三重检查。排序与栈语义与 registerBackHandler 完全一致（内部就是它）。
 */
export function registerVisibilityGuardedBackHandler(
  elementRef: BackHandlerElementRef,
  handler: BackHandler,
  priority: number = BACK_PRIORITY.overlay,
): () => void {
  return registerBackHandler(() => {
    if (!isElementVisibleForBack(elementRef.current)) return false;
    return handler();
  }, priority);
}
