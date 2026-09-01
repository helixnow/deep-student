import React from 'react';
import { WorkbenchSettingsSection } from './WorkbenchSettingsSection';

/**
 * 工作台独立设置页（2026-09 自常规页拆出，防止常规页过长）。
 * WorkbenchSettingsSection 基于 SettingsGroup 自带标题。
 */
export const WorkbenchTab: React.FC = () => {
  return (
    <div className="space-y-1 pb-10 text-left ui-fade-in-slow">
      <WorkbenchSettingsSection />
    </div>
  );
};

export default WorkbenchTab;
