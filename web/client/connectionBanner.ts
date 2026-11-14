/**
 * WebUI 连接状态提示（纯 DOM，零第三方依赖）。
 *
 * 三块 UI：
 * 1. 顶部连接状态胶囊：断线重连中（琥珀色 6px 点 + 第几次 + 倒计时 + 立即重连）、恢复连接后短暂闪出绿色提示。
 * 2. 首屏离线闸门：初始握手因离线 / 宿主不可达失败时占据整屏，避免 `src/main.tsx` 的 startup_preflight
 *    苦等 135 秒后误报「桌面数据库恢复」。
 * 3. 右下角提示堆叠：Service Worker 新版本（刷新启用）、PWA 安装入口（可永久关闭）。
 *
 * 全部文案中文、无 emoji；颜色走 CSS 变量（`--background` / `--foreground` / `--card` / `--border`），
 * 边框 1px，圆点 6px，数字用 `tabular-nums`。
 */

export type ConnectionBannerTone = 'warning' | 'success' | 'danger' | 'info';

const DOT_COLORS: Record<ConnectionBannerTone, string> = {
  warning: '#f59e0b',
  success: '#10b981',
  danger: '#ef4444',
  info: '#3b82f6',
};

const STYLE_ID = 'ds-webui-banner-styles';
const RECONNECTED_VISIBLE_MS = 1800;
const FADE_MS = 180;

function hasDom(): boolean {
  return typeof document !== 'undefined' && typeof window !== 'undefined' && document.body !== null;
}

