/**
 * Crepe 编辑器块拖拽 Hook
 * 使用 Pointer Events 替代原生 HTML5 Drag & Drop API
 * 解决 Tauri WebView 下原生拖拽失效的问题
 * 
 * 关键修复：
 * 1. 在 wrapper 上捕获 pointer，而不是在 block handle 元素上
 * 2. 使用 useRef 保存 blockHandle 引用，避免 pointer capture 后丢失
 * 3. 正确的事件流：pointerdown 记录 → pointermove 拖拽 → pointerup 放置
 */

import { useCallback, useRef, useEffect, useState } from 'react';
import { NodeSelection } from '@milkdown/kit/prose/state';
import type { Crepe } from '@milkdown/crepe';

export interface BlockDragState {
  isDragging: boolean;
  sourcePos: number;
  sourceNode: any;
  targetInsertPos: number;
  insertBefore: boolean;
  draggedElement: HTMLElement | null;
  /** 拖拽预览的位置 */
  previewPosition: { x: number; y: number } | null;
}

export interface UseCrepeBlockDragOptions {
  crepeRef: React.MutableRefObject<Crepe | null>;
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
  wrapperRef: React.MutableRefObject<HTMLDivElement | null>;
  dropIndicatorRef: React.MutableRefObject<HTMLDivElement | null>;
  enabled?: boolean;
}

export interface UseCrepeBlockDragReturn {
  /** 当前拖拽状态 */
  dragState: BlockDragState | null;
  /** 绑定到 wrapper 的事件处理器 */
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
  };
  /** 清理拖拽状态 */
  cleanup: () => void;
}

const DRAG_THRESHOLD = 8; // 最小拖拽距离阈值

/**
 * 基于 Pointer Events 的块拖拽实现
 * 完全不依赖原生 HTML5 Drag & Drop API
 */
