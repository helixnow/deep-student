/**
 * Crepe 编辑器块拖拽 Hook
 * 使用 Pointer Events 替代原生 HTML5 Drag & Drop API
 * 解决 Tauri WebView 下原生拖拽失效的问题
 *
 * 关键设计：
 * 1. 在 wrapper 上捕获 pointer，而不是在 block handle 元素上
 * 2. 定位一律基于被拖块/内容列的真实 rect（兼容缩放与窄边距），不用魔法数
 * 3. 拖拽预览为克隆块的半透明幽灵卡（简洁风格），源块淡化留在文档中
 * 4. 边缘自动滚动使用二次加速曲线；Escape / pointercancel / 窗口失焦可取消拖拽
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
const SOURCE_DIM_OPACITY = '0.32';
const GHOST_MIN_WIDTH = 180;
const GHOST_MAX_WIDTH = 480;
const GHOST_MAX_CONTENT_HEIGHT = 120;
const GHOST_GRAB_INSET = 10; // 抓取点相对幽灵卡边缘的最小内缩
const AUTOSCROLL_EDGE = 56; // 距滚动容器上下边缘触发自动滚动的区域高度
const AUTOSCROLL_MAX_SPEED = 22; // px / frame

/**
 * 基于 Pointer Events 的块拖拽实现
 * 完全不依赖原生 HTML5 Drag & Drop API
 */
