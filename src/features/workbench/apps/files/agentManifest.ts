import { useFinderStore } from '@/features/learning-hub/stores/finderStore';
import type {
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
import { handleFilesActivation } from './filesActivation';

const ALL_ACTIONS = [
  'openFolder', 'reveal', 'goBack', 'goForward', 'goUp', 'search',
  'setViewMode', 'setSorting', 'select', 'selectAll', 'clearSelection', 'refresh',
] as const;
let refreshSequence = 0;

function itemRef(type: string, id: string): string {
  return stableAgentRef('files', type === 'folder' ? 'folder' : 'resource', id);
}

export const filesAgentManifest: AppAgentManifest = {
  version: 2,
  description: '观察文件夹、资源与选择状态并进行安全导航；资源写入仍走 DSTU 领域工具。',
  capabilities: [
    {
      name: 'openFolder', description: '进入指定文件夹。',
      inputSchema: objectSchema({ folderId: { type: 'string', minLength: 1 } }, ['folderId']),
      risk: 'read', mutates: true, reversible: false, idempotent: true,
      targetKinds: ['files-folder'],
    },
    {
      name: 'reveal', description: '打开资源所在位置并选中资源。',
      inputSchema: objectSchema({ resourceId: { type: 'string', minLength: 1 } }, ['resourceId']),
      risk: 'read', mutates: true, reversible: false, idempotent: true,
      targetKinds: ['files-resource'],
    },
    { name: 'goBack', description: '返回上一浏览位置。', inputSchema: NO_ARGS_SCHEMA, risk: 'read', mutates: true, reversible: false, idempotent: false },
    { name: 'goForward', description: '前往下一浏览位置。', inputSchema: NO_ARGS_SCHEMA, risk: 'read', mutates: true, reversible: false, idempotent: false },
    { name: 'goUp', description: '进入当前文件夹的上一级。', inputSchema: NO_ARGS_SCHEMA, risk: 'read', mutates: true, reversible: false, idempotent: false },
    {
      name: 'search', description: '搜索文件和学习资源；空字符串清除搜索。',
      inputSchema: objectSchema({ query: { type: 'string', maxLength: 500 } }, ['query']),
      risk: 'read', mutates: true, reversible: true, idempotent: true,
    },
    {
      name: 'setViewMode', description: '切换网格或列表视图。',
      inputSchema: objectSchema({ mode: { type: 'string', enum: ['grid', 'list'] } }, ['mode']),
      risk: 'low', mutates: true, reversible: true, idempotent: true,
    },
    {
      name: 'setSorting', description: '设置资源排序字段和方向。',
      inputSchema: objectSchema({
        sortBy: { type: 'string', enum: ['name', 'updatedAt', 'createdAt', 'type'] },
        sortOrder: { type: 'string', enum: ['asc', 'desc'] },
      }, ['sortBy']),
      risk: 'low', mutates: true, reversible: true, idempotent: true,
    },
    {
      name: 'select', description: '选择一个可见资源或文件夹。',
      inputSchema: objectSchema({ resourceId: { type: 'string', minLength: 1 } }, ['resourceId']),
      risk: 'low', mutates: true, reversible: false, idempotent: true,
      targetKinds: ['files-folder', 'files-resource'],
    },
    { name: 'selectAll', description: '选择当前结果中的全部项目。', inputSchema: NO_ARGS_SCHEMA, risk: 'low', mutates: true, reversible: false, idempotent: true },
    { name: 'clearSelection', description: '清除资源选择。', inputSchema: NO_ARGS_SCHEMA, risk: 'low', mutates: true, reversible: false, idempotent: true },
    { name: 'refresh', description: '刷新当前资源列表。', inputSchema: NO_ARGS_SCHEMA, risk: 'read', mutates: true, reversible: false, idempotent: true },
  ],
  observe() {
    const state = useFinderStore.getState();
    const visibleItems = state.items.slice(0, 80);
    const entities: AgentEntitySummary[] = visibleItems.map((item) => ({
      ref: itemRef(item.type, item.id),
      kind: item.type === 'folder' ? 'files-folder' : 'files-resource',
      label: shortLabel(item.name) ?? item.id,
      description: item.type,
      actions: item.type === 'folder' ? ['openFolder', 'select'] : ['reveal', 'select'],
      state: {
        type: item.type,
        updatedAt: item.updatedAt,
        size: item.size ?? null,
        selected: state.selectedIds.has(item.id),
      },
    }));
    const itemNodes: AgentAffordanceNode[] = visibleItems.map((item) => ({
      ref: itemRef(item.type, item.id),
      kind: item.type === 'folder' ? 'files-folder' : 'files-resource',
      label: shortLabel(item.name) ?? item.id,
      actions: item.type === 'folder' ? ['openFolder', 'select'] : ['reveal', 'select'],
      selected: state.selectedIds.has(item.id),
      value: item.type === 'folder'
        ? { folderId: item.id }
        : { resourceId: item.id, resourceType: item.type },
    }));
    const breadcrumbNodes: AgentAffordanceNode[] = state.currentPath.breadcrumbs.map((item) => ({
      ref: stableAgentRef('files', 'folder', item.id),
      kind: 'files-folder',
      label: shortLabel(item.name) ?? item.id,
      actions: ['openFolder'],
      value: { folderId: item.id },
    }));
    return {
      revision: stableRevision(
        state.currentPath.folderId,
        state.currentPath.viewKind,
        state.historyIndex,
        state.viewMode,
        state.sortBy,
        state.sortOrder,
        state.searchQuery,
        [...state.selectedIds].sort(),
        visibleItems.map((item) => [item.id, item.updatedAt]),
        refreshSequence,
      ),
      route: state.currentPath.folderId ? `files/folder/${state.currentPath.folderId}` : 'files/root',
      mode: state.viewMode,
      busy: state.isLoading || state.isSearching,
      selection: visibleItems
        .filter((item) => state.selectedIds.has(item.id))
        .map((item) => itemRef(item.type, item.id)),
      availableActions: [...ALL_ACTIONS],
      entities,
      affordances: [
        {
          ref: stableAgentRef('files', 'breadcrumbs'),
          kind: 'files-breadcrumbs',
          label: '当前位置',
          actions: [],
          children: breadcrumbNodes,
        },
        {
          ref: stableAgentRef('files', 'items'),
          kind: 'files-items',
          label: state.searchQuery ? '搜索结果' : '当前目录',
          actions: ['selectAll', 'clearSelection'],
          children: itemNodes,
        },
      ],
      state: {
        folderId: state.currentPath.folderId,
        viewKind: state.currentPath.viewKind,
        viewMode: state.viewMode,
        sortBy: state.sortBy,
        sortOrder: state.sortOrder,
        searchQuery: state.searchQuery,
        itemCount: state.items.length,
        itemsTruncated: state.items.length > visibleItems.length,
        selectedCount: state.selectedIds.size,
        canGoBack: state.historyIndex > 0,
        canGoForward: state.historyIndex < state.history.length - 1,
        error: state.error,
        refreshSequence,
      },
    };
  },
  async execute(ctx, action) {
    const before = useFinderStore.getState();
    const requestedArgs = actionArgs(action);
    if (action.name === 'openFolder' && typeof requestedArgs.folderId === 'string') {
      const mismatch = rejectMismatchedTarget(action, itemRef('folder', requestedArgs.folderId));
      if (mismatch) return mismatch;
    }
    if (
      (action.name === 'select' || action.name === 'reveal') &&
      typeof requestedArgs.resourceId === 'string'
    ) {
      const item = before.items.find((candidate) => candidate.id === requestedArgs.resourceId);
      const mismatch = rejectMismatchedTarget(
        action,
        itemRef(item?.type ?? 'resource', requestedArgs.resourceId),
      );
      if (mismatch) return mismatch;
    }
    const beforeSnapshot = {
      folderId: before.currentPath.folderId,
      historyIndex: before.historyIndex,
      searchQuery: before.searchQuery,
      viewMode: before.viewMode,
      sortBy: before.sortBy,
      sortOrder: before.sortOrder,
      selectedIds: [...before.selectedIds].sort(),
    };
    const result = await executeActivation(handleFilesActivation, ctx, action);
    if (!result.handled) return result;
    if (action.name === 'refresh') refreshSequence += 1;
    const after = useFinderStore.getState();
    const args = requestedArgs;
    result.changed = action.name === 'refresh' || stableRevision(beforeSnapshot) !== stableRevision({
      folderId: after.currentPath.folderId,
      historyIndex: after.historyIndex,
      searchQuery: after.searchQuery,
      viewMode: after.viewMode,
      sortBy: after.sortBy,
      sortOrder: after.sortOrder,
      selectedIds: [...after.selectedIds].sort(),
    });
    if ((action.name === 'select' || action.name === 'reveal') && typeof args.resourceId === 'string') {
      const item = after.items.find((candidate) => candidate.id === args.resourceId);
      result.entityRefs = [itemRef(item?.type ?? 'resource', args.resourceId)];
      result.postconditions = [{ kind: 'selection_includes', ref: itemRef(item?.type ?? 'resource', args.resourceId) }];
    }
    if (action.name === 'openFolder' && typeof args.folderId === 'string') {
      result.postconditions = [{ kind: 'state_equals', path: 'folderId', value: args.folderId }];
    } else if (action.name === 'goBack' || action.name === 'goForward' || action.name === 'goUp') {
      result.postconditions = [{ kind: 'state_equals', path: 'folderId', value: after.currentPath.folderId }];
    } else if (action.name === 'selectAll') {
      result.postconditions = [{ kind: 'state_equals', path: 'selectedCount', value: after.selectedIds.size }];
    } else if (action.name === 'clearSelection') {
      result.postconditions = [{ kind: 'state_equals', path: 'selectedCount', value: 0 }];
    } else if (action.name === 'refresh') {
      result.postconditions = [{ kind: 'state_equals', path: 'refreshSequence', value: refreshSequence }];
    } else if (action.name === 'setViewMode' && typeof args.mode === 'string') {
      result.postconditions = [{ kind: 'state_equals', path: 'viewMode', value: args.mode }];
    } else if (action.name === 'setSorting') {
      result.postconditions = [
        { kind: 'state_equals', path: 'sortBy', value: after.sortBy },
        { kind: 'state_equals', path: 'sortOrder', value: after.sortOrder },
      ];
    } else if (action.name === 'search') {
      result.postconditions = [{ kind: 'state_equals', path: 'searchQuery', value: String(args.query ?? '') }];
    }
    if (result.changed && action.name === 'setViewMode') {
      result.undo = { inverse: { name: 'setViewMode', args: { mode: beforeSnapshot.viewMode }, expect: [{ kind: 'state_equals', path: 'viewMode', value: beforeSnapshot.viewMode }] }, label: '恢复文件视图' };
    } else if (result.changed && action.name === 'setSorting') {
      result.undo = {
        inverse: {
          name: 'setSorting',
          args: { sortBy: beforeSnapshot.sortBy, sortOrder: beforeSnapshot.sortOrder },
          expect: [
            { kind: 'state_equals', path: 'sortBy', value: beforeSnapshot.sortBy },
            { kind: 'state_equals', path: 'sortOrder', value: beforeSnapshot.sortOrder },
          ],
        },
        label: '恢复文件排序',
      };
    } else if (result.changed && action.name === 'search') {
      result.undo = { inverse: { name: 'search', args: { query: beforeSnapshot.searchQuery }, expect: [{ kind: 'state_equals', path: 'searchQuery', value: beforeSnapshot.searchQuery }] }, label: '恢复文件搜索' };
    }
    return result;
  },
};
