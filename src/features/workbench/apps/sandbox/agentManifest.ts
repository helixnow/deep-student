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
    description: '观察并控制结构化 Sandbox 会话。运行模式可能执行不可信代码，因此单独标为高风险。',
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
      {
        name: 'setMode', description: '切换安全预览或 Sandbox 运行模式。',
        inputSchema: objectSchema({ mode: { type: 'string', enum: ['safe-preview', 'sandbox-run'] } }, ['mode']),
        risk: 'high', mutates: true, reversible: true, idempotent: true,
      },
      { name: 'closeSession', description: '关闭并丢弃当前 Sandbox 会话。', inputSchema: NO_ARGS_SCHEMA, risk: 'medium', mutates: true, reversible: false, idempotent: true },
    ],
    observe() {
      const state = stateSnapshot();
      const session = state.activeSession;
      const ref = stableAgentRef('sandbox', 'session', session?.id ?? 'empty');
      return {
        revision: stableRevision(session?.id, session?.updatedAt, session?.mode, state.viewportPreset, state.inspectorOpen, state.isOpen),
        route: session ? `sandbox/${session.id}` : 'sandbox/empty',
        mode: session?.mode ?? 'closed',
        selection: session ? [ref] : [],
        availableActions: session ? ['refresh', 'setViewport', 'setInspector', 'setMode', 'closeSession'] : [],
        entities: session ? [{
          ref,
          kind: 'sandbox-session',
          label: shortLabel(session.title) ?? session.id,
          description: session.language,
          actions: ['refresh', 'setViewport', 'setInspector', 'setMode', 'closeSession'],
          state: { sourceMessageId: session.sourceMessageId, language: session.language, mode: session.mode, updatedAt: session.updatedAt },
        }] : [],
        affordances: session ? [{ ref, kind: 'sandbox-session', label: shortLabel(session.title) ?? session.id, actions: ['refresh', 'setViewport', 'setInspector', 'setMode', 'closeSession'], selected: true }] : [],
        state: {
          sessionId: session?.id ?? null,
          title: session?.title ?? null,
          language: session?.language ?? null,
          mode: session?.mode ?? null,
          updatedAt: session?.updatedAt ?? null,
          viewport: state.viewportPreset,
          inspectorOpen: state.inspectorOpen,
          open: state.isOpen,
        },
      };
    },
    async execute(ctx, action) {
      const before = stateSnapshot();
      const snapshot = { sessionId: before.activeSession?.id ?? null, updatedAt: before.activeSession?.updatedAt ?? null, mode: before.activeSession?.mode ?? null, viewport: before.viewportPreset, inspectorOpen: before.inspectorOpen, open: before.isOpen };
      const result = await executeActivation(activation, ctx, action);
      if (!result.handled) return result;
      const after = stateSnapshot();
      result.changed = stableRevision(snapshot) !== stableRevision({ sessionId: after.activeSession?.id ?? null, updatedAt: after.activeSession?.updatedAt ?? null, mode: after.activeSession?.mode ?? null, viewport: after.viewportPreset, inspectorOpen: after.inspectorOpen, open: after.isOpen });
      const args = actionArgs(action);
      if (action.name === 'setViewport' && typeof args.viewport === 'string') {
        result.postconditions = [{ kind: 'state_equals', path: 'viewport', value: args.viewport }];
        if (result.changed) result.undo = { inverse: { name: 'setViewport', args: { viewport: snapshot.viewport }, expect: [{ kind: 'state_equals', path: 'viewport', value: snapshot.viewport }] }, label: '恢复 Sandbox 视口' };
      } else if (action.name === 'setInspector' && typeof args.open === 'boolean') {
        result.postconditions = [{ kind: 'state_equals', path: 'inspectorOpen', value: args.open }];
        if (result.changed) result.undo = { inverse: { name: 'setInspector', args: { open: snapshot.inspectorOpen }, expect: [{ kind: 'state_equals', path: 'inspectorOpen', value: snapshot.inspectorOpen }] }, label: '恢复 Sandbox 检查器' };
      } else if (action.name === 'setMode' && typeof args.mode === 'string' && snapshot.mode) {
        result.postconditions = [{ kind: 'state_equals', path: 'mode', value: args.mode }];
        if (result.changed) result.undo = { inverse: { name: 'setMode', args: { mode: snapshot.mode }, expect: [{ kind: 'state_equals', path: 'mode', value: snapshot.mode }] }, label: '恢复 Sandbox 模式' };
      } else if (action.name === 'closeSession') {
        result.postconditions = [{ kind: 'state_equals', path: 'sessionId', value: null }];
      } else if (action.name === 'refresh') {
        result.postconditions = [{
          kind: 'state_equals',
          path: 'updatedAt',
          value: after.activeSession?.updatedAt ?? null,
        }];
      }
      return result;
    },
  };
}
