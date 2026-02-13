/**
 * Crepe 编辑器 React Hook
 * 提供更细粒度的编辑器控制
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { editorViewCtx, commandsCtx } from '@milkdown/kit/core';
import { replaceAll } from '@milkdown/kit/utils';
import { toggleMark, setBlockType, wrapIn, lift } from '@milkdown/prose/commands';
import { listItemSchema, wrapInBlockTypeCommand } from '@milkdown/kit/preset/commonmark';
import type { CrepeEditorApi } from './types';
import { createImageBlockConfig } from './features/imageUpload';
import i18next from 'i18next';

export interface UseCrepeEditorOptions {
  /** 容器元素 */
  container: HTMLElement | null;
  
  /** 初始内容 */
  defaultValue?: string;
  
  /** 笔记 ID */
  noteId?: string;
  
  /** 占位符 */
  placeholder?: string;
  
  /** 只读模式 */
  readonly?: boolean;
  
  /** 内容变化回调 */
  onChange?: (markdown: string) => void;
  
  /** 就绪回调 */
  onReady?: (api: CrepeEditorApi) => void;
  
  /** 焦点回调 */
  onFocus?: () => void;
  
  /** 失焦回调 */
  onBlur?: () => void;
}

export interface UseCrepeEditorReturn {
  /** 是否就绪 */
  isReady: boolean;
  
  /** API 对象 */
  api: CrepeEditorApi | null;
  
  /** 手动销毁 */
  destroy: () => Promise<void>;
}

/**
 * Crepe 编辑器 Hook
 */
