/**
 * Crepe 编辑器 React 组件
 * 基于 @milkdown/crepe 的开箱即用 Markdown 编辑器
 *
 * 模块拆分：
 * - 视图解析：`./crepeViewAccess`
 * - Markdown/IME 清洗：`./crepeMarkdownSanitizer`
 * - 命令式 API 构建：`./crepeApiBuilder`
 * - 块操作菜单：`./hooks/useCrepeBlockMenu` + `./CrepeBlockMenu`
 * - 语义锚点点击 & 跨区摘录拖放：`./hooks/useCrepeExcerptDrop`
 */

import React, { useRef, useEffect, useCallback, useState, useMemo, forwardRef, useImperativeHandle } from 'react';
import { ref as createVueRef } from 'vue';
import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { EditorView } from '@codemirror/view';
import { editorViewCtx } from '@milkdown/kit/core';
import { uploadConfig } from '@milkdown/kit/plugin/upload';
import type { EditorView as ProseEditorView } from '@milkdown/prose/view';
import i18next from 'i18next';

// Crepe 样式（由 ./CrepeEditor.css 经 @layer crepe-vendor 统一引入并分层覆写）

import 'katex/contrib/mhchem';

// 本地模块
import type { CrepeEditorProps, CrepeEditorApi, CrepeBlockActionsHost, CrepeDocumentCapabilities } from './types';
import { bindCrepeCommandHost, notifyCrepeCommandState } from './commandRegistry';
import { officialSelectionToolbarEntries, officialSlashMenuEntries } from './commandMenus';
import { COLUMNS_REQUIRED_CAPABILITY } from './plugins/columns';
import { BlockTransferDialog } from './blockTransfer/BlockTransferDialog';
import { readFormattingState } from './formattingState';
import {
  createImageBlockConfig,
  createImageUploader,
  createTransientBlobUrlRegistry,
  pickImageWithTauriDialog,
  readLocalImageFile,
  validateImageFile,
} from './features/imageUpload';
import { bindBrowserImageUploads, createUploadLifecycle, handleNativeImageDrop, type UploadLifecycle } from './uploadLifecycle';
import { applyCrepePlugins } from './plugins';
import { installMilkdownCtxCompat } from './milkdownCtxCompat';
import { useOptionalSlot, useOptionalUiKernel } from '@/ui-kernel/react';
import {
  adaptSelectionToolbar,
  buildEditorSelectionToolbar,
  buildEditorSlashMenu,
  mergeEditorEntries,
  type EditorContributionError,
  type EditorInstanceContext,
} from '@/ui-plugins/official/editor/editorSlots';
import { createMermaidObserver } from './features/mermaidPreview';
import { emitCrepeDebug, captureDOMSnapshot } from '@/shared/debug/channels/crepeEditor';
import { debugMasterSwitch, debugLog } from '../../debug-panel/debugMasterSwitch';
import { emitImageUploadDebug, captureDOMInfo, captureImageBlockSnapshot } from '@/shared/debug/channels/crepeImageUpload';
import './CrepeEditor.css';
// A6：破图占位 + lightbox 样式（lightbox 插件注册后交互生效；破图样式始终可用）
import './plugins/imageLightbox/imageLightbox.css';
import { useCrepeBlockDrag } from './hooks/useCrepeBlockDrag';
import { useSlashMenuCustomScrollbar } from './hooks/useSlashMenuCustomScrollbar';
import { useCrepeBlockMenu } from './hooks/useCrepeBlockMenu';
import { useCrepeExcerptDrop } from './hooks/useCrepeExcerptDrop';
import { CrepeBlockMenu } from './CrepeBlockMenu';
import { createCrepeEditorApi } from './crepeApiBuilder';
import { IME_PLACEHOLDER_ZWS, sanitizeAssetUrlsForCrepe, stripImePlaceholder } from './crepeMarkdownSanitizer';
import { resolveViewFromCtx } from './crepeViewAccess';
import { scrollSelectionIntoEditorViewport } from './scrollSelectionIntoEditorViewport';
import type { AgentScrollFollower } from './agentScrollFollow';
import { showGlobalNotification } from '../UnifiedNotification';
import { isAndroid, isAndroidMobileShell, isWebUiShell } from '@/utils/platform';

/** 空块按类型提示（Notion 式）：文案经 CSS 变量传给 ::before，随语言切换 */
const TYPED_PLACEHOLDER_VARS = () => {
  const q = (key: string, fallback: string) => JSON.stringify(i18next.t(`notes:editor.placeholder.${key}`, fallback));
  return {
    '--ds-ph-h1': q('heading1', 'Heading 1'),
    '--ds-ph-h2': q('heading2', 'Heading 2'),
    '--ds-ph-h3': q('heading3', 'Heading 3'),
    '--ds-ph-heading': q('heading', 'Heading'),
    '--ds-ph-quote': q('quote', 'Empty quote'),
    '--ds-ph-list': q('list', 'List'),
    '--ds-ph-todo': q('todo', 'To-do'),
    '--ds-review-lock-label': JSON.stringify(i18next.t('notes:aiDiff.review_lock', 'Reviewing AI suggestion · editing paused')),
  };
};

/** E1-6：调试全局仅在 dev 或 debug 总开关打开时挂载，避免生产环境持有已销毁 view 的引用。 */
const shouldExposeDebugGlobals = (): boolean =>
  Boolean(import.meta.env?.DEV) || debugMasterSwitch.isEnabled();

const CREPE_STASHED_CLEANUP_KEYS = [
  '__viewChangeCleanup',
  '__mermaidCleanup',
  '__debugDragCleanup',
  '__imageUploadCleanup',
  '__commandHostCleanup',
] as const;

const runStashedCrepeCleanups = (crepe: unknown): void => {
  if (!crepe) return;
  const stash = crepe as Record<string, unknown>;
  for (const key of CREPE_STASHED_CLEANUP_KEYS) {
    const cleanup = stash[key];
    if (typeof cleanup === 'function') {
      try { cleanup(); } catch { /* 销毁阶段 best-effort */ }
    }
    stash[key] = undefined;
  }
};

