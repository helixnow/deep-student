/**
 * 命令事件监听 Hook
 * 用于各模块监听命令面板发出的事件
 */

import { useEffect, useRef } from 'react';

type CommandEventHandler = () => void | Promise<void>;

interface CommandEventHandlers {
  [eventName: string]: CommandEventHandler;
}

/**
 * 监听命令面板事件
 * @param handlers 事件处理器映射
 * @param enabled 是否启用监听
 * 
 * 注意：handlers 对象会被保存到 ref 中，只有 enabled 变化时才会重新绑定。
 * 因此 handlers 中的函数应该访问最新的状态（使用 ref 或函数式更新）。
 */
export function useCommandEvents(
  handlers: CommandEventHandlers,
  enabled: boolean = true
) {
  // 使用 ref 保存 handlers，避免每次渲染都重新绑定监听器
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  
  // 记录已注册的事件名，仅当事件集合变化时重新绑定
  const eventNamesRef = useRef<string[]>([]);
  const eventNames = Object.keys(handlers).sort().join(',');
  
  useEffect(() => {
    if (!enabled) return;
    
    const eventListeners: Array<{ event: string; handler: EventListener }> = [];
    
    for (const eventName of Object.keys(handlersRef.current)) {
      const eventHandler = (e: Event) => {
        const handler = handlersRef.current[eventName];
        if (!handler) return;
        
        try {
          const result = handler();
          if (result instanceof Promise) {
            result.catch(console.error);
          }
        } catch (error: unknown) {
          console.error(`[CommandEvents] 处理事件 ${eventName} 失败:`, error);
        }
      };
      
      window.addEventListener(eventName, eventHandler);
      eventListeners.push({ event: eventName, handler: eventHandler });
    }
    
    eventNamesRef.current = Object.keys(handlersRef.current);
    
    return () => {
      for (const { event, handler } of eventListeners) {
        window.removeEventListener(event, handler);
      }
    };
  }, [enabled, eventNames]); // 仅当 enabled 或事件集合变化时重新绑定
}

/**
 * 创建命令事件派发函数
 * @param eventName 事件名称
 */
export function createCommandEventDispatcher(eventName: string) {
  return (detail?: any) => {
    window.dispatchEvent(new CustomEvent(eventName, { detail }));
  };
}

// ==================== 预定义事件名称常量 ====================

