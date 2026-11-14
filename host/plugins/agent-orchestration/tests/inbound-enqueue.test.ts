/**
 * super_session/inbound.rs::enqueue_external_event_lands_in_super_inbox
 *
 * `agentWorkspace` 用最小的内存替身（L05 契约只发布 api.ts；测试不得引用其实现）。
 * 替身按 Rust WorkspaceCoordinator 的语义实现成员登记、FIFO 收件箱与 metadata。
 */
import { describe, expect, it } from 'vitest';
import type { JsonValue, WorkspaceAgent } from '../../agent-workspace/api.ts';
import {
  enqueueExternalEvent, externalSenderId, incomingTrigger,
  type InboundMessage, type InboundWorkspaceCoordinator,
} from '../src/inbound.ts';

interface StoredMessage extends InboundMessage {
  workspaceId: string;
  senderSessionId: string;
  targetSessionId: string | null;
  messageType: string;
  content: string;
  metadata?: unknown;
}

function memoryCoordinator(): InboundWorkspaceCoordinator & {
  agents: Map<string, WorkspaceAgent>;
  sent: StoredMessage[];
} {
  let counter = 0;
  const agents = new Map<string, WorkspaceAgent>();
  const inbox = new Map<string, StoredMessage[]>();
  const stored = new Map<string, StoredMessage>();
  const sent: StoredMessage[] = [];
  const key = (workspaceId: string, sessionId: string) => `${workspaceId}\u0000${sessionId}`;
  return {
    agents,
    sent,
    getAgent(workspaceId, agentSessionId) {
      return agents.get(key(workspaceId, agentSessionId)) ?? null;
    },
    registerAgent(workspaceId, sessionId, role, _profileId, metadata) {
      const agent: WorkspaceAgent = {
        sessionId, workspaceId, role, skillId: null, status: 'idle',
        joinedAt: '2026-11-03T00:00:00+00:00', lastActiveAt: '2026-11-03T00:00:00+00:00',
        metadata: metadata as JsonValue,
      };
      agents.set(key(workspaceId, sessionId), agent);
      return agent;
    },
    updateAgentStatus(workspaceId, agentSessionId, status) {
      const agent = agents.get(key(workspaceId, agentSessionId));
      if (agent === undefined) throw new Error(`Agent not found: ${agentSessionId}`);
      agent.status = status as WorkspaceAgent['status'];
    },
    sendMessage(workspaceId, from, to, messageType, content) {
      counter += 1;
      const message: StoredMessage = {
        id: `msg_${counter}`, workspaceId, senderSessionId: from, targetSessionId: to,
        messageType, content,
      };
      stored.set(message.id, message);
      sent.push(message);
      const queue = inbox.get(key(workspaceId, to ?? '')) ?? [];
      queue.push(message);
      inbox.set(key(workspaceId, to ?? ''), queue);
      return message;
    },
    updateMessageMetadata(_workspaceId, messageId, metadata) {
      const message = stored.get(messageId);
      if (message === undefined) throw new Error(`Message not found: ${messageId}`);
      message.metadata = metadata;
    },
  };
}

describe('super_session/inbound.rs external event enqueue', () => {
  it('enqueue_external_event_lands_in_super_inbox', () => {
    const coordinator = memoryCoordinator();
    const workspaceId = 'ws_super';
    coordinator.registerAgent(workspaceId, 'sess_super', 'coordinator', null, null);

    const trigger = incomingTrigger('ilink', 'th', '请帮我看看');
    trigger.sender = 'u1';
    const first = enqueueExternalEvent(coordinator, workspaceId, 'sess_super', trigger, 1);
    const second = enqueueExternalEvent(coordinator, workspaceId, 'sess_super', trigger, 1);

    // 第二条复用同一伪发送者。
    const senderKey = [...coordinator.agents.keys()].filter((key) => key.endsWith('external:ilink'));
    expect(senderKey).toHaveLength(1);
    const sender = coordinator.getAgent(workspaceId, externalSenderId('ilink'))!;
    expect(sender.role).toBe('coordinator');
    expect(sender.status).toBe('closed');

    expect(coordinator.sent.map((message) => message.id)).toEqual([first, second]);
    expect(coordinator.sent[0]!.senderSessionId).toBe('external:ilink');
    expect(coordinator.sent[0]!.messageType).toBe('task');
    expect(coordinator.sent[0]!.content).toBe('请帮我看看');
    const meta = coordinator.sent[0]!.metadata as Record<string, Record<string, unknown>>;
    expect(meta.super_external!.source).toBe('ilink');
    expect(meta.super_external!.sender).toBe('u1');
    expect(meta.super_external!.threadKey).toBe('th');
    expect(meta.super_external!.priority).toBe(1);
  });
});
