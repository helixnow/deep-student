/**
 * 给窗口组件补上全局通知宿主（演示壳不渲染 App 壳里的 NotificationContainer）。
 * 只在包的 load() 里动态加载。
 */
import React from 'react';
import type { AppWindowProps } from '@/features/workbench/core/types';
import { NotificationContainer } from '@/components/NotificationContainer';

export function withNotifications(Inner: React.ComponentType<AppWindowProps>): React.FC<AppWindowProps> {
  const WithNotifications: React.FC<AppWindowProps> = (props) =>
    React.createElement(React.Fragment, null, React.createElement(Inner, props), React.createElement(NotificationContainer));
  return WithNotifications;
}