/** 仅当全局仍指向本实例时清空，避免误清并行实例挂载的引用。 */
const clearMilkdownDebugGlobals = (crepe: unknown, view: unknown): void => {
  const w = window as unknown as Record<string, unknown>;
  if (crepe && w.__MILKDOWN_CREPE__ === crepe) w.__MILKDOWN_CREPE__ = undefined;
  if (view && w.__MILKDOWN_VIEW__ === view) {
    w.__MILKDOWN_VIEW__ = undefined;
    w.__MILKDOWN_CTX__ = undefined;
  }
};

/**
 * 等待容器尺寸连续 3 帧稳定后再初始化（如 Learning Hub 面板展开动画期间尺寸会变化）；
 * E2-6：容器长期 0×0（如隐藏面板）时不再永久 rAF 空转，3s 超时后强制继续。
 */
function waitForContainerSize(
  container: HTMLElement,
  isDestroyed: () => boolean,
  noteId: string | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    let lastW = 0;
    let lastH = 0;
    let stableCount = 0;
    const startedAt = performance.now();

    const checkSize = () => {
      if (isDestroyed()) { resolve(); return; }
      if (performance.now() - startedAt >= 3000) {
        emitCrepeDebug('init', 'warning', '等待容器尺寸超时，强制继续初始化', {
          noteId, width: container.offsetWidth, height: container.offsetHeight,
        });
        resolve();
        return;
      }
      const { offsetWidth: w, offsetHeight: h } = container;
      if (w > 0 && h > 0) {
        if (w === lastW && h === lastH) {
          if (++stableCount >= 3) { resolve(); return; }
        } else {
          stableCount = 0;
          lastW = w;
          lastH = h;
        }
      }
      requestAnimationFrame(checkSize);
    };
    checkSize();
  });
}

/** 仅在 debugMasterSwitch 打开时挂载的拖拽事件诊断监听 */
function attachDebugDragListeners(container: HTMLElement): () => void {
  const describe = (el: HTMLElement) => el.tagName + (el.className ? `.${el.className.split(' ')[0]}` : '');
  const onDrag = (e: DragEvent) => {
    const target = e.target as HTMLElement;
    const nearBlockHandle = Boolean(target.closest('.milkdown-block-handle'));
    if (nearBlockHandle || e.type === 'drop') {
      debugLog.log(`[CrepeEditor] Global ${e.type}:`, {
        target: describe(target),
        nearBlockHandle,
        dataTransferTypes: e.dataTransfer ? Array.from(e.dataTransfer.types) : [],
        defaultPrevented: e.defaultPrevented,
      });
    }
  };
  const onMouseDown = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.milkdown-block-handle')) {
      debugLog.log('[CrepeEditor] Global mousedown on block handle:', {
        target: describe(target),
        operationItem: target.closest('.operation-item') ? 'yes' : 'no',
      });
    }
  };
  const events = ['dragstart', 'drag', 'dragover', 'drop', 'dragend'] as const;
  container.addEventListener('mousedown', onMouseDown, { capture: true });
  events.forEach((evt) => container.addEventListener(evt, onDrag, { capture: true }));
  return () => {
    container.removeEventListener('mousedown', onMouseDown, { capture: true });
    events.forEach((evt) => container.removeEventListener(evt, onDrag, { capture: true }));
  };
}

