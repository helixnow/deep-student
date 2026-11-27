import React, { useEffect, useLayoutEffect, useMemo, useRef, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Z_INDEX } from '@/config/zIndex';
import { readCssDurationMs, useMotionPresence } from '@/hooks/useMotionPresence';
import {
  Plus,
  Pencil,
  Check,
  CheckCircle,
  CheckSquare,
  Circle,
  Eye,
  EyeSlash,
  TextB,
  TextItalic,
  TextUnderline,
  TextStrikethrough,
  TextHOne,
  TextHTwo,
  TextHThree,
  TextT,
  Smiley,
  Link,
  LinkSimple,
  LineSegment,
  Palette,
  Highlighter,
  CaretRight,
  CaretDown,
  Trash,
  Copy,
  Scissors,
  ClipboardText,
  MagnifyingGlassPlus,
  CornersOut,
  Note,
  BracketsCurly,
  Cards,
  TreeStructure,
  ListBullets,
  MagicWand,
  ChatCircleDots,
  Quotes,
  Article,
  Flag,
  ChartPieSlice,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { getErrorMessage } from '@/utils/errorUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { tweenFast, transitionInstant } from '@/styles/motion-springs';
import {
  BACK_PRIORITY,
  registerBackHandler,
} from '@/app/navigation/androidBackCoordinator';
import { useMindMapStore, useMindMapStoreApi } from '../../store';
import type { MindMapStoreApi } from '../../store';
import { useMindMapIsActive } from '../../MindMapActiveContext';
import { useMindMapDarkMode } from '../../hooks/useMindMapTheme';
import { useImeCompositionGuard } from '../../hooks/useImeCompositionGuard';
import { exportMindMapSelectionToHandoutNote } from '../../interop/handoutExport';
import { findNodeById, findParentNode } from '../../utils/node/find';
import { collectTopLevelNodeIds, traverseDFS } from '../../utils/node/traverse';
import { serializeNodesToOutlineText } from '../../utils/node/outlineText';
import { countAllDescendants } from '../../utils/layout/countDescendants';
import { resolveSiblingRangeForSummary } from '../../utils/summaryBraces';
import {
  encodeMindMapClipboard,
  fingerprintText,
  readMindMapClipboard,
  writeMindMapClipboard,
} from '../../utils/clipboardCodec';
import { looksLikeMarkdownList, markdownListToNodes } from '../../utils/pasteMarkdown';
import type { MindMapNode, UpdateNodeParams } from '../../types';
import { getQuickTextColors, getQuickBgColors } from '../../constants';
import { EmojiPicker } from '../shared/EmojiPicker';

export type MindMapAiNodeAction = 'expand' | 'summarize' | 'cloze' | 'ask';

const PRIORITY_LEVELS = [1, 2, 3, 4, 5, 6] as const;
const PROGRESS_PRESETS = [0, 25, 50, 75, 100] as const;
const SAFE_HREF_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

function normalizeSafeHref(raw: string): { ok: true; href: string | undefined } | { ok: false } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, href: undefined };
  try {
    const parsed = new URL(trimmed);
    if (SAFE_HREF_SCHEMES.has(parsed.protocol)) {
      return { ok: true, href: trimmed };
    }
    return { ok: false };
  } catch {
    try {
      const candidate = trimmed.startsWith('//') ? `https:${trimmed}` : `https://${trimmed}`;
      const parsed = new URL(candidate);
      if (SAFE_HREF_SCHEMES.has(parsed.protocol) && parsed.hostname.includes('.')) {
        return { ok: true, href: candidate };
      }
      return { ok: false };
    } catch {
      return { ok: false };
    }
  }
}

function countForestNodes(nodes: MindMapNode[]): number {
  let count = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const item = stack.pop()!;
    count += 1;
    if (item.children?.length) stack.push(...item.children);
  }
  return count;
}

function resolveClipboardTargetNodes(
  root: MindMapNode,
  rawIds: string[],
  options?: { excludeRoot?: boolean },
): { ids: string[]; nodes: MindMapNode[] } {
  let sourceIds = rawIds;
  if (!options?.excludeRoot && rawIds.includes(root.id) && root.children.length > 0) {
    sourceIds = root.children.map((child) => child.id);
  }
  const ids = collectTopLevelNodeIds(root, sourceIds, options);
  const wanted = new Set(ids);
  const nodeById = new Map<string, MindMapNode>();
  traverseDFS(root, (item) => {
    if (wanted.has(item.id)) nodeById.set(item.id, item);
  });
  return {
    ids,
    nodes: ids.flatMap((id) => {
      const item = nodeById.get(id);
      return item ? [item] : [];
    }),
  };
}

/**
 * 复用系统剪贴板编解码器执行节点复制（供右键菜单与触屏工具条共享），
 * 让跨导图无损粘贴与跨应用 Markdown 粘贴即时生效。
 */
export function copyNodesWithSystemClipboard(
  storeApi: MindMapStoreApi,
  rawIds: string[],
  t: TFunction<'mindmap'>,
): void {
  const state = storeApi.getState();
  const { ids, nodes } = resolveClipboardTargetNodes(state.document.root, rawIds);
  if (ids.length === 0) return;
  state.copyNodes(ids);
  if (nodes.length > 0) {
    void writeMindMapClipboard(nodes);
    showGlobalNotification(
      'success',
      t('shellV2.clipboard.copiedNodes', {
        count: countForestNodes(nodes),
        defaultValue: '已复制 {{count}} 个节点',
      }),
    );
  }
}

/** 复用系统剪贴板编解码器执行节点剪切（自动保护根节点） */
export function cutNodesWithSystemClipboard(
  storeApi: MindMapStoreApi,
  rawIds: string[],
  t: TFunction<'mindmap'>,
): void {
  const state = storeApi.getState();
  const { ids, nodes } = resolveClipboardTargetNodes(state.document.root, rawIds, {
    excludeRoot: true,
  });
  if (ids.length === 0) return;
  state.cutNodes(ids);
  if (nodes.length > 0) {
    void writeMindMapClipboard(nodes);
    showGlobalNotification(
      'success',
      t('shellV2.clipboard.cutNodes', {
        count: countForestNodes(nodes),
        defaultValue: '已剪切 {{count}} 个节点',
      }),
    );
  }
}

/**
 * 复用系统剪贴板仲裁器执行粘贴：
 * 1. 系统剪贴板不可读/为空 → 回退 store 内部剪贴板；
 * 2. 指纹与本实例内部剪贴板一致 → 走内部 pasteNodes（保留 cut 清空语义）；
 * 3. 结构化载荷（跨导图）→ 灌回内部剪贴板后 pasteNodes；
 * 4. Markdown 列表 / HTML 大纲 → pasteMarkdownChildren 自动生成层级子树；
 * 5. 多行纯文本 → pasteTextChildren 逐行生成子节点。
 */
