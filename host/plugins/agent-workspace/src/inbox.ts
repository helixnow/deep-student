import type { InboxItem } from '../api.ts';
import { INBOX_DRAIN_BATCH_SIZE, MAX_INBOX_SIZE } from './config.ts';

export interface InboxPushResult { accepted: boolean; rejectedMessageId: string | null }

// Every operation is synchronous, preserving the Rust mutex critical section.
export class InboxManager {
  private readonly inboxes = new Map<string, string[]>();

  restoreFromDb(items: InboxItem[]): void {
    for (const item of items) {
      if (item.status !== 'unread') continue;
      const inbox = this.inboxes.get(item.sessionId) ?? [];
      this.inboxes.set(item.sessionId, inbox);
      if (!inbox.includes(item.messageId)) inbox.push(item.messageId);
    }
  }
  push(agentId: string, messageId: string): InboxPushResult {
    const inbox = this.inboxes.get(agentId) ?? [];
    this.inboxes.set(agentId, inbox);
    if (inbox.length >= MAX_INBOX_SIZE) return { accepted: false, rejectedMessageId: messageId };
    inbox.push(messageId);
    return { accepted: true, rejectedMessageId: null };
  }
  drain(agentId: string, limit: number): string[] {
    const inbox = this.inboxes.get(agentId);
    return inbox ? inbox.splice(0, Math.min(limit, inbox.length, INBOX_DRAIN_BATCH_SIZE)) : [];
  }
  peek(agentId: string, limit: number): string[] { return this.inboxes.get(agentId)?.slice(0, limit) ?? []; }
  len(agentId: string): number { return this.inboxes.get(agentId)?.length ?? 0; }
  isEmpty(agentId: string): boolean { return this.len(agentId) === 0; }
  clear(agentId: string): void { this.inboxes.delete(agentId); }
  clearAll(): void { this.inboxes.clear(); }
  totalPending(): number { return [...this.inboxes.values()].reduce((n, inbox) => n + inbox.length, 0); }
  agentCount(): number { return this.inboxes.size; }
}
