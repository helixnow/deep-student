import { useRefreshOnReturn } from '@/hooks/useRefreshOnReturn';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowClockwise,
  ClockCounterClockwise,
  ClipboardText,
  DotsThree,
  GearSix,
  MagnifyingGlass,
  PenNib,
  PencilSimple,
  Plus,
  Rows,
  Translate,
  Trash,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { SidebarFrameIcon, SidebarFrameWithLeftRailIcon } from '@/app/shell/DesktopShellIcons';
import { DsButton } from '@/components/ui/DsButton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';
import { Input } from '@/components/ui/shad/Input';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import {
  AppMenu,
  AppMenuContent,
  AppMenuGroup,
  AppMenuItem,
  AppMenuSeparator,
  AppMenuTrigger,
} from '@/components/ui/app-menu';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Z_INDEX } from '@/config/zIndex';
import { createEmpty, dstu, type DstuNode } from '@/dstu';
import { localizeEssayTitle } from '@/essay-grading/modeI18n';
import UnifiedAppPanel from '@/features/learning-hub/apps/UnifiedAppPanel';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { cn } from '@/lib/utils';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import { isContentDirty } from './contentDirtyRegistry';
import { useReviewPlanStore } from '@/stores/reviewPlanStore';
import {
  clearResourceWorkspaceActive,
  registerResourceWorkspace,
  setResourceWorkspaceActive,
  WORKBENCH_HYDRATE_RECENT_RESOURCE_EVENT,
  type ResourceWorkspaceType,
  type WorkbenchHydrateRecentResourceDetail,
} from './resourceWorkspaceRegistry';
import './ResourceAppWorkspace.css';
import { WorkbenchSidebarSurface, WorkbenchSidebarRow, WorkbenchSidebarRowLabel } from '../../components/sidebar';
import { WorkbenchSidebarLayout } from '../system/SystemWindowShared';
import { classifyWbSysWidth, type WbSysSizeClass } from '../system/useWbSysSize';

export { WORKBENCH_HYDRATE_RECENT_RESOURCE_EVENT, type WorkbenchHydrateRecentResourceDetail };

type LibraryView = 'all' | 'recent';

type SidebarPreference = 'open' | 'collapsed';

/** 窗口窄于该宽度时，打开资源后默认收起资源列表（880 宽的默认窗口并排侧栏后主区只剩 606px） */
const SIDEBAR_AUTO_COLLAPSE_WIDTH = 1100;

const sidebarPreferenceKey = (type: ResourceWorkspaceType) => `wb.resourceWorkspace.${type}.sidebar`;

function readSidebarPreference(type: ResourceWorkspaceType): SidebarPreference | null {
  try {
    const value = window.localStorage.getItem(sidebarPreferenceKey(type));
    return value === 'open' || value === 'collapsed' ? value : null;
  } catch {
    return null;
  }
}

function writeSidebarPreference(type: ResourceWorkspaceType, value: SidebarPreference): void {
  try {
    window.localStorage.setItem(sidebarPreferenceKey(type), value);
  } catch {
    // 存储不可用时偏好只在本窗口生命周期内生效
  }
}

type PendingNavigation =
  | {
      kind: 'select';
      resourceId: string | null;
      confirmation: 'unsaved' | 'review';
      /** Latest list response held until a dirty resource is safely unmounted. */
      itemsAfter?: DstuNode[];
    }
  | { kind: 'create'; confirmation: 'unsaved' | 'review' };

type PendingDelete = {
  item: DstuNode;
  leaveGuard: 'unsaved' | 'review' | null;
};

type OpenRowMenu = {
  id: string;
  mode: 'dropdown' | 'context';
};

const RESOURCE_NAME_MAX_LENGTH = 255;

function sanitizeResourceName(raw: string): string {
  let result = '';
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code === 10 || code === 13) result += ' ';
    else if (code >= 32 && code !== 127) result += ch;
  }
  return result.trim();
}

