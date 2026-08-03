/**
 * ACR 实体级 flash 原语 — R1-10 / R3-03 / 演出优化轮
 *
 * 约定：列表行挂 `data-agent-entity="{typeId}:{entityId}"`；
 * 本函数 `scrollIntoView` + 短暂 `data-agent-flash`（CSS 渐隐）。
 * 对缺失元素必须安全 no-op。见 docs/dev/acr/DESIGN.md §4.2。
 *
 * R3-03：默认 scroll=auto（避免 smooth 与 reduced-motion 冲突）；
 * reduced-motion 下静态高亮 ~400ms 兜底清理；agentFlashMany 默认仅末项滚动。
 *
 * 演出优化轮：
 * - agentFlashMany 批量读写分离：先统一清属性，整批只强制一次重排，
 *   再统一设属性（此前逐条「写→读 offsetWidth→写」是 N 次强制同步布局）；
 * - options.scope 支持窗口/容器作用域查找，多窗同实体时不闪错地方；
 * - 兜底时长从 CSS --acr-flash-ms 单源读取（+50ms 缓冲），不再双源漂移。
 */
import { readCssTimeMs } from '@/shared/utils/cssTime';
import './agent-visuals.css';

type FlashCleanup = () => void;

export interface AgentFlashOptions {
  /** 是否 scrollIntoView；批量 flash 时仅一项为 true */
  scroll?: boolean;
  /** 限定查找范围（如宿主窗口根元素）；缺省全文档 */
  scope?: ParentNode | null;
}

export interface AgentFlashManyOptions {
  /** 滚动到首项 / 末项 / 不滚动；默认 'last'（R3-02 决议：批量只滚一次） */
  scroll?: 'first' | 'last' | false;
  /** 限定查找范围（如宿主窗口根元素）；缺省全文档 */
  scope?: ParentNode | null;
}

/** 同一元素连续 flash 时先清后设 */
const activeCleanups = new WeakMap<Element, FlashCleanup>();

/** CSS --acr-flash-ms 单源 + 缓冲；reduced-motion 用静态时长 */
function flashFallbackMs(): number {
  return readCssTimeMs('--acr-flash-ms', 750) + 50;
}

function flashStaticFallbackMs(): number {
  return readCssTimeMs('--acr-flash-static-ms', 400);
}

function prefersReducedMotion(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function escapeAttrValue(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  // jsdom / 旧环境兜底：转义属性选择器特殊字符
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function findEntityEl(
  typeId: string,
  entityId: string,
  scope?: ParentNode | null,
): Element | null {
  if (typeof document === 'undefined') return null;
  const key = `${typeId}:${entityId}`;
  const root: ParentNode = scope ?? document;
  return root.querySelector(`[data-agent-entity="${escapeAttrValue(key)}"]`);
}

/** 清旧 flash + 摘属性（写阶段 1；调用后需一次强制重排再重设属性） */
function resetFlashAttr(el: Element): void {
  const prev = activeCleanups.get(el);
  if (prev) prev();
  el.removeAttribute('data-agent-flash');
}

/** 设属性 + 注册 animationend/超时双保险清理（写阶段 2） */
function applyFlashAttr(el: Element, reduced: boolean): void {
  el.setAttribute('data-agent-flash', '');

  let settled = false;
  const cleanup: FlashCleanup = () => {
    if (settled) return;
    settled = true;
    el.removeAttribute('data-agent-flash');
    el.removeEventListener('animationend', onAnimationEnd);
    window.clearTimeout(timer);
    activeCleanups.delete(el);
  };

  const onAnimationEnd = () => {
    // ::before 上的动画会冒泡到宿主（R3-02 opacity flash）
    cleanup();
  };

  // reduced-motion：CSS 无 animationend，仅靠短超时清静态高亮
  if (!reduced) {
    el.addEventListener('animationend', onAnimationEnd);
  }
  const timer = window.setTimeout(
    cleanup,
    reduced ? flashStaticFallbackMs() : flashFallbackMs(),
  );
  activeCleanups.set(el, cleanup);
}

function scrollToEl(el: Element): void {
  if (typeof (el as HTMLElement).scrollIntoView === 'function') {
    // 默认 auto：避免 smooth 与 prefers-reduced-motion 冲突，且批量更稳
    (el as HTMLElement).scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }
}

/**
 * 高亮并滚入视口指定实体行。
 * @param typeId workbench 应用 typeId
 * @param entityId 域内实体 id（节点 / 条目等）
 * @param options.scroll 默认 true；批量时仅单项滚动
 * @param options.scope 限定查找范围；缺省全文档
 */
export function agentFlash(
  typeId: string,
  entityId: string,
  options?: AgentFlashOptions,
): void {
  const el = findEntityEl(typeId, entityId, options?.scope);
  if (!el) return;

  resetFlashAttr(el);
  // 强制重排，确保连续调用能重启动画
  void (el as HTMLElement).offsetWidth;
  applyFlashAttr(el, prefersReducedMotion());

  if (options?.scroll !== false) scrollToEl(el);
}

/**
 * 批量 flash：全部高亮，默认仅最后一项 scrollIntoView（避免连跳）。
 * 读写分离：清属性 → 一次强制重排 → 设属性，整批只触发一次同步布局。
 */
export function agentFlashMany(
  typeId: string,
  entityIds: readonly string[],
  options?: AgentFlashManyOptions,
): void {
  if (typeof document === 'undefined') return;
  const ids = entityIds.filter((id) => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return;

  const els: Element[] = [];
  const seen = new Set<Element>();
  for (const id of ids) {
    const el = findEntityEl(typeId, id, options?.scope);
    if (el && !seen.has(el)) {
      seen.add(el);
      els.push(el);
    }
  }
  if (els.length === 0) return;

  for (const el of els) resetFlashAttr(el);
  // 单次强制重排 flush 整批属性移除，随后重设即可重启动画
  void (els[0] as HTMLElement).offsetWidth;

  const reduced = prefersReducedMotion();
  for (const el of els) applyFlashAttr(el, reduced);

  const scrollMode = options?.scroll ?? 'last';
  if (scrollMode !== false) {
    scrollToEl(scrollMode === 'first' ? els[0]! : els[els.length - 1]!);
  }
}
