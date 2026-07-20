/**
 * 思维导图资源选择器弹层
 *
 * 允许用户从 VFS 中搜索/浏览资源并关联到思维导图节点。
 * 锚定到目标节点旁的 popover（非居中模态、无遮罩）：
 * 调用方可传 anchorEl / anchorRect 显式指定锚点；不传时组件内部
 * 通过 DOM 查询目标节点矩形自行锚定，找不到再退化为视口右上角。
 * 轻量级实现，使用 dstu_list / dstu_search API。
 */

import React, { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import {
  MagnifyingGlass,
  X,
  CircleNotch,
  Check,
  CaretLeft,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Input } from '@/components/ui/shad/Input';
import { Z_INDEX } from '@/config/zIndex';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { useMobileScreen } from '../../hooks/useCoarsePointer';
import { useMindMapIsActive } from '../../MindMapActiveContext';
import { getResourceIcon, type ResourceIconType } from '@/features/learning-hub/icons';
import * as dstuApi from '@/dstu/api';
import type { DstuNode } from '@/dstu/types';
import type { MindMapNodeRef } from '../../types';

// ============================================================================
// 类型
// ============================================================================

/** 锚点矩形（视口坐标）；兼容 DOMRect 的子集 */
export interface ResourcePickerAnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MindMapResourcePickerProps {
  isOpen: boolean;
  nodeId: string;
  existingRefs?: MindMapNodeRef[];
  onSelect: (ref: MindMapNodeRef) => void;
  onClose: () => void;
  /** 可选：显式锚点元素（优先级低于 anchorRect） */
  anchorEl?: HTMLElement | null;
  /** 可选：显式锚点矩形（视口坐标，最高优先级） */
  anchorRect?: ResourcePickerAnchorRect | null;
}

// ============================================================================
// 锚定定位
// ============================================================================

const PANEL_MARGIN = 8;
const ANCHOR_GAP = 12;

/** 解析锚点矩形：props 显式锚点 → DOM 查询目标节点 → null（退化） */
function resolveAnchorRect(
  nodeId: string,
  anchorEl?: HTMLElement | null,
  anchorRect?: ResourcePickerAnchorRect | null,
): ResourcePickerAnchorRect | null {
  if (anchorRect) return anchorRect;
  if (anchorEl?.isConnected) return anchorEl.getBoundingClientRect();
  if (!nodeId) return null;
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(nodeId) : nodeId;
  // 画布视图（React Flow 节点）与大纲视图（data-node-id 行）两种宿主
  const el =
    document.querySelector<HTMLElement>(`.react-flow__node[data-id="${escaped}"]`) ??
    document.querySelector<HTMLElement>(`[data-node-id="${escaped}"]`);
  if (el) {
    const rect = el.getBoundingClientRect();
    // 节点在视口外（如画布平移后）时视为不可用，走退化定位
    if (rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth) {
      return rect;
    }
  }
  return null;
}

/** 计算面板位置：优先节点右侧，放不下翻转到左侧，再钳位进视口 */
function computePanelPosition(
  anchor: ResourcePickerAnchorRect | null,
  panelWidth: number,
  panelHeight: number,
): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));

  if (!anchor) {
    // 无锚点退化：靠近视口右上（非居中）
    return {
      left: clamp(vw - panelWidth - 16, PANEL_MARGIN, vw - panelWidth - PANEL_MARGIN),
      top: clamp(72, PANEL_MARGIN, vh - panelHeight - PANEL_MARGIN),
    };
  }

  const anchorRight = anchor.left + anchor.width;
  let left: number;
  if (anchorRight + ANCHOR_GAP + panelWidth <= vw - PANEL_MARGIN) {
    left = anchorRight + ANCHOR_GAP; // 右侧
  } else if (anchor.left - ANCHOR_GAP - panelWidth >= PANEL_MARGIN) {
    left = anchor.left - ANCHOR_GAP - panelWidth; // 翻转到左侧
  } else {
    left = clamp(anchorRight + ANCHOR_GAP, PANEL_MARGIN, vw - panelWidth - PANEL_MARGIN);
  }

  const top = clamp(anchor.top, PANEL_MARGIN, vh - panelHeight - PANEL_MARGIN);
  return { left, top };
}

