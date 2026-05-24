/**
 * Crepe 编辑器拖放调试插件
 * 全面监控拖放功能的完整生命周期，用于诊断拖放无法工作的问题
 * 
 * 监控范围：
 * - 拖放事件：dragstart, dragover, dragenter, dragleave, drop, dragend
 * - BlockService 状态：active node, selection, dragging
 * - ProseMirror 状态：view.dragging, selection
 * - DOM 属性：draggable, data-dragging
 * - 事件传播：是否被阻止、目标元素
 */

import React from 'react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { 
  Copy, Clipboard, Trash, Play, Pause, Eye, 
  Warning, CheckCircle, XCircle, DotsSixVertical,
  Cursor, Target, ArrowDown
} from '@phosphor-icons/react';
import { showGlobalNotification } from '../../components/UnifiedNotification';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// ============ 类型定义 ============

type DragEventType = 
  | 'mousedown'
  | 'mouseup'
  | 'dragstart'
  | 'drag'
  | 'dragover'
  | 'dragenter'
  | 'dragleave'
  | 'drop'
  | 'dragend'
  | 'pointerdown'
  | 'pointerup';

interface DragEventLog {
  id: string;
  ts: number;
  type: DragEventType;
  phase: 'capture' | 'bubble';
  target: string;
  currentTarget: string;
  relatedTarget?: string;
  clientX: number;
  clientY: number;
  dataTransfer?: {
    effectAllowed: string;
    dropEffect: string;
    types: string[];
    hasData: boolean;
  };
  defaultPrevented: boolean;
  propagationStopped: boolean;
  immediatePropagationStopped: boolean;
  // 状态快照
  editorState?: {
    hasFocus: boolean;
    isDragging: boolean;
    hasSelection: boolean;
    selectionType: string;
    draggingSlice: boolean;
  };
  blockHandleState?: {
    visible: boolean;
    activeNodeType: string | null;
    position: { x: number; y: number } | null;
  };
  domState?: {
    draggableElements: number;
    blockHandleExists: boolean;
    dataDragging: string | null;
    // 增强调试字段
    blockHandleDraggable?: boolean;
    blockHandlePointerEvents?: string;
    blockHandleDataShow?: string;
    operationItemCount?: number;
    pmViewExists?: boolean;
    pmViewDragging?: { slice: boolean; move: boolean } | null;
    pmViewEditable?: boolean;
    pmSelectionType?: string;
  };
  // 诊断信息
  issues: string[];
}

interface DiagnosisResult {
  category: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
  details?: string;
}

// ============ 常量 ============

const EVENT_COLORS: Record<DragEventType, string> = {
  mousedown: '#6366f1',
  mouseup: '#8b5cf6',
  pointerdown: '#a855f7',
  pointerup: '#c084fc',
  dragstart: '#22c55e',
  drag: '#84cc16',
  dragover: '#eab308',
  dragenter: '#f97316',
  dragleave: '#ef4444',
  drop: '#10b981',
  dragend: '#06b6d4',
};

const EVENT_ICONS: Record<DragEventType, React.FC<any>> = {
  mousedown: Cursor,
  mouseup: Cursor,
  pointerdown: Cursor,
  pointerup: Cursor,
  dragstart: Play,
  drag: DotsSixVertical,
  dragover: Target,
  dragenter: ArrowDown,
  dragleave: XCircle,
  drop: CheckCircle,
  dragend: Pause,
};

// ============ 全局事件通道 ============

export const CREPE_DRAG_DEBUG_EVENT = 'crepe-drag-drop-debug';

export interface CrepeDragDebugEventDetail {
  type: DragEventType;
  phase: 'capture' | 'bubble';
  target: string;
  currentTarget: string;
  relatedTarget?: string;
  clientX: number;
  clientY: number;
  dataTransfer?: DragEventLog['dataTransfer'];
  defaultPrevented: boolean;
  propagationStopped: boolean;
  immediatePropagationStopped: boolean;
  editorState?: DragEventLog['editorState'];
  blockHandleState?: DragEventLog['blockHandleState'];
  domState?: DragEventLog['domState'];
  issues: string[];
}

