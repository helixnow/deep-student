/**
 * Crepe ProseMirror EditorView 安全解析工具
 *
 * 统一消除多处重复的 ctx.get('editorView') / ctx.get(editorViewCtx) / crepe.editor.action
 * 四路探测逻辑，且绝不回退到全局 window.__MILKDOWN_VIEW__，
 * 防止分屏多实例编辑器跨窗格误取到其他实例的 ProseMirror view。
 */

import type { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import type { EditorView as ProseEditorView } from '@milkdown/prose/view';

export type EditorViewRef = {
  current: ProseEditorView | null;
};

export type CrepeViewResolutionSource =
  | 'viewRef'
  | 'ctx-string'
  | 'ctx-symbol'
  | 'action-string'
  | 'action-symbol'
  | 'none';

export interface CrepeViewResolution {
  view: ProseEditorView | null;
  source: CrepeViewResolutionSource;
}

/**
 * 校验候选对象是否为尚未销毁的 ProseMirror EditorView。
 */
export function isLiveCrepeEditorView(candidate: unknown): candidate is ProseEditorView {
  if (!candidate || typeof candidate !== 'object') return false;
  const view = candidate as Partial<ProseEditorView>;
  return Boolean(view.state && typeof view.dispatch === 'function' && !view.isDestroyed);
}

/**
 * 从已缓存的 ref 中读取有效 view；若 view 已被销毁则同步清空缓存。
 */
function readCachedLiveView(cachedViewRef?: EditorViewRef | null): ProseEditorView | null {
  if (!cachedViewRef) return null;
  const current = cachedViewRef.current;
  if (!current) return null;
  if (isLiveCrepeEditorView(current)) return current;
  cachedViewRef.current = null;
  return null;
}

/**
 * 从 Milkdown Ctx 中按「字符串 key 优先、Symbol 兜底」解析存活的 EditorView。
 */
export function resolveViewFromCtxWithSource(
  ctx: Pick<Ctx, 'get'> | null | undefined,
): { view: ProseEditorView | null; via: 'string' | 'symbol' | 'none' } {
  if (!ctx || typeof ctx.get !== 'function') {
    return { view: null, via: 'none' };
  }
  try {
    const byString = ctx.get('editorView' as unknown as typeof editorViewCtx);
    if (isLiveCrepeEditorView(byString)) {
      return { view: byString, via: 'string' };
    }
  } catch {
    // Milkdown ctx 在未注册字符串 key 时会抛错，继续尝试 symbol key
  }
  try {
    const bySymbol = ctx.get(editorViewCtx);
    if (isLiveCrepeEditorView(bySymbol)) {
      return { view: bySymbol, via: 'symbol' };
    }
  } catch {
    // 编辑器可能尚未初始化完成或已销毁
  }
  return { view: null, via: 'none' };
}

/**
 * 从 Milkdown Ctx 中解析存活的 ProseMirror EditorView。
 */
export function resolveViewFromCtx(
  ctx: Pick<Ctx, 'get'> | null | undefined,
): ProseEditorView | null {
  return resolveViewFromCtxWithSource(ctx).view;
}

/**
 * 解析给定 Crepe 实例对应的 ProseMirror EditorView，并附带来源标记（供大纲/生命周期诊断日志使用）。
 * 绝不读取 window.__MILKDOWN_VIEW__ 全局变量。
 */
export function resolveCrepeEditorViewWithSource(
  crepe: Crepe | null | undefined,
  cachedViewRef?: EditorViewRef | null,
): CrepeViewResolution {
  const cached = readCachedLiveView(cachedViewRef);
  if (cached) {
    return { view: cached, source: 'viewRef' };
  }
  if (!crepe?.editor) {
    return { view: null, source: 'none' };
  }

  // 方式 1 & 2：直接从 editor.ctx 读取（字符串 key 优先，symbol 兜底）
  const direct = resolveViewFromCtxWithSource(crepe.editor.ctx);
  if (direct.view) {
    if (cachedViewRef) cachedViewRef.current = direct.view;
    return {
      view: direct.view,
      source: direct.via === 'string' ? 'ctx-string' : 'ctx-symbol',
    };
  }

  // 方式 3 & 4：通过 editor.action 回调同步读取
  if (typeof crepe.editor.action === 'function') {
    const actionResult: { view: ProseEditorView | null; via: 'string' | 'symbol' | 'none' } = {
      view: null,
      via: 'none',
    };
    try {
      crepe.editor.action((ctx) => {
        const resolved = resolveViewFromCtxWithSource(ctx);
        if (resolved.view) {
          actionResult.view = resolved.view;
          actionResult.via = resolved.via;
        }
      });
    } catch {
      // 销毁阶段或 ctx 未就绪时忽略
    }
    if (actionResult.view) {
      if (cachedViewRef) cachedViewRef.current = actionResult.view;
      return {
        view: actionResult.view,
        source: actionResult.via === 'string' ? 'action-string' : 'action-symbol',
      };
    }
  }

  return { view: null, source: 'none' };
}

/**
 * 解析给定 Crepe 实例对应的存活 ProseMirror EditorView。
 */
export function resolveCrepeEditorView(
  crepe: Crepe | null | undefined,
  cachedViewRef?: EditorViewRef | null,
): ProseEditorView | null {
  return resolveCrepeEditorViewWithSource(crepe, cachedViewRef).view;
}

/**
 * 在拿到存活的 ProseMirror EditorView（以及可用的 Milkdown Ctx）后执行回调。
 * 若回调本身抛出异常，将原样透传而不静默吞掉。
 */
export function withCrepeEditorView<T>(
  crepe: Crepe | null | undefined,
  cachedViewRef: EditorViewRef | null | undefined,
  fn: (view: ProseEditorView, ctx: Ctx | null) => T,
): T | undefined {
  if (!crepe) return undefined;

  let invoked = false;
  let result: T | undefined;

  if (typeof crepe.editor?.action === 'function') {
    try {
      crepe.editor.action((ctx) => {
        const view = resolveViewFromCtx(ctx) ?? readCachedLiveView(cachedViewRef);
        if (!view) return;
        if (cachedViewRef) cachedViewRef.current = view;
        invoked = true;
        result = fn(view, ctx);
      });
      if (invoked) return result;
    } catch (error) {
      if (invoked) throw error;
      // editor.action 获取上下文失败时回退到直接解析
    }
  }

  const fallbackView = resolveCrepeEditorView(crepe, cachedViewRef);
  if (!fallbackView) return undefined;
  return fn(fallbackView, crepe.editor?.ctx ?? null);
}
