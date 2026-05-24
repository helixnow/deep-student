import React from 'react';
import { MindMapCanvas } from './MindMapCanvas';

export const MindMapViewNew: React.FC = () => {
  return (
    <div className="w-full h-full relative">
      <MindMapCanvas />
      {/* 结构选择器已移至顶部工具栏 */}
    </div>
  );
};

