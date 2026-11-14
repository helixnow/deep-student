/**
 * Browser-side Tauri compatibility bootstrap for Deep Student WebUI + PWA.
 *
 * Installs `window.__DS_PLATFORM__`, wires `installTauriBridge` over WebSocket (`/api/ws`) with
 * automatic reconnect + listener re-subscription, maps `convertFileSrc` to `/api/protocol/<scheme>`,
 * handles browser-native dialog / clipboard / opener / window commands, bridges HTML5 file drag-drop
 * to staged server paths, and registers the PWA Service Worker.
 */
import { installTauriBridge, type BridgeTransport } from '../../electron/preload/bridge.ts';
import type { BridgeInit, InvokeMessage, MainToRenderer, RendererToMain, ResponseBody } from '../../electron/shell/bridge-messages.ts';
import { decodeMainMessage, encodeRendererMessage } from '../shared/wire.ts';
import {
  hideOfflineBootOverlay,
  hidePwaInstallOption,
  showOfflineBootOverlay,
  showOfflineWaiting,
  showPwaInstallOption,
  showReconnected,
  showReconnecting,
  showSwUpdateAvailable,
} from './connectionBanner.ts';

export interface PwaInstallController {
  canInstall(): boolean;
  promptInstall(): Promise<boolean>;
}

declare global {
  interface Window {
    __DS_PWA__?: PwaInstallController;
  }
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface ActiveListenerRecord {
  event: string;
  target: unknown;
  handlerId: number;
  clientEventId: number;
  serverEventId?: number;
}

/** 重连重发监听所需的最小字段（重发帧不重新分配 `clientEventId`）。 */
export interface ReconnectListenSpec {
  event: string;
  target: unknown;
  handlerId: number;
}

/**
 * 每次重发 `plugin:event|listen` 都要一个互不相同的 u32 callback id。
 *
 * 早先重连固定用 `callback: 0, error: 0`：多个标签页共用 key `0`，服务端
 * `callbackOwner` 只记得最后一个写入者，任一个 Tab 关闭时按 key 删除映射就会
 * 把其他 Tab 的回调归属一起删掉，listen 结果也会投递到错误的标签页。
 * 与 preload `transformCallback` 一致，用 `crypto.getRandomValues` 生成；
 * 命中 0 时退回 1，避免又落回被占用的 key。
 */
function nextReconnectCallbackId(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] === 0 ? 1 : buf[0]!;
}

/** 构造重连后重发的事件监听 invoke 帧。 */
export function buildReconnectListenMessage(spec: ReconnectListenSpec): InvokeMessage {
  return {
    type: 'invoke',
    cmd: 'plugin:event|listen',
    callback: nextReconnectCallbackId(),
    error: nextReconnectCallbackId(),
    headers: {},
    payload: {
      contentType: 'application/json',
      data: JSON.stringify({
        event: spec.event,
        target: spec.target,
        handler: spec.handlerId,
      }),
    },
  };
}

function encodeJsonBody(value: unknown): ResponseBody {
  const json = JSON.stringify(value === undefined ? null : value);
  return { kind: 'json', data: json === undefined ? 'null' : json };
}

/**
 * 文件 URL → WebUI HTTP 端点。
 *
 * 用**路径段**传文件路径（`/api/protocol/<scheme>/<encodedPath>`）而不是查询串
 * （`?path=`），因为 `src/` 的调用方会继续拼 `?mime=...` / `?qn=...`：
 * 旧写法拼完是 `/api/protocol/pdfstream?path=...?mime=...`，第二个 `?` 之后
 * 全被当成 `path` 的一部分，服务端拿到的路径是坏的（媒体/it 流式直接 404）。
 * 路径式基址不含 `?`，`${convertFileSrc(...)}?mime=...` 永远是合法的单 `?` URL。
 */
export function webConvertFileSrc(filePath: string, protocol = 'asset', origin?: string): string {
  const resolvedOrigin =
    origin ?? (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:1428');
  return `${resolvedOrigin}/api/protocol/${encodeURIComponent(protocol)}/${encodeURIComponent(filePath)}`;
}

export type ClientOs = 'ios' | 'android' | 'macos' | 'windows' | 'linux';

export function detectClientOs(): ClientOs {
  if (typeof navigator === 'undefined') return 'linux';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('android')) return 'android';
  if (
    ua.includes('iphone') ||
    ua.includes('ipad') ||
    ua.includes('ipod') ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  ) {
    return 'ios';
  }
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('win')) return 'windows';
  return 'linux';
}

const WEB_SHELL_STYLE_ID = 'ds-web-shell-styles';

/**
 * 启动阶段会被十几处组件同时调用的只读 RPC：并发请求合并成一次 + 极短读缓存。
 *
 * 实测首屏 55 次 `get_setting`、3 次 `get_api_configurations`（每次 106.8 KB）……
 * 全是同 key 的重复往返。这些命令都只读、可安全复用一个快照。
 */
export const COALESCED_READ_CMDS = new Set<string>([
  'get_setting',
  'get_api_configurations',
  'get_vendor_configs',
  'get_model_assignments',
  'chat_v2_list_sessions',
  'chat_v2_list_groups',
  'chat_v2_count_sessions',
  'super_session_get_state',
  'fsrs_get_stats',
  'review_plan_get_stats',
  'dstu_list',
]);

/**
 * 不影响数据库读结果的调用：不清短 TTL 缓存。
 * 其余任何 invoke 都视为「可能写入」，立刻清空缓存，保证读写后立即可见。
 */
const READ_CACHE_EXEMPT_CMDS = new Set<string>([
  'plugin:event|listen',
  'plugin:event|unlisten',
  'get_startup_recovery_status',
  'data_governance_get_maintenance_status',
  'load_webview_settings',
  'skill_list_directories',
  'chat_v2_list_runtime_roots',
  'get_all_custom_templates',
  'get_default_template_id',
]);

function isReadCacheExempt(cmd: string): boolean {
  return (
    READ_CACHE_EXEMPT_CMDS.has(cmd) ||
    cmd.startsWith('plugin:path|') ||
    cmd.startsWith('plugin:app|')
  );
}

/** 只读合并请求的读缓存 TTL：配置类长一点，列表/统计类短一点。 */
function readCacheTtlMs(cmd: string): number {
  return cmd === 'get_setting' ||
    cmd === 'get_api_configurations' ||
    cmd === 'get_vendor_configs' ||
    cmd === 'get_model_assignments'
    ? 2500
    : 1200;
}

function ensureWebShellStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(WEB_SHELL_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = WEB_SHELL_STYLE_ID;
  style.textContent = `
    :root {
      --ds-shell-bg: hsl(40 20% 99%);
      --ds-shell-fg: hsl(var(--foreground, 220 9% 18%));
      --ds-shell-card: hsl(var(--card, 0 0% 99%));
      --ds-shell-muted-fg: hsl(var(--muted-foreground, 220 6% 42%));
      --ds-shell-border: hsl(var(--border, 0 0% 88%) / 0.35);
      --ds-shell-input: hsl(var(--input, 0 0% 95%));
      --ds-shell-ring: hsl(var(--ring, 214 62% 50%));
      --ds-shell-danger: hsl(var(--destructive, 0 65% 51%));
      --ds-shell-danger-fg: hsl(var(--destructive-foreground, 0 0% 100%));
      --ds-shell-status: hsl(var(--status-working, 152 60% 36%));
      --button-primary-surface: hsl(220 9% 18% / 0.9);
      --button-primary-surface-hover: hsl(220 9% 18% / 0.82);
      --button-primary-fg: hsl(0 0% 100%);
      --button-secondary-surface: hsl(220 9% 18% / 0.06);
      --button-secondary-surface-hover: hsl(220 9% 18% / 0.11);
    }
    :root.dark,
    html[data-theme='dark'],
    html[data-boot-theme='dark'] {
      --ds-shell-bg: hsl(0 0% 7%);
      --ds-shell-fg: hsl(var(--foreground, 0 0% 96%));
      --ds-shell-card: hsl(0 0% 9.8%);
      --ds-shell-muted-fg: hsl(var(--muted-foreground, 0 0% 60%));
      --ds-shell-border: hsl(var(--border, 0 0% 18%) / 0.35);
      --ds-shell-input: hsl(var(--input, 0 0% 14%));
      --ds-shell-ring: hsl(var(--ring, 214 58% 68%));
      --ds-shell-danger: hsl(var(--destructive, 0 55% 45%));
      --ds-shell-danger-fg: hsl(var(--destructive-foreground, 0 0% 100%));
      --ds-shell-status: hsl(var(--status-working, 152 55% 42%));
      --button-primary-surface: hsl(0 0% 96% / 0.12);
      --button-primary-surface-hover: hsl(0 0% 96% / 0.18);
      --button-primary-fg: hsl(0 0% 96%);
      --button-secondary-surface: hsl(0 0% 96% / 0.06);
      --button-secondary-surface-hover: hsl(0 0% 96% / 0.1);
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme='light']):not([data-boot-theme='light']) {
        --ds-shell-bg: hsl(0 0% 7%);
        --ds-shell-fg: hsl(var(--foreground, 0 0% 96%));
        --ds-shell-card: hsl(0 0% 9.8%);
        --ds-shell-muted-fg: hsl(var(--muted-foreground, 0 0% 60%));
        --ds-shell-border: hsl(var(--border, 0 0% 18%) / 0.35);
        --ds-shell-input: hsl(var(--input, 0 0% 14%));
        --ds-shell-ring: hsl(var(--ring, 214 58% 68%));
        --ds-shell-danger: hsl(var(--destructive, 0 55% 45%));
        --ds-shell-danger-fg: hsl(var(--destructive-foreground, 0 0% 100%));
        --ds-shell-status: hsl(var(--status-working, 152 55% 42%));
        --button-primary-surface: hsl(0 0% 96% / 0.12);
        --button-primary-surface-hover: hsl(0 0% 96% / 0.18);
        --button-primary-fg: hsl(0 0% 96%);
        --button-secondary-surface: hsl(0 0% 96% / 0.06);
        --button-secondary-surface-hover: hsl(0 0% 96% / 0.1);
      }
    }
    .ds-web-shell-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      display: grid;
      place-items: center;
      padding:
        max(24px, env(safe-area-inset-top))
        max(24px, env(safe-area-inset-right))
        max(24px, env(safe-area-inset-bottom))
        max(24px, env(safe-area-inset-left));
      overflow-y: auto;
      background: var(--ds-shell-bg);
      color: var(--ds-shell-fg);
      font-family: var(--app-font-family, -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif);
      -webkit-text-size-adjust: 100%;
    }
    .ds-web-shell-overlay--modal {
      background: hsl(0 0% 0% / 0.48);
      backdrop-filter: blur(4px);
    }
    .ds-web-shell-card {
      width: 100%;
      max-width: 380px;
      padding: 24px;
      border-radius: 12px;
      background: var(--ds-shell-card);
      color: var(--ds-shell-fg);
      border: 1px solid var(--ds-shell-border);
      box-sizing: border-box;
      animation: ds-web-shell-enter 180ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    @keyframes ds-web-shell-enter {
      from {
        opacity: 0;
        transform: translateY(4px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .ds-web-shell-card {
        animation: none !important;
        transition: none !important;
      }
    }
    .ds-web-shell-status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--ds-shell-muted-fg);
      margin-bottom: 12px;
    }
    .ds-web-shell-dot {
      width: 6px;
      height: 6px;
      border-radius: 9999px;
      background: var(--ds-shell-status);
      flex-shrink: 0;
    }
    .ds-web-shell-divider {
      height: 1px;
      border: 0;
      background: var(--ds-shell-border);
      margin: 0 0 16px;
    }
    .ds-web-shell-title {
      margin: 0 0 6px;
      font-size: 17px;
      font-weight: 600;
      line-height: 1.35;
      color: var(--ds-shell-fg);
    }
    .ds-web-shell-subtitle {
      margin: 0 0 18px;
      font-size: 14px;
      line-height: 1.55;
      color: var(--ds-shell-muted-fg);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .ds-web-shell-label {
      display: block;
      margin: 0 0 6px;
      font-size: 13px;
      font-weight: 500;
      color: var(--ds-shell-fg);
    }
    .ds-web-shell-input {
      width: 100%;
      min-height: 44px;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid var(--ds-shell-border);
      background: var(--ds-shell-input);
      color: var(--ds-shell-fg);
      font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      font-size: 16px;
      box-sizing: border-box;
      outline: none;
    }
    .ds-web-shell-input:focus-visible {
      outline: 2px solid var(--ds-shell-ring);
      outline-offset: 2px;
    }
    .ds-web-shell-input:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .ds-web-shell-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      min-height: 44px;
      padding: 10px 16px;
      border-radius: 8px;
      border: 1px solid var(--ds-shell-border);
      background: var(--button-primary-surface);
      color: var(--button-primary-fg);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      box-sizing: border-box;
    }
    .ds-web-shell-btn:hover:not(:disabled) {
      background: var(--button-primary-surface-hover);
    }
    .ds-web-shell-btn:focus-visible {
      outline: 2px solid var(--ds-shell-ring);
      outline-offset: 2px;
    }
    .ds-web-shell-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .ds-web-shell-btn--secondary {
      background: var(--button-secondary-surface);
      color: var(--ds-shell-fg);
    }
    .ds-web-shell-btn--secondary:hover:not(:disabled) {
      background: var(--button-secondary-surface-hover);
    }
    .ds-web-shell-btn--danger {
      background: var(--ds-shell-danger);
      color: var(--ds-shell-danger-fg);
      border-color: transparent;
    }
    .ds-web-shell-btn--danger:hover:not(:disabled) {
      opacity: 0.92;
    }
    .ds-web-shell-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 18px;
    }
    .ds-web-shell-actions .ds-web-shell-btn {
      width: auto;
      min-width: 88px;
      flex: 1 1 0;
    }
    .ds-web-shell-error {
      margin-top: 12px;
      font-size: 13px;
      line-height: 1.45;
      color: var(--ds-shell-danger);
    }
    .ds-web-shell-error:empty {
      display: none;
    }
  `;
  (document.head ?? document.documentElement).appendChild(style);
}

export interface WebShellDialogOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export function showWebShellDialog(options: WebShellDialogOptions): Promise<boolean> {
  if (typeof document === 'undefined' || !document.body) {
    return Promise.resolve(false);
  }
  ensureWebShellStyles();

