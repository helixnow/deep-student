/**
 * 文档状态管理
 * 
 * 职责：管理思维导图文档的节点树 CRUD 操作
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { MindMapDocument, MindMapNode, NodeId, UpdateNodeParams } from '../types';
import {
  createNode,
  createRootNode,
  findNodeById,
  findNodeWithParent,
  updateNode as updateNodeInTree,
  deleteNode as deleteNodeFromTree,
  addNode as addNodeToTree,
  moveNode as moveNodeInTree,
  indentNode as indentNodeInTree,
  outdentNode as outdentNodeInTree,
  toggleCollapse as toggleCollapseInTree,
  expandToNode as expandToNodeInTree,
  collapseAll as collapseAllInTree,
  expandAll as expandAllInTree,
} from '../utils/node';

/** 文档状态 */
export interface DocumentState {
  /** 当前文档 */
  document: MindMapDocument | null;
  /** 资源 ID */
  resourceId: string | null;
  /** 是否有未保存的修改 */
  isDirty: boolean;
  /** 是否正在加载 */
  isLoading: boolean;
  /** 错误信息 */
  error: string | null;
}

/** 文档操作 */
export interface DocumentActions {
  // 文档管理
  setDocument: (doc: MindMapDocument | null, resourceId?: string) => void;
  createNewDocument: (title?: string) => void;
  setDirty: (dirty: boolean) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  
  // 节点 CRUD
  updateNode: (nodeId: NodeId, updates: UpdateNodeParams) => void;
  addNode: (parentId: NodeId, index?: number, text?: string) => NodeId;
  deleteNode: (nodeId: NodeId) => void;
  moveNode: (nodeId: NodeId, newParentId: NodeId, index?: number) => void;
  
  // 层级操作
  indentNode: (nodeId: NodeId) => void;
  outdentNode: (nodeId: NodeId) => void;
  
  // 折叠操作
  toggleCollapse: (nodeId: NodeId) => void;
  expandToNode: (nodeId: NodeId) => void;
  collapseAll: () => void;
  expandAll: () => void;
  
  // 辅助方法
  getNode: (nodeId: NodeId) => MindMapNode | null;
  getNodeWithParent: (nodeId: NodeId) => ReturnType<typeof findNodeWithParent>;
}

export type DocumentStore = DocumentState & DocumentActions;

/** 创建文档 Store */
export const useDocumentStore = create<DocumentStore>()(
  immer((set, get) => ({
    // 初始状态
    document: null,
    resourceId: null,
    isDirty: false,
    isLoading: false,
    error: null,

    // 文档管理
    setDocument: (doc, resourceId) => {
      set(state => {
        state.document = doc;
        state.resourceId = resourceId ?? state.resourceId;
        state.isDirty = false;
        state.error = null;
      });
    },

    createNewDocument: (title = '中心主题') => {
      const root = createRootNode(title);
      const doc: MindMapDocument = {
        version: '1.0',
        root,
        meta: {
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      set(state => {
        state.document = doc;
        state.isDirty = true;
      });
    },

    setDirty: (dirty) => {
      set(state => {
        state.isDirty = dirty;
      });
    },

    setLoading: (loading) => {
      set(state => {
        state.isLoading = loading;
      });
    },

    setError: (error) => {
      set(state => {
        state.error = error;
      });
    },

    // 节点 CRUD
    updateNode: (nodeId, updates) => {
      set(state => {
        if (!state.document) return;
        state.document.root = updateNodeInTree(state.document.root, nodeId, updates);
        state.document.meta.updatedAt = new Date().toISOString();
        state.isDirty = true;
      });
    },

    addNode: (parentId, index = -1, text = '') => {
      let newNodeId = '';
      set(state => {
        if (!state.document) return;
        const result = addNodeToTree(state.document.root, parentId, index, text);
        state.document.root = result.tree;
        state.document.meta.updatedAt = new Date().toISOString();
        state.isDirty = true;
        newNodeId = result.newNodeId;
      });
      return newNodeId;
    },

    deleteNode: (nodeId) => {
      set(state => {
        if (!state.document) return;
        // 不能删除根节点
        if (state.document.root.id === nodeId) return;
        state.document.root = deleteNodeFromTree(state.document.root, nodeId);
        state.document.meta.updatedAt = new Date().toISOString();
        state.isDirty = true;
      });
    },

    moveNode: (nodeId, newParentId, index = -1) => {
      set(state => {
        if (!state.document) return;
        state.document.root = moveNodeInTree(state.document.root, nodeId, newParentId, index);
        state.document.meta.updatedAt = new Date().toISOString();
        state.isDirty = true;
      });
    },

    // 层级操作
    indentNode: (nodeId) => {
      set(state => {
        if (!state.document) return;
        state.document.root = indentNodeInTree(state.document.root, nodeId);
        state.document.meta.updatedAt = new Date().toISOString();
        state.isDirty = true;
      });
    },

    outdentNode: (nodeId) => {
      set(state => {
        if (!state.document) return;
        state.document.root = outdentNodeInTree(state.document.root, nodeId);
        state.document.meta.updatedAt = new Date().toISOString();
        state.isDirty = true;
      });
    },

    // 折叠操作
    toggleCollapse: (nodeId) => {
      set(state => {
        if (!state.document) return;
        state.document.root = toggleCollapseInTree(state.document.root, nodeId);
        state.isDirty = true;
      });
    },

    expandToNode: (nodeId) => {
      set(state => {
        if (!state.document) return;
        state.document.root = expandToNodeInTree(state.document.root, nodeId);
        state.isDirty = true;
      });
    },

    collapseAll: () => {
      set(state => {
        if (!state.document) return;
        state.document.root = collapseAllInTree(state.document.root);
        state.isDirty = true;
      });
    },

    expandAll: () => {
      set(state => {
        if (!state.document) return;
        state.document.root = expandAllInTree(state.document.root);
        state.isDirty = true;
      });
    },

    // 辅助方法
    getNode: (nodeId) => {
      const { document } = get();
      if (!document) return null;
      return findNodeById(document.root, nodeId);
    },

    getNodeWithParent: (nodeId) => {
      const { document } = get();
      if (!document) return null;
      return findNodeWithParent(document.root, nodeId);
    },
  }))
);

