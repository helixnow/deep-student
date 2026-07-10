/**
 * 思维导图视图
 *
 * 入口组件，渲染新的模块化画布
 */

import React from 'react';
import {
  MindMapViewNew,
  type MindMapViewNewHandle,
  type MindMapViewNewProps,
} from '../components/mindmap';

export type MindMapViewHandle = MindMapViewNewHandle;
export type MindMapViewProps = MindMapViewNewProps;

export const MindMapView = React.forwardRef<MindMapViewHandle, MindMapViewProps>(
  function MindMapView(props, ref) {
    return <MindMapViewNew ref={ref} {...props} />;
  },
);