  return new Promise<boolean>((resolve) => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const overlay = document.createElement('div');
    overlay.className = 'ds-web-shell-overlay ds-web-shell-overlay--modal';
    overlay.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className = 'ds-web-shell-card';
    dialog.setAttribute('role', options.cancelText !== undefined ? 'alertdialog' : 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    const titleId = `ds-web-dialog-title-${Date.now()}`;
    const descId = `ds-web-dialog-desc-${Date.now()}`;
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.setAttribute('aria-describedby', descId);

    const titleEl = document.createElement('h2');
    titleEl.id = titleId;
    titleEl.className = 'ds-web-shell-title';
    titleEl.textContent = options.title?.trim() || (options.cancelText !== undefined ? '请确认操作' : '提示');

    const messageEl = document.createElement('p');
    messageEl.id = descId;
    messageEl.className = 'ds-web-shell-subtitle';
    messageEl.textContent = options.message;

    const divider = document.createElement('hr');
    divider.className = 'ds-web-shell-divider';

    const actions = document.createElement('div');
    actions.className = 'ds-web-shell-actions';

    let cancelBtn: HTMLButtonElement | null = null;
    if (options.cancelText !== undefined) {
      cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'ds-web-shell-btn ds-web-shell-btn--secondary';
      cancelBtn.textContent = options.cancelText || '取消';
      actions.appendChild(cancelBtn);
    }

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = options.danger
      ? 'ds-web-shell-btn ds-web-shell-btn--danger'
      : 'ds-web-shell-btn';
    confirmBtn.textContent = options.confirmText || (options.cancelText !== undefined ? '确定' : '知道了');
    actions.appendChild(confirmBtn);

    dialog.append(titleEl, divider, messageEl, actions);
    overlay.appendChild(dialog);

    let settled = false;
    const close = (result: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      previousFocus?.focus?.();
      resolve(result);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(options.cancelText !== undefined ? false : true);
      } else if (event.key === 'Tab') {
        const focusables = cancelBtn ? [cancelBtn, confirmBtn] : [confirmBtn];
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    confirmBtn.addEventListener('click', () => close(true));
    cancelBtn?.addEventListener('click', () => close(false));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        close(options.cancelText !== undefined ? false : true);
      }
    });

    window.addEventListener('keydown', onKeyDown, true);
    document.body.appendChild(overlay);
    confirmBtn.focus();
  });
}

export async function ensureAuthenticated(): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof fetch !== 'function') {
    return;
  }

  try {
    const check = await fetch('/api/health', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (check.status !== 401) {
      return;
    }
  } catch {
    return;
  }

  ensureWebShellStyles();

  await new Promise<void>((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ds-web-shell-overlay';

    const form = document.createElement('form');
    form.id = 'ds-web-token-form';
    form.className = 'ds-web-shell-card';

    const statusRow = document.createElement('div');
    statusRow.className = 'ds-web-shell-status';
    const dot = document.createElement('span');
    dot.className = 'ds-web-shell-dot';
    dot.setAttribute('aria-hidden', 'true');
    const statusLabel = document.createElement('span');
    statusLabel.textContent = 'Deep Student WebUI';
    statusRow.append(dot, statusLabel);

    const divider = document.createElement('hr');
    divider.className = 'ds-web-shell-divider';

    const title = document.createElement('h1');
    title.className = 'ds-web-shell-title';
    title.textContent = 'Deep Student 网页工作台';

    const subtitle = document.createElement('p');
    subtitle.className = 'ds-web-shell-subtitle';
    subtitle.textContent = '输入服务端终端输出的访问令牌以连接宿主服务';

    const label = document.createElement('label');
    label.htmlFor = 'ds-web-token-input';
    label.className = 'ds-web-shell-label';
    label.textContent = '访问令牌';

    const input = document.createElement('input');
    input.id = 'ds-web-token-input';
    input.name = 'token';
    input.type = 'password';
    input.required = true;
    input.autocomplete = 'current-password';
    input.placeholder = '访问令牌';
    input.className = 'ds-web-shell-input';

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'ds-web-shell-btn';
    submitBtn.style.marginTop = '14px';
    submitBtn.textContent = '验证并进入';

    const errorEl = document.createElement('div');
    errorEl.id = 'ds-web-token-error';
    errorEl.className = 'ds-web-shell-error';
    errorEl.setAttribute('role', 'alert');
    errorEl.setAttribute('aria-live', 'polite');

    form.append(statusRow, divider, title, subtitle, label, input, submitBtn, errorEl);
    overlay.appendChild(form);
    document.body.appendChild(overlay);
    input.focus();

    let submitting = false;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (submitting) return;
      const tokenValue = input.value.trim();
      if (!tokenValue) {
        errorEl.textContent = '访问令牌无效，请核对后重试';
        input.focus();
        return;
      }

      submitting = true;
      input.disabled = true;
      submitBtn.disabled = true;
      submitBtn.textContent = '正在验证…';
      errorEl.textContent = '';

      void fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenValue }),
        credentials: 'same-origin',
      })
        .then((res) => {
          if (res.ok) {
            overlay.remove();
            resolve();
            return;
          }
          errorEl.textContent = '访问令牌无效，请核对后重试';
        })
        .catch(() => {
          errorEl.textContent = '网络连接失败，请重试';
        })
        .finally(() => {
          if (overlay.isConnected) {
            submitting = false;
            input.disabled = false;
            submitBtn.disabled = false;
            submitBtn.textContent = '验证并进入';
            input.focus();
          }
        });
    });
  });
}

export function stripUrlAuthToken(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('token')) return;
    url.searchParams.delete('token');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch (error) {
    void error;
  }
}

async function stageBrowserFile(file: File): Promise<string> {
  const response = await fetch(`/api/files/stage?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
    },
    body: file,
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to stage file "${file.name}" (${response.status}): ${text}`);
  }
  const data = (await response.json()) as { path: string };
  return data.path;
}

async function pickBrowserFiles(options: {
  multiple?: boolean;
  directory?: boolean;
  filters?: Array<{ name?: string; extensions?: string[] }>;
}): Promise<string | string[] | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.opacity = '0';
    if (options.multiple) input.multiple = true;
    if (options.directory) {
      (input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true;
    }
    if (Array.isArray(options.filters) && !options.directory) {
      const exts = options.filters
        .flatMap((f) => (Array.isArray(f.extensions) ? f.extensions : []))
        .filter((ext) => ext !== '' && ext !== '*')
        .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));
      if (exts.length > 0) input.accept = exts.join(',');
    }

    let settled = false;
    const finish = (value: string | string[] | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener('cancel', () => finish(null));
    input.addEventListener('change', () => {
      const selected = Array.from(input.files ?? []);
      if (selected.length === 0) {
        finish(null);
        return;
      }
      void Promise.all(selected.map(stageBrowserFile)).then(
        (paths) => finish(options.multiple ? paths : (paths[0] ?? null)),
        (error: unknown) => {
          if (settled) return;
          settled = true;
          input.remove();
          reject(error);
        },
      );
    });

    document.body.appendChild(input);
    input.click();
  });
}

function triggerExportDownload(exportId: string, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = `/api/files/export?exportId=${encodeURIComponent(exportId)}`;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** PWA「暂不」后不再打扰（永久记住）；`?pwaPrompt=1` 可强制重新显示。 */
const PWA_PROMPT_DISMISSED_KEY = 'ds_pwa_prompt_dismissed';

interface LaunchQueueFileHandle {
  getFile: () => Promise<File>;
  name?: string;
}

interface LaunchQueueWindow {
  launchQueue?: {
    setConsumer?: (
      consumer: (params: { files?: LaunchQueueFileHandle[] }) => void,
    ) => void;
  };
}

function isStandaloneDisplay(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
  } catch (error) {
    void error;
    return false;
  }
}

function isPwaPromptDismissed(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get('pwaPrompt') === '1') return false;
    return window.localStorage.getItem(PWA_PROMPT_DISMISSED_KEY) === '1';
  } catch (error) {
    void error;
    return false;
  }
}

function markPwaPromptDismissed(): void {
  try {
    window.localStorage.setItem(PWA_PROMPT_DISMISSED_KEY, '1');
  } catch (error) {
    void error;
  }
}

/**
 * PWA 支持：安装入口、文件关联启动（`launchQueue`）、Service Worker 注册与更新提示。
 *
 * `beforeinstallprompt` 仍然 `preventDefault()`（否则 Chrome 的迷你信息条不可控），
 * 但**必须**同时给出自己的入口，否则这个事件被吞掉、用户再也装不了：
 * 右下角出现一个可关闭的 `[安装到桌面] [暂不]` 胶囊，关闭后写入 localStorage 永久消失。
 */