function ensureStyles(): void {
  if (!hasDom() || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .ds-webui-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: min(92vw, 560px);
      padding: 8px 12px;
      border-radius: 9999px;
      border: 1px solid hsl(var(--border, 0 0% 88%) / 0.35);
      background: hsl(var(--card, 0 0% 99%));
      color: hsl(var(--foreground, 220 9% 18%));
      font-family: var(--app-font-family, -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif);
      font-size: 13px;
      line-height: 1.4;
      font-variant-numeric: tabular-nums;
      font-family: var(--font-mono, ui-monospace, monospace);
      box-shadow: 0 4px 16px hsl(0 0% 0% / 0.12);
      box-sizing: border-box;
      transition: opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease;
      pointer-events: auto;
    }
    .ds-webui-pill[data-hidden='true'] {
      opacity: 0;
      transform: translateY(-6px);
      pointer-events: none;
    }
    .ds-webui-pill--top {
      position: fixed;
      top: max(12px, env(safe-area-inset-top));
      left: 50%;
      transform: translateX(-50%);
      z-index: 99999;
    }
    .ds-webui-pill--top[data-hidden='true'] {
      transform: translate(-50%, -6px);
    }
    .ds-webui-pill-stack {
      position: fixed;
      right: max(12px, env(safe-area-inset-right));
      bottom: max(12px, env(safe-area-inset-bottom));
      z-index: 99999;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      pointer-events: none;
    }
    .ds-webui-dot {
      width: 6px;
      height: 6px;
      border-radius: 9999px;
      flex-shrink: 0;
    }
    .ds-webui-text {
      min-width: 0;
      word-break: break-word;
    }
    .ds-webui-action {
      flex-shrink: 0;
      min-height: 32px;
      padding: 2px 10px;
      border-radius: 9999px;
      border: 1px solid hsl(var(--border, 0 0% 88%) / 0.35);
      background: transparent;
      color: inherit;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .ds-webui-action:hover {
      background: hsl(var(--foreground, 220 9% 18%) / 0.06);
    }
    .ds-webui-action:focus-visible {
      outline: 2px solid hsl(var(--ring, 214 62% 50%));
      outline-offset: 2px;
    }
    .ds-webui-offline-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: grid;
      place-items: center;
      padding:
        max(24px, env(safe-area-inset-top))
        max(24px, env(safe-area-inset-right))
        max(24px, env(safe-area-inset-bottom))
        max(24px, env(safe-area-inset-left));
      overflow-y: auto;
      background: hsl(var(--background, 40 20% 99%));
      color: hsl(var(--foreground, 220 9% 18%));
      font-family: var(--app-font-family, -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif);
      -webkit-text-size-adjust: 100%;
    }
    .ds-webui-offline-card {
      width: 100%;
      max-width: 400px;
      padding: 24px;
      border-radius: 12px;
      background: hsl(var(--card, 0 0% 99%));
      color: hsl(var(--foreground, 220 9% 18%));
      border: 1px solid hsl(var(--border, 0 0% 88%) / 0.35);
      box-sizing: border-box;
    }
    .ds-webui-offline-status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
      font-size: 12px;
      color: hsl(var(--muted-foreground, 220 6% 42%));
      font-variant-numeric: tabular-nums;
    }
    .ds-webui-offline-divider {
      height: 1px;
      border: 0;
      margin: 0 0 16px;
      background: hsl(var(--border, 0 0% 88%) / 0.35);
    }
    .ds-webui-offline-title {
      margin: 0 0 8px;
      font-size: 17px;
      font-weight: 600;
      line-height: 1.35;
    }
    .ds-webui-offline-desc {
      margin: 0 0 18px;
      font-size: 14px;
      line-height: 1.55;
      color: hsl(var(--muted-foreground, 220 6% 42%));
      word-break: break-word;
    }
    .ds-webui-offline-retry {
      width: 100%;
      min-height: 44px;
      padding: 10px 16px;
      border-radius: 8px;
      border: 1px solid hsl(var(--border, 0 0% 88%) / 0.35);
      background: hsl(var(--foreground, 220 9% 18%) / 0.9);
      color: hsl(var(--background, 40 20% 99%));
      font: inherit;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      box-sizing: border-box;
    }
    .ds-webui-offline-retry:hover {
      opacity: 0.92;
    }
    .ds-webui-offline-retry:focus-visible {
      outline: 2px solid hsl(var(--ring, 214 62% 50%));
      outline-offset: 2px;
    }
    @media (prefers-reduced-motion: reduce) {
      .ds-webui-pill {
        transition: none !important;
      }
    }
  `;
  (document.head ?? document.documentElement).appendChild(style);
}

function createDot(tone: ConnectionBannerTone): HTMLSpanElement {
  const dot = document.createElement('span');
  dot.className = 'ds-webui-dot';
  dot.setAttribute('aria-hidden', 'true');
  dot.style.background = DOT_COLORS[tone];
  return dot;
}

function createAction(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ds-webui-action';
  button.textContent = label;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

// ---------------------------------------------------------------- 顶部连接状态胶囊

let topPill: HTMLDivElement | null = null;
let topPillTimer: ReturnType<typeof setTimeout> | null = null;

function ensureTopPill(): HTMLDivElement {
  if (topPill && topPill.isConnected) return topPill;
  const pill = document.createElement('div');
  pill.className = 'ds-webui-pill ds-webui-pill--top';
  pill.id = 'ds-webui-connection-pill';
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-live', 'polite');
  document.body.appendChild(pill);
  topPill = pill;
  return pill;
}

function clearTopPillTimer(): void {
  if (topPillTimer !== null) {
    clearTimeout(topPillTimer);
    topPillTimer = null;
  }
}

function fillTopPill(
  pill: HTMLDivElement,
  tone: ConnectionBannerTone,
  text: string,
  action?: { label: string; onClick: () => void },
): void {
  pill.textContent = '';
  pill.dataset.hidden = 'false';
  const label = document.createElement('span');
  label.className = 'ds-webui-text';
  label.textContent = text;
  pill.append(createDot(tone), label);
  if (action) pill.append(createAction(action.label, action.onClick));
}

function removeTopPill(): void {
  clearTopPillTimer();
  if (topPill) {
    topPill.remove();
    topPill = null;
  }
}

/** 断线重连中：`attempt` 为第几次重连，`nextRetryMs` 为本次等待时长。 */
export function showReconnecting(attempt: number, nextRetryMs: number, onRetryNow: () => void): void {
  if (!hasDom()) return;
  ensureStyles();
  clearTopPillTimer();
  const pill = ensureTopPill();
  const seconds = (Math.max(0, nextRetryMs) / 1000).toFixed(1);
  fillTopPill(pill, 'warning', `与服务器连接已断开，正在重连（第 ${attempt} 次，${seconds}s）`, {
    label: '立即重连',
    onClick: onRetryNow,
  });
}

/** 浏览器明确处于离线态：暂停后台退避轮询，等待网络恢复或手动重连。 */
export function showOfflineWaiting(onRetryNow: () => void): void {
  if (!hasDom()) return;
  ensureStyles();
  clearTopPillTimer();
  const pill = ensureTopPill();
  fillTopPill(pill, 'warning', '网络已断开，恢复在线后将自动重连', {
    label: '立即重连',
    onClick: onRetryNow,
  });
}

/** 已恢复：绿色点短暂显示后淡出。 */
export function showReconnected(): void {
  if (!hasDom()) return;
  ensureStyles();
  clearTopPillTimer();
  const pill = ensureTopPill();
  fillTopPill(pill, 'success', '已恢复服务器连接');
  topPillTimer = setTimeout(() => {
    topPillTimer = null;
    if (!topPill) return;
    topPill.dataset.hidden = 'true';
    topPillTimer = setTimeout(() => {
      topPillTimer = null;
      removeTopPill();
    }, FADE_MS);
  }, RECONNECTED_VISIBLE_MS);
}

/** 立即收起顶部胶囊（连接正常时不该有残留）。 */
export function hideConnectionBanner(): void {
  removeTopPill();
}

// ---------------------------------------------------------------- 首屏离线闸门

let offlineOverlay: HTMLDivElement | null = null;
let offlineRetryHandler: (() => void) | null = null;

/** 初始握手失败（离线 / 宿主不可达）时的整屏闸门；网络恢复后由 bootstrap 关闭。 */
export function showOfflineBootOverlay(onRetry: () => void): void {
  if (!hasDom()) return;
  ensureStyles();
  offlineRetryHandler = onRetry;
  if (offlineOverlay && offlineOverlay.isConnected) return;

  const overlay = document.createElement('div');
  overlay.className = 'ds-webui-offline-overlay';
  overlay.id = 'ds-webui-offline-overlay';

  const card = document.createElement('div');
  card.className = 'ds-webui-offline-card';
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-modal', 'true');

  const statusRow = document.createElement('div');
  statusRow.className = 'ds-webui-offline-status';
  const statusLabel = document.createElement('span');
  statusLabel.textContent = 'Deep Student 网页工作台';
  statusRow.append(createDot('warning'), statusLabel);

  const divider = document.createElement('hr');
  divider.className = 'ds-webui-offline-divider';

  const title = document.createElement('h2');
  title.className = 'ds-webui-offline-title';
  title.textContent = '当前处于离线状态或无法连接宿主服务';

  const desc = document.createElement('p');
  desc.className = 'ds-webui-offline-desc';
  desc.textContent = 'WebUI 需要连接远端 Deep Student 服务以加载学习数据。网络恢复后将自动进入应用。';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'ds-webui-offline-retry';
  retry.textContent = '立即重试连接';
  retry.addEventListener('click', (event) => {
    event.preventDefault();
    offlineRetryHandler?.();
  });

  card.append(statusRow, divider, title, desc, retry);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  offlineOverlay = overlay;
}

export function hideOfflineBootOverlay(): void {
  if (offlineOverlay) {
    offlineOverlay.remove();
    offlineOverlay = null;
  }
}

// ---------------------------------------------------------------- 右下角提示堆叠

let pillStack: HTMLDivElement | null = null;
let swPill: HTMLDivElement | null = null;
let installPill: HTMLDivElement | null = null;

function ensurePillStack(): HTMLDivElement {
  if (pillStack && pillStack.isConnected) return pillStack;
  const stack = document.createElement('div');
  stack.className = 'ds-webui-pill-stack';
  document.body.appendChild(stack);
  pillStack = stack;
  return stack;
}

function dropPill(pill: HTMLDivElement | null): void {
  if (!pill) return;
  pill.remove();
  if (pillStack && pillStack.childElementCount === 0) {
    pillStack.remove();
    pillStack = null;
  }
}

/** Service Worker 有新版本：`[刷新启用]` 触发 SKIP_WAITING + 重载，`[稍后]` 收起。 */
export function showSwUpdateAvailable(onReload: () => void): void {
  if (!hasDom()) return;
  ensureStyles();
  if (swPill && swPill.isConnected) return;

  const pill = document.createElement('div');
  pill.className = 'ds-webui-pill';
  pill.id = 'ds-webui-sw-update';
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-live', 'polite');

  const text = document.createElement('span');
  text.className = 'ds-webui-text';
  text.textContent = '应用已更新至新版本';

  pill.append(
    createDot('info'),
    text,
    createAction('刷新启用', onReload),
    createAction('稍后', () => {
      dropPill(pill);
      swPill = null;
    }),
  );

  ensurePillStack().appendChild(pill);
  swPill = pill;
}

export function hideSwUpdateAvailable(): void {
  dropPill(swPill);
  swPill = null;
}

/** PWA 安装入口：`[安装为独立应用]` 调 `beforeinstallprompt`，`[暂不]` 永久关闭。 */
export function showPwaInstallOption(onInstall: () => void, onDismiss: () => void): void {
  if (!hasDom()) return;
  ensureStyles();
  if (installPill && installPill.isConnected) return;

  const pill = document.createElement('div');
  pill.className = 'ds-webui-pill';
  pill.id = 'ds-webui-pwa-install';
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-live', 'polite');

  pill.append(
    createDot('info'),
    createAction('安装为独立应用', onInstall),
    createAction('暂不', () => {
      dropPill(pill);
      installPill = null;
      onDismiss();
    }),
  );

  ensurePillStack().appendChild(pill);
  installPill = pill;
}

export function hidePwaInstallOption(): void {
  dropPill(installPill);
  installPill = null;
}
