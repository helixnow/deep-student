import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { Edge, Node, ReactFlowInstance } from '@xyflow/react';
import {
  BACK_PRIORITY,
  registerBackHandler,
} from '@/app/navigation/androidBackCoordinator';
import { eventMatchesShortcut } from '../../../constants/shortcuts';
import type { MindMapStoreApi } from '../../../store';
import type { MindMapAssociation } from '../../../types';
import type { AssociationEdgeData } from '../edges';

export interface UseCanvasAssociationModeOptions {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
  reactFlowInstance: ReactFlowInstance;
  storeApi: MindMapStoreApi;
  layoutNodes: Node[];
  associations: MindMapAssociation[] | undefined;
  focusedNodeId: string | null;
  selection: string[];
  associationModeRequest: number;
  isCanvasActive: boolean;
  reciteMode: boolean;
  openAssociationContextMenu: (associationId: string, position: { x: number; y: number }) => void;
  /** Safari/WKWebView compositionend 100ms 守卫时间戳 */
  lastCompositionEndAtRef: React.MutableRefObject<number>;
}

export interface UseCanvasAssociationModeResult {
  associatingFromId: string | null;
  selectedAssociationId: string | null;
  editingAssociationId: string | null;
  setSelectedAssociationId: React.Dispatch<React.SetStateAction<string | null>>;
  setEditingAssociationId: React.Dispatch<React.SetStateAction<string | null>>;
  associationPointer: { x: number; y: number } | null;
  associationSourceCenter: { x: number; y: number } | null;
  associationEdges: Edge[];
  lastAssociationIdRef: React.MutableRefObject<string | null>;
  clearAssociationMode: () => void;
  handleStartAssociation: (nodeId: string) => void;
  handleEditAssociationLabel: (associationId: string) => void;
  handleDeleteAssociation: (associationId: string) => void;
  onEdgeClick: (event: React.MouseEvent, edge: Edge) => void;
  onEdgeContextMenu: (event: React.MouseEvent, edge: Edge) => void;
}

/**
 * 画布关联线模式与关联线选中/编辑态管理 Hook：
 * - 关联线创建模式（associatingFromId）、跟手虚线预览坐标（rAF 节流）
 * - 关联线 ReactFlow Edge 构建 + 点击/右键菜单交互
 * - Esc / Mod+L / Enter / F2 / Delete 快捷键 + Android 返回手势优先级注册
 */
