/**
 * useDesktopDrop（O19）— 拖放到桌面 / 窗口的通用落点 hook
 * ---------------------------------------------------------------------------
 * 消费方：O13（桌面空白区拖入 OS 文件开窗）、O17（files 浏览器拖资源到桌面 /
 * 资源拖入窗口）、O16（拖文件进 Chat 窗口作为附件区提示）。
 *
 * 能力：
 *   - 统一识别三类拖拽负载：OS 文件（dataTransfer.files）、内部资源
 *     （自定义 MIME WB_RESOURCE_MIME 的 JSON）、纯文本；
 *   - dragenter/dragleave 计数消除子元素抖动，落点态直写 DOM
 *     （`data-wb-drop-state` 属性 + `wb-cursor-drop-over/denied` 类，
 *     样式见 styles/a11y-cursor.css），全程 0 React state；
 *   - accept 谓词在 dragover 阶段仅凭 types 判定（浏览器安全模型：
 *     文件内容 drop 前不可见），拒绝时 dropEffect='none' → 系统
 *     not-allowed 光标；
 *   - onDrop 提供相对 target 的落点坐标（开窗定位用）。
 *
 * 拖源侧配套：setWorkbenchDragData（O17 files 列表 dragstart 时调用），
 * 与本 hook 的解析器同构，保证内部资源拖拽往返无损。
 */
import { useEffect, useRef } from 'react';
import { resolveGestureTarget, type WorkbenchGestureTarget } from './useWorkbenchGestures';

// ============================================================================
// 负载契约
// ============================================================================

/** 内部资源拖拽的自定义 MIME（dataTransfer 键，全小写以兼容 Chromium 归一化） */
export const WB_RESOURCE_MIME = 'application/x-deepstudent-resource';

export interface WorkbenchResourceDragData {
  /** 业务资源 id（如 'note_xxx' / 'pdf_xxx'，与 instanceKey 同构） */
  resourceId: string;
  /** 资源类型（files 应用的类型标识，如 'note' / 'pdf' / 'image'） */
  resourceType?: string;
  /** 展示标题（拖拽预览 / 落点提示用） */
  title?: string;
}

export type WorkbenchDropPayload =
  | { kind: 'os-files'; files: File[] }
  | { kind: 'resource'; resource: WorkbenchResourceDragData }
  | { kind: 'text'; text: string };

/** dragover 阶段可用的负载摘要（文件内容此时不可读） */
export interface WorkbenchDragInfo {
  hasFiles: boolean;
  hasResource: boolean;
  hasText: boolean;
  types: readonly string[];
}

export interface WorkbenchDropPoint {
  /** 相对 target 左上角（px） */
  x: number;
  y: number;
  clientX: number;
  clientY: number;
}

export type WorkbenchDropState = 'idle' | 'over' | 'denied';

// ============================================================================
// 拖源辅助（O17 files 列表 dragstart 调用）
// ============================================================================

/**
 * 把内部资源写入 dataTransfer（自定义 MIME + text/plain 兜底）。
 * 用法：<div draggable onDragStart={(e) => setWorkbenchDragData(e.dataTransfer, data)}>
 */
export function setWorkbenchDragData(
  dataTransfer: DataTransfer,
  data: WorkbenchResourceDragData,
): void {
  dataTransfer.setData(WB_RESOURCE_MIME, JSON.stringify(data));
  // 兜底：拖到外部应用 / 不识别自定义 MIME 的落点时至少携带标题或 id
  dataTransfer.setData('text/plain', data.title ?? data.resourceId);
  dataTransfer.effectAllowed = 'copyMove';
}

/** 从 dataTransfer 解析内部资源负载；非本应用拖源返回 null */
export function parseWorkbenchDragData(
  dataTransfer: DataTransfer,
): WorkbenchResourceDragData | null {
  let raw = '';
  try {
    raw = dataTransfer.getData(WB_RESOURCE_MIME);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as WorkbenchResourceDragData).resourceId === 'string'
    ) {
      return parsed as WorkbenchResourceDragData;
    }
  } catch {
    /* 非法 JSON → 视作非资源拖拽 */
  }
  return null;
}

function readDragInfo(dataTransfer: DataTransfer | null): WorkbenchDragInfo {
  const types: readonly string[] = dataTransfer?.types ?? [];
  return {
    hasFiles: types.includes('Files'),
    hasResource: types.includes(WB_RESOURCE_MIME),
    hasText: types.includes('text/plain'),
    types,
  };
}

// ============================================================================
// hook 本体
// ============================================================================

/** 落点态样式钩子（a11y-cursor.css）：over/denied 两态类 + data 属性 */
const DROP_STATE_ATTR = 'data-wb-drop-state';
const CLASS_OVER = 'wb-cursor-drop-over';
const CLASS_DENIED = 'wb-cursor-drop-denied';