export function installPwaSupport(options: { onFilesOpened?: (paths: string[]) => void } = {}): void {
  let deferredPrompt: BeforeInstallPromptEvent | null = null;

  const promptInstall = async (): Promise<boolean> => {
    if (!deferredPrompt) return false;
    const promptEvent = deferredPrompt;
    deferredPrompt = null;
    hidePwaInstallOption();
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    return choice.outcome === 'accepted';
  };

  window.__DS_PWA__ = Object.freeze({
    canInstall: () => deferredPrompt !== null,
    promptInstall,
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    if (isStandaloneDisplay() || isPwaPromptDismissed()) return;
    showPwaInstallOption(
      () => {
        void promptInstall();
      },
      () => {
        markPwaPromptDismissed();
      },
    );
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hidePwaInstallOption();
  });

  // 文件关联启动：在系统里双击 .pdf / .md / .apkg 时由 manifest 的 file_handlers 唤起，
  // 交给与 HTML5 拖放相同的暂存管线，再发 `tauri://drag-drop` 走导入流程。
  const launchQueueWindow = window as unknown as LaunchQueueWindow;
  if (launchQueueWindow.launchQueue && typeof launchQueueWindow.launchQueue.setConsumer === 'function') {
    launchQueueWindow.launchQueue.setConsumer((params) => {
      const handles = params.files ?? [];
      if (handles.length === 0) return;
      void (async () => {
        const paths: string[] = [];
        for (const handle of handles) {
          try {
            const file = await handle.getFile();
            paths.push(await stageBrowserFile(file));
          } catch (error) {
            console.warn('[WebUI] Failed to stage launched file:', error);
          }
        }
        if (paths.length > 0) options.onFilesOpened?.(paths);
      })();
    });
  }

  const metaEnv = (import.meta as ImportMeta & { env?: { PROD?: boolean } }).env;
  const enableSw = Boolean(metaEnv?.PROD) || new URLSearchParams(window.location.search).get('pwa') === '1';
  if (!enableSw || !('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        let reloadRequested = false;
        let reloaded = false;
        const reloadOnce = () => {
          if (reloaded) return;
          reloaded = true;
          window.location.reload();
        };

        const offerUpdate = (worker: ServiceWorker | null) => {
          if (!worker || !navigator.serviceWorker.controller) return;
          showSwUpdateAvailable(() => {
            if (reloadRequested || reloaded) return;
            reloadRequested = true;
            // 另一标签页可能已启用该版本，此时不会再有 controllerchange。
            const next = registration.waiting ?? worker;
            if (next.state === 'activated' || next === navigator.serviceWorker.controller) {
              reloadOnce();
            } else {
              next.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        };

        // 首次安装时 controllerchange 也会触发，只有用户点了「刷新启用」才重载
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!reloadRequested) return;
          reloadOnce();
        });

        offerUpdate(registration.waiting);
        const observeInstalling = () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              offerUpdate(registration.waiting ?? installing);
            }
          });
        };
        // register() 返回时更新可能已经开始；首次安装未受控也须保留后续监听。
        observeInstalling();
        registration.addEventListener('updatefound', observeInstalling);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            void registration.update().catch(() => undefined);
          }
        });
      })
      .catch((err) => {
        console.warn('[WebUI] Service worker registration skipped:', err);
      });
  });
}

export interface BootstrappedWebClient {
  readonly connected: Promise<void>;
}

