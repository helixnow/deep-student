import { chronoRfc3339 } from '../../../platform/time/index.ts';
import { rustTrim } from '../../../platform/util/index.ts';

export interface IncomingTrigger {
  source: string;
  threadKey: string;
  sender: string;
  kind: string;
  body: string;
  dedupeKey: string | null;
  explicitRequest: boolean;
}
export type SourceMode = 'ignore' | 'candidate' | 'request';
export interface SourcePolicy {
  mode: SourceMode;
  allowSenders: string[];
  mentionOnly: boolean;
  mentionKeywords: string[];
  maxPerMinute: number;
}
export interface FilterConfig {
  defaultPolicy: SourcePolicy;
  perSource: Map<string, SourcePolicy>;
  dedupeWindowMs: number;
  maxBodyChars: number;
}
export type DropReason = 'empty_body' | 'source_ignored' | 'sender_not_allowed' | 'not_mentioned' | 'duplicate' | 'rate_limited';
export type Verdict = { reason: DropReason } | { priority: number };
export type IngestOutcome = { status: 'disabled' } | { status: 'dropped'; reason: string }
  | { status: 'accepted'; messageId: string; priority: number };

export function incomingTrigger(source: string, threadKey: string, body: string): IncomingTrigger {
  return { source, threadKey, body, sender: '', kind: 'message', dedupeKey: null, explicitRequest: false };
}
export function internalTrigger(threadKey: string, kind: string, body: string): IncomingTrigger {
  return { source: 'internal', threadKey, kind, body, sender: 'system', dedupeKey: null, explicitRequest: true };
}
export function defaultSourcePolicy(): SourcePolicy {
  return { mode: 'candidate', allowSenders: [], mentionOnly: false, mentionKeywords: [], maxPerMinute: 30 };
}
export function defaultFilterConfig(): FilterConfig {
  return {
    defaultPolicy: defaultSourcePolicy(),
    perSource: new Map([
      ['manual', { ...defaultSourcePolicy(), mode: 'request', maxPerMinute: 0 }],
      ['chat', { ...defaultSourcePolicy(), mode: 'request', maxPerMinute: 0 }],
      ['ilink', { ...defaultSourcePolicy(), mode: 'request', maxPerMinute: 20 }],
    ]),
    dedupeWindowMs: 600_000,
    maxBodyChars: 20_000,
  };
}

/** inbound.rs:261–309. Tuple encoding is unambiguous; neither component is a HashMap. */
export class InboundWindow {
  private dedupe = new Map<string, number>();
  private rate = new Map<string, number[]>();

  hasRecentDedupe(source: string, key: string, sinceMs: number): boolean {
    const ts = this.dedupe.get(JSON.stringify([source, key]));
    return ts !== undefined && ts >= sinceMs;
  }
  countRecentFrom(source: string, sender: string, sinceMs: number): number {
    return this.rate.get(JSON.stringify([source, sender]))?.filter(ts => ts >= sinceMs).length ?? 0;
  }
  record(t: IncomingTrigger, nowMs: number, dedupeWindowMs: number): void {
    if (t.dedupeKey !== null && t.dedupeKey !== '') {
      this.dedupe.set(JSON.stringify([t.source, t.dedupeKey]), nowMs);
      if (this.dedupe.size > 4096) {
        const cutoff = nowMs - dedupeWindowMs;
        for (const [key, ts] of this.dedupe) if (ts < cutoff) this.dedupe.delete(key);
        if (this.dedupe.size > 4096) {
          const stamps = [...this.dedupe.values()].sort((a, b) => a - b);
          const median = stamps[Math.floor(stamps.length / 2)]!;
          for (const [key, ts] of this.dedupe) if (ts < median) this.dedupe.delete(key);
        }
      }
    }
    if (t.sender !== '') {
      const key = JSON.stringify([t.source, t.sender]);
      const bucket = this.rate.get(key) ?? [];
      this.rate.set(key, bucket);
      bucket.push(nowMs);
      const cutoff = nowMs - 60_000;
      while ((bucket[0] !== undefined && bucket[0] < cutoff) || bucket.length > 512) bucket.shift();
    }
  }
}