/** 仅在 debugMasterSwitch 打开时挂载的图片渲染与节点状态诊断器 */
function attachImageUploadDiagnostics(params: {
  container: HTMLElement;
  crepe: Crepe;
  noteId: string | undefined;
  isTauriEnv: boolean;
  isDestroyed: () => boolean;
}): () => void {
  const { container, crepe, noteId, isTauriEnv, isDestroyed } = params;
  emitImageUploadDebug('dom_snapshot', 'info', '编辑器就绪，捕获 ImageBlock DOM 快照', { isTauriEnv, noteId }, undefined, undefined, captureImageBlockSnapshot(container));

  const renderCleanups = new Set<() => void>();
  const emitImageRender = (img: HTMLImageElement, status: 'success' | 'error', extra?: Record<string, unknown>) => {
    const src = img.getAttribute('src') || '';
    const srcDiagnosis = {
      isEmpty: !src, isAssetUrl: src.startsWith('asset://'), isTauriUrl: src.startsWith('tauri://'),
      isHttpUrl: src.startsWith('http://') || src.startsWith('https://'), isBlobUrl: src.startsWith('blob:'),
      isDataUrl: src.startsWith('data:'), isRelativePath: src.startsWith('notes_assets/'),
      urlProtocol: src.split(':')[0] || 'none', urlLength: src.length,
    };
    emitImageUploadDebug(
      'image_render',
      status === 'success' ? 'success' : 'error',
      status === 'success' ? '图片渲染成功' : `⚠️ 图片渲染失败 - ${srcDiagnosis.isEmpty ? 'src为空' : srcDiagnosis.isRelativePath ? '相对路径未转换' : '加载失败'}`,
      {
        noteId, status, src: src.slice(0, 150), currentSrc: img.currentSrc?.slice(0, 150),
        naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, complete: img.complete,
        srcDiagnosis, parentClass: img.parentElement?.className, grandParentClass: img.parentElement?.parentElement?.className, ...extra,
      },
      captureDOMInfo(img),
    );
    if (status === 'error') {
      debugLog.error('[CrepeEditor] 图片渲染失败详情:', { src, srcDiagnosis, imgElement: img, parentHTML: img.parentElement?.outerHTML?.slice(0, 300) });
    }
  };

  const attachRenderListeners = () => {
    container.querySelectorAll<HTMLImageElement>('.milkdown-image-block img, .milkdown-image-inline img').forEach((img) => {
      const flagged = img as unknown as Record<string, unknown>;
      if (flagged.__crepeImageRenderHooked) return;
      flagged.__crepeImageRenderHooked = true;
      const onLoad = () => emitImageRender(img, 'success');
      const onError = (e: Event) => emitImageRender(img, 'error', { errorType: (e as ErrorEvent)?.type ?? 'unknown', message: (e as ErrorEvent)?.message });
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
      renderCleanups.add(() => {
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
        delete flagged.__crepeImageRenderHooked;
      });
      if (img.complete) queueMicrotask(() => (img.naturalWidth > 0 ? onLoad() : onError(new Event('error'))));
    });
  };

  attachRenderListeners();
  const observer = new MutationObserver((mutations) => {
    attachRenderListeners();
    mutations.forEach((m) => {
      if (m.type === 'attributes' && m.attributeName === 'src' && (m.target as HTMLElement).tagName === 'IMG') {
        const target = m.target as HTMLImageElement;
        const newSrc = target.getAttribute('src') || '';
        emitImageUploadDebug('node_update', newSrc ? 'info' : 'warning', `图片 src 属性变化${!newSrc ? ' (⚠️ 被清空!)' : ''}`, {
          oldSrc: (m.oldValue || '').slice(0, 100), newSrc: newSrc.slice(0, 100), targetClass: target.className,
          parentClass: target.parentElement?.className, isInImageBlock: Boolean(target.closest('.milkdown-image-block')),
          isInImageInline: Boolean(target.closest('.milkdown-image-inline')),
        });
      }
      if (m.type === 'childList') {
        m.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          (node.tagName === 'IMG' ? [node] : Array.from(node.querySelectorAll('img'))).forEach((img) => {
            const cls = (img as HTMLElement).className || '';
            if (cls.includes('ProseMirror-separator') || cls.includes('ProseMirror-trailingBreak')) return;
            const src = (img as HTMLImageElement).getAttribute('src') || '';
            emitImageUploadDebug('dom_snapshot', 'debug', '新增图片元素', { src: src.slice(0, 100), srcEmpty: !src, className: cls, parentClass: img.parentElement?.className });
          });
        });
      }
    });
  });
  observer.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'], attributeOldValue: true });

  let lastSrcMap = new Map<number, string>();
  let tick = 0;
  const trackNodes = () => {
    if (isDestroyed()) return;
    const isPeriodic = ++tick % 20 === 0;
    try {
      crepe.editor.action((ctx) => {
        const view = resolveViewFromCtx(ctx);
        if (!view) return;
        const nextMap = new Map<number, string>();
        const nodes: Array<{ pos: number; src: string; type: string; attrs: unknown }> = [];
        view.state.doc.descendants((node, pos) => {
          if (node.type.name === 'image' || node.type.name === 'image-block' || node.type.name === 'imageBlock') {
            const src = String(node.attrs?.src || '');
            nextMap.set(pos, src);
            nodes.push({ pos, src: src.slice(0, 100), type: node.type.name, attrs: node.attrs });
            const prev = lastSrcMap.get(pos);
            if (prev !== undefined && prev !== src) {
              emitImageUploadDebug('node_update', src ? 'info' : 'error', src ? '图片节点 src 变化' : '⚠️ 图片节点 src 被清空！', {
                pos, prevSrc: prev.slice(0, 100), newSrc: src.slice(0, 100), nodeType: node.type.name, allAttrs: node.attrs,
              });
            }
          }
          return true;
        });
        if (isPeriodic && nodes.length > 0) {
          const empty = nodes.filter((n) => !n.src);
          const rel = nodes.filter((n) => n.src.startsWith('notes_assets/'));
          emitImageUploadDebug('dom_snapshot', empty.length || rel.length ? 'warning' : 'info', '📊 图片节点状态报告 (每10秒)', {
            totalCount: nodes.length, emptyCount: empty.length, relativePathCount: rel.length,
            assetUrlCount: nodes.filter((n) => n.src.startsWith('asset://')).length,
            blobUrlCount: nodes.filter((n) => n.src.startsWith('blob:')).length,
            emptyNodes: empty.map((n) => ({ pos: n.pos, type: n.type })),
            relativePathNodes: rel.map((n) => ({ pos: n.pos, src: n.src })),
            allNodes: nodes,
          });
          const domImgs = Array.from(container.querySelectorAll<HTMLImageElement>('img')).map((img, idx) => ({
            index: idx, src: img.getAttribute('src')?.slice(0, 80) || '', naturalWidth: img.naturalWidth,
            complete: img.complete, error: img.naturalWidth === 0 && img.complete, inImageBlock: Boolean(img.closest('.milkdown-image-block')),
          }));
          const broken = domImgs.filter((i) => i.error);
          if (broken.length > 0) {
            emitImageUploadDebug('image_render', 'error', `⚠️ DOM 中有 ${broken.length} 个损坏的图片`, { brokenImages: broken, allDomImages: domImgs });
          }
        }
        lastSrcMap = nextMap;
      });
    } catch { /* 销毁阶段上下文不可用时静默忽略 */ }
  };

  const trackInterval = setInterval(trackNodes, 500);
  const initTimer = window.setTimeout(() => {
    if (isDestroyed()) return;
    let md = '';
    try { md = crepe.getMarkdown() || ''; } catch { /* ignore */ }
    emitImageUploadDebug('dom_snapshot', 'info', '🚀 编辑器初始化完成 - 执行初始诊断', { noteId, isTauriEnv, markdownLength: md.length }, undefined, undefined, captureImageBlockSnapshot(container));
    const matches = md.match(/!\[.*?\]\((.*?)\)/g) || [];
    if (matches.length > 0) {
      const srcs = matches.map((m) => m.match(/!\[.*?\]\((.*?)\)/)?.[1] ?? '');
      emitImageUploadDebug('dom_snapshot', 'info', `📷 初始内容包含 ${matches.length} 个图片`, {
        imageSrcs: srcs.map((s) => s.slice(0, 80)),
        hasRelativePaths: srcs.some((s) => s.startsWith('notes_assets/')),
        hasAssetUrls: srcs.some((s) => s.startsWith('asset://')),
        hasBlobUrls: srcs.some((s) => s.startsWith('blob:')),
      });
    }
    trackNodes();
  }, 100);

  return () => {
    window.clearTimeout(initTimer);
    clearInterval(trackInterval);
    observer.disconnect();
    renderCleanups.forEach((fn) => fn());
    renderCleanups.clear();
  };
}

/**
 * Crepe 编辑器组件
 */
