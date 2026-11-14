// workspace/router.rs —— 消息路由：落库、投递 inbox、标记 delivered。
import type { MessageType, WorkspaceMessage } from '../../api.ts';
import type { InboxManager } from '../inbox.ts';
import type { WorkspaceRepo } from './repo.ts';
import { newWorkspaceMessage } from './types.ts';

export interface InboxOverflow {
  targetSessionId: string;
  rejectedMessageId: string;
}

export interface RouteResult {
  targets: string[];
  overflow: InboxOverflow[];
}

export class MessageRouter {
  private readonly repo: WorkspaceRepo;
  private readonly inboxManager: InboxManager;

  constructor(
    repo: WorkspaceRepo,
    inboxManager: InboxManager,
  ) {
    this.repo = repo;
    this.inboxManager = inboxManager;
  }

  route(message: WorkspaceMessage): RouteResult {
    this.repo.saveMessage(message);

    const targets = this.resolveTargets(message);
    const overflow: InboxOverflow[] = [];

    for (const target of targets) {
      const priority = calculatePriority(message.messageType);
      this.repo.addToInbox(target, message.id, priority);
      const pushResult = this.inboxManager.push(target, message.id);
      if (pushResult.rejectedMessageId !== null) {
        // 保持数据库与内存一致：将本次被拒绝入队的消息标记为 processed。
        this.repo.markInboxProcessedByMessage(target, pushResult.rejectedMessageId);
        overflow.push({ targetSessionId: target, rejectedMessageId: pushResult.rejectedMessageId });
      }
    }

    this.repo.updateMessageStatus(message.id, 'delivered');
    return { targets, overflow };
  }

  private resolveTargets(message: WorkspaceMessage): string[] {
    if (message.targetSessionId !== null) {
      return message.targetSessionId === message.senderSessionId ? [] : [message.targetSessionId];
    }
    return this.repo
      .listAgents()
      .filter(agent => agent.sessionId !== message.senderSessionId)
      .map(agent => agent.sessionId);
  }

  sendUnicast(
    workspaceId: string,
    senderId: string,
    targetId: string,
    messageType: MessageType,
    content: string,
  ): { message: WorkspaceMessage; overflow: InboxOverflow[] } {
    const message = newWorkspaceMessage(workspaceId, senderId, targetId, messageType, content);
    const { overflow } = this.route(message);
    return { message, overflow };
  }

  sendBroadcast(
    workspaceId: string,
    senderId: string,
    messageType: MessageType,
    content: string,
  ): { message: WorkspaceMessage; targets: string[]; overflow: InboxOverflow[] } {
    const message = newWorkspaceMessage(workspaceId, senderId, null, messageType, content);
    const { targets, overflow } = this.route(message);
    return { message, targets, overflow };
  }
}

export function calculatePriority(messageType: MessageType): number {
  switch (messageType) {
    case 'correction': return 2;
    case 'task':
    case 'query': return 1;
    case 'progress':
    case 'result':
    case 'broadcast': return 0;
  }
}