export function useCanvasAssociationMode({
  canvasContainerRef,
  reactFlowInstance,
  storeApi,
  layoutNodes,
  associations,
  focusedNodeId,
  selection,
  associationModeRequest,
  isCanvasActive,
  reciteMode,
  openAssociationContextMenu,
  lastCompositionEndAtRef,
}: UseCanvasAssociationModeOptions): UseCanvasAssociationModeResult {
  const [associatingFromId, setAssociatingFromId] = useState<string | null>(null);
  const [selectedAssociationId, setSelectedAssociationId] = useState<string | null>(null);
  const [editingAssociationId, setEditingAssociationId] = useState<string | null>(null);
  const [associationPointer, setAssociationPointer] = useState<{ x: number; y: number } | null>(
    null,
  );
  const lastAssociationIdRef = useRef<string | null>(null);

  if (selectedAssociationId) {
    lastAssociationIdRef.current = selectedAssociationId;
  }

  const clearAssociationMode = useCallback(() => {
    setAssociatingFromId(null);
  }, []);

  // 关联线模式跟手预览：指针的 flow 坐标（rAF 节流采样，退出模式即清空）
  useEffect(() => {
    if (!associatingFromId) {
      setAssociationPointer(null);
      return;
    }
    const container = canvasContainerRef.current;
    if (!container) return;
    let raf: number | null = null;
    let pending: { x: number; y: number } | null = null;
    const onPointerMove = (e: PointerEvent) => {
      pending = reactFlowInstance.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      if (raf != null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        if (pending) setAssociationPointer(pending);
      });
    };
    container.addEventListener('pointermove', onPointerMove);
    return () => {
      container.removeEventListener('pointermove', onPointerMove);
      if (raf != null) cancelAnimationFrame(raf);
      setAssociationPointer(null);
    };
  }, [associatingFromId, canvasContainerRef, reactFlowInstance]);

  // 关联线预览的源节点中心（flow 坐标）
  const associationSourceCenter = useMemo(() => {
    if (!associatingFromId) return null;
    const source = layoutNodes.find((n) => n.id === associatingFromId);
    if (!source) return null;
    const width = (source.width as number | undefined) ?? source.measured?.width ?? 100;
    const height = (source.height as number | undefined) ?? source.measured?.height ?? 36;
    return {
      x: source.position.x + width / 2,
      y: source.position.y + height / 2,
    };
  }, [associatingFromId, layoutNodes]);

  const handleStartAssociation = useCallback(
    (nodeId: string) => {
      const state = storeApi.getState();
      setAssociatingFromId(nodeId);
      setSelectedAssociationId(null);
      setEditingAssociationId(null);
      state.setFocusedNodeId(nodeId);
      state.setSelection([nodeId]);
    },
    [storeApi],
  );

  const handledAssociationRequestRef = useRef(0);
  useEffect(() => {
    if (
      associationModeRequest <= 0 ||
      associationModeRequest === handledAssociationRequestRef.current
    ) {
      return;
    }
    handledAssociationRequestRef.current = associationModeRequest;
    const sourceId = focusedNodeId || selection[0];
    if (sourceId) handleStartAssociation(sourceId);
  }, [associationModeRequest, focusedNodeId, handleStartAssociation, selection]);

  const handleAssociationLabelChange = useCallback(
    (associationId: string, label: string) => {
      storeApi.getState().updateAssociationLabel(associationId, label);
    },
    [storeApi],
  );

  const handleAssociationLabelEditEnd = useCallback(() => {
    setEditingAssociationId(null);
  }, []);

  const handleAssociationLabelEditStart = useCallback(
    (associationId: string) => {
      const state = storeApi.getState();
      setEditingAssociationId(associationId);
      setSelectedAssociationId(associationId);
      state.setFocusedNodeId(null);
      state.setSelection([]);
    },
    [storeApi],
  );

  const handleEditAssociationLabel = useCallback((id: string) => {
    setEditingAssociationId(id);
    setSelectedAssociationId(id);
  }, []);

  const handleDeleteAssociation = useCallback(
    (id: string) => {
      storeApi.getState().removeAssociation(id);
      setSelectedAssociationId((cur) => (cur === id ? null : cur));
      setEditingAssociationId((cur) => (cur === id ? null : cur));
    },
    [storeApi],
  );

  const associationEdges = useMemo<Edge[]>(() => {
    const list = associations ?? [];
    if (list.length === 0) return [];
    const visibleNodeIds = new Set(layoutNodes.map((n) => n.id));
    return list
      .filter((a) => visibleNodeIds.has(a.source) && visibleNodeIds.has(a.target))
      .map((a) => {
        const data: AssociationEdgeData = {
          kind: 'association',
          associationId: a.id,
          label: a.label,
          editing: editingAssociationId === a.id,
          onLabelChange: handleAssociationLabelChange,
          onLabelEditEnd: handleAssociationLabelEditEnd,
          onLabelEditStart: handleAssociationLabelEditStart,
        };
        return {
          id: a.id,
          source: a.source,
          target: a.target,
          type: 'association',
          selectable: true,
          selected: selectedAssociationId === a.id,
          style: a.style
            ? {
                stroke: a.style.stroke,
                strokeWidth: a.style.strokeWidth,
                strokeDasharray: a.style.strokeDasharray,
              }
            : undefined,
          data,
        } satisfies Edge;
      });
  }, [
    associations,
    layoutNodes,
    editingAssociationId,
    selectedAssociationId,
    handleAssociationLabelChange,
    handleAssociationLabelEditEnd,
    handleAssociationLabelEditStart,
  ]);

  const onEdgeClick = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      const kind = (edge.data as { kind?: string } | undefined)?.kind;
      if (kind !== 'association') return;
      event.stopPropagation();
      const associationId =
        (edge.data as AssociationEdgeData | undefined)?.associationId ?? edge.id;
      const state = storeApi.getState();
      setSelectedAssociationId(associationId);
      state.setFocusedNodeId(null);
      state.setSelection([]);
      state.setEditingNodeId(null);
      state.setEditingNoteNodeId(null);
    },
    [storeApi],
  );

  const onEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      event.preventDefault();
      event.stopPropagation();
      if (reciteMode) return;
      const kind = (edge.data as { kind?: string } | undefined)?.kind;
      if (kind !== 'association') return;
      const associationId =
        (edge.data as AssociationEdgeData | undefined)?.associationId ?? edge.id;
      setSelectedAssociationId(associationId);
      openAssociationContextMenu(associationId, { x: event.clientX, y: event.clientY });
    },
    [openAssociationContextMenu, reciteMode],
  );

  // 关联线键盘交互（capture 抢在 useMindMapKeyboard 之前，严格守卫 IME 组合态）
  useEffect(() => {
    if (!isCanvasActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (Date.now() - lastCompositionEndAtRef.current < 100) return;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

      if (e.key === 'Escape' && associatingFromId) {
        e.preventDefault();
        e.stopPropagation();
        clearAssociationMode();
        return;
      }

      if (
        eventMatchesShortcut(e, 'mod+l') &&
        !reciteMode &&
        !associatingFromId &&
        !editingAssociationId
      ) {
        const state = storeApi.getState();
        const sourceId = state.focusedNodeId || state.selection[0];
        if (sourceId) {
          e.preventDefault();
          e.stopPropagation();
          handleStartAssociation(sourceId);
        }
        return;
      }

      if (
        (e.key === 'Enter' || e.key === 'F2') &&
        selectedAssociationId &&
        !editingAssociationId &&
        !reciteMode &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        e.stopPropagation();
        setEditingAssociationId(selectedAssociationId);
        return;
      }

      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        selectedAssociationId &&
        !editingAssociationId &&
        !reciteMode
      ) {
        e.preventDefault();
        e.stopPropagation();
        storeApi.getState().removeAssociation(selectedAssociationId);
        setSelectedAssociationId(null);
      }
    };

    window.document.addEventListener('keydown', handleKeyDown, true);
    return () => window.document.removeEventListener('keydown', handleKeyDown, true);
  }, [
    isCanvasActive,
    associatingFromId,
    clearAssociationMode,
    handleStartAssociation,
    selectedAssociationId,
    editingAssociationId,
    reciteMode,
    storeApi,
    lastCompositionEndAtRef,
  ]);

  // 关联创建/选中工具条属于画布内临时操作态，Android 返回应先退出该状态
  useEffect(() => {
    if (!isCanvasActive || (!associatingFromId && !selectedAssociationId)) return;
    return registerBackHandler(() => {
      if (associatingFromId) {
        clearAssociationMode();
      } else {
        setSelectedAssociationId(null);
      }
      return true;
    }, BACK_PRIORITY.overlay);
  }, [associatingFromId, clearAssociationMode, isCanvasActive, selectedAssociationId]);

  return {
    associatingFromId,
    selectedAssociationId,
    editingAssociationId,
    setSelectedAssociationId,
    setEditingAssociationId,
    associationPointer,
    associationSourceCenter,
    associationEdges,
    lastAssociationIdRef,
    clearAssociationMode,
    handleStartAssociation,
    handleEditAssociationLabel,
    handleDeleteAssociation,
    onEdgeClick,
    onEdgeContextMenu,
  };
}
