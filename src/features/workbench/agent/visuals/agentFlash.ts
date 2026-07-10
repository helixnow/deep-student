/**
 * ACR 实体级 flash 原语 — R1-10 / R3-03
 *
 * 约定：列表行挂 `data-agent-entity="{typeId}:{entityId}"`；
 * 本函数 `scrollIntoView` + 短暂 `data-agent-flash`（CSS 渐隐）。
 * 对缺失元素必须安全 no-op。见 docs/dev/acr/DESIGN.md §4.2。
 *
 * R3-03：默认 scroll=auto（避免 smooth 与 reduced-motion 冲突）；
 * reduced-motion 下静态高亮 ~400ms 兜底清理；agentFlashMany 仅末项滚动。
 */
import './agent-visuals.css';

type FlashCleanup = () => void;

export interface AgentFlashOptions {
  /** 是否 scrollIntoView；批量 flash 时仅最后一项为 true */
  scroll?: boolean;
}

/** 同一元素连续 flash 时先清后设 */
const activeCleanups = new WeakMap<Element, FlashCleanup>();

/** 与 CSS --acr-flash-ms(750) + 缓冲对齐；reduced-motion 用静态时长 */
const FLASH_FALLBACK_MS = 800;
const FLASH_STATIC_FALLBACK_MS = 400;

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

/**
 * 高亮并滚入视口指定实体行。
 * @param typeId workbench 应用 typeId
 * @param entityId 域内实体 id（节点 / 条目等）
 * @param options.scroll 默认 true；批量时仅末项滚动
 */
export function agentFlash(
  typeId: string,
  entityId: string,
  options?: AgentFlashOptions,
): void {
  if (typeof document === 'undefined') return;

  const key = `${typeId}:${entityId}`;
  const el = document.querySelector(
    `[data-agent-entity="${escapeAttrValue(key)}"]`,
  );
  if (!el) return;

  const prev = activeCleanups.get(el);
  if (prev) prev();

  const reduced = prefersReducedMotion();
  const shouldScroll = options?.scroll !== false;

  el.removeAttribute('data-agent-flash');
  // 强制重排，确保连续调用能重启动画
  void (el as HTMLElement).offsetWidth;
  el.setAttribute('data-agent-flash', '');

  if (shouldScroll && typeof (el as HTMLElement).scrollIntoView === 'function') {
    // 默认 auto：避免 smooth 与 prefers-reduced-motion 冲突，且批量更稳
    (el as HTMLElement).scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }

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
    reduced ? FLASH_STATIC_FALLBACK_MS : FLASH_FALLBACK_MS,
  );
  activeCleanups.set(el, cleanup);
}

/**
 * 批量 flash：全部高亮，仅最后一项 scrollIntoView（避免连跳）。
 */
export function agentFlashMany(typeId: string, entityIds: readonly string[]): void {
  const ids = entityIds.filter((id) => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return;
  const last = ids.length - 1;
  for (let i = 0; i < ids.length; i++) {
    agentFlash(typeId, ids[i]!, { scroll: i === last });
  }
}
