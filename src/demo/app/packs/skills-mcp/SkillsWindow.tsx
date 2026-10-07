/**
 * 技能管理窗口 + 全局通知宿主（演示壳不渲染 App 壳里的 NotificationContainer）。
 * 只经包的 load() 动态导入，可以静态依赖 app 模块。
 */
import React from 'react';
import type { AppWindowProps } from '@/features/workbench/core/types';
import SkillsAppWindow from '@/features/workbench/apps/system/SkillsAppWindow';
import { NotificationContainer } from '@/components/NotificationContainer';

const SkillsWindow: React.FC<AppWindowProps> = (props) => (
  <>
    <SkillsAppWindow {...props} />
    <NotificationContainer />
  </>
);

export default SkillsWindow;