export const COMMAND_EVENTS = {
  // 导航事件
  NAV_BACK: 'COMMAND_PALETTE_NAV_BACK',
  NAV_FORWARD: 'COMMAND_PALETTE_NAV_FORWARD',
  GLOBAL_SEARCH: 'COMMAND_PALETTE_GLOBAL_SEARCH',
  
  // 笔记事件
  NOTES_CREATE_NEW: 'NOTES_CREATE_NEW',
  NOTES_CREATE_FOLDER: 'NOTES_CREATE_FOLDER',
  NOTES_FOCUS_SEARCH: 'NOTES_FOCUS_SEARCH',
  NOTES_FORCE_SAVE: 'NOTES_FORCE_SAVE',
  NOTES_TOGGLE_SIDEBAR: 'NOTES_TOGGLE_SIDEBAR',
  NOTES_TOGGLE_OUTLINE: 'NOTES_TOGGLE_OUTLINE',
  NOTES_EXPORT_CURRENT: 'NOTES_EXPORT_CURRENT',
  NOTES_EXPORT_ALL: 'NOTES_EXPORT_ALL',
  NOTES_INSERT_MATH: 'NOTES_INSERT_MATH',
  NOTES_INSERT_TABLE: 'NOTES_INSERT_TABLE',
  NOTES_INSERT_CODEBLOCK: 'NOTES_INSERT_CODEBLOCK',
  NOTES_INSERT_LINK: 'NOTES_INSERT_LINK',
  NOTES_INSERT_IMAGE: 'NOTES_INSERT_IMAGE',
  AI_CONTINUE_WRITING: 'AI_CONTINUE_WRITING',
  
  // 分析事件
  ANALYSIS_NEW_SESSION: 'ANALYSIS_NEW_SESSION',
  ANALYSIS_SAVE_CONVERSATION: 'ANALYSIS_SAVE_CONVERSATION',
  ANALYSIS_STOP_GENERATION: 'ANALYSIS_STOP_GENERATION',
  ANALYSIS_RETRY_LAST: 'ANALYSIS_RETRY_LAST',
  ANALYSIS_CLEAR_CONVERSATION: 'ANALYSIS_CLEAR_CONVERSATION',
  ANALYSIS_EXTRACT_MEMORY: 'ANALYSIS_EXTRACT_MEMORY',
  
  // 白板事件
  CANVAS_EXPORT: 'CANVAS_EXPORT',
  CANVAS_ZOOM_IN: 'CANVAS_ZOOM_IN',
  CANVAS_ZOOM_OUT: 'CANVAS_ZOOM_OUT',
  CANVAS_FIT_VIEW: 'CANVAS_FIT_VIEW',
  CANVAS_ADD_NODE: 'CANVAS_ADD_NODE',
  CANVAS_ADD_TEXT_NODE: 'CANVAS_ADD_TEXT_NODE',
  CANVAS_ADD_CHAT_NODE: 'CANVAS_ADD_CHAT_NODE',
  CANVAS_ADD_STICKY_NODE: 'CANVAS_ADD_STICKY_NODE',
  CANVAS_UNGROUP_SELECTED: 'CANVAS_UNGROUP_SELECTED',
  
  // Anki 事件
  ANKI_GENERATE_SMART: 'ANKI_GENERATE_SMART',
  ANKI_REGENERATE: 'ANKI_REGENERATE',
  ANKI_SYNC_TO_CONNECT: 'ANKI_SYNC_TO_CONNECT',
  ANKI_EXPORT: 'ANKI_EXPORT',
  ANKI_TOGGLE_BATCH_MODE: 'ANKI_TOGGLE_BATCH_MODE',
  ANKI_ACCEPT_ALL: 'ANKI_ACCEPT_ALL',
  ANKI_RESET: 'ANKI_RESET',
  ANKI_OPEN_SETTINGS: 'ANKI_OPEN_SETTINGS',
  
  IREC_GRAPH_ZOOM_IN: 'IREC_GRAPH_ZOOM_IN',
  IREC_GRAPH_ZOOM_OUT: 'IREC_GRAPH_ZOOM_OUT',
  IREC_GRAPH_FIT_VIEW: 'IREC_GRAPH_FIT_VIEW',
  IREC_GRAPH_OPEN_FILTER: 'IREC_GRAPH_OPEN_FILTER',
  IREC_GRAPH_EXPAND_SELECTED: 'IREC_GRAPH_EXPAND_SELECTED',
  
  // 开发者事件
  DEV_TOGGLE_DEBUG_PANEL: 'DEV_TOGGLE_DEBUG_PANEL',
  DEV_VIEW_DATABASE: 'DEV_VIEW_DATABASE',
  DEV_EXPORT_STATE: 'DEV_EXPORT_STATE',
  DEV_VIEW_PERFORMANCE: 'DEV_VIEW_PERFORMANCE',
  DEV_VIEW_LOGS: 'DEV_VIEW_LOGS',
  
  // 备份/恢复事件
  BACKUP_DATA: 'COMMAND_PALETTE_BACKUP_DATA',
  RESTORE_DATA: 'COMMAND_PALETTE_RESTORE_DATA',
  
  // 设置事件
  SETTINGS_NAVIGATE_TAB: 'SETTINGS_NAVIGATE_TAB',

  // 全局事件
  GLOBAL_SHORTCUT_SETTINGS: 'GLOBAL_SHORTCUT_SETTINGS',
  GLOBAL_QUICK_SEARCH: 'GLOBAL_QUICK_SEARCH',
  GLOBAL_TOGGLE_THEME: 'GLOBAL_TOGGLE_THEME',
  GLOBAL_RELOAD: 'GLOBAL_RELOAD',

  // Chat V2 事件 (chat.commands.ts 中定义的事件)
  CHAT_NEW_SESSION: 'CHAT_NEW_SESSION',
  CHAT_NEW_ANALYSIS_SESSION: 'CHAT_NEW_ANALYSIS_SESSION',
  CHAT_SAVE_SESSION: 'CHAT_SAVE_SESSION',
  CHAT_STOP_GENERATION: 'CHAT_STOP_GENERATION',
  CHAT_RETRY_LAST: 'CHAT_RETRY_LAST',
  CHAT_CLEAR_SESSION: 'CHAT_CLEAR_SESSION',
  CHAT_TOGGLE_RAG: 'CHAT_TOGGLE_RAG',
  CHAT_TOGGLE_GRAPH: 'CHAT_TOGGLE_GRAPH',
  CHAT_TOGGLE_WEB_SEARCH: 'CHAT_TOGGLE_WEB_SEARCH',
  CHAT_TOGGLE_MCP: 'CHAT_TOGGLE_MCP',
  CHAT_TOGGLE_LEARN_MODE: 'CHAT_TOGGLE_LEARN_MODE',
  CHAT_SELECT_MODEL: 'CHAT_SELECT_MODEL',
  CHAT_UPLOAD_IMAGE: 'CHAT_UPLOAD_IMAGE',
  CHAT_UPLOAD_FILE: 'CHAT_UPLOAD_FILE',
  CHAT_TOGGLE_SIDEBAR: 'CHAT_TOGGLE_SIDEBAR',
  CHAT_TOGGLE_PANEL: 'CHAT_TOGGLE_PANEL',
  CHAT_BOOKMARK_SESSION: 'CHAT_BOOKMARK_SESSION',
} as const;

export type CommandEventName = typeof COMMAND_EVENTS[keyof typeof COMMAND_EVENTS];
