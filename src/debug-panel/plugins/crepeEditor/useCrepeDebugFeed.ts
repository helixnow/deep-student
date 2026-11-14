/**
 * Crepe 编辑器调试面板激活期间订阅编辑器上报的 feed，并从全局 error / unhandledrejection 中挑出与编辑器相关的
 * （Prism、milkdown、crepe、ProseMirror），逐条交给 append；激活时先记一条激活日志，停用时全部退订。
 */

import { useEffect } from 'react';
import type { CrepeDebugEventDetail, DebugLog } from './model';
import { crepeDebugFeed } from './report';

export function useCrepeDebugFeed(isActivated: boolean, append: (entry: Omit<DebugLog, 'id'>) => void): void {
  // 监听调试事件
  useEffect(() => {
    if (!isActivated) return;

    const handleDebugEvent = (detail: CrepeDebugEventDetail) => {
      append({
        ...detail,
        ts: Date.now(),
      });
    };

    const unsubscribeDebug = crepeDebugFeed.subscribe(handleDebugEvent);

    // 监听全局错误
    const handleError = (event: ErrorEvent) => {
      if (event.message?.includes('Prism') || 
          event.message?.includes('milkdown') || 
          event.message?.includes('crepe') ||
          event.message?.includes('ProseMirror')) {
        append({
          ts: Date.now(),
          category: 'error',
          level: 'error',
          message: `全局错误捕获: ${event.message}`,
          details: {
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
            error: event.error?.toString(),
          },
        });
      }
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = String(event.reason);
      if (reason.includes('Prism') || 
          reason.includes('milkdown') || 
          reason.includes('crepe') ||
          reason.includes('ProseMirror')) {
        append({
          ts: Date.now(),
          category: 'error',
          level: 'error',
          message: `Promise 拒绝: ${reason}`,
          details: {
            reason: event.reason?.toString(),
            stack: event.reason?.stack,
          },
        });
      }
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    // 初始化日志
    append({
      ts: Date.now(),
      category: 'lifecycle',
      level: 'info',
      message: 'Crepe 编辑器调试插件已激活',
      details: { timestamp: new Date().toISOString() },
    });

    return () => {
      unsubscribeDebug();
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, [isActivated, append]);
}