function escapeCssId(id: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(id)
    : id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

interface ResourceInlineEditTextProps {
  value: string;
  displayValue?: string;
  isEditing: boolean;
  onConfirm: (nextValue: string) => void;
  onCancel: () => void;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
}

/**
 * 行内标题编辑（与学习中心 InlineEditText 相同的 Enter / Escape / blur / IME 契约）：
 * - 进入编辑自动聚焦并全选（含 rAF + 60ms 兜底抵消菜单关闭抢焦点）
 * - <250ms 未修改的早期失焦自动回焦，避免右键/下拉菜单关闭瞬间误取消
 * - IME 组字态（compositionStart / isComposing / keyCode 229）不误提交或取消
 * - 阻止键盘/点击/右键冒泡，避免列表快捷键（Home/End/Arrow/F2/Delete）劫持编辑输入
 */
const ResourceInlineEditText: React.FC<ResourceInlineEditTextProps> = React.memo(function ResourceInlineEditText({
  value,
  displayValue,
  isEditing,
  onConfirm,
  onCancel,
  ariaLabel,
  placeholder,
  disabled = false,
  maxLength = RESOURCE_NAME_MAX_LENGTH,
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [editValue, setEditValue] = useState(value);
  const editValueRef = useRef(editValue);
  editValueRef.current = editValue;
  const valueRef = useRef(value);
  valueRef.current = value;
  const isComposingRef = useRef(false);
  const hasHandledRef = useRef(false);
  const editStartedAtRef = useRef(0);
  const blurRafRef = useRef<number | null>(null);

  const cancelPendingBlur = useCallback(() => {
    if (blurRafRef.current !== null) {
      cancelAnimationFrame(blurRafRef.current);
      blurRafRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    hasHandledRef.current = true;
    cancelPendingBlur();
  }, [cancelPendingBlur]);

  useEffect(() => {
    if (!isEditing) {
      cancelPendingBlur();
      setEditValue(value);
    }
  }, [cancelPendingBlur, isEditing, value]);

  useEffect(() => {
    if (!isEditing) return;
    cancelPendingBlur();
    hasHandledRef.current = false;
    editStartedAtRef.current = Date.now();
    setEditValue(valueRef.current);
  }, [cancelPendingBlur, isEditing]);

  useEffect(() => {
    if (!isEditing) return;
    const focusAndSelect = () => {
      const el = inputRef.current;
      if (!el || hasHandledRef.current) return;
      el.focus({ preventScroll: true });
      el.select();
    };
    focusAndSelect();
    const rafId = requestAnimationFrame(focusAndSelect);
    const timerId = window.setTimeout(() => {
      if (document.activeElement !== inputRef.current) {
        focusAndSelect();
      }
    }, 60);
    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(timerId);
    };
  }, [isEditing]);

  const handleConfirm = useCallback(() => {
    if (hasHandledRef.current) return;
    cancelPendingBlur();
    hasHandledRef.current = true;
    const cleaned = sanitizeResourceName(editValueRef.current);
    if (cleaned && cleaned !== valueRef.current) {
      onConfirm(cleaned);
    } else {
      onCancel();
    }
  }, [cancelPendingBlur, onCancel, onConfirm]);

  const handleCancel = useCallback(() => {
    if (hasHandledRef.current) return;
    cancelPendingBlur();
    hasHandledRef.current = true;
    setEditValue(valueRef.current);
    onCancel();
  }, [cancelPendingBlur, onCancel]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (isComposingRef.current || isComposingKeyEvent(event.nativeEvent)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      handleConfirm();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      handleCancel();
    }
  }, [handleCancel, handleConfirm]);

  const handleBlur = useCallback(() => {
    cancelPendingBlur();
    blurRafRef.current = requestAnimationFrame(() => {
      blurRafRef.current = null;
      if (hasHandledRef.current) return;
      const elapsed = Date.now() - editStartedAtRef.current;
      if (elapsed < 250 && editValueRef.current === valueRef.current) {
        inputRef.current?.focus({ preventScroll: true });
        return;
      }
      handleConfirm();
    });
  }, [cancelPendingBlur, handleConfirm]);

  if (!isEditing) {
    return <WorkbenchSidebarRowLabel>{displayValue ?? value}</WorkbenchSidebarRowLabel>;
  }

  return (
    <Input
      ref={inputRef}
      type="text"
      value={editValue}
      onChange={(event) => setEditValue(event.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onCompositionStart={() => {
        isComposingRef.current = true;
      }}
      onCompositionEnd={() => {
        isComposingRef.current = false;
      }}
      maxLength={maxLength}
      disabled={disabled}
      aria-label={ariaLabel}
      placeholder={placeholder}
      className="wb-resource-workspace-rename-input"
    />
  );
});

interface ResourceAppWorkspaceProps {
  type: ResourceWorkspaceType;
  /** 宿主窗口 id：资源列表开关 portal 进该窗口标题栏 */
  windowId?: string;
  initialResourceId?: string | null;
  isActive: boolean;
  onTitleChange: (title: string) => void;
}

export const ResourceAppWorkspace: React.FC<ResourceAppWorkspaceProps> = ({
  type,
  windowId,
  initialResourceId,
  isActive,
  onTitleChange,
}) => {
  const { t } = useTranslation('workbench');
  const [items, setItems] = useState<DstuNode[]>([]);
  const [query, setQuery] = useState('');
  const [libraryView, setLibraryView] = useState<LibraryView>('all');
  const [selectedId, setSelectedId] = useState<string | null>(initialResourceId ?? null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sizeClass, setSizeClass] = useState<WbSysSizeClass>('wide');
  // 用户显式选择过「展开 / 收起」才有值；未选择时按窗口宽度自动决定
  const [sidebarPreference, setSidebarPreference] = useState<SidebarPreference | null>(
    () => readSidebarPreference(type),
  );
  const [roomy, setRoomy] = useState(true);
  // ⌘F 搜索时临时展开已收起的列表，不改写记住的偏好
  const [sidebarPeek, setSidebarPeek] = useState(false);
  const [titlebarTarget, setTitlebarTarget] = useState<HTMLElement | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<OpenRowMenu | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listViewportRef = useRef<HTMLDivElement | null>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const pendingHydrateRecentRef = useRef<{ resourceId?: string | null } | null>(null);
  const pendingConfirmedDeletionIdsRef = useRef<Set<string>>(new Set());
  const visibleItemsRef = useRef<DstuNode[]>([]);
  const prevEditingIdRef = useRef<string | null>(null);

  const isExam = type === 'exam';
  // 作文/翻译：设置由 OS 应用侧边栏进入，并替换主区成为完整内容页
  const hasSettingsEntry = type === 'essay' || type === 'translation';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const title = t(`workbench:apps.${type}`);
  const ResourceIcon = isExam ? ClipboardText : type === 'translation' ? Translate : PenNib;
  const newLabel = isExam
    ? t('workbench:resourceHome.newExam')
    : type === 'translation'
      ? t('workbench:resourceHome.newTranslation')
      : t('workbench:resourceHome.newEssay');

  useEffect(() => onTitleChange(title), [onTitleChange, title]);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await dstu.list('/', {
      typeFilter: type,
      sortBy: 'updatedAt',
      sortOrder: 'desc',
      limit: 500,
    });
    if (result.ok) {
      setEditingId((current) => (
        current && !result.value.some((item) => item.id === current) ? null : current
      ));
      const activeId = selectedIdRef.current;
      if (activeId && !result.value.some((item) => item.id === activeId)) {
        if (pendingConfirmedDeletionIdsRef.current.has(activeId)) {
          // User already confirmed deleting this active resource; keep the
          // delete flow in charge of fallback selection without re-prompting.
          setItems(result.value);
          setLoading(false);
          return;
        }
        const reviewSession = useReviewPlanStore.getState().session;
        const confirmation = (
          type === 'exam'
          && reviewSession.isActive
          && reviewSession.examId === activeId
          && reviewSession.currentIndex < reviewSession.queue.length
        )
          ? 'review'
          : isContentDirty(type, activeId)
            ? 'unsaved'
            : null;

        if (confirmation) {
          // Do not replace `items` yet: selectedItem would become null and
          // unmount the dirty editor before the user can decide what to do.
          setPendingNavigation((current) => (
            current?.kind === 'select' && current.resourceId === null
              ? { ...current, itemsAfter: result.value }
              : {
                  kind: 'select',
                  resourceId: null,
                  confirmation,
                  itemsAfter: result.value,
                }
          ));
        } else {
          setItems(result.value);
          selectedIdRef.current = null;
          setSelectedId(null);
        }
      } else {
        setItems(result.value);
        if (pendingHydrateRecentRef.current && !selectedIdRef.current && result.value.length > 0) {
          const requestedId = pendingHydrateRecentRef.current.resourceId;
          pendingHydrateRecentRef.current = null;
          const target =
            (requestedId ? result.value.find((item) => item.id === requestedId) : null) ??
            result.value[0];
          if (target) {
            selectedIdRef.current = target.id;
            setSelectedId(target.id);
          }
        }
      }
    } else {
      setError(result.error.toUserMessage());
    }
    setLoading(false);
  }, [type]);

  useEffect(() => {
    void loadItems();
    const unwatch = dstu.watch('*', () => void loadItems());
    return () => unwatch();
  }, [loadItems]);

  const setSettingsView = useCallback((open: boolean, resourceId = selectedIdRef.current) => {
    if (!hasSettingsEntry || !resourceId) return;
    setSettingsOpen(open);
    window.dispatchEvent(new CustomEvent(`${type}:openSettings`, {
      detail: { targetResourceId: resourceId, open },
    }));
    if (open && sizeClass === 'compact') setSidebarOpen(false);
  }, [hasSettingsEntry, sizeClass, type]);

  const commitResourceSelection = useCallback((resourceId: string | null) => {
    selectedIdRef.current = resourceId;
    setSelectedId(resourceId);
    setSettingsOpen(false);
    setSidebarPeek(false);
    if (resourceId && sizeClass === 'compact') setSidebarOpen(false);
  }, [sizeClass]);

  const getLeaveConfirmation = useCallback((): 'unsaved' | 'review' | null => {
    const resourceId = selectedIdRef.current;
    if (!resourceId) return null;

    const reviewSession = useReviewPlanStore.getState().session;
    if (
      type === 'exam'
      && reviewSession.isActive
      && reviewSession.examId === resourceId
      && reviewSession.currentIndex < reviewSession.queue.length
    ) {
      return 'review';
    }
    if (isContentDirty(type, resourceId)) {
      return 'unsaved';
    }
    return null;
  }, [type]);

  const selectResource = useCallback((resourceId: string | null, itemsAfter?: DstuNode[]): boolean => {
    const current = selectedIdRef.current;
    if (resourceId === current) {
      if (settingsOpen) setSettingsView(false, current);
      return true;
    }
    const confirmation = getLeaveConfirmation();
    if (confirmation) {
      setPendingNavigation({ kind: 'select', resourceId, confirmation, itemsAfter });
      return false;
    }
    if (itemsAfter) setItems(itemsAfter);
    commitResourceSelection(resourceId);
    return true;
  }, [commitResourceSelection, getLeaveConfirmation, settingsOpen, setSettingsView]);

  useEffect(() => {
    if (initialResourceId && initialResourceId !== selectedIdRef.current) {
      selectResource(initialResourceId);
    }
  }, [initialResourceId, selectResource]);

  useRefreshOnReturn(loadItems, isActive);

  useEffect(() => {
    return registerResourceWorkspace(type, (resourceId) => {
      if (selectResource(resourceId)) void loadItems();
    });
  }, [loadItems, selectResource, type]);

  useEffect(() => {
    const onHydrateRecent = (evt: Event) => {
      const detail = (evt as CustomEvent<WorkbenchHydrateRecentResourceDetail>).detail;
      if (!detail || detail.type !== type || selectedIdRef.current) return;
      const target =
        (detail.resourceId ? items.find((item) => item.id === detail.resourceId) : null) ??
        items[0];
      if (target) {
        selectResource(target.id);
      } else {
        pendingHydrateRecentRef.current = { resourceId: detail.resourceId ?? null };
      }
    };
    window.addEventListener(WORKBENCH_HYDRATE_RECENT_RESOURCE_EVENT, onHydrateRecent);
    return () => window.removeEventListener(WORKBENCH_HYDRATE_RECENT_RESOURCE_EVENT, onHydrateRecent);
  }, [items, selectResource, type]);

  useEffect(() => {
    setResourceWorkspaceActive(type, selectedId);
    return () => clearResourceWorkspaceActive(type, selectedId);
  }, [selectedId, type]);

  // 侧边栏"设置"标签选中态：作文/翻译工作台在设置页开合时广播 settingsVisibility
  useEffect(() => {
    if (!hasSettingsEntry) return;
    const eventName = `${type}:settingsVisibility`;
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent<{ resourceId?: string; open?: boolean }>).detail;
      if (!detail?.resourceId || detail.resourceId !== selectedIdRef.current) return;
      setSettingsOpen(Boolean(detail.open));
    };
    window.addEventListener(eventName, handler);
    return () => window.removeEventListener(eventName, handler);
  }, [hasSettingsEntry, type]);

  const selectLibraryView = useCallback((view: LibraryView) => {
    setLibraryView(view);
    if (settingsOpen) setSettingsView(false);
  }, [settingsOpen, setSettingsView]);

  const getDisplayName = useCallback((item: DstuNode): string => (
    (type === 'essay' && item.name ? localizeEssayTitle(item.name, t) : item.name)
    || t('resourceHome.untitled')
  ), [t, type]);

  const focusRowMainButton = useCallback((resourceId: string) => {
    const viewport = listViewportRef.current;
    if (!viewport) return;
    const escaped = escapeCssId(resourceId);
    const button = viewport.querySelector<HTMLButtonElement>(
      `[data-resource-id="${escaped}"] .wb-resource-workspace-row-main`,
    );
    button?.focus({ preventScroll: true });
    button?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  const createResourceNow = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    const result = await createEmpty({ type });
    setCreating(false);
    if (!result.ok) {
      setError(result.error.toUserMessage());
      return;
    }
    setItems((current) => [result.value, ...current.filter((item) => item.id !== result.value.id)]);
    commitResourceSelection(result.value.id);
    requestAnimationFrame(() => {
      const viewport = listViewportRef.current;
      if (!viewport) return;
      const escaped = escapeCssId(result.value.id);
      viewport
        .querySelector<HTMLElement>(`[data-resource-id="${escaped}"]`)
        ?.scrollIntoView?.({ block: 'nearest' });
    });
  }, [commitResourceSelection, creating, type]);

  const createResource = useCallback(() => {
    if (creating) return;
    const confirmation = getLeaveConfirmation();
    if (confirmation) {
      setPendingNavigation({ kind: 'create', confirmation });
      return;
    }
    void createResourceNow();
  }, [createResourceNow, creating, getLeaveConfirmation]);

  const confirmPendingNavigation = useCallback(() => {
    const action = pendingNavigation;
    setPendingNavigation(null);
    if (!action) return;
    if (action.confirmation === 'review') {
      useReviewPlanStore.getState().endSession();
      // Re-enter the normal navigation path after ending review. It may still
      // need to confirm an unsaved exam draft before the current view unmounts.
      if (action.kind === 'select') {
        selectResource(action.resourceId, action.itemsAfter);
        return;
      }
      createResource();
      return;
    }
    if (action.kind === 'select') {
      if (action.itemsAfter) setItems(action.itemsAfter);
      commitResourceSelection(action.resourceId);
      return;
    }
    void createResourceNow();
  }, [commitResourceSelection, createResource, createResourceNow, pendingNavigation, selectResource]);

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const recentThreshold = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return items.filter((item) => {
      if (libraryView === 'recent' && item.updatedAt < recentThreshold) return false;
      return !normalized || item.name.toLocaleLowerCase().includes(normalized);
    });
  }, [items, libraryView, query]);
  visibleItemsRef.current = visibleItems;

  const selectedItem = items.find((item) => item.id === selectedId) ?? null;
  const compact = sizeClass === 'compact';
  // 未打开资源时主区空态提示「从左侧选择」，列表必须可见
  const sidebarCollapsed = !compact
    && selectedItem !== null
    && !sidebarPeek
    && (sidebarPreference ? sidebarPreference === 'collapsed' : !roomy);
  const navigationVisible = compact ? sidebarOpen : !sidebarCollapsed;

  useEffect(() => {
    if (!navigationVisible) {
      setEditingId(null);
      setOpenMenu(null);
    }
  }, [navigationVisible]);

  useEffect(() => {
    const previousId = prevEditingIdRef.current;
    prevEditingIdRef.current = editingId;
    if (previousId && editingId === null) {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!active || active === document.body || active === document.documentElement) {
          focusRowMainButton(previousId);
        }
      });
    }
  }, [editingId, focusRowMainButton]);

  const beginRename = useCallback((item: DstuNode) => {
    if (deletingId || renamingId) return;
    setOpenMenu(null);
    setEditingId(item.id);
  }, [deletingId, renamingId]);

  const cancelRename = useCallback(() => {
    setEditingId(null);
  }, []);

  const commitRename = useCallback(async (item: DstuNode, rawNextName: string) => {
    const nextName = sanitizeResourceName(rawNextName);
    if (!nextName || nextName === item.name) {
      setEditingId(null);
      return;
    }
    setRenamingId(item.id);
    try {
      const path = item.path || `/${item.id}`;
      const result = await dstu.rename(path, nextName);
      if (!result.ok) {
        showGlobalNotification('error', result.error.toUserMessage());
        return;
      }
      const updatedNode = result.value;
      const updatedName = updatedNode?.name?.trim() || nextName;
      const updatedAt = updatedNode?.updatedAt ?? Date.now();
      setItems((current) => current.map((entry) => (
        entry.id === item.id
          ? { ...entry, ...(updatedNode ?? {}), name: updatedName, updatedAt }
          : entry
      )));
    } finally {
      setRenamingId(null);
      setEditingId(null);
    }
  }, []);

  const requestDelete = useCallback((item: DstuNode) => {
    if (deletingId) return;
    setOpenMenu(null);
    setEditingId(null);
    setDeleteError(null);
    const leaveGuard = item.id === selectedIdRef.current ? getLeaveConfirmation() : null;
    setPendingDelete({ item, leaveGuard });
  }, [deletingId, getLeaveConfirmation]);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || deletingId) return;
    const { item: target, leaveGuard } = pendingDelete;
    const isDeletingSelected = target.id === selectedIdRef.current;

    if (isDeletingSelected) {
      const liveGuard = getLeaveConfirmation();
      if (leaveGuard === null && liveGuard !== null) {
        setPendingDelete({ item: target, leaveGuard: liveGuard });
        return;
      }
      if (liveGuard === 'review') {
        useReviewPlanStore.getState().endSession();
        if (isContentDirty(type, target.id)) {
          setPendingDelete({ item: target, leaveGuard: 'unsaved' });
          return;
        }
      }
    }

    // Compute sibling fallback BEFORE dstu.delete so concurrent dstu.watch refreshes
    // cannot shift the deleted row's index before the delete promise resolves.
    let plannedFallbackId: string | null = null;
    if (isDeletingSelected) {
      const currentVisible = visibleItemsRef.current;
      const deletedIndex = currentVisible.findIndex((entry) => entry.id === target.id);
      const remainingVisible = currentVisible.filter((entry) => entry.id !== target.id);
      if (remainingVisible.length > 0) {
        const fallbackIndex = deletedIndex >= 0
          ? Math.min(deletedIndex, remainingVisible.length - 1)
          : 0;
        plannedFallbackId = remainingVisible[fallbackIndex].id;
      }
    }

    setDeleteError(null);
    setDeletingId(target.id);
    pendingConfirmedDeletionIdsRef.current.add(target.id);
    try {
      const path = target.path || `/${target.id}`;
      const result = await dstu.delete(path);
      if (!result.ok) {
        const message = result.error.toUserMessage();
        setDeleteError(message);
        showGlobalNotification('error', message);
        return;
      }

      if (selectedIdRef.current === target.id) {
        const latestVisible = visibleItemsRef.current.filter((entry) => entry.id !== target.id);
        const nextSelectedId = (
          plannedFallbackId && latestVisible.some((entry) => entry.id === plannedFallbackId)
            ? plannedFallbackId
            : latestVisible[0]?.id ?? null
        );
        selectedIdRef.current = nextSelectedId;
        setSelectedId(nextSelectedId);
        setSettingsOpen(false);
        setSidebarPeek(false);
      }

      setItems((current) => current.filter((entry) => entry.id !== target.id));
      setPendingDelete(null);
      setDeleteError(null);
      showGlobalNotification('success', t('resourceWorkspace.deletedToast', {
        name: getDisplayName(target),
      }));
    } finally {
      pendingConfirmedDeletionIdsRef.current.delete(target.id);
      setDeletingId(null);
    }
  }, [deletingId, getDisplayName, getLeaveConfirmation, pendingDelete, t, type]);

  const toggleNavigation = useCallback(() => {
    if (compact) {
      setSidebarOpen((open) => !open);
      return;
    }
    const next: SidebarPreference = sidebarCollapsed ? 'open' : 'collapsed';
    setSidebarPeek(false);
    setSidebarPreference(next);
    writeSidebarPreference(type, next);
  }, [compact, sidebarCollapsed, type]);

  const handleResourceTitle = useCallback((resourceTitle: string) => {
    if (!selectedIdRef.current) return;
    const resourceId = selectedIdRef.current;
    setItems((current) => current.map((item) => (
      item.id === resourceId && item.name !== resourceTitle
        ? { ...item, name: resourceTitle }
        : item
    )));
  }, []);

  const handleListKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (editingId !== null || visibleItems.length === 0) return;
    if (isComposingKeyEvent(event.nativeEvent)) return;
    const targetEl = event.target instanceof HTMLElement ? event.target : null;
    if (targetEl?.closest('input, textarea, [contenteditable="true"]')) return;

    const focusedRowId = targetEl?.closest<HTMLElement>('[data-resource-id]')?.dataset.resourceId ?? null;

    if (event.key === 'F2' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const targetItem = (focusedRowId
        ? visibleItems.find((entry) => entry.id === focusedRowId)
        : null) ?? visibleItems.find((entry) => entry.id === selectedIdRef.current) ?? null;
      if (targetItem) {
        event.preventDefault();
        event.stopPropagation();
        beginRename(targetItem);
      }
      return;
    }

    if (event.key === 'Delete' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const targetItem = (focusedRowId
        ? visibleItems.find((entry) => entry.id === focusedRowId)
        : null) ?? visibleItems.find((entry) => entry.id === selectedIdRef.current) ?? null;
      if (targetItem) {
        event.preventDefault();
        event.stopPropagation();
        requestDelete(targetItem);
      }
      return;
    }

    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = visibleItems.findIndex((item) => item.id === selectedIdRef.current);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? visibleItems.length - 1
        : currentIndex < 0
          ? (delta > 0 ? 0 : visibleItems.length - 1)
          : Math.min(Math.max(currentIndex + delta, 0), visibleItems.length - 1);
    const nextId = visibleItems[nextIndex].id;
    if (selectResource(nextId) && focusedRowId !== null) {
      requestAnimationFrame(() => focusRowMainButton(nextId));
    }
  }, [beginRename, editingId, focusRowMainButton, requestDelete, selectResource, visibleItems]);

  const handleRowDropdownOpenChange = useCallback((id: string, open: boolean) => {
    setOpenMenu((current) => {
      if (open) return { id, mode: 'dropdown' };
      return current?.id === id && current.mode === 'dropdown' ? null : current;
    });
  }, []);

  const handleRowContextOpenChange = useCallback((id: string, open: boolean) => {
    if (open && editingId === id) return;
    setOpenMenu((current) => {
      if (open) return { id, mode: 'context' };
      return current?.id === id && current.mode === 'context' ? null : current;
    });
  }, [editingId]);

  const renderRowMenuItems = useCallback((item: DstuNode) => (
    <AppMenuGroup>
      <AppMenuItem
        icon={<PencilSimple size={15} />}
        shortcut="F2"
        onClick={(event) => {
          event.stopPropagation();
          beginRename(item);
        }}
      >
        {t('resourceWorkspace.rename')}
      </AppMenuItem>
      <AppMenuSeparator />
      <AppMenuItem
        icon={<Trash size={15} />}
        destructive
        onClick={(event) => {
          event.stopPropagation();
          requestDelete(item);
        }}
      >
        {t('resourceWorkspace.delete')}
      </AppMenuItem>
    </AppMenuGroup>
  ), [beginRename, requestDelete, t]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // 首帧同步分级：ResizeObserver 首次回调是异步的，窄窗打开时会先按
    // wide 渲染并排侧栏再塌缩成抽屉（一帧闪变）。jsdom 下测量为 0，保持
    // wide 兜底不影响测试。
    const applyWidth = (width: number) => {
      setSizeClass(classifyWbSysWidth(width));
      setRoomy(width >= SIDEBAR_AUTO_COLLAPSE_WIDTH);
    };
    const initialWidth = host.getBoundingClientRect().width || host.clientWidth;
    if (initialWidth > 0) applyWidth(initialWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => applyWidth(entry.contentRect.width));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!windowId) return undefined;
    const escapedWindowId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(windowId) : windowId;
    const shell = document.querySelector<HTMLElement>(`[data-wb-window-id="${escapedWindowId}"]`);
    const queryRoot: ParentNode = shell ?? document;
    let observer: MutationObserver | null = null;
    const findTarget = (): boolean => {
      const target = Array.from(queryRoot.querySelectorAll<HTMLElement>('[data-wb-titlebar-slot]'))
        .find((element) => element.dataset.windowId === windowId) ?? null;
      if (!target) return false;
      setTitlebarTarget((current) => (current === target ? current : target));
      observer?.disconnect();
      observer = null;
      return true;
    };
    if (!findTarget()) {
      observer = new MutationObserver(() => {
        findTarget();
      });
      observer.observe(shell ?? document.body, { childList: true, subtree: true });
    }
    return () => observer?.disconnect();
  }, [windowId]);

  const handleShortcut = useCallback((rawEvent: Event) => {
    const event = rawEvent as KeyboardEvent;
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLocaleLowerCase();
    if (key === 'f') {
      event.preventDefault();
      setSidebarOpen(true);
      setSidebarPeek(true);
      window.setTimeout(() => searchInputRef.current?.focus(), 0);
    } else if (key === 'n') {
      event.preventDefault();
      createResource();
    }
  }, [createResource]);

  useEventRegistry(
    isActive ? [{ target: 'window', type: 'keydown', listener: handleShortcut }] : [],
    [handleShortcut, isActive],
  );

  return (
    <div
      ref={hostRef}
      className="wb-resource-workspace"
      data-testid={`wb-${type}-workspace`}
      data-compact={compact ? 'true' : 'false'}
      data-sidebar-open={navigationVisible ? 'true' : 'false'}
    >
      <WorkbenchSidebarLayout
        sizeClass={sizeClass}
        navLabel={title}
        drawerOpen={sidebarOpen}
        onDrawerOpenChange={setSidebarOpen}
        sidebarCollapsed={sidebarCollapsed}
        hideDrawerHandle={Boolean(titlebarTarget)}
        sidebar={<WorkbenchSidebarSurface ariaLabel={title} className="wb-resource-workspace-sidebar">
        {/* data-wb-drawer-stay：搜索/新建/过滤的结果就显示在抽屉列表里，
            紧凑窗抽屉不因这些操作自动收起（见 WorkbenchSidebarLayout）；
            窗口标题栏已承载应用标题，侧栏顶部不再重复渲染应用名。 */}
        <div className="wb-resource-workspace-sidebar-top" data-wb-drawer-stay>
          <div className="wb-resource-workspace-search">
            <MagnifyingGlass size={14} aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) {
                  event.preventDefault();
                  setQuery('');
                }
              }}
              placeholder={t('workbench:resourceHome.search')}
              aria-label={t('workbench:resourceHome.search')}
            />
            {query && (
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                onClick={() => {
                  setQuery('');
                  searchInputRef.current?.focus();
                }}
                title={t('workbench:resourceWorkspace.clearSearch')}
                aria-label={t('workbench:resourceWorkspace.clearSearch')}
              >
                <X size={12} />
              </DsButton>
            )}
          </div>
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            className="wb-resource-workspace-create-btn"
            onClick={createResource}
            disabled={creating}
            title={newLabel}
            aria-label={newLabel}
          >
            {creating ? <ArrowClockwise size={14} className="animate-spin" /> : <Plus size={14} />}
          </DsButton>
        </div>

        <nav className="wb-resource-workspace-nav" aria-label={title} data-wb-drawer-stay>
          <WorkbenchSidebarRow
            isActive={!settingsOpen && libraryView === 'all'}
            onClick={() => selectLibraryView('all')}
            leftSlot={<Rows size={14} />}
            rightSlot={<small className="font-mono tabular-nums">{items.length}</small>}
          >
            <WorkbenchSidebarRowLabel>{t('workbench:resourceHome.all')}</WorkbenchSidebarRowLabel>
          </WorkbenchSidebarRow>
          <WorkbenchSidebarRow
            isActive={!settingsOpen && libraryView === 'recent'}
            onClick={() => selectLibraryView('recent')}
            leftSlot={<ClockCounterClockwise size={14} />}
          >
            <WorkbenchSidebarRowLabel>{t('workbench:resourceHome.recent')}</WorkbenchSidebarRowLabel>
          </WorkbenchSidebarRow>
        </nav>

        <CustomScrollArea
          className="wb-resource-workspace-list-scroll"
          viewportRef={listViewportRef}
          viewportClassName="wb-resource-workspace-list"
          viewportProps={{
            role: 'listbox',
            tabIndex: 0,
            'aria-label': title,
            'aria-busy': loading,
            onKeyDown: handleListKeyDown,
          }}
          trackOffsetTop={5}
          trackOffsetBottom={8}
          trackOffsetRight={1}
        >
          {loading && items.length === 0 ? (
            <div className="wb-resource-workspace-loading" role="status">
              {[0, 1, 2, 3, 4].map((index) => <i key={index} />)}
            </div>
          ) : error ? (
            <div className="wb-resource-workspace-message" role="alert">
              <WarningCircle size={22} />
              <span>{error}</span>
              <DsButton
                variant="outline"
                size="sm"
                onClick={() => void loadItems()}
              >
                {t('resourceHome.retry')}
              </DsButton>
            </div>
          ) : visibleItems.length === 0 ? (
            <div className="wb-resource-workspace-message">
              <span>
                {query
                  ? t('workbench:resourceHome.noMatches')
                  : t('workbench:resourceHome.empty')}
              </span>
            </div>
          ) : visibleItems.map((item) => {
            const displayName = getDisplayName(item);
            const isSelectedRow = !settingsOpen && selectedId === item.id;
            const isEditing = editingId === item.id;
            const isMenuOpen = openMenu?.id === item.id;
            const isContextOpen = isMenuOpen && openMenu?.mode === 'context';
            const isDropdownOpen = isMenuOpen && openMenu?.mode === 'dropdown';
            const itemActionsLabel = t('resourceWorkspace.itemActions', { name: displayName });

            return (
              <AppMenu
                key={item.id}
                mode="context"
                className="wb-resource-workspace-row-context"
                open={isContextOpen}
                onOpenChange={(open) => handleRowContextOpenChange(item.id, open)}
              >
                <AppMenuTrigger asChild>
                  <div
                    role="option"
                    aria-selected={isSelectedRow}
                    data-workbench-sidebar-row="thread"
                    data-resource-id={item.id}
                    data-editing={isEditing ? 'true' : undefined}
                    data-menu-open={isMenuOpen ? 'true' : undefined}
                    className={cn(
                      'wb-resource-workspace-row',
                      'desktop-shell-sidebar-row desktop-shell-thread-row',
                      isSelectedRow && 'desktop-shell-thread-row--active',
                    )}
                  >
                    {isEditing ? (
                      <div
                        className="wb-resource-workspace-row-main wb-resource-workspace-row-edit"
                        data-wb-drawer-stay
                      >
                        <span className="wb-resource-workspace-row-icon" aria-hidden="true">
                          <ResourceIcon size={15} weight="duotone" />
                        </span>
                        <ResourceInlineEditText
                          value={item.name}
                          displayValue={displayName}
                          isEditing
                          disabled={renamingId === item.id}
                          onConfirm={(nextName) => {
                            void commitRename(item, nextName);
                          }}
                          onCancel={cancelRename}
                          ariaLabel={t('resourceWorkspace.renameInputAria', { name: displayName })}
                          placeholder={t('resourceHome.untitled')}
                        />
                      </div>
                    ) : (
                      <DsButton
                        variant="nav"
                        size="md"
                        className="wb-resource-workspace-row-main"
                        onClick={() => selectResource(item.id)}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          if (pendingNavigation || pendingDelete) return;
                          beginRename(item);
                        }}
                      >
                        <span className="wb-resource-workspace-row-icon" aria-hidden="true">
                          <ResourceIcon size={15} weight="duotone" />
                        </span>
                        <WorkbenchSidebarRowLabel>{displayName}</WorkbenchSidebarRowLabel>
                      </DsButton>
                    )}

                    {!isEditing && (
                      <div className="wb-resource-workspace-row-actions" data-wb-drawer-stay>
                        <AppMenu
                          open={isDropdownOpen}
                          onOpenChange={(open) => handleRowDropdownOpenChange(item.id, open)}
                        >
                          <AppMenuTrigger asChild>
                            <DsButton
                              variant="ghost"
                              size="icon"
                              iconOnly
                              className="wb-resource-workspace-row-menu-trigger"
                              aria-label={itemActionsLabel}
                              title={t('resourceWorkspace.moreActions')}
                              onClick={(event) => event.stopPropagation()}
                              onDoubleClick={(event) => event.stopPropagation()}
                            >
                              <DotsThree size={15} weight="bold" aria-hidden="true" />
                            </DsButton>
                          </AppMenuTrigger>
                          <AppMenuContent
                            align="end"
                            width={168}
                            style={{ zIndex: Z_INDEX.contextMenu }}
                            aria-label={itemActionsLabel}
                          >
                            {renderRowMenuItems(item)}
                          </AppMenuContent>
                        </AppMenu>
                      </div>
                    )}
                  </div>
                </AppMenuTrigger>
                <AppMenuContent
                  width={168}
                  style={{ zIndex: Z_INDEX.contextMenu }}
                  aria-label={itemActionsLabel}
                >
                  {renderRowMenuItems(item)}
                </AppMenuContent>
              </AppMenu>
            );
          })}
        </CustomScrollArea>

        {hasSettingsEntry && (
          <div className="wb-resource-workspace-settings" data-wb-drawer-stay>
            <WorkbenchSidebarRow
              isActive={settingsOpen}
              onClick={() => setSettingsView(true)}
              disabled={!selectedItem}
              title={selectedItem ? undefined : t('workbench:resourceHome.settingsNeedSelection')}
              leftSlot={<GearSix size={14} />}
            >
              <WorkbenchSidebarRowLabel>
                {type === 'translation'
                  ? t('workbench:resourceHome.translationSettings')
                  : t('workbench:resourceHome.essaySettings')}
              </WorkbenchSidebarRowLabel>
            </WorkbenchSidebarRow>
            {/* 禁用原因内联提示：native title 在触屏上不可见 */}
            {!selectedItem && (
              <span className="wb-resource-workspace-settings-hint">
                {t('workbench:resourceHome.settingsNeedSelection')}
              </span>
            )}
          </div>
        )}

        <footer className="wb-resource-workspace-sidebar-footer" data-wb-drawer-stay>
          <span className="font-mono tabular-nums">{t('workbench:resourceHome.itemCount', { count: visibleItems.length })}</span>
        </footer>
      </WorkbenchSidebarSurface>}
      >

      <main className="wb-resource-workspace-main">
        {selectedItem ? (
          <UnifiedAppPanel
            type={type}
            resourceId={selectedItem.id}
            dstuPath={`/${selectedItem.id}`}
            strictType
            isActive={isActive}
            onTitleChange={handleResourceTitle}
            onClose={() => selectResource(null)}
            className="h-full"
            externalSettingsNavigation={hasSettingsEntry}
            externalSettingsOpen={settingsOpen}
          />
        ) : (
          <div className="wb-resource-workspace-empty">
            <ResourceIcon size={38} weight="thin" />
            <strong>{t('workbench:resourceWorkspace.selectTitle')}</strong>
            <span>{t('workbench:resourceWorkspace.selectHint')}</span>
            <DsButton
              size="sm"
              onClick={createResource}
              disabled={creating}
            >
              <Plus size={15} />
              {newLabel}
            </DsButton>
          </div>
        )}
      </main>
      </WorkbenchSidebarLayout>
      <DsAlertDialog
        open={pendingNavigation !== null}
        onOpenChange={(open) => {
          if (!open) setPendingNavigation(null);
        }}
        icon={<WarningCircle size={20} className="text-warning" />}
        title={pendingNavigation?.confirmation === 'review'
          ? t('resourceWorkspace.reviewExitTitle')
          : t('content.unsavedTitle')}
        description={pendingNavigation?.confirmation === 'review'
          ? t('resourceWorkspace.reviewExitDescription')
          : t('content.confirmCloseUnsaved')}
        confirmText={pendingNavigation?.confirmation === 'review'
          ? t('resourceWorkspace.reviewExitConfirm')
          : t('resourceWorkspace.discard')}
        cancelText={t('resourceWorkspace.cancel')}
        confirmVariant="danger"
        onConfirm={confirmPendingNavigation}
      />
      <DsAlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deletingId) {
            setPendingDelete(null);
            setDeleteError(null);
          }
        }}
        icon={<WarningCircle size={20} className="text-destructive" />}
        title={pendingDelete?.leaveGuard === 'review'
          ? t('resourceWorkspace.deleteReviewTitle')
          : pendingDelete?.leaveGuard === 'unsaved'
            ? t('resourceWorkspace.deleteUnsavedTitle')
            : t('resourceWorkspace.deleteTitle')}
        description={pendingDelete
          ? (pendingDelete.leaveGuard === 'review'
            ? t('resourceWorkspace.deleteReviewDescription', { name: getDisplayName(pendingDelete.item) })
            : pendingDelete.leaveGuard === 'unsaved'
              ? t('resourceWorkspace.deleteUnsavedDescription', { name: getDisplayName(pendingDelete.item) })
              : t('resourceWorkspace.deleteDescription', { name: getDisplayName(pendingDelete.item) }))
          : undefined}
        confirmText={pendingDelete?.leaveGuard === 'review'
          ? t('resourceWorkspace.deleteReviewConfirm')
          : pendingDelete?.leaveGuard === 'unsaved'
            ? t('resourceWorkspace.deleteUnsavedConfirm')
            : t('resourceWorkspace.deleteConfirm')}
        cancelText={t('resourceWorkspace.cancel')}
        confirmVariant="danger"
        loading={deletingId !== null}
        onConfirm={() => {
          void confirmDelete();
        }}
      >
        {deleteError ? (
          <p className="wb-resource-workspace-delete-error" role="alert">
            {deleteError}
          </p>
        ) : null}
      </DsAlertDialog>
      {titlebarTarget && (compact || selectedItem) ? createPortal(
        <div className="wb-resource-workspace-titlebar-controls">
          <Tooltip>
            <TooltipTrigger asChild>
              <DsButton
                variant="ghost"
                size="icon"
                className="wb-resource-workspace-titlebar-toggle"
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={toggleNavigation}
                aria-label={t('common:navigation.toggle_sidebar', '切换边栏')}
                aria-expanded={navigationVisible}
                data-wb-resource-sidebar-toggle
              >
                {navigationVisible ? <SidebarFrameWithLeftRailIcon /> : <SidebarFrameIcon />}
              </DsButton>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('common:navigation.toggle_sidebar', '切换边栏')}</TooltipContent>
          </Tooltip>
        </div>,
        titlebarTarget,
      ) : null}
    </div>
  );
};

export default ResourceAppWorkspace;
