import React from 'react';
import { MindMapCanvas, type MindMapCanvasHandle, type MindMapCanvasProps } from './MindMapCanvas';

export type MindMapViewNewHandle = MindMapCanvasHandle;
export type MindMapViewNewProps = MindMapCanvasProps;

export const MindMapViewNew = React.forwardRef<MindMapViewNewHandle, MindMapViewNewProps>(
  function MindMapViewNew(props, ref) {
    return (
      <div className="w-full h-full relative">
        <MindMapCanvas ref={ref} {...props} />
        {/* 结构选择器已移至顶部工具栏 */}
      </div>
    );
  },
);
