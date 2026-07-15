import {
  getMindMapStoreForInstance,
  type MindMapStoreApi,
} from '@/features/mindmap/store/mindmapStore';
import type { MindMapNode } from '@/features/mindmap/types';
import type {
  ActivationContext,
  ActivationHandlerResult,
  AgentAffordanceNode,
  AgentEntitySummary,
  AppAgentManifest,
} from '../../core/types';
import {
  NO_ARGS_SCHEMA,
  actionArgs,
  executeActivation,
  objectSchema,
  rejectMismatchedTarget,
  shortLabel,
  stableAgentRef,
  stableRevision,
} from '../agentManifestUtils';

const MAX_OBSERVED_NODES = 80;
const MAX_OBSERVED_DEPTH = 6;
const ALL_ACTIONS = [
  'focusNode',
  'setView',
  'search',
  'nextSearchResult',
  'previousSearchResult',
  'clearSearch',
] as const;

function nodeRef(id: string): string {
  return stableAgentRef('mindmap', 'node', id);
}

function getStore(windowId: string, resourceId: string | null): MindMapStoreApi | undefined {
  return resourceId ? getMindMapStoreForInstance(windowId, resourceId) : undefined;
}

export function buildMindmapAffordances(root: MindMapNode, selectedIds: ReadonlySet<string>) {
  const entities: AgentEntitySummary[] = [];
  let count = 0;
  let truncated = false;

  const visit = (node: MindMapNode, depth = 1): AgentAffordanceNode | null => {
    if (count >= MAX_OBSERVED_NODES) {
      truncated = true;
      return null;
    }
    count += 1;
    const ref = nodeRef(node.id);
    const label = shortLabel(node.text) ?? '未命名节点';
    if (depth >= MAX_OBSERVED_DEPTH && node.children.length > 0) truncated = true;
    const children = depth < MAX_OBSERVED_DEPTH
      ? node.children
          .map((child) => visit(child, depth + 1))
          .filter((child): child is AgentAffordanceNode => child !== null)
      : [];
    entities.push({
      ref,
      kind: 'mindmap-node',
      label,
      actions: ['focusNode'],
      state: {
        childCount: node.children.length,
        completed: Boolean(node.completed),
      },
    });
    return {
      ref,
      kind: 'mindmap-node',
      label,
      actions: ['focusNode'],
      selected: selectedIds.has(node.id),
      value: { nodeId: node.id },
      ...(children.length > 0 ? { children } : {}),
    };
  };

  return { root: visit(root), entities, count, truncated };
}

