/**
 * 设置搜索 → 内容区定位高亮。
 *
 * 侧栏搜索命中项只携带 tab + label（见 useSettingsNavigation 的
 * settingsSearchIndex）：切换 tab 后内容区 lazy 加载，无法同步拿到目标行。
 * 这里以「标题文本匹配」轮询定位——SettingRow / GroupTitle / SwitchRow 均以
 * 与索引同源的 t() 文案渲染标题（h3 等），命中后滚动到视口中央并施加一次性
 * 高亮脉冲（settings.css 的 .settings-search-hit）。超时未命中（如虚拟化
 * 列表尚未挂载对应行）则静默放弃，保底行为是 tab 已切换。
 */

/** 标题类候选元素；data-settings-anchor 允许各 Tab 显式打点优先匹配 */
const CANDIDATE_SELECTOR = '[data-settings-anchor], h2, h3, h4, legend, label';

const POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 3_000;
const HIGHLIGHT_DURATION_MS = 2_200;
export const SETTINGS_SEARCH_HIT_CLASS = 'settings-search-hit';
/** 内容区根节点 id（Settings.tsx renderSettingsMainContent） */
export const SETTINGS_MAIN_CONTENT_ID = 'settings-main-content';

function normalize(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 在 root 内按标题文本查找目标元素（纯 DOM 查询，可单测）。
 * 优先级：data-settings-anchor 精确值 > 标题文本全等 > 标题文本前缀。
 */
export function findSettingsRevealTarget(root: ParentNode, label: string): HTMLElement | null {
  const needle = normalize(label);
  if (!needle) return null;

  const candidates = Array.from(root.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR));
  let exactHit: HTMLElement | null = null;
  let prefixHit: HTMLElement | null = null;
  for (const el of candidates) {
    // anchor 命中立即返回：显式打点不受 DOM 顺序影响，始终压过文本匹配
    if (el.getAttribute('data-settings-anchor') === needle) return el;
    if (exactHit) continue;
    const text = normalize(el.textContent);
    if (!text) continue;
    if (text === needle) {
      exactHit = el;
    } else if (!prefixHit && text.startsWith(needle)) {
      prefixHit = el;
    }
  }
  return exactHit ?? prefixHit;
}

/** 命中行的高亮宿主：优先所在设置行（SettingRow/SwitchRow 的 group 容器），否则元素自身 */
function resolveHighlightHost(target: HTMLElement): HTMLElement {
  return target.closest<HTMLElement>('.group') ?? target;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

let cancelActiveReveal: (() => void) | null = null;

/**
 * 切换 tab 后调用：轮询等待目标行挂载，命中即滚动 + 高亮。
 * 同一时刻只保留一个进行中的定位（新的搜索跳转会取消上一个）。
 * 返回取消函数（组件卸载 / 测试清理用）。
 */
export function revealSettingsSection(
  label: string,
  options?: { timeoutMs?: number },
): () => void {
  cancelActiveReveal?.();

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let highlightTimerId: ReturnType<typeof setTimeout> | null = null;
  let highlighted: HTMLElement | null = null;

  const cleanup = () => {
    if (intervalId != null) clearInterval(intervalId);
    intervalId = null;
    if (highlightTimerId != null) clearTimeout(highlightTimerId);
    highlightTimerId = null;
    if (highlighted) highlighted.classList.remove(SETTINGS_SEARCH_HIT_CLASS);
    highlighted = null;
    if (cancelActiveReveal === cleanup) cancelActiveReveal = null;
  };
  cancelActiveReveal = cleanup;

  const tryReveal = (): boolean => {
    const root = document.getElementById(SETTINGS_MAIN_CONTENT_ID);
    if (!root) return false;
    const target = findSettingsRevealTarget(root, label);
    if (!target) return false;

    if (intervalId != null) clearInterval(intervalId);
    intervalId = null;

    target.scrollIntoView({
      block: 'center',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
    highlighted = resolveHighlightHost(target);
    highlighted.classList.add(SETTINGS_SEARCH_HIT_CLASS);
    highlightTimerId = setTimeout(cleanup, HIGHLIGHT_DURATION_MS);
    return true;
  };

  // 首帧先试一次（同 tab 内跳转无需等待），未命中再进入轮询
  if (!tryReveal()) {
    intervalId = setInterval(() => {
      if (Date.now() - startedAt >= timeoutMs) {
        cleanup();
        return;
      }
      tryReveal();
    }, POLL_INTERVAL_MS);
  }

  return cleanup;
}
