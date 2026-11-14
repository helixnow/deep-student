/**
 * 停靠聊天输入栏的实际占位高度（含底部 gap 与键盘 inset，CSS 长度串如 `112px`），
 * 供聊天模块之外的悬浮组件（如全局番茄钟药丸）做底部避让。
 *
 * 不写成 document root 上的 CSS 变量：root 的自定义属性被全文档继承，输入栏每变一次高度
 * （挂载测量、换行、键盘弹起）都会让整页所有元素重算样式。改为模块级单例，消费方订阅后
 * 只重渲染自身。
 *
 * 语义沿用原 root 变量：后写入者覆盖，输入栏卸载（或值变化前）清空；未写入时为 null，
 * 消费方自行回退（药丸回退 96px）。
 */
import { useSyncExternalStore } from 'react';

type Listener = () => void;

let dockHeight: string | null = null;
const listeners = new Set<Listener>();

export function getComposerDockHeight(): string | null {
  return dockHeight;
}

export function setComposerDockHeight(value: string | null): void {
  if (value === dockHeight) return;
  dockHeight = value;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useComposerDockHeight(): string | null {
  return useSyncExternalStore(subscribe, getComposerDockHeight, () => null);
}
