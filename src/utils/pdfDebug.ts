/**
 * PDF 渲染调试工具
 * 用于追踪 PDF 组件的渲染行为
 */

import React from 'react';

interface RenderEventDetail {
  timestamp: number;
  component: string;
  reason: string;
  props?: Record<string, any>;
  state?: Record<string, any>;
  duration?: number;
  stack?: string;
}

let isDebugEnabled = false;

// 检查是否启用调试模式
if (typeof window !== 'undefined') {
  try {
    const debugFlag = localStorage.getItem('DSTU_DEBUG_ENABLED');
    isDebugEnabled = debugFlag === 'true' || debugFlag === '1';
  } catch {
    isDebugEnabled = false;
  }
}

/**
 * 发送 PDF 渲染事件到调试面板
 */
export function emitPdfRenderEvent(
  component: string,
  reason: string,
  additionalData?: Partial<Omit<RenderEventDetail, 'timestamp' | 'component' | 'reason'>>
): void {
  if (!isDebugEnabled) return;
  
  const event: RenderEventDetail = {
    timestamp: Date.now(),
    component,
    reason,
    ...additionalData,
  };

  try {
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(
        new CustomEvent('DSTU_PDF_RENDER_EVENT', {
          detail: event,
        })
      );
    }
  } catch (error: unknown) {
    console.warn('[PDF Debug] Failed to emit render event:', error);
  }
}

/**
 * 创建一个性能追踪函数
 */
export function createRenderTracker(component: string) {
  return {
    start: (reason: string) => {
      const startTime = performance.now();
      return {
        end: (additionalData?: Partial<Omit<RenderEventDetail, 'timestamp' | 'component' | 'reason' | 'duration'>>) => {
          const duration = performance.now() - startTime;
          emitPdfRenderEvent(component, reason, {
            ...additionalData,
            duration,
          });
        },
      };
    },
    emit: (reason: string, additionalData?: Partial<Omit<RenderEventDetail, 'timestamp' | 'component' | 'reason'>>) => {
      emitPdfRenderEvent(component, reason, additionalData);
    },
  };
}

/**
 * React Hook 用于追踪组件渲染
 */
export function usePdfRenderTracker(
  component: string,
  props?: Record<string, any>
): void {
  // 渲染计数器
  const renderCountRef = React.useRef(0);
  const prevPropsRef = React.useRef<Record<string, any> | undefined>(undefined);
  const mountTimeRef = React.useRef(Date.now());
  
  renderCountRef.current += 1;
  const currentRenderCount = renderCountRef.current;

  // 捕获调用栈（仅在开发环境且调试启用时）
  let stack: string | undefined;
  if (isDebugEnabled && process.env.NODE_ENV === 'development') {
    try {
      const error = new Error();
      stack = error.stack?.split('\n').slice(2, 8).join('\n');
    } catch {
      stack = undefined;
    }
  }

  // 检测渲染原因
  let reason = 'initial-mount';
  const changedProps: Record<string, { prev: any; current: any }> = {};

  if (prevPropsRef.current && props) {
    const changes: string[] = [];
    const allKeys = new Set([
      ...Object.keys(prevPropsRef.current),
      ...Object.keys(props),
    ]);

    for (const key of allKeys) {
      const prevValue = prevPropsRef.current[key];
      const currentValue = props[key];
      
      if (prevValue !== currentValue) {
        changes.push(key);
        changedProps[key] = {
          prev: simplifyValue(prevValue),
          current: simplifyValue(currentValue),
        };
      }
    }

    if (changes.length > 0) {
      reason = `props-change: ${changes.join(', ')}`;
    } else {
      reason = 'state-change-or-parent-rerender';
    }
  } else if (currentRenderCount > 1) {
    reason = 'rerender-without-props-change';
  }

  // 发送实时渲染事件（不等待 useEffect）
  if (isDebugEnabled) {
    const renderStartTime = performance.now();
    
    // 立即发送渲染开始事件
    emitPdfRenderEvent(component, `${reason} (render #${currentRenderCount})`, {
      props: props ? simplifyProps(props) : undefined,
      state: {
        renderCount: currentRenderCount,
        timeSinceMount: Date.now() - mountTimeRef.current,
        changedProps: Object.keys(changedProps).length > 0 ? changedProps : undefined,
      },
      stack,
    });

    // 在下一帧测量渲染耗时
    requestAnimationFrame(() => {
      const duration = performance.now() - renderStartTime;
      if (duration > 5) { // 只记录超过5ms的渲染
        emitPdfRenderEvent(component, `${reason} (completed, render #${currentRenderCount})`, {
          duration,
          state: { renderCount: currentRenderCount },
        });
      }
    });
  }

  prevPropsRef.current = props;

  // 挂载和卸载事件
  React.useEffect(() => {
    if (isDebugEnabled) {
      if (currentRenderCount === 1) {
        emitPdfRenderEvent(component, 'component-mounted', {
          state: { renderCount: currentRenderCount },
        });
      }
    }

    return () => {
      if (isDebugEnabled) {
        emitPdfRenderEvent(component, 'component-will-unmount', {
          state: {
            totalRenders: renderCountRef.current,
            lifetimeMs: Date.now() - mountTimeRef.current,
          },
        });
      }
    };
  }, []);
}

// 简化 props 值，避免大对象
function simplifyProps(props: Record<string, any>): Record<string, any> {
  return Object.keys(props).reduce((acc, key) => {
    acc[key] = simplifyValue(props[key]);
    return acc;
  }, {} as Record<string, any>);
}

function simplifyValue(value: any): any {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  } else if (value === null || value === undefined) {
    return value;
  } else if (Array.isArray(value)) {
    return `Array(${value.length})`;
  } else if (value instanceof Set) {
    return `Set(${value.size})`;
  } else if (value instanceof Map) {
    return `Map(${value.size})`;
  } else if (typeof value === 'function') {
    return `Function(${value.name || 'anonymous'})`;
  } else if (typeof value === 'object') {
    return `Object(${Object.keys(value).length} keys)`;
  } else {
    return typeof value;
  }
}