export function useCrepeBlockDrag(options: UseCrepeBlockDragOptions): UseCrepeBlockDragReturn {
  const { crepeRef, containerRef, wrapperRef, dropIndicatorRef, enabled = true } = options;

  const [dragState, setDragState] = useState<BlockDragState | null>(null);
  const dragStateRef = useRef<BlockDragState | null>(null);
  
  // 拖拽过程中的状态（使用 ref 避免闭包问题）
  const pointerStartPos = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const blockHandleRef = useRef<Element | null>(null); // 保存 block handle 引用
  const pointerIdRef = useRef<number | null>(null);
  const previewElementRef = useRef<HTMLElement | null>(null); // 克隆的预览元素
  const previewPointerOffsetRef = useRef({ x: 0, y: 0 });

  /**
   * 获取 ProseMirror view
   */
  const getView = useCallback(() => {
    const crepe = crepeRef.current;
    if (!crepe) return null;

    try {
      let view: any = null;
      crepe.editor.action((ctx) => {
        try {
          view = ctx.get('editorView' as any);
        } catch {
          // 忽略
        }
      });
      return view;
    } catch {
      return null;
    }
  }, [crepeRef]);

  /**
   * 根据 block handle 位置找到对应的 ProseMirror 节点位置
   */
  const findNodePosFromBlockHandle = useCallback((blockHandle: Element): { pos: number; node: any } | null => {
    const view = getView();
    if (!view) return null;

    const rect = blockHandle.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    // 在 block handle 右侧一点找到编辑器内容
    const pos = view.posAtCoords({ left: x + 100, top: y });
    if (!pos || pos.inside < 0) return null;

    // 找到根节点
    let $pos = view.state.doc.resolve(pos.inside);
    while ($pos.depth > 1) {
      $pos = view.state.doc.resolve($pos.before($pos.depth));
    }

    const node = view.state.doc.nodeAt($pos.pos);
    if (!node) return null;

    return { pos: $pos.pos, node };
  }, [getView]);

  /**
   * 根据 Y 坐标计算目标插入位置
   */
  const calculateTargetPos = useCallback((clientY: number): { pos: number; insertBefore: boolean; blockIndex: number } | null => {
    const view = getView();
    const wrapper = wrapperRef.current;
    if (!view || !wrapper) return null;

    const proseMirror = wrapper.querySelector('.ProseMirror');
    if (!proseMirror) return null;

    const blocks = proseMirror.querySelectorAll(':scope > *');
    let closestBlock: Element | null = null;
    let closestDistance = Infinity;
    let insertBefore = true;
    let closestBlockIndex = -1;

    blocks.forEach((block, index) => {
      const rect = block.getBoundingClientRect();
      const blockMiddle = rect.top + rect.height / 2;
      const distance = Math.abs(clientY - blockMiddle);

      if (distance < closestDistance) {
        closestDistance = distance;
        closestBlock = block;
        insertBefore = clientY < blockMiddle;
        closestBlockIndex = index;
      }
    });

    if (!closestBlock || closestBlockIndex < 0) return null;

    // 计算 ProseMirror 文档中的插入位置
    let targetPos = 0;
    let currentBlockIndex = 0;
    view.state.doc.forEach((node: any, offset: number) => {
      if (currentBlockIndex === closestBlockIndex) {
        targetPos = insertBefore ? offset : offset + node.nodeSize;
      }
      currentBlockIndex++;
    });

    return { pos: targetPos, insertBefore, blockIndex: closestBlockIndex };
  }, [getView, wrapperRef]);

  /**
   * 更新 drop indicator 位置
   */
  const updateDropIndicator = useCallback((clientY: number) => {
    const wrapper = wrapperRef.current;
    const indicator = dropIndicatorRef.current;
    if (!wrapper || !indicator) return;

    const proseMirror = wrapper.querySelector('.ProseMirror');
    if (!proseMirror) return;

    const wrapperRect = wrapper.getBoundingClientRect();
    const blocks = proseMirror.querySelectorAll(':scope > *');
    let closestBlock: Element | null = null;
    let closestDistance = Infinity;
    let insertBefore = true;

    blocks.forEach((block) => {
      const rect = block.getBoundingClientRect();
      const blockMiddle = rect.top + rect.height / 2;
      const distance = Math.abs(clientY - blockMiddle);

      if (distance < closestDistance) {
        closestDistance = distance;
        closestBlock = block;
        insertBefore = clientY < blockMiddle;
      }
    });

    if (closestBlock) {
      const blockRect = closestBlock.getBoundingClientRect();
      const indicatorY = insertBefore
        ? blockRect.top - wrapperRect.top
        : blockRect.bottom - wrapperRect.top;

      indicator.style.top = `${indicatorY}px`;
      indicator.style.left = `${blockRect.left - wrapperRect.left}px`;
      indicator.style.width = `${blockRect.width}px`;
      indicator.dataset.visible = 'true';
    } else {
      delete indicator.dataset.visible;
    }
  }, [wrapperRef, dropIndicatorRef]);

  /**
   * 隐藏 drop indicator
   */
  const hideDropIndicator = useCallback(() => {
    const indicator = dropIndicatorRef.current;
    if (indicator) {
      delete indicator.dataset.visible;
    }
  }, [dropIndicatorRef]);

  /**
   * 执行块移动操作
   */
  const executeBlockMove = useCallback((sourcePos: number, targetPos: number) => {
    const view = getView();
    if (!view) return false;

    try {
      const sourceNode = view.state.doc.nodeAt(sourcePos);
      if (!sourceNode) return false;

      const sourceNodeSize = sourceNode.nodeSize;
      let tr = view.state.tr;

      if (targetPos > sourcePos) {
        // 向下移动：先插入后删除
        const nodeToInsert = sourceNode.copy(sourceNode.content);
        tr = tr.insert(targetPos, nodeToInsert);
        tr = tr.delete(sourcePos, sourcePos + sourceNodeSize);
      } else {
        // 向上移动：先删除后插入
        const nodeToInsert = sourceNode.copy(sourceNode.content);
        tr = tr.delete(sourcePos, sourcePos + sourceNodeSize);
        tr = tr.insert(targetPos, nodeToInsert);
      }

      view.dispatch(tr.scrollIntoView());
      view.focus();

      console.log('[useCrepeBlockDrag] Block move completed:', { sourcePos, targetPos });
      return true;
    } catch (err) {
      console.error('[useCrepeBlockDrag] Block move failed:', err);
      return false;
    }
  }, [getView]);

  /**
   * 创建拖拽预览（克隆原始 DOM 元素，放在 wrapper 内保持样式）
   */
  const createDragPreview = useCallback((element: HTMLElement, clientX: number, clientY: number) => {
    // 移除之前的预览
    if (previewElementRef.current) {
      previewElementRef.current.remove();
    }

    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const rect = element.getBoundingClientRect();
    previewPointerOffsetRef.current = {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };

    // NodeSelection 只用于拖拽定位，不应成为预览外观的一部分。
    const wasSelectedNode = element.classList.contains('ProseMirror-selectednode');
    const selectedAttribute = element.getAttribute('data-selected');
    element.classList.remove('ProseMirror-selectednode');
    element.removeAttribute('data-selected');

    let clone: HTMLElement;
    try {
      clone = element.cloneNode(true) as HTMLElement;
      const sourceElements = [element, ...Array.from(element.querySelectorAll('*'))];
      const clonedElements = [clone, ...Array.from(clone.querySelectorAll('*'))];

      // 将每个节点的最终计算样式固化到克隆上，避免预览脱离原 DOM 层级后样式变化。
      sourceElements.forEach((source, index) => {
        const target = clonedElements[index] as HTMLElement | undefined;
        if (!target) return;

        const computedStyle = window.getComputedStyle(source);
        for (const property of computedStyle) {
          target.style.setProperty(
            property,
            computedStyle.getPropertyValue(property),
            computedStyle.getPropertyPriority(property),
          );
        }
      });
    } finally {
      if (wasSelectedNode) element.classList.add('ProseMirror-selectednode');
      if (selectedAttribute !== null) element.setAttribute('data-selected', selectedAttribute);
    }

    // 仅覆盖拖拽层定位相关属性，视觉属性全部来自原始块。
    clone.classList.add('crepe-drag-preview-clone');
    clone.style.setProperty('position', 'fixed', 'important');
    clone.style.setProperty('left', `${clientX - previewPointerOffsetRef.current.x}px`, 'important');
    clone.style.setProperty('top', `${clientY - previewPointerOffsetRef.current.y}px`, 'important');
    clone.style.setProperty('width', `${rect.width}px`, 'important');
    clone.style.setProperty('height', `${rect.height}px`, 'important');
    clone.style.setProperty('margin', '0', 'important');
    clone.style.setProperty('pointer-events', 'none', 'important');
    clone.style.setProperty('z-index', '9999', 'important');

    // 放在 wrapper 内部以继承样式作用域
    wrapper.appendChild(clone);
    previewElementRef.current = clone;
  }, [wrapperRef]);

  /**
   * 更新拖拽预览位置
   */
  const updateDragPreview = useCallback((clientX: number, clientY: number) => {
    const preview = previewElementRef.current;
    if (!preview) return;

    preview.style.left = `${clientX - previewPointerOffsetRef.current.x}px`;
    preview.style.top = `${clientY - previewPointerOffsetRef.current.y}px`;
  }, []);

  /**
   * 移除拖拽预览
   */
  const removeDragPreview = useCallback(() => {
    if (previewElementRef.current) {
      previewElementRef.current.remove();
      previewElementRef.current = null;
    }
  }, []);

  /**
   * 开始拖拽
   */
  const startDrag = useCallback((blockHandle: Element, clientX: number, clientY: number) => {
    if (!enabled) return;

    const nodeInfo = findNodePosFromBlockHandle(blockHandle);
    if (!nodeInfo) {
      console.warn('[useCrepeBlockDrag] Cannot find node from block handle');
      return;
    }

    // 创建 NodeSelection
    const view = getView();
    if (view && NodeSelection.isSelectable(nodeInfo.node)) {
      const nodeSelection = NodeSelection.create(view.state.doc, nodeInfo.pos);
      view.dispatch(view.state.tr.setSelection(nodeSelection));
    }

    // 获取被拖拽的 DOM 元素
    const draggedElement: HTMLElement | null = null;
    const container = containerRef.current;
    if (container) {
      // 需要等待 DOM 更新
      requestAnimationFrame(() => {
        const selected = container.querySelector('.ProseMirror-selectednode') as HTMLElement;
        if (selected) {
          // 先按原始状态创建预览，再淡化留在文档中的源块。
          createDragPreview(selected, clientX, clientY);
          selected.style.opacity = '0.32';
          if (dragStateRef.current) {
            dragStateRef.current.draggedElement = selected;
          }
        }
      });
    }

    const state: BlockDragState = {
      isDragging: true,
      sourcePos: nodeInfo.pos,
      sourceNode: nodeInfo.node,
      targetInsertPos: -1,
      insertBefore: true,
      draggedElement,
      previewPosition: { x: 0, y: clientY },
    };

    dragStateRef.current = state;
    setDragState(state);
    isDraggingRef.current = true;

    // 设置 data-dragging 属性，用于隐藏浮动工具栏
    const wrapper = wrapperRef.current;
    if (wrapper) {
      wrapper.dataset.dragging = 'true';
    }

    // 立即显示 drop indicator
    updateDropIndicator(clientY)

    console.log('[useCrepeBlockDrag] Drag started:', { sourcePos: nodeInfo.pos, nodeType: nodeInfo.node?.type?.name });
  }, [enabled, findNodePosFromBlockHandle, getView, containerRef, wrapperRef, updateDropIndicator, createDragPreview]);

  /**
   * Pointer Down 处理器
   */
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!enabled) return;

    const target = e.target as Element;
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

    // 阻止默认行为和冒泡，避免触发编辑器其他行为
    e.preventDefault();
    e.stopPropagation();

    // 保存状态
    pointerStartPos.current = { x: e.clientX, y: e.clientY };
    blockHandleRef.current = blockHandle;
    pointerIdRef.current = e.pointerId;

    // 在 wrapper 上捕获 pointer（而不是在 block handle 上）
    const wrapper = wrapperRef.current;
    if (wrapper) {
      wrapper.setPointerCapture(e.pointerId);
    }
  }, [enabled, wrapperRef]);

  /**
   * Pointer Move 处理器
   */
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!enabled || !pointerStartPos.current || !blockHandleRef.current) return;

    const dx = e.clientX - pointerStartPos.current.x;
    const dy = e.clientY - pointerStartPos.current.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // 超过阈值才开始拖拽
    if (!isDraggingRef.current && distance >= DRAG_THRESHOLD) {
      startDrag(blockHandleRef.current, e.clientX, e.clientY);
    }

    // 正在拖拽时更新位置
    if (isDraggingRef.current && dragStateRef.current) {
      updateDropIndicator(e.clientY);

      // 更新目标位置
      const targetInfo = calculateTargetPos(e.clientY);
      if (targetInfo) {
        dragStateRef.current.targetInsertPos = targetInfo.pos;
        dragStateRef.current.insertBefore = targetInfo.insertBefore;
      }

      // 更新拖拽预览位置
      updateDragPreview(e.clientX, e.clientY);
      dragStateRef.current.previewPosition = { x: e.clientX, y: e.clientY };
    }
  }, [enabled, startDrag, updateDropIndicator, calculateTargetPos, updateDragPreview]);

  /**
   * Pointer Up 处理器
   */
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    // 释放 pointer 捕获
    const wrapper = wrapperRef.current;
    if (wrapper && pointerIdRef.current !== null) {
      try {
        wrapper.releasePointerCapture(pointerIdRef.current);
      } catch {
        // 忽略
      }
    }

    // 如果没有开始拖拽，清理并返回
    if (!isDraggingRef.current || !dragStateRef.current) {
      pointerStartPos.current = null;
      blockHandleRef.current = null;
      pointerIdRef.current = null;
      return;
    }

    const { sourcePos, targetInsertPos, draggedElement } = dragStateRef.current;

    // 恢复被拖拽元素的样式
    if (draggedElement) {
      draggedElement.style.opacity = '';
    }

    // 隐藏 drop indicator
    hideDropIndicator();

    // 执行块移动
    if (targetInsertPos >= 0 && sourcePos !== targetInsertPos) {
      executeBlockMove(sourcePos, targetInsertPos);
    }

    // 移除拖拽预览
    removeDragPreview();

    // 移除 data-dragging 属性
    if (wrapper) {
      delete wrapper.dataset.dragging;
    }

    // 清理状态
    dragStateRef.current = null;
    setDragState(null);
    isDraggingRef.current = false;
    pointerStartPos.current = null;
    blockHandleRef.current = null;
    pointerIdRef.current = null;
  }, [wrapperRef, hideDropIndicator, executeBlockMove, removeDragPreview]);

  /**
   * 清理函数
   */
  const cleanup = useCallback(() => {
    if (dragStateRef.current?.draggedElement) {
      dragStateRef.current.draggedElement.style.opacity = '';
    }
    hideDropIndicator();
    removeDragPreview();
    
    // 移除 data-dragging 属性
    const wrapper = wrapperRef.current;
    if (wrapper) {
      delete wrapper.dataset.dragging;
    }
    
    dragStateRef.current = null;
    setDragState(null);
    isDraggingRef.current = false;
    pointerStartPos.current = null;
    blockHandleRef.current = null;
    pointerIdRef.current = null;
  }, [hideDropIndicator, wrapperRef, removeDragPreview]);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    dragState,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
    },
    cleanup,
  };
}

export default useCrepeBlockDrag;
