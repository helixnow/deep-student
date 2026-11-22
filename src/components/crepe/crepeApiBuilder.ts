/**
 * CrepeEditorApi 命令式句柄工厂
 *
 * 将 CrepeEditor 对外暴露的全部命令式方法（Markdown 读写、选区快照、焦点控制、
 * 大纲标题跳转、ACR Agent 增量演出、格式/块命令代理与销毁清理）集中组装，
 * 所有方法均在调用时动态读取 ref 并通过 crepeViewAccess 统一解析 ProseMirror view。
 */

import type React from 'react';
import type { Crepe } from '@milkdown/crepe';
import { parserCtx, serializerCtx } from '@milkdown/kit/core';
import { replaceAll } from '@milkdown/kit/utils';
import { Slice } from '@milkdown/prose/model';
import { TextSelection } from '@milkdown/prose/state';
import i18next from 'i18next';
import { readCssTimeMs } from '@/shared/utils/cssTime';
import { debugLog } from '../../debug-panel/debugMasterSwitch';
import {
  emitOutlineDebugLog,
  emitOutlineDebugSnapshot,
} from '../../debug-panel/events/NotesOutlineDebugChannel';
import { showGlobalNotification } from '../UnifiedNotification';
import { resolveFlashSnippet } from './agentDiffFlash';
import { AgentScrollFollower } from './agentScrollFollow';
import {
  canEditCrepeView,
  canExecuteCrepeCommand,
  executeCrepeCommand,
  notifyCrepeCommandState,
  subscribeCrepeCommandState,
  type CrepeCommandId,
  type CrepeCommandRequest,
} from './commandRegistry';
import { stripImePlaceholder } from './crepeMarkdownSanitizer';
import {
  resolveCrepeEditorView,
  resolveCrepeEditorViewWithSource,
  withCrepeEditorView,
  type EditorViewRef,
} from './crepeViewAccess';
import { pickImageWithTauriDialog } from './features/imageUpload';
import { minimalReplace } from './minimalReplace';
import { normalizeMarkdown } from './normalizeMarkdown';
import {
  agentHighlightKey,
  type AgentHighlightMeta,
  type AgentHighlightState,
} from './plugins/agentHighlight';
import { blockIdentityKey, copyBlockWithFreshIdentity } from './plugins/blockIdentity';
import { focusBlockId } from './plugins/blockIdentity/links';
import { exportColumnsPlainMarkdown } from './plugins/columns';
import type {
  CrepeBlockActionsHost,
  CrepeDocumentCapabilities,
  CrepeEditorApi,
} from './types';
import type { UploadLifecycle } from './uploadLifecycle';
import { createAgentInsertTransaction } from './useCrepeEditor';

export interface CrepeApiBuilderDeps {
  crepeRef: React.MutableRefObject<Crepe | null>;
  viewRef: EditorViewRef;
  containerRef: React.RefObject<HTMLDivElement | null>;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  uploadsRef: React.RefObject<UploadLifecycle | null>;
  noteIdRef: React.RefObject<string | undefined>;
  readonlyRef: React.RefObject<boolean>;
  imePlaceholderLiveRef: React.MutableRefObject<boolean>;
  identityOriginalRef: React.MutableRefObject<string>;
  capabilitiesRef: React.MutableRefObject<CrepeDocumentCapabilities | null>;
  blockActionsHostRef: React.MutableRefObject<CrepeBlockActionsHost | null>;
  reviewLeasesRef: React.RefObject<Set<symbol>>;
  userActivityRef: React.RefObject<{ lastInputAt: number; composing: boolean }>;
  agentFollowerRef: React.MutableRefObject<AgentScrollFollower | null>;
  agentPulseTimerRef: React.MutableRefObject<number | null>;
  closeBlockMenu: () => void;
  openBlockMenuAtSelectionRef: React.RefObject<() => void>;
  cleanupBlockDragRef: React.RefObject<() => void>;
  runStashedCleanups: (crepe: unknown) => void;
  clearDebugGlobals: (crepe: unknown, view: unknown) => void;
}

