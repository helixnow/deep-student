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
  rejectMismatchedTarget,
  stableAgentRef,
  stableRevision,
} from '../agentManifestUtils';

const inputFocusSequence = new Map<string, number>();
const lastScrolledMessage = new Map<string, { messageId: string; sequence: number }>();

async function resolveSession(sessionId: string | null) {
  const { sessionManager } = await import('@/features/chat/core/session/sessionManager');
  const resolvedId = sessionId ?? sessionManager.getCurrentSessionId();
  return {
    sessionId: resolvedId,
    store: resolvedId ? sessionManager.get(resolvedId) : undefined,
  };
}

export function createChatAgentManifest(
  activation: (ctx: ActivationContext) => ActivationHandlerResult | Promise<ActivationHandlerResult>,
): AppAgentManifest {
  return {
    version: 2,
    description: '观察 Chat 会话、消息锚点和输入草稿状态；仅支持定位与设置草稿，不会自动发送。',
    capabilities: [
      {
        name: 'setInput', description: '设置指定会话的输入草稿；不会发送消息。',
        inputSchema: objectSchema({
          sessionId: { type: 'string', minLength: 1 },
          content: { type: 'string', maxLength: 100000 },
          focus: { type: 'boolean' },
        }, ['content']),
        risk: 'medium', mutates: true, reversible: true, idempotent: true,
      },
      { name: 'focusInput', description: '聚焦 Chat 输入框。', inputSchema: objectSchema({ sessionId: { type: 'string' } }), risk: 'read', mutates: true, reversible: false, idempotent: true },
      {
        name: 'scrollToMessage', description: '滚动到指定消息。',
        inputSchema: objectSchema({ sessionId: { type: 'string' }, messageId: { type: 'string', minLength: 1 } }, ['messageId']),
        risk: 'read', mutates: true, reversible: false, idempotent: true,
        targetKinds: ['chat-message'],
      },
    ],
    async observe(ctx) {
      const resolved = await resolveSession(ctx.instanceKey);
      const state = resolved.store?.getState();
      if (!state || !resolved.sessionId) {
        return { revision: stableRevision('chat', 'not-ready'), busy: true, availableActions: [], state: { sessionId: null, ready: false } };
      }
      const messageIds = state.messageOrder.slice(-50);
      const draftRevision = stableRevision(state.inputValue);
      const focusSequence = inputFocusSequence.get(state.sessionId) ?? 0;
      const lastScroll = lastScrolledMessage.get(state.sessionId) ?? null;
      return {
        revision: stableRevision(state.sessionId, state.sessionStatus, state.messageOrder, state.currentStreamingMessageId, draftRevision, Boolean(state.pendingBlockingInteraction), focusSequence, lastScroll),
        route: `chat/${state.sessionId}`,
        mode: state.mode,
        busy: Boolean(state.currentStreamingMessageId),
        selection: state.currentStreamingMessageId ? [stableAgentRef('chat', 'message', state.currentStreamingMessageId)] : [],
        availableActions: ['setInput', 'focusInput', 'scrollToMessage'],
        entities: messageIds.map((id) => {
          const message = state.messageMap.get(id);
          return {
            ref: stableAgentRef('chat', 'message', id),
            kind: 'chat-message',
            label: message ? `${message.role} · ${new Date(message.timestamp).toLocaleString()}` : id,
            actions: ['scrollToMessage'],
            state: { role: message?.role ?? 'unknown', timestamp: message?.timestamp ?? null },
          };
        }),
        affordances: messageIds.map((id) => ({
          ref: stableAgentRef('chat', 'message', id),
          kind: 'chat-message',
          label: state.messageMap.get(id)?.role ?? id,
          actions: ['scrollToMessage'],
          selected: id === state.currentStreamingMessageId,
          value: { sessionId: state.sessionId, messageId: id },
        })),
        ...(state.pendingBlockingInteraction ? {
          pendingDialog: {
            ref: stableAgentRef('chat', 'blocking', state.sessionId),
            kind: 'chat-blocking-interaction',
            title: 'Chat 等待用户操作',
            actions: [],
          },
        } : {}),
        state: {
          sessionId: state.sessionId,
          title: state.title,
          sessionStatus: state.sessionStatus,
          messageCount: state.messageOrder.length,
          messagesTruncated: state.messageOrder.length > messageIds.length,
          streamingMessageId: state.currentStreamingMessageId,
          hasDraft: state.inputValue.length > 0,
          draftLength: state.inputValue.length,
          inputValueRevision: draftRevision,
          attachmentCount: state.attachments.length,
          queuedMessageCount: state.queuedMessages.length,
          pendingApproval: Boolean(state.pendingApprovalRequest),
          agentCanSend: false,
          inputFocusSequence: focusSequence,
          lastScrolledMessageId: lastScroll?.messageId ?? null,
          scrollSequence: lastScroll?.sequence ?? 0,
        },
      };
    },
    async execute(ctx, action) {
      const args = actionArgs(action);
      if (action.name === 'scrollToMessage' && typeof args.messageId === 'string') {
        const mismatch = rejectMismatchedTarget(
          action,
          stableAgentRef('chat', 'message', args.messageId),
        );
        if (mismatch) return mismatch;
      }
      const requestedSession = typeof args.sessionId === 'string' ? args.sessionId : ctx.instanceKey;
      const beforeResolved = await resolveSession(requestedSession);
      const before = beforeResolved.store?.getState();
      const previousInput = before?.inputValue ?? '';
      const beforeRevision = stableRevision(previousInput);
      const result = await executeActivation(activation, ctx, action);
      if (!result.handled) return result;
      const afterResolved = await resolveSession(requestedSession);
      const after = afterResolved.store?.getState();
      const afterInput = after?.inputValue ?? '';
      if (action.name === 'focusInput' && afterResolved.sessionId) {
        inputFocusSequence.set(
          afterResolved.sessionId,
          (inputFocusSequence.get(afterResolved.sessionId) ?? 0) + 1,
        );
      }
      if (
        action.name === 'scrollToMessage' &&
        afterResolved.sessionId &&
        typeof args.messageId === 'string'
      ) {
        lastScrolledMessage.set(afterResolved.sessionId, {
          messageId: args.messageId,
          sequence: (lastScrolledMessage.get(afterResolved.sessionId)?.sequence ?? 0) + 1,
        });
      }
      result.changed = action.name === 'focusInput' || action.name === 'scrollToMessage'
        || (action.name === 'setInput' && beforeRevision !== stableRevision(afterInput));
      if (action.name === 'setInput' && after) {
        const afterRevision = stableRevision(afterInput);
        result.postconditions = [{ kind: 'state_equals', path: 'inputValueRevision', value: afterRevision }];
        if (result.changed) {
          result.undo = {
            inverse: {
              name: 'setInput',
              args: { sessionId: after.sessionId, content: previousInput },
              expect: [{ kind: 'state_equals', path: 'inputValueRevision', value: beforeRevision }],
            },
            label: '恢复 Chat 输入草稿',
          };
        }
      } else if (action.name === 'scrollToMessage' && typeof args.messageId === 'string') {
        result.entityRefs = [stableAgentRef('chat', 'message', args.messageId)];
        result.postconditions = [{ kind: 'state_equals', path: 'lastScrolledMessageId', value: args.messageId }];
      } else if (action.name === 'focusInput' && afterResolved.sessionId) {
        result.postconditions = [{
          kind: 'state_equals',
          path: 'inputFocusSequence',
          value: inputFocusSequence.get(afterResolved.sessionId) ?? 0,
        }];
      }
      return result;
    },
  };
}