export function useCrepeBlockDrag(options: UseCrepeBlockDragOptions): UseCrepeBlockDragReturn {
  const { crepeRef, wrapperRef, dropIndicatorRef, enabled = true } = options;

  const [dragState, setDragState] = useState<BlockDragState | null>(null);
  const dragStateRef = useRef<BlockDragState | null>(null);

  // 拖拽过程中的状态（使用 ref 避免闭包问题）
  const pointerStartPos = useRef<{ x: number; y: number } | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const blockHandleRef = useRef<Element | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const ghostElementRef = useRef<HTMLElement | null>(null);
  const ghostGrabOffsetRef = useRef({ x: GHOST_GRAB_INSET, y: GHOST_GRAB_INSET });
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);

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

  const getProseMirrorElement = useCallback((): HTMLElement | null => {
    return wrapperRef.current?.querySelector('.ProseMirror') as HTMLElement | null;
  }, [wrapperRef]);

  /** 把文档内任意位置收敛到对应顶层块的位置 */
  const resolveTopLevelPos = useCallback((view: any, rawPos: number): number | null => {
    const clamped = Math.max(0, Math.min(rawPos, view.state.doc.content.size));
    const $pos = view.state.doc.resolve(clamped);
    const pos = $pos.depth > 0 ? $pos.before(1) : clamped;
    return view.state.doc.nodeAt(pos) ? pos : null;
  }, []);

  /**
   * 根据 block handle 位置找到对应的 ProseMirror 顶层节点
   *
   * 用 handle 垂直中心命中的顶层块 DOM + posAtDOM 求位置，不再依赖
   * posAtCoords(x + 100) 的魔法水平偏移；rect 是布局后的真实坐标，
   * 缩放和窄侧边距下同样成立。
   */
  const findNodePosFromBlockHandle = useCallback((blockHandle: Element): { pos: number; node: any } | null => {
    const view = getView();
    const proseMirror = getProseMirrorElement();
    if (!view || !proseMirror) return null;

    const handleRect = blockHandle.getBoundingClientRect();
    const centerY = handleRect.top + handleRect.height / 2;

    let matched: Element | null = null;
    let nearest: Element | null = null;
    let nearestDistance = Infinity;
    for (const child of Array.from(proseMirror.children)) {
      const rect = child.getBoundingClientRect();
      if (rect.height <= 0) continue;
      if (centerY >= rect.top && centerY <= rect.bottom) {
        matched = child;
        break;
      }
      const distance = Math.min(Math.abs(centerY - rect.top), Math.abs(centerY - rect.bottom));
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = child;
      }
    }
    const blockElement = matched ?? nearest;

    let rawPos = -1;
    if (blockElement) {
      try {
        rawPos = view.posAtDOM(blockElement, 0);
      } catch {
        rawPos = -1;
      }
    }
    if (rawPos < 0) {
      // 兜底：从内容列实际左缘（ProseMirror rect + padding-left）取样
      const pmRect = proseMirror.getBoundingClientRect();
      const paddingLeft = Number.parseFloat(getComputedStyle(proseMirror).paddingLeft) || 0;
      const probeX = Math.min(pmRect.left + paddingLeft + 4, pmRect.right - 4);
      const hit = view.posAtCoords({ left: probeX, top: centerY });
      if (!hit) return null;
      rawPos = hit.inside >= 0 ? hit.inside : hit.pos;
    }

    const pos = resolveTopLevelPos(view, rawPos);
    if (pos === null) return null;
    return { pos, node: view.state.doc.nodeAt(pos) };
  }, [getView, getProseMirrorElement, resolveTopLevelPos]);

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
   * 单次扫描同时更新目标插入位置与 drop indicator。
   * indicator 垂直位移走 transform（配合样式表的 transform 过渡平滑跟随），
   * 目标位置用 posAtDOM 求得，避免 DOM 子元素与 doc 子节点索引错位。
   */
  const applyDropTarget = useCallback((clientY: number) => {
    const view = getView();
    const wrapper = wrapperRef.current;
    const proseMirror = getProseMirrorElement();
    if (!view || !wrapper || !proseMirror) return;

    let closestBlock: Element | null = null;
    let closestDistance = Infinity;
    let insertBefore = true;

    for (const block of Array.from(proseMirror.children)) {
      const rect = block.getBoundingClientRect();
      if (rect.height <= 0) continue;
      const middle = rect.top + rect.height / 2;
      const distance = Math.abs(clientY - middle);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestBlock = block;
        insertBefore = clientY < middle;
      }
    }

    if (!closestBlock) {
      hideDropIndicator();
      return;
    }

    let targetPos = -1;
    try {
      const rawPos = view.posAtDOM(closestBlock, 0);
      const topPos = resolveTopLevelPos(view, rawPos);
      if (topPos !== null) {
        const node = view.state.doc.nodeAt(topPos);
        targetPos = insertBefore ? topPos : topPos + node.nodeSize;
      }
    } catch {
      targetPos = -1;
    }

    if (dragStateRef.current && targetPos >= 0) {
      dragStateRef.current.targetInsertPos = targetPos;
      dragStateRef.current.insertBefore = insertBefore;
    }

    const indicator = dropIndicatorRef.current;
    if (indicator) {
      const wrapperRect = wrapper.getBoundingClientRect();
      const blockRect = closestBlock.getBoundingClientRect();
      const y = (insertBefore ? blockRect.top : blockRect.bottom) - wrapperRect.top;
      const wasVisible = indicator.dataset.visible === 'true';
      indicator.style.top = '0px';
      indicator.style.left = `${blockRect.left - wrapperRect.left}px`;
      indicator.style.width = `${blockRect.width}px`;
      if (!wasVisible) {
        // 首次出现直接落位，之后的移动才走样式表的 transform 过渡（避免从原点扫过）
        indicator.style.transition = 'none';
      }
      // -1px 让 2px 高度的插入条在块边界上下居中
      indicator.style.transform = `translate3d(0, ${y - 1}px, 0)`;
      if (!wasVisible) {
        void indicator.offsetHeight;
        indicator.style.transition = '';
      }
      indicator.dataset.visible = 'true';
    }
  }, [getView, wrapperRef, getProseMirrorElement, resolveTopLevelPos, hideDropIndicator, dropIndicatorRef]);

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
      // 目标落在源块自身边界（块前/块后）时是 no-op，跳过以免产生冗余历史步骤
      if (targetPos === sourcePos || targetPos === sourcePos + sourceNodeSize) {
        return false;
      }
      // 防御：目标位置不允许落进源块内部（嵌套块坐标计算异常时的兜底）
      if (targetPos > sourcePos && targetPos < sourcePos + sourceNodeSize) {
        return false;
      }
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
      return true;
    } catch (err) {
      console.error('[useCrepeBlockDrag] Block move failed:', err);
      return false;
    }
  }, [getView]);

  /**
   * 移除拖拽幽灵预览
   */
  const removeDragGhost = useCallback(() => {
    if (ghostElementRef.current) {
      ghostElementRef.current.remove();
      ghostElementRef.current = null;
    }
  }, []);

  /**
   * 创建 简洁风格的半透明块幽灵预览：克隆被拖块内容、限制宽高、
   * 底部渐隐裁剪。克隆容器借用 milkdown / ProseMirror 类名以复用既有
   * 排版样式，纯 cloneNode 成本低（不做逐属性 computed style 拷贝）。
   */
  const createDragGhost = useCallback((element: HTMLElement, clientX: number, clientY: number) => {
    removeDragGhost();

    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const rect = element.getBoundingClientRect();
    const width = Math.max(GHOST_MIN_WIDTH, Math.min(rect.width + 24, GHOST_MAX_WIDTH));
    ghostGrabOffsetRef.current = {
      x: Math.min(Math.max(clientX - rect.left, GHOST_GRAB_INSET), width - GHOST_GRAB_INSET),
      y: Math.min(Math.max(clientY - rect.top, GHOST_GRAB_INSET), GHOST_MAX_CONTENT_HEIGHT - GHOST_GRAB_INSET),
    };

    const ghost = document.createElement('div');
    // 根节点带上 crepe-editor-wrapper 类：幽灵挂到 body 后仍能命中
    // `.crepe-editor-wrapper .milkdown` 等作用域选择器与 --crepe-* 变量
    ghost.className = 'crepe-editor-wrapper crepe-drag-ghost';
    // 定位属性用 important 防御样式表覆盖；视觉属性走设计 token
    ghost.style.setProperty('position', 'fixed', 'important');
    ghost.style.setProperty('left', '0', 'important');
    ghost.style.setProperty('top', '0', 'important');
    ghost.style.setProperty('margin', '0', 'important');
    // 覆盖 .crepe-editor-wrapper 基础规则的 min-height:300px
    ghost.style.setProperty('min-height', '0', 'important');
    ghost.style.setProperty('pointer-events', 'none', 'important');
    ghost.style.setProperty('z-index', '9999', 'important');
    ghost.style.width = `${width}px`;
    ghost.style.boxSizing = 'border-box';
    ghost.style.padding = '8px 12px';
    ghost.style.borderRadius = 'var(--notes-radius-popup, 12px)';
    ghost.style.background = 'hsl(var(--background) / 0.92)';
    ghost.style.border = '1px solid hsl(var(--border))';
    ghost.style.boxShadow = 'var(--notes-popup-shadow, 0 8px 24px hsl(var(--foreground) / 0.14))';
    ghost.style.opacity = '0.85';
    ghost.style.willChange = 'transform';
    ghost.style.transform = `translate3d(${clientX - ghostGrabOffsetRef.current.x}px, ${clientY - ghostGrabOffsetRef.current.y}px, 0)`;

    // 借用编辑器类名让克隆内容套用既有排版；布局相关属性内联复位
    const scope = document.createElement('div');
    scope.className = 'milkdown';
    scope.style.setProperty('padding', '0', 'important');
    scope.style.setProperty('margin', '0', 'important');
    scope.style.setProperty('background', 'transparent', 'important');

    const content = document.createElement('div');
    content.className = 'ProseMirror';
    content.setAttribute('contenteditable', 'false');
    content.style.setProperty('min-height', '0', 'important');
    content.style.setProperty('padding', '0', 'important');
    content.style.setProperty('margin', '0', 'important');
    content.style.maxHeight = `${GHOST_MAX_CONTENT_HEIGHT}px`;
    content.style.overflow = 'hidden';
    const fadeMask = 'linear-gradient(to bottom, black 72%, transparent 100%)';
    content.style.setProperty('-webkit-mask-image', fadeMask);
    content.style.setProperty('mask-image', fadeMask);

    const clone = element.cloneNode(true) as HTMLElement;
    clone.classList.remove('ProseMirror-selectednode');
    clone.removeAttribute('contenteditable');
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
    clone.querySelectorAll('[contenteditable]').forEach((node) => node.removeAttribute('contenteditable'));
    clone.style.setProperty('margin', '0', 'important');
    clone.style.setProperty('opacity', '1', 'important');

    content.appendChild(clone);
    scope.appendChild(content);
    ghost.appendChild(scope);
    // 挂到 body 而非 wrapper：wrapper 可能位于带 transform 的移动端滑动轨道内，
    // position:fixed 会相对轨道定位导致幽灵跟手错位；样式作用域由根节点类名保留
    document.body.appendChild(ghost);
    ghostElementRef.current = ghost;
  }, [wrapperRef, removeDragGhost]);

  /**
   * 更新拖拽幽灵位置（transform 合成层移动，不触发布局）
   */
  const updateDragGhost = useCallback((clientX: number, clientY: number) => {
    const ghost = ghostElementRef.current;
    if (!ghost) return;
    const offset = ghostGrabOffsetRef.current;
    ghost.style.transform = `translate3d(${clientX - offset.x}px, ${clientY - offset.y}px, 0)`;
  }, []);

  const applyBodyCursor = useCallback(() => {
    document.body.style.setProperty('cursor', 'grabbing', 'important');
  }, []);

  const restoreBodyCursor = useCallback(() => {
    document.body.style.removeProperty('cursor');
  }, []);

  /** 找到编辑器所在的第一个可滚动祖先，用于边缘自动滚动 */
  const findScrollContainer = useCallback((): HTMLElement | null => {
    let el: HTMLElement | null = getProseMirrorElement();
    while (el) {
      if (el.scrollHeight > el.clientHeight + 1) {
        const { overflowY } = getComputedStyle(el);
        if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
          return el;
        }
      }
      el = el.parentElement;
    }
    return (document.scrollingElement as HTMLElement | null) ?? null;
  }, [getProseMirrorElement]);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current !== null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
  }, []);

  /** 自动滚动帧：二次加速曲线，越贴近边缘滚得越快；滚动后重算落点 */
  const autoScrollTick = useCallback(() => {
    autoScrollFrameRef.current = null;
    if (!isDraggingRef.current) return;

    const container = scrollContainerRef.current;
    const pointer = lastPointerRef.current;
    if (container && pointer) {
      const isRoot = container === document.scrollingElement
        || container === document.documentElement
        || container === document.body;
      let top: number;
      let bottom: number;
      if (isRoot) {
        top = 0;
        bottom = window.innerHeight;
      } else {
        const rect = container.getBoundingClientRect();
        top = rect.top;
        bottom = rect.bottom;
      }

      let delta = 0;
      const topDistance = pointer.y - top;
      const bottomDistance = bottom - pointer.y;
      if (topDistance < AUTOSCROLL_EDGE) {
        const t = Math.min(1, Math.max(0, (AUTOSCROLL_EDGE - topDistance) / AUTOSCROLL_EDGE));
        delta = -Math.ceil(AUTOSCROLL_MAX_SPEED * t * t);
      } else if (bottomDistance < AUTOSCROLL_EDGE) {
        const t = Math.min(1, Math.max(0, (AUTOSCROLL_EDGE - bottomDistance) / AUTOSCROLL_EDGE));
        delta = Math.ceil(AUTOSCROLL_MAX_SPEED * t * t);
      }

      if (delta !== 0) {
        const previous = container.scrollTop;
        container.scrollTop = previous + delta;
        if (container.scrollTop !== previous) {
          applyDropTarget(pointer.y);
        }
      }
    }

    autoScrollFrameRef.current = requestAnimationFrame(() => autoScrollTick());
  }, [applyDropTarget]);

  const startAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current === null) {
      autoScrollFrameRef.current = requestAnimationFrame(() => autoScrollTick());
    }
  }, [autoScrollTick]);

  const releasePointerCaptureIfAny = useCallback(() => {
    const wrapper = wrapperRef.current;
    const pointerId = pointerIdRef.current;
    if (wrapper && pointerId !== null) {
      try {
        if (wrapper.hasPointerCapture(pointerId)) {
          wrapper.releasePointerCapture(pointerId);
        }
      } catch {
        // 忽略
      }
    }
  }, [wrapperRef]);

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

    const view = getView();
    if (view && NodeSelection.isSelectable(nodeInfo.node)) {
      const nodeSelection = NodeSelection.create(view.state.doc, nodeInfo.pos);
      view.dispatch(view.state.tr.setSelection(nodeSelection));
    }

    // nodeDOM 同步可得，无需等待选中态渲染帧
    let draggedElement: HTMLElement | null = null;
    if (view) {
      try {
        const dom = view.nodeDOM(nodeInfo.pos);
        if (dom instanceof HTMLElement) draggedElement = dom;
      } catch {
        draggedElement = null;
      }
    }
    if (draggedElement) {
      // 先按原始状态创建预览，再淡化留在文档中的源块
      createDragGhost(draggedElement, clientX, clientY);
      draggedElement.style.opacity = SOURCE_DIM_OPACITY;
    }

    const state: BlockDragState = {
      isDragging: true,
      sourcePos: nodeInfo.pos,
      sourceNode: nodeInfo.node,
      targetInsertPos: -1,
      insertBefore: true,
      draggedElement,
      previewPosition: { x: clientX, y: clientY },
    };

    dragStateRef.current = state;
    setDragState(state);
    isDraggingRef.current = true;
    lastPointerRef.current = { x: clientX, y: clientY };
    scrollContainerRef.current = findScrollContainer();

    // 设置 data-dragging 属性，用于隐藏浮动工具栏
    const wrapper = wrapperRef.current;
    if (wrapper) {
      wrapper.dataset.dragging = 'true';
    }
    applyBodyCursor();

    applyDropTarget(clientY);
    startAutoScroll();
  }, [
    enabled,
    findNodePosFromBlockHandle,
    getView,
    createDragGhost,
    findScrollContainer,
    wrapperRef,
    applyBodyCursor,
    applyDropTarget,
    startAutoScroll,
  ]);

  const resetInteractionRefs = useCallback(() => {
    dragStateRef.current = null;
    setDragState(null);
    isDraggingRef.current = false;
    pointerStartPos.current = null;
    lastPointerRef.current = null;
    blockHandleRef.current = null;
    pointerIdRef.current = null;
    scrollContainerRef.current = null;
  }, []);

  /**
   * 清理函数（含取消拖拽路径：Escape / pointercancel / 窗口失焦 / 卸载）
   */
  const cleanup = useCallback(() => {
    stopAutoScroll();
    releasePointerCaptureIfAny();
    restoreBodyCursor();

    if (dragStateRef.current?.draggedElement) {
      dragStateRef.current.draggedElement.style.opacity = '';
    }
    hideDropIndicator();
    removeDragGhost();

    const wrapper = wrapperRef.current;
    if (wrapper) {
      delete wrapper.dataset.dragging;
    }

    resetInteractionRefs();
  }, [
    stopAutoScroll,
    releasePointerCaptureIfAny,
    restoreBodyCursor,
    hideDropIndicator,
    removeDragGhost,
    wrapperRef,
    resetInteractionRefs,
  ]);

  /**
   * Pointer Down 处理器
   */
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!enabled) return;
    if (e.button !== 0) return;

    const target = e.target as Element;
    const blockHandle = target.closest('.milkdown-block-handle');
    if (!blockHandle) return;

    // 检查是否在加号按钮上（第一个 operation-item）- 如果是则跳过
    const operationItem = target.closest('.operation-item');
    if (operationItem) {
      const allItems = blockHandle.querySelectorAll('.operation-item');
      const itemIndex = Array.from(allItems).indexOf(operationItem);
      if (itemIndex === 0) return;
    }

    // 阻止默认行为和冒泡，避免触发编辑器其他行为
    e.preventDefault();
    e.stopPropagation();

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

    if (isDraggingRef.current && dragStateRef.current) {
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
      applyDropTarget(e.clientY);
      updateDragGhost(e.clientX, e.clientY);
      dragStateRef.current.previewPosition = { x: e.clientX, y: e.clientY };
    }
  }, [enabled, startDrag, applyDropTarget, updateDragGhost]);

  /**
   * Pointer Up 处理器
   */
  const onPointerUp = useCallback((_e: React.PointerEvent) => {
    releasePointerCaptureIfAny();

    // 如果没有开始拖拽，清理并返回
    if (!isDraggingRef.current || !dragStateRef.current) {
      pointerStartPos.current = null;
      blockHandleRef.current = null;
      pointerIdRef.current = null;
      return;
    }

    const { sourcePos, targetInsertPos, draggedElement } = dragStateRef.current;

    stopAutoScroll();
    restoreBodyCursor();

    // 恢复被拖拽元素的样式
    if (draggedElement) {
      draggedElement.style.opacity = '';
    }

    hideDropIndicator();

    // 执行块移动
    if (targetInsertPos >= 0 && sourcePos !== targetInsertPos) {
      executeBlockMove(sourcePos, targetInsertPos);
    }

    removeDragGhost();

    const wrapper = wrapperRef.current;
    if (wrapper) {
      delete wrapper.dataset.dragging;
    }

    resetInteractionRefs();
  }, [
    releasePointerCaptureIfAny,
    stopAutoScroll,
    restoreBodyCursor,
    hideDropIndicator,
    executeBlockMove,
    removeDragGhost,
    wrapperRef,
    resetInteractionRefs,
  ]);

  // 取消路径：Escape 取消拖拽（不落块）、pointercancel、窗口失焦
  useEffect(() => {
    if (!enabled) return;

    const cancelActiveDrag = () => {
      if (isDraggingRef.current || pointerStartPos.current) {
        cleanup();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isDraggingRef.current) {
        event.preventDefault();
        event.stopPropagation();
        cleanup();
      }
    };

    window.addEventListener('pointercancel', cancelActiveDrag);
    window.addEventListener('blur', cancelActiveDrag);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointercancel', cancelActiveDrag);
      window.removeEventListener('blur', cancelActiveDrag);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [enabled, cleanup]);

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
