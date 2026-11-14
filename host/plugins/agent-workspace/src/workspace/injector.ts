// workspace/injector.rs —— 工作区消息注入（节流状态由调用方持有）。
import type { WorkspaceCoordinator, WorkspaceMessage } from '../../api.ts';
import { INJECTION_COOLDOWN_MS, MAX_MESSAGES_PER_INJECTION } from '../config.ts';
import { monotonicMillis } from './util.ts';
import { charCount, takeChars } from '../../../../platform/util/index.ts';

/** 单条注入消息内容的最大字符数（与 A2 侧 result_summary 4000 预算对齐）。 */
export const MAX_INJECTED_MESSAGE_CHARS = 4000;

export interface InjectionResult {
  messages: WorkspaceMessage[];
  shouldContinue: boolean;
}

export type WorkspaceInjectionCoordinator = Pick<WorkspaceCoordinator, 'hasPendingMessages' | 'drainInbox'>;

/** 注入节流状态（纯数据，无锁）。由调用方在一次执行生命周期内持有并复用。 */
export class InjectionThrottle {
  lastInjection: number | null = null;
  injectionCount = 0;

  /** 重置轮次计数（新一轮执行开始时可选调用）。 */
  resetCount(): void {
    this.injectionCount = 0;
  }
}

/** 工作区消息注入器（无状态；节流状态通过参数传入）。 */
export class WorkspaceInjector {
  private readonly coordinator: WorkspaceInjectionCoordinator;

  constructor(coordinator: WorkspaceInjectionCoordinator) {
    this.coordinator = coordinator;
  }

  /**
   * 检查 inbox 并按节流规则注入消息。
   *
   * - 每轮最多注入 `maxInjectionsPerRound` 批（由 `throttle.injectionCount` 记账）；
   * - 两次注入之间至少间隔 `INJECTION_COOLDOWN_MS`；
   * - 每批最多 `MAX_MESSAGES_PER_INJECTION` 条。
   */
  checkAndInject(
    throttle: InjectionThrottle,
    workspaceId: string,
    sessionId: string,
    maxInjectionsPerRound: number,
  ): InjectionResult {
    if (throttle.injectionCount >= maxInjectionsPerRound) {
      return { messages: [], shouldContinue: false };
    }

    if (throttle.lastInjection !== null) {
      if (monotonicMillis() - throttle.lastInjection < INJECTION_COOLDOWN_MS) {
        return { messages: [], shouldContinue: false };
      }
    }

    if (!this.coordinator.hasPendingMessages(workspaceId, sessionId)) {
      return { messages: [], shouldContinue: false };
    }

    const messages = this.coordinator.drainInbox(workspaceId, sessionId, MAX_MESSAGES_PER_INJECTION);
    if (messages.length === 0) {
      return { messages: [], shouldContinue: false };
    }

    throttle.lastInjection = monotonicMillis();
    throttle.injectionCount += 1;

    const hasMore = this.coordinator.hasPendingMessages(workspaceId, sessionId);
    return { messages, shouldContinue: hasMore };
  }

  static formatInjectedMessages(messages: readonly WorkspaceMessage[]): string {
    if (messages.length === 0) return '';

    let formatted = '[工作区消息]\n';
    for (const message of messages) {
      formatted += `来自 ${message.senderSessionId}: [${message.messageType}] `
        + `${truncateContent(message.content)}\n`;
    }
    return formatted;
  }

  /** 单条消息内容截断（字符安全，不会切在多字节字符中间）。 */
  static truncateContent(content: string): string {
    if (charCount(content) <= MAX_INJECTED_MESSAGE_CHARS) return content;
    return `${takeChars(content, MAX_INJECTED_MESSAGE_CHARS)}…[truncated]`;
  }
}

function truncateContent(content: string): string {
  return WorkspaceInjector.truncateContent(content);
}
