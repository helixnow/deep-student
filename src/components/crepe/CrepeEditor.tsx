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

import React, { useRef, useEffect, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { editorViewCtx, commandsCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/prose/state';
import { replaceAll } from '@milkdown/kit/utils';
import { NodeSelection } from '@milkdown/kit/prose/state';
import { toggleMark, setBlockType, wrapIn } from '@milkdown/prose/commands';
import { MarkType, NodeType } from '@milkdown/prose/model';
import { listItemSchema, wrapInBlockTypeCommand } from '@milkdown/kit/preset/commonmark';
import i18next from 'i18next';

// Crepe 样式（亮色 + 暗色主题）
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import '@milkdown/crepe/theme/frame-dark.css';

// 本地模块
import type { CrepeEditorProps, CrepeEditorApi } from './types';
import { createImageBlockConfig, createImageUploader, pickImageWithTauriDialog } from './features/imageUpload';
import { applyCrepePlugins } from './plugins';
import { createMermaidObserver } from './features/mermaidPreview';
import { emitCrepeDebug, captureDOMSnapshot } from '../../debug-panel/plugins/CrepeEditorDebugPlugin';
import { emitOutlineDebugLog, emitOutlineDebugSnapshot } from '../../debug-panel/events/NotesOutlineDebugChannel';
import { debugMasterSwitch, debugLog } from '../../debug-panel/debugMasterSwitch';
import { convertFileSrc } from '@tauri-apps/api/core';
import { 
  emitImageUploadDebug, 
  captureDOMInfo, 
  checkSelectorMatches, 
  captureImageBlockSnapshot 
} from '../../debug-panel/plugins/CrepeImageUploadDebugPlugin';
import './CrepeEditor.css';
import { useCrepeBlockDrag } from './hooks/useCrepeBlockDrag';
import { useSlashMenuCustomScrollbar } from './hooks/useSlashMenuCustomScrollbar';

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
  } = props;

  const wrapperRef = useRef<HTMLDivElement>(null); // 外层包装
  const containerRef = useRef<HTMLDivElement>(null); // Crepe 容器
  const crepeRef = useRef<Crepe | null>(null);
  const viewRef = useRef<any>(null); // 存储 ProseMirror view 引用
  const dropIndicatorRef = useRef<HTMLDivElement>(null); // 拖拽插入条
  const dragStateRef = useRef<{
    isDragging: boolean;
    sourcePos: number;
    sourceNode: any;
    targetInsertPos: number;
    insertBefore: boolean;
  } | null>(null); // 内部块拖拽状态
  const [isReady, setIsReady] = useState(false);
  const [initPhase, setInitPhase] = useState('pending'); // 🔧 调试：追踪初始化阶段
  const onChangeRef = useRef(onChange);
  const defaultValueRef = useRef(defaultValue);
  const exposeTimeoutsRef = useRef<number[]>([]);

  // 🔧 使用基于 Pointer Events 的块拖拽（替代失效的原生 Drag & Drop）
  const { handlers: blockDragHandlers, cleanup: cleanupBlockDrag, dragState: blockDragState } = useCrepeBlockDrag({
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
  
  // 保持回调引用最新
  onChangeRef.current = onChange;

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
        if (!crepe) return;
        try {
          // @ts-ignore Milkdown 版本类型差异，运行时兼容
          crepe.editor.action(replaceAll(markdown));
        } catch (e) {
          debugLog.error('[CrepeEditor] setMarkdown failed:', e);
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
      
      scrollToHeading: (text: string, level: number, normalizedText?: string) => {
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
            if (node.type.name === 'heading' && node.attrs?.level === level) {
              const nodeText = node.textContent.toLowerCase().trim();
              
              // 精确匹配优先
              if (nodeText === searchText) {
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
              if (!headingElement && containerRef.current) {
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
        if (!view) return;
        try {
          const markType = view.state.schema.marks.link;
          if (markType) {
            const { from, to, empty } = view.state.selection;
            if (empty) {
              const linkText = text || href || 'link';
              const linkMark = markType.create({ href: href || '' });
              const tr = view.state.tr.insertText(linkText, from);
              tr.addMark(from, from + linkText.length, linkMark);
              view.dispatch(tr);
            } else {
              toggleMark(markType, { href: href || '' })(view.state, view.dispatch);
            }
            view.focus();
          }
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
        
        const checkSize = () => {
          if (destroyed) {
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

        // 创建 Crepe 实例
        let crepe = new Crepe({
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
            // 图片上传配置
            [CrepeFeature.ImageBlock]: createImageBlockConfig(noteId),
            
            // 占位符配置
            [CrepeFeature.Placeholder]: {
              text: placeholder || i18next.t('notes:editor.placeholder.body'),
              mode: 'doc',
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
        
        // 暴露 crepe 实例到全局以便调试
        (window as any).__MILKDOWN_CREPE__ = crepe;
        
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
        let changeTimer: number | null = null;
        let isComposing = false;
        let zwsInsertedInComposition = false;
        const ZWS = '\u200b';
        const scheduleEmitChange = () => {
          if (destroyed || isComposing) return;
          if (changeTimer != null) window.clearTimeout(changeTimer);
          changeTimer = window.setTimeout(() => {
            if (destroyed || !crepeRef.current || isComposing) return;
            let markdown = '';
            try {
              markdown = (crepeRef.current.getMarkdown() || '').split(ZWS).join('');
            } catch {
              return;
            }
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
                  (window as any).__MILKDOWN_VIEW__ = view;
                  (window as any).__MILKDOWN_CTX__ = ctx;
                  viewRef.current = view; // 缓存到 ref 供 scrollToHeading 使用
                  if (!viewHooked) {
                    viewHooked = true;
                    try {
                      lastMarkdown = currentCrepe.getMarkdown() || '';
                    } catch {
                      lastMarkdown = '';
                    }
                    lastMarkdown = lastMarkdown.split(ZWS).join('');

                    // 🔧 修复：使用 updateState 来监听文档变化
                    // dispatchTransaction 是 EditorView 的构造配置，不是实例方法
                    // 我们需要 hook updateState 来监听所有 state 变化
                    const originalUpdateState = view.updateState?.bind(view);
                    
                    if (originalUpdateState) {
                      view.updateState = (newState: any) => {
                        const oldState = view.state;
                        originalUpdateState(newState);
                        if (destroyed) return;
                        
                        // 检查文档是否变化
                        const docChanged = !oldState?.doc?.eq?.(newState?.doc);
                        const isCompositionTr = Boolean(view.composing);
                        
                        if (isCompositionTr) return;
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
                      onFocus?.();
                      if (debugMasterSwitch.isEnabled()) {
                        emitCrepeDebug('editor', 'info', '编辑器获得焦点', undefined, captureDOMSnapshot(container));
                      }
                    };
                    const handleBlur = () => {
                      if (destroyed) return;
                      onBlur?.();
                      if (debugMasterSwitch.isEnabled()) {
                        emitCrepeDebug('editor', 'debug', '编辑器失去焦点');
                      }
                    };

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
                    (window as any).__MILKDOWN_VIEW__ = view;
                    (window as any).__MILKDOWN_CTX__ = ctx;
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
          const cleanupMermaid = createMermaidObserver(container, 800);
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
        
        // 🔧 关键修复：确保 block handle 的拖拽按钮设置了 draggable 属性
        // Milkdown 的 BlockService 可能没有正确设置 draggable，需要手动补充
        const ensureBlockHandlesDraggable = () => {
          const blockHandles = container.querySelectorAll('.milkdown-block-handle');
          blockHandles.forEach((handle) => {
            // 找到拖拽按钮（第二个 operation-item，索引为 1）
            const operationItems = handle.querySelectorAll('.operation-item');
            if (operationItems.length >= 2) {
              const dragButton = operationItems[1] as HTMLElement;
              if (!dragButton.hasAttribute('draggable')) {
                dragButton.setAttribute('draggable', 'true');
              }
            }
            // 整个 handle 也设置为可拖拽
            if (!handle.hasAttribute('draggable')) {
              (handle as HTMLElement).setAttribute('draggable', 'true');
            }
          });
        };
        
        // 初始执行一次
        ensureBlockHandlesDraggable();
        
        // 使用 MutationObserver 监听新创建的 block handle
        const blockHandleObserver = new MutationObserver((mutations) => {
          let needsUpdate = false;
          mutations.forEach((mutation) => {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
              mutation.addedNodes.forEach((node) => {
                if (node instanceof HTMLElement) {
                  if (node.classList?.contains('milkdown-block-handle') || 
                      node.querySelector?.('.milkdown-block-handle')) {
                    needsUpdate = true;
                  }
                }
              });
            }
          });
          if (needsUpdate) {
            ensureBlockHandlesDraggable();
          }
        });
        
        blockHandleObserver.observe(container, {
          childList: true,
          subtree: true,
        });
        
        (crepe as any).__blockHandleObserver = blockHandleObserver;
        
        // 修复 BlockService 的 mousedown 事件处理
        // 问题：BlockService.#handleMouseDown 没有被正确触发
        // 解决方案：使用事件委托在 container 级别监听事件
        const handleMouseDown = (e: MouseEvent) => {
          const target = e.target as Element;
          // 检查是否在 block handle 上
          const blockHandle = target.closest('.milkdown-block-handle');
          if (!blockHandle) return;
          
          // 检查是否在加号按钮上（第一个 operation-item）- 如果是则跳过
          const operationItem = target.closest('.operation-item');
          if (operationItem) {
            const allItems = blockHandle.querySelectorAll('.operation-item');
            const itemIndex = Array.from(allItems).indexOf(operationItem);
            // 跳过加号按钮（第一个 operation-item，索引为 0）
            if (itemIndex === 0) return;
          }
          
          // 手动触发 BlockService 的选区创建逻辑
          safeEditorAction((ctx) => {
            try {
              const view = ctx.get('editorView') as any;
              if (!view) return;
              
              const rect = blockHandle.getBoundingClientRect();
              const x = rect.left + rect.width / 2;
              const y = rect.top + rect.height / 2;
              
              // 找到对应位置的节点
              const pos = view.posAtCoords({ left: x + 100, top: y });
              if (!pos || pos.inside < 0) return;
              
              // 找到根节点
              let $pos = view.state.doc.resolve(pos.inside);
              while ($pos.depth > 1) {
                $pos = view.state.doc.resolve($pos.before($pos.depth));
              }
              
              const node = view.state.doc.nodeAt($pos.pos);
              if (!node) return;
              
              // 创建 NodeSelection
              if (NodeSelection.isSelectable(node)) {
                const nodeSelection = NodeSelection.create(view.state.doc, $pos.pos);
                view.dispatch(view.state.tr.setSelection(nodeSelection));
                view.focus();
                
                // 保存选区以便 dragstart 时使用
                (crepe as any).__pendingDragSelection = nodeSelection;
              }
            } catch (e) {
              debugLog.warn('[CrepeEditor] Block handle mousedown fix failed:', e);
            }
          });
        };
        
        const handleDragStart = (e: DragEvent) => {
          const target = e.target as Element;
          debugLog.log('[CrepeEditor] DragStart triggered on:', {
            tagName: target.tagName,
            className: target.className,
            draggable: (target as HTMLElement).draggable,
          });
          
          const blockHandle = target.closest('.milkdown-block-handle');
          if (!blockHandle) {
            debugLog.log('[CrepeEditor] DragStart: Not from block handle, skipping');
            return;
          }
          
          debugLog.log('[CrepeEditor] DragStart: Processing block handle drag');
          
          // 在 dragstart 中完成所有操作：创建 NodeSelection + 设置 dataTransfer
          safeEditorAction((ctx) => {
            try {
              const view = ctx.get('editorView') as any;
              if (!view) {
                debugLog.warn('[CrepeEditor] DragStart: No view available');
                return;
              }
              
              // 1. 首先创建 NodeSelection（如果还没有）
              let selection = view.state.selection;
              let sourcePos = -1;
              let sourceNode = null;
              
              if (!selection.constructor.name.includes('NodeSelection')) {
                // 找到 block handle 对应的节点
                const rect = blockHandle.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                
                const pos = view.posAtCoords({ left: x + 100, top: y });
                if (pos && pos.inside >= 0) {
                  let $pos = view.state.doc.resolve(pos.inside);
                  while ($pos.depth > 1) {
                    $pos = view.state.doc.resolve($pos.before($pos.depth));
                  }
                  
                  const node = view.state.doc.nodeAt($pos.pos);
                  if (node && NodeSelection.isSelectable(node)) {
                    selection = NodeSelection.create(view.state.doc, $pos.pos);
                    view.dispatch(view.state.tr.setSelection(selection));
                    sourcePos = $pos.pos;
                    sourceNode = node;
                  }
                }
              } else {
                // 已经是 NodeSelection
                sourcePos = selection.from;
                sourceNode = view.state.doc.nodeAt(sourcePos);
              }
              
              // 2. 检查是否有有效的 NodeSelection
              if (!selection.constructor.name.includes('NodeSelection')) return;
              
              const slice = selection.content();
              if (!slice) return;
              
              // 3. 保存拖拽状态到 ref（用于 drop 时恢复）
              dragStateRef.current = {
                isDragging: true,
                sourcePos,
                sourceNode,
                targetInsertPos: -1,
                insertBefore: true,
              };
              
              // 4. 设置 dataTransfer
              if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                const { dom, text } = view.serializeForClipboard(slice);
                e.dataTransfer.clearData();
                e.dataTransfer.setData('text/html', dom.innerHTML);
                e.dataTransfer.setData('text/plain', text);
                // 添加自定义类型标识这是内部块拖拽
                e.dataTransfer.setData('application/x-milkdown-block', JSON.stringify({
                  sourcePos,
                  nodeSize: sourceNode?.nodeSize || 0,
                }));
                
                // 设置拖拽图像
                const selectedNode = container.querySelector('.ProseMirror-selectednode');
                if (selectedNode) {
                  e.dataTransfer.setDragImage(selectedNode, 0, 0);
                }
                
                // 设置 view.dragging
                view.dragging = {
                  slice,
                  move: true,
                };
                
                // 设置 data-dragging 属性
                view.dom.dataset.dragging = 'true';
              }
              
              debugLog.log('[CrepeEditor] Block drag started:', { sourcePos, nodeType: sourceNode?.type?.name });
            } catch (e2) {
              debugLog.warn('[CrepeEditor] Block handle dragstart fix failed:', e2);
              dragStateRef.current = null;
            }
          });
        };
        
        // 使用事件委托
        container.addEventListener('mousedown', handleMouseDown, { capture: true });
        container.addEventListener('dragstart', handleDragStart, { capture: true });
        
        // 处理 dragover 事件，显示手动的 drop indicator
        // 在 Tauri 环境中，需要正确区分内部拖拽和外部文件拖拽
        const handleDragOver = (e: DragEvent) => {
          // 检测是否是内部块拖拽
          const types = Array.from(e.dataTransfer?.types || []);
          const isFileDrag = types.includes('Files') || types.includes('application/x-moz-file');
          const isInternalBlockDrag = types.includes('application/x-milkdown-block') || 
                                      (dragStateRef.current?.isDragging && !isFileDrag);
          
          // 如果是内部块拖拽，显示 drop indicator 并计算插入位置
          if (isInternalBlockDrag) {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) {
              e.dataTransfer.dropEffect = 'move';
            }
            
            // 更新 drop indicator 位置
            const indicator = dropIndicatorRef.current;
            const wrapper = wrapperRef.current;
            if (indicator && wrapper) {
              const wrapperRect = wrapper.getBoundingClientRect();
              const y = e.clientY;
              
              // 使用 ProseMirror 的 posAtCoords 获取精确位置
              safeEditorAction((ctx) => {
                try {
                  const view = ctx.get('editorView') as any;
                  if (!view) return;
                  
                  // 找到鼠标位置最近的块元素
                  const proseMirror = wrapper.querySelector('.ProseMirror');
                  if (!proseMirror) return;
                  
                  const blocks = proseMirror.querySelectorAll(':scope > *');
                  let closestBlock: Element | null = null;
                  let closestDistance = Infinity;
                  let insertBefore = true;
                  let closestBlockIndex = -1;
                  
                  blocks.forEach((block, index) => {
                    const rect = block.getBoundingClientRect();
                    const blockMiddle = rect.top + rect.height / 2;
                    const distance = Math.abs(y - blockMiddle);
                    
                    if (distance < closestDistance) {
                      closestDistance = distance;
                      closestBlock = block;
                      insertBefore = y < blockMiddle;
                      closestBlockIndex = index;
                    }
                  });
                  
                  if (closestBlock) {
                    const blockRect = closestBlock.getBoundingClientRect();
                    const indicatorY = insertBefore 
                      ? blockRect.top - wrapperRect.top 
                      : blockRect.bottom - wrapperRect.top;
                    
                    indicator.style.top = `${indicatorY}px`;
                    indicator.style.display = 'block';
                    
                    // 计算 ProseMirror 文档中的插入位置
                    // 获取目标块在文档中的位置
                    let targetPos = 0;
                    let currentBlockIndex = 0;
                    view.state.doc.forEach((node: any, offset: number) => {
                      if (currentBlockIndex === closestBlockIndex) {
                        targetPos = insertBefore ? offset : offset + node.nodeSize;
                      }
                      currentBlockIndex++;
                    });
                    
                    // 更新拖拽状态中的目标位置
                    if (dragStateRef.current) {
                      dragStateRef.current.targetInsertPos = targetPos;
                      dragStateRef.current.insertBefore = insertBefore;
                    }
                  } else {
                    indicator.style.display = 'none';
                  }
                } catch (err) {
                  debugLog.warn('[CrepeEditor] dragover position calc failed:', err);
                }
              });
            }
          } else {
            // 隐藏 indicator（外部文件拖入或非内部拖拽）
            const indicator = dropIndicatorRef.current;
            if (indicator) {
              indicator.style.display = 'none';
            }
          }
        };
        
        // 处理 dragleave 事件，隐藏 indicator
        const handleDragLeave = (e: DragEvent) => {
          // 只有当离开 wrapper 时才隐藏
          const relatedTarget = e.relatedTarget as Node | null;
          const wrapper = wrapperRef.current;
          if (wrapper && !wrapper.contains(relatedTarget)) {
            const indicator = dropIndicatorRef.current;
            if (indicator) {
              indicator.style.display = 'none';
            }
          }
        };
        
        // 处理 dragend 事件，清理拖拽状态
        const handleDragEnd = () => {
          // 隐藏 drop indicator
          const indicator = dropIndicatorRef.current;
          if (indicator) {
            indicator.style.display = 'none';
          }
          
          // 清理拖拽状态
          dragStateRef.current = null;
          
          safeEditorAction((ctx) => {
            try {
              const view = ctx.get('editorView') as any;
              if (view?.dom) {
                delete view.dom.dataset.dragging;
              }
              if (view) {
                view.dragging = null;
              }
            } catch { /* 非关键：dragend 清理失败不影响编辑器功能 */ }
          });
        };
        
        // 🔧 核心修复：处理 drop 事件
        // 策略：让 ProseMirror 处理 drop，我们只负责清理和提供备用方案
        const handleDrop = (e: DragEvent) => {
          // 隐藏 drop indicator
          const indicator = dropIndicatorRef.current;
          if (indicator) {
            indicator.style.display = 'none';
          }
          
          // 检测是否是内部块拖拽
          const types = Array.from(e.dataTransfer?.types || []);
          const isFileDrag = types.includes('Files') || types.includes('application/x-moz-file');
          const dragState = dragStateRef.current;
          
          debugLog.log('[CrepeEditor] Drop event:', { 
            types, 
            isFileDrag, 
            hasDragState: !!dragState,
            isDragging: dragState?.isDragging,
            sourcePos: dragState?.sourcePos,
            targetPos: dragState?.targetInsertPos,
          });
          
          // 如果不是内部块拖拽，让其他处理器处理
          if (!dragState?.isDragging || isFileDrag) {
            dragStateRef.current = null;
            return; // 不阻止，让 ProseMirror 或其他处理器处理
          }
          
          // 检查 ProseMirror 是否会处理这个 drop
          // 通过检查 view.dragging 是否存在
          let proseMirrorWillHandle = false;
          safeEditorAction((ctx) => {
            try {
              const view = ctx.get('editorView') as any;
              if (view?.dragging?.slice) {
                proseMirrorWillHandle = true;
                debugLog.log('[CrepeEditor] ProseMirror will handle drop');
              }
            } catch { /* 非关键：dragging 状态检查失败时 fallback 到自定义处理 */ }
          });
          
          // 如果 ProseMirror 会处理，让它处理，我们只清理状态
          if (proseMirrorWillHandle) {
            // 使用 setTimeout 延迟清理，让 ProseMirror 有时间处理
            setTimeout(() => {
              dragStateRef.current = null;
            }, 100);
            return; // 不阻止事件
          }
          
          // ProseMirror 不会处理，我们手动处理
          const { sourcePos, targetInsertPos } = dragState;
          
          // 验证位置有效性
          if (sourcePos < 0 || targetInsertPos < 0) {
            debugLog.warn('[CrepeEditor] Invalid drag positions:', { sourcePos, targetInsertPos });
            dragStateRef.current = null;
            return;
          }
          
          // 如果源位置和目标位置相同，不执行操作
          if (sourcePos === targetInsertPos) {
            debugLog.log('[CrepeEditor] Same position, skip move');
            dragStateRef.current = null;
            return;
          }
          
          // 阻止默认行为，由我们手动处理
          e.preventDefault();
          e.stopPropagation();
          
          debugLog.log('[CrepeEditor] Executing manual block move:', { sourcePos, targetInsertPos });
          
          // 执行块移动操作
          safeEditorAction((ctx) => {
            try {
              const view = ctx.get('editorView') as any;
              if (!view) {
                debugLog.warn('[CrepeEditor] No view available for drop');
                return;
              }
              
              const { state } = view;
              const sourceNode = state.doc.nodeAt(sourcePos);
              
              if (!sourceNode) {
                debugLog.warn('[CrepeEditor] Source node not found at pos:', sourcePos);
                return;
              }
              
              const sourceNodeSize = sourceNode.nodeSize;
              let tr = state.tr;
              
              if (targetInsertPos > sourcePos) {
                // 向下移动：先插入后删除
                const nodeToInsert = sourceNode.copy(sourceNode.content);
                tr = tr.insert(targetInsertPos, nodeToInsert);
                tr = tr.delete(sourcePos, sourcePos + sourceNodeSize);
              } else {
                // 向上移动：先删除后插入
                const nodeToInsert = sourceNode.copy(sourceNode.content);
                tr = tr.delete(sourcePos, sourcePos + sourceNodeSize);
                tr = tr.insert(targetInsertPos, nodeToInsert);
              }
              
              view.dispatch(tr.scrollIntoView());
              view.focus();
              
              debugLog.log('[CrepeEditor] Block move completed successfully');
            } catch (err) {
              debugLog.error('[CrepeEditor] Block move failed:', err);
            } finally {
              dragStateRef.current = null;
              try {
                const view = ctx.get('editorView') as any;
                if (view) {
                  view.dragging = null;
                  if (view.dom) {
                    delete view.dom.dataset.dragging;
                  }
                }
              } catch { /* 非关键：拖拽完成后状态清理失败不影响编辑器 */ }
            }
          });
        };
        
        // 在 wrapper 上绑定拖拽事件（drop indicator 在 wrapper 中）
        const wrapper = wrapperRef.current;
        if (wrapper) {
          wrapper.addEventListener('dragover', handleDragOver);
          wrapper.addEventListener('dragleave', handleDragLeave);
          wrapper.addEventListener('dragend', handleDragEnd);
          // 使用 capture 确保我们的处理器优先于 ProseMirror 内置的处理器
          wrapper.addEventListener('drop', handleDrop, { capture: true });
        }
        
        (crepe as any).__blockHandleCleanup = () => {
          container.removeEventListener('mousedown', handleMouseDown, { capture: true });
          container.removeEventListener('dragstart', handleDragStart, { capture: true });
          if (wrapper) {
            wrapper.removeEventListener('dragover', handleDragOver);
            wrapper.removeEventListener('dragleave', handleDragLeave);
            wrapper.removeEventListener('dragend', handleDragEnd);
            wrapper.removeEventListener('drop', handleDrop, { capture: true });
          }
          // 断开 MutationObserver
          if ((crepe as any).__blockHandleObserver) {
            (crepe as any).__blockHandleObserver.disconnect();
            (crepe as any).__blockHandleObserver = null;
          }
          // 确保清理拖拽状态
          dragStateRef.current = null;
        };

        // Tauri 图片上传修复：拦截图片上传区域的点击，使用 Tauri dialog 替代浏览器原生 file input
        // Milkdown ImageInput 使用 <label class="uploader" for={uuid}> 关联隐藏的 <input type="file">
        // 我们需要拦截 label 的点击，阻止它触发 file input，改用 Tauri dialog
        const isTauriEnv = typeof window !== 'undefined' &&
          Boolean((window as any).__TAURI_INTERNALS__);
        const uploader = createImageUploader(noteId);

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
            
            // 查找当前图片节点并更新其 src
            // 使用 crepeRef.current 获取最新的实例（异步操作期间编辑器可能重新初始化）
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
        
        // 🔧 调试：暂时禁用图片上传点击拦截器，排查编辑器点击问题
        // 使用 capture: true 在捕获阶段拦截，确保在 label 触发 file input 之前处理
        // container.addEventListener('click', handleImageUploadClick, { capture: true });
        debugLog.log('[CrepeEditor] 🔧 DEBUG: Image upload click handler DISABLED for debugging');
        
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
                
                emitImageUploadDebug('file_convert', 'success', '文件读取成功', {
                  fileName: file.name,
                  fileSize: file.size,
                  fileType: file.type,
                });
                
                // 上传文件
                const url = await uploader(file);
                
                emitImageUploadDebug('upload_complete', 'success', '拖放图片上传完成', {
                  url,
                  fileName: file.name,
                });
                
                // 更新图片节点（使用 crepeRef.current 获取最新实例）
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
        };

        // 通知就绪
        const api = buildApi();
        // 🔧 包裹 onReady 回调，防止回调内部的错误导致初始化失败
        try {
          onReady?.(api);
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
      if (crepeRef.current) {
        // 清理轻量内容监听器
        const viewChangeCleanup = (crepeRef.current as any).__viewChangeCleanup;
        if (typeof viewChangeCleanup === 'function') {
          viewChangeCleanup();
        }
        // 清理 Mermaid 观察器
        const mermaidCleanup = (crepeRef.current as any).__mermaidCleanup;
        if (typeof mermaidCleanup === 'function') {
          mermaidCleanup();
        }
        // 清理 block handle 修复
        const blockHandleCleanup = (crepeRef.current as any).__blockHandleCleanup;
        if (typeof blockHandleCleanup === 'function') {
          blockHandleCleanup();
        }
        // 清理拖拽调试监听
        const debugDragCleanup = (crepeRef.current as any).__debugDragCleanup;
        if (typeof debugDragCleanup === 'function') {
          debugDragCleanup();
        }
        // 清理图片上传修复
        const imageUploadCleanup = (crepeRef.current as any).__imageUploadCleanup;
        if (typeof imageUploadCleanup === 'function') {
          imageUploadCleanup();
        }
        // 清理基于 Pointer Events 的块拖拽
        cleanupBlockDrag();
        // 组件卸载时的销毁回调（避免依赖 plugin-listener 的 destroy 事件）
        try {
          onDestroy?.();
        } catch (err) {
          debugLog.warn('[CrepeEditor] onDestroy callback failed:', err);
        }
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
        style={{ display: 'none' }}
      />
    </div>
  );
});

CrepeEditor.displayName = 'CrepeEditor';

export default CrepeEditor;