export function createMindmapAgentManifest(
  activation: (
    ctx: ActivationContext,
  ) => ActivationHandlerResult | Promise<ActivationHandlerResult>,
): AppAgentManifest {
  return {
    version: 2,
    description: '观察并导航思维导图节点、视图与搜索结果；内容写入仍走 mindmap 领域工具。',
    capabilities: [
      {
        name: 'focusNode',
        description: '聚焦并展开到指定导图节点。',
        inputSchema: objectSchema({ nodeId: { type: 'string', minLength: 1 } }, ['nodeId']),
        risk: 'low',
        mutates: true,
        reversible: false,
        idempotent: true,
        targetKinds: ['mindmap-node'],
      },
      {
        name: 'setView',
        description: '在大纲和画布视图间切换。',
        inputSchema: objectSchema({ view: { type: 'string', enum: ['outline', 'mindmap'] } }, ['view']),
        risk: 'low',
        mutates: true,
        reversible: true,
        idempotent: true,
      },
      {
        name: 'search',
        description: '在当前导图中搜索节点文本。',
        inputSchema: objectSchema({ query: { type: 'string', maxLength: 500 } }, ['query']),
        risk: 'read',
        mutates: true,
        reversible: true,
        idempotent: true,
      },
      {
        name: 'nextSearchResult',
        description: '聚焦下一个搜索结果。',
        inputSchema: NO_ARGS_SCHEMA,
        risk: 'read',
        mutates: true,
        reversible: false,
        idempotent: false,
      },
      {
        name: 'previousSearchResult',
        description: '聚焦上一个搜索结果。',
        inputSchema: NO_ARGS_SCHEMA,
        risk: 'read',
        mutates: true,
        reversible: false,
        idempotent: false,
      },
      {
        name: 'clearSearch',
        description: '清除导图搜索条件。',
        inputSchema: NO_ARGS_SCHEMA,
        risk: 'read',
        mutates: true,
        reversible: true,
        idempotent: true,
      },
    ],
    observe(ctx) {
      const store = getStore(ctx.windowId, ctx.instanceKey);
      if (!store || store.getState().mindmapId !== ctx.instanceKey) {
        return {
          revision: stableRevision(ctx.instanceKey, 'not-ready'),
          busy: true,
          availableActions: [],
          state: { resourceId: ctx.instanceKey, ready: false },
        };
      }
      const state = store.getState();
      const selectedIds = new Set([
        ...state.selection,
        ...(state.focusedNodeId ? [state.focusedNodeId] : []),
      ]);
      const observed = buildMindmapAffordances(state.document.root, selectedIds);
      const selection = [...selectedIds].map(nodeRef);
      return {
        revision: stableRevision(
          ctx.instanceKey,
          state._documentVersion,
          state.currentView,
          state.focusedNodeId,
          state.selection,
          state.searchQuery,
          state.currentSearchIndex,
        ),
        route: `mindmap/${ctx.instanceKey}`,
        mode: state.currentView,
        busy: state.isSaving || state.isExporting,
        selection,
        availableActions: ALL_ACTIONS.filter((action) => {
          if (action === 'nextSearchResult' || action === 'previousSearchResult') {
            return state.searchResults.length > 1;
          }
          if (action === 'clearSearch') return Boolean(state.searchQuery);
          return true;
        }),
        entities: observed.entities,
        affordances: observed.root ? [observed.root] : [],
        state: {
          resourceId: ctx.instanceKey,
          ready: true,
          dirty: state.isDirty,
          saving: state.isSaving,
          nodeCount: observed.count,
          entitiesTruncated: observed.truncated,
          focusedNodeId: state.focusedNodeId,
          editingNodeId: state.editingNodeId,
          currentView: state.currentView,
          viewRootId: state.viewRootId,
          searchQuery: state.searchQuery,
          searchResultCount: state.searchResults.length,
          currentSearchIndex: state.currentSearchIndex,
        },
      };
    },
    async execute(ctx, action) {
      const requestedArgs = actionArgs(action);
      if (action.name === 'focusNode' && typeof requestedArgs.nodeId === 'string') {
        const mismatch = rejectMismatchedTarget(action, nodeRef(requestedArgs.nodeId));
        if (mismatch) return mismatch;
      }
      const before = getStore(ctx.windowId, ctx.instanceKey)?.getState();
      let expectedSearchIndex: number | null = null;
      if (action.name === 'nextSearchResult' || action.name === 'previousSearchResult') {
        const count = before?.searchResults.length ?? 0;
        if (count <= 1) {
          return {
            handled: false,
            changed: false,
            code: 'ACTION_UNAVAILABLE',
            hint: count === 0 ? '当前没有导图搜索结果' : '只有一个搜索结果，无法移动焦点',
          };
        }
        expectedSearchIndex = action.name === 'nextSearchResult'
          ? ((before!.currentSearchIndex + 1) % count)
          : ((before!.currentSearchIndex - 1 + count) % count);
      }
      const beforeSnapshot = before ? {
        currentView: before.currentView,
        focusedNodeId: before.focusedNodeId,
        searchQuery: before.searchQuery,
        currentSearchIndex: before.currentSearchIndex,
      } : null;
      const result = await executeActivation(activation, ctx, action);
      if (!result.handled) return result;
      const after = getStore(ctx.windowId, ctx.instanceKey)?.getState();
      result.changed = Boolean(beforeSnapshot && after && stableRevision(beforeSnapshot) !== stableRevision({
        currentView: after.currentView,
        focusedNodeId: after.focusedNodeId,
        searchQuery: after.searchQuery,
        currentSearchIndex: after.currentSearchIndex,
      }));
      if (!result.changed) {
        return {
          handled: false,
          changed: false,
          code: 'ACTION_UNAVAILABLE',
          hint: `${action.name} 未改变导图状态`,
        };
      }
      result.acknowledged = true;
      const args = requestedArgs;
      if (action.name === 'focusNode' && typeof args.nodeId === 'string') {
        result.entityRefs = [nodeRef(args.nodeId)];
        result.postconditions = [{ kind: 'selection_includes', ref: nodeRef(args.nodeId) }];
      } else if (action.name === 'setView' && before) {
        const next = args.view;
        result.postconditions = [{ kind: 'state_equals', path: 'currentView', value: String(next ?? '') }];
        if (result.changed) {
          result.undo = {
            inverse: {
              name: 'setView',
              args: { view: before.currentView },
              expect: [{ kind: 'state_equals', path: 'currentView', value: before.currentView }],
            },
            label: '恢复导图视图',
          };
        }
      } else if ((action.name === 'search' || action.name === 'clearSearch') && before) {
        const nextQuery = action.name === 'search' && typeof args.query === 'string' ? args.query : '';
        result.postconditions = [{ kind: 'state_equals', path: 'searchQuery', value: nextQuery }];
        if (result.changed) {
          result.undo = {
            inverse: before.searchQuery
              ? {
                  name: 'search',
                  args: { query: before.searchQuery },
                  expect: [{ kind: 'state_equals', path: 'searchQuery', value: before.searchQuery }],
                }
              : {
                  name: 'clearSearch',
                  expect: [{ kind: 'state_equals', path: 'searchQuery', value: '' }],
                },
            label: '恢复导图搜索',
          };
        }
      } else if (expectedSearchIndex != null) {
        result.postconditions = [{ kind: 'state_equals', path: 'currentSearchIndex', value: expectedSearchIndex }];
      }
      return result;
    },
  };
}
