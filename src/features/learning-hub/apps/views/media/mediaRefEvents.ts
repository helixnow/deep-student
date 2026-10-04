/**
 * 媒体时间戳引用事件契约（docs/dev/media-learning/README.md §2）
 *
 * 与 PDF 引用同族：
 * - `media-ref:open`  {resourceId, seconds}：「打开资源并跳到该时间」的意图。
 *   消费方：经典壳 useChatPageEvents（聊天右侧面板 / 学习资源页标签）、
 *   工作台 WorkbenchEventBridge（launch file 资源窗）。派发方：聊天 `[媒体@…]`
 *   徽章、笔记（Crepe）里的媒体锚点。
 * - `media-ref:focus` {resourceId, seconds, targetScopeId?, acknowledge?, isStale?}：
 *   已挂载的媒体视图（FileContentView 的音视频分支）seek + 播放后回执。
 *
 * 本模块零运行时依赖（聊天 / 笔记 / 工作台均可静态 import，不拖入播放器 chunk）。
 */

export const MEDIA_REF_OPEN_EVENT = 'media-ref:open';
export const MEDIA_REF_FOCUS_EVENT = 'media-ref:focus';

export interface MediaRefOpenDetail {
  resourceId: string;
  seconds: number;
}

export interface MediaFocusEventDetail {
  resourceId: string;
  seconds: number;
  /** 只让指定视图实例响应（聊天右侧面板传 CHAT_PANEL_PDF_FOCUS_SCOPE） */
  targetScopeId?: string;
  /** seek 后是否开始播放（默认 true） */
  play?: boolean;
  acknowledge?: (handled: boolean) => void;
  /** 派发方已判定失败（超时 / 卸载）时返回 true；视图兑现前必须检查 */
  isStale?: () => boolean;
}

function isValidTarget(resourceId: unknown, seconds: unknown): boolean {
  return (
    typeof resourceId === 'string' &&
    resourceId.length > 0 &&
    typeof seconds === 'number' &&
    Number.isFinite(seconds) &&
    seconds >= 0
  );
}

/**
 * 待兑现的跳转意图（握手兜底，同 pendingChatNavigation 思路）：冷启动打开媒体要先
 * 拉起窗口 / 加载 chunk / 读元数据，可能晚于重发窗口（~10s）或工作台单发回执（1.5s）。
 * 意图在点击时记下，媒体视图就绪后按资源匹配领取；任一路径兑现后清除，避免重复 seek。
 */
export const PENDING_MEDIA_FOCUS_TTL_MS = 30_000;
let pendingMediaFocus: { resourceId: string; seconds: number; at: number } | null = null;

export function rememberPendingMediaFocus(resourceId: string, seconds: number): void {
  if (!isValidTarget(resourceId, seconds)) return;
  pendingMediaFocus = { resourceId, seconds, at: Date.now() };
}

/** 领取匹配本视图资源且未过期的意图（领取即清除）；无则 null */
export function takePendingMediaFocus(matches: (resourceId: string) => boolean): number | null {
  const pending = pendingMediaFocus;
  if (!pending) return null;
  if (Date.now() - pending.at > PENDING_MEDIA_FOCUS_TTL_MS) {
    pendingMediaFocus = null;
    return null;
  }
  if (!matches(pending.resourceId)) return null;
  pendingMediaFocus = null;
  return pending.seconds;
}

/** 已由回执路径兑现：清掉同一资源的待兑现意图 */
export function clearPendingMediaFocus(resourceId: string): void {
  if (pendingMediaFocus?.resourceId === resourceId) pendingMediaFocus = null;
}

/** 点击引用徽章 / 笔记锚点 → 打开资源并跳转 */
export function dispatchOpenMediaRef(resourceId: string, seconds: number): void {
  if (!isValidTarget(resourceId, seconds)) return;
  rememberPendingMediaFocus(resourceId, seconds);
  document.dispatchEvent(
    new CustomEvent<MediaRefOpenDetail>(MEDIA_REF_OPEN_EVENT, {
      detail: { resourceId, seconds },
    }),
  );
}

/**
 * 带回执重发直到被处理（同 chatPdfFocus.requestPdfFocusUntilHandled）：
 * 面板首次打开要先加载 chunk + 解析媒体源，常超过 800ms。
 */
export const MEDIA_FOCUS_RETRY_DELAYS_MS = [0, 250, 800, 1600, 3000, 5000] as const;

export interface MediaFocusTarget {
  resourceId: string;
  seconds: number;
  targetScopeId?: string;
  play?: boolean;
}

/** @returns 取消函数（停止剩余重发） */
export function requestMediaFocusUntilHandled(target: MediaFocusTarget): () => void {
  const { resourceId, seconds, targetScopeId, play } = target;
  if (!isValidTarget(resourceId, seconds)) return () => undefined;
  let handled = false;
  const timers: number[] = [];
  for (const delay of MEDIA_FOCUS_RETRY_DELAYS_MS) {
    timers.push(
      window.setTimeout(() => {
        if (handled) return;
        document.dispatchEvent(
          new CustomEvent<MediaFocusEventDetail>(MEDIA_REF_FOCUS_EVENT, {
            detail: {
              resourceId,
              seconds,
              targetScopeId,
              play,
              acknowledge: (ok: boolean) => {
                if (ok) handled = true;
              },
            },
          }),
        );
      }, delay),
    );
  }
  return () => {
    handled = true;
    for (const id of timers) window.clearTimeout(id);
  };
}

/** 单发 + 超时回执（同 workbench pdfFocusAck.requestPdfPageFocus） */
export const MEDIA_FOCUS_ACK_TIMEOUT_MS = 1500;

export function requestMediaSeekWithAck(target: MediaFocusTarget): Promise<boolean> {
  if (typeof document === 'undefined' || !isValidTarget(target.resourceId, target.seconds)) {
    return Promise.resolve(false);
  }
  let stale = false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (!ok) stale = true;
      window.clearTimeout(timeout);
      resolve(ok);
    };
    const timeout = window.setTimeout(() => finish(false), MEDIA_FOCUS_ACK_TIMEOUT_MS);
    document.dispatchEvent(
      new CustomEvent<MediaFocusEventDetail>(MEDIA_REF_FOCUS_EVENT, {
        detail: {
          ...target,
          acknowledge: finish,
          isStale: () => stale,
        },
      }),
    );
  });
}