// ============ 辅助函数 ============

const getElementPath = (el: Element | null): string => {
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

const resolveTargetElement = (target: EventTarget | null): Element | null => {
  if (!target) return null;
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
};

const captureEditorState = (): DragEventLog['editorState'] | undefined => {
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

const captureBlockHandleState = (): DragEventLog['blockHandleState'] | undefined => {
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

const captureDOMState = (): DragEventLog['domState'] | undefined => {
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

const detectIssues = (
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

// ============ 插件组件 ============

const CrepeDragDropDebugPlugin: React.FC<DebugPanelPluginProps> = ({ visible, isActive, isActivated }) => {
  const [logs, setLogs] = React.useState<DragEventLog[]>([]);
  const [isRecording, setIsRecording] = React.useState(true);
  const [selectedEventTypes, setSelectedEventTypes] = React.useState<Set<DragEventType>>(new Set([
    'dragstart', 'dragover', 'dragenter', 'dragleave', 'drop', 'dragend', 'mousedown', 'mouseup'
  ]));
  const [autoScroll, setAutoScroll] = React.useState(true);
  const [showIssuesOnly, setShowIssuesOnly] = React.useState(false);
  const logContainerRef = React.useRef<HTMLDivElement>(null);
  const listenersRef = React.useRef<Map<string, EventListener>>(new Map());

  const append = React.useCallback((entry: Omit<DragEventLog, 'id'>) => {
    if (!isRecording) return;
    setLogs(prev => {
      const next = [...prev, { ...entry, id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}` }];
      return next.slice(-300);
    });
  }, [isRecording]);

  // 设置事件监听
  React.useEffect(() => {
    if (!isActivated) return;

    console.log('[CrepeDragDropDebug] 插件激活，开始监听事件...');
    
    // 在 block handle 上添加调试监听器
    const setupBlockHandleDebug = () => {
      const blockHandle = document.querySelector('.milkdown-block-handle');
      if (blockHandle) {
        console.log('[CrepeDragDropDebug] Block handle found, adding debug listeners');
        console.log('[CrepeDragDropDebug] Block handle draggable:', (blockHandle as HTMLElement).draggable);
        console.log('[CrepeDragDropDebug] Block handle children:', blockHandle.children.length);
        
        // 监听 block handle 自身的事件
        const debugMousedown = (e: Event) => {
          console.log('[CrepeDragDropDebug] Block handle mousedown (direct):', e.target);
        };
        const debugDragstart = (e: Event) => {
          console.log('[CrepeDragDropDebug] Block handle dragstart (direct):', e.target, (e as DragEvent).dataTransfer);
        };
        blockHandle.addEventListener('mousedown', debugMousedown, { capture: true });
        blockHandle.addEventListener('dragstart', debugDragstart, { capture: true });
        
        return () => {
          blockHandle.removeEventListener('mousedown', debugMousedown, { capture: true });
          blockHandle.removeEventListener('dragstart', debugDragstart, { capture: true });
        };
      } else {
        console.warn('[CrepeDragDropDebug] Block handle not found, retrying in 1s...');
        const timer = setTimeout(setupBlockHandleDebug, 1000);
        return () => clearTimeout(timer);
      }
    };
    
    const cleanupBlockHandleDebug = setupBlockHandleDebug();

    const eventTypes: DragEventType[] = [
      'mousedown', 'mouseup', 'pointerdown', 'pointerup',
      'dragstart', 'drag', 'dragover', 'dragenter', 'dragleave', 'drop', 'dragend'
    ];

    const createHandler = (type: DragEventType, phase: 'capture' | 'bubble') => {
      return (e: Event) => {
        const event = e as DragEvent | MouseEvent | PointerEvent;
        const elementTarget = resolveTargetElement(event.target);

        // 只监听与编辑器相关的事件
        const isEditorRelated = elementTarget?.closest('.crepe-editor-wrapper') || 
                                elementTarget?.closest('.milkdown-block-handle') ||
                                elementTarget?.closest('.milkdown');
        
        // 对于 drag 相关事件，即使不在编辑器内也要记录（因为可能是拖拽过程中）
        const isDragEvent = ['dragstart', 'drag', 'dragover', 'dragenter', 'dragleave', 'drop', 'dragend'].includes(type);
        
        // 对于 mouse/pointer 事件，也要记录 block handle 上的
        const isMouseEvent = ['mousedown', 'mouseup', 'pointerdown', 'pointerup'].includes(type);
        const isOnBlockHandle = elementTarget?.closest('.milkdown-block-handle');
        
        if (!elementTarget && !isDragEvent) return;
        if (!isEditorRelated && !isDragEvent && !(isMouseEvent && isOnBlockHandle)) return;
        
        // 跳过频繁的 drag 和 dragover 事件（节流）
        if ((type === 'drag' || type === 'dragover') && Math.random() > 0.1) return;

        console.log(`[CrepeDragDropDebug] 捕获事件: ${type}`, { target: elementTarget?.tagName, className: elementTarget?.className });

        const editorState = captureEditorState();
        const blockHandleState = captureBlockHandleState();
        const domState = captureDOMState();
        const issues = detectIssues(event, type, editorState, blockHandleState, domState);

        let dataTransfer: DragEventLog['dataTransfer'] | undefined;
        if ('dataTransfer' in event && event.dataTransfer) {
          dataTransfer = {
            effectAllowed: event.dataTransfer.effectAllowed,
            dropEffect: event.dataTransfer.dropEffect,
            types: Array.from(event.dataTransfer.types),
            hasData: event.dataTransfer.types.length > 0,
          };
        }

        append({
          ts: Date.now(),
          type,
          phase,
          target: getElementPath(elementTarget),
          currentTarget: getElementPath(resolveTargetElement(event.currentTarget as EventTarget)),
          relatedTarget: 'relatedTarget' in event ? getElementPath(resolveTargetElement((event as DragEvent).relatedTarget as EventTarget)) : undefined,
          clientX: event.clientX,
          clientY: event.clientY,
          dataTransfer,
          defaultPrevented: event.defaultPrevented,
          propagationStopped: false,
          immediatePropagationStopped: false,
          editorState,
          blockHandleState,
          domState,
          issues,
        });
      };
    };

    // 在 capture 阶段监听 - 使用 document 来捕获所有事件
    eventTypes.forEach(type => {
      const captureHandler = createHandler(type, 'capture');
      const key = `${type}-capture`;
      listenersRef.current.set(key, captureHandler as EventListener);
      window.addEventListener(type, captureHandler, { capture: true, passive: true });
    });

    // 记录初始化
    const domState = captureDOMState();
    console.log('[CrepeDragDropDebug] 初始 DOM 状态:', domState);
    
    append({
      ts: Date.now(),
      type: 'dragstart',
      phase: 'capture',
      target: 'system',
      currentTarget: 'system',
      clientX: 0,
      clientY: 0,
      defaultPrevented: false,
      propagationStopped: false,
      immediatePropagationStopped: false,
      domState,
      issues: ['📍 拖放调试插件已激活，等待拖放操作...'],
    });

    return () => {
      console.log('[CrepeDragDropDebug] 清理事件监听器');
      cleanupBlockHandleDebug?.();
      listenersRef.current.forEach((handler, key) => {
        const [type] = key.split('-');
        window.removeEventListener(type, handler, { capture: true });
      });
      listenersRef.current.clear();
    };
  }, [isActivated, append]);

  // 自动滚动
  React.useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const clearLogs = React.useCallback(() => setLogs([]), []);

  // 运行完整诊断
  const runDiagnosis = React.useCallback(() => {
    const results: string[] = [];
    
    // 1. 检查 window.__MILKDOWN_VIEW__
    const milkdownView = (window as any).__MILKDOWN_VIEW__;
    const milkdownCtx = (window as any).__MILKDOWN_CTX__;
    
    if (milkdownView) {
      results.push('✅ window.__MILKDOWN_VIEW__ 存在');
      results.push(`   - editable: ${milkdownView.editable}`);
      results.push(`   - dragging: ${JSON.stringify(milkdownView.dragging)}`);
      results.push(`   - selection: ${milkdownView.state?.selection?.constructor?.name || 'unknown'}`);
      results.push(`   - hasFocus: ${milkdownView.hasFocus?.() ?? 'unknown'}`);
    } else {
      results.push('❌ window.__MILKDOWN_VIEW__ 不存在');
    }
    
    if (milkdownCtx) {
      results.push('✅ window.__MILKDOWN_CTX__ 存在');
    } else {
      results.push('❌ window.__MILKDOWN_CTX__ 不存在');
    }
    
    // 检查 crepe 实例
    const crepe = (window as any).__MILKDOWN_CREPE__;
    if (crepe) {
      results.push('✅ window.__MILKDOWN_CREPE__ 存在');
      results.push(`   - crepe.readonly: ${crepe.readonly}`);
      
      // 检查 crepe 对象结构
      const crepeKeys = Object.keys(crepe).filter(k => !k.startsWith('_'));
      results.push(`   - crepe keys: ${crepeKeys.join(', ')}`);
      
      // 检查 editor 对象
      if (crepe.editor) {
        const editorKeys = Object.keys(crepe.editor).filter(k => !k.startsWith('_'));
        results.push(`   - editor keys: ${editorKeys.join(', ')}`);
        
        // 检查 ctx
        if (crepe.editor.ctx) {
          results.push('   - editor.ctx: ✅');
          
          // 尝试使用 inspect() 获取信息
          try {
            if (typeof crepe.editor.inspect === 'function') {
              const inspectResult = crepe.editor.inspect();
              results.push(`   - inspect() 返回: ${typeof inspectResult}`);
              if (inspectResult) {
                const inspectKeys = Object.keys(inspectResult).slice(0, 10);
                results.push(`   - inspect keys: ${inspectKeys.join(', ')}`);
              }
            }
          } catch (e) {
            results.push(`   - inspect() 失败: ${e}`);
          }
          
          // 尝试获取 ctx 的所有属性
          try {
            const ctx = crepe.editor.ctx;
            const ctxKeys = [];
            for (const key in ctx) {
              ctxKeys.push(key);
            }
            results.push(`   - ctx 属性: ${ctxKeys.slice(0, 15).join(', ')}`);
            
            // 检查 ctx.get 方法
            if (typeof ctx.get === 'function') {
              results.push('   - ctx.get: ✅ 存在');
              
              // 尝试使用 action 来获取 view
              try {
                let viewFound = false;
                crepe.editor.action((actionCtx: any) => {
                  // 尝试获取 editorView
                  try {
                    // 遍历 actionCtx 找到 get 方法能获取的值
                    // editorViewCtx 的 key 通常包含 'editorView'
                    const testKeys = ['editorView', 'view', 'prosemirror', 'pm'];
                    for (const testKey of testKeys) {
                      try {
                        const val = actionCtx.get(testKey);
                        if (val && val.state && val.dispatch) {
                          results.push(`   - 通过 ctx.get('${testKey}') 获取到 view!`);
                          results.push(`   - view.editable: ${val.editable}`);
                          results.push(`   - view.dragging: ${JSON.stringify(val.dragging)}`);
                          (window as any).__MILKDOWN_VIEW__ = val;
                          (window as any).__MILKDOWN_CTX__ = actionCtx;
                          viewFound = true;
                          break;
                        }
                      } catch (e) {
                        // 这个 key 不存在
                      }
                    }
                    
                    // 如果上面的方法失败，尝试遍历已记录的 slices
                    if (!viewFound && typeof actionCtx.isRecorded === 'function') {
                      // 尝试一些常见的 slice IDs
                      const sliceIds = ['editorView', 'editorViewCtx', 'view', 'editorState', 'proseState'];
                      for (const id of sliceIds) {
                        if (actionCtx.isRecorded({ id })) {
                          try {
                            const val = actionCtx.get({ id });
                            if (val && val.state && val.dispatch) {
                              results.push(`   - 通过 slice id '${id}' 获取到 view!`);
                              (window as any).__MILKDOWN_VIEW__ = val;
                              viewFound = true;
                              break;
                            }
                          } catch (e) {
                            // 忽略
                          }
                        }
                      }
                    }
                  } catch (e) {
                    results.push(`   - action 内部错误: ${e}`);
                  }
                });
                
                if (!viewFound) {
                  results.push('   - 无法通过 action 获取 view');
                }
              } catch (e) {
                results.push(`   - action 调用失败: ${e}`);
              }
            }
          } catch (e) {
            results.push(`   - ctx 检查失败: ${e}`);
          }
        }
      }
      
      // 尝试 getMarkdown 验证 crepe 工作正常
      try {
        const md = crepe.getMarkdown?.();
        results.push(`   - getMarkdown(): ${md ? `"${md.substring(0, 50)}..."` : '(empty)'}`);
      } catch (e) {
        results.push(`   - getMarkdown() 失败: ${e}`);
      }
    } else {
      results.push('❌ window.__MILKDOWN_CREPE__ 不存在');
    }
    
    // 2. 检查 DOM 结构
    const crepeWrapper = document.querySelector('.crepe-editor-wrapper');
    const milkdown = document.querySelector('.milkdown');
    const proseMirror = document.querySelector('.ProseMirror');
    const blockHandle = document.querySelector('.milkdown-block-handle');
    
    results.push('');
    results.push('📦 DOM 结构检查:');
    results.push(`   - .crepe-editor-wrapper: ${crepeWrapper ? '✅' : '❌'}`);
    results.push(`   - .milkdown: ${milkdown ? '✅' : '❌'}`);
    results.push(`   - .ProseMirror: ${proseMirror ? '✅' : '❌'}`);
    results.push(`   - .milkdown-block-handle: ${blockHandle ? '✅' : '❌'}`);
    
    if (blockHandle) {
      const bh = blockHandle as HTMLElement;
      results.push(`   - block handle draggable: ${bh.draggable}`);
      results.push(`   - block handle data-show: ${bh.getAttribute('data-show')}`);
      results.push(`   - block handle pointer-events: ${getComputedStyle(bh).pointerEvents}`);
      results.push(`   - operation-items: ${bh.querySelectorAll('.operation-item').length}`);
    }
    
    // 3. 检查 ProseMirror view 从 DOM
    if (proseMirror) {
      const pmDesc = (proseMirror as any).pmViewDesc;
      if (pmDesc?.view) {
        results.push('');
        results.push('📝 ProseMirror (from DOM):');
        results.push(`   - view exists: ✅`);
        results.push(`   - editable: ${pmDesc.view.editable}`);
        results.push(`   - dragging: ${JSON.stringify(pmDesc.view.dragging)}`);
        
        // 如果全局变量不存在，设置它
        if (!milkdownView) {
          (window as any).__MILKDOWN_VIEW__ = pmDesc.view;
          results.push('   - ⚠️ 已将 view 设置到 window.__MILKDOWN_VIEW__');
        }
      } else {
        results.push('');
        results.push('📝 ProseMirror (from DOM):');
        results.push('   - pmViewDesc: ❌ 不存在');
      }
    }
    
    // 4. 检查 draggable 元素
    const draggableElements = document.querySelectorAll('.crepe-editor-wrapper [draggable="true"]');
    results.push('');
    results.push(`🎯 Draggable 元素: ${draggableElements.length} 个`);
    draggableElements.forEach((el, i) => {
      const tag = el.tagName.toLowerCase();
      const cls = el.className?.toString().split(' ').slice(0, 3).join('.') || '';
      results.push(`   ${i + 1}. ${tag}.${cls}`);
    });
    
    // 添加到日志
    append({
      ts: Date.now(),
      type: 'dragstart',
      phase: 'capture',
      target: 'diagnosis',
      currentTarget: 'diagnosis',
      clientX: 0,
      clientY: 0,
      defaultPrevented: false,
      propagationStopped: false,
      immediatePropagationStopped: false,
      domState: captureDOMState(),
      issues: results,
    });
    
    showGlobalNotification('info', '诊断完成，请查看日志');
  }, [append]);

  const filteredLogs = React.useMemo(() => {
    return logs.filter(log => {
      if (!selectedEventTypes.has(log.type)) return false;
      if (showIssuesOnly && log.issues.length === 0) return false;
      return true;
    });
  }, [logs, selectedEventTypes, showIssuesOnly]);

  const copyAllLogs = React.useCallback(() => {
    const text = JSON.stringify(filteredLogs.map(log => ({
      timestamp: new Date(log.ts).toISOString(),
      ...log,
    })), null, 2);
    
    copyTextToClipboard(text).then(() => {
      showGlobalNotification('success', `已复制 ${filteredLogs.length} 条日志`);
    }).catch(console.error);
  }, [filteredLogs]);

  const copyLog = React.useCallback((log: DragEventLog) => {
    const text = JSON.stringify({
      timestamp: new Date(log.ts).toISOString(),
      ...log,
    }, null, 2);
    
    copyTextToClipboard(text).then(() => {
      showGlobalNotification('success', '日志已复制');
    }).catch(console.error);
  }, []);

  // 诊断分析
  const diagnosis = React.useMemo((): DiagnosisResult[] => {
    const results: DiagnosisResult[] = [];
    
    const dragstartLogs = logs.filter(l => l.type === 'dragstart' && l.target !== 'system');
    const dropLogs = logs.filter(l => l.type === 'drop');
    const dragoverLogs = logs.filter(l => l.type === 'dragover');

    // 检查是否有 dragstart
    if (dragstartLogs.length === 0) {
      results.push({
        category: 'dragstart',
        status: 'warning',
        message: '未检测到 dragstart 事件',
        details: '请尝试拖拽 block handle（六个点图标）',
      });
    } else {
      const lastDragstart = dragstartLogs[dragstartLogs.length - 1];
      if (lastDragstart.defaultPrevented) {
        results.push({
          category: 'dragstart',
          status: 'error',
          message: 'dragstart 被阻止',
          details: '某个事件处理器调用了 preventDefault()，阻止了拖拽开始',
        });
      } else if (!lastDragstart.dataTransfer?.hasData) {
        results.push({
          category: 'dragstart',
          status: 'error',
          message: 'dataTransfer 无数据',
          details: 'BlockService 未正确设置拖拽数据',
        });
      } else {
        results.push({
          category: 'dragstart',
          status: 'ok',
          message: 'dragstart 正常触发',
        });
      }
    }

    // 检查 dragover
    if (dragoverLogs.length > 0) {
      const preventedCount = dragoverLogs.filter(l => l.defaultPrevented).length;
      const ratio = preventedCount / dragoverLogs.length;
      if (ratio < 0.5) {
        results.push({
          category: 'dragover',
          status: 'error',
          message: 'dragover 未正确处理',
          details: `${(ratio * 100).toFixed(0)}% 的 dragover 调用了 preventDefault()，需要接近 100%`,
        });
      } else {
        results.push({
          category: 'dragover',
          status: 'ok',
          message: 'dragover 处理正常',
        });
      }
    }

    // 检查 drop
    if (dropLogs.length === 0 && dragstartLogs.length > 0) {
      results.push({
        category: 'drop',
        status: 'error',
        message: '未检测到 drop 事件',
        details: '拖拽后无法放下，可能是 dragover 未正确处理',
      });
    } else if (dropLogs.length > 0) {
      results.push({
        category: 'drop',
        status: 'ok',
        message: 'drop 事件已触发',
      });
    }

    // 检查 DOM 状态
    const domState = captureDOMState();
    if (!domState?.blockHandleExists) {
      results.push({
        category: 'dom',
        status: 'error',
        message: 'Block handle 不存在',
        details: '检查 CrepeFeature.BlockEdit 是否启用',
      });
    }
    if (domState?.draggableElements === 0) {
      results.push({
        category: 'dom',
        status: 'error',
        message: '无 draggable 元素',
        details: 'BlockProvider 未正确设置 draggable 属性',
      });
    }

    return results;
  }, [logs]);

  const stats = React.useMemo(() => {
    const counts: Record<DragEventType, number> = {} as any;
    const issueCount = logs.filter(l => l.issues.length > 0).length;
    
    logs.forEach(log => {
      counts[log.type] = (counts[log.type] || 0) + 1;
    });
    
    return { counts, issueCount };
  }, [logs]);

  const toggleEventType = (type: DragEventType) => {
    setSelectedEventTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  if (!isActivated) return null;

  return (
    <div className="p-4 space-y-4">
      {/* 标题栏 */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <DotsSixVertical size={20} />
          Crepe 拖放调试
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setIsRecording(!isRecording)}
            className={`px-3 py-1 text-sm rounded flex items-center gap-1 ${
              isRecording ? 'bg-red-500 text-white' : 'bg-gray-200 text-gray-700'
            }`}
          >
            {isRecording ? <Pause size={16} /> : <Play size={16} />}
            {isRecording ? '录制中' : '已暂停'}
          </button>
          <button
            onClick={() => setShowIssuesOnly(!showIssuesOnly)}
            className={`px-3 py-1 text-sm rounded ${showIssuesOnly ? 'bg-orange-500 text-white' : 'bg-gray-200 text-gray-700'}`}
          >
            <Warning size={16} />
          </button>
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`px-3 py-1 text-sm rounded ${autoScroll ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-700'}`}
          >
            自动滚动
          </button>
          <button
            onClick={runDiagnosis}
            className="px-3 py-1 text-sm bg-purple-500 text-white rounded hover:bg-purple-600 flex items-center gap-1"
          >
            <Target size={16} />
            运行诊断
          </button>
          <button
            onClick={copyAllLogs}
            className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600"
            disabled={filteredLogs.length === 0}
          >
            <Clipboard size={16} />
          </button>
          <button
            onClick={clearLogs}
            className="px-3 py-1 text-sm bg-gray-500 text-white rounded hover:bg-gray-600"
          >
            <Trash size={16} />
          </button>
        </div>
      </div>

      {/* 诊断面板 */}
      <div className="border rounded-lg p-3 bg-gradient-to-r from-slate-50 to-blue-50">
        <div className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
          <Eye size={16} />
          实时诊断
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
          {diagnosis.map((d, i) => (
            <div
              key={i}
              className={`p-2 rounded text-xs ${
                d.status === 'ok' ? 'bg-green-100 border-green-300' :
                d.status === 'warning' ? 'bg-yellow-100 border-yellow-300' :
                'bg-red-100 border-red-300'
              } border`}
            >
              <div className="font-medium flex items-center gap-1">
                {d.status === 'ok' ? <CheckCircle size={12} className="text-green-600" /> :
                 d.status === 'warning' ? <Warning size={12} className="text-yellow-600" /> :
                 <XCircle size={12} className="text-red-600" />}
                {d.category}
              </div>
              <div className="text-gray-700 mt-0.5">{d.message}</div>
              {d.details && <div className="text-gray-500 mt-0.5">{d.details}</div>}
            </div>
          ))}
        </div>
      </div>

      {/* 事件类型过滤 */}
      <div className="flex flex-wrap gap-2">
        {(Object.keys(EVENT_COLORS) as DragEventType[]).map(type => (
          <button
            key={type}
            onClick={() => toggleEventType(type)}
            className={`px-2 py-1 text-xs rounded-full transition-all ${
              selectedEventTypes.has(type) ? 'ring-2 ring-offset-1' : 'opacity-50'
            }`}
            style={{ 
              backgroundColor: `${EVENT_COLORS[type]}20`,
              color: EVENT_COLORS[type],
            }}
          >
            {type}: {stats.counts[type] || 0}
          </button>
        ))}
      </div>

      {/* 统计 */}
      <div className="flex items-center gap-4 text-sm">
        <span className="text-gray-500">总计: {logs.length}</span>
        <span className="text-gray-500">已过滤: {filteredLogs.length}</span>
        <span className={`${stats.issueCount > 0 ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
          问题: {stats.issueCount}
        </span>
      </div>

      {/* 日志列表 */}
      <div className="border rounded-lg overflow-hidden">
        <div className="bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700">
          事件日志
        </div>
        <div ref={logContainerRef} className="max-h-[400px] overflow-auto">
          {filteredLogs.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <div className="mb-2">暂无日志</div>
              <div className="text-xs text-gray-400">
                尝试拖拽编辑器中的 block handle（六个点图标）
              </div>
            </div>
          ) : (
            <div className="divide-y text-xs font-mono">
              {filteredLogs.map((log) => {
                const Icon = EVENT_ICONS[log.type];
                const color = EVENT_COLORS[log.type];
                
                return (
                  <div 
                    key={log.id} 
                    className={`p-2 hover:bg-gray-50 ${log.issues.length > 0 ? 'bg-red-50' : ''}`}
                  >
                    <div className="flex items-start gap-2">
                      <Icon size={16} className="mt-0.5 flex-shrink-0" style={{ color }} />
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-gray-500">
                            {new Date(log.ts).toLocaleTimeString(undefined, { 
                              hour12: false,
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                            })}.{String(log.ts % 1000).padStart(3, '0')}
                          </span>
                          <span 
                            className="px-2 py-0.5 rounded font-medium"
                            style={{ backgroundColor: `${color}20`, color }}
                          >
                            {log.type}
                          </span>
                          <span className="text-gray-400">{log.phase}</span>
                          <span className="text-gray-500">({log.clientX}, {log.clientY})</span>
                          {log.defaultPrevented && (
                            <span className="px-1.5 py-0.5 bg-red-100 text-red-700 rounded text-[10px]">
                              prevented
                            </span>
                          )}
                          {log.propagationStopped && (
                            <span className="px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded text-[10px]">
                              stopped
                            </span>
                          )}
                        </div>
                        
                        <div className="text-gray-600 mt-1 truncate" title={log.target}>
                          → {log.target}
                        </div>

                        {log.issues.length > 0 && (
                          <div className="mt-1 space-y-0.5">
                            {log.issues.map((issue, i) => (
                              <div key={i} className="text-red-600">{issue}</div>
                            ))}
                          </div>
                        )}

                        {(log.dataTransfer || log.editorState || log.domState) && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-blue-600 hover:text-blue-800">
                              详细信息
                            </summary>
                            <div className="mt-1 p-2 bg-gray-100 rounded overflow-auto max-h-32">
                              {log.dataTransfer && (
                                <div className="mb-1">
                                  <span className="text-gray-500">dataTransfer:</span>{' '}
                                  {JSON.stringify(log.dataTransfer)}
                                </div>
                              )}
                              {log.editorState && (
                                <div className="mb-1">
                                  <span className="text-gray-500">editorState:</span>{' '}
                                  {JSON.stringify(log.editorState)}
                                </div>
                              )}
                              {log.domState && (
                                <div>
                                  <span className="text-gray-500">domState:</span>{' '}
                                  {JSON.stringify(log.domState)}
                                </div>
                              )}
                            </div>
                          </details>
                        )}
                      </div>

                      <button
                        onClick={() => copyLog(log)}
                        className="p-1 text-gray-400 hover:text-gray-600 flex-shrink-0"
                        title="复制日志"
                      >
                        <Copy size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 使用说明 */}
      <div className="text-xs text-gray-500 p-3 bg-gray-50 rounded-lg">
        <div className="font-medium mb-1">调试步骤：</div>
        <ol className="list-decimal list-inside space-y-0.5">
          <li>在笔记编辑器中输入几行文本</li>
          <li>将鼠标悬停在某一行左侧，等待 block handle（+ 和 ⋮⋮）出现</li>
          <li>按住拖拽手柄（六个点），开始拖动</li>
          <li>观察日志中的 <code className="bg-gray-200 px-1 rounded">dragstart</code> 事件</li>
          <li>拖动到目标位置，观察 <code className="bg-gray-200 px-1 rounded">dragover</code> 是否有 <code className="bg-gray-200 px-1 rounded">prevented</code></li>
          <li>松开鼠标，观察是否有 <code className="bg-gray-200 px-1 rounded">drop</code> 事件</li>
          <li>检查「实时诊断」面板中的问题提示</li>
        </ol>
      </div>
    </div>
  );
};

export default CrepeDragDropDebugPlugin;
