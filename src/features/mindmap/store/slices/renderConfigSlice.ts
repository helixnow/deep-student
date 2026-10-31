/**
 * mindmapStore slice：布局/样式/边类型、实测高度、预设、渲染配置与 ReactFlow 实例注册。
 */

import type { LayoutDirection, EdgeType, MindMapRenderConfig } from '../../types';
import { PresetRegistry } from '../../registry';
import { DEFAULT_LAYOUT_CONFIG } from '../../constants';
import { normalizeStyleId } from '../mindmapStoreHelpers';
import type { MindMapSliceCreator } from '../mindmapStoreRuntime';

export const createRenderConfigSlice: MindMapSliceCreator<
  | 'setLayoutId'
  | 'setLayoutDirection'
  | 'setStyleId'
  | 'setEdgeType'
  | 'setMeasuredNodeHeight'
  | 'applyPreset'
  | 'getRenderConfig'
  | 'setReactFlowGetter'
> = (set, get, rt) => {
  const { measuredHeightsQueue, flushMeasuredNodeHeights, applyRenderConfigChange } = rt;

  return {
    // 设置布局
    // D1：布局/样式变更需要标脏并触发保存，否则「只改主题/方向后切走」会丢失渲染配置
    setLayoutId: (layoutId: string) => {
      if (get().layoutId === layoutId) return;
      applyRenderConfigChange((state) => {
        state.layoutId = layoutId;
      });
    },

    // 设置布局方向
    setLayoutDirection: (direction: LayoutDirection) => {
      if (get().layoutDirection === direction) return;
      applyRenderConfigChange((state) => {
        state.layoutDirection = direction;
      });
    },

    // 设置样式主题
    setStyleId: (styleId: string) => {
      const normalizedStyleId = normalizeStyleId(styleId);
      if (get().styleId === normalizedStyleId) return;
      applyRenderConfigChange((state) => {
        state.styleId = normalizedStyleId;
      });
    },

    // 设置边类型
    setEdgeType: (edgeType: EdgeType) => {
      if (get().edgeType === edgeType) return;
      applyRenderConfigChange((state) => {
        state.edgeType = edgeType;
      });
    },

    // 记录节点实测高度
    setMeasuredNodeHeight: (nodeId: string, height: number) => {
      if (!nodeId || !Number.isFinite(height) || height <= 0) {
        return;
      }
      measuredHeightsQueue.set(nodeId, height);
      if (rt.measuredFlushTimer) {
        return;
      }
      rt.measuredFlushTimer = setTimeout(() => {
        rt.measuredFlushTimer = null;
        flushMeasuredNodeHeights();
      }, 16);
    },

    // 应用预设（D1：同 setLayoutId，需持久化渲染配置）
    applyPreset: (presetId: string) => {
      const preset = PresetRegistry.get(presetId);
      if (!preset) return;
      const s = get();
      const nextStyleId = preset.styleId || 'default';
      const nextEdgeType = (preset.edgeType || 'bezier') as EdgeType;
      if (
        s.layoutId === preset.layoutId &&
        s.layoutDirection === preset.layoutDirection &&
        s.styleId === nextStyleId &&
        s.edgeType === nextEdgeType
      ) {
        return;
      }
      applyRenderConfigChange((state) => {
        state.layoutId = preset.layoutId;
        state.layoutDirection = preset.layoutDirection as LayoutDirection;
        state.styleId = nextStyleId;
        state.edgeType = nextEdgeType;
      });
    },

    // 获取当前渲染配置
    getRenderConfig: (): MindMapRenderConfig => {
      const state = get();
      return {
        layoutId: state.layoutId,
        direction: state.layoutDirection,
        styleId: state.styleId,
        edgeType: state.edgeType,
        layoutConfig: { ...DEFAULT_LAYOUT_CONFIG, direction: state.layoutDirection },
      };
    },

    // 注册 ReactFlow 实例（用于图片导出）
    setReactFlowGetter: (getter) => {
      set((state) => {
        state._reactFlowGetter = getter as typeof state._reactFlowGetter;
      });
    },
  };
};
