import React from 'react';
import { BaseEdge, EdgeProps, getStraightPath } from '@xyflow/react';
import { getEdgeEmphasis, emphasizedEdgeStyle, withEmphasisClass } from './edgeEmphasis';
import './edges.css';

export const StraightEdge: React.FC<EdgeProps> = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
  id,
  data,
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

  const emphasized = getEdgeEmphasis(data);

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      markerStart={markerStart}
      interactionWidth={interactionWidth}
      className={withEmphasisClass('straight-edge mm-tree-edge', emphasized)}
      style={{
        strokeWidth: 1.5,
        stroke: 'var(--mm-edge)',
        strokeLinecap: 'round',
        fill: 'none',
        ...style,
        ...emphasizedEdgeStyle(emphasized),
      }}
    />
  );
};
