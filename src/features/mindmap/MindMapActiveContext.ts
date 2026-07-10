/**
 * 标签页激活状态上下文
 *
 * TabPanelContainer 用 display:none 保活非活跃标签页，组件仍然挂载，
 * 其上注册的全局键盘/剪贴板监听器也仍然存活。store 是全局单例，
 * 多个保活实例会让一次按键触发多次 action（stopPropagation 无法阻止
 * 同一 target 上的其他 listener）。
 *
 * MindMapContentView 通过本 Provider 下发 isActive 与 resourceId，
 * 全局监听器（useMindMapClipboard 挂在 ContentView；useMindMapKeyboard / Ctrl+0 挂在画布）
 * 仅在「实例活跃 且 store 当前加载的就是本实例的文档」时注册。
 * resourceId 校验用于分屏场景：左右面板同时 isActive=true，但单例
 * store 只承载其中一个文档，另一个实例不得响应按键。
 */

import { createContext, useContext } from 'react';
import { useMindMapStore } from './store';

export interface MindMapActiveContextValue {
  isActive: boolean;
  /** 本实例对应的 mindmap 资源 id；null 表示独立使用（不校验） */
  resourceId: string | null;
}

/** 默认 isActive=true、resourceId=null：独立使用（无标签页容器）时不受影响 */
export const MindMapActiveContext = createContext<MindMapActiveContextValue>({
  isActive: true,
  resourceId: null,
});

/** 本实例是否应响应全局键盘/剪贴板事件 */
export function useMindMapIsActive(): boolean {
  const { isActive, resourceId } = useContext(MindMapActiveContext);
  const storeMindmapId = useMindMapStore(s => s.mindmapId);
  if (!isActive) return false;
  if (resourceId !== null && storeMindmapId !== resourceId) return false;
  return true;
}
