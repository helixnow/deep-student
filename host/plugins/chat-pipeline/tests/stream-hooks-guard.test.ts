import { describe, expect, it } from 'vitest';
import { createPipelineHost } from './chat-host.ts';
import type { LlmStreamHooks } from '../../llm/api.ts';

describe('tool_loop.rs StreamHooksGuard through real L02 services', () => {
  it('stream_guard_cleanup_clears_hook_channel_and_pending_cancel', async () => {
    const host = await createPipelineHost({ llm: true });
    try {
      const event = 'chat_v2_event_test_var_msg_run_1';
      const owner: LlmStreamHooks = {};
      host.ctx.llmStreamEvents.registerStreamHooks(event, owner);
      const receiver = await host.ctx.llm.subscribeCancelStream(event);
      await host.ctx.llm.requestCancelStream(event);
      expect(receiver.aborted).toBe(true);
      const guard = host.ctx.chatPipeline.createStreamHooksGuard(event, owner);
      await guard.cleanup();
      expect(host.ctx.llmStreamEvents.unregisterStreamHooksIfOwner(event, owner)).toBe(false);
      expect(await host.ctx.llm.consumePendingCancel(event)).toBe(false);
      // AbortSignal has no watch::Receiver::has_changed. A new cancelled request cannot reach a removed channel.
      const channel = await host.ctx.llm.subscribeCancelStream(event);
      const nextGuard = host.ctx.chatPipeline.createStreamHooksGuard(event, owner);
      await nextGuard.cleanup();
      await host.ctx.llm.requestCancelStream(event);
      expect(channel.aborted).toBe(false);
      expect(await host.ctx.llm.consumePendingCancel(event)).toBe(true);
      await guard.cleanup();
    } finally { await host.dispose(); }
  });
  it('stream_hook_keys_are_unique_across_same_message_retry: old owner disposal preserves replacement and another run', async () => {
    const host = await createPipelineHost({ llm: true });
    try {
      const oldOwner: LlmStreamHooks = {}, newOwner: LlmStreamHooks = {};
      const event = host.ctx.chatPipeline.buildRunScopedStreamEvent('s', 'm', 'old', 1);
      const next = host.ctx.chatPipeline.buildRunScopedStreamEvent('s', 'm', 'new', 2);
      host.ctx.llmStreamEvents.registerStreamHooks(event, oldOwner);
      const guard = host.ctx.chatPipeline.createStreamHooksGuard(event, oldOwner);
      host.ctx.llmStreamEvents.registerStreamHooks(event, newOwner);
      host.ctx.llmStreamEvents.registerStreamHooks(next, newOwner);
      const nextReceiver = await host.ctx.llm.subscribeCancelStream(next);
      await guard[Symbol.asyncDispose]();
      expect(host.ctx.llmStreamEvents.unregisterStreamHooksIfOwner(event, newOwner)).toBe(true);
      expect(host.ctx.llmStreamEvents.unregisterStreamHooksIfOwner(next, newOwner)).toBe(true);
      await host.ctx.llm.requestCancelStream(next);
      expect(nextReceiver.aborted).toBe(true);
      const disarmed = host.ctx.chatPipeline.createStreamHooksGuard(next, newOwner);
      disarmed.disarm(); await disarmed.cleanup();
      expect(await host.ctx.llm.consumePendingCancel(next)).toBe(true);
      await host.ctx.llm.clearCancelArtifacts(next);
    } finally { await host.dispose(); }
  });
});