export function useCrepeEditor(options: UseCrepeEditorOptions): UseCrepeEditorReturn {
  const {
    container,
    defaultValue = '',
    noteId,
    placeholder,
    readonly = false,
    onChange,
    onReady,
    onFocus,
    onBlur,
  } = options;

  const crepeRef = useRef<Crepe | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [api, setApi] = useState<CrepeEditorApi | null>(null);
  
  // 保持回调引用最新
  const callbacksRef = useRef({ onChange, onReady, onFocus, onBlur });
  callbacksRef.current = { onChange, onReady, onFocus, onBlur };

  /**
   * 构建 API 对象
   */
  const buildApi = useCallback((crepe: Crepe): CrepeEditorApi => {
    return {
      getMarkdown: () => {
        try {
          return crepe.getMarkdown();
        } catch (e) {
          console.error('[useCrepeEditor] getMarkdown failed:', e);
          return '';
        }
      },
      
      setMarkdown: (markdown: string) => {
        try {
          crepe.editor.action(replaceAll(markdown));
        } catch (e) {
          console.error('[useCrepeEditor] setMarkdown failed:', e);
        }
      },
      
      focus: () => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            view.focus();
          });
        } catch (e) {
          console.error('[useCrepeEditor] focus failed:', e);
        }
      },
      
      isReadonly: () => crepe.readonly,
      
      setReadonly: (value: boolean) => {
        crepe.setReadonly(value);
      },
      
      scrollToHeading: (text: string, level: number) => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const doc = view.state.doc;
            const searchText = text.toLowerCase().trim();
            
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
                if (nodeText.includes(searchText)) score = searchText.length / nodeText.length;
                else if (searchText.includes(nodeText)) score = nodeText.length / searchText.length * 0.8;
                
                if (score > 0 && (!bestMatch || score > bestMatch.score)) {
                  bestMatch = { pos, score };
                }
              }
              return true;
            });
            
            // 使用精确匹配或最佳模糊匹配
            const finalPos = targetPos >= 0 ? targetPos : bestMatch?.pos;
            
            if (finalPos !== undefined && finalPos >= 0) {
              // 滚动到目标位置
              const domAtPos = view.domAtPos(finalPos);
              const element = domAtPos.node instanceof Element 
                ? domAtPos.node 
                : domAtPos.node.parentElement;
              
              // 查找实际的标题元素（h1-h6）
              const headingElement = element?.closest('h1, h2, h3, h4, h5, h6') || element;
              headingElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          });
        } catch (e) {
          console.error('[useCrepeEditor] scrollToHeading failed:', e);
        }
      },
      
      getCrepe: () => crepe,
      
      destroy: async () => {
        await crepe.destroy();
        crepeRef.current = null;
        setIsReady(false);
        setApi(null);
      },
      
      insertAtCursor: (text: string) => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { state, dispatch } = view;
            const { from } = state.selection;
            const tr = state.tr.insertText(text, from);
            dispatch(tr);
            view.focus();
          });
        } catch (e) {
          console.error('[useCrepeEditor] insertAtCursor failed:', e);
        }
      },
      
      wrapSelection: (before: string, after: string) => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { state, dispatch } = view;
            const { from, to, empty } = state.selection;
            
            if (empty) {
              // 没有选中文本：插入前后标记并将光标置于中间
              const insertText = before + after;
              const tr = state.tr.insertText(insertText, from);
              // 将光标移动到 before 和 after 之间
              const newPos = from + before.length;
              tr.setSelection((state.selection.constructor as any).near(tr.doc.resolve(newPos)));
              dispatch(tr);
            } else {
              // 有选中文本：用标记包裹选中内容
              const selectedText = state.doc.textBetween(from, to);
              const wrappedText = before + selectedText + after;
              const tr = state.tr.replaceWith(from, to, state.schema.text(wrappedText));
              dispatch(tr);
            }
            view.focus();
          });
        } catch (e) {
          console.error('[useCrepeEditor] wrapSelection failed:', e);
        }
      },
      
      toggleLinePrefix: (prefix: string) => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { state, dispatch } = view;
            const { from } = state.selection;
            
            // 找到当前行的开始位置
            const $from = state.doc.resolve(from);
            const lineStart = $from.start($from.depth);
            const lineEnd = $from.end($from.depth);
            const lineText = state.doc.textBetween(lineStart, lineEnd);
            
            // 检查当前行是否已有此前缀
            const prefixWithSpace = prefix.endsWith(' ') ? prefix : prefix + ' ';
            
            if (lineText.startsWith(prefixWithSpace)) {
              // 移除前缀
              const tr = state.tr.delete(lineStart, lineStart + prefixWithSpace.length);
              dispatch(tr);
            } else if (lineText.match(/^(#{1,6}|>|-|\*|\d+\.|\- \[[ x]\])\s/)) {
              // 当前行有其他块级前缀，替换它
              const match = lineText.match(/^(#{1,6}|>|-|\*|\d+\.|\- \[[ x]\])\s/);
              if (match) {
                const tr = state.tr.replaceWith(
                  lineStart, 
                  lineStart + match[0].length, 
                  state.schema.text(prefixWithSpace)
                );
                dispatch(tr);
              }
            } else {
              // 添加前缀
              const tr = state.tr.insertText(prefixWithSpace, lineStart);
              dispatch(tr);
            }
            view.focus();
          });
        } catch (e) {
          console.error('[useCrepeEditor] toggleLinePrefix failed:', e);
        }
      },
      
      insertNewLineWithPrefix: (prefix: string) => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
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
          console.error('[useCrepeEditor] insertNewLineWithPrefix failed:', e);
        }
      },

      // ===== Milkdown 命令 API（使用 ProseMirror 命令直接操作）=====

      toggleBold: () => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const markType = view.state.schema.marks.strong;
            if (markType) {
              toggleMark(markType)(view.state, view.dispatch);
              view.focus();
            }
          });
        } catch (e) {
          console.error('[useCrepeEditor] toggleBold failed:', e);
        }
      },

      toggleItalic: () => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const markType = view.state.schema.marks.emphasis;
            if (markType) {
              toggleMark(markType)(view.state, view.dispatch);
              view.focus();
            }
          });
        } catch (e) {
          console.error('[useCrepeEditor] toggleItalic failed:', e);
        }
      },

      toggleStrikethrough: () => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            // Milkdown GFM 中删除线的 schema 名称是 strike_through（带下划线）
            const markType = view.state.schema.marks.strike_through || view.state.schema.marks.strikethrough;
            if (markType) {
              toggleMark(markType)(view.state, view.dispatch);
              view.focus();
            }
          });
        } catch (e) {
          console.error('[useCrepeEditor] toggleStrikethrough failed:', e);
        }
      },

      toggleInlineCode: () => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const markType = view.state.schema.marks.inlineCode || view.state.schema.marks.code;
            if (markType) {
              toggleMark(markType)(view.state, view.dispatch);
              view.focus();
            }
          });
        } catch (e) {
          console.error('[useCrepeEditor] toggleInlineCode failed:', e);
        }
      },

      setHeading: (level: number) => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const nodeType = view.state.schema.nodes.heading;
            if (nodeType) {
              setBlockType(nodeType, { level })(view.state, view.dispatch);
              view.focus();
            }
          });
        } catch (e) {
          console.error('[useCrepeEditor] setHeading failed:', e);
        }
      },

      toggleBulletList: () => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const nodeType = view.state.schema.nodes.bullet_list || view.state.schema.nodes.bulletList;
            if (nodeType) {
              const { $from } = view.state.selection;
              let isInside = false;
              for (let d = $from.depth; d > 0; d--) {
                if ($from.node(d).type === nodeType) {
                  isInside = true;
                  break;
                }
              }
              if (isInside) {
                lift(view.state, view.dispatch);
              } else {
                wrapIn(nodeType)(view.state, view.dispatch);
              }
              view.focus();
            }
          });
        } catch (e) {
          console.error('[useCrepeEditor] toggleBulletList failed:', e);
        }
      },

      toggleOrderedList: () => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const nodeType = view.state.schema.nodes.ordered_list || view.state.schema.nodes.orderedList;
            if (nodeType) {
              const { $from } = view.state.selection;
              let isInside = false;
              for (let d = $from.depth; d > 0; d--) {
                if ($from.node(d).type === nodeType) {
                  isInside = true;
                  break;
                }
              }
              if (isInside) {
                lift(view.state, view.dispatch);
              } else {
                wrapIn(nodeType)(view.state, view.dispatch);
              }
              view.focus();
            }
          });
        } catch (e) {
          console.error('[useCrepeEditor] toggleOrderedList failed:', e);
        }
      },

      toggleTaskList: () => {
        try {
          crepe.editor.action((ctx) => {
            try {
              const commands = ctx.get(commandsCtx);
              const listItem = listItemSchema.type(ctx);
              commands.call(wrapInBlockTypeCommand.key, {
                nodeType: listItem,
                attrs: { checked: false },
              });
            } catch (innerError) {
              console.error('[useCrepeEditor] toggleTaskList action failed:', innerError);
            }
            const view = ctx.get(editorViewCtx);
            view.focus();
          });
        } catch (e) {
          console.error('[useCrepeEditor] toggleTaskList failed:', e);
        }
      },

      toggleBlockquote: () => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const nodeType = view.state.schema.nodes.blockquote;
            if (nodeType) {
              const { $from } = view.state.selection;
              let isInside = false;
              for (let d = $from.depth; d > 0; d--) {
                if ($from.node(d).type === nodeType) {
                  isInside = true;
                  break;
                }
              }
              if (isInside) {
                lift(view.state, view.dispatch);
              } else {
                wrapIn(nodeType)(view.state, view.dispatch);
              }
              view.focus();
            }
          });
        } catch (e) {
          console.error('[useCrepeEditor] toggleBlockquote failed:', e);
        }
      },

      insertHr: () => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const nodeType = view.state.schema.nodes.hr || view.state.schema.nodes.horizontal_rule;
            if (nodeType) {
              const { tr } = view.state;
              const node = nodeType.create();
              view.dispatch(tr.replaceSelectionWith(node).scrollIntoView());
              view.focus();
            }
          });
        } catch (e) {
          console.error('[useCrepeEditor] insertHr failed:', e);
        }
      },

      insertCodeBlock: () => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const nodeType = view.state.schema.nodes.code_block || view.state.schema.nodes.codeBlock;
            if (nodeType) {
              setBlockType(nodeType)(view.state, view.dispatch);
              view.focus();
            }
          });
        } catch (e) {
          console.error('[useCrepeEditor] insertCodeBlock failed:', e);
        }
      },

      insertLink: (href?: string, text?: string) => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
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
          });
        } catch (e) {
          console.error('[useCrepeEditor] insertLink failed:', e);
        }
      },

      insertImage: (src?: string, alt?: string) => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const nodeType = view.state.schema.nodes.image;
            if (nodeType) {
              const node = nodeType.create({ src: src || '', alt: alt || '' });
              const { tr } = view.state;
              view.dispatch(tr.replaceSelectionWith(node).scrollIntoView());
              view.focus();
            }
          });
        } catch (e) {
          console.error('[useCrepeEditor] insertImage failed:', e);
        }
      },

      insertTable: () => {
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
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
          });
        } catch (e) {
          console.error('[useCrepeEditor] insertTable failed:', e);
        }
      },
    };
  }, []);

  /**
   * 手动销毁
   */
  const destroy = useCallback(async () => {
    if (crepeRef.current) {
      await crepeRef.current.destroy();
      crepeRef.current = null;
      setIsReady(false);
      setApi(null);
    }
  }, []);

  /**
   * 初始化编辑器
   */
  useEffect(() => {
    if (!container) return;

    let destroyed = false;

    const initEditor = async () => {
      try {
        const crepe = new Crepe({
          root: container,
          defaultValue,
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
            [CrepeFeature.ImageBlock]: createImageBlockConfig(noteId),
            [CrepeFeature.Placeholder]: {
              text: placeholder || i18next.t('notes:editor.placeholder.body'),
              mode: 'doc',
            },
            [CrepeFeature.Latex]: {
              katexOptions: { throwOnError: false },
            },
          },
        });

        // 注册事件监听
        crepe.on((listener) => {
          listener.markdownUpdated((ctx, markdown, prevMarkdown) => {
            if (markdown !== prevMarkdown && !destroyed) {
              callbacksRef.current.onChange?.(markdown);
            }
          });

          listener.focus(() => {
            if (!destroyed) callbacksRef.current.onFocus?.();
          });

          listener.blur(() => {
            if (!destroyed) callbacksRef.current.onBlur?.();
          });
        });

        if (readonly) {
          crepe.setReadonly(true);
        }

        await crepe.create();

        if (destroyed) {
          await crepe.destroy();
          return;
        }

        crepeRef.current = crepe;
        const editorApi = buildApi(crepe);
        setApi(editorApi);
        setIsReady(true);
        callbacksRef.current.onReady?.(editorApi);

      } catch (error) {
        console.error('[useCrepeEditor] Failed to initialize:', error);
      }
    };

    void initEditor();

    return () => {
      destroyed = true;
      if (crepeRef.current) {
        crepeRef.current.destroy().catch(console.error);
        crepeRef.current = null;
      }
      setIsReady(false);
      setApi(null);
    };
  }, [container, noteId, buildApi]); // defaultValue 故意不作为依赖，避免重复初始化

  /**
   * 同步只读状态
   */
  useEffect(() => {
    if (crepeRef.current && isReady) {
      crepeRef.current.setReadonly(readonly);
    }
  }, [readonly, isReady]);

  return {
    isReady,
    api,
    destroy,
  };
}
