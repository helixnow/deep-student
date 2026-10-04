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

/** 点击引用徽章 / 笔记锚点 → 打开资源并跳转 */
export function dispatchOpenMediaRef(resourceId: string, seconds: number): void {
  if (!isValidTarget(resourceId, seconds)) return;
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