/** 面板内可聚焦元素（Tab 焦点循环用） */
function getFocusable(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter(el => el.offsetParent !== null || el === document.activeElement);
}

// ============================================================================
// 组件
// ============================================================================

export const MindMapResourcePicker: React.FC<MindMapResourcePickerProps> = ({
  isOpen,
  nodeId,
  existingRefs,
  onSelect,
  onClose,
  anchorEl,
  anchorRect,
}) => {
  const { t } = useTranslation(['mindmap', 'common']);
  // 移动端窄屏：改为画布内全屏内联列表子屏（非 Portal 居中卡片）
  const isMobile = useMobileScreen();
  const isMindMapActive = useMindMapIsActive();
  const [query, setQuery] = useState('');
  const [resources, setResources] = useState<DstuNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // 始终持有最新 onClose，事件监听不再依赖父组件的 useCallback 稳定性
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const existingIds = useMemo(() => new Set(existingRefs?.map(r => r.sourceId) ?? []), [existingRefs]);

  // 加载根目录资源
  const loadRootResources = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await dstuApi.list('/', { recursive: true });
      if (result.ok) {
        // 过滤掉文件夹，只保留资源
        setResources(result.value.filter(n => n.type !== 'folder'));
      } else {
        setError(result.error.message);
      }
    } catch {
      setError(t('refs.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // 搜索资源
  const searchResources = useCallback(async (q: string) => {
    if (!q.trim()) {
      loadRootResources();
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await dstuApi.search(q.trim());
      if (result.ok) {
        setResources(result.value.filter(n => n.type !== 'folder'));
      } else {
        setError(result.error.message);
      }
    } catch {
      setError(t('refs.searchFailed'));
    } finally {
      setLoading(false);
    }
  }, [loadRootResources, t]);

  // 打开时加载资源 + 聚焦搜索框
  useEffect(() => {
    if (isOpen) {
      loadRootResources();
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery('');
      setResources([]);
    }
  }, [isOpen, loadRootResources]);

  // 搜索防抖（仅在用户实际输入时触发，避免与初始加载重复）
  useEffect(() => {
    if (!isOpen || !query) return;
    const timer = setTimeout(() => {
      searchResources(query);
    }, 300);
    return () => clearTimeout(timer);
  }, [query, isOpen, searchResources]);

  // 自定义 picker（移动子屏/桌面浮层）都需显式接入 Android 返回键。
  // 标签页保活时仅允许当前可见导图注册，避免隐藏实例拦截返回。
  useEffect(() => {
    if (!isOpen || !isMindMapActive) return;
    return registerBackHandler(() => {
      onCloseRef.current();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isMindMapActive, isOpen]);

  // 锚定定位：打开时解析锚点并钳位，窗口尺寸变化时重算（移动端全屏子屏不需要）
  useLayoutEffect(() => {
    if (!isOpen || isMobile) {
      setPosition(null);
      return;
    }
    const reposition = () => {
      const panel = panelRef.current;
      const width = panel?.offsetWidth || 360;
      const height = panel?.offsetHeight || 420;
      const anchor = resolveAnchorRect(nodeId, anchorEl, anchorRect);
      const next = computePanelPosition(anchor, width, height);
      setPosition(prev => (prev?.left === next.left && prev.top === next.top ? prev : next));
    };
    reposition();
    window.addEventListener('resize', reposition);
    return () => window.removeEventListener('resize', reposition);
  }, [isOpen, isMobile, nodeId, anchorEl, anchorRect, loading, resources.length]);

  // 点击外部关闭 + Esc 关闭 + Tab 焦点循环
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as HTMLElement)) {
        onCloseRef.current();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        // Tab 焦点循环钉在面板内（无遮罩，避免焦点漂移到底层画布）
        const focusable = getFocusable(panelRef.current);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (!active || !panelRef.current.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        }
      }
    };
    // 延迟绑定，避免触发菜单关闭的同一事件立即关闭 picker
    const timer = setTimeout(() => {
      window.addEventListener('mousedown', handleClick);
      window.addEventListener('keydown', handleKeyDown);
    }, 50);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousedown', handleClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleSelect = useCallback((node: DstuNode) => {
    const ref: MindMapNodeRef = {
      sourceId: node.sourceId || node.id,
      type: node.type,
      name: node.name,
      resourceHash: node.resourceHash,
    };
    onSelect(ref);
  }, [onSelect]);

  if (!isOpen) return null;

  const searchBox = (
    <div className="px-3 py-2 border-b border-border">
      <div className="mindmap-picker-search relative">
        <MagnifyingGlass className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('refs.searchPlaceholder')}
          className={cn(
            'w-full pl-7 pr-2 py-1.5 text-sm rounded-md',
            'bg-muted/50 border border-border/50',
            'focus:outline-none focus:ring-1 focus:ring-primary/50',
            'placeholder:text-muted-foreground/60',
          )}
        />
      </div>
    </div>
  );

  const listBody = loading ? (
    <div className="flex items-center justify-center py-8 text-muted-foreground">
      <CircleNotch className="w-5 h-5 animate-spin motion-reduce:animate-none mr-2" />
      <span className="text-sm">{t('refs.loading')}</span>
    </div>
  ) : error ? (
    <div className="text-center py-8 text-sm text-destructive">{error}</div>
  ) : resources.length === 0 ? (
    <div className="text-center py-8 text-sm text-muted-foreground">
      {query ? t('refs.noResults') : t('refs.empty')}
    </div>
  ) : (
    resources.map((node) => {
      const IconComp = getResourceIcon(node.type as ResourceIconType);
      const isAdded = existingIds.has(node.sourceId || node.id);

      return (
        <DsButton
          key={node.id}
          variant="ghost" size="sm"
          disabled={isAdded}
          onClick={() => handleSelect(node)}
          className={cn(
            '!w-full !justify-start !px-2 !py-1.5 !h-auto !rounded-md !text-left',
            '[@media(pointer:coarse)]:!min-h-[44px]',
            isAdded
              ? 'opacity-50 cursor-not-allowed'
              : 'hover:bg-[var(--interactive-hover)] cursor-pointer',
          )}
        >
          <IconComp size={20} className="shrink-0" />
          <span className="flex-1 min-w-0 text-sm truncate">{node.name}</span>
          {isAdded && (
            <Check className="w-3.5 h-3.5 text-primary shrink-0" />
          )}
        </DsButton>
      );
    })
  );

  // 移动端：画布内全屏内联子屏（顶栏返回 + 搜索 + 44px 行列表，pb-safe）
  if (isMobile) {
    return (
      <div
        ref={panelRef}
        role="dialog"
        aria-label={t('refs.pickerTitle')}
        className="mm-mobile-subview absolute inset-0 z-50 flex flex-col bg-[var(--mm-bg)]"
      >
        <div className="mm-mobile-subview-header">
          <DsButton
            variant="ghost"
            className="mm-mobile-subview-back"
            onClick={onClose}
            aria-label={t('common:back')}
          >
            <CaretLeft className="w-5 h-5" />
          </DsButton>
          <span className="font-medium text-sm">{t('refs.pickerTitle')}</span>
        </div>
        {searchBox}
        <CustomScrollArea
          className="flex-1 min-h-0"
          viewportClassName="mm-mobile-subview-scroll p-1"
          hideTrackWhenIdle
        >
          {listBody}
        </CustomScrollArea>
      </div>
    );
  }

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t('refs.pickerTitle')}
      className={cn(
        'fixed w-[360px] max-w-[calc(100vw-32px)] max-h-[min(420px,calc(100vh-96px))] flex flex-col',
        'mindmap-container rounded-[var(--mm-radius-popup,8px)] border border-[var(--mm-border)] bg-[var(--mm-bg-elevated)]',
        'shadow-[var(--mm-popover-shadow)]',
        'ui-zoom-fade-in',
      )}
      style={{
        zIndex: Z_INDEX.contextMenu + 10,
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium">{t('refs.pickerTitle')}</span>
        <DsButton variant="ghost" onClick={onClose} aria-label={t('common:close', { defaultValue: '关闭' })} className="w-6 h-6 p-0 [@media(pointer:coarse)]:w-9 [@media(pointer:coarse)]:h-9">
          <X className="w-4 h-4" />
        </DsButton>
      </div>

      {searchBox}

      {/* 资源列表 */}
      <CustomScrollArea className="flex-1 min-h-0" viewportClassName="p-1" hideTrackWhenIdle>
        {listBody}
      </CustomScrollArea>
    </div>,
    window.document.body
  );
};
