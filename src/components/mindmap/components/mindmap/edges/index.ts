/**
 * 边组件聚合导出
 */

import type { EdgeTypes } from '@xyflow/react';
import { CurvedEdge } from './CurvedEdge';
import { StraightEdge } from './StraightEdge';
import { OrthogonalEdge } from './OrthogonalEdge';
import { StepEdge } from './StepEdge';
import { OrgChartEdge, OrgChartHorizontalEdge } from './OrgChartEdge';

// 导出组件
export { CurvedEdge } from './CurvedEdge';
export { StraightEdge } from './StraightEdge';
export { OrthogonalEdge } from './OrthogonalEdge';
export { StepEdge } from './StepEdge';
export { OrgChartEdge, OrgChartHorizontalEdge } from './OrgChartEdge';

// 边类型注册（默认边类型）
export const edgeTypes: EdgeTypes = {
  curved: CurvedEdge,
  bezier: CurvedEdge,
  straight: StraightEdge,
  orthogonal: OrthogonalEdge,
  step: StepEdge,
  orgchart: OrgChartEdge,
  'orgchart-horizontal': OrgChartHorizontalEdge,
};