export async function pasteNodesWithSystemClipboard(
  storeApi: MindMapStoreApi,
  targetId: string,
  t: TFunction<'mindmap'>,
): Promise<boolean> {
  const read = await readMindMapClipboard();
  const state = storeApi.getState();

  if (read.kind === 'empty') {
    if (state.clipboard && state.clipboard.nodes.length > 0) {
      state.pasteNodes(targetId);
      return true;
    }
    showGlobalNotification(
      'info',
      t('clipboard.empty', { defaultValue: '剪贴板为空' }),
    );
    return false;
  }

  if (state.clipboard && state.clipboard.nodes.length > 0 && read.text !== null) {
    const encoded = encodeMindMapClipboard(state.clipboard.nodes);
    if (encoded && encoded.payload.fingerprint === fingerprintText(read.text)) {
      state.pasteNodes(targetId);
      return true;
    }
  }

  if (read.kind === 'structured') {
    const hydrated = {
      nodes: read.payload.nodes,
      sourceOperation: 'copy' as const,
      copiedAt: read.payload.copiedAt,
    };
    type ClipboardState = ReturnType<MindMapStoreApi['getState']>['clipboard'];
    storeApi.setState({ clipboard: hydrated as unknown as ClipboardState });
    storeApi.getState().pasteNodes(targetId);
    return true;
  }

  const text = read.text;
  if (!text?.trim()) return false;

  const markdown =
    read.kind === 'markdown'
      ? read.markdown
      : looksLikeMarkdownList(text)
        ? text
        : null;
  if (markdown) {
    try {
      if (markdownListToNodes(markdown).length > 0) {
        state.pasteMarkdownChildren(targetId, markdown);
        return true;
      }
    } catch {
      showGlobalNotification(
        'warning',
        t('clipboard.pasteParseFailed', {
          defaultValue: '粘贴内容过大或层级过深，无法解析',
        }),
      );
      return false;
    }
  }

  const lines =
    read.kind === 'lines'
      ? read.lines
      : text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  state.pasteTextChildren(targetId, lines);
  return true;
}

interface CanvasContextMenuProps {
  isOpen: boolean;
  position: { x: number; y: number };
  nodeId: string | null;
  /** 右键关联线时传入；与 nodeId 互斥 */
  associationId?: string | null;
  /** 画布空白处右键：与 nodeId / associationId 互斥 */
  paneMenu?: boolean;
  onClose: () => void;
  onOpenResourcePicker?: (nodeId: string) => void;
  onFocusBranch?: (nodeId: string) => void;
  /** 进入「添加关联线」连线模式 */
  onStartAssociation?: (nodeId: string) => void;
  onEditAssociationLabel?: (associationId: string) => void;
  onDeleteAssociation?: (associationId: string) => void;
  /** 画布空白菜单：适应视图 */
  onFitView?: () => void;
  /** 画布空白菜单：当前处于分支专注模式时提供退出入口 */
  onExitFocusMode?: (() => void) | null;
  /** 画布原生一键 AI 菜单回调；未传时走 mindmap:ai-action 自定义事件 + selectionToChat 兜底 */
  onAiNodeAction?: (action: MindMapAiNodeAction, nodeId: string) => void;
}

/** 菜单外壳：对齐 AppMenu 的 --menu-shell-* 语言（与全局下拉/右键菜单同族） */
const MENU_SHELL_CLASS = cn(
  'mindmap-container fixed min-w-[200px] max-w-[248px]',
  'max-h-[calc(100vh-16px)] rounded-[var(--menu-shell-radius)]',
  'border border-[var(--menu-shell-border)] bg-[var(--menu-shell-surface)]',
  'text-[var(--menu-shell-foreground)] shadow-[var(--menu-shell-shadow)]',
  '[backdrop-filter:var(--menu-shell-backdrop-filter)]',
  'ui-zoom-fade-in ui-zoom-fade-out outline-none',
);

/** 键盘导航可达的菜单项标记（MenuItem / 格式按钮 / 色板都会带上） */
const MENU_ITEM_ATTR = 'data-mm-menuitem';

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  destructive?: boolean;
  disabled?: boolean;
  active?: boolean;
  onClick: () => void;
}

const MenuItem: React.FC<MenuItemProps> = ({ icon, label, shortcut, destructive, disabled, active, onClick }) => (
  <DsButton variant="ghost"
    role="menuitem"
    {...{ [MENU_ITEM_ATTR]: '' }}
    className={cn(
      'flex items-center gap-2 w-full px-2.5 py-1.5 rounded-[var(--menu-shell-row-radius)] text-[13px] text-left transition-colors',
      '[@media(pointer:coarse)]:!min-h-[44px]',
      'focus-visible:outline-none focus-visible:bg-[var(--menu-shell-row-hover)]',
      destructive
        ? 'text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10'
        : active
          ? 'text-primary font-medium hover:bg-[var(--menu-shell-row-hover)]'
          : 'text-[var(--menu-shell-foreground)] hover:bg-[var(--menu-shell-row-hover)]',
      disabled && 'opacity-40 pointer-events-none'
    )}
    onClick={onClick}
    disabled={disabled}
  >
    <span className="w-4 h-4 flex-shrink-0 flex items-center justify-center">{icon}</span>
    <span className="flex-1">{label}</span>
    {active && (
      <Check size={12} className="text-primary mr-1 shrink-0" aria-hidden="true" />
    )}
    {shortcut && (
      <span className="text-[11px] text-muted-foreground ml-auto pl-2 flex-shrink-0">{shortcut}</span>
    )}
  </DsButton>
);

const MenuSeparator: React.FC = () => (
  <div className="h-px bg-[var(--menu-shell-border)] my-1 mx-2" />
);

/** 子树内是否存在挖空区间（决定「清除分支挖空」是否展示） */
function subtreeHasBlanks(node: MindMapNode): boolean {
  if (node.blankedRanges && node.blankedRanges.length > 0) return true;
  return node.children.some(subtreeHasBlanks);
}

/** 内联颜色选择面板 */
export const ColorPalette: React.FC<{
  colors: string[];
  activeColor?: string;
  onSelect: (color: string | undefined) => void;
}> = ({ colors, activeColor, onSelect }) => {
  const { t } = useTranslation('mindmap');
  return (
    <div className="flex flex-wrap items-center gap-1 px-2 py-1.5">
      {colors.map(color => {
        const selected = activeColor === color;
        const label = t('contextMenu.selectColor', {
          defaultValue: '选择颜色 {{color}}',
          color,
        });
        return (
          <DsButton
            key={color}
            variant="ghost" size="icon" iconOnly
            {...{ [MENU_ITEM_ATTR]: '' }}
            className={cn(
              '!w-[18px] !h-[18px] !min-w-0 !p-0 !rounded-full border-2 transition-colors motion-reduce:transition-none flex-shrink-0',
              '[@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:!h-11',
              selected
                ? 'border-primary ring-2 ring-primary/60 ring-offset-1 ring-offset-[var(--menu-shell-surface)]'
                : 'border-transparent hover:border-[var(--mm-text-secondary)] hover:ring-2 hover:ring-[var(--mm-border-strong)]',
            )}
            style={{ backgroundColor: color }}
            onClick={(e) => { e.stopPropagation(); onSelect(color); }}
            aria-label={label}
            aria-pressed={selected}
            title={label}
          />
        );
      })}
      <DsButton variant="ghost" size="icon" iconOnly {...{ [MENU_ITEM_ATTR]: '' }} className="!w-[18px] !h-[18px] !min-w-0 !p-0 !rounded-full [@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:!h-11 border border-[var(--menu-shell-border)] text-muted-foreground hover:bg-[var(--menu-shell-row-hover)] flex-shrink-0" onClick={(e) => { e.stopPropagation(); onSelect(undefined); }} aria-label={t('contextMenu.clearColor', { defaultValue: '清除颜色' })}>
        <X className="w-2.5 h-2.5" />
      </DsButton>
    </div>
  );
};

