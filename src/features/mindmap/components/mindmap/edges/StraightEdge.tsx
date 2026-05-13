import React from 'react';
import { BaseEdge, EdgeProps, getStraightPath } from '@xyflow/react';

export const StraightEdge: React.FC<EdgeProps> = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
  id,
  markerEnd,
  markerStart,
  interactionWidth,
  style,
}) => {
  const [edgePath] = getStraightPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      markerStart={markerStart}
      interactionWidth={interactionWidth}
      className="straight-edge"
      style={{
        strokeWidth: 1.5,
        stroke: 'var(--mm-edge)',
        strokeLinecap: 'round',
        fill: 'none',
        ...style,
      }}
    />
  );
};
