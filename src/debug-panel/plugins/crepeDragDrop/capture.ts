/**
 * Crepe 拖放调试：从 DOM 与 ProseMirror view 采集编辑器 / block handle / DOM 状态，并按事件类型检出问题。
 */

import type { DragEventLog, DragEventType } from './model';

// ============ 辅助函数 ============

export const getElementPath = (el: Element | null): string => {
  if (!el) return 'null';
  const parts: string[] = [];
  let current: Element | null = el;
  let depth = 0;
  while (current && depth < 5) {
    const tag = current.tagName.toLowerCase();
    const classes = current.className ? `.${current.className.split(' ').slice(0, 2).join('.')}` : '';
    parts.unshift(`${tag}${classes}`);
    current = current.parentElement;
    depth++;
  }
  return parts.join(' > ');
};

export const resolveTargetElement = (target: EventTarget | null): Element | null => {
  if (!target) return null;
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
};

export const captureEditorState = (): DragEventLog['editorState'] | undefined => {
  try {
    const milkdown = document.querySelector('.crepe-editor-wrapper .milkdown');
    const proseMirror = document.querySelector('.crepe-editor-wrapper .ProseMirror');
    
    if (!milkdown || !proseMirror) return undefined;

    // 尝试访问 ProseMirror view
    const view = (proseMirror as any).pmViewDesc?.node?.pmViewDesc?.view 
      || (window as any).__MILKDOWN_VIEW__;
    
    return {
      hasFocus: document.activeElement === proseMirror || proseMirror.contains(document.activeElement),
      isDragging: milkdown.getAttribute('data-dragging') === 'true',
      hasSelection: !!window.getSelection()?.toString(),
      selectionType: view?.state?.selection?.constructor?.name || 'unknown',
      draggingSlice: !!view?.dragging,
    };
  } catch {
    return undefined;
  }
};

export const captureBlockHandleState = (): DragEventLog['blockHandleState'] | undefined => {
  try {
    const blockHandle = document.querySelector('.milkdown-block-handle');
    if (!blockHandle) return { visible: false, activeNodeType: null, position: null };

    const dataShow = blockHandle.getAttribute('data-show');
    const rect = blockHandle.getBoundingClientRect();
    
    return {
      visible: dataShow !== 'false' && rect.width > 0,
      activeNodeType: blockHandle.closest('.ProseMirror')?.querySelector('[data-node-type]')?.getAttribute('data-node-type') || null,
      position: rect.width > 0 ? { x: rect.left, y: rect.top } : null,
    };
  } catch {
    return undefined;
  }
};

export const captureDOMState = (): DragEventLog['domState'] | undefined => {
  try {
    const draggableElements = document.querySelectorAll('.crepe-editor-wrapper [draggable="true"]');
    const blockHandle = document.querySelector('.milkdown-block-handle') as HTMLElement | null;
    const milkdown = document.querySelector('.crepe-editor-wrapper .milkdown');
    const proseMirror = document.querySelector('.crepe-editor-wrapper .ProseMirror') as HTMLElement | null;
    
    // 深度检查 block handle 状态
    let blockHandleDraggable = false;
    let blockHandlePointerEvents = '';
    let blockHandleDataShow = '';
    let operationItemCount = 0;
    
    if (blockHandle) {
      blockHandleDraggable = blockHandle.draggable === true || blockHandle.getAttribute('draggable') === 'true';
      blockHandlePointerEvents = getComputedStyle(blockHandle).pointerEvents;
      blockHandleDataShow = blockHandle.getAttribute('data-show') || '';
      operationItemCount = blockHandle.querySelectorAll('.operation-item').length;
    }
    
    // 检查 ProseMirror view
    let pmViewExists = false;
    let pmViewDragging = null;
    let pmViewEditable = false;
    let pmSelectionType = '';
    
    // 尝试多种方式获取 ProseMirror view
    let view = (window as any).__MILKDOWN_VIEW__;
    
    // 如果全局变量不存在，尝试从 DOM 获取
    if (!view && proseMirror) {
      // ProseMirror 将 view 存储在 DOM 元素的内部属性中
      view = (proseMirror as any).pmViewDesc?.view;
      if (!view) {
        // 尝试遍历 DOM 属性查找
        for (const key of Object.keys(proseMirror)) {
          if (key.startsWith('__reactFiber') || key.startsWith('__reactProps')) continue;
          const val = (proseMirror as any)[key];
          if (val && typeof val === 'object' && 'state' in val && 'dispatch' in val) {
            view = val;
            break;
          }
        }
      }
    }
    
    if (view) {
      pmViewExists = true;
      pmViewDragging = view.dragging;
      pmViewEditable = view.editable;
      pmSelectionType = view.state?.selection?.constructor?.name || '';
      console.log('[CrepeDragDropDebug] Found ProseMirror view:', { 
        dragging: view.dragging, 
        editable: view.editable,
        selectionType: pmSelectionType 
      });
    } else {
      // 尝试更多方式获取 view
      const milkdownView = (window as any).__MILKDOWN_VIEW__;
      const milkdownCtx = (window as any).__MILKDOWN_CTX__;
      console.warn('[CrepeDragDropDebug] ProseMirror view not found:', {
        windowView: milkdownView,
        windowCtx: milkdownCtx,
        proseMirrorDom: proseMirror,
        proseMirrorKeys: proseMirror ? Object.keys(proseMirror).filter(k => !k.startsWith('__react')).slice(0, 10) : [],
      });
    }
    
    return {
      draggableElements: draggableElements.length,
      blockHandleExists: !!blockHandle,
      dataDragging: milkdown?.getAttribute('data-dragging') || null,
      // 新增字段
      blockHandleDraggable,
      blockHandlePointerEvents,
      blockHandleDataShow,
      operationItemCount,
      pmViewExists,
      pmViewDragging: pmViewDragging ? { slice: !!pmViewDragging.slice, move: pmViewDragging.move } : null,
      pmViewEditable,
      pmSelectionType,
    };
  } catch (e) {
    console.error('[CrepeDragDropDebug] captureDOMState error:', e);
    return undefined;
  }
};