export interface UseDesktopDropOptions {
  target: WorkbenchGestureTarget;
  /** 松手落点（accept 通过后才会触发） */
  onDrop: (payload: WorkbenchDropPayload, point: WorkbenchDropPoint) => void | Promise<void>;
  /**
   * dragover 阶段的接受谓词（仅凭 types 摘要判定）。
   * 缺省 = 接受文件与内部资源，拒绝纯文本。
   */
  accept?: (info: WorkbenchDragInfo) => boolean;
  /** 落点态变化（idle/over/denied）；用于额外反馈（如提示文案），高亮本身已直写 DOM */
  onDragStateChange?: (state: WorkbenchDropState) => void;
  /** 接受时向系统声明的效果（决定 OS 光标徽标），默认 'copy' */
  dropEffect?: 'copy' | 'move' | 'link';
  disabled?: boolean;
}

export interface UseDesktopDropResult {
  /** 非响应式查询当前落点态 */
  getDropState: () => WorkbenchDropState;
}

function defaultAccept(info: WorkbenchDragInfo): boolean {
  return info.hasFiles || info.hasResource;
}

export function useDesktopDrop(options: UseDesktopDropOptions): UseDesktopDropResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const stateRef = useRef<WorkbenchDropState>('idle');

  useEffect(() => {
    const el = resolveGestureTarget(optionsRef.current.target);
    if (!el || optionsRef.current.disabled) return undefined;

    /** dragenter/dragleave 会在子元素间反复触发，用计数判定真实进出 */
    let enterDepth = 0;

    const applyState = (state: WorkbenchDropState) => {
      if (stateRef.current === state) return;
      stateRef.current = state;
      // 直写 DOM，不进 React state（编排 §1.5）
      if (state === 'idle') {
        el.removeAttribute(DROP_STATE_ATTR);
        el.classList.remove(CLASS_OVER, CLASS_DENIED);
      } else {
        el.setAttribute(DROP_STATE_ATTR, state);
        el.classList.toggle(CLASS_OVER, state === 'over');
        el.classList.toggle(CLASS_DENIED, state === 'denied');
      }
      optionsRef.current.onDragStateChange?.(state);
    };

    const evaluate = (event: DragEvent): boolean => {
      const info = readDragInfo(event.dataTransfer);
      const accept = optionsRef.current.accept ?? defaultAccept;
      return accept(info);
    };

    const onDragEnter = (event: DragEvent) => {
      enterDepth += 1;
      const accepted = evaluate(event);
      if (accepted) {
        event.preventDefault();
        applyState('over');
      } else {
        applyState('denied');
      }
    };

    const onDragOver = (event: DragEvent) => {
      const accepted = evaluate(event);
      if (accepted) {
        // preventDefault = 声明本元素为合法落点（否则浏览器禁止 drop）
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = optionsRef.current.dropEffect ?? 'copy';
        }
        applyState('over');
      } else {
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
        applyState('denied');
      }
    };

    const onDragLeave = () => {
      enterDepth = Math.max(0, enterDepth - 1);
      if (enterDepth === 0) applyState('idle');
    };

    const onDrop = (event: DragEvent) => {
      enterDepth = 0;
      const wasAccepted = evaluate(event);
      applyState('idle');
      if (!wasAccepted) return;
      event.preventDefault();
      event.stopPropagation();

      const dataTransfer = event.dataTransfer;
      if (!dataTransfer) return;

      let payload: WorkbenchDropPayload | null = null;
      const resource = parseWorkbenchDragData(dataTransfer);
      if (resource) {
        payload = { kind: 'resource', resource };
      } else if (dataTransfer.files && dataTransfer.files.length > 0) {
        payload = { kind: 'os-files', files: Array.from(dataTransfer.files) };
      } else {
        const text = dataTransfer.getData('text/plain');
        if (text) payload = { kind: 'text', text };
      }
      if (!payload) return;

      const rect = el.getBoundingClientRect();
      const point: WorkbenchDropPoint = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      void optionsRef.current.onDrop(payload, point);
    };

    /** 拖拽被取消（Esc / 拖出浏览器窗口）时浏览器发 dragend 给拖源；
     *  落点侧兜底：window 级 dragend / drop 复位残留高亮 */
    const onWindowDragEnd = () => {
      enterDepth = 0;
      applyState('idle');
    };

    el.addEventListener('dragenter', onDragEnter);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDrop);
    window.addEventListener('dragend', onWindowDragEnd);

    return () => {
      el.removeEventListener('dragenter', onDragEnter);
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('dragleave', onDragLeave);
      el.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', onWindowDragEnd);
      // 复位残留视觉态
      el.removeAttribute(DROP_STATE_ATTR);
      el.classList.remove(CLASS_OVER, CLASS_DENIED);
      stateRef.current = 'idle';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.disabled, options.target]);

  return {
    getDropState: () => stateRef.current,
  };
}
