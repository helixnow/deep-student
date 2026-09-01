import React from 'react';
import { MemorySettingsSection } from './MemorySettingsSection';

/**
 * 记忆独立设置页（2026-09 自常规页拆出，防止常规页过长）。
 * MemorySettingsSection 在非 embedded 模式下自带 GroupTitle。
 */
export const MemoryTab: React.FC = () => {
  return (
    <div className="space-y-1 pb-10 text-left ui-fade-in-slow">
      <MemorySettingsSection />
    </div>
  );
};

export default MemoryTab;
