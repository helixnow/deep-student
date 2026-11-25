/**
 * Crepe 块操作菜单完整状态与交互 Hook
 *
 * 负责：
 * - 块句柄 pointerdown / pointerup / keydown 监听与无障碍属性注入
 * - 菜单状态同步失效（doc/note/readonly 切换时无竞态残留）
 * - 视口钳制、目标块多选高亮矩形追踪、键盘导航 + typeahead + Android 返回键拦截
 * - 官方块操作（含持久身份复制/跨页移动/块链接）与社区槽位贡献行执行及错误上报
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';
import type { Crepe } from '@milkdown/crepe';
import type { EditorView as ProseEditorView } from '@milkdown/prose/view';
import i18next from 'i18next';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import type { useOptionalUiKernel } from '@/ui-kernel/react';
import type { EditorBlockMenuContribution, SlotEntry } from '@/ui-sdk';
import {
  collectEditorBlockMenuRows,
  mergeEditorEntries,
  type EditorInstanceContext,
} from '@/ui-plugins/official/editor/editorSlots';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { debugLog } from '../../../debug-panel/debugMasterSwitch';
import { showGlobalNotification } from '../../UnifiedNotification';
import {
  contractBlockMenuTarget,
  registerBlockMenuContributions,
  type BlockMenuContributionRow,
} from '../blockMenuContributions';
import {
  findCrepeBlockMenuTypeaheadIndex,
  getNextCrepeBlockMenuIndex,
  shouldDismissCrepeBlockMenuForKey,
} from '../blockMenuState';
import {
  isBlockTargetCurrent,
  resolveBlockHandleTarget,
  resolveBlockSelection,
  resolveStableBlockTarget,
  type BlockTarget,
} from '../blockTarget';
import { canEditCrepeView, executeCrepeCommand } from '../commandRegistry';
import { preflightRootBlockIdentity } from '../plugins/blockIdentity/commands';
import { buildBlockLink } from '../plugins/blockIdentity/links';
import type { CrepeBlockActionsHost } from '../types';
import type { EditorViewRef } from '../crepeViewAccess';
import {
  desktopBlockEntries,
  type BlockMenuAction,
  type BlockMenuHighlight,
  type BlockMenuState,
  type BlockTransferState,
} from '../CrepeBlockMenu';

type OptionalUiKernel = ReturnType<typeof useOptionalUiKernel>;
type BlockMenuSlotEntries = readonly SlotEntry<EditorBlockMenuContribution>[] | undefined;

export interface UseCrepeBlockMenuOptions {
  isReady: boolean;
  readonly: boolean;
  noteId: string | undefined;
  containerRef: React.RefObject<HTMLDivElement | null>;
  crepeRef: React.RefObject<Crepe | null>;
  viewRef: EditorViewRef;
  noteIdRef: React.RefObject<string | undefined>;
  readonlyRef: React.RefObject<boolean>;
  identityOriginalRef: React.RefObject<string>;
  blockActionsHostRef: React.RefObject<CrepeBlockActionsHost | null>;
  editorInstanceRef: React.RefObject<EditorInstanceContext>;
  uiKernelRef: React.RefObject<OptionalUiKernel>;
  blockMenuEntries: BlockMenuSlotEntries;
}

export interface UseCrepeBlockMenuResult {
  blockMenu: BlockMenuState;
  blockMenuElRef: React.RefObject<HTMLDivElement | null>;
  blockMenuActive: number;
  blockMenuHighlights: BlockMenuHighlight[];
  blockTransfer: BlockTransferState;
  clearBlockTransfer: () => void;
  closeBlockMenu: () => void;
  invalidateBlockMenuIfStale: (view: ProseEditorView) => void;
  openBlockMenuAtSelection: () => void;
  identityActionBlockedReason: (action: BlockMenuAction, target: BlockTarget) => string | undefined;
  setBlockMenuActiveIndex: (index: number) => void;
  runContributedBlockMenuRow: (item: BlockMenuContributionRow) => void;
}

export function useCrepeBlockMenu({
  isReady,
  readonly,
  noteId,
  containerRef,
  crepeRef,
  viewRef,
  noteIdRef,
  readonlyRef,
  identityOriginalRef,
  blockActionsHostRef,
  editorInstanceRef,
  uiKernelRef,
  blockMenuEntries,
}: UseCrepeBlockMenuOptions): UseCrepeBlockMenuResult {
  const blockMenuElRef = useRef<HTMLDivElement>(null);
  const [blockMenu, setBlockMenuState] = useState<BlockMenuState>(null);
  const blockMenuRef = useRef<BlockMenuState>(null);
  const setBlockMenu = useCallback((menu: BlockMenuState) => {
    // Invalidate synchronously, including before React flushes a document/note switch.
    blockMenuRef.current = menu;
    setBlockMenuState(menu);
  }, []);

  const [blockMenuHighlights, setBlockMenuHighlights] = useState<BlockMenuHighlight[]>([]);
  const [blockMenuActive, setBlockMenuActive] = useState(-1);
  const blockMenuActiveRef = useRef(-1); // keydown 监听内读取，避免闭包过期
  const [blockTransfer, setBlockTransfer] = useState<BlockTransferState>(null);

  const blockMenuEntriesRef = useRef(blockMenuEntries);
  blockMenuEntriesRef.current = blockMenuEntries;

  const runOfficialBlockActionRef = useRef<(action: BlockMenuAction) => void>(() => {});

  const closeBlockMenu = useCallback(() => {
    setBlockMenu(null);
  }, [setBlockMenu]);

  const clearBlockTransfer = useCallback(() => {
    setBlockTransfer(null);
  }, []);

  const invalidateBlockMenuIfStale = useCallback(
    (view: ProseEditorView) => {
      const menu = blockMenuRef.current;
      if (menu && !isBlockTargetCurrent(view, menu.target)) {
        setBlockMenu(null);
      }
    },
    [setBlockMenu],
  );

  const setBlockMenuActiveIndex = useCallback((index: number) => {
    blockMenuActiveRef.current = index;
    setBlockMenuActive(index);
  }, []);

  /** 块链接 / 跨页移动的前置条件：与执行时同一组判断，提前置灰并说明原因（不再点了才报错） */
  const identityActionBlockedReason = useCallback(
    (action: BlockMenuAction, target: BlockTarget): string | undefined => {
      if (action !== 'copy-block-link' && action !== 'move-to-note') return undefined;
      const host = blockActionsHostRef.current;
      if (target.depth !== 1) {
        return i18next.t('notes:blockIdentity.topLevelOnly', '持久身份仅支持顶层块；嵌套块暂不支持。');
      }
      if (!host) {
        return i18next.t('notes:blockIdentity.hostRequired', '当前笔记尚未接入完整文档块操作。');
      }
      if (host.isDocumentWindowed()) {
        return i18next.t('notes:blockIdentity.fullDocumentRequired', '请先加载完整笔记，再创建块链接或跨页移动。');
      }
      if (action === 'copy-block-link' && target.nodes.length !== 1) {
        return i18next.t('notes:blockIdentity.singleLink', '复制块链接时请选择一个顶层块。');
      }
      return undefined;
    },
    [blockActionsHostRef],
  );

  /** A community block-menu row that throws or rejects only loses itself: it is counted against its plugin. */
  const reportBlockMenuRunError = useCallback(
    (entry: SlotEntry<unknown>, error: unknown) => {
      const kernel = uiKernelRef.current;
      if (kernel) {
        kernel.errors.report({
          pluginId: entry.owner,
          origin: entry.origin,
          phase: 'report',
          error,
          slot: 'editor.blockMenu',
          entryId: entry.id,
        });
      } else {
        console.error(`[editor.blockMenu] "${entry.id}" failed`, error);
      }
    },
    [uiKernelRef],
  );

  const collectMenuRows = useCallback(
    (view: ProseEditorView, target: BlockTarget) =>
      collectEditorBlockMenuRows(
        mergeEditorEntries(
          desktopBlockEntries(
            view,
            target,
            (action) => runOfficialBlockActionRef.current(action),
            identityActionBlockedReason,
          ),
          blockMenuEntriesRef.current,
        ),
        contractBlockMenuTarget(view, target, 'desktop-handle'),
        editorInstanceRef.current,
        reportBlockMenuRunError,
      ),
    [editorInstanceRef, identityActionBlockedReason, reportBlockMenuRunError],
  );

  const runContributedBlockMenuRow = useCallback(
    ({ entry, row }: BlockMenuContributionRow) => {
      const view = viewRef.current;
      const menu = blockMenu;
      if (row.disabled || !blockMenuEntriesRef.current?.includes(entry)) return;
      if (
        !view
        || !menu
        || menu !== blockMenuRef.current
        || readonlyRef.current
        || !canEditCrepeView(view)
        || menu.noteId !== noteIdRef.current
        || !isBlockTargetCurrent(view, menu.target)
      ) {
        setBlockMenu(null);
        return;
      }
      // The menu closes and focus returns to the editor before the row runs (contract).
      setBlockMenu(null);
      if (!view.isDestroyed) view.focus();
      try {
        const result = row.run(view);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((error) => reportBlockMenuRunError(entry, error));
        }
      } catch (error) {
        reportBlockMenuRunError(entry, error);
      }
    },
    [blockMenu, noteIdRef, readonlyRef, reportBlockMenuRunError, setBlockMenu, viewRef],
  );

  const runBlockAction = useCallback(
    (action: BlockMenuAction) => {
      const view = viewRef.current;
      const menu = blockMenu;
      if (!view || !menu || menu !== blockMenuRef.current) return;
      if (
        readonlyRef.current
        || !canEditCrepeView(view)
        || menu.noteId !== noteIdRef.current
        || !isBlockTargetCurrent(view, menu.target)
      ) {
        setBlockMenu(null);
        return;
      }
      setBlockMenu(null);
      if (
        action === 'copy-block-link'
        || action === 'move-to-note'
        || (action === 'duplicate' && menu.target.depth === 1 && blockActionsHostRef.current)
      ) {
        void (async () => {
          try {
            const crepe = crepeRef.current;
            const host = blockActionsHostRef.current;
            if (menu.target.depth !== 1) {
              throw new Error(i18next.t('notes:blockIdentity.topLevelOnly', '持久身份仅支持顶层块；嵌套块暂不支持。'));
            }
            if (!crepe || !host || !menu.noteId) {
              throw new Error(i18next.t('notes:blockIdentity.hostRequired', '当前笔记尚未接入完整文档块操作。'));
            }
            if (host.isDocumentWindowed()) {
              throw new Error(i18next.t('notes:blockIdentity.fullDocumentRequired', '请先加载完整笔记，再创建块链接或跨页移动。'));
            }
            if (action === 'copy-block-link' && menu.target.nodes.length !== 1) {
              throw new Error(i18next.t('notes:blockIdentity.singleLink', '复制块链接时请选择一个顶层块。'));
            }
            const fullMarkdown = host.getFullMarkdown();
            crepe.editor.action((ctx) =>
              preflightRootBlockIdentity(ctx, menu.target, fullMarkdown, identityOriginalRef.current),
            );
            const allIds = await host.transferService.ensureIdentities(menu.noteId, fullMarkdown);
            if (menu.noteId !== noteIdRef.current) {
              throw new Error('Note changed before the block operation completed.');
            }
            const ids = allIds.slice(menu.target.fromIndex, menu.target.toIndex);
            if (ids.length !== menu.target.nodes.length) {
              throw new Error('An empty trailing block cannot be linked or moved.');
            }
            if (action === 'duplicate') {
              const currentView = viewRef.current;
              const currentTarget = currentView && resolveStableBlockTarget(currentView, ids);
              if (!currentTarget || !(await executeCrepeCommand(currentView, 'duplicate', { target: currentTarget }))) {
                throw new Error('Block changed before duplication.');
              }
              return;
            }
            if (action === 'move-to-note') {
              setBlockTransfer({ noteId: menu.noteId, blockIds: ids, host });
              return;
            }
            await host.flushPendingSave();
            if (menu.noteId !== noteIdRef.current) {
              throw new Error('Note changed before the link was saved.');
            }
            await copyTextToClipboard(buildBlockLink({ noteId: menu.noteId, blockId: ids[0] }));
            showGlobalNotification('success', i18next.t('notes:blockIdentity.linkCopied', '块链接已复制'));
          } catch (error) {
            showGlobalNotification('error', error instanceof Error ? error.message : String(error));
          }
        })();
        return;
      }
      void executeCrepeCommand(view, action, { target: menu.target }).catch((error) =>
        showGlobalNotification('error', String(error)),
      );
    },
    [blockActionsHostRef, blockMenu, crepeRef, identityOriginalRef, noteIdRef, readonlyRef, setBlockMenu, viewRef],
  );
  runOfficialBlockActionRef.current = runBlockAction;

  // 选区入口锁定最近嵌套内容单元或同容器多块范围，与句柄共用命令目标。
  const openBlockMenuAtSelection = useCallback(() => {
    const view = viewRef.current;
    if (!view || !canEditCrepeView(view) || readonlyRef.current) return;
    try {
      const target = resolveBlockSelection(view);
      if (!target) return;
      const coords = view.coordsAtPos(Math.min(target.pos + 1, view.state.doc.content.size));
      const rows = collectMenuRows(view, target);
      setBlockMenu({
        target,
        noteId: noteIdRef.current,
        x: coords.left,
        y: Math.max(8, coords.bottom + 6),
        rows,
      });
    } catch (e) {
      debugLog.error('[CrepeEditor] openBlockMenuAtSelection failed:', e);
    }
  }, [collectMenuRows, noteIdRef, readonlyRef, setBlockMenu, viewRef]);

  // 块句柄点击与键盘激活监听 + 操作按钮 ARIA 属性补充
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
    const openHandleMenu = (handle: Element) => {
      const view = viewRef.current;
      if (!view || readonlyRef.current) return;
      const rect = handle.getBoundingClientRect();
      const target = resolveBlockHandleTarget(view, handle);
      if (!target) return;
      const rows = collectMenuRows(view, target);
      // 先按句柄位置放置；渲染后由 useLayoutEffect 按菜单实测尺寸钳入视口
      setBlockMenu({
        target,
        noteId: noteIdRef.current,
        x: rect.right + 6,
        y: Math.max(8, rect.top),
        rows,
      });
    };
    const onPointerUp = (event: PointerEvent) => {
      const current = pending;
      pending = null;
      if (!current || current.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) >= 8) return;
      event.preventDefault();
      event.stopPropagation();
      openHandleMenu(getMenuHandle(event.target) ?? current.handle);
    };
    const onHandleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (!(event.target instanceof Element)) return;
      const operation = event.target.closest('.milkdown-block-handle .operation-item');
      if (!operation) return;
      event.preventDefault();
      event.stopPropagation();
      const menuHandle = getMenuHandle(operation);
      if (menuHandle) openHandleMenu(menuHandle);
      // Crepe 的加号仅监听 pointerup，键盘激活复用它的插入与菜单流程。
      else operation.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    };
    // BlockProvider 在首个 animation frame 中把操作栏挂到编辑器。
    const accessibilityFrame = requestAnimationFrame(() => {
      const operations = container.querySelectorAll<HTMLElement>('.milkdown-block-handle .operation-item');
      operations.forEach((operation, index) => {
        const label = i18next.t(index === 0 ? 'notes:blockMenu.addAfter' : 'notes:blockMenu.dragOrMenu');
        operation.setAttribute('role', 'button');
        operation.setAttribute('aria-label', label);
        operation.setAttribute('aria-haspopup', 'menu');
        operation.title = label;
        operation.tabIndex = 0;
      });
    });
    container.addEventListener('pointerdown', onPointerDown, true);
    container.addEventListener('pointerup', onPointerUp, true);
    container.addEventListener('keydown', onHandleKeyDown, true);
    return () => {
      cancelAnimationFrame(accessibilityFrame);
      container.removeEventListener('pointerdown', onPointerDown, true);
      container.removeEventListener('pointerup', onPointerUp, true);
      container.removeEventListener('keydown', onHandleKeyDown, true);
    };
  }, [isReady, readonly, noteId, containerRef, collectMenuRows, noteIdRef, readonlyRef, setBlockMenu, viewRef]);

  // 切换笔记或只读状态时立即清空块菜单与跨页移动弹窗
  useLayoutEffect(() => {
    setBlockMenu(null);
    setBlockTransfer(null);
  }, [noteId, readonly, setBlockMenu]);

  // Paint the captured sibling range without changing PM selection, document or history.
  // The body portal is independent of editor NodeViews (including upload widgets).
  const updateBlockMenuHighlights = useCallback(() => {
    if (!blockMenu) {
      setBlockMenuHighlights([]);
      return;
    }
    const { target } = blockMenu;
    const view = viewRef.current;
    if (
      !view
      || blockMenuRef.current !== blockMenu
      || readonlyRef.current
      || blockMenu.noteId !== noteIdRef.current
      || !isBlockTargetCurrent(view, target)
    ) {
      setBlockMenu(null);
      return;
    }
    const rects: BlockMenuHighlight[] = [];
    let pos = target.pos;
    for (const node of target.nodes) {
      const dom = view.nodeDOM(pos);
      if (dom instanceof HTMLElement) {
        const { left, top, width, height } = dom.getBoundingClientRect();
        if (width > 0 && height > 0) rects.push({ pos, left, top, width, height });
      }
      pos += node.nodeSize;
    }
    setBlockMenuHighlights(rects);
  }, [blockMenu, noteIdRef, readonlyRef, setBlockMenu, viewRef]);

  useLayoutEffect(() => {
    if (!blockMenu) {
      setBlockMenuHighlights([]);
      return;
    }
    updateBlockMenuHighlights();
    const observer = new ResizeObserver(updateBlockMenuHighlights);
    observer.observe(blockMenu.target.view.dom);
    return () => {
      observer.disconnect();
    };
  }, [blockMenu, updateBlockMenuHighlights]);

  useEventRegistry(
    blockMenu
      ? [{ target: 'window', type: 'scroll', options: true, listener: updateBlockMenuHighlights }]
      : [],
    [blockMenu, updateBlockMenuHighlights],
  );

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
    el.focus({ preventScroll: true });
  }, [blockMenu]);

  useLayoutEffect(() => {
    if (blockMenuActive < 0) return;
    const item = blockMenuElRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[blockMenuActive];
    item?.focus({ preventScroll: true });
    item?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [blockMenuActive]);

  // The programmatic mobile block menu lives outside the React tree; hand it this instance's rows.
  useEffect(() => {
    if (!isReady) return;
    const view = viewRef.current;
    if (!view || view.isDestroyed) return;
    return registerBlockMenuContributions(view, {
      entries: blockMenuEntries ?? [],
      editor: editorInstanceRef.current,
      onError: reportBlockMenuRunError,
    });
  }, [blockMenuEntries, editorInstanceRef, isReady, reportBlockMenuRunError, viewRef]);

  // 全局点击/键盘导航/typeahead/输入关闭监听
  const handleGlobalMenuEvent = useCallback(
    (event: Event) => {
      if (!blockMenu) return;
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          setBlockMenu(null);
          viewRef.current?.focus();
          return;
        }
        // 键盘导航：↑↓ 循环、Home/End 跳首尾、Enter 执行高亮项（未高亮时按原契约关闭菜单）
        const communityRows = blockMenu.rows ?? [];
        const navIndex = getNextCrepeBlockMenuIndex({
          key: event.key,
          activeIndex: blockMenuActiveRef.current,
          itemCount: communityRows.length,
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
          const index = blockMenuActiveRef.current;
          const selected = communityRows[index];
          if (selected.row.disabled) {
            if (selected.entry.origin === 'builtin') setBlockMenu(null);
            return;
          }
          if (selected.entry.origin === 'builtin') selected.row.run(blockMenu.target.view);
          else runContributedBlockMenuRow(selected);
          return;
        }
        // typeahead 先于 dismiss：单个可打印字符先尝试按 label 前缀命中
        if (
          event.key.length === 1
          && !event.metaKey
          && !event.ctrlKey
          && !event.altKey
          && !event.isComposing
        ) {
          const typeaheadIndex = findCrepeBlockMenuTypeaheadIndex(
            communityRows.map(({ row }) => row.label),
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
        if (
          !shouldDismissCrepeBlockMenuForKey({
            key: event.key,
            editorTarget,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            isComposing: event.isComposing,
          })
        ) {
          return;
        }
      } else if (event.target instanceof Element && event.target.closest('.crepe-block-menu')) {
        return;
      }
      setBlockMenu(null);
    },
    [blockMenu, runContributedBlockMenuRow, setBlockMenu, setBlockMenuActiveIndex, viewRef],
  );

  const handleGlobalBeforeInput = useCallback(
    (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.ProseMirror')) {
        setBlockMenu(null);
      }
    },
    [setBlockMenu],
  );

  useEventRegistry(
    blockMenu
      ? [
          { target: 'window', type: 'pointerdown', options: true, listener: handleGlobalMenuEvent },
          { target: 'window', type: 'keydown', options: true, listener: handleGlobalMenuEvent },
          { target: 'window', type: 'beforeinput', options: true, listener: handleGlobalBeforeInput },
          { target: 'window', type: 'resize', listener: handleGlobalMenuEvent },
        ]
      : [],
    [blockMenu, handleGlobalBeforeInput, handleGlobalMenuEvent],
  );

  // 📱 Android 系统返回键：块菜单打开时先关菜单（overlay 级），避免返回键穿透到
  // 底层视图/导航。仅随开合注册注销，菜单位置变化不重挂 handler。
  const blockMenuOpen = !!blockMenu;
  useEffect(() => {
    if (!blockMenuOpen) return;
    return registerBackHandler(() => {
      setBlockMenu(null);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [blockMenuOpen, setBlockMenu]);

  return {
    blockMenu,
    blockMenuElRef,
    blockMenuActive,
    blockMenuHighlights,
    blockTransfer,
    clearBlockTransfer,
    closeBlockMenu,
    invalidateBlockMenuIfStale,
    openBlockMenuAtSelection,
    identityActionBlockedReason,
    setBlockMenuActiveIndex,
    runContributedBlockMenuRow,
  };
}