export const detectIssues = (
  event: DragEvent | MouseEvent | PointerEvent,
  type: DragEventType,
  editorState?: DragEventLog['editorState'],
  blockHandleState?: DragEventLog['blockHandleState'],
  domState?: DragEventLog['domState']
): string[] => {
  const issues: string[] = [];

  // 检查 dragstart 事件
  if (type === 'dragstart') {
    if (event.defaultPrevented) {
      issues.push('❌ dragstart 被 preventDefault() 阻止');
    }
    if (!domState?.blockHandleExists) {
      issues.push('❌ Block handle 不存在');
    }
    if (domState?.draggableElements === 0) {
      issues.push('❌ 没有 draggable="true" 的元素');
    }
    // 检查 block handle 的 draggable 属性
    if (domState && 'blockHandleDraggable' in domState && !domState.blockHandleDraggable) {
      issues.push('❌ Block handle 没有 draggable=true 属性');
    }
    // 检查 pointer-events
    if (domState && 'blockHandlePointerEvents' in domState && domState.blockHandlePointerEvents === 'none') {
      issues.push('❌ Block handle pointer-events: none');
    }
    // 检查 ProseMirror view
    if (domState && 'pmViewExists' in domState && !domState.pmViewExists) {
      issues.push('❌ ProseMirror view 不存在');
    }
    if (domState && 'pmViewDragging' in domState && !domState.pmViewDragging) {
      issues.push('⚠️ ProseMirror view.dragging 为空（BlockService 未设置）');
    }
    if (domState && 'pmSelectionType' in domState && domState.pmSelectionType !== 'NodeSelection') {
      issues.push(`⚠️ 当前选区类型: ${domState.pmSelectionType}（应为 NodeSelection）`);
    }
    const de = event as DragEvent;
    if (de.dataTransfer && !de.dataTransfer.types.length) {
      issues.push('⚠️ dataTransfer 没有数据');
    }
  }

  // 检查 dragover 事件
  if (type === 'dragover') {
    if (!event.defaultPrevented) {
      issues.push('⚠️ dragover 未调用 preventDefault()，可能阻止 drop');
    }
  }

  // 检查 drop 事件
  if (type === 'drop') {
    if (event.defaultPrevented) {
      issues.push('⚠️ drop 被 preventDefault() 阻止');
    }
    if (!editorState?.draggingSlice) {
      issues.push('⚠️ ProseMirror view.dragging 为空');
    }
  }

  // 检查 block handle 状态
  if (type === 'mousedown' || type === 'pointerdown') {
    if (!blockHandleState?.visible) {
      issues.push('⚠️ Block handle 不可见');
    }
    // 检查 mousedown 是否在 block handle 上
    const target = event.target as Element;
    const isOnBlockHandle = target?.closest?.('.milkdown-block-handle');
    const isOnOperationItem = target?.closest?.('.operation-item');
    if (isOnBlockHandle) {
      issues.push('📍 mousedown 在 block handle 上');
      if (isOnOperationItem) {
        // 检查是否是加号按钮（第一个 operation-item）
        const allItems = document.querySelectorAll('.milkdown-block-handle .operation-item');
        const itemIndex = Array.from(allItems).indexOf(target.closest('.operation-item')!);
        if (itemIndex === 0) {
          issues.push('📍 点击的是加号按钮（会触发 slash menu）');
        } else if (itemIndex === 1) {
          issues.push('📍 点击的是拖拽手柄（应触发 dragstart）');
        }
      }
    }
  }

  // 检查 mouseup 后的选区状态
  if (type === 'mouseup') {
    if (domState && 'pmSelectionType' in domState) {
      if (domState.pmSelectionType === 'NodeSelection') {
        issues.push('✅ 已设置 NodeSelection');
      } else {
        issues.push(`⚠️ 选区类型: ${domState.pmSelectionType}（需要 NodeSelection 才能拖放）`);
      }
    }
  }

  return issues;
};
