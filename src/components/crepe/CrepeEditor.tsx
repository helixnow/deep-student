/**
 * Crepe 编辑器 React 组件
 * 基于 @milkdown/crepe 的开箱即用 Markdown 编辑器
 * 
 * 特性：
 * - 完整的 Markdown 支持（GFM）
 * - 斜杠命令菜单
 * - 气泡工具栏
 * - 表格、代码块、数学公式
 * - 图片上传（集成笔记资产管理）
 * - 拖拽句柄
 */

import React, { useRef, useEffect, useLayoutEffect, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { EditorView } from '@codemirror/view';
import { editorViewCtx, commandsCtx, parserCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/prose/state';
import { replaceAll } from '@milkdown/kit/utils';
import { toggleMark, setBlockType, wrapIn } from '@milkdown/prose/commands';
import { Slice } from '@milkdown/prose/model';
import { listItemSchema, wrapInBlockTypeCommand } from '@milkdown/kit/preset/commonmark';
import { linkTooltipAPI } from '@milkdown/kit/component/link-tooltip';
import i18next from 'i18next';

// Crepe 样式（亮色 + 暗色主题）
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import '@milkdown/crepe/theme/frame-dark.css';

import 'katex/contrib/mhchem';

// 本地模块
import type { CrepeEditorProps, CrepeEditorApi } from './types';
import { readCssTimeMs } from '@/shared/utils/cssTime';
import { agentHighlightKey, type AgentHighlightMeta } from './plugins/agentHighlight';
import {
  createImageBlockConfig,
  createImageUploader,
  createTransientBlobUrlRegistry,
  pickImageWithTauriDialog,
} from './features/imageUpload';
import { applyCrepePlugins } from './plugins';
import { appendCalloutToggleSlashItems } from './plugins/slashMenuExtras';
import { createMermaidObserver } from './features/mermaidPreview';
import { emitCrepeDebug, captureDOMSnapshot } from '../../debug-panel/plugins/CrepeEditorDebugPlugin';
import { emitOutlineDebugLog, emitOutlineDebugSnapshot } from '../../debug-panel/events/NotesOutlineDebugChannel';
import { debugMasterSwitch, debugLog } from '../../debug-panel/debugMasterSwitch';
import { 
  emitImageUploadDebug, 
  captureDOMInfo, 
  checkSelectorMatches, 
  captureImageBlockSnapshot 
} from '../../debug-panel/plugins/CrepeImageUploadDebugPlugin';
import './CrepeEditor.css';
// A6：破图占位 + lightbox 样式（lightbox 插件注册后交互生效；破图样式始终可用）
import './plugins/imageLightbox/imageLightbox.css';
import { useCrepeBlockDrag } from './hooks/useCrepeBlockDrag';
import { useSlashMenuCustomScrollbar } from './hooks/useSlashMenuCustomScrollbar';
import { createAgentInsertTransaction } from './useCrepeEditor';
import { scrollSelectionIntoEditorViewport } from './scrollSelectionIntoEditorViewport';
import { AgentScrollFollower } from './agentScrollFollow';
import { resolveFlashSnippet } from './agentDiffFlash';
import { showGlobalNotification } from '../UnifiedNotification';
import { isNonEmptyHref } from './plugins/imageLightbox/nonEmptyHref';
import {
  deleteCrepeBlock,
  duplicateCrepeBlock,
  turnCrepeBlockInto,
  type CrepeBlockTurnInto,
} from './blockMenuCommands';
import {
  findCrepeBlockMenuTypeaheadIndex,
  getNextCrepeBlockMenuIndex,
  isCrepeBlockMenuDocCurrent,
  shouldDismissCrepeBlockMenuForKey,
} from './blockMenuState';

type BlockMenuState = { pos: number; x: number; y: number; doc: unknown } | null;
type BlockMenuAction = CrepeBlockTurnInto | 'duplicate' | 'delete';

/** turn-into 目标（渲染顺序即键盘导航顺序） */
const BLOCK_MENU_TURN_INTO_ACTIONS: readonly CrepeBlockTurnInto[] = [
  'paragraph',
  'heading-1',
  'heading-2',
  'heading-3',
  'bullet-list',
  'ordered-list',
  'task-list',
  'quote',
  'code-block',
  'callout',
  'toggle',
];

/** 键盘 ↑↓/Enter 导航遍历的完整动作序列（turn-into + duplicate + delete） */
const BLOCK_MENU_ACTIONS: readonly BlockMenuAction[] = [
  ...BLOCK_MENU_TURN_INTO_ACTIONS,
  'duplicate',
  'delete',
];

function getBlockMenuActionLabel(action: BlockMenuAction): string {
  switch (action) {
    case 'paragraph': return i18next.t('notes:blockMenu.paragraph', 'Text');
    case 'heading-1': return i18next.t('notes:blockMenu.heading1', 'Heading 1');
    case 'heading-2': return i18next.t('notes:blockMenu.heading2', 'Heading 2');
    case 'heading-3': return i18next.t('notes:blockMenu.heading3', 'Heading 3');
    case 'bullet-list': return i18next.t('notes:blockMenu.bulletList', 'Bulleted list');
    case 'ordered-list': return i18next.t('notes:blockMenu.orderedList', 'Numbered list');
    case 'task-list': return i18next.t('notes:blockMenu.taskList', 'To-do list');
    case 'quote': return i18next.t('notes:blockMenu.quote', 'Quote');
    case 'code-block': return i18next.t('notes:blockMenu.codeBlock', 'Code block');
    case 'callout': return i18next.t('notes:blockMenu.callout', 'Callout');
    case 'toggle': return i18next.t('notes:blockMenu.toggle', 'Toggle list');
    case 'duplicate': return i18next.t('notes:blockMenu.duplicate', 'Duplicate');
    case 'delete': return i18next.t('notes:blockMenu.delete', 'Delete');
  }
}

/**
 * E1-6：调试全局仅在 dev 或 debug 总开关打开时挂载，
 * 生产环境默认不暴露 window.__MILKDOWN_*，避免持有已销毁 view 的引用。
 */
const shouldExposeDebugGlobals = (): boolean =>
  Boolean(import.meta.env?.DEV) || debugMasterSwitch.isEnabled();

/** 初始化期间挂到 crepe 实例上的清理函数键（DOM 监听 / observer / interval） */
const CREPE_STASHED_CLEANUP_KEYS = [
  '__viewChangeCleanup',
  '__mermaidCleanup',
  '__debugDragCleanup',
  '__imageUploadCleanup',
] as const;

/** 统一执行 stashed 清理；effect cleanup 与 api.destroy() 都必须走这里，避免 observer 泄漏。 */
const runStashedCrepeCleanups = (crepe: unknown): void => {
  if (!crepe) return;
  for (const key of CREPE_STASHED_CLEANUP_KEYS) {
    const cleanup = (crepe as any)[key];
    if (typeof cleanup === 'function') {
      try {
        cleanup();
      } catch { /* 销毁阶段 best-effort */ }
    }
    (crepe as any)[key] = undefined;
  }
};

/** 仅当全局仍指向本实例时清空，避免误清并行实例挂载的引用。 */
const clearMilkdownDebugGlobals = (crepe: unknown, view: unknown): void => {
  const w = window as any;
  if (crepe && w.__MILKDOWN_CREPE__ === crepe) {
    w.__MILKDOWN_CREPE__ = undefined;
  }
  if (view && w.__MILKDOWN_VIEW__ === view) {
    w.__MILKDOWN_VIEW__ = undefined;
    w.__MILKDOWN_CTX__ = undefined;
  }
};

/**
 * Crepe 编辑器组件
 */
export const CrepeEditor = forwardRef<CrepeEditorApi, CrepeEditorProps>((props, ref) => {
  const {
    defaultValue = '',
    onChange,
    onReady,
    onDestroy,
    onFocus,
    onBlur,
    readonly = false,
    placeholder,
    className = '',
    noteId,
    plugins: pluginsOptions,
  } = props;

  const wrapperRef = useRef<HTMLDivElement>(null); // 外层包装
  const containerRef = useRef<HTMLDivElement>(null); // Crepe 容器
  const crepeRef = useRef<Crepe | null>(null);
  const viewRef = useRef<any>(null); // 存储 ProseMirror view 引用
  const dropIndicatorRef = useRef<HTMLDivElement>(null); // 拖拽插入条
  const blockMenuElRef = useRef<HTMLDivElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [blockMenu, setBlockMenu] = useState<BlockMenuState>(null);
  const [blockMenuActive, setBlockMenuActive] = useState(-1);
  const blockMenuActiveRef = useRef(-1); // keydown 监听内读取，避免闭包过期
  const [initPhase, setInitPhase] = useState('pending'); // 🔧 调试：追踪初始化阶段
  const onChangeRef = useRef(onChange);
  const onReadyRef = useRef(onReady);
  const onDestroyRef = useRef(onDestroy);
  const onFocusRef = useRef(onFocus);
  const onBlurRef = useRef(onBlur);
  const placeholderRef = useRef(placeholder);
  const pluginsOptionsRef = useRef(pluginsOptions);
  const defaultValueRef = useRef(defaultValue);
  const exposeTimeoutsRef = useRef<number[]>([]);
  // ACR 4.0：AI 打字机演出的节流滚动跟随（每实例一个，unmount 时 dispose）
  const agentFollowerRef = useRef<AgentScrollFollower | null>(null);
  const agentPulseTimerRef = useRef<number | null>(null);

  // 🔧 使用基于 Pointer Events 的块拖拽（替代失效的原生 Drag & Drop）
  const { handlers: blockDragHandlers, cleanup: cleanupBlockDrag } = useCrepeBlockDrag({
    crepeRef,
    containerRef,
    wrapperRef,
    dropIndicatorRef,
    enabled: !readonly && isReady,
  });

  useSlashMenuCustomScrollbar({
    wrapperRef,
    enabled: true,
  });

  useEffect(() => {
    if (!isReady || readonly) return;
    const container = containerRef.current;
    if (!container) return;

    let pending: { handle: Element; x: number; y: number; pointerId: number } | null = null;
    const getMenuHandle = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null;
      const handle = target.closest('.milkdown-block-handle');
      const operation = target.closest('.operation-item');
      if (!handle || !operation) return null;
      const items = Array.from(handle.querySelectorAll('.operation-item'));
      return items.indexOf(operation) === 1 ? handle : null;
    };
    const onPointerDown = (event: PointerEvent) => {
      const handle = getMenuHandle(event.target);
      pending = handle ? { handle, x: event.clientX, y: event.clientY, pointerId: event.pointerId } : null;
    };
    const onPointerUp = (event: PointerEvent) => {
      const current = pending;
      pending = null;
      if (!current || current.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) >= 8) return;
      const target = event.target;
      const handle = getMenuHandle(target) ?? current.handle;

      const view = viewRef.current;
      if (!view) return;
      const rect = handle.getBoundingClientRect();
      // 探测点钳入编辑器内容区，句柄悬停在内容区外（窄栏/缩进块）时 posAtCoords 也能命中
      const editorRect = (view.dom as HTMLElement).getBoundingClientRect();
      const probeX = Math.min(
        Math.max(rect.right + 24, editorRect.left + 4),
        Math.max(editorRect.left + 4, editorRect.right - 4),
      );
      const hit = view.posAtCoords({ left: probeX, top: rect.top + rect.height / 2 });
      if (!hit) return;
      const $pos = view.state.doc.resolve(Math.max(0, hit.inside >= 0 ? hit.inside : hit.pos));
      const pos = $pos.depth > 0 ? $pos.before(1) : hit.pos;
      event.preventDefault();
      event.stopPropagation();
      // 先按句柄位置放置；渲染后由 useLayoutEffect 按菜单实测尺寸钳入视口
      setBlockMenu({
        pos,
        x: rect.right + 6,
        y: Math.max(8, rect.top),
        doc: view.state.doc,
      });
    };
    container.addEventListener('pointerdown', onPointerDown, true);
    container.addEventListener('pointerup', onPointerUp, true);
    return () => {
      container.removeEventListener('pointerdown', onPointerDown, true);
      container.removeEventListener('pointerup', onPointerUp, true);
    };
  }, [isReady, readonly]);

  // 菜单开/关（对象变化）时重置键盘高亮
  useEffect(() => {
    blockMenuActiveRef.current = -1;
    setBlockMenuActive(-1);
  }, [blockMenu]);

  // 按菜单实测尺寸钳入视口，替代固定高度估算（菜单项增减后无需回调整数值）
  useLayoutEffect(() => {
    const el = blockMenuElRef.current;
    if (!blockMenu || !el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(blockMenu.x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(blockMenu.y, window.innerHeight - rect.height - 8));
    if (left !== blockMenu.x) el.style.left = `${left}px`;
    if (top !== blockMenu.y) el.style.top = `${top}px`;
  }, [blockMenu]);

  const setBlockMenuActiveIndex = useCallback((index: number) => {
    blockMenuActiveRef.current = index;
    setBlockMenuActive(index);
  }, []);

  const runBlockAction = useCallback((action: BlockMenuAction) => {
    const view = viewRef.current;
    const menu = blockMenu;
    if (!view || !menu) return;
    if (!isCrepeBlockMenuDocCurrent(view.state.doc, menu.doc)) {
      setBlockMenu(null);
      return;
    }
    if (action === 'duplicate') duplicateCrepeBlock(view, menu.pos);
    else if (action === 'delete') deleteCrepeBlock(view, menu.pos);
    else turnCrepeBlockInto(view, menu.pos, action);
    setBlockMenu(null);
  }, [blockMenu]);

  useEffect(() => {
    if (!blockMenu) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        // 键盘导航：↑↓ 循环、Home/End 跳首尾、Enter 执行高亮项（未高亮时按原契约关闭菜单）
        const navIndex = getNextCrepeBlockMenuIndex({
          key: event.key,
          activeIndex: blockMenuActiveRef.current,
          itemCount: BLOCK_MENU_ACTIONS.length,
        });
        if (navIndex !== null) {
          event.preventDefault();
          event.stopPropagation();
          setBlockMenuActiveIndex(navIndex);
          return;
        }
        if (event.key === 'Enter' && blockMenuActiveRef.current >= 0) {
          event.preventDefault();
          event.stopPropagation();
          runBlockAction(BLOCK_MENU_ACTIONS[blockMenuActiveRef.current]);
          return;
        }
        // typeahead 先于 dismiss：单个可打印字符先尝试按 label 前缀命中
        if (
          event.key.length === 1
          && !event.metaKey && !event.ctrlKey && !event.altKey
          && !event.isComposing
        ) {
          const typeaheadIndex = findCrepeBlockMenuTypeaheadIndex(
            BLOCK_MENU_ACTIONS.map(getBlockMenuActionLabel),
            event.key,
            blockMenuActiveRef.current,
          );
          if (typeaheadIndex !== null) {
            event.preventDefault();
            event.stopPropagation();
            setBlockMenuActiveIndex(typeaheadIndex);
            return;
          }
        }
        const editorTarget = event.target instanceof Element
          && Boolean(event.target.closest('.ProseMirror'));
        if (!shouldDismissCrepeBlockMenuForKey({
          key: event.key,
          editorTarget,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          isComposing: event.isComposing,
        })) return;
      } else if (event.target instanceof Element && event.target.closest('.crepe-block-menu')) {
        return;
      }
      setBlockMenu(null);
    };
    const closeOnBeforeInput = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.ProseMirror')) {
        setBlockMenu(null);
      }
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close, true);
    window.addEventListener('beforeinput', closeOnBeforeInput, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close, true);
      window.removeEventListener('beforeinput', closeOnBeforeInput, true);
      window.removeEventListener('resize', close);
    };
  }, [blockMenu, runBlockAction, setBlockMenuActiveIndex]);
  
  // 保持回调/配置引用最新（初始化 effect 只依赖 noteId，闭包内一律经 ref 读取）
  onChangeRef.current = onChange;
  onReadyRef.current = onReady;
  onDestroyRef.current = onDestroy;
  onFocusRef.current = onFocus;
  onBlurRef.current = onBlur;
  placeholderRef.current = placeholder;
  pluginsOptionsRef.current = pluginsOptions;

  // 同步 defaultValue 到 ref（不触发编辑器重新初始化）
  useEffect(() => {
    defaultValueRef.current = defaultValue;
  }, [defaultValue]);

  const clearExposeTimeouts = useCallback(() => {
    exposeTimeoutsRef.current.forEach((timeoutId) => {
      clearTimeout(timeoutId);
    });
    exposeTimeoutsRef.current = [];
  }, []);

  /**
   * 构建 API 对象
   */
  const buildApi = useCallback((): CrepeEditorApi => {
    // 注意：不要在这里捕获 crepeRef.current，而是在每个方法调用时动态读取
    // 否则会导致闭包捕获到初始的 null 值
    
    return {
      getMarkdown: () => {
        const crepe = crepeRef.current;
        if (!crepe) return '';
        try {
          return crepe.getMarkdown();
        } catch (e) {
          debugLog.error('[CrepeEditor] getMarkdown failed:', e);
          return '';
        }
      },
      
      setMarkdown: (markdown: string) => {
        const crepe = crepeRef.current;
        if (!crepe) return false;
        try {
          // Milkdown 版本类型差异，运行时兼容
          (crepe.editor as any).action(replaceAll(markdown));
          return true;
        } catch (e) {
          debugLog.error('[CrepeEditor] setMarkdown failed:', e);
          return false;
        }
      },

      captureSelection: () => {
        const crepe = crepeRef.current;
        if (!crepe) return null;
        try {
          const view = crepe.editor.ctx.get(editorViewCtx);
          if (!view?.state?.selection) return null;
          return {
            from: view.state.selection.from,
            to: view.state.selection.to,
          };
        } catch {
          return null;
        }
      },

      hasFocus: () => {
        const crepe = crepeRef.current;
        if (!crepe) return false;
        try {
          const view = crepe.editor.ctx.get(editorViewCtx);
          return Boolean(view?.hasFocus?.());
        } catch {
          return false;
        }
      },

      restoreSelection: (snapshot) => {
        if (!snapshot) return;
        const crepe = crepeRef.current;
        if (!crepe) return;
        try {
          const view = crepe.editor.ctx.get(editorViewCtx);
          if (!view?.state?.doc || !view.dispatch) return;
          const docSize = view.state.doc.content.size;
          const from = Math.max(0, Math.min(snapshot.from, docSize));
          const to = Math.max(from, Math.min(snapshot.to, docSize));
          const selection = TextSelection.create(view.state.doc, from, to);
          view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
          view.focus();
        } catch (e) {
          debugLog.error('[CrepeEditor] restoreSelection failed:', e);
        }
      },
      
      focus: () => {
        const crepe = crepeRef.current;
        if (!crepe) return;
        try {
          crepe.editor.action((ctx) => {
            // 优先使用字符串 key（Milkdown 7.x 推荐方式）
            let view: any = null;
            try {
              view = ctx.get('editorView' as any);
            } catch {
              try {
                view = ctx.get(editorViewCtx);
              } catch {
                // 编辑器可能还未完全初始化
              }
            }
            if (view) {
              view.focus();
            }
          });
        } catch (e) {
          debugLog.error('[CrepeEditor] focus failed:', e);
        }
      },
      
      isReadonly: () => {
        return crepeRef.current?.readonly ?? false;
      },
      
      setReadonly: (value: boolean) => {
        crepeRef.current?.setReadonly(value);
      },
      
      scrollToHeading: (
        text: string,
        level: number,
        normalizedText?: string,
        matchesHeading?: (docHeadingText: string) => boolean
      ) => {
        const crepe = crepeRef.current;
        if (!crepe) {
          emitOutlineDebugLog({
            category: 'error',
            action: 'crepe:scrollToHeading:noCrepe',
            level: 'error',
            details: { noteId: noteId ?? null, text, level, hasCrepeRef: !!crepeRef.current },
          });
          return;
        }
        
        try {
          // 多种方式尝试获取 ProseMirror view
          let view: any = null;
          let viewSource = 'none';
          
          // 方式0: 优先使用已缓存的 viewRef
          if (viewRef.current?.state && viewRef.current?.dispatch) {
            view = viewRef.current;
            viewSource = 'viewRef';
          }
          
          // 方式1: 使用字符串 key 'editorView'（Milkdown 内部用法）
          if (!view) {
            try {
              view = crepe.editor.ctx.get('editorView' as any);
              if (view?.state && view?.dispatch) {
                viewSource = 'ctx-string';
                viewRef.current = view; // 缓存到 ref
              } else {
                view = null;
              }
            } catch {
              // 忽略
            }
          }
          
          // 方式2: 使用 editorViewCtx symbol
          if (!view) {
            try {
              view = crepe.editor.ctx.get(editorViewCtx);
              if (view?.state && view?.dispatch) {
                viewSource = 'ctx-symbol';
                viewRef.current = view; // 缓存到 ref
              } else {
                view = null;
              }
            } catch {
              // 忽略
            }
          }
          
          // 方式3: 使用全局暴露的 view（在初始化时设置）
          if (!view) {
            const globalView = (window as any).__MILKDOWN_VIEW__;
            if (globalView?.state && globalView?.dispatch) {
              view = globalView;
              viewSource = 'global';
              viewRef.current = view; // 缓存到 ref
            }
          }
          
          // 方式4: 通过 action 回调同步获取
          if (!view) {
            try {
              crepe.editor.action((ctx) => {
                try {
                  const v = ctx.get('editorView' as any) as { state?: unknown; dispatch?: unknown } | null;
                  if (v?.state && v?.dispatch) {
                    view = v;
                    viewSource = 'action-string';
                    viewRef.current = v; // 缓存到 ref
                  }
                } catch {
                  try {
                    const v = ctx.get(editorViewCtx);
                    if (v?.state && v?.dispatch) {
                      view = v;
                      viewSource = 'action-symbol';
                      viewRef.current = v; // 缓存到 ref
                    }
                  } catch {
                    // 忽略
                  }
                }
              });
            } catch {
              // 忽略
            }
          }
          
          if (!view) {
            emitOutlineDebugLog({
              category: 'editor',
              action: 'crepe:scrollToHeading:allMethodsFailed',
              level: 'warn',
              details: {
                noteId: noteId ?? null,
                hasGlobalView: !!(window as any).__MILKDOWN_VIEW__,
                hasGlobalCtx: !!(window as any).__MILKDOWN_CTX__,
              },
            });
          }
          
          if (!view) {
            emitOutlineDebugLog({
              category: 'error',
              action: 'crepe:scrollToHeading:noView',
              level: 'error',
              details: { 
                noteId: noteId ?? null, 
                text, 
                level,
                hasCrepe: !!crepe,
                hasEditor: !!crepe?.editor,
                hasCtx: !!crepe?.editor?.ctx,
                hasContainer: !!containerRef.current,
              },
            });
            return;
          }
          
          emitOutlineDebugLog({
            category: 'editor',
            action: 'crepe:scrollToHeading:viewObtained',
            details: { noteId: noteId ?? null, viewSource, text, level },
          });
          
          const doc = view.state.doc;
          const searchText = (normalizedText ?? text).toLowerCase().trim();
          
          // 遍历文档查找匹配的标题
          let targetPos = -1;
          let bestMatch: { pos: number; score: number } | null = null;
          
          doc.descendants((node, pos) => {
            // 检查是否是标题节点
            if (node.type.name === 'heading' && (level < 1 || node.attrs?.level === level)) {
              const rawText = node.textContent;
              const nodeText = rawText.toLowerCase().trim();
              
              // 精确匹配优先（调用方谓词可注入全半角/中文标点规范化）
              if (matchesHeading ? matchesHeading(rawText) : nodeText === searchText) {
                targetPos = pos;
                return false; // 精确匹配，立即停止
              }
              
              // 计算匹配分数（用于模糊匹配）
              let score = 0;
              if (searchText && nodeText.includes(searchText)) score = searchText.length / nodeText.length;
              else if (searchText && searchText.includes(nodeText)) score = nodeText.length / searchText.length * 0.8;
              
              if (score > 0 && (!bestMatch || score > bestMatch.score)) {
                bestMatch = { pos, score };
              }
            }
            return true;
          });
          
          // 使用精确匹配或最佳模糊匹配
          const finalPos = targetPos >= 0 ? targetPos : bestMatch?.pos;

          emitOutlineDebugLog({
            category: 'editor',
            action: 'crepe:scrollToHeading:matchResult',
            details: {
              noteId: noteId ?? null,
              searchText,
              requestedLevel: level,
              exactMatch: targetPos >= 0,
              bestMatchScore: bestMatch?.score ?? null,
              targetPos: finalPos ?? null,
              docSize: doc.nodeSize,
            },
          });
          
          if (finalPos !== undefined && finalPos >= 0) {
            // 定位到对应 heading，使编辑器自身滚动到视口
            const resolvedPos = Math.min(finalPos + 1, view.state.doc.nodeSize - 2);
            const selection = TextSelection.near(view.state.doc.resolve(resolvedPos));
            const tr = view.state.tr.setSelection(selection);
            view.dispatch(tr);
            view.focus();

            emitOutlineDebugSnapshot({
              noteId: noteId ?? null,
              heading: {
                text,
                normalized: searchText,
                level,
              },
              scrollEvent: {
                reason: 'crepe:scrollToHeading:selection',
                targetPos: finalPos,
                resolvedPos,
                exactMatch: targetPos >= 0,
              },
              editorState: {
                hasView: true,
                hasSelection: true,
                selectionFrom: selection.from,
                selectionTo: selection.to,
                containerScrollTop: (view.dom as HTMLElement)?.parentElement?.scrollTop ?? null,
                containerScrollHeight: (view.dom as HTMLElement)?.parentElement?.scrollHeight ?? null,
                containerClientHeight: (view.dom as HTMLElement)?.parentElement?.clientHeight ?? null,
              },
            });

            // 额外兜底：若编辑器未自动滚动，则手动滚动 DOM
            requestAnimationFrame(() => {
              let headingElement: Element | null = null;
              
              // 方式1: 使用 ProseMirror nodeDOM 获取精确节点
              try {
                const $pos = view.state.doc.resolve(finalPos);
                const nodeDOM = view.nodeDOM($pos.before($pos.depth)) as Element | null;
                if (nodeDOM?.tagName?.match(/^H[1-6]$/)) {
                  headingElement = nodeDOM;
                } else if (nodeDOM) {
                  headingElement = nodeDOM.querySelector('h1, h2, h3, h4, h5, h6');
                }
              } catch {
                // 忽略
              }
              
              // 方式2: 通过 domAtPos + closest 查找
              if (!headingElement) {
                try {
                  const domAtPos = view.domAtPos(finalPos);
                  const element = domAtPos.node instanceof Element 
                    ? domAtPos.node 
                    : domAtPos.node.parentElement;
                  headingElement = element?.closest('h1, h2, h3, h4, h5, h6') ?? null;
                } catch {
                  // 忽略
                }
              }
              
              // 方式3: 在编辑器容器中按文本和级别查找标题
              if (!headingElement && containerRef.current && level >= 1 && level <= 6) {
                const selector = `h${level}`;
                const candidates = containerRef.current.querySelectorAll(selector);
                for (const el of candidates) {
                  if (el.textContent?.toLowerCase().trim() === searchText) {
                    headingElement = el;
                    break;
                  }
                }
              }
              
              // 方式4: 查找所有标题，找文本匹配的
              if (!headingElement && containerRef.current) {
                const allHeadings = containerRef.current.querySelectorAll('h1, h2, h3, h4, h5, h6');
                for (const el of allHeadings) {
                  if (el.textContent?.toLowerCase().trim() === searchText) {
                    headingElement = el;
                    break;
                  }
                }
              }
              
              if (headingElement) {
                headingElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                // 定位闪烁：帮助用户在长文档中锁定跳转目标（reduced-motion 由 CSS 关停）
                headingElement.classList.remove('crepe-heading-locate-flash');
                // 强制 reflow 以便连续点击同一标题时重新播放动画
                void (headingElement as HTMLElement).offsetWidth;
                headingElement.classList.add('crepe-heading-locate-flash');
                const flashTarget = headingElement;
                window.setTimeout(() => {
                  flashTarget.classList.remove('crepe-heading-locate-flash');
                }, 1300);
                emitOutlineDebugLog({
                  category: 'dom',
                  action: 'crepe:scrollToHeading:domScroll',
                  details: {
                    noteId: noteId ?? null,
                    headingText: text,
                    tagName: headingElement.tagName,
                    textContent: headingElement.textContent?.slice(0, 50),
                  },
                });
              } else {
                emitOutlineDebugLog({
                  category: 'error',
                  action: 'crepe:scrollToHeading:domMissing',
                  level: 'warn',
                  details: {
                    noteId: noteId ?? null,
                    headingText: text,
                    containerHasHeadings: containerRef.current?.querySelectorAll('h1, h2, h3, h4, h5, h6').length ?? 0,
                  },
                });
              }
            });
          } else {
            emitOutlineDebugLog({
              category: 'error',
              action: 'crepe:scrollToHeading:notFound',
              level: 'warn',
              details: {
                noteId: noteId ?? null,
                searchText,
                level,
              },
            });
          }
        } catch (e) {
          debugLog.error('[CrepeEditor] scrollToHeading failed:', e);
          emitOutlineDebugLog({
            category: 'error',
            action: 'crepe:scrollToHeading:exception',
            level: 'error',
            details: {
              noteId: noteId ?? null,
              message: e instanceof Error ? e.message : String(e),
            },
          });
        }
      },
      
      getCrepe: () => crepeRef.current,
      
      destroy: async () => {
        const crepe = crepeRef.current;
        if (crepe) {
          runStashedCrepeCleanups(crepe);
          clearMilkdownDebugGlobals(crepe, viewRef.current);
          await crepe.destroy();
          crepeRef.current = null;
          viewRef.current = null;
        }
      },
      
      insertAtCursor: (text: string) => {
        const crepe = crepeRef.current;
        if (!crepe) return;
        try {
          crepe.editor.action((ctx) => {
            // 优先使用字符串 key（Milkdown 7.x 推荐方式）
            let view: any = null;
            try {
              view = ctx.get('editorView' as any);
            } catch {
              view = ctx.get(editorViewCtx);
            }
            if (!view) return;
            
            const { state, dispatch } = view;
            const { from } = state.selection;
            const tr = state.tr.insertText(text, from);
            dispatch(tr);
            view.focus();
          });
        } catch (e) {
          debugLog.error('[CrepeEditor] insertAtCursor failed:', e);
        }
      },

      // ===== ACR agent API（R1-12）——不抢焦点、不进用户 undo =====
      agentInsert: (text: string, pos: number) => {
        const crepe = crepeRef.current;
        if (!crepe || !text) return null;
        let result: { from: number; to: number; cursor: number } | null = null;
        try {
          crepe.editor.action((ctx) => {
            let view: any = null;
            try {
              view = ctx.get('editorView' as any);
            } catch {
              view = ctx.get(editorViewCtx);
            }
            if (!view) return;

            const { state, dispatch } = view;
            const { transaction: tr, from, to, cursor } = createAgentInsertTransaction(state, text, pos);
            tr.setMeta('addToHistory', false);
            // 记录完整结构插入范围；块边界插入时再把 caret 拉回文本块内。
            tr.setMeta(agentHighlightKey, {
              type: 'insert',
              from,
              to,
            } satisfies AgentHighlightMeta);
            dispatch(tr);
            if (cursor !== to) {
              dispatch(view.state.tr.setMeta(agentHighlightKey, {
                type: 'caret',
                pos: cursor,
              } satisfies AgentHighlightMeta));
            }
            result = { from, to, cursor };
            // ACR 4.0：打字机演出的节流滚动跟随（AI 光标越出视口时温和滚入）
            const follower = agentFollowerRef.current
              ?? (agentFollowerRef.current = new AgentScrollFollower());
            follower.followPos(view, cursor);
          });
        } catch (e) {
          debugLog.error('[CrepeEditor] agentInsert failed:', e);
        }
        return result;
      },

      agentInsertMarkdown: (markdown: string, pos: number) => {
        const crepe = crepeRef.current;
        if (!crepe || !markdown) return null;
        try {
          let result: { from: number; to: number; cursor: number } | null = null;
          crepe.editor.action((ctx) => {
            let view: any = null;
            try {
              view = ctx.get('editorView' as any);
            } catch {
              view = ctx.get(editorViewCtx);
            }
            if (!view) return;

            const parsed = ctx.get(parserCtx)(markdown);
            if (!parsed) return;
            const insertPos = Math.max(0, Math.min(pos, view.state.doc.content.size));
            const tr = view.state.tr.replace(
              insertPos,
              insertPos,
              new Slice(parsed.content, 0, 0),
            );
            const from = tr.mapping.map(insertPos, -1);
            const to = tr.mapping.map(insertPos, 1);
            tr.setMeta('addToHistory', false);
            tr.setMeta(agentHighlightKey, {
              type: 'insert',
              from,
              to,
            } satisfies AgentHighlightMeta);
            view.dispatch(tr);
            result = { from, to, cursor: to };
            // ACR 4.0：结构化插入同样参与滚动跟随
            const follower = agentFollowerRef.current
              ?? (agentFollowerRef.current = new AgentScrollFollower());
            follower.followPos(view, to);
          });
          return result;
        } catch (e) {
          debugLog.error('[CrepeEditor] agentInsertMarkdown failed:', e);
          return null;
        }
      },

      agentSignal: (meta: AgentHighlightMeta) => {
        const crepe = crepeRef.current;
        if (!crepe) return;
        try {
          crepe.editor.action((ctx) => {
            let view: any = null;
            try {
              view = ctx.get('editorView' as any);
            } catch {
              view = ctx.get(editorViewCtx);
            }
            if (!view) return;
            const tr = view.state.tr.setMeta(agentHighlightKey, meta);
            view.dispatch(tr);
            // ACR 4.0：caret 落点（run 起始/重定位）也做一次跟随
            if (meta.type === 'caret') {
              const follower = agentFollowerRef.current
                ?? (agentFollowerRef.current = new AgentScrollFollower());
              follower.followPos(view, meta.pos);
            }
          });
        } catch (e) {
          debugLog.error('[CrepeEditor] agentSignal failed:', e);
        }
      },

      // ACR 4.0：破坏类直改（note_replace/note_set）后的变更区域演出
      agentFlashChange: (previousMarkdown: string, nextMarkdown: string) => {
        const crepe = crepeRef.current;
        if (!crepe) return false;
        const located = resolveFlashSnippet(previousMarkdown, nextMarkdown);
        if (!located) return false; // 两文一致，无需演出

        let performed = false;
        try {
          crepe.editor.action((ctx) => {
            let view: any = null;
            try {
              view = ctx.get('editorView' as any);
            } catch {
              view = ctx.get(editorViewCtx);
            }
            if (!view) return;

            // 在文档 textblock 中检索差异片段 → 高亮承载段落并滚入视口
            let blockFrom = -1;
            let blockTo = -1;
            if (located.snippet) {
              view.state.doc.descendants((node: any, pos: number) => {
                if (blockFrom >= 0) return false;
                if (node.isTextblock && typeof node.textContent === 'string'
                  && node.textContent.includes(located.snippet)) {
                  blockFrom = pos + 1;
                  blockTo = pos + node.nodeSize - 1;
                  return false;
                }
                return true;
              });
            }

            if (blockFrom >= 0 && blockTo > blockFrom) {
              view.dispatch(view.state.tr.setMeta(agentHighlightKey, {
                type: 'flash',
                from: blockFrom,
                to: blockTo,
              } satisfies AgentHighlightMeta));
              const follower = agentFollowerRef.current
                ?? (agentFollowerRef.current = new AgentScrollFollower());
              follower.followPos(view, blockFrom, true);
              performed = true;
              return;
            }

            // 退化路径：整个内容区一次轻微 opacity 脉冲（reduced-motion 下 CSS 关停）
            const wrapper = wrapperRef.current;
            if (wrapper) {
              wrapper.classList.remove('crepe-agent-pulse');
              // 强制重排以便连续调用能重启动画
              void wrapper.offsetWidth;
              wrapper.classList.add('crepe-agent-pulse');
              if (agentPulseTimerRef.current != null) {
                window.clearTimeout(agentPulseTimerRef.current);
              }
              // 时长单源：CSS --acr-doc-pulse-ms + 缓冲（旧值 900 与 CSS 0.6s 双源漂移）
              agentPulseTimerRef.current = window.setTimeout(() => {
                agentPulseTimerRef.current = null;
                wrapper.classList.remove('crepe-agent-pulse');
              }, readCssTimeMs('--acr-doc-pulse-ms', 600) + 250);
              performed = true;
            }
          });
        } catch (e) {
          debugLog.error('[CrepeEditor] agentFlashChange failed:', e);
        }
        return performed;
      },

      getDocEndPos: () => {
        const crepe = crepeRef.current;
        if (!crepe) return 0;
        try {
          const view = crepe.editor.ctx.get(editorViewCtx);
          return view?.state?.doc?.content?.size ?? 0;
        } catch {
          try {
            let size = 0;
            crepe.editor.action((ctx) => {
              const view = ctx.get(editorViewCtx);
              size = view?.state?.doc?.content?.size ?? 0;
            });
            return size;
          } catch {
            return 0;
          }
        }
      },

      resolveHeadingPos: (heading: string) => {
        const crepe = crepeRef.current;
        if (!crepe || !heading.trim()) return null;
        try {
          let result: number | null = null;
          crepe.editor.action((ctx) => {
            let view: any = null;
            try {
              view = ctx.get('editorView' as any);
            } catch {
              view = ctx.get(editorViewCtx);
            }
            if (!view?.state?.doc) return;

            const doc = view.state.doc;
            const searchText = heading.toLowerCase().trim();
            let bestMatch: { pos: number; nodeSize: number; score: number } | null = null;

            doc.descendants((node: { type: { name: string }; textContent: string; nodeSize: number }, pos: number) => {
              if (node.type.name !== 'heading') return true;
              const nodeText = node.textContent.toLowerCase().trim();
              if (nodeText === searchText) {
                bestMatch = { pos, nodeSize: node.nodeSize, score: 1 };
                return false;
              }
              let score = 0;
              if (searchText && nodeText.includes(searchText)) {
                score = searchText.length / Math.max(nodeText.length, 1);
              } else if (searchText && searchText.includes(nodeText) && nodeText) {
                score = (nodeText.length / searchText.length) * 0.8;
              }
              if (score > 0 && (!bestMatch || score > bestMatch.score)) {
                bestMatch = { pos, nodeSize: node.nodeSize, score };
              }
              return true;
            });

            if (!bestMatch) return;
            // 标题节点之后：pos + nodeSize 为紧随其后的插入点
            result = Math.min(bestMatch.pos + bestMatch.nodeSize, doc.content.size);
          });
          return result;
        } catch (e) {
          debugLog.error('[CrepeEditor] resolveHeadingPos failed:', e);
          return null;
        }
      },
      
      wrapSelection: (before: string, after: string) => {
        const crepe = crepeRef.current;
        if (!crepe) return;
        try {
          crepe.editor.action((ctx) => {
            // 优先使用字符串 key（Milkdown 7.x 推荐方式）
            let view: any = null;
            try {
              view = ctx.get('editorView' as any);
            } catch {
              view = ctx.get(editorViewCtx);
            }
            if (!view) return;
            
            const { state, dispatch } = view;
            const { from, to, empty } = state.selection;
            
            if (empty) {
              // 没有选中文本：插入前后标记并将光标置于中间
              const insertText = before + after;
              const tr = state.tr.insertText(insertText, from);
              // 将光标移动到 before 和 after 之间
              const newPos = from + before.length;
              tr.setSelection(TextSelection.create(tr.doc, newPos));
              dispatch(tr);
            } else {
              // 有选中文本：用标记包裹选中内容
              const selectedText = state.doc.textBetween(from, to);
              const wrappedText = before + selectedText + after;
              const tr = state.tr.insertText(wrappedText, from, to);
              dispatch(tr);
            }
            view.focus();
          });
        } catch (e) {
          debugLog.error('[CrepeEditor] wrapSelection failed:', e);
        }
      },
      
      toggleLinePrefix: (prefix: string) => {
        const crepe = crepeRef.current;
        if (!crepe) return;
        try {
          crepe.editor.action((ctx) => {
            // 优先使用字符串 key（Milkdown 7.x 推荐方式）
            let view: any = null;
            try {
              view = ctx.get('editorView' as any);
            } catch {
              view = ctx.get(editorViewCtx);
            }
            if (!view) return;
            
            const { state, dispatch } = view;
            const { from } = state.selection;
            
            // 找到当前段落/块的开始位置
            const $from = state.doc.resolve(from);
            // 使用 depth 1 来获取顶层块节点的边界，更可靠
            const depth = $from.depth > 0 ? 1 : 0;
            const blockStart = $from.start(depth);
            const blockEnd = $from.end(depth);
            const blockText = state.doc.textBetween(blockStart, blockEnd);
            
            // 检查当前块是否已有此前缀
            const prefixWithSpace = prefix.endsWith(' ') ? prefix : prefix + ' ';
            
            if (blockText.startsWith(prefixWithSpace)) {
              // 移除前缀
              const tr = state.tr.delete(blockStart, blockStart + prefixWithSpace.length);
              dispatch(tr);
            } else if (blockText.match(/^(#{1,6}|>|-|\*|\d+\.|- \[[ x]\])\s/)) {
              // 当前块有其他块级前缀，替换它
              const match = blockText.match(/^(#{1,6}|>|-|\*|\d+\.|- \[[ x]\])\s/);
              if (match) {
                const tr = state.tr.insertText(prefixWithSpace, blockStart, blockStart + match[0].length);
                dispatch(tr);
              }
            } else {
              // 添加前缀
              const tr = state.tr.insertText(prefixWithSpace, blockStart);
              dispatch(tr);
            }
            view.focus();
          });
        } catch (e) {
          debugLog.error('[CrepeEditor] toggleLinePrefix failed:', e);
        }
      },
      
      insertNewLineWithPrefix: (prefix: string) => {
        const crepe = crepeRef.current;
        if (!crepe) return;
        try {
          crepe.editor.action((ctx) => {
            // 优先使用字符串 key（Milkdown 7.x 推荐方式）
            let view: any = null;
            try {
              view = ctx.get('editorView' as any);
            } catch {
              view = ctx.get(editorViewCtx);
            }
            if (!view) return;
            
            const { state, dispatch } = view;
            const { from } = state.selection;
            
            // 在当前位置插入换行和前缀
            const prefixWithSpace = prefix.endsWith(' ') ? prefix : prefix + ' ';
            const insertText = '\n' + prefixWithSpace;
            const tr = state.tr.insertText(insertText, from);
            dispatch(tr);
            view.focus();
          });
        } catch (e) {
          debugLog.error('[CrepeEditor] insertNewLineWithPrefix failed:', e);
        }
      },
      
      // ===== Milkdown 命令 API =====
      // 使用 ProseMirror 命令直接操作，避免与 Crepe 内置模块冲突
      
      toggleBold: () => {
        const view = viewRef.current;
        if (!view) return;
        try {
          const markType = view.state.schema.marks.strong;
          if (markType) {
            toggleMark(markType)(view.state, view.dispatch);
            view.focus();
          }
        } catch (e) {
          debugLog.error('[CrepeEditor] toggleBold failed:', e);
        }
      },
      
      toggleItalic: () => {
        const view = viewRef.current;
        if (!view) return;
        try {
          const markType = view.state.schema.marks.emphasis;
          if (markType) {
            toggleMark(markType)(view.state, view.dispatch);
            view.focus();
          }
        } catch (e) {
          debugLog.error('[CrepeEditor] toggleItalic failed:', e);
        }
      },
      
      toggleStrikethrough: () => {
        const view = viewRef.current;
        if (!view) return;
        try {
          // Milkdown GFM 中删除线的 schema 名称是 strike_through（带下划线）
          const markType = view.state.schema.marks.strike_through || view.state.schema.marks.strikethrough;
          if (markType) {
            toggleMark(markType)(view.state, view.dispatch);
            view.focus();
          }
        } catch (e) {
          debugLog.error('[CrepeEditor] toggleStrikethrough failed:', e);
        }
      },
      
      toggleInlineCode: () => {
        const view = viewRef.current;
        if (!view) return;
        try {
          const markType = view.state.schema.marks.inlineCode || view.state.schema.marks.code;
          if (markType) {
            toggleMark(markType)(view.state, view.dispatch);
            view.focus();
          }
        } catch (e) {
          debugLog.error('[CrepeEditor] toggleInlineCode failed:', e);
        }
      },
      
      setHeading: (level: number) => {
        const view = viewRef.current;
        if (!view) return;
        try {
          const nodeType = view.state.schema.nodes.heading;
          if (nodeType) {
            setBlockType(nodeType, { level })(view.state, view.dispatch);
            view.focus();
          }
        } catch (e) {
          debugLog.error('[CrepeEditor] setHeading failed:', e);
        }
      },
      
      toggleBulletList: () => {
        const view = viewRef.current;
        if (!view) return;
        try {
          const nodeType = view.state.schema.nodes.bullet_list || view.state.schema.nodes.bulletList;
          if (nodeType) {
            wrapIn(nodeType)(view.state, view.dispatch);
            view.focus();
          }
        } catch (e) {
          debugLog.error('[CrepeEditor] toggleBulletList failed:', e);
        }
      },
      
      toggleOrderedList: () => {
        const view = viewRef.current;
        if (!view) return;
        try {
          const nodeType = view.state.schema.nodes.ordered_list || view.state.schema.nodes.orderedList;
          if (nodeType) {
            wrapIn(nodeType)(view.state, view.dispatch);
            view.focus();
          }
        } catch (e) {
          debugLog.error('[CrepeEditor] toggleOrderedList failed:', e);
        }
      },
      
      toggleTaskList: () => {
        const crepe = crepeRef.current;
        if (!crepe) return;
        try {
          // 使用 Milkdown 命令系统创建任务列表
          // 任务列表在 Milkdown 中是带有 checked 属性的 list_item
          crepe.editor.action((ctx) => {
            try {
              const commands = ctx.get(commandsCtx);
              const listItem = listItemSchema.type(ctx);
              commands.call(wrapInBlockTypeCommand.key, {
                nodeType: listItem,
                attrs: { checked: false },
              });
            } catch (innerError) {
              debugLog.error('[CrepeEditor] toggleTaskList action failed:', innerError);
            }
          });
          // 聚焦编辑器
          const view = viewRef.current;
          if (view) view.focus();
        } catch (e) {
          debugLog.error('[CrepeEditor] toggleTaskList failed:', e);
        }
      },
      
      toggleBlockquote: () => {
        const view = viewRef.current;
        if (!view) return;
        try {
          const nodeType = view.state.schema.nodes.blockquote;
          if (nodeType) {
            wrapIn(nodeType)(view.state, view.dispatch);
            view.focus();
          }
        } catch (e) {
          debugLog.error('[CrepeEditor] toggleBlockquote failed:', e);
        }
      },
      
      insertHr: () => {
        const view = viewRef.current;
        if (!view) return;
        try {
          const nodeType = view.state.schema.nodes.hr || view.state.schema.nodes.horizontal_rule;
          if (nodeType) {
            const { tr } = view.state;
            const node = nodeType.create();
            view.dispatch(tr.replaceSelectionWith(node).scrollIntoView());
            view.focus();
          }
        } catch (e) {
          debugLog.error('[CrepeEditor] insertHr failed:', e);
        }
      },
      
      insertCodeBlock: () => {
        const view = viewRef.current;
        if (!view) return;
        try {
          const nodeType = view.state.schema.nodes.code_block || view.state.schema.nodes.codeBlock;
          if (nodeType) {
            setBlockType(nodeType)(view.state, view.dispatch);
            view.focus();
          }
        } catch (e) {
          debugLog.error('[CrepeEditor] insertCodeBlock failed:', e);
        }
      },
      
      insertLink: (href?: string, text?: string) => {
        const view = viewRef.current;
        const crepe = crepeRef.current;
        if (!view) return;
        try {
          const markType = view.state.schema.marks.link;
          if (!markType) return;

          const trimmedHref = isNonEmptyHref(href) ? href!.trim() : '';

          // 无有效 href：绝不插入空链接；打开 LinkTooltip 编辑流程（工具栏调用方不传 href）
          if (!trimmedHref) {
            if (crepe) {
              crepe.editor.action((ctx) => {
                const { from, to } = view.state.selection;
                const api = ctx.get(linkTooltipAPI.key);
                api.addLink(from, to);
              });
              view.focus();
              return;
            }
            showGlobalNotification(
              'info',
              i18next.t('notes:crepe.link.href_required'),
            );
            view.focus();
            return;
          }

          const { from, empty } = view.state.selection;
          if (empty) {
            const linkText = text || trimmedHref;
            const linkMark = markType.create({ href: trimmedHref });
            const tr = view.state.tr.insertText(linkText, from);
            tr.addMark(from, from + linkText.length, linkMark);
            view.dispatch(tr);
          } else {
            toggleMark(markType, { href: trimmedHref })(view.state, view.dispatch);
          }
          view.focus();
        } catch (e) {
          debugLog.error('[CrepeEditor] insertLink failed:', e);
        }
      },
      
      insertImage: (src?: string, alt?: string) => {
        const view = viewRef.current;
        if (!view) return;
        try {
          const nodeType = view.state.schema.nodes.image;
          if (nodeType) {
            const node = nodeType.create({ src: src || '', alt: alt || '' });
            const { tr } = view.state;
            view.dispatch(tr.replaceSelectionWith(node).scrollIntoView());
            view.focus();
          }
        } catch (e) {
          debugLog.error('[CrepeEditor] insertImage failed:', e);
        }
      },
      
      insertTable: () => {
        const view = viewRef.current;
        if (!view) return;
        try {
          const tableType = view.state.schema.nodes.table;
          const rowType = view.state.schema.nodes.table_row || view.state.schema.nodes.tableRow;
          const cellType = view.state.schema.nodes.table_cell || view.state.schema.nodes.tableCell;
          const headerType = view.state.schema.nodes.table_header || view.state.schema.nodes.tableHeader;
          
          if (tableType && rowType && (cellType || headerType)) {
            const cell = cellType || headerType;
            const emptyCell = cell.createAndFill();
            if (emptyCell) {
              const row = rowType.create(null, [emptyCell, cell.createAndFill()!, cell.createAndFill()!]);
              const table = tableType.create(null, [row, rowType.create(null, [cell.createAndFill()!, cell.createAndFill()!, cell.createAndFill()!])]);
              const { tr } = view.state;
              view.dispatch(tr.replaceSelectionWith(table).scrollIntoView());
              view.focus();
            }
          }
        } catch (e) {
          debugLog.error('[CrepeEditor] insertTable failed:', e);
        }
      },

      // 📱 触屏无 hover 块句柄：在当前选区顶层块处打开块操作菜单
      // （复用块句柄的 setBlockMenu 渲染路径；渲染后 useLayoutEffect 会按实测尺寸钳入视口）
      openBlockMenuAtSelection: () => {
        const view = viewRef.current;
        if (!view || view.isDestroyed) return;
        try {
          const { $from } = view.state.selection;
          const pos = $from.depth > 0 ? $from.before(1) : $from.pos;
          const coords = view.coordsAtPos(Math.min(pos + 1, view.state.doc.content.size));
          setBlockMenu({
            pos,
            x: coords.left,
            y: Math.max(8, coords.bottom + 6),
            doc: view.state.doc,
          });
        } catch (e) {
          debugLog.error('[CrepeEditor] openBlockMenuAtSelection failed:', e);
        }
      },
    };
  }, []);

  // 暴露 API 给父组件
  useImperativeHandle(ref, buildApi, [buildApi, isReady]);

  /**
   * 初始化编辑器
   */
  useEffect(() => {
    setInitPhase('useEffect-started'); // 🔧 调试：useEffect 开始
    
    if (!containerRef.current) {
      setInitPhase('error-no-container');
      emitCrepeDebug('init', 'error', 'containerRef.current 为空，无法初始化', { noteId });
      return;
    }

    let destroyed = false;
    const container = containerRef.current;
    clearExposeTimeouts();
    setInitPhase('init-starting'); // 🔧 调试：开始初始化

    emitCrepeDebug('lifecycle', 'info', '开始初始化 Crepe 编辑器', {
      noteId,
      defaultValueLength: defaultValueRef.current?.length || 0,
      readonly,
    }, captureDOMSnapshot(container));

    // 🔧 修复：等待容器尺寸稳定后再初始化
    // 关键：Learning Hub 面板展开动画期间尺寸会变化，必须等动画完成
    const waitForContainerSize = (): Promise<void> => {
      return new Promise((resolve) => {
        let lastWidth = 0;
        let lastHeight = 0;
        let stableCount = 0;
        const STABLE_THRESHOLD = 3; // 连续 3 帧尺寸不变才认为稳定
        // E2-6：容器长期 0×0（如隐藏面板）时不再永久 rAF 空转，超时后强制初始化
        const WAIT_TIMEOUT_MS = 3000;
        const startedAt = performance.now();

        const checkSize = () => {
          if (destroyed) {
            resolve();
            return;
          }
          if (performance.now() - startedAt >= WAIT_TIMEOUT_MS) {
            emitCrepeDebug('init', 'warning', '等待容器尺寸超时，强制继续初始化', {
              noteId,
              width: container.offsetWidth,
              height: container.offsetHeight,
            });
            resolve();
            return;
          }
          const { offsetWidth, offsetHeight } = container;
          
          // 检查尺寸是否为正数且稳定
          if (offsetWidth > 0 && offsetHeight > 0) {
            if (offsetWidth === lastWidth && offsetHeight === lastHeight) {
              stableCount++;
              if (stableCount >= STABLE_THRESHOLD) {
                // 尺寸已稳定，可以初始化
                resolve();
                return;
              }
            } else {
              // 尺寸变化，重置计数
              stableCount = 0;
              lastWidth = offsetWidth;
              lastHeight = offsetHeight;
            }
          }
          
          // 继续等待
          requestAnimationFrame(checkSize);
        };
        checkSize();
      });
    };

    const initEditor = async () => {
      try {
        setInitPhase('waiting-for-size');
        await waitForContainerSize();
        if (destroyed) return;
        
        // 使用 requestIdleCallback 延迟初始化，确保浏览器空闲时再创建编辑器
        setInitPhase('delay-for-stability');
        await new Promise<void>(resolve => {
          if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(() => resolve(), { timeout: 200 });
          } else {
            setTimeout(resolve, 100);
          }
        });
        if (destroyed) return;
        
        setInitPhase('creating-crepe');
        emitCrepeDebug('init', 'debug', '创建 Crepe 实例...', {
          features: ['CodeMirror', 'ListItem', 'LinkTooltip', 'Cursor', 'ImageBlock', 'BlockEdit', 'Toolbar', 'Placeholder', 'Table', 'Latex'],
        });

        // 预处理 defaultValue：保持 notes_assets 相对路径，并清理历史错误的 asset:// URL
        let processedDefaultValue = defaultValueRef.current;
        const isTauriEnvironment = typeof window !== 'undefined' &&
          Boolean((window as any).__TAURI_INTERNALS__);
        
        // NOTE: 保持 notes_assets/... 相对路径原样，交给 ImageBlock.proxyDomURL 在渲染阶段转换。
        // 这样可以避免 appDataDir 与活动数据空间（slot）不一致时生成错误 asset:// 绝对路径。
        
        // 🔧 修复：处理已有的 asset:// URL 中的编码和格式问题
        if (processedDefaultValue && processedDefaultValue.includes('asset://')) {
          const originalValue = processedDefaultValue;
          processedDefaultValue = processedDefaultValue
            .replace(/(asset:\/\/[^)\s]+)/g, (match) => {
              let fixed = match;
              // 1. 修复双重编码问题
              if (fixed.includes('%2F') || fixed.includes('%5C')) {
                fixed = fixed
                  .replace(/%2F/gi, '/')
                  .replace(/%5C/gi, '/');
              }
              // 2. 修复双斜杠问题（asset://localhost//Users -> asset://localhost/Users）
              fixed = fixed.replace(/^(asset:\/\/localhost)\/+/, '$1/');
              // 3. 历史兼容：将绝对 asset://.../notes_assets/... 还原成相对路径，
              // 避免因数据空间目录差异导致后端安全校验拒绝访问。
              const notesAssetsMatch = fixed.match(
                /^(?:asset|tauri):\/\/localhost\/.*?(notes_assets\/[^)\s"']+)$/i
              );
              if (notesAssetsMatch?.[1]) {
                fixed = notesAssetsMatch[1];
              }
              return fixed;
            });
          
          if (originalValue !== processedDefaultValue) {
            emitCrepeDebug('init', 'warning', '修复了已有 asset:// URL 中的格式问题', {
              hadIssue: true,
            });
          }
        }

        // 本实例降级上传产生的 blob URL，销毁时统一 revoke
        const blobUrlRegistry = createTransientBlobUrlRegistry();

        // 创建 Crepe 实例
        const crepe = new Crepe({
          root: container,
          defaultValue: processedDefaultValue,
          features: {
            // 启用所有内置特性
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
            // 代码块：自动换行（保留语言选择 / 复制按钮等默认配置）
            [CrepeFeature.CodeMirror]: {
              extensions: [EditorView.lineWrapping],
            },

            // 图片上传配置 + 破图占位
            [CrepeFeature.ImageBlock]: {
              ...createImageBlockConfig(noteId, blobUrlRegistry),
              onImageLoadError: (event: Event) => {
                const img = event.target;
                if (!(img instanceof HTMLImageElement)) return;
                img.classList.add('crepe-image--broken');
                if (!img.alt) {
                  img.alt = i18next.t('notes:crepe.image.load_failed');
                }
              },
            },
            
            // 占位符配置：block 模式在聚焦的空段落展示 "输入 /" 提示（对齐常见笔记编辑器）
            [CrepeFeature.Placeholder]: {
              text: placeholderRef.current || i18next.t('notes:editor.placeholder.body'),
              mode: 'block',
            },
            
            // 斜杠命令配置（使用 i18n 国际化）
            [CrepeFeature.BlockEdit]: {
              textGroup: {
                label: i18next.t('notes:slashMenu.textGroup.label'),
                text: { label: i18next.t('notes:slashMenu.textGroup.text') },
                h1: { label: i18next.t('notes:slashMenu.textGroup.h1') },
                h2: { label: i18next.t('notes:slashMenu.textGroup.h2') },
                h3: { label: i18next.t('notes:slashMenu.textGroup.h3') },
                h4: { label: i18next.t('notes:slashMenu.textGroup.h4') },
                h5: { label: i18next.t('notes:slashMenu.textGroup.h5') },
                h6: { label: i18next.t('notes:slashMenu.textGroup.h6') },
                quote: { label: i18next.t('notes:slashMenu.textGroup.quote') },
                divider: { label: i18next.t('notes:slashMenu.textGroup.divider') },
              },
              listGroup: {
                label: i18next.t('notes:slashMenu.listGroup.label'),
                bulletList: { label: i18next.t('notes:slashMenu.listGroup.bulletList') },
                orderedList: { label: i18next.t('notes:slashMenu.listGroup.orderedList') },
                taskList: { label: i18next.t('notes:slashMenu.listGroup.taskList') },
              },
              advancedGroup: {
                label: i18next.t('notes:slashMenu.advancedGroup.label'),
                image: { label: i18next.t('notes:slashMenu.advancedGroup.image') },
                codeBlock: { label: i18next.t('notes:slashMenu.advancedGroup.codeBlock') },
                table: { label: i18next.t('notes:slashMenu.advancedGroup.table') },
                math: { label: i18next.t('notes:slashMenu.advancedGroup.math') },
              },
              // A3/A4：slash 菜单追加 callout / toggle（见 docs/revamp/03|04）
              buildMenu: (builder) => {
                appendCalloutToggleSlashItems(builder);
              },
            },
            
            // 工具栏配置（使用默认）
            [CrepeFeature.Toolbar]: {
              // 可以在这里自定义工具栏按钮
            },
            
            // LaTeX 配置
            [CrepeFeature.Latex]: {
              katexOptions: {
                throwOnError: false,
              },
            },
          },
        });

        emitCrepeDebug('init', 'debug', 'Crepe 实例已创建');

        // 应用扩展插件（automd、查找高亮、wikilink/callout/toggle 等，必须在 create() 之前）
        applyCrepePlugins(crepe, pluginsOptionsRef.current);

        // 设置只读状态
        if (readonly) {
          crepe.setReadonly(true);
        }

        setInitPhase('calling-crepe-create');
        emitCrepeDebug('init', 'info', '调用 crepe.create()...', {
          containerSize: `${container.offsetWidth}x${container.offsetHeight}`,
        });
        
        await crepe.create();
        
        setInitPhase('crepe-create-done');
        emitCrepeDebug('init', 'info', 'crepe.create() 完成', undefined, captureDOMSnapshot(container));

        if (destroyed) {
          setInitPhase('destroyed-before-ready');
          emitCrepeDebug('lifecycle', 'warning', '组件已销毁，放弃初始化');
          await crepe.destroy();
          return;
        }

        crepeRef.current = crepe;
        setIsReady(true);
        setInitPhase('ready');
        
        // 暴露 crepe 实例到全局以便调试（仅 dev / debug 开关；E1-6）
        if (shouldExposeDebugGlobals()) {
          (window as any).__MILKDOWN_CREPE__ = crepe;
        }
        
        // 🔧 安全的 editor.action 包装函数：捕获编辑器销毁时的 "Context 'nodes' not found" 错误
        const safeEditorAction = (callback: (ctx: any) => void) => {
          if (destroyed) return;
          try {
            crepe.editor.action(callback);
          } catch (e) {
            // 静默处理编辑器销毁后的上下文错误
            if (String(e).includes('Context') && String(e).includes('not found')) {
              debugLog.debug('[CrepeEditor] Editor action skipped (context not available)');
            } else {
              throw e; // 重新抛出其他错误
            }
          }
        };
        
        // 使用 editor.action 获取 view（使用字符串 key 'editorView'）
        // 同时安装轻量内容监听器：避免 plugin-listener 在 IME 合成态触发大量 debounce 定时器/markdown 序列化导致卡顿。
        let viewHooked = false;
        let lastMarkdown = '';
        // E1-3 性能：记录上次整篇序列化时的 doc 引用；doc 未变（引用相等）时跳过 getMarkdown，
        // 避免大文档下选区/装饰类事务触发不必要的 O(n) 序列化。
        let lastSerializedDoc: unknown = null;
        let changeTimer: number | null = null;
        let isComposing = false;
        let zwsInsertedInComposition = false;
        const ZWS = '\u200b';
        const scheduleEmitChange = () => {
          if (destroyed || isComposing) return;
          if (changeTimer != null) window.clearTimeout(changeTimer);
          changeTimer = window.setTimeout(() => {
            if (destroyed || !crepeRef.current || isComposing) return;
            const currentDoc = viewRef.current?.state?.doc ?? null;
            if (currentDoc && currentDoc === lastSerializedDoc) return;
            let markdown = '';
            try {
              markdown = (crepeRef.current.getMarkdown() || '').split(ZWS).join('');
            } catch {
              return;
            }
            if (currentDoc) lastSerializedDoc = currentDoc;
            if (markdown === lastMarkdown) return;
            const prev = lastMarkdown;
            lastMarkdown = markdown;
            onChangeRef.current?.(markdown);
            if (debugMasterSwitch.isEnabled()) {
              emitCrepeDebug('editor', 'debug', 'Markdown 内容更新', {
                prevLength: prev?.length || 0,
                newLength: markdown?.length || 0,
              });
            }
            if (markdown.includes('```mermaid')) {
              attachMermaidObserver();
            }
          }, 250);
        };

        const exposeView = () => {
          // 检查组件是否已销毁，避免在销毁后访问 context 导致 "Context 'nodes' not found" 错误
          if (destroyed || !crepeRef.current) {
            return;
          }
          // 使用 crepeRef.current 而不是闭包中的 crepe，确保访问最新的实例
          const currentCrepe = crepeRef.current;
          try {
            currentCrepe.editor.action((ctx) => {
              try {
                // 使用字符串 key 获取 view（这是 Milkdown ctx 的正确用法）
                const view = ctx.get('editorView') as any;
                if (view && view.state && view.dispatch) {
                  if (shouldExposeDebugGlobals()) {
                    (window as any).__MILKDOWN_VIEW__ = view;
                    (window as any).__MILKDOWN_CTX__ = ctx;
                  }
                  viewRef.current = view; // 缓存到 ref 供 scrollToHeading 使用
                  if (!viewHooked) {
                    viewHooked = true;
                    try {
                      lastMarkdown = currentCrepe.getMarkdown() || '';
                    } catch {
                      lastMarkdown = '';
                    }
                    lastMarkdown = lastMarkdown.split(ZWS).join('');
                    lastSerializedDoc = view.state?.doc ?? null;

                    // 🔧 修复：使用 updateState 来监听文档变化
                    // dispatchTransaction 是 EditorView 的构造配置，不是实例方法
                    // 我们需要 hook updateState 来监听所有 state 变化
                    const originalUpdateState = view.updateState?.bind(view);
                    
                    if (originalUpdateState) {
                      view.updateState = (newState: any) => {
                        const oldState = view.state;
                        originalUpdateState(newState);
                        if (destroyed) return;

                        // E1-3 快速短路：选区/装饰类事务保持同一 doc 对象，直接跳过（O(1)）
                        if (oldState?.doc === newState?.doc) return;
                        // IME 合成期间不调度序列化（compositionend 后的 docChanged 事务会补上）
                        if (view.composing) return;

                        const docChanged = !oldState?.doc?.eq?.(newState?.doc);
                        if (docChanged) scheduleEmitChange();
                      };
                    } else {
                      // 备用方案：监听 DOM input 事件
                      debugLog.warn('[CrepeEditor] ⚠️ updateState 不存在，使用 DOM input 监听');
                      const editorDom = view.dom;
                      if (editorDom) {
                        const handleInput = () => {
                          if (destroyed) return;
                          scheduleEmitChange();
                        };
                        editorDom.addEventListener('input', handleInput);
                        // 存储清理函数
                        (crepe as any).__inputCleanup = () => {
                          editorDom.removeEventListener('input', handleInput);
                        };
                      }
                    }

                    const handleCompositionStart = () => {
                      isComposing = true;
                      zwsInsertedInComposition = false;

                      // 🔧 IME 性能修复：空段落 + IME 合成在部分 WebView/浏览器下会进入慢路径导致“每个字都卡”
                      // 处理：合成开始时若当前 textblock 为空，则插入零宽字符占位（不写入历史）以避免慢路径；
                      // 合成结束时再清理占位字符，避免污染最终 markdown。
                      try {
                        const sel = view.state.selection;
                        const $from = sel.$from;
                        const parent = $from.parent;
                        if (parent?.isTextblock && !parent.textContent) {
                          const insertPos = sel.from;
                          const tr = view.state.tr.insertText(ZWS, insertPos);
                          tr.setMeta('addToHistory', false);
                          view.dispatch(tr);
                          zwsInsertedInComposition = true;
                        }
                      } catch { /* 非关键：IME 零宽占位插入失败不影响正常输入，仅可能触发慢路径 */ }
                    };
                    const handleCompositionEnd = () => {
                      isComposing = false;
                      // 清理本段落中的零宽占位符（不写入历史）
                      if (!zwsInsertedInComposition) {
                        return;
                      }
                      try {
                        const sel = view.state.selection;
                        const $from = sel.$from;
                        // 找到最近的 textblock 深度
                        let depth = $from.depth;
                        while (depth > 0 && !$from.node(depth).isTextblock) depth -= 1;
                        if (depth > 0) {
                          const blockStart = $from.start(depth);
                          const blockEnd = $from.end(depth);
                          const zwsRanges: Array<{ from: number; to: number }> = [];
                          view.state.doc.nodesBetween(blockStart, blockEnd, (node: any, pos: number) => {
                            if (node?.isText && typeof node.text === 'string' && node.text.includes('\u200b')) {
                              const text: string = node.text;
                              for (let i = 0; i < text.length; i++) {
                                if (text[i] === '\u200b') {
                                  zwsRanges.push({ from: pos + i, to: pos + i + 1 });
                                }
                              }
                            }
                            return true;
                          });
                          if (zwsRanges.length > 0) {
                            let tr = view.state.tr;
                            // 倒序删除，避免位置偏移
                            zwsRanges.sort((a, b) => b.from - a.from).forEach((r) => {
                              tr = tr.delete(r.from, r.to);
                            });
                            tr.setMeta('addToHistory', false);
                            view.dispatch(tr);
                          }
                        }
                      } catch { /* 非关键：IME 零宽字符清理失败不影响内容，可能残留不可见字符 */ }
                      zwsInsertedInComposition = false;
                      // 交由下一次 docChanged 的 dispatchTransaction 触发 scheduleEmitChange，
                      // 避免在 compositionend 同步阶段额外触发序列化。
                    };
                    const handleFocus = () => {
                      if (destroyed) return;
                      onFocusRef.current?.();
                      if (debugMasterSwitch.isEnabled()) {
                        emitCrepeDebug('editor', 'info', '编辑器获得焦点', undefined, captureDOMSnapshot(container));
                      }
                    };
                    const handleBlur = () => {
                      if (destroyed) return;
                      onBlurRef.current?.();
                      if (debugMasterSwitch.isEnabled()) {
                        emitCrepeDebug('editor', 'debug', '编辑器失去焦点');
                      }
                    };

                    const originalHandleScrollToSelection = view.props?.handleScrollToSelection;
                    const handleScrollToSelection = (editorView: any) => {
                      if (originalHandleScrollToSelection?.(editorView)) return true;
                      return scrollSelectionIntoEditorViewport(editorView);
                    };
                    view.setProps?.({ handleScrollToSelection });

                    const dom = view.dom as HTMLElement | null;
                    dom?.addEventListener('compositionstart', handleCompositionStart, true);
                    dom?.addEventListener('compositionend', handleCompositionEnd, true);
                    dom?.addEventListener('focus', handleFocus, true);
                    dom?.addEventListener('blur', handleBlur, true);

                    (crepe as any).__viewChangeCleanup = () => {
                      /* 以下清理操作均为 best-effort：编辑器销毁阶段 view 可能已失效 */
                      try {
                        if (originalUpdateState) {
                          view.updateState = originalUpdateState;
                        }
                      } catch { /* view 可能已销毁 */ }
                      // 清理 DOM input 监听器（如果使用了备用方案）
                      try {
                        const inputCleanup = (crepe as any).__inputCleanup;
                        if (typeof inputCleanup === 'function') {
                          inputCleanup();
                        }
                      } catch { /* inputCleanup 可能已被回收 */ }
                      try {
                        if (view.props?.handleScrollToSelection === handleScrollToSelection) {
                          view.setProps?.({ handleScrollToSelection: originalHandleScrollToSelection });
                        }
                        dom?.removeEventListener('compositionstart', handleCompositionStart, true);
                        dom?.removeEventListener('compositionend', handleCompositionEnd, true);
                        dom?.removeEventListener('focus', handleFocus, true);
                        dom?.removeEventListener('blur', handleBlur, true);
                      } catch { /* DOM 元素可能已从文档移除 */ }
                      if (changeTimer != null) {
                        window.clearTimeout(changeTimer);
                        changeTimer = null;
                      }
                    };
                  }
                }
              } catch (e) {
                // 备用方案：尝试使用 editorViewCtx
                try {
                  const view = ctx.get(editorViewCtx);
                  if (view) {
                    if (shouldExposeDebugGlobals()) {
                      (window as any).__MILKDOWN_VIEW__ = view;
                      (window as any).__MILKDOWN_CTX__ = ctx;
                    }
                    viewRef.current = view; // 缓存到 ref 供 scrollToHeading 使用
                  }
                } catch (e2) {
                  // 忽略
                }
              }
            });
          } catch (e) {
            // 忽略错误
          }
        };
        
        // 立即尝试
        exposeView();
        
        // 延迟再次尝试（确保 editor 完全就绪）
        [100, 500, 1000].forEach((delay) => {
          const timeoutId = window.setTimeout(exposeView, delay);
          exposeTimeoutsRef.current.push(timeoutId);
        });

        // 🔧 安全获取 markdown 长度，避免 "Context 'nodes' not found" 错误
        let safeMarkdownLength = 0;
        try {
          safeMarkdownLength = crepe.getMarkdown()?.length || 0;
        } catch {
          // 编辑器上下文可能未完全初始化
        }
        
        emitCrepeDebug('lifecycle', 'info', '编辑器就绪，isReady=true', {
          readonly: crepe.readonly,
          markdownLength: safeMarkdownLength,
        }, captureDOMSnapshot(container), {
          crepeExists: true,
          isReady: true,
          readonly: crepe.readonly,
          noteId: noteId || null,
          markdownLength: safeMarkdownLength,
        });

        const attachMermaidObserver = () => {
          if (!container) return;
          if ((crepe as any).__mermaidCleanup) return;
          const mermaidNode = container.querySelector('pre code.language-mermaid, code.language-mermaid, .language-mermaid, .mermaid');
          if (!mermaidNode) return;
          const cleanupMermaid = createMermaidObserver(container, 300);
          (crepe as any).__mermaidCleanup = cleanupMermaid;
        };

        attachMermaidObserver();
        
        // 🔍 调试：全局监听拖拽事件（默认关闭，避免日常使用产生额外监听与日志）
        if (debugMasterSwitch.isEnabled()) {
          const debugDragEvents = (e: DragEvent) => {
            const target = e.target as HTMLElement;
            const nearBlockHandle = target.closest('.milkdown-block-handle');
            if (nearBlockHandle || e.type === 'drop') {
              debugLog.log(`[CrepeEditor] Global ${e.type}:`, {
                target: target.tagName + (target.className ? `.${target.className.split(' ')[0]}` : ''),
                nearBlockHandle: !!nearBlockHandle,
                dataTransferTypes: e.dataTransfer ? Array.from(e.dataTransfer.types) : [],
                defaultPrevented: e.defaultPrevented,
              });
            }
          };

          const handleDebugMouseDown = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const nearBlockHandle = target.closest('.milkdown-block-handle');
            if (nearBlockHandle) {
              debugLog.log('[CrepeEditor] Global mousedown on block handle:', {
                target: target.tagName + (target.className ? `.${target.className.split(' ')[0]}` : ''),
                operationItem: target.closest('.operation-item') ? 'yes' : 'no',
              });
            }
          };

          container.addEventListener('mousedown', handleDebugMouseDown, { capture: true });
          container.addEventListener('dragstart', debugDragEvents, { capture: true });
          container.addEventListener('drag', debugDragEvents, { capture: true });
          container.addEventListener('dragover', debugDragEvents, { capture: true });
          container.addEventListener('drop', debugDragEvents, { capture: true });
          container.addEventListener('dragend', debugDragEvents, { capture: true });

          (crepe as any).__debugDragCleanup = () => {
            container.removeEventListener('mousedown', handleDebugMouseDown, { capture: true });
            container.removeEventListener('dragstart', debugDragEvents, { capture: true });
            container.removeEventListener('drag', debugDragEvents, { capture: true });
            container.removeEventListener('dragover', debugDragEvents, { capture: true });
            container.removeEventListener('drop', debugDragEvents, { capture: true });
            container.removeEventListener('dragend', debugDragEvents, { capture: true });
          };
        }
        
        // Tauri 图片上传修复：拦截图片上传区域的点击，使用 Tauri dialog 替代浏览器原生 file input
        // Milkdown ImageInput 使用 <label class="uploader" for={uuid}> 关联隐藏的 <input type="file">
        // 我们需要拦截 label 的点击，阻止它触发 file input，改用 Tauri dialog
        const isTauriEnv = typeof window !== 'undefined' &&
          Boolean((window as any).__TAURI_INTERNALS__);
        const uploader = createImageUploader(noteId, blobUrlRegistry);

        const imageDebugEnabled = debugMasterSwitch.isEnabled();
        if (imageDebugEnabled) {
          // 发射初始化快照（仅调试用）
          emitImageUploadDebug(
            'dom_snapshot',
            'info',
            '编辑器就绪，捕获 ImageBlock DOM 快照',
            { isTauriEnv, noteId },
            undefined,
            undefined,
            captureImageBlockSnapshot(container)
          );
        }

        const imageRenderCleanup = new Set<() => void>();
        const IMAGE_RENDER_SELECTOR = '.milkdown-image-block img, .milkdown-image-inline img';
        let imageRenderObserver: MutationObserver | null = null;

        const emitImageRender = (
          img: HTMLImageElement,
          status: 'success' | 'error',
          extra?: Record<string, unknown>,
        ) => {
          const src = img.getAttribute('src') || '';
          // 深度诊断：检查 src 格式和可能的问题
          const srcDiagnosis = {
            isEmpty: !src,
            isAssetUrl: src.startsWith('asset://'),
            isTauriUrl: src.startsWith('tauri://'),
            isHttpUrl: src.startsWith('http://') || src.startsWith('https://'),
            isBlobUrl: src.startsWith('blob:'),
            isDataUrl: src.startsWith('data:'),
            isRelativePath: src.startsWith('notes_assets/'),
            urlProtocol: src.split(':')[0] || 'none',
            urlLength: src.length,
          };
          
          emitImageUploadDebug(
            'image_render',
            status === 'success' ? 'success' : 'error',
            status === 'success' ? '图片渲染成功' : `⚠️ 图片渲染失败 - ${srcDiagnosis.isEmpty ? 'src为空' : srcDiagnosis.isRelativePath ? '相对路径未转换' : '加载失败'}`,
            {
              noteId,
              status,
              src: src.slice(0, 150),
              currentSrc: img.currentSrc?.slice(0, 150),
              naturalWidth: img.naturalWidth,
              naturalHeight: img.naturalHeight,
              complete: img.complete,
              srcDiagnosis,
              // 额外诊断信息
              parentClass: img.parentElement?.className,
              grandParentClass: img.parentElement?.parentElement?.className,
              ...extra,
            },
            captureDOMInfo(img),
          );
          
          // 如果是错误状态，尝试输出更多信息到控制台
          if (status === 'error') {
            debugLog.error('[CrepeEditor] 图片渲染失败详情:', {
              src,
              srcDiagnosis,
              imgElement: img,
              parentHTML: img.parentElement?.outerHTML?.slice(0, 300),
            });
          }
        };

        const attachImageRenderListeners = () => {
          container.querySelectorAll<HTMLImageElement>(IMAGE_RENDER_SELECTOR).forEach((img) => {
            if ((img as any).__crepeImageRenderHooked) return;
            (img as any).__crepeImageRenderHooked = true;

            const handleLoad = () => emitImageRender(img, 'success');
            const handleError = (event: Event) =>
              emitImageRender(img, 'error', {
                errorType: (event as ErrorEvent)?.type ?? 'unknown',
                message: (event as ErrorEvent)?.message,
              });

            img.addEventListener('load', handleLoad);
            img.addEventListener('error', handleError);

            imageRenderCleanup.add(() => {
              img.removeEventListener('load', handleLoad);
              img.removeEventListener('error', handleError);
              delete (img as any).__crepeImageRenderHooked;
            });

            if (img.complete) {
              queueMicrotask(() => {
                if (img.naturalWidth > 0) {
                  handleLoad();
                } else {
                  handleError(new Event('error'));
                }
              });
            }
          });
        };

        if (imageDebugEnabled) {
          attachImageRenderListeners();

          // 增强版 MutationObserver：监听 src 变化并记录详情（仅调试用）
          imageRenderObserver = new MutationObserver((mutations) => {
            attachImageRenderListeners();
            
            // 检查 src 属性变化
            mutations.forEach((mutation) => {
              if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
                const target = mutation.target as HTMLImageElement;
                if (target.tagName === 'IMG') {
                  const newSrc = target.getAttribute('src') || '';
                  const oldSrc = (mutation.oldValue || '');
                  
                  emitImageUploadDebug('node_update', newSrc ? 'info' : 'warning', 
                    `图片 src 属性变化${!newSrc ? ' (⚠️ 被清空!)' : ''}`, {
                    oldSrc: oldSrc?.slice(0, 100),
                    newSrc: newSrc?.slice(0, 100),
                    targetClass: target.className,
                    parentClass: target.parentElement?.className,
                    isInImageBlock: !!target.closest('.milkdown-image-block'),
                    isInImageInline: !!target.closest('.milkdown-image-inline'),
                  });
                }
              }
              
              // 检查新添加的图片节点
              if (mutation.type === 'childList') {
                mutation.addedNodes.forEach((node) => {
                  if (node instanceof HTMLElement) {
                    const imgs = node.tagName === 'IMG' ? [node] : Array.from(node.querySelectorAll('img'));
                    imgs.forEach((img) => {
                      // 🔧 过滤 ProseMirror 内部元素，避免误报
                      const className = (img as HTMLElement).className || '';
                      if (className.includes('ProseMirror-separator') || className.includes('ProseMirror-trailingBreak')) {
                        return; // 跳过 ProseMirror 内部占位元素
                      }
                      const src = (img as HTMLImageElement).getAttribute('src') || '';
                      emitImageUploadDebug('dom_snapshot', 'debug', '新增图片元素', {
                        src: src?.slice(0, 100),
                        srcEmpty: !src,
                        className,
                        parentClass: img.parentElement?.className,
                      });
                    });
                  }
                });
              }
            });
          });

          imageRenderObserver.observe(container, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['src'],
            attributeOldValue: true, // 记录旧值
          });
        }

        const handleImageUploadClick = async (e: MouseEvent) => {
          const target = e.target as HTMLElement;
          
          // 发射点击检测事件
          emitImageUploadDebug('click_detected', 'debug', '检测到点击事件', {
            isTauriEnv,
            targetTag: target.tagName,
            targetClass: target.className,
          }, captureDOMInfo(target), checkSelectorMatches(target), captureImageBlockSnapshot(container));
          
          // 只在 Tauri 环境下拦截，浏览器环境使用原生 file input
          if (!isTauriEnv) {
            emitImageUploadDebug('tauri_check', 'info', '非 Tauri 环境，跳过拦截，使用原生 file input', {
              reason: 'not_tauri_env',
            });
            return;
          }
          
          // 如果点击的是链接输入框，不拦截（优先检查）
          if (target.classList.contains('link-input-area') || 
              (target.tagName === 'INPUT' && !target.classList.contains('hidden'))) {
            emitImageUploadDebug('selector_check', 'debug', '点击的是输入框，跳过拦截', {
              reason: 'input_element',
              targetClass: target.className,
              targetTag: target.tagName,
            });
            return;
          }
          
          // 检查是否在 ImageBlock 或 ImageInline 内
          const imageContainer = target.closest('.milkdown-image-block') || 
                                target.closest('.milkdown-image-inline');
          
          if (!imageContainer) {
            emitImageUploadDebug('selector_check', 'debug', '不在图片容器内，跳过处理', {
              reason: 'no_image_container',
            });
            return;
          }
          
          // 检查图片容器内是否有 .placeholder（表示是空图片，需要上传）
          // 如果图片已经有 src，则不需要拦截
          const hasPlaceholder = imageContainer.querySelector('.placeholder') !== null;
          const hasImageEdit = imageContainer.querySelector('.image-edit') !== null;
          
          // 发射选择器检查事件
          emitImageUploadDebug('selector_check', 'debug', '选择器匹配检查', {
            hasImageContainer: true,
            hasPlaceholder,
            hasImageEdit,
            targetTag: target.tagName,
            targetClass: target.className,
          }, undefined, checkSelectorMatches(target));
          
          // 只处理空图片块的点击（有 placeholder 表示未上传图片）
          if (!hasPlaceholder) {
            emitImageUploadDebug('selector_check', 'debug', '图片已有内容，跳过拦截', {
              reason: 'image_has_content',
              hasPlaceholder,
            });
            return;
          }

          // 阻止默认行为（label 触发 file input）
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();

          emitImageUploadDebug('dialog_open', 'info', '准备打开 Tauri 文件对话框', {
            targetClass: target.className,
          });
          
          // 使用 Tauri dialog 选择图片
          const file = await pickImageWithTauriDialog();

          // 异步等待期间本实例可能已销毁（切换笔记会重建编辑器），
          // 销毁后 crepeRef.current 已指向新实例，绝不能再写入
          if (destroyed) return;

          if (!file) {
            emitImageUploadDebug('dialog_result', 'warning', '用户取消选择或未选择文件', {
              result: null,
            });
            return;
          }
          
          emitImageUploadDebug('dialog_result', 'success', '文件选择成功', {
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type,
          });

          try {
            emitImageUploadDebug('upload_start', 'info', '开始上传文件', {
              fileName: file.name,
              noteId,
            });
            
            // 调用上传函数获取 URL
            const url = await uploader(file);

            if (destroyed) return;

            emitImageUploadDebug('upload_complete', 'success', '文件上传完成', {
              url,
              fileName: file.name,
            });
            
            // 找到最近的图片块容器
            const imageBlock = target.closest('.milkdown-image-block') || target.closest('.milkdown-image-inline');
            
            emitImageUploadDebug('node_find', 'info', '开始查找图片节点', {
              hasImageBlock: !!imageBlock,
              imageBlockClass: (imageBlock as HTMLElement)?.className,
            });
            
            // 已通过 destroyed 检查，crepeRef.current 仍指向本实例
            const currentCrepe = crepeRef.current;
            if (!currentCrepe) {
              emitImageUploadDebug('error', 'error', '编辑器已销毁，无法更新节点', {});
              return;
            }
            
            // 🔧 外层 try-catch：捕获编辑器已销毁时 ctx.get 抛出的 "Context 'nodes' not found" 错误
            try {
            currentCrepe.editor.action((ctx) => {
              try {
                const view = ctx.get('editorView') as any;
                if (!view) {
                  emitImageUploadDebug('node_find', 'error', '无法获取 editorView', {});
                  return;
                }
                
                // 遍历文档查找图片节点
                const { state } = view;
                let imagePos = -1;
                let firstEmptyImagePos = -1; // 备选：第一个空 src 的图片节点
                const nodeTypes: string[] = [];
                
                state.doc.descendants((node: any, pos: number) => {
                  nodeTypes.push(`${node.type.name}@${pos}`);
                  if (imagePos >= 0) return false;
                  // 检查是否是图片节点（Milkdown 使用 image-block）
                  if (node.type.name === 'image' || node.type.name === 'image-block' || node.type.name === 'imageBlock' || node.type.name === 'image_block') {
                    // 记录第一个空 src 的图片节点作为备选
                    if (firstEmptyImagePos < 0 && !node.attrs?.src) {
                      firstEmptyImagePos = pos;
                    }
                    // 优先：检查这个节点的 DOM 是否匹配（如果 imageBlock 仍然有效）
                    const domNode = view.nodeDOM(pos);
                    if (domNode && imageBlock && document.body.contains(imageBlock) &&
                        (imageBlock.contains(domNode) || domNode.contains(imageBlock) || domNode === imageBlock)) {
                      imagePos = pos;
                      return false;
                    }
                  }
                  return true;
                });
                
                // 如果 DOM 匹配失败，使用第一个空 src 的图片节点
                if (imagePos < 0 && firstEmptyImagePos >= 0) {
                  imagePos = firstEmptyImagePos;
                  emitImageUploadDebug('node_find', 'info', '使用备选：第一个空 src 图片节点', {
                    imagePos,
                  });
                }
                
                emitImageUploadDebug('node_find', imagePos >= 0 ? 'success' : 'warning', 
                  imagePos >= 0 ? '找到图片节点' : '未找到匹配的图片节点', {
                  imagePos,
                  nodeTypesCount: nodeTypes.length,
                  nodeTypes: nodeTypes.slice(0, 10), // 只显示前10个
                });
                
                if (imagePos >= 0) {
                  const node = state.doc.nodeAt(imagePos);
                  if (node) {
                    // 更新图片节点的 src 属性
                    const tr = state.tr.setNodeMarkup(imagePos, undefined, {
                      ...node.attrs,
                      src: url,
                    });
                    view.dispatch(tr);
                    
                    emitImageUploadDebug('node_update', 'success', '图片节点更新成功', {
                      imagePos,
                      newSrc: url,
                      nodeType: node.type.name,
                      prevAttrs: node.attrs,
                    });
                  }
                } else {
                  emitImageUploadDebug('node_update', 'error', '无法更新：未找到图片节点', {
                    nodeTypesInDoc: nodeTypes,
                  });
                }
              } catch (err) {
                emitImageUploadDebug('error', 'error', `更新节点失败: ${err}`, {
                  error: String(err),
                });
              }
            });
            } catch (editorActionError) {
              // 🔧 捕获编辑器销毁后 ctx.get 抛出的 "Context 'nodes' not found" 错误
              // 这是预期行为，异步操作完成时编辑器可能已被销毁
              debugLog.warn('[CrepeEditor] Editor action failed (editor may be destroyed):', editorActionError);
            }
          } catch (error) {
            emitImageUploadDebug('error', 'error', `上传失败: ${error}`, {
              error: String(error),
              fileName: file?.name,
            });
          }
        };
        
        // Tauri 下点击空 ImageBlock 走 Tauri dialog 选图。
        // 使用 capture: true 在捕获阶段拦截，确保在 label 触发 file input 之前处理。
        container.addEventListener('click', handleImageUploadClick, { capture: true });
        
        // 在 Tauri 环境中阻止 DOM 原生 drop 事件到达 Milkdown 的图片区域
        // 这样 Milkdown 的 onUpload 不会被触发（我们用 Tauri API 处理）
        const handleDomDrop = (e: DragEvent) => {
          if (!isTauriEnv) return;
          
          const target = e.target as HTMLElement;
          const imageContainer = target?.closest?.('.milkdown-image-block') || 
                                target?.closest?.('.milkdown-image-inline');
          
          if (imageContainer) {
            const hasPlaceholder = imageContainer.querySelector('.placeholder') !== null;
            if (hasPlaceholder) {
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
              emitImageUploadDebug('selector_check', 'info', '阻止 DOM drop 事件（由 Tauri 处理）', {
                targetClass: target?.className,
              });
            }
          }
        };
        
        container.addEventListener('drop', handleDomDrop, { capture: true });
        
        // Tauri 拖放事件处理
        let dragDropUnlisten: (() => void) | undefined;
        let dragDropSetupAborted = false;
        
        const setupDragDropListener = async () => {
          if (!isTauriEnv) return;
          
          try {
            const { getCurrentWebview } = await import('@tauri-apps/api/webview');
            const { convertFileSrc } = await import('@tauri-apps/api/core');
            
            // 检查是否已被销毁
            if (destroyed || dragDropSetupAborted) return;
            
            const webview = getCurrentWebview();
            
            const unlisten = await webview.onDragDropEvent(async (event) => {
              if (event.payload.type !== 'drop') return;
              
              const paths = event.payload.paths;
              if (!paths || paths.length === 0) return;
              
              emitImageUploadDebug('click_detected', 'info', '检测到 Tauri 拖放事件', {
                pathsCount: paths.length,
                paths: paths.slice(0, 3),
              });
              
              // 检查是否拖放到了 ImageBlock 区域
              const pos = event.payload.position;
              if (!pos) return;
              
              const elementAtPoint = document.elementFromPoint(pos.x, pos.y);
              if (!elementAtPoint) return;
              
              // 只处理图片文件
              const imagePaths = paths.filter(p => 
                /\.(jpg|jpeg|png|gif|bmp|webp|svg|heic|heif)$/i.test(p)
              );
              
              if (imagePaths.length === 0) {
                emitImageUploadDebug('selector_check', 'warning', '没有图片文件', {
                  paths,
                });
                return;
              }
              
              const imageContainer = elementAtPoint.closest('.milkdown-image-block') || 
                                    elementAtPoint.closest('.milkdown-image-inline');
              
              // 检查是否在编辑器容器内
              const isInEditor = elementAtPoint.closest('.crepe-editor-wrapper') !== null ||
                                elementAtPoint.closest('.milkdown') !== null ||
                                elementAtPoint.closest('.ProseMirror') !== null;
              
              if (!isInEditor) {
                emitImageUploadDebug('selector_check', 'debug', '拖放位置不在编辑器内', {
                  x: pos.x,
                  y: pos.y,
                  elementClass: (elementAtPoint as HTMLElement).className,
                });
                return;
              }
              
              const filePath = imagePaths[0];
              emitImageUploadDebug('dialog_result', 'info', '处理拖放的图片文件', {
                filePath,
                hasImageContainer: !!imageContainer,
              });
              
              try {
                // 读取文件
                const assetUrl = convertFileSrc(filePath);
                const response = await fetch(assetUrl);
                if (!response.ok) {
                  throw new Error(`Failed to fetch: ${response.status}`);
                }
                
                const blob = await response.blob();
                const { extractFileName } = await import('@/utils/fileManager');
                const fileName = extractFileName(filePath) || 'image.png';
                const file = new File([blob], fileName, { type: blob.type || 'image/png' });

                if (destroyed || dragDropSetupAborted) return;

                emitImageUploadDebug('file_convert', 'success', '文件读取成功', {
                  fileName: file.name,
                  fileSize: file.size,
                  fileType: file.type,
                });
                
                // 上传文件
                const url = await uploader(file);

                // 上传期间本实例可能已销毁；此后 crepeRef.current 指向新实例，禁止写入
                if (destroyed || dragDropSetupAborted) return;

                emitImageUploadDebug('upload_complete', 'success', '拖放图片上传完成', {
                  url,
                  fileName: file.name,
                });
                
                const currentCrepe = crepeRef.current;
                if (!currentCrepe) {
                  emitImageUploadDebug('error', 'error', '编辑器已销毁，无法更新拖放节点', {});
                  return;
                }
                
                // 🔧 外层 try-catch：捕获编辑器已销毁时 ctx.get 抛出的 "Context 'nodes' not found" 错误
                try {
                currentCrepe.editor.action((ctx) => {
                  try {
                    const view = ctx.get('editorView') as any;
                    if (!view) return;
                    
                    const { state } = view;
                    
                    // 情况1: 拖放到已有的空图片容器
                    if (imageContainer) {
                      const hasPlaceholder = imageContainer.querySelector('.placeholder') !== null;
                      if (hasPlaceholder) {
                        // 查找对应的图片节点并更新
                        let imagePos = -1;
                        state.doc.descendants((node: any, nodePos: number) => {
                          if (imagePos >= 0) return false;
                          if (node.type.name === 'image' || node.type.name === 'image-block' || node.type.name === 'imageBlock' || node.type.name === 'image_block') {
                            const domNode = view.nodeDOM(nodePos);
                            if (domNode && document.body.contains(imageContainer) &&
                                (imageContainer.contains(domNode) || domNode.contains(imageContainer) || domNode === imageContainer)) {
                              imagePos = nodePos;
                              return false;
                            }
                          }
                          return true;
                        });
                        
                        if (imagePos >= 0) {
                          const node = state.doc.nodeAt(imagePos);
                          if (node) {
                            const tr = state.tr.setNodeMarkup(imagePos, undefined, {
                              ...node.attrs,
                              src: url,
                            });
                            view.dispatch(tr);
                            emitImageUploadDebug('node_update', 'success', '拖放图片节点更新成功', {
                              imagePos,
                              newSrc: url,
                            });
                            return;
                          }
                        }
                      } else {
                        emitImageUploadDebug('selector_check', 'debug', '图片已有内容，将在拖放位置插入新图片', {
                          reason: 'image_has_content',
                        });
                      }
                    }
                    
                    // 情况2: 没有图片容器或图片容器已有内容，在拖放位置插入新图片
                    emitImageUploadDebug('node_insert', 'info', '在拖放位置插入新图片节点', {
                      x: pos.x,
                      y: pos.y,
                    });
                    
                    // 获取拖放位置对应的编辑器位置
                    const posAtCoords = view.posAtCoords({ left: pos.x, top: pos.y });
                    let insertPos: number;
                    
                    if (posAtCoords && posAtCoords.pos >= 0) {
                      // 找到最近的块级节点边界
                      const $pos = state.doc.resolve(posAtCoords.pos);
                      // 在当前块之后插入
                      insertPos = $pos.after($pos.depth > 0 ? 1 : 0);
                      // 确保位置有效
                      if (insertPos > state.doc.content.size) {
                        insertPos = state.doc.content.size;
                      }
                    } else {
                      // 无法确定位置，在当前选区位置插入
                      const { from } = state.selection;
                      const $from = state.doc.resolve(from);
                      insertPos = $from.after($from.depth > 0 ? 1 : 0);
                      if (insertPos > state.doc.content.size) {
                        insertPos = state.doc.content.size;
                      }
                    }
                    
                    // 查找图片节点类型
                    const imageBlockType = state.schema.nodes['image-block'] || 
                                          state.schema.nodes['imageBlock'] || 
                                          state.schema.nodes['image_block'] ||
                                          state.schema.nodes['image'];
                    
                    if (imageBlockType) {
                      // 创建图片节点
                      const imageNode = imageBlockType.create({
                        src: url,
                        alt: fileName,
                      });
                      
                      // 插入图片节点
                      const tr = state.tr.insert(insertPos, imageNode);
                      view.dispatch(tr.scrollIntoView());
                      view.focus();
                      
                      emitImageUploadDebug('node_insert', 'success', '新图片节点插入成功', {
                        insertPos,
                        src: url,
                        nodeType: imageBlockType.name,
                      });
                    } else {
                      // 备选：使用 Markdown 格式插入
                      emitImageUploadDebug('node_insert', 'warning', '未找到图片节点类型，使用 Markdown 格式', {
                        availableNodes: Object.keys(state.schema.nodes),
                      });
                      
                      const imageMarkdown = `\n![${fileName}](${url})\n`;
                      const tr = state.tr.insertText(imageMarkdown, insertPos);
                      view.dispatch(tr.scrollIntoView());
                      view.focus();
                    }
                  } catch (err) {
                    emitImageUploadDebug('error', 'error', `拖放更新节点失败: ${err}`, {
                      error: String(err),
                    });
                  }
                });
                } catch (editorActionError) {
                  // 🔧 捕获编辑器销毁后 ctx.get 抛出的 "Context 'nodes' not found" 错误
                  debugLog.warn('[CrepeEditor] Editor action failed during drag-drop (editor may be destroyed):', editorActionError);
                }
              } catch (error) {
                emitImageUploadDebug('error', 'error', `拖放处理失败: ${error}`, {
                  error: String(error),
                  filePath,
                });
              }
            });
            
            // 再次检查是否已被销毁，如果是则立即清理
            if (destroyed || dragDropSetupAborted) {
              unlisten();
              return;
            }
            
            dragDropUnlisten = unlisten;
            emitImageUploadDebug('dom_snapshot', 'info', 'Tauri 拖放监听器已注册', {});
          } catch (error) {
            emitImageUploadDebug('error', 'warning', `无法注册 Tauri 拖放监听器: ${error}`, {
              error: String(error),
            });
          }
        };
        
        void setupDragDropListener();
        
        // 监听图片节点状态变化（调试用）
        let lastImageSrcMap = new Map<number, string>();
        let trackCounter = 0;
        
        const trackImageNodeChanges = () => {
          trackCounter++;
          const isPeriodicReport = trackCounter % 20 === 0; // 每 10 秒（20 * 500ms）输出一次完整报告
          
          // 🔧 使用 safeEditorAction 统一处理编辑器销毁时的上下文错误
          safeEditorAction((ctx) => {
            try {
              const view = ctx.get('editorView') as any;
              if (!view) return;
              
              const { state } = view;
              const currentImageSrcMap = new Map<number, string>();
              const allImageNodes: Array<{pos: number; src: string; type: string; attrs: any}> = [];
              
              state.doc.descendants((node: any, pos: number) => {
                if (node.type.name === 'image' || node.type.name === 'image-block' || node.type.name === 'imageBlock') {
                  const src = node.attrs?.src || '';
                  currentImageSrcMap.set(pos, src);
                  allImageNodes.push({
                    pos,
                    src: src?.slice(0, 100),
                    type: node.type.name,
                    attrs: node.attrs,
                  });
                  
                  const prevSrc = lastImageSrcMap.get(pos);
                  if (prevSrc !== undefined && prevSrc !== src) {
                    emitImageUploadDebug('node_update', src ? 'info' : 'error', 
                      src ? `图片节点 src 变化` : `⚠️ 图片节点 src 被清空！`, {
                      pos,
                      prevSrc: prevSrc?.slice(0, 100),
                      newSrc: src?.slice(0, 100),
                      nodeType: node.type.name,
                      allAttrs: node.attrs,
                    });
                  }
                }
                return true;
              });
              
              // 定期输出完整图片状态报告
              if (isPeriodicReport && allImageNodes.length > 0) {
                const emptyNodes = allImageNodes.filter(n => !n.src);
                const relativePathNodes = allImageNodes.filter(n => n.src?.startsWith('notes_assets/'));
                const assetNodes = allImageNodes.filter(n => n.src?.startsWith('asset://'));
                const blobNodes = allImageNodes.filter(n => n.src?.startsWith('blob:'));
                
                emitImageUploadDebug('dom_snapshot', emptyNodes.length > 0 || relativePathNodes.length > 0 ? 'warning' : 'info', 
                  `📊 图片节点状态报告 (每10秒)`, {
                  totalCount: allImageNodes.length,
                  emptyCount: emptyNodes.length,
                  relativePathCount: relativePathNodes.length,
                  assetUrlCount: assetNodes.length,
                  blobUrlCount: blobNodes.length,
                  emptyNodes: emptyNodes.map(n => ({ pos: n.pos, type: n.type })),
                  relativePathNodes: relativePathNodes.map(n => ({ pos: n.pos, src: n.src })),
                  allNodes: allImageNodes,
                });
                
                // 同时检查 DOM 中的图片元素
                const domImages = container.querySelectorAll<HTMLImageElement>('img');
                const domImageReport = Array.from(domImages).map((img, idx) => ({
                  index: idx,
                  src: img.getAttribute('src')?.slice(0, 80) || '',
                  naturalWidth: img.naturalWidth,
                  complete: img.complete,
                  error: img.naturalWidth === 0 && img.complete,
                  inImageBlock: !!img.closest('.milkdown-image-block'),
                }));
                
                const brokenImages = domImageReport.filter(i => i.error);
                if (brokenImages.length > 0) {
                  emitImageUploadDebug('image_render', 'error', 
                    `⚠️ DOM 中有 ${brokenImages.length} 个损坏的图片`, {
                    brokenImages,
                    allDomImages: domImageReport,
                  });
                }
              }
              
              lastImageSrcMap = currentImageSrcMap;
            } catch (e) {
              // ignore
            }
          });
        };
        
        // 定期检查图片节点状态（仅调试用）
        let imageTrackInterval: ReturnType<typeof setInterval> | null = null;
        if (imageDebugEnabled) {
          imageTrackInterval = setInterval(trackImageNodeChanges, 500);

          // 初始化完成后立即执行一次诊断
          setTimeout(() => {
            // 🔧 安全获取 markdown，避免 "Context 'nodes' not found" 错误
            let diagMarkdownLength = 0;
            let initialMarkdown = '';
            try {
              initialMarkdown = crepe.getMarkdown() || '';
              diagMarkdownLength = initialMarkdown.length;
            } catch {
              // 编辑器上下文可能未完全初始化
            }
            
            emitImageUploadDebug('dom_snapshot', 'info', '🚀 编辑器初始化完成 - 执行初始诊断', {
              noteId,
              isTauriEnv,
              markdownLength: diagMarkdownLength,
            }, undefined, undefined, captureImageBlockSnapshot(container));
            
            // 检查初始内容中是否有图片
            const imageMatches = initialMarkdown.match(/!\[.*?\]\((.*?)\)/g) || [];
            if (imageMatches.length > 0) {
              const imageSrcs = imageMatches.map(m => {
                const match = m.match(/!\[.*?\]\((.*?)\)/);
                return match ? match[1] : '';
              });
              
              emitImageUploadDebug('dom_snapshot', 'info', `📷 初始内容包含 ${imageMatches.length} 个图片`, {
                imageSrcs: imageSrcs.map(s => s?.slice(0, 80)),
                hasRelativePaths: imageSrcs.some(s => s?.startsWith('notes_assets/')),
                hasAssetUrls: imageSrcs.some(s => s?.startsWith('asset://')),
                hasBlobUrls: imageSrcs.some(s => s?.startsWith('blob:')),
              });
            }
            
            // 立即执行一次节点跟踪
            trackImageNodeChanges();
          }, 100);
        }
        
        (crepe as any).__imageUploadCleanup = () => {
          container.removeEventListener('click', handleImageUploadClick, { capture: true });
          container.removeEventListener('drop', handleDomDrop, { capture: true });
          imageRenderObserver?.disconnect();
          imageRenderCleanup.forEach(fn => fn());
          imageRenderCleanup.clear();
          // 标记异步设置已中止，防止异步完成后泄漏
          dragDropSetupAborted = true;
          dragDropUnlisten?.();
          if (imageTrackInterval) {
            clearInterval(imageTrackInterval);
            imageTrackInterval = null;
          }
          // 降级上传的 blob URL 不会被 GC 回收，实例销毁时统一释放
          blobUrlRegistry.releaseAll();
        };

        // 通知就绪
        const api = buildApi();
        // 🔧 包裹 onReady 回调，防止回调内部的错误导致初始化失败
        try {
          onReadyRef.current?.(api);
        } catch (onReadyError) {
          // onReady 回调错误不应该影响编辑器初始化状态
          debugLog.warn('[CrepeEditor] onReady callback error (non-fatal):', onReadyError);
        }

        debugLog.log('[CrepeEditor] Editor initialized successfully');
      } catch (error) {
        setInitPhase('init-error');
        debugLog.error('[CrepeEditor] Failed to initialize editor:', error);
        emitCrepeDebug('error', 'error', `编辑器初始化失败: ${error}`, {
          errorMessage: String(error),
          errorStack: (error as Error)?.stack,
          noteId,
        }, captureDOMSnapshot(container));
      }
    };

    void initEditor();

    return () => {
      emitCrepeDebug('lifecycle', 'info', '开始清理编辑器', { noteId });
      destroyed = true;
      clearExposeTimeouts();
      // ACR 4.0：解绑滚动跟随监听 / 清掉未完成的内容脉冲
      agentFollowerRef.current?.dispose();
      agentFollowerRef.current = null;
      if (agentPulseTimerRef.current != null) {
        window.clearTimeout(agentPulseTimerRef.current);
        agentPulseTimerRef.current = null;
      }
      if (crepeRef.current) {
        // 内容监听器 / mermaid observer / 调试拖拽 / 图片上传修复 统一清理
        runStashedCrepeCleanups(crepeRef.current);
        // 清理基于 Pointer Events 的块拖拽
        cleanupBlockDrag();
        // 组件卸载时的销毁回调（避免依赖 plugin-listener 的 destroy 事件）
        try {
          onDestroyRef.current?.();
        } catch (err) {
          debugLog.warn('[CrepeEditor] onDestroy callback failed:', err);
        }
        // E1-6：仅当全局仍指向本实例时清空调试全局，避免多实例切换后指向已销毁 view
        clearMilkdownDebugGlobals(crepeRef.current, viewRef.current);
        crepeRef.current.destroy().catch((e) => {
          debugLog.error('[CrepeEditor] Failed to destroy editor:', e);
          emitCrepeDebug('error', 'error', `编辑器销毁失败: ${e}`);
        });
        crepeRef.current = null;
        viewRef.current = null; // 清理 view 引用
      }
      setIsReady(false);
      emitCrepeDebug('lifecycle', 'info', '编辑器清理完成，isReady=false');
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]); // 🔧 修复：只依赖 noteId，避免 cleanupBlockDrag 变化导致重复初始化

  /**
   * 同步只读状态
   */
  useEffect(() => {
    if (crepeRef.current && isReady) {
      crepeRef.current.setReadonly(readonly);
    }
  }, [readonly, isReady]);

  return (
    <div
      ref={wrapperRef}
      className={`crepe-editor-wrapper ${className}`}
      data-ready={isReady}
      style={{ position: 'relative' }}
      // 🔧 基于 Pointer Events 的块拖拽（替代失效的原生 Drag & Drop）
      onPointerDown={blockDragHandlers.onPointerDown}
      onPointerMove={blockDragHandlers.onPointerMove}
      onPointerUp={blockDragHandlers.onPointerUp}
    >
      {/* Crepe 编辑器容器 */}
      <div ref={containerRef} className="crepe-editor-container" />
      
      {/* 手动的拖拽插入条，放在容器外部避免被 Crepe 覆盖 */}
      <div
        ref={dropIndicatorRef}
        className="crepe-drop-indicator"
      />
      {/* Portal 到 body：编辑器可能位于带 transform 的移动端滑动轨道内，
          position:fixed 会相对轨道定位导致菜单错位（外点关闭仍按 .crepe-block-menu 类判定，不受影响） */}
      {blockMenu && createPortal(
        <div
          ref={blockMenuElRef}
          className="crepe-block-menu"
          role="menu"
          aria-label={i18next.t('notes:blockMenu.label', 'Block actions')}
          style={{ left: blockMenu.x, top: blockMenu.y }}
        >
          <div className="crepe-block-menu__label">{i18next.t('notes:blockMenu.turnInto', 'Turn into')}</div>
          {BLOCK_MENU_ACTIONS.map((action, index) => {
            const isActive = blockMenuActive === index;
            const button = (
              <button
                key={action}
                type="button"
                role="menuitem"
                data-active={isActive || undefined}
                data-destructive={action === 'delete' || undefined}
                // 键盘高亮：无 CSS 所有权，用内联 hover token 兜底
                style={isActive ? { backgroundColor: 'var(--interactive-hover)' } : undefined}
                onMouseEnter={() => setBlockMenuActiveIndex(index)}
                onClick={() => runBlockAction(action)}
              >
                {getBlockMenuActionLabel(action)}
              </button>
            );
            // duplicate 前插入分隔线（turn-into 组结束）
            if (action === 'duplicate') {
              return (
                <React.Fragment key={action}>
                  <div className="crepe-block-menu__separator" />
                  {button}
                </React.Fragment>
              );
            }
            return button;
          })}
        </div>,
        document.body,
      )}
    </div>
  );
});

CrepeEditor.displayName = 'CrepeEditor';

export default CrepeEditor;
