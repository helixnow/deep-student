import React, { useRef } from 'react';
import { MindMapCanvas, type MindMapCanvasHandle, type MindMapCanvasProps } from './MindMapCanvas';
import { MindMapGhostProposalLayer } from '../agent/MindMapGhostProposalLayer';

export type MindMapViewNewHandle = MindMapCanvasHandle;
export type MindMapViewNewProps = MindMapCanvasProps;

export const MindMapViewNew = React.forwardRef<MindMapViewNewHandle, MindMapViewNewProps>(
  function MindMapViewNew(props, ref) {
    const hostRef = useRef<HTMLDivElement>(null);
    return (
      <div ref={hostRef} className="w-full h-full relative">
        <MindMapCanvas ref={ref} {...props} />
        <MindMapGhostProposalLayer hostRef={hostRef} />
      </div>
    );
  },
);