export const CanvasContextMenu: React.FC<CanvasContextMenuProps> = ({
  isOpen,
  position,
  nodeId,
  associationId = null,
  paneMenu = false,
  onClose,
  onOpenResourcePicker,
  onFocusBranch,
  onStartAssociation,
  onEditAssociationLabel,
  onDeleteAssociation,
  onFitView,
  onExitFocusMode,
  onAiNodeAction,
}) => {
  const { t } = useTranslation('mindmap');
  const menuRef = useRef<HTMLDivElement>(null);
  const hrefInputRef = useRef<HTMLInputElement>(null);
  const {
    onCompositionStart: onHrefCompositionStart,
    onCompositionEnd: onHrefCompositionEnd,
    isComposingKeyEvent: isHrefComposingKeyEvent,
  } = useImeCompositionGuard();
  const isMindMapActive = useMindMapIsActive();
  const isDark = useMindMapDarkMode();
  const quickTextColors = useMemo(() => getQuickTextColors(isDark) as unknown as string[], [isDark]);
  const quickBgColors = useMemo(() => getQuickBgColors(isDark) as unknown as string[], [isDark]);
  const storeApi = useMindMapStoreApi();
  const document = useMindMapStore(s => s.document);
  const mindmapId = useMindMapStore(s => s.mindmapId);
  const addNode = useMindMapStore(s => s.addNode);
  const deleteNode = useMindMapStore(s => s.deleteNode);
  const deleteNodes = useMindMapStore(s => s.deleteNodes);
  const updateNode = useMindMapStore(s => s.updateNode);
  const toggleCollapse = useMindMapStore(s => s.toggleCollapse);
  const setEditingNodeId = useMindMapStore(s => s.setEditingNodeId);
  const setEditingNoteNodeId = useMindMapStore(s => s.setEditingNoteNodeId);
  const setFocusedNodeId = useMindMapStore(s => s.setFocusedNodeId);
  const expandAll = useMindMapStore(s => s.expandAll);
  const collapseAll = useMindMapStore(s => s.collapseAll);
  const reciteMode = useMindMapStore(s => s.reciteMode);
  const blankBranchNodes = useMindMapStore(s => s.blankBranchNodes);
  const clearBranchBlanks = useMindMapStore(s => s.clearBranchBlanks);
  const selection = useMindMapStore(s => s.selection);
  const toggleNodeFlashcard = useMindMapStore(s => s.toggleNodeFlashcard);
  const addSummaryBrace = useMindMapStore(s => s.addSummaryBrace);

  /** 「添加图标」内联展开的 emoji 面板 */
  const [showIconPanel, setShowIconPanel] = useState(false);
  /** 「添加/编辑超链接」内联输入框 */
  const [showHrefPanel, setShowHrefPanel] = useState(false);
  const [hrefDraft, setHrefDraft] = useState('');
  const [exportingHandout, setExportingHandout] = useState(false);
  /** 删除带子树节点或批量删除的内联二次确认（危险项不弹 Dialog，原位展开确认条） */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const prefersReducedMotion = useReducedMotion();
  /** 钳位后的最终坐标；null = 尚未测量（隐藏渲染，避免越界闪跳） */
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const presence = useMotionPresence(isOpen, {
    exitMs: readCssDurationMs('--dropdown-close-dur', 150),
    enter: 'animation',
  });

  useEffect(() => {
    if (!isOpen || !isMindMapActive) return;
    return registerBackHandler(() => {
      if (showHrefPanel) {
        setShowHrefPanel(false);
      } else if (showIconPanel) {
        setShowIconPanel(false);
      } else if (confirmingDelete) {
        setConfirmingDelete(false);
      } else {
        onClose();
      }
      return true;
    }, BACK_PRIORITY.overlay);
  }, [
    confirmingDelete,
    isMindMapActive,
    isOpen,
    onClose,
    showHrefPanel,
    showIconPanel,
  ]);

  const isAssociationMenu = !!associationId && !nodeId;
  const association = associationId
    ? document.associations?.find((a) => a.id === associationId) ?? null
    : null;

  const node = nodeId ? findNodeById(document.root, nodeId) : null;
  const isRoot = nodeId === document.root.id;
  const hasChildren = node ? node.children.length > 0 : false;
  const isCollapsed = node?.collapsed ?? false;

  // 多选右键保留整个选中集：当右键目标属于当前多选集合时，批量作用于整组选中节点
  const targetIds = useMemo(() => {
    if (!nodeId) return [] as string[];
    return selection.length > 1 && selection.includes(nodeId) ? selection : [nodeId];
  }, [nodeId, selection]);
  const isBatchSelection = targetIds.length > 1;
  const targetNodes = useMemo(
    () =>
      Array.from(new Set(targetIds))
        .map((id) => findNodeById(document.root, id))
        .filter((item): item is MindMapNode => Boolean(item)),
    [document.root, targetIds],
  );
  const deletableIds = useMemo(
    () => collectTopLevelNodeIds(document.root, targetIds, { excludeRoot: true }),
    [document.root, targetIds],
  );
  const deletableDescendantCount = useMemo(
    () =>
      deletableIds.reduce((sum, id) => {
        const target = findNodeById(document.root, id);
        return sum + (target ? countAllDescendants(target) : 0);
      }, 0),
    [document.root, deletableIds],
  );
  const allTargetFlashcards = targetNodes.length > 0 && targetNodes.every((item) => Boolean(item.isFlashcard));

  /**
   * 批量更新选中集（单次 undo 步）：首个实际变更节点记入独立历史快照（coalesceKey: null），
   * 其余跳过历史记录，避免 800ms 内连续点加粗+改色合并为一步 Undo。
   */
  const applyBatchUpdate = useCallback(
    (buildPatch: (target: MindMapNode) => UpdateNodeParams | null) => {
      let recordedHistory = false;
      for (const target of targetNodes) {
        const patch = buildPatch(target);
        if (!patch) continue;
        if (!recordedHistory) {
          updateNode(target.id, patch, { coalesceKey: null });
          recordedHistory = true;
        } else {
          updateNode(target.id, patch, { skipHistory: true });
        }
      }
    },
    [targetNodes, updateNode],
  );

  /**
   * 执行菜单动作。格式类操作（颜色/加粗/标题等）传 keepOpen 保持菜单打开，
   * 支持连续调整；动作类（删除/新建等）默认关闭。
   */
  const exec = useCallback((action: () => void, opts?: { keepOpen?: boolean }) => {
    action();
    if (!opts?.keepOpen) onClose();
  }, [onClose]);

  const handleQuoteToChat = useCallback(() => {
    if (!mindmapId || !nodeId || targetNodes.length === 0) return;
    const text = serializeNodesToOutlineText(targetNodes);
    void import('@/features/chat/context/selectionRef').then(({ selectionToChat }) =>
      selectionToChat({
        text,
        source: {
          kind: 'mindmap',
          sourceId: mindmapId,
          locator: `node:${nodeId}`,
          title: document.root.text || undefined,
        },
      }),
    );
  }, [mindmapId, nodeId, targetNodes, document.root.text]);

  const handleExportHandout = useCallback(() => {
    if (!mindmapId || targetNodes.length === 0 || exportingHandout) return;
    setExportingHandout(true);
    void exportMindMapSelectionToHandoutNote({
      nodes: targetNodes,
      mindmapId,
      mindmapTitle: document.root.text,
      defaultNoteSuffix: t('mn5.exportHandoutSuffix', { defaultValue: '讲义' }),
    })
      .then((outcome) => {
        showGlobalNotification(
          'success',
          t('mn5.exportHandoutSuccess', {
            defaultValue: '已导出讲义笔记「{{title}}」',
            title: outcome.noteTitle,
          }),
        );
      })
      .catch((err) => {
        showGlobalNotification(
          'error',
          t('mn5.exportHandoutFailed', {
            defaultValue: '导出讲义笔记失败：{{error}}',
            error: getErrorMessage(err),
          }),
        );
      })
      .finally(() => {
        setExportingHandout(false);
      });
  }, [mindmapId, targetNodes, exportingHandout, document.root.text, t]);

  const handleAiNodeAction = useCallback((action: MindMapAiNodeAction) => {
    if (!nodeId || !node) return;
    if (onAiNodeAction) {
      onAiNodeAction(action, nodeId);
      return;
    }
    const nodesForAi = targetNodes.length > 0 ? targetNodes : [node];
    const outlineText = serializeNodesToOutlineText(nodesForAi);
    const aiEvent = new CustomEvent('mindmap:ai-action', {
      cancelable: true,
      detail: {
        action,
        nodeId,
        nodeIds: targetIds,
        mindmapId,
        text: outlineText,
        mindmapTitle: document.root.text || undefined,
      },
    });
    const handledByEvent = !window.dispatchEvent(aiEvent);
    if (handledByEvent) return;

    const promptPrefix: Record<MindMapAiNodeAction, string> = {
      expand: t('contextMenu.aiExpandPrompt', { defaultValue: '请为以下思维导图知识点扩写子节点：' }),
      summarize: t('contextMenu.aiSummarizePrompt', { defaultValue: '请总结以下思维导图分支的核心要点：' }),
      cloze: t('contextMenu.aiClozePrompt', { defaultValue: '请为以下知识点智能生成背诵挖空建议：' }),
      ask: t('contextMenu.aiAskPrompt', { defaultValue: '请深入讲解以下知识点：' }),
    };
    void import('@/features/chat/context/selectionRef').then(({ selectionToChat }) =>
      selectionToChat({
        text: `${promptPrefix[action]}\n${outlineText}`,
        source: {
          kind: 'mindmap',
          sourceId: mindmapId ?? document.root.id,
          locator: `node:${nodeId}`,
          title: document.root.text || undefined,
        },
      }),
    );
  }, [nodeId, node, onAiNodeAction, targetNodes, targetIds, mindmapId, document.root.id, document.root.text, t]);

  const handleSaveHref = useCallback(() => {
    if (!nodeId) return;
    const result = normalizeSafeHref(hrefDraft);
    if (!result.ok) {
      showGlobalNotification(
        'warning',
        t('contextMenu.invalidHref', { defaultValue: '请输入有效的 http/https/mailto 链接' }),
      );
      return;
    }
    applyBatchUpdate(() => ({ href: result.href }));
    setShowHrefPanel(false);
  }, [nodeId, hrefDraft, applyBatchUpdate, t]);

  // 打开/切换目标时收起内联面板与删除确认
  useEffect(() => {
    setShowIconPanel(false);
    setShowHrefPanel(false);
    setConfirmingDelete(false);
  }, [isOpen, nodeId]);

  useEffect(() => {
    if (showHrefPanel) {
      setHrefDraft(node?.href ?? '');
      requestAnimationFrame(() => hrefInputRef.current?.focus());
    }
  }, [showHrefPanel, node?.href]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as HTMLElement)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isHrefComposingKeyEvent(e)) return;
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (showHrefPanel) {
        setShowHrefPanel(false);
      } else if (showIconPanel) {
        setShowIconPanel(false);
      } else if (confirmingDelete) {
        setConfirmingDelete(false);
      } else {
        onClose();
      }
    };
    // 菜单内部滚动（如 emoji 面板）不应触发关闭
    const handleScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      onClose();
    };

    window.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleEscape, true);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleEscape, true);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [confirmingDelete, isHrefComposingKeyEvent, isOpen, onClose, showHrefPanel, showIconPanel]);

  // 打开时把焦点移入菜单容器（方向键立即可用），关闭时归还原焦点
  useEffect(() => {
    if (!isOpen) return;
    const menuEl = menuRef.current;
    const prevActive = window.document.activeElement;
    const frame = requestAnimationFrame(() => menuEl?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(frame);
      const active = window.document.activeElement;
      // 只有焦点仍属于菜单（或已丢到 body）时才归还，避免抢走动作设置的编辑焦点
      const focusIsOurs = active === window.document.body || (menuEl?.contains(active) ?? false);
      if (focusIsOurs && prevActive instanceof HTMLElement && prevActive.isConnected) {
        prevActive.focus({ preventScroll: true });
      }
    };
  }, [isOpen]);

  // 越界钳位：渲染后同步测量，定位完成前保持不可见，避免第一帧闪跳
  useLayoutEffect(() => {
    if (!isOpen) return;
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = position.x;
    let y = position.y;
    if (x + rect.width > vw - 8) x = vw - rect.width - 8;
    if (y + rect.height > vh - 8) y = vh - rect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    setCoords(prev => (prev?.left === x && prev.top === y ? prev : { left: x, top: y }));
  }, [isOpen, position, showIconPanel, showHrefPanel, confirmingDelete]);

  /** 方向键 / Home / End 在菜单项间移动焦点（roving focus） */
  const handleMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    const activeTarget = e.target as HTMLElement | null;
    if (
      activeTarget &&
      (activeTarget.tagName === 'INPUT' || activeTarget.tagName === 'TEXTAREA')
    ) {
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const menu = menuRef.current;
    if (!menu) return;
    const items = Array.from(
      menu.querySelectorAll<HTMLElement>(`[${MENU_ITEM_ATTR}]:not(:disabled)`),
    );
    if (items.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const current = items.indexOf(window.document.activeElement as HTMLElement);
    let next: number;
    if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
    else if (e.key === 'ArrowUp') next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else next = items.length - 1;
    items[next]?.focus({ preventScroll: true });
  }, []);

  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: coords?.left ?? position.x,
    top: coords?.top ?? position.y,
    zIndex: Z_INDEX.contextMenu,
    visibility: coords ? 'visible' : 'hidden',
  };

  if (!presence.mounted) return null;
  const menuDataState = presence.exiting ? 'closed' : 'open';

  if (isAssociationMenu && association) {
    return createPortal(
      <CustomScrollArea
        ref={menuRef}
        role="menu"
        tabIndex={-1}
        aria-label={t('association.menuLabel', { defaultValue: '关联线菜单' })}
        className={MENU_SHELL_CLASS}
        data-testid="mm-context-menu"
        data-state={menuDataState}
        aria-hidden={presence.exiting || undefined}
        viewportClassName="max-h-[inherit] overscroll-contain p-[var(--menu-shell-padding)]"
        fullHeight={false}
        style={menuStyle}
        onKeyDown={handleMenuKeyDown}
      >
        <MenuItem
          icon={<Pencil className="w-4 h-4" />}
          label={t('association.editLabel', { defaultValue: '编辑标签' })}
          shortcut="Enter"
          onClick={() => exec(() => onEditAssociationLabel?.(association.id))}
        />
        <MenuSeparator />
        <MenuItem
          icon={<Trash className="w-4 h-4" />}
          label={t('association.delete', { defaultValue: '删除关联线' })}
          shortcut="Del"
          destructive
          onClick={() => exec(() => onDeleteAssociation?.(association.id))}
        />
      </CustomScrollArea>,
      window.document.body,
    );
  }

  // 画布空白处右键菜单：新建主题 / 粘贴 / 适应视图 / 全部展开折叠
  if (paneMenu && !nodeId && !associationId) {
    return createPortal(
      <CustomScrollArea
        ref={menuRef}
        role="menu"
        tabIndex={-1}
        aria-label={t('contextMenu.paneMenuLabel', { defaultValue: '画布菜单' })}
        className={MENU_SHELL_CLASS}
        data-testid="mm-context-menu"
        data-state={menuDataState}
        aria-hidden={presence.exiting || undefined}
        viewportClassName="max-h-[inherit] overscroll-contain p-[var(--menu-shell-padding)]"
        fullHeight={false}
        style={menuStyle}
        onKeyDown={handleMenuKeyDown}
      >
        <MenuItem
          icon={<Plus className="w-4 h-4" />}
          label={t('contextMenu.addTopic', { defaultValue: '新建主题' })}
          onClick={() => exec(() => {
            const newId = addNode(document.root.id);
            if (newId) {
              setFocusedNodeId(newId);
              requestAnimationFrame(() => setEditingNodeId(newId));
            }
          })}
        />
        <MenuItem
          icon={<ClipboardText className="w-4 h-4" />}
          label={t('contextMenu.paste', { defaultValue: '粘贴' })}
          shortcut="⌘V"
          onClick={() => exec(() => {
            void pasteNodesWithSystemClipboard(storeApi, document.root.id, t);
          })}
        />
        <MenuSeparator />
        <MenuItem
          icon={<CornersOut className="w-4 h-4" />}
          label={t('contextMenu.fitView', { defaultValue: '适应视图' })}
          shortcut="⌘0"
          onClick={() => exec(() => onFitView?.())}
        />
        {onExitFocusMode && (
          <MenuItem
            icon={<MagnifyingGlassPlus className="w-4 h-4" />}
            label={t('contextMenu.exitFocusMode', { defaultValue: '退出专注模式' })}
            onClick={() => exec(() => onExitFocusMode())}
          />
        )}
        <MenuSeparator />
        <MenuItem
          icon={<CaretDown className="w-4 h-4" />}
          label={t('toolbar.expandAll', { defaultValue: '展开全部' })}
          onClick={() => exec(() => expandAll())}
        />
        <MenuItem
          icon={<CaretRight className="w-4 h-4" />}
          label={t('toolbar.collapseAll', { defaultValue: '折叠全部' })}
          onClick={() => exec(() => collapseAll())}
        />
      </CustomScrollArea>,
      window.document.body,
    );
  }

  if (!nodeId || !node) return null;

  /** 格式类快捷按钮（加粗/标题等）：保持菜单打开，可连续操作 */
  const formatBtnClass = (activeState: boolean) => cn(
    'w-7 h-7 [@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:!h-11 flex items-center justify-center rounded-[var(--menu-shell-row-radius)]',
    'hover:bg-[var(--menu-shell-row-hover)] focus-visible:outline-none focus-visible:bg-[var(--menu-shell-row-hover)]',
    activeState && 'bg-[var(--menu-shell-row-active)] text-primary',
  );

  return createPortal(
    <CustomScrollArea
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      aria-label={t('contextMenu.nodeMenuLabel', { defaultValue: '节点菜单' })}
      className={MENU_SHELL_CLASS}
      data-testid="mm-context-menu"
      data-state={menuDataState}
      aria-hidden={presence.exiting || undefined}
      viewportClassName="max-h-[inherit] overscroll-contain p-[var(--menu-shell-padding)]"
      fullHeight={false}
      style={menuStyle}
      onKeyDown={handleMenuKeyDown}
    >
      <MenuItem
        icon={<Plus className="w-4 h-4" />}
        label={t('actions.addChild')}
        shortcut="Tab"
        onClick={() => exec(() => {
          const newId = addNode(nodeId);
          if (newId) {
            setFocusedNodeId(newId);
            requestAnimationFrame(() => setEditingNodeId(newId));
          }
        })}
      />
      {!isRoot && (
        <MenuItem
          icon={<Plus className="w-4 h-4" />}
          label={t('contextMenu.addSibling')}
          shortcut="Enter"
          onClick={() => exec(() => {
            const parent = findParentNode(document.root, nodeId);
            if (parent) {
              const idx = parent.children.findIndex(c => c.id === nodeId);
              const newId = addNode(parent.id, idx + 1);
              if (newId) {
                setFocusedNodeId(newId);
                requestAnimationFrame(() => setEditingNodeId(newId));
              }
            }
          })}
        />
      )}
      <MenuItem
        icon={<Note className="w-4 h-4" />}
        label={node.note ? t('contextMenu.editNote') : t('contextMenu.addNote')}
        shortcut="⇧Enter"
        onClick={() => exec(() => {
          // 先关菜单再进备注编辑，避免菜单关闭后的焦点回落抢到正文 textarea
          const id = nodeId;
          if (!id) return;
          setFocusedNodeId(id);
          requestAnimationFrame(() => {
            setEditingNoteNodeId(id);
          });
        })}
      />

      <MenuItem
        icon={<Link className="w-4 h-4" />}
        label={t('contextMenu.linkResource')}
        onClick={() => exec(() => {
          if (nodeId) onOpenResourcePicker?.(nodeId);
        })}
      />

      <MenuItem
        icon={<LineSegment className="w-4 h-4" />}
        label={t('association.add', { defaultValue: '添加关联线' })}
        shortcut="⌘L"
        onClick={() => exec(() => {
          if (nodeId) onStartAssociation?.(nodeId);
        })}
      />

      {!isRoot && (
        <MenuItem
          icon={<MagnifyingGlassPlus className="w-4 h-4" />}
          label={t('outline.enterFocusMode')}
          onClick={() => exec(() => {
            if (nodeId) onFocusBranch?.(nodeId);
          })}
        />
      )}

      <MenuSeparator />

      {/* 画布原生一键 AI 助手分区 */}
      {!reciteMode && (
        <>
          <div className="flex items-center gap-2 px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground select-none">
            <span>{t('contextMenu.aiAssistant', { defaultValue: 'AI 助手' })}</span>
          </div>
          <MenuItem
            icon={<TreeStructure className="w-4 h-4" />}
            label={t('contextMenu.aiExpand', { defaultValue: 'AI 扩写子节点' })}
            onClick={() => exec(() => handleAiNodeAction('expand'))}
          />
          <MenuItem
            icon={<ListBullets className="w-4 h-4" />}
            label={t('contextMenu.aiSummarize', { defaultValue: 'AI 总结当前分支' })}
            onClick={() => exec(() => handleAiNodeAction('summarize'))}
          />
          <MenuItem
            icon={<MagicWand className="w-4 h-4" />}
            label={t('contextMenu.aiCloze', { defaultValue: 'AI 智能生成挖空' })}
            onClick={() => exec(() => handleAiNodeAction('cloze'))}
          />
          <MenuItem
            icon={<ChatCircleDots className="w-4 h-4" />}
            label={t('contextMenu.aiAsk', { defaultValue: '追问当前知识点' })}
            onClick={() => exec(() => handleAiNodeAction('ask'))}
          />
          <MenuSeparator />
        </>
      )}

      <MenuItem
        icon={node.completed
          ? <Circle className="w-4 h-4" />
          : <CheckCircle className="w-4 h-4" />}
        label={node.completed ? t('contextMenu.unmarkComplete') : t('contextMenu.markComplete')}
        active={node.completed}
        onClick={() => exec(() => applyBatchUpdate(() => ({ completed: !node.completed })), { keepOpen: true })}
      />
      <MenuItem
        icon={<CheckSquare className="w-4 h-4" />}
        label={t('contextMenu.toggleCheckbox', { defaultValue: '显示待办勾选框' })}
        active={Boolean(node.style?.showCheckbox)}
        onClick={() => exec(() => {
          const nextShow = !node.style?.showCheckbox;
          applyBatchUpdate((target) => ({
            style: { ...target.style, showCheckbox: nextShow ? true : undefined },
          }));
        }, { keepOpen: true })}
      />
      {/* 添加图标：内联展开 emoji 面板（不再另开弹层） */}
      <MenuItem
        icon={node.style?.icon
          ? <span className="text-sm leading-none">{node.style.icon}</span>
          : <Smiley className="w-4 h-4" />}
        label={t('contextMenu.addIcon', { defaultValue: '添加图标' })}
        onClick={() => setShowIconPanel(v => !v)}
      />
      {showIconPanel && (
        <EmojiPicker
          value={node.style?.icon}
          onChange={(emoji) => exec(
            () => applyBatchUpdate((target) => ({ style: { ...target.style, icon: emoji } })),
            { keepOpen: true },
          )}
          onClose={() => setShowIconPanel(false)}
          className="!w-full !border-0 !bg-transparent !shadow-none !rounded-none px-1.5 pb-1"
        />
      )}
      {/* 添加/编辑超链接：内联输入框（不弹 Dialog，IME 安全） */}
      <MenuItem
        icon={<LinkSimple className="w-4 h-4" />}
        label={node.href
          ? t('contextMenu.editHref', { defaultValue: '编辑超链接' })
          : t('contextMenu.addHref', { defaultValue: '添加超链接' })}
        active={Boolean(node.href)}
        onClick={() => setShowHrefPanel(v => !v)}
      />
      {showHrefPanel && (
        <div
          className="flex flex-col gap-1.5 px-2 pb-1.5 pt-0.5"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            ref={hrefInputRef}
            type="url"
            value={hrefDraft}
            onChange={(e) => setHrefDraft(e.target.value)}
            onCompositionStart={onHrefCompositionStart}
            onCompositionEnd={onHrefCompositionEnd}
            onKeyDown={(e) => {
              if (isHrefComposingKeyEvent(e)) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                handleSaveHref();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setShowHrefPanel(false);
              }
            }}
            placeholder="https://..."
            aria-label={t('contextMenu.hrefInputLabel', { defaultValue: '超链接地址' })}
            className="h-7 [@media(pointer:coarse)]:min-h-[44px] w-full rounded-[var(--menu-shell-row-radius)] border border-[var(--menu-shell-border)] bg-[var(--mm-bg)] px-2 text-xs text-[var(--menu-shell-foreground)] outline-none focus:border-primary"
          />
          <div className="flex items-center justify-end gap-1">
            {node.href && (
              <DsButton
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs [@media(pointer:coarse)]:!min-h-[44px]"
                onClick={() => exec(() => {
                  applyBatchUpdate(() => ({ href: undefined }));
                  setHrefDraft('');
                  setShowHrefPanel(false);
                }, { keepOpen: true })}
              >
                {t('contextMenu.clearHref', { defaultValue: '清除' })}
              </DsButton>
            )}
            <DsButton
              variant="primary"
              size="sm"
              className="h-6 px-2.5 text-xs [@media(pointer:coarse)]:!min-h-[44px]"
              onClick={handleSaveHref}
            >
              {t('common.save', { defaultValue: '保存' })}
            </DsButton>
          </div>
        </div>
      )}

      {/* W08 快捷属性：优先级 P1–P6 / 清除 */}
      <div className="flex items-center gap-2 px-2 pt-1.5 pb-0.5 text-[13px] text-muted-foreground select-none">
        <Flag className="w-4 h-4 flex-shrink-0" />
        <span>{t('contextMenu.priority', { defaultValue: '优先级' })}</span>
      </div>
      <div
        className="flex flex-wrap items-center gap-1 px-2 py-1"
        role="group"
        aria-label={t('contextMenu.priority', { defaultValue: '优先级' })}
      >
        {PRIORITY_LEVELS.map((level) => {
          const active = node.priority === level;
          return (
            <DsButton
              key={level}
              variant="ghost"
              size="sm"
              {...{ [MENU_ITEM_ATTR]: '' }}
              className={cn(
                '!h-6 !min-w-[26px] !px-1 text-[11px] font-semibold rounded-[var(--menu-shell-row-radius)]',
                '[@media(pointer:coarse)]:!min-w-11 [@media(pointer:coarse)]:!min-h-11',
                active
                  ? 'bg-[var(--menu-shell-row-active)] text-primary'
                  : 'text-[var(--menu-shell-foreground)] hover:bg-[var(--menu-shell-row-hover)]',
              )}
              aria-pressed={active}
              aria-label={t('node.priorityBadge', { level, defaultValue: `优先级 ${level}` })}
              onClick={() => exec(
                () => applyBatchUpdate(() => ({ priority: active ? undefined : level })),
                { keepOpen: true },
              )}
            >
              P{level}
            </DsButton>
          );
        })}
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          {...{ [MENU_ITEM_ATTR]: '' }}
          className="!w-6 !h-6 !min-w-0 !p-0 rounded-[var(--menu-shell-row-radius)] [@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:!h-11 border border-[var(--menu-shell-border)] text-muted-foreground hover:bg-[var(--menu-shell-row-hover)]"
          aria-label={t('contextMenu.clearPriority', { defaultValue: '清除优先级' })}
          onClick={() => exec(() => applyBatchUpdate(() => ({ priority: undefined })), { keepOpen: true })}
        >
          <X className="w-2.5 h-2.5" />
        </DsButton>
      </div>

      {/* W08 快捷属性：完成进度 0%–100% / 清除 */}
      <div className="flex items-center gap-2 px-2 pt-1 pb-0.5 text-[13px] text-muted-foreground select-none">
        <ChartPieSlice className="w-4 h-4 flex-shrink-0" />
        <span>{t('contextMenu.progress', { defaultValue: '完成进度' })}</span>
      </div>
      <div
        className="flex flex-wrap items-center gap-1 px-2 py-1"
        role="group"
        aria-label={t('contextMenu.progress', { defaultValue: '完成进度' })}
      >
        {PROGRESS_PRESETS.map((percent) => {
          const active = node.progress === percent;
          return (
            <DsButton
              key={percent}
              variant="ghost"
              size="sm"
              {...{ [MENU_ITEM_ATTR]: '' }}
              className={cn(
                '!h-6 !min-w-[32px] !px-1 text-[11px] tabular-nums rounded-[var(--menu-shell-row-radius)]',
                '[@media(pointer:coarse)]:!min-w-11 [@media(pointer:coarse)]:!min-h-11',
                active
                  ? 'bg-[var(--menu-shell-row-active)] text-primary font-medium'
                  : 'text-[var(--menu-shell-foreground)] hover:bg-[var(--menu-shell-row-hover)]',
              )}
              aria-pressed={active}
              aria-label={t('node.progressLabel', { percent, defaultValue: `进度 ${percent}%` })}
              onClick={() => exec(
                () => applyBatchUpdate(() => ({ progress: active ? undefined : percent })),
                { keepOpen: true },
              )}
            >
              {percent}%
            </DsButton>
          );
        })}
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          {...{ [MENU_ITEM_ATTR]: '' }}
          className="!w-6 !h-6 !min-w-0 !p-0 rounded-[var(--menu-shell-row-radius)] [@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:!h-11 border border-[var(--menu-shell-border)] text-muted-foreground hover:bg-[var(--menu-shell-row-hover)]"
          aria-label={t('contextMenu.clearProgress', { defaultValue: '清除进度' })}
          onClick={() => exec(() => applyBatchUpdate(() => ({ progress: undefined })), { keepOpen: true })}
        >
          <X className="w-2.5 h-2.5" />
        </DsButton>
      </div>

      {/* B / I / U / S | H1 / H2 / H3 / T */}
      <div className="flex flex-wrap items-center gap-1 px-2 py-1" role="group" aria-label={t('contextMenu.textStyleGroup', { defaultValue: '文本样式' })}>
        {[
          { key: 'bold', icon: TextB, prop: 'fontWeight' as const, val: 'bold' as const, cur: node.style?.fontWeight },
          { key: 'italic', icon: TextItalic, prop: 'fontStyle' as const, val: 'italic' as const, cur: node.style?.fontStyle },
          { key: 'underline', icon: TextUnderline, prop: 'textDecoration' as const, val: 'underline' as const, cur: node.style?.textDecoration },
          { key: 'strikethrough', icon: TextStrikethrough, prop: 'textDecoration' as const, val: 'line-through' as const, cur: node.style?.textDecoration },
        ].map(({ key, icon: Icon, prop, val, cur }) => (
          <DsButton variant="ghost" key={key}
            {...{ [MENU_ITEM_ATTR]: '' }}
            className={formatBtnClass(cur === val)}
            onClick={() => exec(
              () => applyBatchUpdate((target) => ({
                style: { ...target.style, [prop]: cur === val ? undefined : val },
              })),
              { keepOpen: true },
            )}
            aria-pressed={cur === val}
            title={t(`contextMenu.${key}`)}
          ><Icon className="w-4 h-4" /></DsButton>
        ))}
        <div className="w-px h-4 bg-[var(--menu-shell-border)] mx-0.5" />
        {([['h1', TextHOne], ['h2', TextHTwo], ['h3', TextHThree]] as const).map(([level, Icon]) => (
          <DsButton variant="ghost" key={level}
            {...{ [MENU_ITEM_ATTR]: '' }}
            className={formatBtnClass(node.style?.headingLevel === level)}
            onClick={() => exec(
              () => applyBatchUpdate((target) => ({
                style: {
                  ...target.style,
                  headingLevel: node.style?.headingLevel === level ? undefined : level,
                },
              })),
              { keepOpen: true },
            )}
            aria-pressed={node.style?.headingLevel === level}
            title={t(`contextMenu.${level === 'h1' ? 'heading1' : level === 'h2' ? 'heading2' : 'heading3'}`)}
          ><Icon className="w-4 h-4" /></DsButton>
        ))}
        <DsButton variant="ghost"
          {...{ [MENU_ITEM_ATTR]: '' }}
          className={formatBtnClass(!node.style?.headingLevel)}
          onClick={() => exec(
            () => applyBatchUpdate((target) => ({ style: { ...target.style, headingLevel: undefined } })),
            { keepOpen: true },
          )}
          aria-pressed={!node.style?.headingLevel}
          title={t('contextMenu.normalText')}
        ><TextT className="w-4 h-4" /></DsButton>
      </div>
      <div className="flex items-center gap-2 px-2 pt-1.5 pb-0.5 text-[13px] text-muted-foreground select-none">
        <Palette className="w-4 h-4 flex-shrink-0" />
        <span>{t('contextMenu.textColor')}</span>
      </div>
      <ColorPalette
        colors={quickTextColors}
        activeColor={node.style?.textColor}
        onSelect={(color) => exec(
          () => applyBatchUpdate((target) => ({ style: { ...target.style, textColor: color } })),
          { keepOpen: true },
        )}
      />
      <div className="flex items-center gap-2 px-2 pt-1.5 pb-0.5 text-[13px] text-muted-foreground select-none">
        <Highlighter className="w-4 h-4 flex-shrink-0" />
        <span>{t('contextMenu.highlight')}</span>
      </div>
      <ColorPalette
        colors={quickBgColors}
        activeColor={node.style?.bgColor}
        onSelect={(color) => exec(
          () => applyBatchUpdate((target) => ({ style: { ...target.style, bgColor: color } })),
          { keepOpen: true },
        )}
      />

      {/* 背诵与闪卡投影 / 归纳总结 / 引用与讲义：学习闭环入口 */}
      <MenuSeparator />
      {!reciteMode && (
        <>
          <MenuItem
            icon={<Cards className="w-4 h-4" />}
            label={t(
              allTargetFlashcards ? 'mn5.unprojectFlashcard' : 'mn5.projectAsFlashcard',
              { defaultValue: allTargetFlashcards ? '取消闪卡' : '转为闪卡' },
            )}
            active={allTargetFlashcards}
            onClick={() => exec(() => {
              if (targetNodes.length > 1) {
                const nextEnabled = !allTargetFlashcards;
                applyBatchUpdate((target) => {
                  if ((target.isFlashcard === true) === nextEnabled) return null;
                  return { isFlashcard: nextEnabled ? true : undefined };
                });
              } else {
                toggleNodeFlashcard(nodeId);
              }
            })}
          />
          {resolveSiblingRangeForSummary(
            document.root,
            selection.includes(nodeId) ? selection : [...selection, nodeId],
          ) && (
            <MenuItem
              icon={<BracketsCurly className="w-4 h-4" />}
              label={t('mn5.addSummaryBrace', { defaultValue: '添加归纳总结' })}
              onClick={() => exec(() => {
                const ids = selection.includes(nodeId) ? selection : [...selection, nodeId];
                addSummaryBrace(ids);
              })}
            />
          )}
          <MenuItem
            icon={<EyeSlash className="w-4 h-4" />}
            label={t('recite.blankBranch', { defaultValue: '挖空整个分支' })}
            onClick={() => exec(() => {
              const count = blankBranchNodes(nodeId);
              if (count > 0) {
                showGlobalNotification('success', t('recite.blankBranchDone', { count }));
              }
            })}
          />
          {subtreeHasBlanks(node) && (
            <MenuItem
              icon={<Eye className="w-4 h-4" />}
              label={t('recite.clearBranchBlanks', { defaultValue: '清除分支挖空' })}
              onClick={() => exec(() => {
                const count = clearBranchBlanks(nodeId);
                if (count > 0) {
                  showGlobalNotification('success', t('recite.clearBranchBlanksDone', { count }));
                }
              })}
            />
          )}
        </>
      )}
      <MenuItem
        icon={<Quotes className="w-4 h-4" />}
        label={t('toolbar.quoteToChat', { defaultValue: '引用到 AI 对话' })}
        disabled={!mindmapId}
        onClick={() => exec(handleQuoteToChat)}
      />
      <MenuItem
        icon={<Article className="w-4 h-4" />}
        label={t('mn5.exportHandout', { defaultValue: '导出讲义笔记' })}
        disabled={!mindmapId || exportingHandout}
        onClick={() => exec(handleExportHandout)}
      />

      <MenuSeparator />

      <MenuItem
        icon={<Copy className="w-4 h-4" />}
        label={isBatchSelection ? `${t('contextMenu.copy')} (${targetIds.length})` : t('contextMenu.copy')}
        shortcut="⌘C"
        onClick={() => exec(() => copyNodesWithSystemClipboard(storeApi, targetIds, t))}
      />
      <MenuItem
        icon={<Scissors className="w-4 h-4" />}
        label={isBatchSelection ? `${t('contextMenu.cut')} (${deletableIds.length})` : t('contextMenu.cut')}
        shortcut="⌘X"
        disabled={deletableIds.length === 0}
        onClick={() => exec(() => cutNodesWithSystemClipboard(storeApi, targetIds, t))}
      />
      <MenuItem
        icon={<ClipboardText className="w-4 h-4" />}
        label={t('contextMenu.pasteAsChild')}
        shortcut="⌘V"
        onClick={() => exec(() => {
          void pasteNodesWithSystemClipboard(storeApi, nodeId, t);
        })}
      />

      <MenuSeparator />

      {hasChildren && (
        <MenuItem
          icon={isCollapsed
            ? <CaretRight className="w-4 h-4" />
            : <CaretDown className="w-4 h-4" />}
          label={isCollapsed ? t('actions.expand') : t('actions.collapse')}
          shortcut={isCollapsed ? '⌘]' : '⌘['}
          onClick={() => exec(() => toggleCollapse(nodeId))}
        />
      )}

      {deletableIds.length > 0 && (
        <>
          {hasChildren && <MenuSeparator />}
          {/* 危险项内联确认：带子树或多选批量删除先原位展开确认条（无 Dialog），
              单叶子节点仍一步删除。确认态自动聚焦取消（误触安全默认）。 */}
          <AnimatePresence mode="wait" initial={false}>
            {confirmingDelete && (deletableDescendantCount > 0 || deletableIds.length > 1) ? (
              <motion.div
                key="confirm-delete"
                initial={prefersReducedMotion ? false : { opacity: 0, x: 6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={prefersReducedMotion ? undefined : { opacity: 0, x: 6 }}
                transition={prefersReducedMotion ? transitionInstant : tweenFast}
                className="flex items-center gap-1.5 px-2.5 py-1.5"
              >
                <span className="flex-1 text-xs text-destructive" role="alert">
                  {deletableIds.length > 1
                    ? t('canvasV2.deleteSelectedNodesQuestion', {
                        defaultValue: '确定删除选中的 {{count}} 个节点？',
                        count: deletableIds.length,
                      })
                    : t('canvasV2.deleteWithChildrenQuestion', {
                        defaultValue: '同时删除 {{count}} 个子主题？',
                        count: deletableDescendantCount,
                      })}
                </span>
                <DsButton
                  variant="danger"
                  size="sm"
                  className="[@media(pointer:coarse)]:!min-h-11"
                  {...{ [MENU_ITEM_ATTR]: '' }}
                  onClick={() => exec(() => {
                    if (deletableIds.length > 1) {
                      deleteNodes(deletableIds);
                    } else {
                      deleteNode(deletableIds[0]);
                    }
                  })}
                >
                  {t('canvasV2.confirmDelete', { defaultValue: '删除' })}
                </DsButton>
                <DsButton
                  variant="utility"
                  size="sm"
                  className="[@media(pointer:coarse)]:!min-h-11"
                  autoFocus
                  {...{ [MENU_ITEM_ATTR]: '' }}
                  onClick={() => setConfirmingDelete(false)}
                >
                  {t('canvasV2.cancel', { defaultValue: '取消' })}
                </DsButton>
              </motion.div>
            ) : (
              <motion.div
                key="delete-item"
                initial={prefersReducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={prefersReducedMotion ? undefined : { opacity: 0 }}
                transition={prefersReducedMotion ? transitionInstant : tweenFast}
              >
                <MenuItem
                  icon={<Trash className="w-4 h-4" />}
                  label={deletableIds.length > 1 ? `${t('actions.delete')} (${deletableIds.length})` : t('actions.delete')}
                  shortcut="Del"
                  destructive
                  onClick={() => {
                    if (deletableDescendantCount > 0 || deletableIds.length > 1) {
                      setConfirmingDelete(true);
                    } else {
                      exec(() => deleteNode(deletableIds[0]));
                    }
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </CustomScrollArea>,
    window.document.body
  );
};
