import { getMindMapStoreForWindow } from '@/features/mindmap/store/mindmapStore';
import { getNoteEditor } from '../../agent/drivers/noteDriver';
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
import { buildMindmapAffordances } from '../mindmap/agentManifest';
import {
  activateWorkspaceResource,
  getWorkspaceActiveResource,
  getWorkspaceResourcesForWindow,
} from './workspaceRegistry';

const RESOURCE_SCHEMA = {
  resourceType: { type: 'string' as const, enum: ['note', 'mindmap'] },
  resourceId: { type: 'string' as const, minLength: 1 },
};

function resourceRef(type: 'note' | 'mindmap', id: string): string {
  return stableAgentRef('notes', type, id);
}

function headingRef(resourceId: string, level: number, heading: string, occurrence: number): string {
  return stableAgentRef('note', 'heading', resourceId, stableRevision(level, heading, occurrence));
}

function noteHeadings(resourceId: string, markdown: string): {
  entities: AgentEntitySummary[];
  affordances: AgentAffordanceNode[];
} {
  const entities: AgentEntitySummary[] = [];
  const affordances: AgentAffordanceNode[] = [];
  const occurrences = new Map<string, number>();
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    if (affordances.length >= 60) break;
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const heading = match[2].replace(/\s+#+\s*$/, '').trim();
    if (!heading) continue;
    const level = match[1].length;
    const occurrenceKey = `${level}:${heading}`;
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    const ref = headingRef(resourceId, level, heading, occurrence);
    const label = shortLabel(heading) ?? heading;
    entities.push({
      ref,
      kind: 'note-heading',
      label,
      actions: [],
      state: { level },
    });
    affordances.push({
      ref,
      kind: 'note-heading',
      label,
      actions: [],
      value: { resourceType: 'note', resourceId, heading, level },
    });
  }
  return { entities, affordances };
}