/**
 * 创建 CrepeEditorApi 实例。
 * 注意：不要在构造期捕获 crepeRef.current / viewRef.current，而是在每个方法调用时动态读取。
 */
export function createCrepeEditorApi(deps: CrepeApiBuilderDeps): CrepeEditorApi {
  const {
    crepeRef,
    viewRef,
    containerRef,
    wrapperRef,
    uploadsRef,
    noteIdRef,
    readonlyRef,
    imePlaceholderLiveRef,
    identityOriginalRef,
    capabilitiesRef,
    blockActionsHostRef,
    reviewLeasesRef,
    userActivityRef,
    agentFollowerRef,
    agentPulseTimerRef,
    closeBlockMenu,
    openBlockMenuAtSelectionRef,
    cleanupBlockDragRef,
    runStashedCleanups,
    clearDebugGlobals,
  } = deps;

  const getAgentFollower = () =>
    agentFollowerRef.current ?? (agentFollowerRef.current = new AgentScrollFollower());

  const execute = async (id: CrepeCommandId, request?: CrepeCommandRequest) => {
    const view = viewRef.current;
    return view ? executeCrepeCommand(view, id, request) : false;
  };

  const run = (id: CrepeCommandId, request?: CrepeCommandRequest) => {
    void execute(id, request).catch((error) => showGlobalNotification('error', String(error)));
  };

  return {
    executeCommand: execute,
    subscribeCommandState: (listener) =>
      viewRef.current ? subscribeCrepeCommandState(viewRef.current, listener) : () => {},
    canExecuteCommand: (id, request) =>
      Boolean(viewRef.current && canExecuteCrepeCommand(viewRef.current, id, request)),

    setDocumentCapabilities: (grant) => {
      capabilitiesRef.current = grant?.noteId === noteIdRef.current ? grant : null;
      notifyCrepeCommandState(viewRef.current);
    },

    getPlainMarkdown: () => {
      const crepe = crepeRef.current;
      if (!crepe) return '';
      return (
        withCrepeEditorView(crepe, viewRef, (view, ctx) => {
          if (!ctx) return '';
          return exportColumnsPlainMarkdown(
            copyBlockWithFreshIdentity(view.state.doc, false),
            ctx.get(serializerCtx),
          );
        }) ?? ''
      );
    },

    acquireReviewLease: () => {
      const leases = reviewLeasesRef.current;
      const token = Symbol('crepe-review');
      leases.add(token);
      closeBlockMenu();
      cleanupBlockDragRef.current();
      const release = uploadsRef.current?.acquireReviewLease();
      notifyCrepeCommandState(viewRef.current);
      return () => {
        leases.delete(token);
        release?.();
        notifyCrepeCommandState(viewRef.current);
      };
    },

    getUploadState: () =>
      uploadsRef.current?.getState() ?? {
        pending: 0,
        running: 0,
        failed: 0,
        reviewLeases: reviewLeasesRef.current.size,
      },

    insertImageFromDevice: () => {
      const view = viewRef.current;
      if (!view || !canEditCrepeView(view)) return;
      uploadsRef.current?.start(
        [
          {
            name: i18next.t('notes:upload.choose', { defaultValue: '选择图片' }),
            read: async (signal) => pickImageWithTauriDialog(signal),
          },
        ],
        { pos: view.state.selection.from },
      );
    },

    configureBlockActions: (host) => {
      blockActionsHostRef.current = host;
      notifyCrepeCommandState(viewRef.current);
    },

    setBlockIdentityMode: (enabled) => {
      const view = viewRef.current;
      if (view && !view.isDestroyed) {
        view.dispatch(view.state.tr.setMeta(blockIdentityKey, enabled));
      }
    },

    focusBlock: (id) => {
      const view = viewRef.current;
      return Boolean(view && !view.isDestroyed && focusBlockId(view, id));
    },

    getMarkdown: () => {
      const crepe = crepeRef.current;
      if (!crepe) return '';
      try {
        const markdown = crepe.getMarkdown() || '';
        return imePlaceholderLiveRef.current ? stripImePlaceholder(markdown) : markdown;
      } catch (e) {
        debugLog.error('[CrepeEditor] getMarkdown failed:', e);
        return '';
      }
    },

    normalizeMarkdown: (markdown: string) => {
      const crepe = crepeRef.current;
      if (!crepe) throw new Error('Editor is not ready.');
      return crepe.editor.action((ctx) => normalizeMarkdown(ctx, markdown));
    },

    setMarkdown: (markdown: string) => {
      const crepe = crepeRef.current;
      if (!crepe) return false;
      try {
        closeBlockMenu();
        uploadsRef.current?.cancelAll();
        // 最小差异替换：只重建真正变化的区间（结果与 replaceAll 同一文档），
        // 未变化的段落/图片/代码块 NodeView 保留，选区与滚动按映射保持，不再整篇闪烁
        let applied = false;
        try {
          withCrepeEditorView(crepe, viewRef, (view, ctx) => {
            if (!ctx) return;
            const next = ctx.get(parserCtx)(markdown);
            if (!next) return;
            const tr = minimalReplace(view.state, next);
            if (tr) view.dispatch(tr);
            applied = true;
          });
        } catch (diffError) {
          debugLog.warn('[CrepeEditor] minimal setMarkdown failed, falling back to replaceAll:', diffError);
        }
        // Milkdown 版本类型差异，运行时兼容
        if (!applied) (crepe.editor as any).action(replaceAll(markdown));
        identityOriginalRef.current = markdown;
        // 文档已整体对齐到传入内容，残留的 IME 占位随之消失
        imePlaceholderLiveRef.current = false;
        return true;
      } catch (e) {
        debugLog.error('[CrepeEditor] setMarkdown failed:', e);
        return false;
      }
    },

    captureSelection: () => {
      const view = resolveCrepeEditorView(crepeRef.current, viewRef);
      if (!view?.state?.selection) return null;
      return {
        from: view.state.selection.from,
        to: view.state.selection.to,
      };
    },

    hasFocus: () => {
      const view = resolveCrepeEditorView(crepeRef.current, viewRef);
      return Boolean(view?.hasFocus?.());
    },

    getUserActivity: () => {
      const view = resolveCrepeEditorView(crepeRef.current, viewRef);
      const composing = userActivityRef.current.composing || Boolean(view?.composing);
      return { lastInputAt: userActivityRef.current.lastInputAt, composing };
    },

    restoreSelection: (snapshot) => {
      if (!snapshot) return;
      const view = resolveCrepeEditorView(crepeRef.current, viewRef);
      if (!view?.state?.doc || !view.dispatch) return;
      try {
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
      try {
        withCrepeEditorView(crepeRef.current, viewRef, (view) => {
          view.focus();
        });
      } catch (e) {
        debugLog.error('[CrepeEditor] focus failed:', e);
      }
    },

    focusStart: () => {
      try {
        withCrepeEditorView(crepeRef.current, viewRef, (view) => {
          view.dispatch(
            view.state.tr.setSelection(TextSelection.atStart(view.state.doc)).scrollIntoView(),
          );
          view.focus();
        });
      } catch (e) {
        debugLog.error('[CrepeEditor] focusStart failed:', e);
      }
    },

    focusEnd: () => {
      try {
        withCrepeEditorView(crepeRef.current, viewRef, (view) => {
          const { doc, schema } = view.state;
          const last = doc.lastChild;
          const tr = view.state.tr;
          const editable = !readonlyRef.current && view.editable;
          if (editable && last && !(last.type === schema.nodes.paragraph && last.content.size === 0)) {
            const paragraph = schema.nodes.paragraph?.createAndFill();
            if (paragraph) tr.insert(doc.content.size, paragraph);
          }
          tr.setSelection(TextSelection.atEnd(tr.doc));
          view.dispatch(tr.scrollIntoView());
          view.focus();
        });
      } catch (e) {
        debugLog.error('[CrepeEditor] focusEnd failed:', e);
      }
    },

    isReadonly: () => crepeRef.current?.readonly ?? false,

    setReadonly: (value: boolean) => {
      if (value) closeBlockMenu();
      if (value) uploadsRef.current?.cancelAll();
      crepeRef.current?.setReadonly(value);
    },

    scrollToHeading: (
      text: string,
      level: number,
      normalizedText?: string,
      matchesHeading?: (docHeadingText: string) => boolean,
      occurrence?: number,
    ) => {
      const crepe = crepeRef.current;
      const currentNoteId = noteIdRef.current ?? null;
      if (!crepe) {
        emitOutlineDebugLog({
          category: 'error',
          action: 'crepe:scrollToHeading:noCrepe',
          level: 'error',
          details: { noteId: currentNoteId, text, level, hasCrepeRef: false },
        });
        return;
      }

      try {
        const { view, source: viewSource } = resolveCrepeEditorViewWithSource(crepe, viewRef);

        if (!view) {
          emitOutlineDebugLog({
            category: 'error',
            action: 'crepe:scrollToHeading:noView',
            level: 'error',
            details: {
              noteId: currentNoteId,
              text,
              level,
              hasCrepe: Boolean(crepe),
              hasEditor: Boolean(crepe?.editor),
              hasCtx: Boolean(crepe?.editor?.ctx),
              hasContainer: Boolean(containerRef.current),
            },
          });
          return;
        }

        emitOutlineDebugLog({
          category: 'editor',
          action: 'crepe:scrollToHeading:viewObtained',
          details: { noteId: currentNoteId, viewSource, text, level },
        });

        const doc = view.state.doc;
        const searchText = (normalizedText ?? text).toLowerCase().trim();

        let targetPos = -1;
        let bestMatch: { pos: number; score: number } | null = null;
        // C6：occurrence 精确消歧；必须用显式标志短路兄弟节点遍历，避免被后续同名标题覆盖。
        const targetOccurrence = Math.max(0, occurrence ?? 0);
        let exactSeen = 0;
        let exactResolved = false;

        doc.descendants((node, pos) => {
          if (exactResolved) return false;
          if (node.type.name === 'heading' && (level < 1 || node.attrs?.level === level)) {
            const rawText = node.textContent;
            const nodeText = rawText.toLowerCase().trim();

            if (matchesHeading ? matchesHeading(rawText) : nodeText === searchText) {
              if (exactSeen === targetOccurrence) {
                targetPos = pos;
                exactResolved = true;
              } else {
                exactSeen += 1;
              }
              return false;
            }

            let score = 0;
            if (searchText && nodeText.includes(searchText)) {
              score = searchText.length / nodeText.length;
            } else if (searchText && searchText.includes(nodeText) && nodeText) {
              score = (nodeText.length / searchText.length) * 0.8;
            }

            if (score > 0 && (!bestMatch || score > bestMatch.score)) {
              bestMatch = { pos, score };
            }
          }
          return true;
        });

        const finalPos = targetPos >= 0 ? targetPos : bestMatch?.pos;

        emitOutlineDebugLog({
          category: 'editor',
          action: 'crepe:scrollToHeading:matchResult',
          details: {
            noteId: currentNoteId,
            searchText,
            requestedLevel: level,
            exactMatch: targetPos >= 0,
            bestMatchScore: bestMatch?.score ?? null,
            targetPos: finalPos ?? null,
            docSize: doc.nodeSize,
          },
        });

        if (finalPos !== undefined && finalPos >= 0) {
          const resolvedPos = Math.min(finalPos + 1, view.state.doc.nodeSize - 2);
          const selection = TextSelection.near(view.state.doc.resolve(resolvedPos));
          view.dispatch(view.state.tr.setSelection(selection));
          view.focus();

          emitOutlineDebugSnapshot({
            noteId: currentNoteId,
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
                const element =
                  domAtPos.node instanceof Element
                    ? domAtPos.node
                    : domAtPos.node.parentElement;
                headingElement = element?.closest('h1, h2, h3, h4, h5, h6') ?? null;
              } catch {
                // 忽略
              }
            }

            // 方式3: 在编辑器容器中按文本和级别查找标题
            if (!headingElement && containerRef.current && level >= 1 && level <= 6) {
              const candidates = containerRef.current.querySelectorAll(`h${level}`);
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
                  noteId: currentNoteId,
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
                  noteId: currentNoteId,
                  headingText: text,
                  containerHasHeadings:
                    containerRef.current?.querySelectorAll('h1, h2, h3, h4, h5, h6').length ?? 0,
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
              noteId: currentNoteId,
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
            noteId: currentNoteId,
            message: e instanceof Error ? e.message : String(e),
          },
        });
      }
    },

    getCrepe: () => crepeRef.current,

    getAgentHighlightState: () => {
      try {
        return (
          withCrepeEditorView(
            crepeRef.current,
            viewRef,
            (view): AgentHighlightState | null => agentHighlightKey.getState(view.state) ?? null,
          ) ?? null
        );
      } catch {
        return null;
      }
    },

    destroy: async () => {
      closeBlockMenu();
      const crepe = crepeRef.current;
      if (crepe) {
        runStashedCleanups(crepe);
        clearDebugGlobals(crepe, viewRef.current);
        await crepe.destroy();
        crepeRef.current = null;
        viewRef.current = null;
      }
    },

    insertAtCursor: (text: string) => {
      try {
        withCrepeEditorView(crepeRef.current, viewRef, (view) => {
          const { state, dispatch } = view;
          const { from } = state.selection;
          dispatch(state.tr.insertText(text, from));
          view.focus();
        });
      } catch (e) {
        debugLog.error('[CrepeEditor] insertAtCursor failed:', e);
      }
    },

    // ===== ACR agent API（R1-12）——不抢焦点、不进用户 undo =====
    agentInsert: (text: string, pos: number) => {
      if (!crepeRef.current || !text) return null;
      try {
        return (
          withCrepeEditorView(crepeRef.current, viewRef, (view) => {
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
              dispatch(
                view.state.tr.setMeta(agentHighlightKey, {
                  type: 'caret',
                  pos: cursor,
                } satisfies AgentHighlightMeta),
              );
            }
            // ACR 4.0：打字机演出的节流滚动跟随（AI 光标越出视口时温和滚入）
            getAgentFollower().followPos(view, cursor);
            return { from, to, cursor };
          }) ?? null
        );
      } catch (e) {
        debugLog.error('[CrepeEditor] agentInsert failed:', e);
        return null;
      }
    },

    agentInsertMarkdown: (markdown: string, pos: number, revealMs?: number) => {
      if (!crepeRef.current || !markdown) return null;
      try {
        return (
          withCrepeEditorView(crepeRef.current, viewRef, (view, ctx) => {
            if (!ctx) return null;
            const parsed = ctx.get(parserCtx)(markdown);
            if (!parsed) return null;
            let insertPos = Math.max(0, Math.min(pos, view.state.doc.content.size));
            // 结构化块插入必须落在顶层块边界：若调用方传入的 pos（如视觉 caret）落在标题/段落内部，
            // 先收敛到该顶层块的前/后边界，避免 tr.replace 劈开当前块或把标题顶到文末。
            const $insert = view.state.doc.resolve(insertPos);
            if ($insert.depth > 0) {
              insertPos = $insert.parentOffset === 0 ? $insert.before(1) : $insert.after(1);
            }
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
              revealMs,
            } satisfies AgentHighlightMeta);
            view.dispatch(tr);
            // 插入点保持在块边界（下一批结构块从这里接着插，不能劈开段落）；
            // 可见 AI 光标则落到最后一个文本块末尾，避免在两段之间单独占一行跳动。
            const visual = TextSelection.findFrom(view.state.doc.resolve(to), -1, true)?.head ?? to;
            if (visual !== to) {
              view.dispatch(
                view.state.tr.setMeta(agentHighlightKey, {
                  type: 'caret',
                  pos: visual,
                } satisfies AgentHighlightMeta),
              );
            }
            // ACR 4.0：结构化插入同样参与滚动跟随
            getAgentFollower().followPos(view, visual);
            return { from, to, cursor: to };
          }) ?? null
        );
      } catch (e) {
        debugLog.error('[CrepeEditor] agentInsertMarkdown failed:', e);
        return null;
      }
    },

    agentSignal: (meta: AgentHighlightMeta) => {
      try {
        withCrepeEditorView(crepeRef.current, viewRef, (view) => {
          let signal = meta;
          if (meta.type === 'caret') {
            // 块边界上的 caret 会被渲染成段间孤立的一行：就近收进文本块
            const pos = Math.max(0, Math.min(meta.pos, view.state.doc.content.size));
            const $pos = view.state.doc.resolve(pos);
            if (!$pos.parent.inlineContent) {
              const near =
                TextSelection.findFrom($pos, -1, true) ?? TextSelection.findFrom($pos, 1, true);
              if (near) signal = { ...meta, pos: near.head };
            }
          }
          view.dispatch(view.state.tr.setMeta(agentHighlightKey, signal));
          // ACR 4.0：caret 落点（run 起始/重定位）也做一次跟随
          if (signal.type === 'caret') {
            getAgentFollower().followPos(view, signal.pos);
          }
        });
      } catch (e) {
        debugLog.error('[CrepeEditor] agentSignal failed:', e);
      }
    },

    // ACR 4.0：破坏类直改（note_replace/note_set）后的变更区域演出
    agentFlashChange: (previousMarkdown: string, nextMarkdown: string) => {
      if (!crepeRef.current) return false;
      const located = resolveFlashSnippet(previousMarkdown, nextMarkdown);
      if (!located) return false; // 两文一致，无需演出

      try {
        return (
          withCrepeEditorView(crepeRef.current, viewRef, (view) => {
            // 在文档 textblock 中检索差异片段 → 高亮承载段落并滚入视口
            let blockFrom = -1;
            let blockTo = -1;
            if (located.snippet) {
              view.state.doc.descendants((node, pos) => {
                if (blockFrom >= 0) return false;
                if (
                  node.isTextblock
                  && typeof node.textContent === 'string'
                  && node.textContent.includes(located.snippet)
                ) {
                  blockFrom = pos + 1;
                  blockTo = pos + node.nodeSize - 1;
                  return false;
                }
                return true;
              });
            }

            if (blockFrom >= 0 && blockTo > blockFrom) {
              view.dispatch(
                view.state.tr.setMeta(agentHighlightKey, {
                  type: 'flash',
                  from: blockFrom,
                  to: blockTo,
                } satisfies AgentHighlightMeta),
              );
              getAgentFollower().followPos(view, blockFrom, true);
              return true;
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
              // 时长单源：CSS --acr-doc-pulse-ms + 缓冲
              agentPulseTimerRef.current = window.setTimeout(() => {
                agentPulseTimerRef.current = null;
                wrapper.classList.remove('crepe-agent-pulse');
              }, readCssTimeMs('--acr-doc-pulse-ms', 600) + 250);
              return true;
            }
            return false;
          }) ?? false
        );
      } catch (e) {
        debugLog.error('[CrepeEditor] agentFlashChange failed:', e);
        return false;
      }
    },

    getDocEndPos: () => {
      const view = resolveCrepeEditorView(crepeRef.current, viewRef);
      return view?.state?.doc?.content?.size ?? 0;
    },

    resolveHeadingPos: (heading: string) => {
      if (!crepeRef.current || !heading.trim()) return null;
      try {
        return (
          withCrepeEditorView(crepeRef.current, viewRef, (view) => {
            const doc = view.state.doc;
            const searchText = heading.toLowerCase().trim();
            let bestMatch: { pos: number; nodeSize: number; score: number } | null = null;

            doc.descendants((node, pos) => {
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

            if (!bestMatch) return null;
            // 标题节点之后：pos + nodeSize 为紧随其后的插入点
            return Math.min(bestMatch.pos + bestMatch.nodeSize, doc.content.size);
          }) ?? null
        );
      } catch (e) {
        debugLog.error('[CrepeEditor] resolveHeadingPos failed:', e);
        return null;
      }
    },

    wrapSelection: (before: string, after: string) => {
      try {
        withCrepeEditorView(crepeRef.current, viewRef, (view) => {
          const { state, dispatch } = view;
          const { from, to, empty } = state.selection;

          if (empty) {
            const insertText = before + after;
            const tr = state.tr.insertText(insertText, from);
            const newPos = from + before.length;
            tr.setSelection(TextSelection.create(tr.doc, newPos));
            dispatch(tr);
          } else {
            const selectedText = state.doc.textBetween(from, to);
            const wrappedText = before + selectedText + after;
            dispatch(state.tr.insertText(wrappedText, from, to));
          }
          view.focus();
        });
      } catch (e) {
        debugLog.error('[CrepeEditor] wrapSelection failed:', e);
      }
    },

    toggleLinePrefix: (prefix: string) => {
      try {
        withCrepeEditorView(crepeRef.current, viewRef, (view) => {
          const { state, dispatch } = view;
          const { from } = state.selection;
          const $from = state.doc.resolve(from);
          const depth = $from.depth > 0 ? 1 : 0;
          const blockStart = $from.start(depth);
          const blockEnd = $from.end(depth);
          const blockText = state.doc.textBetween(blockStart, blockEnd);
          const prefixWithSpace = prefix.endsWith(' ') ? prefix : `${prefix} `;

          if (blockText.startsWith(prefixWithSpace)) {
            dispatch(state.tr.delete(blockStart, blockStart + prefixWithSpace.length));
          } else {
            const match = blockText.match(/^(#{1,6}|>|-|\*|\d+\.|- \[[ x]\])\s/);
            if (match) {
              dispatch(state.tr.insertText(prefixWithSpace, blockStart, blockStart + match[0].length));
            } else {
              dispatch(state.tr.insertText(prefixWithSpace, blockStart));
            }
          }
          view.focus();
        });
      } catch (e) {
        debugLog.error('[CrepeEditor] toggleLinePrefix failed:', e);
      }
    },

    insertNewLineWithPrefix: (prefix: string) => {
      try {
        withCrepeEditorView(crepeRef.current, viewRef, (view) => {
          const { state, dispatch } = view;
          const { from } = state.selection;
          const prefixWithSpace = prefix.endsWith(' ') ? prefix : `${prefix} `;
          dispatch(state.tr.insertText(`\n${prefixWithSpace}`, from));
          view.focus();
        });
      } catch (e) {
        debugLog.error('[CrepeEditor] insertNewLineWithPrefix failed:', e);
      }
    },

    // Compatibility API methods all delegate to the same Milkdown-backed registry.
    toggleBold: () => run('bold'),
    toggleItalic: () => run('italic'),
    toggleStrikethrough: () => run('strikethrough'),
    toggleInlineCode: () => run('inline-code'),
    setHeading: (level) => {
      if (level >= 1 && level <= 6) run(`heading-${level}` as CrepeCommandId);
    },
    toggleBulletList: () => run('bullet-list', { toggle: true }),
    toggleOrderedList: () => run('ordered-list', { toggle: true }),
    toggleTaskList: () => run('task-list', { toggle: true }),
    toggleBlockquote: () => run('quote', { toggle: true }),
    insertHr: () => run('hr'),
    insertCodeBlock: () => run('code-block'),
    insertLink: (href, text) => run('link', { href, text }),
    insertImage: (src, alt) => run('image', { src, alt }),
    insertTable: () => run('table'),

    openBlockMenuAtSelection: () => {
      openBlockMenuAtSelectionRef.current();
    },
  };
}
