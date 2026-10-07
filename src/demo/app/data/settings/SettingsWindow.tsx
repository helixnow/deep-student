/**
 * 设置窗口 + 全局通知宿主。演示壳不渲染 App 壳里的 NotificationContainer，
 * 不挂它的话「已保存」「请在桌面版中使用」之类的提示全都看不见。
 * 只经包的 load() 动态导入，可以静态依赖 app 模块。
 */
import React from 'react';
import type { AppWindowProps } from '@/features/workbench/core/types';
import SettingsAppWindow from '@/features/workbench/apps/system/SettingsAppWindow';
import { NotificationContainer } from '@/components/NotificationContainer';

const SettingsWindow: React.FC<AppWindowProps> = (props) => (
  <>
    <SettingsAppWindow {...props} />
    <NotificationContainer />
  </>
);

export default SettingsWindow;