export function createNotesAgentManifest(
  activation: (
    ctx: ActivationContext,
  ) => ActivationHandlerResult | Promise<ActivationHandlerResult>,
): AppAgentManifest {
  return {
    version: 2,
    description: '观察并导航 Notes 工作区标签、笔记标题和导图节点；内容增删改仍走领域工具。',
    capabilities: [
      {
        name: 'openResource',
        description: '在 Notes 工作区打开或切换到指定笔记/导图标签。',
        inputSchema: objectSchema(RESOURCE_SCHEMA, ['resourceType', 'resourceId']),
        risk: 'low',
        mutates: true,
        reversible: false,
        idempotent: true,
        targetKinds: ['notes-resource'],
      },
      {
        name: 'scrollToHeading',
        description: '滚动到活动笔记中的标题。',
        inputSchema: objectSchema({
          ...RESOURCE_SCHEMA,
          heading: { type: 'string', minLength: 1 },
          level: { type: 'integer', minimum: 1, maximum: 6 },
        }, ['heading']),
        risk: 'read',
        mutates: true,
        reversible: false,
        idempotent: true,
      },
      {
        name: 'focusNode',
        description: '聚焦活动导图中的节点。',
        inputSchema: objectSchema({
          ...RESOURCE_SCHEMA,
          nodeId: { type: 'string', minLength: 1 },
        }, ['nodeId']),
        risk: 'low',
        mutates: true,
        reversible: false,
        idempotent: true,
        targetKinds: ['mindmap-node'],
      },
      {
        name: 'setView',
        description: '切换活动导图的大纲/画布视图。',
        inputSchema: objectSchema({
          ...RESOURCE_SCHEMA,
          view: { type: 'string', enum: ['outline', 'mindmap'] },
        }, ['view']),
        risk: 'low',
        mutates: true,
        reversible: true,
        idempotent: true,
      },
      {
        name: 'search',
        description: '搜索活动导图的节点文本。',
        inputSchema: objectSchema({
          ...RESOURCE_SCHEMA,
          query: { type: 'string', maxLength: 500 },
        }, ['query']),
        risk: 'read',
        mutates: true,
        reversible: true,
        idempotent: true,
      },
      {
        name: 'nextSearchResult',
        description: '聚焦活动导图的下一个搜索结果。',
        inputSchema: NO_ARGS_SCHEMA,
        risk: 'read',
        mutates: true,
        reversible: false,
        idempotent: false,
      },
      {
        name: 'previousSearchResult',
        description: '聚焦活动导图的上一个搜索结果。',
        inputSchema: NO_ARGS_SCHEMA,
        risk: 'read',
        mutates: true,
        reversible: false,
        idempotent: false,
      },
      {
        name: 'clearSearch',
        description: '清除活动导图的搜索条件。',
        inputSchema: NO_ARGS_SCHEMA,
        risk: 'read',
        mutates: true,
        reversible: true,
        idempotent: true,
      },
    ],
    observe(ctx) {
      const tabs = getWorkspaceResourcesForWindow(ctx.windowId).slice(0, 40);
      const active = getWorkspaceActiveResource(ctx.windowId);
      const entities: AgentEntitySummary[] = tabs.map((tab) => ({
        ref: resourceRef(tab.type, tab.id),
        kind: 'notes-resource',
        label: shortLabel(tab.title) ?? tab.id,
        description: tab.type === 'note' ? '笔记标签' : '思维导图标签',
        actions: ['openResource'],
        state: { type: tab.type, saveState: tab.saveState ?? 'saved' },
      }));
      const resourceNodes: AgentAffordanceNode[] = tabs.map((tab) => ({
        ref: resourceRef(tab.type, tab.id),
        kind: 'notes-resource',
        label: shortLabel(tab.title) ?? tab.id,
        actions: ['openResource'],
        selected: active?.type === tab.type && active.id === tab.id,
        value: { resourceType: tab.type, resourceId: tab.id },
      }));
      let documentNodes: AgentAffordanceNode[] = [];
      let documentSelection: string[] = [];
      let contentRevision: unknown = null;
      let documentState: Record<string, string | number | boolean | null> = {};

      if (active?.type === 'note') {
        const editor = getNoteEditor(active.id, ctx.windowId);
        let markdown = '';
        try {
          markdown = editor?.getFullMarkdown?.() ?? editor?.getMarkdown() ?? '';
        } catch {
          markdown = '';
        }
        const headings = noteHeadings(active.id, markdown);
        entities.push(...headings.entities);
        documentNodes = headings.affordances;
        contentRevision = markdown;
        documentState = {
          editorReady: Boolean(editor),
          headingCount: headings.affordances.length,
          markdownLength: markdown.length,
        };
      } else if (active?.type === 'mindmap') {
        const store = getMindMapStoreForWindow(ctx.windowId, active.id);
        if (store?.getState().mindmapId === active.id) {
          const state = store.getState();
          const selected = new Set([
            ...state.selection,
            ...(state.focusedNodeId ? [state.focusedNodeId] : []),
          ]);
          const observed = buildMindmapAffordances(state.document.root, selected);
          entities.push(...observed.entities);
          documentNodes = observed.root ? [observed.root] : [];
          contentRevision = [state._documentVersion, state.currentView, state.focusedNodeId, state.searchQuery];
          documentState = {
            editorReady: true,
            view: state.currentView,
            dirty: state.isDirty,
            saving: state.isSaving,
            focusedNodeId: state.focusedNodeId,
            nodeCount: observed.count,
            searchQuery: state.searchQuery,
            searchResultCount: state.searchResults.length,
            currentSearchIndex: state.currentSearchIndex,
          };
          documentSelection = [...selected].map((id) => stableAgentRef('mindmap', 'node', id));
        } else {
          documentState = { editorReady: false };
        }
      }

      const activeActions = active?.type === 'note'
        ? ['openResource']
        : active?.type === 'mindmap'
          ? [
              'openResource',
              'focusNode',
              'setView',
              'search',
              ...(typeof documentState.searchResultCount === 'number'
                && documentState.searchResultCount > 1
                ? ['nextSearchResult', 'previousSearchResult']
                : []),
              ...(typeof documentState.searchQuery === 'string'
                && documentState.searchQuery
                ? ['clearSearch']
                : []),
            ]
          : ['openResource'];
      return {
        revision: stableRevision(tabs, active, contentRevision),
        route: active ? `notes/${active.type}/${active.id}` : 'notes',
        mode: active?.type ?? 'workspace',
        selection: active ? [resourceRef(active.type, active.id), ...documentSelection] : [],
        availableActions: activeActions,
        entities,
        affordances: [
          {
            ref: stableAgentRef('notes', 'tabs', ctx.windowId),
            kind: 'notes-tabs',
            label: '打开的标签页',
            actions: [],
            children: resourceNodes,
          },
          ...documentNodes,
        ],
        state: {
          tabCount: tabs.length,
          tabsTruncated: getWorkspaceResourcesForWindow(ctx.windowId).length > tabs.length,
          activeResourceType: active?.type ?? null,
          activeResourceId: active?.id ?? null,
          ...documentState,
        },
      };
    },
    async execute(ctx, action) {
      const active = getWorkspaceActiveResource(ctx.windowId);
      const requestedArgs = actionArgs(action);
      if (action.name === 'scrollToHeading') {
        // 经 workspaceRegistry 定向到本窗编辑器（editor.scrollToHeading 已实现，
        // 此前这里硬返回 ACTION_UNAVAILABLE 与 activation 路径不一致）
        if (!active || active.type !== 'note') {
          return {
            handled: false,
            changed: false,
            code: 'ANCHOR_NOT_FOUND',
            hint: '当前活动标签不是笔记',
          };
        }
        const { result } = await activateWorkspaceResource(
          { type: 'note', id: active.id },
          'scrollToHeading',
          requestedArgs,
          ctx.windowId,
        );
        return { changed: false, ...result };
      }
      if (action.name === 'openResource') {
        const type = requestedArgs.resourceType;
        const id = requestedArgs.resourceId;
        if ((type === 'note' || type === 'mindmap') && typeof id === 'string') {
          const mismatch = rejectMismatchedTarget(action, resourceRef(type, id));
          if (mismatch) return mismatch;
        }
      } else if (action.name === 'focusNode' && typeof requestedArgs.nodeId === 'string') {
        const mismatch = rejectMismatchedTarget(
          action,
          stableAgentRef('mindmap', 'node', requestedArgs.nodeId),
        );
        if (mismatch) return mismatch;
      }
      const mindmapStore = active?.type === 'mindmap'
        ? getMindMapStoreForWindow(ctx.windowId, active.id)
        : undefined;
      const before = mindmapStore?.getState();
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
      const beforeSnapshot = {
        active,
        currentView: before?.currentView ?? null,
        focusedNodeId: before?.focusedNodeId ?? null,
        searchQuery: before?.searchQuery ?? null,
        currentSearchIndex: before?.currentSearchIndex ?? null,
      };
      const result = await executeActivation(activation, ctx, action);
      if (!result.handled) return result;
      const args = requestedArgs;
      const afterActive = getWorkspaceActiveResource(ctx.windowId);
      const afterStore = afterActive?.type === 'mindmap'
        ? getMindMapStoreForWindow(ctx.windowId, afterActive.id)
        : undefined;
      const after = afterStore?.getState();
      result.changed = stableRevision(beforeSnapshot) !== stableRevision({
            active: afterActive,
            currentView: after?.currentView ?? null,
            focusedNodeId: after?.focusedNodeId ?? null,
            searchQuery: after?.searchQuery ?? null,
            currentSearchIndex: after?.currentSearchIndex ?? null,
          });
      if (!result.changed) {
        // 幂等动作的目标终态已满足时（如 openResource 的目标标签本就激活），
        // no-op 也是成功；只有终态确实未达成才按 ACTION_UNAVAILABLE 失败。
        const endStateSatisfied = (() => {
          switch (action.name) {
            case 'openResource':
              return afterActive?.type === args.resourceType
                && afterActive?.id === args.resourceId;
            case 'focusNode':
              return typeof args.nodeId === 'string'
                && after?.focusedNodeId === args.nodeId;
            case 'setView':
              return typeof args.view === 'string'
                && after?.currentView === args.view;
            case 'search':
              return (after?.searchQuery ?? '') === (typeof args.query === 'string' ? args.query : '');
            case 'clearSearch':
              return (after?.searchQuery ?? '') === '';
            default:
              return false;
          }
        })();
        if (!endStateSatisfied) {
          return {
            handled: false,
            changed: false,
            code: 'ACTION_UNAVAILABLE',
            hint: `${action.name} 未改变 Notes 工作区状态`,
          };
        }
        result.handled = true;
        result.message = result.message ?? `${action.name} 目标状态已满足（幂等 no-op）`;
      }
      result.acknowledged = true;
      if (action.name === 'openResource') {
        const type = args.resourceType;
        const id = args.resourceId;
        if ((type === 'note' || type === 'mindmap') && typeof id === 'string') {
          result.entityRefs = [resourceRef(type, id)];
          result.postconditions = [{ kind: 'selection_includes', ref: resourceRef(type, id) }];
        }
      } else if (action.name === 'focusNode' && typeof args.nodeId === 'string') {
        result.entityRefs = [stableAgentRef('mindmap', 'node', args.nodeId)];
        result.postconditions = [{ kind: 'selection_includes', ref: stableAgentRef('mindmap', 'node', args.nodeId) }];
      } else if (action.name === 'setView' && before) {
        result.postconditions = [{ kind: 'state_equals', path: 'view', value: String(args.view ?? '') }];
        if (result.changed) {
          result.undo = {
            inverse: {
              name: 'setView',
              args: { resourceType: 'mindmap', resourceId: active!.id, view: before.currentView },
              expect: [{ kind: 'state_equals', path: 'view', value: before.currentView }],
            },
            label: '恢复导图视图',
          };
        }
      } else if ((action.name === 'search' || action.name === 'clearSearch') && before) {
        const next = action.name === 'search' && typeof args.query === 'string' ? args.query : '';
        result.postconditions = [{ kind: 'state_equals', path: 'searchQuery', value: next }];
        if (result.changed) {
          result.undo = {
            inverse: before.searchQuery
              ? {
                  name: 'search',
                  args: { resourceType: 'mindmap', resourceId: active!.id, query: before.searchQuery },
                  expect: [{ kind: 'state_equals', path: 'searchQuery', value: before.searchQuery }],
                }
              : {
                  name: 'clearSearch',
                  args: { resourceType: 'mindmap', resourceId: active!.id },
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