export function bootstrapWebClient(): BootstrappedWebClient {
  stripUrlAuthToken();

  const params = new URLSearchParams(window.location.search);
  const explicitShell = params.get('shell');
  const clientOs = detectClientOs();
  const shellKind: 'mobile' | 'desktop' =
    explicitShell === 'mobile'
      ? 'mobile'
      : explicitShell === 'desktop'
        ? 'desktop'
        : clientOs === 'ios' || clientOs === 'android'
          ? 'mobile'
          : 'desktop';

  Object.defineProperty(window, '__DS_PLATFORM__', {
    value: Object.freeze({ kind: shellKind, os: clientOs }),
    configurable: false,
    enumerable: false,
    writable: false,
  });

  // `src/` 判断「是否运行在 WebUI」只能读这个全局标记（src/ 禁止 import web/）。
  // WebUI 里 iOS Safari / Android Chrome 同样拿到 HTTP 206 的 pdfstream / filestream。
  if ((globalThis as { __DS_WEBUI__?: unknown }).__DS_WEBUI__ !== true) {
    Object.defineProperty(window, '__DS_WEBUI__', {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }

  const bridgeSubscribers = new Set<(message: MainToRenderer) => void>();
  const emitToBridge = (message: MainToRenderer) => {
    for (const sub of bridgeSubscribers) sub(message);
  };

  const pendingSavesByPath = new Map<string, { exportId: string; fileName: string }>();
  const openRidToPath = new Map<number, string>();
  const pendingOpenCallbacks = new Map<number, string>();

  // Track active JS listeners so WebSocket reconnects re-register seamlessly
  const activeListeners = new Map<number, ActiveListenerRecord>();
  const serverEventToClient = new Map<number, number>();
  const replayedListeners = new Map<number, ActiveListenerRecord>();
  const pendingListenCallbacks = new Map<number, number>();
  // Never reuse a renderer ID, even if a restarted server reuses its own IDs.
  let nextClientEventId = 0;
  const allocateClientEventId = (serverId: number): number => {
    const id = Math.max(nextClientEventId, serverId);
    nextClientEventId = id + 1;
    return id;
  };

  const toWsPayload = (frame: string | Uint8Array): string | ArrayBuffer =>
    typeof frame === 'string'
      ? frame
      : (frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer);

  /** 已发出、尚未收到结果的 invoke：断线时逐个以错误结束，避免 `await invoke(...)` 永久挂起。 */
  interface InFlightInvoke {
    callback: number;
    error: number;
    cmd: string;
    /** 实际发出这一帧的 socket（排队中的帧还没有归属）。 */
    socket?: WebSocket;
  }
  const inFlightInvokes = new Map<number, InFlightInvoke>();

  /** 合并后的只读请求：一个主帧 + 若干等结果的调用方。 */
  interface ReadWaiter {
    callback: number;
    error: number;
  }
  interface InFlightRead {
    /** 代次 + 命令 + 参数：写入后同一命令必须重新发帧，不能挂到写入前的旧主帧上。 */
    genKey: string;
    cacheKey: string;
    callback: number;
    error: number;
    waiters: ReadWaiter[];
    /** 发出时的缓存代次：写入型调用会让代次 +1，旧代次的滞留结果不再写回缓存。 */
    generation: number;
    socket?: WebSocket;
  }
  const inflightReads = new Map<string, InFlightRead>();
  const inflightReadByCallback = new Map<number, string>();
  const readCache = new Map<string, { body: ResponseBody; expiresAt: number }>();
  let readCacheGeneration = 0;
  const pendingReadCacheWrites = new Set<number>();

  /** 让所有「写入前发出、写入后才回来」的读结果失效，避免它们污染写后缓存。 */
  const invalidateReadCache = (): void => {
    if (readCache.size > 0) readCache.clear();
    readCacheGeneration += 1;
  };

  // 异步写入期间仍可能读到旧快照。写入结束再换代，既清掉这种缓存，
  // 也阻止写后读取合并到尚未返回的旧快照；断线的本地错误同样清理记录。
  // 在安装桥之前注册，确保应用的写入回调触发下一次读时已经失效。
  bridgeSubscribers.add((message) => {
    if (message.type !== 'result' || !pendingReadCacheWrites.has(message.callbackId)) return;
    pendingReadCacheWrites.delete(message.callbackId);
    pendingReadCacheWrites.delete(message.otherId);
    invalidateReadCache();
  });

  let ws: WebSocket | null = null;
  let wsOpen = false;
  let hasEverOpened = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let authProbeInFlight = false;
  // 首次登录闸门未完成前不允许任何 online/visibility 事件提前开 socket：
  // 服务端会 401 拒升级，而 socket error 会把离线闸门盖在令牌表单上。
  let authenticationReady = false;
  const outboundQueue: Array<{
    payload: string | ArrayBuffer;
    invoke?: InFlightInvoke;
    read?: InFlightRead;
  }> = [];
  let resolveInitialConnect!: () => void;
  const connected = new Promise<void>((resolve) => {
    resolveInitialConnect = resolve;
  });

  const sendRawToServer = (frame: string | Uint8Array, invoke?: InFlightInvoke, read?: InFlightRead) => {
    const payload = toWsPayload(frame);
    if (ws && wsOpen && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
      if (invoke) inFlightInvokes.set(invoke.callback, { ...invoke, socket: ws });
      if (read) read.socket = ws;
    } else {
      outboundQueue.push({ payload, invoke, read });
    }
  };

  const emitInvokeError = (entry: { callback: number; error: number }, message: string) => {
    emitToBridge({
      type: 'result',
      callbackId: entry.error,
      otherId: entry.callback,
      body: encodeJsonBody(message),
    });
  };

  /**
   * 连接断了：把这条连接上所有还在等结果的 invoke 立刻判失败。
   *
   * 这是「UI 永久转圈」的根因修复：过去 socket 断开后已发出的帧不会再有任何
   * result，`await invoke('chat_v2_list_sessions')` 之类的 Promise 永远不 settle。
   * 合并请求的排队方（waiters）也要一起失败，否则它们等的是一个已死的主帧。
   *
   * 只处理 `socket` 上发出的帧：旧 socket 的迟到 close 不能误杀新连接的在途请求。
   */
  const rejectPendingInvokes = (reason: string, socket: WebSocket): void => {
    const settled = new Set<number>();
    const fail = (entry: { callback: number; error: number }) => {
      if (settled.has(entry.callback) || settled.has(entry.error)) return;
      settled.add(entry.callback);
      settled.add(entry.error);
      emitInvokeError(entry, reason);
    };
    for (const [callback, entry] of inFlightInvokes) {
      if (entry.socket !== socket) continue;
      const handler = pendingListenCallbacks.get(callback);
      pendingListenCallbacks.delete(callback);
      if (handler !== undefined) {
        // listen-js can arrive before its result. A failed listen has no unlisten
        // closure in the renderer, so do not resurrect it on the next connection.
        for (const [id, rec] of activeListeners) {
          if (rec.handlerId === handler) activeListeners.delete(id);
        }
      }
      fail(entry);
      inFlightInvokes.delete(callback);
    }
    for (const [genKey, read] of inflightReads) {
      if (read.socket !== socket) continue;
      for (const waiter of read.waiters) fail(waiter);
      inflightReads.delete(genKey);
      inflightReadByCallback.delete(read.callback);
      inflightReadByCallback.delete(read.error);
    }
    invalidateReadCache();
  };

  /**
   * 主帧结果到达：存短 TTL 缓存，并把同一份结果分发给所有排队方。
   * 失败也照样分发（失败的调用方不能各自再打一次 WS）。
   */
  const settleCoalescedRead = (decoded: Extract<MainToRenderer, { type: 'result' }>): void => {
    const genKey = inflightReadByCallback.get(decoded.callbackId);
    if (genKey === undefined) return;
    const entry = inflightReads.get(genKey);
    if (!entry) return;
    inflightReadByCallback.delete(entry.callback);
    inflightReadByCallback.delete(entry.error);
    inflightReads.delete(genKey);
    const ok = decoded.callbackId === entry.callback;
    if (ok && entry.generation === readCacheGeneration) {
      for (const [key, cached] of readCache) {
        if (cached.expiresAt <= Date.now()) readCache.delete(key);
      }
      const cmd = entry.cacheKey.slice(0, entry.cacheKey.indexOf('::'));
      readCache.set(entry.cacheKey, { body: decoded.body, expiresAt: Date.now() + readCacheTtlMs(cmd) });
    }
    for (const waiter of entry.waiters) {
      queueMicrotask(() => {
        emitToBridge({
          type: 'result',
          callbackId: ok ? waiter.callback : waiter.error,
          otherId: ok ? waiter.error : waiter.callback,
          body: decoded.body,
        });
      });
    }
  };

  const isBrowserOffline = (): boolean => {
    if (typeof window !== 'undefined' && window.navigator) return window.navigator.onLine === false;
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  };

  const probeAuthAfterDisconnect = async (): Promise<void> => {
    if (authProbeInFlight || isBrowserOffline()) return;
    authProbeInFlight = true;
    try {
      const res = await fetch('/api/health', { credentials: 'same-origin', cache: 'no-store' });
      if (res.status === 401 && !wsOpen) {
        // 服务端令牌过期 / 轮换：重走登录闸门，而不是无限退避重连
        // The offline gate sits above the token form; leave login reachable.
        hideOfflineBootOverlay();
        authenticationReady = false;
        await ensureAuthenticated();
        authenticationReady = true;
        triggerImmediateReconnect();
      }
    } catch (error) {
      void error;
      // 真的离线：等 online 事件或下一轮退避
    } finally {
      authProbeInFlight = false;
    }
  };

  function triggerImmediateReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    connectWebSocket();
  }

  const scheduleReconnect = () => {
    if (isBrowserOffline()) {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempt = Math.max(1, reconnectAttempt);
      if (hasEverOpened) showOfflineWaiting(triggerImmediateReconnect);
      else if (!authProbeInFlight) showOfflineBootOverlay(triggerImmediateReconnect);
      return;
    }
    if (reconnectTimer !== null) return;
    // 指数退避 + ±15% 抖动：多标签页同时断线时不要一起砸服务器
    const delay = Math.min(
      10_000,
      Math.round(500 * Math.pow(1.8, reconnectAttempt) * (0.85 + Math.random() * 0.3)),
    );
    reconnectAttempt += 1;
    // 首连失败由全屏离线闸门负责提示，不再叠加顶部胶囊
    if (hasEverOpened) showReconnecting(reconnectAttempt, delay, triggerImmediateReconnect);
    if (reconnectAttempt >= 2) void probeAuthAfterDisconnect();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, delay);
  };

  const connectWebSocket = () => {
    if (!authenticationReady) return;
    // 已有连接或正在握手：不再叠加第二个 socket
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${proto}//${window.location.host}/api/ws`);
    socket.binaryType = 'arraybuffer';
    ws = socket;

    socket.addEventListener('open', () => {
      wsOpen = true;
      const recovered = reconnectAttempt > 0;
      hasEverOpened = true;
      reconnectAttempt = 0;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (recovered) showReconnected();
      hideOfflineBootOverlay();
      resolveInitialConnect();
      // Re-subscribe any listeners registered prior to reconnect.
      // callback/error 必须是每次重发唯一的 id，否则多标签页会在服务端 callbackOwner
      // 里争夺同一个 key，某个 Tab 关闭时误删其他 Tab 的回调映射。
      for (const rec of activeListeners.values()) {
        replayedListeners.set(rec.handlerId, rec);
        socket.send(
          toWsPayload(
            encodeRendererMessage(
              buildReconnectListenMessage({
                event: rec.event,
                target: rec.target,
                handlerId: rec.handlerId,
              }),
            ),
          ),
        );
      }
      // Restore progress subscriptions before a queued command can emit events.
      while (outboundQueue.length > 0) {
        const next = outboundQueue.shift()!;
        socket.send(next.payload);
        if (next.invoke) inFlightInvokes.set(next.invoke.callback, { ...next.invoke, socket });
        if (next.read) next.read.socket = socket;
      }
    });

    socket.addEventListener('message', (event) => {
      const rawData =
        typeof event.data === 'string'
          ? event.data
          : new Uint8Array(event.data as ArrayBuffer);
      let decoded: MainToRenderer;
      try {
        decoded = decodeMainMessage(rawData);
      } catch (error) {
        console.warn('[WebUI] Failed to decode server message:', error);
        return;
      }

      if (decoded.type === 'listen-js') {
        const replayed = replayedListeners.get(decoded.handlerId);
        replayedListeners.delete(decoded.handlerId);
        if (replayed && !activeListeners.has(replayed.clientEventId)) {
          // The component unmounted while its reconnect subscription was in flight.
          sendRawToServer(encodeRendererMessage({
            type: 'invoke', cmd: 'plugin:event|unlisten',
            callback: nextReconnectCallbackId(), error: nextReconnectCallbackId(), headers: {},
            payload: { contentType: 'application/json', data: JSON.stringify({
              event: decoded.event, eventId: decoded.eventId,
            }) },
          }));
          return;
        }
        const rec: ActiveListenerRecord = replayed ?? {
          event: decoded.event, target: decoded.target, handlerId: decoded.handlerId,
          clientEventId: allocateClientEventId(decoded.eventId),
        };
        rec.serverEventId = decoded.eventId;
        activeListeners.set(rec.clientEventId, rec);
        serverEventToClient.set(decoded.eventId, rec.clientEventId);
        // Keep the ID captured by Tauri's unlisten closure stable across reconnects.
        decoded = { ...decoded, eventId: rec.clientEventId };
      } else if (decoded.type === 'emit-js') {
        decoded = { ...decoded, ids: decoded.ids.flatMap((id) => {
          const clientId = serverEventToClient.get(id);
          return clientId === undefined ? [] : [clientId];
        }) };
      } else if (decoded.type === 'result') {
        const invocation = inFlightInvokes.get(decoded.callbackId) ?? inFlightInvokes.get(decoded.otherId);
        if (invocation && decoded.callbackId === invocation.callback &&
            !COALESCED_READ_CMDS.has(invocation.cmd) && !isReadCacheExempt(invocation.cmd)) {
          invalidateReadCache();
        }
        const listenHandler = pendingListenCallbacks.get(decoded.callbackId);
        pendingListenCallbacks.delete(decoded.callbackId);
        pendingListenCallbacks.delete(decoded.otherId);
        if (listenHandler !== undefined) {
          const rec = [...activeListeners.values()].find((entry) => entry.handlerId === listenHandler);
          if (rec) decoded = { ...decoded, body: encodeJsonBody(rec.clientEventId) };
        }
        // 结果已到，两端的 callback / error id 都不再是「在途」
        inFlightInvokes.delete(decoded.callbackId);
        inFlightInvokes.delete(decoded.otherId);
        settleCoalescedRead(decoded);

        const openedPath = pendingOpenCallbacks.get(decoded.callbackId);
        if (openedPath !== undefined) {
          pendingOpenCallbacks.delete(decoded.callbackId);
          if (decoded.body.kind === 'json') {
            const rid = JSON.parse(decoded.body.data) as unknown;
            if (typeof rid === 'number') openRidToPath.set(rid, openedPath);
          }
        } else {
          pendingOpenCallbacks.delete(decoded.otherId);
        }
      }

      emitToBridge(decoded);
    });

    socket.addEventListener('close', () => {
      // 旧 socket 的迟到 close：只清掉它自己的在途帧，新连接不受影响
      if (ws !== socket) {
        rejectPendingInvokes('WebSocket 连接已断开，请重试', socket);
        return;
      }
      wsOpen = false;
      ws = null;
      serverEventToClient.clear();
      replayedListeners.clear();
      for (const rec of activeListeners.values()) rec.serverEventId = undefined;
      rejectPendingInvokes('WebSocket 连接已断开，请重试', socket);
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      if (ws !== socket) return;
      // 首连就失败：交给全屏离线闸门，等 socket 真正 open 再放行，
      // 而不是让 main.tsx 的 startup_preflight 苦等 135 秒后误报数据库恢复。
      if (!hasEverOpened && !authProbeInFlight) showOfflineBootOverlay(triggerImmediateReconnect);
    });
  };

  const replyLocal = (msg: InvokeMessage, ok: boolean, value: unknown) => {
    emitToBridge({
      type: 'result',
      callbackId: ok ? msg.callback : msg.error,
      otherId: ok ? msg.error : msg.callback,
      body: encodeJsonBody(value),
    });
  };

  const parseJsonArgs = (msg: InvokeMessage): Record<string, unknown> => {
    if (msg.payload.contentType !== 'application/json') return {};
    try {
      const parsed = JSON.parse(msg.payload.data) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch (error) {
      void error;
      return {};
    }
  };

  const maybeTriggerSavedExport = (writtenPath: string | null) => {
    if (!writtenPath) return;
    const pending = pendingSavesByPath.get(writtenPath);
    if (!pending) return;
    pendingSavesByPath.delete(writtenPath);
    triggerExportDownload(pending.exportId, pending.fileName);
  };

  const handleBrowserLocalPlugin = (msg: InvokeMessage): boolean => {
    const { cmd } = msg;

    if (cmd.startsWith('plugin:window|') || cmd.startsWith('plugin:webview|')) {
      const sub = cmd.split('|')[1] ?? '';
      const dpr = window.devicePixelRatio || 1;
      const physSize = {
        width: Math.round(window.innerWidth * dpr),
        height: Math.round(window.innerHeight * dpr),
      };
      const args = parseJsonArgs(msg);
      switch (sub) {
        case 'inner_size':
        case 'outer_size':
          replyLocal(msg, true, physSize);
          return true;
        case 'inner_position':
        case 'outer_position':
          replyLocal(msg, true, { x: 0, y: 0 });
          return true;
        case 'scale_factor':
          replyLocal(msg, true, dpr);
          return true;
        case 'is_focused':
          replyLocal(msg, true, document.hasFocus());
          return true;
        case 'is_visible':
          replyLocal(msg, true, document.visibilityState === 'visible');
          return true;
        case 'is_minimized':
          replyLocal(msg, true, document.visibilityState === 'hidden');
          return true;
        case 'is_maximized':
          replyLocal(msg, true, true);
          return true;
        case 'is_fullscreen':
          replyLocal(msg, true, Boolean(document.fullscreenElement));
          return true;
        case 'is_decorated':
        case 'is_resizable':
        case 'is_maximizable':
        case 'is_minimizable':
        case 'is_closable':
          replyLocal(msg, true, false);
          return true;
        case 'theme':
          replyLocal(
            msg,
            true,
            document.documentElement.classList.contains('dark') ? 'dark' : 'light',
          );
          return true;
        case 'title':
          replyLocal(msg, true, document.title);
          return true;
        case 'set_title':
          if (typeof args.value === 'string') document.title = args.value;
          replyLocal(msg, true, null);
          return true;
        case 'set_fullscreen':
          if (args.value === true) {
            void document.documentElement.requestFullscreen?.().catch(() => undefined);
          } else if (document.fullscreenElement) {
            void document.exitFullscreen?.().catch(() => undefined);
          }
          replyLocal(msg, true, null);
          return true;
        case 'current_monitor':
        case 'primary_monitor': {
          const monitor = {
            name: 'Browser Viewport',
            size: physSize,
            position: { x: 0, y: 0 },
            workArea: { position: { x: 0, y: 0 }, size: physSize },
            scaleFactor: dpr,
          };
          replyLocal(msg, true, monitor);
          return true;
        }
        case 'available_monitors':
          replyLocal(msg, true, [
            {
              name: 'Browser Viewport',
              size: physSize,
              position: { x: 0, y: 0 },
              workArea: { position: { x: 0, y: 0 }, size: physSize },
              scaleFactor: dpr,
            },
          ]);
          return true;
        default:
          replyLocal(msg, true, null);
          return true;
      }
    }

    if (cmd.startsWith('plugin:dialog|')) {
      const sub = cmd.slice('plugin:dialog|'.length);
      const args = parseJsonArgs(msg);
      const opts = (args.options && typeof args.options === 'object' ? args.options : {}) as Record<string, unknown>;
      if (sub === 'open') {
        void pickBrowserFiles({
          multiple: opts.multiple === true,
          directory: opts.directory === true,
          filters: Array.isArray(opts.filters) ? (opts.filters as Array<{ name?: string; extensions?: string[] }>) : undefined,
        }).then(
          (selected) => replyLocal(msg, true, selected),
          (err: unknown) => replyLocal(msg, false, err instanceof Error ? err.message : String(err)),
        );
        return true;
      }
      if (sub === 'save') {
        void fetch('/api/files/prepare-save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultPath: opts.defaultPath }),
          credentials: 'same-origin',
        })
          .then(async (res) => {
            if (!res.ok) throw new Error(await res.text());
            return (await res.json()) as { path: string; exportId: string; fileName: string };
          })
          .then(
            (prepared) => {
              pendingSavesByPath.set(prepared.path, {
                exportId: prepared.exportId,
                fileName: prepared.fileName,
              });
              replyLocal(msg, true, prepared.path);
            },
            (err: unknown) => replyLocal(msg, false, err instanceof Error ? err.message : String(err)),
          );
        return true;
      }
      if (sub === 'ask' || sub === 'confirm') {
        const text = typeof args.message === 'string' ? args.message : '';
        const rawTitle = typeof args.title === 'string' ? args.title : typeof opts.title === 'string' ? opts.title : '';
        const rawKind = typeof args.kind === 'string' ? args.kind : typeof opts.kind === 'string' ? opts.kind : '';
        const rawConfirm =
          typeof args.okButtonLabel === 'string'
            ? args.okButtonLabel
            : typeof args.yesButtonLabel === 'string'
              ? args.yesButtonLabel
              : typeof opts.okLabel === 'string'
                ? opts.okLabel
                : '确定';
        const rawCancel =
          typeof args.cancelButtonLabel === 'string'
            ? args.cancelButtonLabel
            : typeof args.noButtonLabel === 'string'
              ? args.noButtonLabel
              : typeof opts.cancelLabel === 'string'
                ? opts.cancelLabel
                : '取消';
        void showWebShellDialog({
          title: rawTitle || '请确认操作',
          message: text,
          confirmText: rawConfirm,
          cancelText: rawCancel,
          danger: rawKind === 'warning' || rawKind === 'error',
        }).then((confirmed) => {
          replyLocal(msg, true, confirmed);
        });
        return true;
      }
      if (sub === 'message') {
        const text = typeof args.message === 'string' ? args.message : '';
        const rawTitle = typeof args.title === 'string' ? args.title : typeof opts.title === 'string' ? opts.title : '';
        const rawConfirm =
          typeof args.okButtonLabel === 'string'
            ? args.okButtonLabel
            : typeof opts.okLabel === 'string'
              ? opts.okLabel
              : '知道了';
        void showWebShellDialog({
          title: rawTitle || '提示',
          message: text,
          confirmText: rawConfirm,
        }).then(() => {
          replyLocal(msg, true, 'Ok');
        });
        return true;
      }
    }

    if (cmd.startsWith('plugin:clipboard-manager|')) {
      const sub = cmd.slice('plugin:clipboard-manager|'.length);
      const args = parseJsonArgs(msg);
      if (sub === 'write_text') {
        const text = typeof args.text === 'string' ? args.text : '';
        void navigator.clipboard.writeText(text).then(
          () => replyLocal(msg, true, null),
          (err: unknown) => replyLocal(msg, false, err instanceof Error ? err.message : String(err)),
        );
        return true;
      }
      if (sub === 'read_text') {
        void navigator.clipboard.readText().then(
          (text) => replyLocal(msg, true, text),
          (err: unknown) => replyLocal(msg, false, err instanceof Error ? err.message : String(err)),
        );
        return true;
      }
      if (sub === 'clear') {
        void navigator.clipboard.writeText('').then(
          () => replyLocal(msg, true, null),
          () => replyLocal(msg, true, null),
        );
        return true;
      }
    }

    if (cmd.startsWith('plugin:opener|')) {
      const sub = cmd.slice('plugin:opener|'.length);
      const args = parseJsonArgs(msg);
      if (sub === 'open_url') {
        const targetUrl = typeof args.url === 'string' ? args.url : '';
        if (/^(https?:|mailto:)/i.test(targetUrl)) {
          window.open(targetUrl, '_blank', 'noopener,noreferrer');
          replyLocal(msg, true, null);
        } else {
          replyLocal(msg, false, `Not allowed to open url ${targetUrl}`);
        }
        return true;
      }
      if (sub === 'open_path' || sub === 'reveal_item_in_dir') {
        replyLocal(msg, true, null);
        return true;
      }
    }

    return false;
  };

  const watchSaveSideEffects = (msg: InvokeMessage) => {
    if (msg.cmd === 'plugin:fs|write_file' || msg.cmd === 'plugin:fs|write_text_file') {
      const headerPath = msg.headers.path ? decodeURIComponent(msg.headers.path) : null;
      if (headerPath && pendingSavesByPath.has(headerPath)) {
        const origCb = msg.callback;
        const watcher = (incoming: MainToRenderer) => {
          if (incoming.type === 'result' && (incoming.callbackId === origCb || incoming.otherId === origCb)) {
            bridgeSubscribers.delete(watcher);
            if (incoming.callbackId === origCb) maybeTriggerSavedExport(headerPath);
          }
        };
        bridgeSubscribers.add(watcher);
      }
      return;
    }
    if (msg.cmd === 'save_text_to_file' || msg.cmd === 'copy_file') {
      const args = parseJsonArgs(msg);
      const targetPath =
        typeof args.path === 'string'
          ? args.path
          : typeof args.destPath === 'string'
            ? args.destPath
            : null;
      if (targetPath && pendingSavesByPath.has(targetPath)) {
        const origCb = msg.callback;
        const watcher = (incoming: MainToRenderer) => {
          if (incoming.type === 'result' && (incoming.callbackId === origCb || incoming.otherId === origCb)) {
            bridgeSubscribers.delete(watcher);
            if (incoming.callbackId === origCb) maybeTriggerSavedExport(targetPath);
          }
        };
        bridgeSubscribers.add(watcher);
      }
      return;
    }
    if (msg.cmd === 'plugin:fs|open') {
      const args = parseJsonArgs(msg);
      if (typeof args.path === 'string' && pendingSavesByPath.has(args.path)) {
        pendingOpenCallbacks.set(msg.callback, args.path);
      }
      return;
    }
    if (msg.cmd === 'plugin:resources|close') {
      const args = parseJsonArgs(msg);
      if (typeof args.rid === 'number') {
        const trackedPath = openRidToPath.get(args.rid);
        if (trackedPath) {
          openRidToPath.delete(args.rid);
          const origCb = msg.callback;
          const watcher = (incoming: MainToRenderer) => {
            if (incoming.type === 'result' && (incoming.callbackId === origCb || incoming.otherId === origCb)) {
              bridgeSubscribers.delete(watcher);
              if (incoming.callbackId === origCb) maybeTriggerSavedExport(trackedPath);
            }
          };
          bridgeSubscribers.add(watcher);
        }
      }
    }
  };

  const buildReadCacheKey = (msg: InvokeMessage): string =>
    `${msg.cmd}::${msg.payload.contentType === 'application/json' ? msg.payload.data : ''}`;

  /**
   * 短 TTL 读缓存命中 / 并发合并。返回 `handled: true` 表示这一帧不需要再发到服务端。
   *
   * 三条路径：
   * 1. 缓存未过期 → 微任务里直接回一份 result（零 WS 往返）；
   * 2. 同 key 已有主帧在途 → 只登记 waiter，结果到达时统一分发；
   * 3. 都没有 → 登记主帧，由调用方正常发送。
   */
  type CoalescedReadResult = { handled: true } | { handled: false; entry: InFlightRead };

  const serveCoalescedRead = (msg: InvokeMessage): CoalescedReadResult => {
    const cacheKey = buildReadCacheKey(msg);
    const cached = readCache.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        const body = cached.body;
        queueMicrotask(() => {
          emitToBridge({
            type: 'result',
            callbackId: msg.callback,
            otherId: msg.error,
            body,
          });
        });
        return { handled: true };
      }
      readCache.delete(cacheKey);
    }
    const genKey = `${readCacheGeneration}::${cacheKey}`;
    const existing = inflightReads.get(genKey);
    if (existing) {
      existing.waiters.push({ callback: msg.callback, error: msg.error });
      return { handled: true };
    }
    const entry: InFlightRead = {
      genKey,
      cacheKey,
      callback: msg.callback,
      error: msg.error,
      waiters: [],
      generation: readCacheGeneration,
    };
    inflightReads.set(genKey, entry);
    inflightReadByCallback.set(msg.callback, genKey);
    inflightReadByCallback.set(msg.error, genKey);
    return { handled: false, entry };
  };

  const transport: BridgeTransport = {
    send(message: RendererToMain) {
      if (message.type === 'invoke') {
        if (message.cmd === 'plugin:event|listen') {
          const args = parseJsonArgs(message);
          if (typeof args.handler === 'number') pendingListenCallbacks.set(message.callback, args.handler);
        }
        if (message.cmd === 'plugin:event|unlisten') {
          const args = parseJsonArgs(message);
          if (typeof args.eventId === 'number') {
            const rec = activeListeners.get(args.eventId);
            activeListeners.delete(args.eventId);
            if (rec && rec.serverEventId === undefined) {
              // The old socket already lost this subscription. A pending replay, if any,
              // is cleaned up when listen-js arrives with the newly allocated server ID.
              replyLocal(message, true, null);
              return;
            }
            if (rec?.serverEventId !== undefined) {
              serverEventToClient.delete(rec.serverEventId);
              message = { ...message, payload: {
                contentType: 'application/json',
                data: JSON.stringify({ ...args, eventId: rec.serverEventId }),
              } };
            }
          }
        }
        if (handleBrowserLocalPlugin(message)) return;
        watchSaveSideEffects(message);

        const coalesced = COALESCED_READ_CMDS.has(message.cmd);
        if (!coalesced && !isReadCacheExempt(message.cmd)) {
          // 任何可能写库的调用：立刻清空短 TTL 缓存，读写后必须立即可见
          invalidateReadCache();
          pendingReadCacheWrites.add(message.callback);
          pendingReadCacheWrites.add(message.error);
        }
        let readEntry: InFlightRead | undefined;
        if (coalesced) {
          const readResult = serveCoalescedRead(message);
          if (readResult.handled) return;
          readEntry = readResult.entry;
        }

        sendRawToServer(
          encodeRendererMessage(message),
          { callback: message.callback, error: message.error, cmd: message.cmd },
          readEntry,
        );
        return;
      }
      sendRawToServer(encodeRendererMessage(message));
    },
    subscribe(listener: (message: MainToRenderer) => void) {
      bridgeSubscribers.add(listener);
    },
  };

  // Pre-install a Proxy for `__TAURI_INTERNALS__` so `convertFileSrc` resolves over `/api/protocol/<scheme>`
  // without modifying `electron/preload/bridge.ts` (which defines `convertFileSrc` non-configurable).
  const rawInternals: Record<PropertyKey, unknown> = { plugins: {} };
  const proxiedInternals = new Proxy(rawInternals, {
    get(target, prop, receiver) {
      if (prop === 'convertFileSrc') {
        return (filePath: string, protocol = 'asset') => webConvertFileSrc(filePath, protocol);
      }
      return Reflect.get(target, prop, receiver);
    },
    defineProperty(target, prop, descriptor) {
      if (prop === 'convertFileSrc') return true;
      return Reflect.defineProperty(target, prop, descriptor);
    },
  });
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: proxiedInternals,
    configurable: true,
  });

  const init: BridgeInit = {
    osName: clientOs,
    protocolScheme: window.location.protocol === 'https:' ? 'https' : 'http',
    windowLabel: 'main',
    webviewLabel: 'main',
    sep: '/',
    delimiter: ':',
    dragDropEnabled: true,
  };

  installTauriBridge(transport, init, window);

  // Bridge external HTML5 file drops into staged server paths + `tauri://drag-*` events so
  // `UnifiedDragDropZone` works identically to Desktop Tauri/Electron (`onPathsDropped` + `onFilesDropped`).
  const emitLocalTauriDragEvent = (eventName: string, payload: unknown, listenerIds?: number[]) => {
    const ids: number[] = [];
    for (const [id, rec] of activeListeners) {
      if (rec.event === eventName && (!listenerIds || listenerIds.includes(id))) ids.push(id);
    }
    if (ids.length > 0) {
      emitToBridge({
        type: 'emit-js',
        event: eventName,
        payload: JSON.stringify(payload),
        ids,
      });
    }
  };

  const hasDraggedFiles = (e: DragEvent): boolean =>
    Boolean(e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files'));

  window.addEventListener(
    'dragenter',
    (e) => {
      if (!hasDraggedFiles(e)) return;
      const dpr = window.devicePixelRatio || 1;
      emitLocalTauriDragEvent('tauri://drag-enter', {
        paths: [],
        position: { x: e.clientX * dpr, y: e.clientY * dpr },
      });
    },
    true,
  );

  window.addEventListener(
    'dragover',
    (e) => {
      if (!hasDraggedFiles(e)) return;
      const dpr = window.devicePixelRatio || 1;
      emitLocalTauriDragEvent('tauri://drag-over', {
        position: { x: e.clientX * dpr, y: e.clientY * dpr },
      });
    },
    true,
  );

  window.addEventListener(
    'drop',
    (e) => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      // Only intercept for `tauri://drag-drop` when a native drag listener is active on the page
      const dropListenerIds = [...activeListeners.entries()]
        .filter(([, rec]) => rec.event === 'tauri://drag-drop')
        .map(([id]) => id);
      if (dropListenerIds.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const dpr = window.devicePixelRatio || 1;
      const position = { x: e.clientX * dpr, y: e.clientY * dpr };
      void Promise.all(files.map(stageBrowserFile)).then(
        (paths) => {
          // Uploads may take minutes on WAN. Do not import into a view mounted after the drop.
          emitLocalTauriDragEvent('tauri://drag-drop', { paths, position }, dropListenerIds);
        },
        (err) => {
          console.warn('[WebUI] Failed to stage dropped files:', err);
          emitLocalTauriDragEvent('tauri://drag-leave', null);
        },
      );
    },
    true,
  );

  // 网络恢复 / 回到前台：立刻重连，不等退避计时器；明确离线时清理后台重连定时器
  window.addEventListener('online', triggerImmediateReconnect);
  window.addEventListener('offline', () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (!wsOpen) {
      reconnectAttempt = Math.max(1, reconnectAttempt);
      if (hasEverOpened) showOfflineWaiting(triggerImmediateReconnect);
      else if (!authProbeInFlight) showOfflineBootOverlay(triggerImmediateReconnect);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !wsOpen && !isBrowserOffline()) triggerImmediateReconnect();
  });

  void ensureAuthenticated().then(() => {
    authenticationReady = true;
    connectWebSocket();
  });
  installPwaSupport({
    onFilesOpened: (paths) => {
      emitLocalTauriDragEvent('tauri://drag-drop', { paths, position: { x: 0, y: 0 } });
    },
  });

  return {
    connected,
  };
}
