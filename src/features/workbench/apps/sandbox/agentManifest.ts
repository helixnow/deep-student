import {
  LEGACY_SANDBOX_OWNER_KEY,
  selectSandboxWorkbenchOwnerState,
  useSandboxWorkbenchStore,
} from '@/features/sandbox/store/useSandboxWorkbenchStore';
import type {
  ActivationContext,
  ActivationHandlerResult,
  AppAgentManifest,
} from '../../core/types';
import {
  NO_ARGS_SCHEMA,
  actionArgs,
  executeActivation,
  objectSchema,
  shortLabel,
  stableAgentRef,
  stableRevision,
} from '../agentManifestUtils';

function stateSnapshot() {
  return selectSandboxWorkbenchOwnerState(
    useSandboxWorkbenchStore.getState(),
    LEGACY_SANDBOX_OWNER_KEY,
  );
}

export function createSandboxAgentManifest(
  activation: (ctx: ActivationContext) => ActivationHandlerResult | Promise<ActivationHandlerResult>,
): AppAgentManifest {
  return {
    version: 2,
    // ACR 4.0（A6 诚实化）：撤除 setMode 能力——渲染面固定 chat-safe 安全预览
    // （HtmlSandboxPreview 两种 mode 均剥离用户脚本，不存在真实的 sandbox-run 形态），
    // 能力表只报真可用。observe/queryState 的 mode 一律报告真实渲染形态 safe-preview。
    description: '观察并控制结构化 Sandbox 会话。渲染面固定为安全预览（safe-preview），不提供运行模式切换。',
    capabilities: [
      { name: 'refresh', description: '刷新当前 Sandbox 会话。', inputSchema: NO_ARGS_SCHEMA, risk: 'medium', mutates: true, reversible: false, idempotent: false },
      {
        name: 'setViewport', description: '切换桌面、平板或手机视口。',
        inputSchema: objectSchema({ viewport: { type: 'string', enum: ['desktop', 'tablet', 'mobile'] } }, ['viewport']),
        risk: 'low', mutates: true, reversible: true, idempotent: true,
      },
      {
        name: 'setInspector', description: '打开或关闭检查器。',
        inputSchema: objectSchema({ open: { type: 'boolean' } }, ['open']),
        risk: 'low', mutates: true, reversible: true, idempotent: true,
      },
      { name: 'closeSession', description: '关闭并丢弃当前 Sandbox 会话。', inputSchema: NO_ARGS_SCHEMA, risk: 'medium', mutates: true, reversible: false, idempotent: true },
    ],
    observe() {
      const state = stateSnapshot();
      const session = state.activeSession;
      const ref = stableAgentRef('sandbox', 'session', session?.id ?? 'empty');
      // mode 报告真实渲染形态：SandboxWorkbenchSurface 固定以 chat-safe 安全预览渲染。
      const renderedMode = session ? 'safe-preview' : null;
      return {
        revision: stableRevision(session?.id, session?.updatedAt, renderedMode, state.viewportPreset, state.inspectorOpen, state.isOpen),
        route: session ? `sandbox/${session.id}` : 'sandbox/empty',
        mode: renderedMode ?? 'closed',
        selection: session ? [ref] : [],
        availableActions: session ? ['refresh', 'setViewport', 'setInspector', 'closeSession'] : [],
        entities: session ? [{
          ref,
          kind: 'sandbox-session',
          label: shortLabel(session.title) ?? session.id,
          description: session.language,
          actions: ['refresh', 'setViewport', 'setInspector', 'closeSession'],
          state: { sourceMessageId: session.sourceMessageId, language: session.language, mode: renderedMode, updatedAt: session.updatedAt },
        }] : [],
        affordances: session ? [{ ref, kind: 'sandbox-session', label: shortLabel(session.title) ?? session.id, actions: ['refresh', 'setViewport', 'setInspector', 'closeSession'], selected: true }] : [],
        state: {
          sessionId: session?.id ?? null,
          title: session?.title ?? null,
          language: session?.language ?? null,
          mode: renderedMode,
          updatedAt: session?.updatedAt ?? null,
          viewport: state.viewportPreset,
          inspectorOpen: state.inspectorOpen,
          open: state.isOpen,
        },
      };
    },
    async execute(ctx, action) {
      const before = stateSnapshot();
      const snapshot = { sessionId: before.activeSession?.id ?? null, updatedAt: before.activeSession?.updatedAt ?? null, viewport: before.viewportPreset, inspectorOpen: before.inspectorOpen, open: before.isOpen };
      const result = await executeActivation(activation, ctx, action);
      if (!result.handled) return result;
      const after = stateSnapshot();
      result.changed = stableRevision(snapshot) !== stableRevision({ sessionId: after.activeSession?.id ?? null, updatedAt: after.activeSession?.updatedAt ?? null, viewport: after.viewportPreset, inspectorOpen: after.inspectorOpen, open: after.isOpen });
      if (!result.changed || result.acknowledged !== true) {
        return {
          handled: false,
          changed: false,
          code: 'ACTION_UNAVAILABLE',
          hint: `${action.name} 未获得 Sandbox 表面确认`,
        };
      }
      const args = actionArgs(action);
      if (action.name === 'setViewport' && typeof args.viewport === 'string') {
        result.postconditions = [{ kind: 'state_equals', path: 'viewport', value: args.viewport }];
        if (result.changed) result.undo = { inverse: { name: 'setViewport', args: { viewport: snapshot.viewport }, expect: [{ kind: 'state_equals', path: 'viewport', value: snapshot.viewport }] }, label: '恢复 Sandbox 视口' };
      } else if (action.name === 'setInspector' && typeof args.open === 'boolean') {
        result.postconditions = [{ kind: 'state_equals', path: 'inspectorOpen', value: args.open }];
        if (result.changed) result.undo = { inverse: { name: 'setInspector', args: { open: snapshot.inspectorOpen }, expect: [{ kind: 'state_equals', path: 'inspectorOpen', value: snapshot.inspectorOpen }] }, label: '恢复 Sandbox 检查器' };
      } else if (action.name === 'closeSession') {
        result.postconditions = [{ kind: 'state_equals', path: 'sessionId', value: null }];
      }
      return result;
    },
  };
}
