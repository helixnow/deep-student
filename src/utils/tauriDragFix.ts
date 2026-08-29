/**
 * Tauri 环境下的拖拽修复工具
 *
 * Tauri WebView 可能会拦截拖拽事件，导致网页内的拖拽功能失效
 * 这个模块提供了修复方案
 *
 * 注：原 react-complex-tree（.rct-tree*）专项规则已移除——DndFileTree 于 2026-08
 * 零挂载删除后，src/ 中不再有任何 rct-* 类；workbench 笔记树（nwt-*）为独立实现，
 * 不依赖本注入。当前模块暂无调用方，保留通用规则以备 Tauri 拖拽问题复现时接入。
 */

import React from 'react';

// 检测是否在 Tauri 环境中
export const isTauri = (): boolean => {
  return typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__ !== undefined;
};

/**
 * 禁用 Tauri 窗口拖拽，启用网页拖拽
 * 在需要使用网页拖拽的组件中调用
 */
export const enableWebDrag = () => {
  if (!isTauri()) return;

  // 为整个文档添加样式，禁用窗口拖拽
  const style = document.createElement('style');
  style.id = 'tauri-drag-fix';
  style.innerHTML = `
    /* 禁用 Tauri 窗口拖拽 */
    html, body {
      -webkit-app-region: no-drag !important;
      -webkit-user-select: auto !important;
      user-select: auto !important;
    }
    
    /* 确保所有元素可以正常拖拽 */
    * {
      -webkit-app-region: no-drag !important;
    }
    
    /* 允许 draggable 元素拖拽 */
    [draggable="true"] {
      -webkit-user-drag: element !important;
      user-drag: element !important;
      cursor: move !important;
    }
  `;
  
  // 移除可能存在的旧样式
  const oldStyle = document.getElementById('tauri-drag-fix');
  if (oldStyle) {
    oldStyle.remove();
  }
  
  document.head.appendChild(style);
  
  // 不在此处全局拦截 drag 事件，避免影响局部逻辑
};

/**
 * 恢复 Tauri 窗口拖拽
 * 在不需要网页拖拽时调用
 */
export const disableWebDrag = () => {
  const style = document.getElementById('tauri-drag-fix');
  if (style) {
    style.remove();
  }
};

/**
 * React Hook: 在组件中启用网页拖拽
 */
export const useTauriDragFix = () => {
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    enableWebDrag();

    return () => {
      // 组件卸载时可选择是否恢复
      // disableWebDrag();
    };
  }, []);
};