export function evaluate(cfg: FilterConfig, window: InboundWindow, t: IncomingTrigger, threadHasSubscribers: boolean, nowMs: number): Verdict {
  if (t.source === 'internal') return { priority: 2 };
  if (rustTrim(t.body) === '') return { reason: 'empty_body' };
  const policy = cfg.perSource.get(t.source) ?? cfg.defaultPolicy;
  if (policy.mode === 'ignore') return { reason: 'source_ignored' };
  if (policy.allowSenders.length && !policy.allowSenders.includes(t.sender)) return { reason: 'sender_not_allowed' };
  if (policy.mentionOnly && !t.explicitRequest && !threadHasSubscribers) {
    const lowered = t.body.toLowerCase();
    if (!policy.mentionKeywords.some(k => k !== '' && lowered.includes(k.toLowerCase()))) return { reason: 'not_mentioned' };
  }
  if (t.dedupeKey !== null && t.dedupeKey !== '' && window.hasRecentDedupe(t.source, t.dedupeKey, nowMs - cfg.dedupeWindowMs)) {
    return { reason: 'duplicate' };
  }
  if (policy.maxPerMinute > 0 && t.sender !== '' && window.countRecentFrom(t.source, t.sender, nowMs - 60_000) >= policy.maxPerMinute) {
    return { reason: 'rate_limited' };
  }
  return { priority: policy.mode === 'request' || t.explicitRequest ? 1 : 0 };
}

export function evaluateAndRecord(cfg: FilterConfig, window: InboundWindow, t: IncomingTrigger, nowMs: number): Verdict {
  const verdict = evaluate(cfg, window, t, false, nowMs);
  if ('priority' in verdict && t.source !== 'internal') window.record(t, nowMs, cfg.dedupeWindowMs);
  return verdict;
}

export function normalizeTrigger(t: IncomingTrigger, cfg: FilterConfig): IncomingTrigger {
  return { ...t, threadKey: rustTrim(t.threadKey) === '' ? `${t.source}:default` : t.threadKey,
    body: [...t.body].slice(0, cfg.maxBodyChars).join('') };
}
export function externalSenderId(source: string): string {
  return `external:${source.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 48) || 'unknown'}`;
}
export function isExternalSender(sessionId: string): boolean {
  return sessionId.startsWith('external:');
}

/** inbound.rs:503–522 的跨 lane 依赖（L05 `agentWorkspace`）。 */
export interface InboundWorkspaceCoordinator {
  getAgent(workspaceId: string, agentSessionId: string): InboundAgent | null;
  registerAgent(workspaceId: string, sessionId: string, role: 'coordinator' | 'worker',
    profileId: string | null, metadata: unknown): InboundAgent;
  updateAgentStatus(workspaceId: string, agentSessionId: string, status: string): void;
  sendMessage(workspaceId: string, from: string, to: string | null,
    messageType: 'task' | 'progress' | 'result' | 'query' | 'correction' | 'broadcast', content: string): InboundMessage;
  updateMessageMetadata(workspaceId: string, messageId: string, metadata: unknown): void;
}
export interface InboundAgent { role: string; status: string; metadata?: unknown }
export interface InboundMessage { id: string }

export const EXTERNAL_META_KEY = 'super_external';

/**
 * inbound.rs:503–522：外部伪发送者登记为 Coordinator 角色 + Closed 状态
 * （不占活跃配额，也不进 Worker 名册/取消逻辑）。
 */
export function ensureExternalSender(
  coordinator: InboundWorkspaceCoordinator, workspaceId: string, senderId: string,
): void {
  if (coordinator.getAgent(workspaceId, senderId) !== null) return;
  coordinator.registerAgent(workspaceId, senderId, 'coordinator', null,
    { super_agent: { external_source: true } });
  coordinator.updateAgentStatus(workspaceId, senderId, 'closed');
}

/** inbound.rs:524–562：外部事件原样入 Super 收件箱并写结构化 metadata。 */
export function enqueueExternalEvent(
  coordinator: InboundWorkspaceCoordinator, workspaceId: string, superSessionId: string,
  trigger: IncomingTrigger, priority: number,
): string {
  const senderId = externalSenderId(trigger.source);
  ensureExternalSender(coordinator, workspaceId, senderId);
  const message = coordinator.sendMessage(workspaceId, senderId, superSessionId, 'task', trigger.body);
  const metadata = {
    [EXTERNAL_META_KEY]: {
      source: trigger.source,
      sender: trigger.sender,
      kind: trigger.kind,
      threadKey: trigger.threadKey,
      explicitRequest: trigger.explicitRequest,
      priority,
      receivedAt: chronoRfc3339(),
    },
  };
  try {
    coordinator.updateMessageMetadata(workspaceId, message.id, metadata);
  } catch (error) {
    // Rust 只记 warn 后继续：metadata 写入失败不影响入箱本身。
    externalSenderWarning(error);
  }
  return message.id;
}

let inboundWarn: ((message: string) => void) | null = null;

/** 装配层注入的告警通道（对应 Rust `log::warn!`）。 */
export function setInboundLogger(warn: ((message: string) => void) | null): void {
  inboundWarn = warn;
}

function externalSenderWarning(error: unknown): void {
  inboundWarn?.(`[SuperSession::inbound] Failed to persist external event metadata: ${error instanceof Error ? error.message : String(error)}`);
}