export const CrepeEditor = forwardRef<CrepeEditorApi, CrepeEditorProps>((props, ref) => {
  const {
    defaultValue = '',
    onChange,
    onDocumentChange,
    onFormattingChange,
    onReady,
    onDestroy,
    onFocus,
    onBlur,
    readonly = false,
    placeholder,
    className = '',
    noteId,
    plugins: pluginsOptions,
    selectionActions,
  } = props;

  /** 真实用户输入（DOM 事件）才记账；agent 事务不经过 DOM 事件，天然不计入 */
  const userActivityRef = useRef({ lastInputAt: 0, composing: false });
  const markUserInput = useCallback(() => { userActivityRef.current.lastInputAt = Date.now(); }, []);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const uploadsRef = useRef<UploadLifecycle | null>(null);
  const viewRef = useRef<ProseEditorView | null>(null);
  const dropIndicatorRef = useRef<HTMLDivElement>(null);

  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;
  const readonlyRef = useRef(readonly);
  readonlyRef.current = readonly;
  // IME 零宽占位可能仍留在文档里（合成未结束 / 合成结束时选区已离开该段落而漏清理）：
  // 此时 getMarkdown 与 scheduleEmitChange 一样剔除零宽空格，避免隐藏时保存把它写进笔记
  const imePlaceholderLiveRef = useRef(false);
  const [isReady, setIsReady] = useState(false);

  // 保持回调与配置最新（初始化 effect 只依赖 noteId，闭包内一律经 ref 读取）
  const latestPropsRef = useRef({
    onChange, onDocumentChange, onFormattingChange, onReady, onDestroy,
    onFocus, onBlur, placeholder, pluginsOptions, selectionActions,
  });
  latestPropsRef.current = {
    onChange, onDocumentChange, onFormattingChange, onReady, onDestroy,
    onFocus, onBlur, placeholder, pluginsOptions, selectionActions,
  };
  const defaultValueRef = useRef(defaultValue);
  useEffect(() => { defaultValueRef.current = defaultValue; }, [defaultValue]);

  const uiKernel = useOptionalUiKernel();
  // 无 UI 内核时为 undefined：applyCrepePlugins 使用官方插件栈
  const extensionEntries = useOptionalSlot('editor.extensions');
  const slashMenuEntries = useOptionalSlot('editor.slashMenu') ?? officialSlashMenuEntries;
  const selectionToolbarEntries = useOptionalSlot('editor.selectionToolbar');
  const blockMenuEntries = useOptionalSlot('editor.blockMenu');
  // Milkdown 插件在实例创建时取一次（create() 之后无法增删）；斜杠菜单、块菜单、选中浮条每次构建时取当前槽位
  const editorContributionsRef = useRef({ extensionEntries, slashMenuEntries, selectionToolbarEntries, blockMenuEntries, uiKernel });
  editorContributionsRef.current = { extensionEntries, slashMenuEntries, selectionToolbarEntries, blockMenuEntries, uiKernel };
  const selectionToolbarVersionRef = useMemo(() => createVueRef(0), []);
  useEffect(() => {
    selectionToolbarVersionRef.value += 1;
  }, [selectionToolbarEntries, selectionActions, selectionToolbarVersionRef]);
  const uiKernelRef = useRef(uiKernel);
  uiKernelRef.current = uiKernel;
  const editorInstanceRef = useRef<EditorInstanceContext>({ options: {} });

  const identityOriginalRef = useRef(defaultValue);
  const blockActionsHostRef = useRef<CrepeBlockActionsHost | null>(null);
  const capabilitiesRef = useRef<CrepeDocumentCapabilities | null>(null);
  const reviewLeasesRef = useRef(new Set<symbol>());
  const canWriteLayout = useCallback(() => {
    const grant = capabilitiesRef.current;
    return Boolean(grant && grant.noteId === noteIdRef.current && grant.writable && grant.capabilities.includes(COLUMNS_REQUIRED_CAPABILITY));
  }, []);

  const exposeTimeoutsRef = useRef<number[]>([]);
  const clearExposeTimeouts = useCallback(() => {
    exposeTimeoutsRef.current.forEach((id) => clearTimeout(id));
    exposeTimeoutsRef.current = [];
  }, []);

  // ACR 4.0：AI 打字机演出的节流滚动跟随（每实例一个，unmount 时 dispose）
  const agentFollowerRef = useRef<AgentScrollFollower | null>(null);
  const agentPulseTimerRef = useRef<number | null>(null);

  // 基于 Pointer Events 的块拖拽（替代失效的原生 Drag & Drop）
  const { handlers: blockDragHandlers, cleanup: cleanupBlockDrag } = useCrepeBlockDrag({
    crepeRef, containerRef, wrapperRef, dropIndicatorRef, enabled: !readonly && isReady,
  });
  const cleanupBlockDragRef = useRef(cleanupBlockDrag);
  cleanupBlockDragRef.current = cleanupBlockDrag;

  useSlashMenuCustomScrollbar({ wrapperRef, enabled: true });

  // 块菜单状态与交互（复用 notes:slashMenu.advancedGroup.callout 与 notes:toggle.slashLabel 等共享 i18n 键）
  const {
    blockMenu, blockMenuElRef, blockMenuActive, blockMenuHighlights,
    blockTransfer, clearBlockTransfer, closeBlockMenu, invalidateBlockMenuIfStale,
    openBlockMenuAtSelection, identityActionBlockedReason, setBlockMenuActiveIndex, runContributedBlockMenuRow,
  } = useCrepeBlockMenu({
    isReady, readonly, noteId, containerRef, crepeRef, viewRef, noteIdRef, readonlyRef,
    identityOriginalRef, blockActionsHostRef, editorInstanceRef, uiKernelRef, blockMenuEntries,
  });
  const openBlockMenuAtSelectionRef = useRef(openBlockMenuAtSelection);
  openBlockMenuAtSelectionRef.current = openBlockMenuAtSelection;
  const invalidateBlockMenuIfStaleRef = useRef(invalidateBlockMenuIfStale);
  invalidateBlockMenuIfStaleRef.current = invalidateBlockMenuIfStale;

  // 语义锚点点击拦截 + DS_EXCERPT_MIME 跨区摘录拖放
  useCrepeExcerptDrop({
    isReady, readonly, containerRef, crepeRef, viewRef, noteIdRef, readonlyRef, reviewLeasesRef, uiKernel, uiKernelRef,
  });

  const buildApi = useCallback(
    (): CrepeEditorApi =>
      createCrepeEditorApi({
        crepeRef, viewRef, containerRef, wrapperRef, uploadsRef, noteIdRef, readonlyRef,
        imePlaceholderLiveRef, identityOriginalRef, capabilitiesRef, blockActionsHostRef,
        reviewLeasesRef, userActivityRef, agentFollowerRef, agentPulseTimerRef,
        closeBlockMenu, openBlockMenuAtSelectionRef, cleanupBlockDragRef,
        runStashedCleanups: runStashedCrepeCleanups,
        clearDebugGlobals: clearMilkdownDebugGlobals,
      }),
    [closeBlockMenu],
  );

  useImperativeHandle(ref, buildApi, [buildApi, isReady]);

  /** 初始化编辑器（仅随 noteId 重建实例） */
  useEffect(() => {
    if (!containerRef.current) {
      emitCrepeDebug('init', 'error', 'containerRef.current 为空，无法初始化', { noteId });
      return;
    }

    let destroyed = false;
    const container = containerRef.current;
    clearExposeTimeouts();
    emitCrepeDebug('lifecycle', 'info', '开始初始化 Crepe 编辑器', {
      noteId, defaultValueLength: defaultValueRef.current?.length || 0, readonly,
    }, captureDOMSnapshot(container));

    const initEditor = async () => {
      try {
        await waitForContainerSize(container, () => destroyed, noteId);
        if (destroyed) return;

        await new Promise<void>((resolve) => {
          if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(() => resolve(), { timeout: 200 });
          else setTimeout(resolve, 100);
        });
        if (destroyed) return;

        const rawDefaultValue = defaultValueRef.current;
        const processedDefaultValue = sanitizeAssetUrlsForCrepe(rawDefaultValue);
        if (rawDefaultValue !== processedDefaultValue) {
          emitCrepeDebug('init', 'warning', '修复了已有 asset:// URL 中的格式问题', { hadIssue: true });
        }

        const blobUrlRegistry = createTransientBlobUrlRegistry();
        const uploadLifecycle = createUploadLifecycle({
          container,
          getView: () => (crepeRef.current === crepe ? crepe.editor.ctx.get(editorViewCtx) : null),
          isCurrent: () => !destroyed && noteIdRef.current === noteId && crepeRef.current === crepe,
          validate: validateImageFile,
          upload: createImageUploader(noteId, {
            register: (url) => {
              if (destroyed || crepeRef.current !== crepe) URL.revokeObjectURL(url);
              else blobUrlRegistry.register(url);
            },
            releaseAll: blobUrlRegistry.releaseAll,
          }),
        });

        identityOriginalRef.current = rawDefaultValue;
        blockActionsHostRef.current = null;
        capabilitiesRef.current = null;
        reviewLeasesRef.current = new Set();

        const contributions = editorContributionsRef.current;
        const reportContributionError = (slot: string): EditorContributionError => (entry, error) => {
          if (contributions.uiKernel) {
            contributions.uiKernel.errors.report({
              pluginId: entry.owner, origin: entry.origin, phase: 'render', error, slot, entryId: entry.id,
            });
          } else {
            console.error(`[CrepeEditor] ${slot} "${entry.id}" failed`, error);
          }
        };

        const editorInstance: EditorInstanceContext = {
          options: { ...latestPropsRef.current.pluginsOptions, columns: { canWrite: canWriteLayout } },
        };
        editorInstanceRef.current = editorInstance;

        const tLabel = (key: string) => ({ label: i18next.t(key) });

        const crepe = new Crepe({
          root: container,
          defaultValue: processedDefaultValue,
          features: {
            [CrepeFeature.CodeMirror]: true,
            [CrepeFeature.ListItem]: true,
            [CrepeFeature.LinkTooltip]: true,
            [CrepeFeature.Cursor]: true,
            [CrepeFeature.ImageBlock]: true,
            [CrepeFeature.BlockEdit]: true,
            [CrepeFeature.Toolbar]: true,
            [CrepeFeature.Placeholder]: true,
            [CrepeFeature.Table]: true,
            [CrepeFeature.Latex]: true,
          },
          featureConfigs: {
            [CrepeFeature.LinkTooltip]: {
              inputPlaceholder: i18next.t('notes:crepe.link.input_placeholder', { defaultValue: 'Enter a link…' }),
            },
            [CrepeFeature.CodeMirror]: {
              extensions: [EditorView.lineWrapping],
              previewOnlyByDefault: true,
              copyText: i18next.t('notes:crepe.code.copy', { defaultValue: 'Copy' }),
              previewLabel: i18next.t('notes:crepe.code.preview', { defaultValue: 'Preview' }),
              previewToggleText: (previewOnly: boolean) =>
                previewOnly
                  ? i18next.t('notes:crepe.code.edit_source', { defaultValue: 'Edit' })
                  : i18next.t('notes:crepe.code.hide_source', { defaultValue: 'Hide' }),
              searchPlaceholder: i18next.t('notes:crepe.code.search_language', { defaultValue: 'Search language' }),
              noResultText: i18next.t('notes:crepe.code.no_language', { defaultValue: 'No result' }),
            },
            [CrepeFeature.ImageBlock]: {
              ...createImageBlockConfig(noteId, blobUrlRegistry),
              onImageLoadError: (event: Event) => {
                const img = event.target;
                if (!(img instanceof HTMLImageElement)) return;
                img.classList.add('crepe-image--broken');
                if (!img.alt) img.alt = i18next.t('notes:crepe.image.load_failed');
              },
            },
            [CrepeFeature.Placeholder]: {
              text: latestPropsRef.current.placeholder || i18next.t('notes:editor.placeholder.body'),
              mode: 'block',
            },
            [CrepeFeature.BlockEdit]: {
              blockHandle: { getOffset: () => 8 },
              textGroup: {
                label: i18next.t('notes:slashMenu.textGroup.label'),
                text: tLabel('notes:slashMenu.textGroup.text'),
                h1: tLabel('notes:slashMenu.textGroup.h1'),
                h2: tLabel('notes:slashMenu.textGroup.h2'),
                h3: tLabel('notes:slashMenu.textGroup.h3'),
                h4: tLabel('notes:slashMenu.textGroup.h4'),
                h5: tLabel('notes:slashMenu.textGroup.h5'),
                h6: tLabel('notes:slashMenu.textGroup.h6'),
                quote: tLabel('notes:slashMenu.textGroup.quote'),
                divider: tLabel('notes:slashMenu.textGroup.divider'),
              },
              listGroup: {
                label: i18next.t('notes:slashMenu.listGroup.label'),
                bulletList: tLabel('notes:slashMenu.listGroup.bulletList'),
                orderedList: tLabel('notes:slashMenu.listGroup.orderedList'),
                taskList: tLabel('notes:slashMenu.listGroup.taskList'),
              },
              advancedGroup: {
                label: i18next.t('notes:slashMenu.advancedGroup.label'),
                image: tLabel('notes:slashMenu.advancedGroup.image'),
                codeBlock: tLabel('notes:slashMenu.advancedGroup.codeBlock'),
                table: tLabel('notes:slashMenu.advancedGroup.table'),
                math: tLabel('notes:slashMenu.advancedGroup.math'),
              },
              buildMenu: (builder) =>
                buildEditorSlashMenu(editorContributionsRef.current.slashMenuEntries, builder, editorInstance, reportContributionError('editor.slashMenu')),
            },
            [CrepeFeature.Toolbar]: {
              buildToolbar: (builder) => {
                void selectionToolbarVersionRef.value;
                const liveToolbarEntries = mergeEditorEntries(
                  officialSelectionToolbarEntries(() => latestPropsRef.current.selectionActions ?? []),
                  editorContributionsRef.current.selectionToolbarEntries,
                );
                buildEditorSelectionToolbar(liveToolbarEntries, adaptSelectionToolbar(builder), editorInstance, reportContributionError('editor.selectionToolbar'));
              },
            },
            [CrepeFeature.Latex]: { katexOptions: { throwOnError: false } },
          },
        });

        installMilkdownCtxCompat(crepe.editor.ctx);
        crepe.editor.config((ctx) =>
          ctx.update(uploadConfig.key, (config) => ({ ...config, uploadWidgetFactory: uploadLifecycle.widgetFactory })),
        );
        applyCrepePlugins(crepe, editorInstance.options, contributions.extensionEntries, reportContributionError('editor.extensions'));
        if (readonly) crepe.setReadonly(true);

        await crepe.create();
        if (destroyed) {
          uploadLifecycle.dispose();
          await crepe.destroy();
          return;
        }

        const crepeStash = crepe as unknown as Record<string, unknown>;
        crepeRef.current = crepe;
        uploadsRef.current = uploadLifecycle;
        const commandView = crepe.editor.ctx.get(editorViewCtx);
        crepeStash.__commandHostCleanup = bindCrepeCommandHost(commandView, {
          ctx: crepe.editor.ctx,
          isReviewActive: () => reviewLeasesRef.current.size > 0,
          canWriteLayout,
          get requestLayoutCapability() {
            if (!blockActionsHostRef.current?.requestLayoutCapability) return undefined;
            return async () => {
              const sourceNote = noteIdRef.current;
              const grant = await blockActionsHostRef.current!.requestLayoutCapability!();
              if (crepe !== crepeRef.current || sourceNote !== noteIdRef.current) return false;
              capabilitiesRef.current = grant?.noteId === sourceNote ? grant : null;
              notifyCrepeCommandState(commandView);
              return canWriteLayout();
            };
          },
          onError: (error) => showGlobalNotification('error', String(error)),
        });

        setIsReady(true);
        if (shouldExposeDebugGlobals()) {
          (window as unknown as Record<string, unknown>).__MILKDOWN_CREPE__ = crepe;
        }

        const attachMermaidObserver = () => {
          if (!container || crepeStash.__mermaidCleanup) return;
          if (container.querySelector('pre code.language-mermaid, code.language-mermaid, .language-mermaid, .mermaid')) {
            crepeStash.__mermaidCleanup = createMermaidObserver(container, 300);
          }
        };

        // 轻量内容监听：避免 plugin-listener 在 IME 合成态触发大量序列化防抖导致卡顿。
        let viewHooked = false;
        let lastMarkdown = '';
        let lastSerializedDoc: unknown = null;
        let changeTimer: number | null = null;
        let isComposing = false;
        let zwsInsertedInComposition = false;

        const scheduleEmitChange = () => {
          if (destroyed || isComposing) return;
          if (changeTimer != null) window.clearTimeout(changeTimer);
          changeTimer = window.setTimeout(() => {
            if (destroyed || !crepeRef.current || isComposing) return;
            const currentDoc = viewRef.current?.state?.doc ?? null;
            if (currentDoc && currentDoc === lastSerializedDoc) return;
            let markdown = '';
            try { markdown = stripImePlaceholder(crepeRef.current.getMarkdown() || ''); } catch { return; }
            if (currentDoc) lastSerializedDoc = currentDoc;
            if (markdown === lastMarkdown) return;
            const prevLen = lastMarkdown.length;
            lastMarkdown = markdown;
            latestPropsRef.current.onChange?.(markdown);
            if (debugMasterSwitch.isEnabled()) {
              emitCrepeDebug('editor', 'debug', 'Markdown 内容更新', { prevLength: prevLen, newLength: markdown.length });
            }
            if (markdown.includes('```mermaid')) attachMermaidObserver();
          }, 250);
        };

        const exposeView = () => {
          if (destroyed || !crepeRef.current) return;
          const currentCrepe = crepeRef.current;
          try {
            currentCrepe.editor.action((ctx) => {
              const view = resolveViewFromCtx(ctx);
              if (!view) return;
              if (shouldExposeDebugGlobals()) {
                (window as unknown as Record<string, unknown>).__MILKDOWN_VIEW__ = view;
                (window as unknown as Record<string, unknown>).__MILKDOWN_CTX__ = ctx;
              }
              viewRef.current = view;
              const editorDom = view.dom as HTMLElement | null;
              if (editorDom) {
                if (!editorDom.getAttribute('role')) editorDom.setAttribute('role', 'textbox');
                editorDom.setAttribute('aria-multiline', 'true');
                if (!editorDom.getAttribute('aria-label')) {
                  editorDom.setAttribute(
                    'aria-label',
                    i18next.t('notes:editor.placeholder.body', { defaultValue: '笔记正文' }),
                  );
                }
                editorDom.setAttribute('aria-readonly', String(Boolean(currentCrepe.readonly)));
              }
              latestPropsRef.current.onFormattingChange?.(readFormattingState(view.state));
              if (viewHooked) return;
              viewHooked = true;

              try { lastMarkdown = stripImePlaceholder(currentCrepe.getMarkdown() || ''); } catch { lastMarkdown = ''; }
              lastSerializedDoc = view.state?.doc ?? null;

              let formatRafId: number | null = null;
              const scheduleFormattingSync = () => {
                if (formatRafId !== null || destroyed) return;
                formatRafId = window.requestAnimationFrame(() => {
                  formatRafId = null;
                  if (destroyed || !viewRef.current) return;
                  try {
                    latestPropsRef.current.onFormattingChange?.(readFormattingState(viewRef.current.state));
                  } catch { /* ignore transient ProseMirror view state */ }
                });
              };

              const originalUpdateState = view.updateState?.bind(view);
              if (originalUpdateState) {
                view.updateState = (newState) => {
                  const oldState = view.state;
                  originalUpdateState(newState);
                  uploadLifecycle.pruneDeleted();
                  if (destroyed) return;

                  invalidateBlockMenuIfStaleRef.current(view);
                  if (oldState.doc !== newState.doc || !oldState.selection.eq(newState.selection) || oldState.storedMarks !== newState.storedMarks) {
                    scheduleFormattingSync();
                  }
                  if (oldState?.doc === newState?.doc || view.composing) return;
                  const oldSize = oldState?.doc?.content?.size ?? -1;
                  const newSize = newState?.doc?.content?.size ?? -2;
                  const docMutated =
                    oldSize !== newSize ||
                    newSize > 4096 ||
                    !oldState?.doc?.eq?.(newState?.doc);
                  if (docMutated) {
                    latestPropsRef.current.onDocumentChange?.();
                    scheduleEmitChange();
                  }
                };
              } else if (view.dom) {
                debugLog.warn('[CrepeEditor] ⚠️ updateState 不存在，使用 DOM input 监听');
                const handleInput = () => { if (!destroyed) scheduleEmitChange(); };
                view.dom.addEventListener('input', handleInput);
                crepeStash.__inputCleanup = () => view.dom.removeEventListener('input', handleInput);
              }

              const handleCompositionStart = () => {
                isComposing = true;
                zwsInsertedInComposition = false;
                if (isAndroid()) return;
                try {
                  const sel = view.state.selection;
                  if (sel.$from.parent?.isTextblock && !sel.$from.parent.textContent) {
                    const tr = view.state.tr.insertText(IME_PLACEHOLDER_ZWS, sel.from).setMeta('addToHistory', false);
                    view.dispatch(tr);
                    zwsInsertedInComposition = true;
                    imePlaceholderLiveRef.current = true;
                  }
                } catch { /* 非关键：IME 占位插入失败不影响正常输入 */ }
              };

              const handleCompositionEnd = () => {
                isComposing = false;
                if (!zwsInsertedInComposition) return;
                try {
                  const $from = view.state.selection.$from;
                  let depth = $from.depth;
                  while (depth > 0 && !$from.node(depth).isTextblock) depth -= 1;
                  if (depth > 0) {
                    const ranges: Array<{ from: number; to: number }> = [];
                    view.state.doc.nodesBetween($from.start(depth), $from.end(depth), (node, pos) => {
                      if (node?.isText && typeof node.text === 'string' && node.text.includes(IME_PLACEHOLDER_ZWS)) {
                        for (let i = 0; i < node.text.length; i += 1) {
                          if (node.text[i] === IME_PLACEHOLDER_ZWS) ranges.push({ from: pos + i, to: pos + i + 1 });
                        }
                      }
                      return true;
                    });
                    if (ranges.length > 0) {
                      let tr = view.state.tr;
                      ranges.sort((a, b) => b.from - a.from).forEach((r) => { tr = tr.delete(r.from, r.to); });
                      view.dispatch(tr.setMeta('addToHistory', false));
                      imePlaceholderLiveRef.current = false;
                    }
                  }
                } catch { /* 非关键 */ }
                zwsInsertedInComposition = false;
              };

              const handleFocus = () => {
                if (destroyed) return;
                latestPropsRef.current.onFocus?.();
                if (debugMasterSwitch.isEnabled()) emitCrepeDebug('editor', 'info', '编辑器获得焦点', undefined, captureDOMSnapshot(container));
              };
              const handleBlur = () => {
                if (destroyed) return;
                latestPropsRef.current.onBlur?.();
                if (debugMasterSwitch.isEnabled()) emitCrepeDebug('editor', 'debug', '编辑器失去焦点');
              };

              const origScroll = view.props?.handleScrollToSelection;
              const handleScrollToSelection = (v: ProseEditorView) => origScroll?.(v) || scrollSelectionIntoEditorViewport(v);
              view.setProps?.({ handleScrollToSelection });

              const dom = view.dom as HTMLElement | null;
              dom?.addEventListener('compositionstart', handleCompositionStart, true);
              dom?.addEventListener('compositionend', handleCompositionEnd, true);
              dom?.addEventListener('focus', handleFocus, true);
              dom?.addEventListener('blur', handleBlur, true);

              crepeStash.__viewChangeCleanup = () => {
                try { if (originalUpdateState) view.updateState = originalUpdateState; } catch { /* ignore */ }
                try { if (typeof crepeStash.__inputCleanup === 'function') (crepeStash.__inputCleanup as () => void)(); } catch { /* ignore */ }
                try {
                  if (view.props?.handleScrollToSelection === handleScrollToSelection) view.setProps?.({ handleScrollToSelection: origScroll });
                  dom?.removeEventListener('compositionstart', handleCompositionStart, true);
                  dom?.removeEventListener('compositionend', handleCompositionEnd, true);
                  dom?.removeEventListener('focus', handleFocus, true);
                  dom?.removeEventListener('blur', handleBlur, true);
                } catch { /* ignore */ }
                if (changeTimer != null) { window.clearTimeout(changeTimer); changeTimer = null; }
                if (formatRafId != null) { window.cancelAnimationFrame(formatRafId); formatRafId = null; }
              };
            });
          } catch { /* 忽略初始化瞬态错误 */ }
        };

        exposeView();
        [100, 500, 1000].forEach((delay) => exposeTimeoutsRef.current.push(window.setTimeout(exposeView, delay)));

        let safeMarkdownLength = 0;
        try { safeMarkdownLength = crepe.getMarkdown()?.length || 0; } catch { /* ignore */ }
        emitCrepeDebug('lifecycle', 'info', '编辑器就绪，isReady=true', { readonly: crepe.readonly, markdownLength: safeMarkdownLength }, captureDOMSnapshot(container), {
          crepeExists: true, isReady: true, readonly: crepe.readonly, noteId: noteId || null, markdownLength: safeMarkdownLength,
        });

        attachMermaidObserver();
        if (debugMasterSwitch.isEnabled()) crepeStash.__debugDragCleanup = attachDebugDragListeners(container);

        const isTauriEnv = typeof window !== 'undefined' && Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__);
        const imageDiagCleanup = debugMasterSwitch.isEnabled()
          ? attachImageUploadDiagnostics({ container, crepe, noteId, isTauriEnv, isDestroyed: () => destroyed })
          : undefined;

        const uploadView = crepe.editor.ctx.get(editorViewCtx);
        const unbindBrowserUploads = bindBrowserImageUploads({
          container,
          view: uploadView,
          lifecycle: uploadLifecycle,
          native: isTauriEnv && !isWebUiShell() && !isAndroidMobileShell(),
          pickNative: pickImageWithTauriDialog,
        });

        let dragDropUnlisten: (() => void) | undefined;
        let dragDropAborted = false;
        if (isTauriEnv) {
          void (async () => {
            try {
              const { getCurrentWebview } = await import('@tauri-apps/api/webview');
              if (destroyed || dragDropAborted) return;
              const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
                if (destroyed || dragDropAborted) return;
                handleNativeImageDrop({
                  payload: event.payload,
                  pixelRatio: window.devicePixelRatio,
                  view: uploadView,
                  container,
                  lifecycle: uploadLifecycle,
                  read: async (path, signal) => {
                    const file = await readLocalImageFile(path);
                    signal.throwIfAborted();
                    return file;
                  },
                });
              });
              if (destroyed || dragDropAborted) { unlisten(); return; }
              dragDropUnlisten = unlisten;
              emitImageUploadDebug('dom_snapshot', 'info', 'Tauri 拖放监听器已注册', {});
            } catch (error) {
              emitImageUploadDebug('error', 'warning', `无法注册 Tauri 拖放监听器: ${error}`, { error: String(error) });
            }
          })();
        }

        crepeStash.__imageUploadCleanup = () => {
          unbindBrowserUploads();
          uploadLifecycle.dispose();
          if (uploadsRef.current === uploadLifecycle) uploadsRef.current = null;
          imageDiagCleanup?.();
          dragDropAborted = true;
          dragDropUnlisten?.();
          blobUrlRegistry.releaseAll();
        };

        try {
          latestPropsRef.current.onReady?.(buildApi());
        } catch (onReadyError) {
          debugLog.warn('[CrepeEditor] onReady callback error (non-fatal):', onReadyError);
        }
        debugLog.log('[CrepeEditor] Editor initialized successfully');
      } catch (error) {
        debugLog.error('[CrepeEditor] Failed to initialize editor:', error);
        emitCrepeDebug('error', 'error', `编辑器初始化失败: ${error}`, {
          errorMessage: String(error), errorStack: (error as Error)?.stack, noteId,
        }, captureDOMSnapshot(container));
      }
    };

    void initEditor();

    return () => {
      emitCrepeDebug('lifecycle', 'info', '开始清理编辑器', { noteId });
      destroyed = true;
      closeBlockMenu();
      clearExposeTimeouts();
      agentFollowerRef.current?.dispose();
      agentFollowerRef.current = null;
      if (agentPulseTimerRef.current != null) {
        window.clearTimeout(agentPulseTimerRef.current);
        agentPulseTimerRef.current = null;
      }
      if (crepeRef.current) {
        runStashedCrepeCleanups(crepeRef.current);
        cleanupBlockDragRef.current();
        try { latestPropsRef.current.onDestroy?.(); } catch (err) { debugLog.warn('[CrepeEditor] onDestroy callback failed:', err); }
        clearMilkdownDebugGlobals(crepeRef.current, viewRef.current);
        crepeRef.current.destroy().catch((e) => {
          debugLog.error('[CrepeEditor] Failed to destroy editor:', e);
          emitCrepeDebug('error', 'error', `编辑器销毁失败: ${e}`);
        });
        crepeRef.current = null;
        viewRef.current = null;
      }
      setIsReady(false);
      emitCrepeDebug('lifecycle', 'info', '编辑器清理完成，isReady=false');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  /** 同步只读状态 */
  useEffect(() => {
    if (crepeRef.current && isReady) {
      if (readonly) uploadsRef.current?.cancelAll();
      crepeRef.current.setReadonly(readonly);
      const editorDom = viewRef.current?.dom as HTMLElement | undefined;
      editorDom?.setAttribute('aria-readonly', String(Boolean(readonly)));
    }
  }, [readonly, isReady]);

  return (
    <div
      ref={wrapperRef}
      className={`crepe-editor-wrapper ${className}`}
      data-ready={isReady}
      style={{ position: 'relative', ...TYPED_PLACEHOLDER_VARS() } as React.CSSProperties}
      onKeyDownCapture={markUserInput}
      onInputCapture={markUserInput}
      onCompositionStartCapture={() => { userActivityRef.current.composing = true; markUserInput(); }}
      onCompositionEndCapture={() => { userActivityRef.current.composing = false; markUserInput(); }}
      onPointerDownCapture={markUserInput}
      onPointerDown={blockDragHandlers.onPointerDown}
      onPointerMove={blockDragHandlers.onPointerMove}
      onPointerUp={blockDragHandlers.onPointerUp}
    >
      <div ref={containerRef} className="crepe-editor-container" />
      {blockTransfer && blockTransfer.noteId === noteId && (
        <BlockTransferDialog
          sourceNoteId={blockTransfer.noteId}
          blockIds={blockTransfer.blockIds}
          service={blockTransfer.host.transferService}
          onClose={clearBlockTransfer}
        />
      )}
      <div ref={dropIndicatorRef} className="crepe-drop-indicator" />
      <CrepeBlockMenu
        blockMenu={blockMenu}
        blockMenuElRef={blockMenuElRef}
        blockMenuActive={blockMenuActive}
        blockMenuHighlights={blockMenuHighlights}
        identityActionBlockedReason={identityActionBlockedReason}
        onActiveIndexChange={setBlockMenuActiveIndex}
        onRunContributedRow={runContributedBlockMenuRow}
      />
    </div>
  );
});

CrepeEditor.displayName = 'CrepeEditor';

export default CrepeEditor;
