/** tool_loop.rs:353–447 — owner-scoped cleanup against the published L02 services. */
import type { LLMManager, LlmStreamEvents, LlmStreamHooks } from '../../llm/api.ts';

export class StreamHooksGuard {
  private armed = true;
  private readonly events: LlmStreamEvents;
  private readonly manager: Pick<LLMManager, 'clearCancelArtifacts'>;
  private readonly streamEvent: string;
  private readonly owner: LlmStreamHooks;
  constructor(events: LlmStreamEvents, manager: Pick<LLMManager, 'clearCancelArtifacts'>,
    streamEvent: string, owner: LlmStreamHooks) {
    this.events = events; this.manager = manager; this.streamEvent = streamEvent; this.owner = owner;
  }
  disarm(): void { this.armed = false; }
  async cleanup(): Promise<void> {
    if (!this.armed) return;
    this.events.unregisterStreamHooksIfOwner(this.streamEvent, this.owner);
    await this.manager.clearCancelArtifacts(this.streamEvent);
    this.disarm();
  }
  async [Symbol.asyncDispose](): Promise<void> {
    if (this.streamEvent === '') return;
    await this.cleanup();
  }
}
