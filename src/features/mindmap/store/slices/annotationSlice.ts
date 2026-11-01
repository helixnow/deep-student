/**
 * mindmapStore slice：节点资源引用与跨分支关联线。
 */

import { nanoid } from 'nanoid';
import type { MindMapNodeRef, MindMapAssociation } from '../../types';
import { findNodeById } from '../../utils/node/find';
import { findAssociationPair } from '../mindmapStoreHelpers';
import type { MindMapSliceCreator } from '../mindmapStoreRuntime';

export const createAnnotationSlice: MindMapSliceCreator<
  | 'addNodeRef'
  | 'removeNodeRef'
  | 'addAssociation'
  | 'updateAssociationLabel'
  | 'removeAssociation'
> = (set, get, rt) => {
  const { applyMutation } = rt;

  return {
    // 节点资源引用
    addNodeRef: (nodeId: string, ref: MindMapNodeRef) => {
      applyMutation((state) => {
        const node = findNodeById(state.document.root, nodeId);
        if (!node) return;
        if (!node.refs) {
          node.refs = [];
        }
        // 去重：同一 sourceId 不重复添加
        if (node.refs.some((r) => r.sourceId === ref.sourceId)) return;
        node.refs.push(ref);
      });
    },

    removeNodeRef: (nodeId: string, sourceId: string) => {
      applyMutation((state) => {
        const node = findNodeById(state.document.root, nodeId);
        if (!node?.refs) return;
        node.refs = node.refs.filter((r) => r.sourceId !== sourceId);
        if (node.refs.length === 0) {
          delete node.refs;
        }
      });
    },

    // 跨分支关联线
    addAssociation: (source: string, target: string, label?: string) => {
      if (!source || !target || source === target) return null;
      const { document } = get();
      if (!findNodeById(document.root, source) || !findNodeById(document.root, target)) {
        return null;
      }
      if (findAssociationPair(document.associations, source, target)) {
        return null;
      }

      const id = `assoc_${nanoid(10)}`;
      const association: MindMapAssociation = {
        id,
        source,
        target,
        ...(label != null && label !== '' ? { label } : {}),
      };

      applyMutation((state) => {
        if (!state.document.associations) {
          state.document.associations = [];
        }
        state.document.associations.push(association);
      });

      return id;
    },

    updateAssociationLabel: (id: string, label: string) => {
      const { document } = get();
      const existing = document.associations?.find((a) => a.id === id);
      if (!existing) return;

      applyMutation((state) => {
        const assoc = state.document.associations?.find((a) => a.id === id);
        if (!assoc) return;
        const trimmed = label.trim();
        if (trimmed) {
          assoc.label = trimmed;
        } else {
          delete assoc.label;
        }
      });
    },

    removeAssociation: (id: string) => {
      const { document } = get();
      if (!document.associations?.some((a) => a.id === id)) return;

      applyMutation((state) => {
        if (!state.document.associations) return;
        state.document.associations = state.document.associations.filter((a) => a.id !== id);
        if (state.document.associations.length === 0) {
          delete state.document.associations;
        }
      });
    },
  };
};
