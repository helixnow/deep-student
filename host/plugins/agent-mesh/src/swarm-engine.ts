/**
 * Heterogeneous Swarm Engine (Spec §III.4 & §IV.1–6):
 * - Monotonic `seq` append-only message board per `chatSessionId` with `@mention` parser & taint neutralization
 * - `lastSeenSeq` Zero-Miss Reactive Wakeup Scheduler (0-token `parked` idle, atomic delta check on settle)
 * - Quiescence gate (`waiting_children` blocks parking when `hasActiveChildren` is true)
 * - Graded mid-turn delivery: human `correction` steers immediately; peer `@mention` queues cleanly + 500ms coalescing
 * - Anti-Ping-Pong circuit breaker (`autonomous_hops >= max_autonomous_hops`, reset to 0 on human post)
 * - Stall detector: wakes `coordinator_agent` once when all members settle into `parked` while swarm is `active`
 * - `human_controlled` lock: holds peer/coordinator mentions unread until human releases control
 */
import type {
  AgentMeshEvent,
  BoardMessagePriority,
  BoardSenderKind,
  SwarmBoardMessage,
  SwarmMemberRecord,
  SwarmMemberStatus,
  SwarmSessionRecord,
  SwarmSessionSnapshot,
} from './contracts.ts';
import type { AgentMeshStorage } from './storage.ts';

export const DEFAULT_SWARM_COALESCE_MS = 500;
export const DEFAULT_MAX_AUTONOMOUS_HOPS = 12;

const MENTION_REGEX = /(?:^|[^a-zA-Z0-9._-])@([a-zA-Z0-9][a-zA-Z0-9._:-]{0,63})/g;
const DANGEROUS_TAG_REGEX =
  /<\s*\/?\s*(?:system|SYSTEM_MESSAGE|plugin_extensions|turn_volatile|instructions|tool_call|tool_response)\b[^>]*>/gi;

/**
 * Neutralizes untrusted external CLI / peer text so it cannot spoof system delimiters or control tags
 * when injected into another agent's context or `<plugin_extensions>`.
 */
export function neutralizeUntrusted(raw: string, maxChars = 16_000): string {
  const withoutControls = raw
    .replace(/\u0000/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const defanged = withoutControls.replace(DANGEROUS_TAG_REGEX, (tag) =>
    tag.replace(/</g, '‹').replace(/>/g, '›'),
  );
  if (defanged.length <= maxChars) return defanged;
  return `${defanged.slice(0, maxChars)}…[truncated]`;
}

function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

/**
 * Extracts normalized `@mentions` (`rosterName`, `agentId`, `coordinator`, `all`) from board text
 * combined with any explicit `mentions` array, ignoring email addresses like `user@example.com`.
 */
export function parseBoardMentions(
  text: string,
  explicitMentions?: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const explicit of explicitMentions ?? []) {
    const clean = normalizeHandle(explicit);
    if (clean) out.add(clean);
  }
  MENTION_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_REGEX.exec(text)) !== null) {
    const token = normalizeHandle(match[1] ?? '');
    if (token) out.add(token);
  }
  return [...out];
}

export interface SwarmWakeRequest {
  chatSessionId: string;
  member: SwarmMemberRecord;
  reason: 'mention' | 'delta_catchup' | 'stall' | 'human_release';
  sinceSeq: number;
  toSeq: number;
  messages: SwarmBoardMessage[];
  triggeredByHuman: boolean;
}

export interface SwarmSteerRequest {
  chatSessionId: string;
  member: SwarmMemberRecord;
  message: SwarmBoardMessage;
}

export interface SettleMemberResult {
  outcome:
    | 'waiting_children'
    | 'human_controlled_parked'
    | 'delta_wake_scheduled'
    | 'parked';
  member: SwarmMemberRecord;
  unreadMessages: SwarmBoardMessage[];
}

export interface SwarmEngineCallbacks {
  onWakeMember(request: SwarmWakeRequest): Promise<void> | void;
  onSteerMember(request: SwarmSteerRequest): Promise<boolean> | boolean;
  onEmitEvent?(event: AgentMeshEvent): void;
}

interface MemberRuntimeActivity {
  activeChildCount: number;
  activeBgTaskCount: number;
}

interface PendingWakeEntry {
  chatSessionId: string;
  rosterName: string;
  reason: SwarmWakeRequest['reason'];
  triggeredByHuman: boolean;
  timer: ReturnType<typeof setTimeout>;
}

function memberKey(chatSessionId: string, rosterName: string): string {
  return `${chatSessionId}\u0000${rosterName}`;
}

export interface SwarmEngineOptions {
  storage: AgentMeshStorage;
  callbacks: SwarmEngineCallbacks;
  coalesceWindowMs?: number;
  defaultMaxAutonomousHops?: number;
}

export class SwarmEngine {
  private readonly storage: AgentMeshStorage;
  private readonly callbacks: SwarmEngineCallbacks;
  private readonly coalesceWindowMs: number;
  private readonly defaultMaxAutonomousHops: number;
  private readonly activityByMember = new Map<string, MemberRuntimeActivity>();
  private readonly pendingWakes = new Map<string, PendingWakeEntry>();
  private readonly pendingMentionsByMember = new Map<string, number[]>();
  private readonly lastStallWakeSeqBySession = new Map<string, number>();
  private disposed = false;

  constructor(options: SwarmEngineOptions) {
    this.storage = options.storage;
    this.callbacks = options.callbacks;
    this.coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_SWARM_COALESCE_MS;
    this.defaultMaxAutonomousHops =
      options.defaultMaxAutonomousHops ?? DEFAULT_MAX_AUTONOMOUS_HOPS;
  }

  getSnapshot(chatSessionId: string): SwarmSessionSnapshot | null {
    const session = this.storage.getSwarmSession(chatSessionId);
    if (!session) return null;
    const members = this.storage.listSwarmMembers(chatSessionId);
    const board = this.storage.readBoardMessages(chatSessionId, { sinceSeq: 0, limit: 500 });
    return { session, members, board };
  }

  startSession(input: {
    chatSessionId: string;
    title: string;
    goal: string;
    coordinatorAgent?: string;
    maxAutonomousHops?: number;
    members?: ReadonlyArray<{
      rosterName: string;
      agentId: string;
      roleTitle?: string;
      ownedGlobs?: string[];
    }>;
    initialBrief?: string;
  }): SwarmSessionSnapshot {
    const coordinatorAgent = normalizeHandle(input.coordinatorAgent || 'deepstudent') || 'deepstudent';
    const session = this.storage.upsertSwarmSession({
      chatSessionId: input.chatSessionId,
      title: input.title.trim() || 'Swarm Task',
      goal: input.goal.trim(),
      status: 'active',
      coordinatorAgent,
      autonomousHops: 0,
      maxAutonomousHops: input.maxAutonomousHops ?? this.defaultMaxAutonomousHops,
    });

    // Always ensure coordinator member exists on the roster so @coordinator / stall detector can address it.
    if (!this.storage.getSwarmMember(input.chatSessionId, coordinatorAgent)) {
      this.storage.upsertSwarmMember({
        chatSessionId: input.chatSessionId,
        rosterName: coordinatorAgent,
        agentId: coordinatorAgent,
        roleTitle: 'Coordinator',
        status: 'parked',
        lastSeenSeq: session.headSeq,
      });
    }

    for (const member of input.members ?? []) {
      const cleanName = normalizeHandle(member.rosterName);
      if (!cleanName) continue;
      this.storage.upsertSwarmMember({
        chatSessionId: input.chatSessionId,
        rosterName: cleanName,
        agentId: member.agentId.trim(),
        roleTitle: member.roleTitle ?? '',
        ownedGlobs: member.ownedGlobs ?? [],
        status: 'parked',
        lastSeenSeq: session.headSeq,
      });
    }

    if (input.initialBrief && input.initialBrief.trim()) {
      this.postMessage({
        chatSessionId: input.chatSessionId,
        sender: 'human',
        senderKind: 'human',
        priority: 'task',
        text: input.initialBrief.trim(),
      });
    } else {
      this.emitSwarmUpdated(input.chatSessionId);
    }

    return this.getSnapshot(input.chatSessionId)!;
  }

  addOrUpdateMember(input: {
    chatSessionId: string;
    rosterName: string;
    agentId: string;
    roleTitle?: string;
    ownedGlobs?: string[];
    status?: SwarmMemberStatus;
    threadId?: string | null;
    externalSessionId?: string | null;
    humanControlled?: boolean;
  }): SwarmMemberRecord {
    const cleanName = normalizeHandle(input.rosterName);
    if (!cleanName) {
      throw new Error('AGENT_MESH_INVALID_MEMBER: rosterName must be non-empty');
    }
    const session = this.storage.getSwarmSession(input.chatSessionId);
    const existing = this.storage.getSwarmMember(input.chatSessionId, cleanName);
    const member = this.storage.upsertSwarmMember({
      chatSessionId: input.chatSessionId,
      rosterName: cleanName,
      agentId: input.agentId.trim(),
      roleTitle: input.roleTitle,
      status: input.status ?? existing?.status ?? 'parked',
      threadId: input.threadId,
      externalSessionId: input.externalSessionId,
      lastSeenSeq: existing ? existing.lastSeenSeq : (session?.headSeq ?? 0),
      ownedGlobs: input.ownedGlobs,
      humanControlled: input.humanControlled,
    });
    this.emitSwarmUpdated(input.chatSessionId);
    return member;
  }

  swapMemberCli(input: {
    chatSessionId: string;
    rosterName: string;
    newAgentId: string;
    roleTitle?: string;
  }): SwarmMemberRecord {
    const cleanName = normalizeHandle(input.rosterName);
    const existing = this.storage.getSwarmMember(input.chatSessionId, cleanName);
    if (!existing) {
      throw new Error(`AGENT_MESH_MEMBER_NOT_FOUND: ${cleanName}`);
    }
    const updated = this.storage.upsertSwarmMember({
      chatSessionId: input.chatSessionId,
      rosterName: cleanName,
      agentId: input.newAgentId.trim(),
      roleTitle: input.roleTitle ?? existing.roleTitle,
      status: 'parked',
      threadId: null,
      externalSessionId: null,
      // Re-feed context on next wake if needed while preserving owned globs.
      lastSeenSeq: existing.lastSeenSeq,
      ownedGlobs: existing.ownedGlobs,
      humanControlled: existing.humanControlled,
    });
    this.emitSwarmUpdated(input.chatSessionId);
    return updated;
  }

  removeMember(chatSessionId: string, rosterName: string): SwarmMemberRecord | null {
    const cleanName = normalizeHandle(rosterName);
    const key = memberKey(chatSessionId, cleanName);
    this.cancelPendingWake(key);
    this.activityByMember.delete(key);
    this.pendingMentionsByMember.delete(key);
    const existing = this.storage.getSwarmMember(chatSessionId, cleanName);
    if (!existing) return null;
    const stopped = this.storage.upsertSwarmMember({
      chatSessionId,
      rosterName: cleanName,
      agentId: existing.agentId,
      status: 'stopped',
    });
    this.emitSwarmUpdated(chatSessionId);
    return stopped;
  }

  setMemberActivity(
    chatSessionId: string,
    rosterName: string,
    update: {
      activeChildCount?: number;
      activeBgTaskCount?: number;
      status?: SwarmMemberStatus;
      threadId?: string | null;
      externalSessionId?: string | null;
    },
  ): SwarmMemberRecord | null {
    const cleanName = normalizeHandle(rosterName);
    const existing = this.storage.getSwarmMember(chatSessionId, cleanName);
    if (!existing) return null;
    const key = memberKey(chatSessionId, cleanName);
    const prev = this.activityByMember.get(key) ?? { activeChildCount: 0, activeBgTaskCount: 0 };
    const next: MemberRuntimeActivity = {
      activeChildCount:
        update.activeChildCount !== undefined
          ? Math.max(0, update.activeChildCount)
          : prev.activeChildCount,
      activeBgTaskCount:
        update.activeBgTaskCount !== undefined
          ? Math.max(0, update.activeBgTaskCount)
          : prev.activeBgTaskCount,
    };
    this.activityByMember.set(key, next);

    const updated = this.storage.upsertSwarmMember({
      chatSessionId,
      rosterName: cleanName,
      agentId: existing.agentId,
      status: update.status ?? existing.status,
      threadId: update.threadId !== undefined ? update.threadId : existing.threadId,
      externalSessionId:
        update.externalSessionId !== undefined
          ? update.externalSessionId
          : existing.externalSessionId,
    });
    this.emitSwarmUpdated(chatSessionId);
    return updated;
  }

  hasActiveChildren(chatSessionId: string, rosterName: string): boolean {
    const activity = this.activityByMember.get(memberKey(chatSessionId, normalizeHandle(rosterName)));
    if (!activity) return false;
    return activity.activeChildCount > 0 || activity.activeBgTaskCount > 0;
  }

  getPendingMentions(chatSessionId: string, rosterName: string): number[] {
    return [...(this.pendingMentionsByMember.get(memberKey(chatSessionId, normalizeHandle(rosterName))) ?? [])];
  }

  /**
   * Toggles `human_controlled` on a swarm member. While `true`, peer/coordinator `@mentions`
   * remain unread (`lastSeenSeq` not advanced) without auto-spawning turns. When released (`false`),
   * any unread `@mentions` immediately schedule a coalesced wake!
   */
  setMemberHumanControlled(
    chatSessionId: string,
    rosterName: string,
    humanControlled: boolean,
  ): SwarmMemberRecord | null {
    const cleanName = normalizeHandle(rosterName);
    const existing = this.storage.getSwarmMember(chatSessionId, cleanName);
    if (!existing) return null;
    const key = memberKey(chatSessionId, cleanName);
    if (humanControlled) {
      this.cancelPendingWake(key);
    }
    const updated = this.storage.upsertSwarmMember({
      chatSessionId,
      rosterName: cleanName,
      agentId: existing.agentId,
      humanControlled,
    });
    this.emitSwarmUpdated(chatSessionId);

    if (!humanControlled && (updated.status === 'parked' || updated.status === 'stopped')) {
      const unread = this.findUnreadMentionsForMember(chatSessionId, updated);
      if (unread.length > 0) {
        this.scheduleWake(chatSessionId, updated.rosterName, 'human_release', true, 0);
      }
    }
    return updated;
  }

  readBoard(
    chatSessionId: string,
    options: { sinceSeq?: number; limit?: number } = {},
  ): SwarmBoardMessage[] {
    return this.storage.readBoardMessages(chatSessionId, options);
  }

  /**
   * Appends a monotonic `seq` board post and routes graded reactive wakeups / mid-turn steering.
   */
  postMessage(input: {
    chatSessionId: string;
    sender: string;
    senderKind: BoardSenderKind;
    priority?: BoardMessagePriority;
    text: string;
    mentions?: string[];
    channel?: string;
    replyToSeq?: number | null;
    diffRef?: string | null;
  }): SwarmBoardMessage {
    const cleanSender = normalizeHandle(input.sender) || input.senderKind;
    const sanitizedText =
      input.senderKind === 'human' ? input.text.trim() : neutralizeUntrusted(input.text.trim());
    const mentions = parseBoardMentions(sanitizedText, input.mentions);
    const defaultPriority: BoardMessagePriority =
      input.senderKind === 'human' ? 'correction' : 'progress';
    const priority = input.priority ?? defaultPriority;

    // Human message resets autonomous_hops to 0 atomically in appendBoardMessage,
    // and unpauses circuit-broken sessions when human gives a correction/task.
    const preSession = this.storage.getSwarmSession(input.chatSessionId);
    if (
      input.senderKind === 'human' &&
      preSession?.status === 'paused' &&
      (priority === 'correction' || priority === 'task')
    ) {
      this.storage.updateSwarmSessionPatch(input.chatSessionId, {
        status: 'active',
        autonomousHops: 0,
      });
    }

    const message = this.storage.appendBoardMessage({
      chatSessionId: input.chatSessionId,
      sender: cleanSender,
      senderKind: input.senderKind,
      priority,
      text: sanitizedText,
      mentions,
      channel: input.channel,
      replyToSeq: input.replyToSeq,
      diffRef: input.diffRef,
    });

    // Sender has obviously seen up to its own post if it's a registered member.
    const senderMember = this.storage.getSwarmMember(input.chatSessionId, cleanSender);
    if (senderMember && senderMember.lastSeenSeq < message.seq && !senderMember.humanControlled) {
      // Only advance sender's lastSeenSeq if there are no earlier unread mentions between sender.lastSeenSeq and message.seq - 1!
      const priorUnread = this.findUnreadMentionsForMember(
        input.chatSessionId,
        senderMember,
        message.seq - 1,
      );
      if (priorUnread.length === 0) {
        this.storage.upsertSwarmMember({
          chatSessionId: input.chatSessionId,
          rosterName: senderMember.rosterName,
          agentId: senderMember.agentId,
          lastSeenSeq: message.seq,
        });
      }
    }

    this.callbacks.onEmitEvent?.({
      type: 'swarm_board_post',
      chatSessionId: input.chatSessionId,
      message,
    });
    this.emitSwarmUpdated(input.chatSessionId);

    const session = this.storage.getSwarmSession(input.chatSessionId);
    if (!session || session.status !== 'active') {
      return message;
    }

    const targets = this.resolveTargetMembers(session, message);
    for (const target of targets) {
      this.routePostToTarget(session, target, message);
    }

    return message;
  }

  /**
   * Called when a member's main turn reaches completion.
   * Enforces:
   * 1) Quiescence gate (`waiting_children` if `hasActiveChildren` is true);
   * 2) `human_controlled` non-interference;
   * 3) Atomic Zero-Miss delta check (`board.headSeq > member.lastSeenSeq` with `@member` / `@all`);
   * 4) Transition to 0-token `parked` + Stall Detector check!
   */
  settleMemberTurn(
    chatSessionId: string,
    rosterName: string,
    options: { hasActiveChildren?: boolean } = {},
  ): SettleMemberResult {
    const cleanName = normalizeHandle(rosterName);
    const member = this.storage.getSwarmMember(chatSessionId, cleanName);
    if (!member) {
      throw new Error(`AGENT_MESH_MEMBER_NOT_FOUND: ${cleanName}`);
    }

    // 1) Quiescence gate: NEVER park while child subagents or background tasks are active!
    if (options.hasActiveChildren === true || this.hasActiveChildren(chatSessionId, cleanName)) {
      const waiting = this.storage.upsertSwarmMember({
        chatSessionId,
        rosterName: cleanName,
        agentId: member.agentId,
        status: 'waiting_children',
      });
      this.emitSwarmUpdated(chatSessionId);
      return {
        outcome: 'waiting_children',
        member: waiting,
        unreadMessages: [],
      };
    }

    // 2) `human_controlled` lock: park cleanly without advancing `lastSeenSeq` or auto-waking.
    if (member.humanControlled) {
      const lockedParked = this.storage.upsertSwarmMember({
        chatSessionId,
        rosterName: cleanName,
        agentId: member.agentId,
        status: 'parked',
      });
      this.emitSwarmUpdated(chatSessionId);
      return {
        outcome: 'human_controlled_parked',
        member: lockedParked,
        unreadMessages: this.findUnreadMentionsForMember(chatSessionId, lockedParked),
      };
    }

    // 3) Atomic Zero-Miss Check: did any @member / @all message land while this member was working?
    const session = this.storage.getSwarmSession(chatSessionId);
    const unread = this.findUnreadMentionsForMember(chatSessionId, member);
    if (session && session.status === 'active' && unread.length > 0) {
      const parkedTemporarily = this.storage.upsertSwarmMember({
        chatSessionId,
        rosterName: cleanName,
        agentId: member.agentId,
        status: 'parked',
      });
      const triggeredByHuman = unread.some((m) => m.senderKind === 'human');
      this.scheduleWake(
        chatSessionId,
        cleanName,
        'delta_catchup',
        triggeredByHuman,
        triggeredByHuman ? 0 : Math.min(this.coalesceWindowMs, 50),
      );
      this.emitSwarmUpdated(chatSessionId);
      return {
        outcome: 'delta_wake_scheduled',
        member: parkedTemporarily,
        unreadMessages: unread,
      };
    }

    // 4) No unread mentions targeting this member: safe to advance lastSeenSeq to headSeq and park (0 tokens)!
    const nextSeen = Math.max(member.lastSeenSeq, session?.headSeq ?? member.lastSeenSeq);
    const parked = this.storage.upsertSwarmMember({
      chatSessionId,
      rosterName: cleanName,
      agentId: member.agentId,
      status: 'parked',
      lastSeenSeq: nextSeen,
    });
    this.pendingMentionsByMember.delete(memberKey(chatSessionId, cleanName));
    this.emitSwarmUpdated(chatSessionId);

    this.checkStallAndWakeCoordinatorIfNeeded(chatSessionId);
    return {
      outcome: 'parked',
      member: parked,
      unreadMessages: [],
    };
  }

  pauseSwarm(chatSessionId: string): SwarmSessionRecord | null {
    this.cancelAllPendingWakesForSession(chatSessionId);
    const updated = this.storage.updateSwarmSessionPatch(chatSessionId, { status: 'paused' });
    if (updated) this.emitSwarmUpdated(chatSessionId);
    return updated;
  }

  resumeSwarm(chatSessionId: string): SwarmSessionRecord | null {
    const updated = this.storage.updateSwarmSessionPatch(chatSessionId, {
      status: 'active',
      autonomousHops: 0,
    });
    if (!updated) return null;
    this.emitSwarmUpdated(chatSessionId);

    // Dispatch any unread mentions that queued while paused!
    const members = this.storage.listSwarmMembers(chatSessionId);
    let scheduledAny = false;
    for (const member of members) {
      if (member.humanControlled) continue;
      if (member.status !== 'parked' && member.status !== 'stopped') continue;
      const unread = this.findUnreadMentionsForMember(chatSessionId, member);
      if (unread.length > 0) {
        scheduledAny = true;
        this.scheduleWake(chatSessionId, member.rosterName, 'mention', true, 0);
      }
    }
    if (!scheduledAny) {
      this.checkStallAndWakeCoordinatorIfNeeded(chatSessionId);
    }
    return updated;
  }

  completeSwarm(chatSessionId: string): SwarmSessionRecord | null {
    this.cancelAllPendingWakesForSession(chatSessionId);
    this.lastStallWakeSeqBySession.delete(chatSessionId);
    const updated = this.storage.updateSwarmSessionPatch(chatSessionId, { status: 'completed' });
    if (updated) this.emitSwarmUpdated(chatSessionId);
    return updated;
  }

  setMaxAutonomousHops(chatSessionId: string, maxAutonomousHops: number): SwarmSessionRecord | null {
    const clamped = Math.max(1, Math.min(200, Math.trunc(maxAutonomousHops)));
    const updated = this.storage.updateSwarmSessionPatch(chatSessionId, {
      maxAutonomousHops: clamped,
    });
    if (updated) this.emitSwarmUpdated(chatSessionId);
    return updated;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.pendingWakes.values()) {
      clearTimeout(entry.timer);
    }
    this.pendingWakes.clear();
    this.activityByMember.clear();
    this.pendingMentionsByMember.clear();
    this.lastStallWakeSeqBySession.clear();
  }

  // ---- Internal Routing & Invariants ----------------------------------------

  private resolveTargetMembers(
    session: SwarmSessionRecord,
    message: SwarmBoardMessage,
  ): SwarmMemberRecord[] {
    if (message.mentions.length === 0) return [];
    const members = this.storage.listSwarmMembers(session.chatSessionId);
    const senderNorm = normalizeHandle(message.sender);
    const mentionSet = new Set(message.mentions.map(normalizeHandle));
    const isAll = mentionSet.has('all');
    const coordinatorNorm = normalizeHandle(session.coordinatorAgent);

    return members.filter((member) => {
      if (member.status === 'stopped' && !isAll && !mentionSet.has(normalizeHandle(member.rosterName))) {
        return false;
      }
      const rosterNorm = normalizeHandle(member.rosterName);
      if (rosterNorm === senderNorm) return false;
      if (isAll) return member.status !== 'stopped';
      const agentNorm = normalizeHandle(member.agentId);
      if (mentionSet.has(rosterNorm) || mentionSet.has(agentNorm)) return true;
      if (mentionSet.has('coordinator') && rosterNorm === coordinatorNorm) return true;
      return false;
    });
  }

  private isMessageAddressedToMember(
    session: SwarmSessionRecord,
    member: SwarmMemberRecord,
    message: SwarmBoardMessage,
  ): boolean {
    const rosterNorm = normalizeHandle(member.rosterName);
    const senderNorm = normalizeHandle(message.sender);
    if (rosterNorm === senderNorm) return false;
    const mentionSet = new Set(message.mentions.map(normalizeHandle));
    if (mentionSet.has('all')) return true;
    if (mentionSet.has(rosterNorm)) return true;
    if (mentionSet.has(normalizeHandle(member.agentId))) return true;
    if (mentionSet.has('coordinator') && rosterNorm === normalizeHandle(session.coordinatorAgent)) {
      return true;
    }
    return false;
  }

  findUnreadMentionsForMember(
    chatSessionId: string,
    member: SwarmMemberRecord,
    upToSeq?: number,
  ): SwarmBoardMessage[] {
    const session = this.storage.getSwarmSession(chatSessionId);
    if (!session) return [];
    const maxSeq = upToSeq ?? session.headSeq;
    if (maxSeq <= member.lastSeenSeq) return [];
    const delta = this.storage.readBoardMessages(chatSessionId, {
      sinceSeq: member.lastSeenSeq,
      limit: 500,
    });
    return delta.filter(
      (msg) => msg.seq <= maxSeq && this.isMessageAddressedToMember(session, member, msg),
    );
  }

  private recordPendingMention(chatSessionId: string, rosterName: string, seq: number): void {
    const key = memberKey(chatSessionId, rosterName);
    const list = this.pendingMentionsByMember.get(key) ?? [];
    if (!list.includes(seq)) {
      list.push(seq);
      this.pendingMentionsByMember.set(key, list);
    }
  }

  private routePostToTarget(
    session: SwarmSessionRecord,
    target: SwarmMemberRecord,
    message: SwarmBoardMessage,
  ): void {
    // Invariant 6 (`human_controlled` lock): peer/coordinator @mentions stay unread in the board
    // without auto-spawning a turn until human releases control!
    if (target.humanControlled && message.senderKind !== 'human') {
      this.recordPendingMention(session.chatSessionId, target.rosterName, message.seq);
      return;
    }

    const isBusy =
      target.status === 'working' ||
      target.status === 'waiting_children' ||
      target.status === 'waiting_approval';

    if (isBusy) {
      // Invariant 3: Human `correction` steers active turn immediately; peer mentions queue cleanly!
      if (message.senderKind === 'human' && message.priority === 'correction') {
        void Promise.resolve(
          this.callbacks.onSteerMember({
            chatSessionId: session.chatSessionId,
            member: target,
            message,
          }),
        ).then((deliveredMidTurn) => {
          if (deliveredMidTurn) {
            // Advance lastSeenSeq ONLY if there were no older unread messages skipped.
            const fresh = this.storage.getSwarmMember(session.chatSessionId, target.rosterName);
            if (fresh && fresh.lastSeenSeq === message.seq - 1) {
              this.storage.upsertSwarmMember({
                chatSessionId: session.chatSessionId,
                rosterName: fresh.rosterName,
                agentId: fresh.agentId,
                lastSeenSeq: message.seq,
              });
              this.emitSwarmUpdated(session.chatSessionId);
            }
          } else {
            this.recordPendingMention(session.chatSessionId, target.rosterName, message.seq);
          }
        });
        return;
      }

      // Peer/coordinator message while working: leave lastSeenSeq behind so settleMemberTurn wakes at quiescence!
      this.recordPendingMention(session.chatSessionId, target.rosterName, message.seq);
      return;
    }

    // Target is `parked` (or resumable): schedule coalesced wakeup (0ms for human correction, 500ms for peer/worker)!
    this.recordPendingMention(session.chatSessionId, target.rosterName, message.seq);
    const triggeredByHuman = message.senderKind === 'human';
    const delayMs =
      triggeredByHuman && message.priority === 'correction' ? 0 : this.coalesceWindowMs;
    this.scheduleWake(session.chatSessionId, target.rosterName, 'mention', triggeredByHuman, delayMs);
  }

  private scheduleWake(
    chatSessionId: string,
    rosterName: string,
    reason: SwarmWakeRequest['reason'],
    triggeredByHuman: boolean,
    delayMs: number,
  ): void {
    if (this.disposed) return;
    const key = memberKey(chatSessionId, rosterName);
    const existing = this.pendingWakes.get(key);
    if (existing) {
      if (triggeredByHuman && !existing.triggeredByHuman) {
        // Upgrade pending peer wake to immediate human wake!
        clearTimeout(existing.timer);
        this.pendingWakes.delete(key);
      } else {
        // Coalesce into existing timer window so N simultaneous completions wake @coordinator once!
        return;
      }
    }

    const timer = setTimeout(() => {
      this.pendingWakes.delete(key);
      void this.executeScheduledWake(chatSessionId, rosterName, reason, triggeredByHuman);
    }, Math.max(0, delayMs));

    this.pendingWakes.set(key, {
      chatSessionId,
      rosterName,
      reason,
      triggeredByHuman,
      timer,
    });
  }

  private async executeScheduledWake(
    chatSessionId: string,
    rosterName: string,
    reason: SwarmWakeRequest['reason'],
    triggeredByHuman: boolean,
  ): Promise<void> {
    if (this.disposed) return;
    const session = this.storage.getSwarmSession(chatSessionId);
    if (!session || session.status !== 'active') return;

    const member = this.storage.getSwarmMember(chatSessionId, rosterName);
    if (!member) return;
    if (member.humanControlled && !triggeredByHuman) return;
    if (
      member.status === 'working' ||
      member.status === 'waiting_children' ||
      member.status === 'waiting_approval'
    ) {
      return;
    }

    // Anti-Ping-Pong Circuit Breaker (Spec §IV.5):
    // Autonomous agent-to-agent wakeups increment `autonomous_hops`; human wakeups do not.
    if (!triggeredByHuman) {
      if (session.autonomousHops >= session.maxAutonomousHops) {
        this.tripCircuitBreaker(session);
        return;
      }
      this.storage.updateSwarmSessionPatch(chatSessionId, {
        autonomousHops: session.autonomousHops + 1,
      });
    }

    const sinceSeq = member.lastSeenSeq;
    const deltaBoard = this.storage.readBoardMessages(chatSessionId, {
      sinceSeq,
      limit: 500,
    });
    const refreshedSession = this.storage.getSwarmSession(chatSessionId)!;
    const toSeq = refreshedSession.headSeq;

    // Mark member `working` and advance `lastSeenSeq` to `toSeq` atomically as delta is fed into the turn!
    const workingMember = this.storage.upsertSwarmMember({
      chatSessionId,
      rosterName: member.rosterName,
      agentId: member.agentId,
      status: 'working',
      lastSeenSeq: toSeq,
    });
    this.pendingMentionsByMember.delete(memberKey(chatSessionId, rosterName));
    this.emitSwarmUpdated(chatSessionId);

    try {
      await this.callbacks.onWakeMember({
        chatSessionId,
        member: workingMember,
        reason,
        sinceSeq,
        toSeq,
        messages: deltaBoard,
        triggeredByHuman,
      });
    } catch {
      // Revert `lastSeenSeq` on immediate spawn failure so unread messages are never lost!
      this.storage.upsertSwarmMember({
        chatSessionId,
        rosterName: member.rosterName,
        agentId: member.agentId,
        status: 'failed',
        lastSeenSeq: sinceSeq,
      });
      this.emitSwarmUpdated(chatSessionId);
    }
  }

  private tripCircuitBreaker(session: SwarmSessionRecord): void {
    this.cancelAllPendingWakesForSession(session.chatSessionId);
    this.storage.updateSwarmSessionPatch(session.chatSessionId, { status: 'paused' });
    const reason = `Swarm reached ${session.autonomousHops}/${session.maxAutonomousHops} autonomous hops without human input; paused to prevent ping-pong loops.`;
    this.callbacks.onEmitEvent?.({
      type: 'swarm_circuit_breaker',
      chatSessionId: session.chatSessionId,
      autonomousHops: session.autonomousHops,
      maxAutonomousHops: session.maxAutonomousHops,
      reason,
    });
    this.emitSwarmUpdated(session.chatSessionId);
  }

  /**
   * Stall Detector (Spec §IV.5):
   * When ALL non-stopped members are `parked`, swarm `status === 'active'`, and zero wakeups are
   * pending for this session, wakes `coordinator_agent` once for the current `headSeq` to synthesize
   * results, close out the swarm, or ask the human user.
   */
  private checkStallAndWakeCoordinatorIfNeeded(chatSessionId: string): void {
    if (this.disposed) return;
    const session = this.storage.getSwarmSession(chatSessionId);
    if (!session || session.status !== 'active') return;
    if (this.hasPendingWakeForSession(chatSessionId)) return;

    const members = this.storage.listSwarmMembers(chatSessionId);
    const activeRoster = members.filter((m) => m.status !== 'stopped');
    if (activeRoster.length === 0) return;

    const allParked = activeRoster.every((m) => m.status === 'parked');
    if (!allParked) return;

    // Do not re-wake coordinator repeatedly at the exact same headSeq if coordinator itself just parked!
    const lastStallSeq = this.lastStallWakeSeqBySession.get(chatSessionId);
    if (lastStallSeq === session.headSeq) return;

    const coordinator = members.find(
      (m) => normalizeHandle(m.rosterName) === normalizeHandle(session.coordinatorAgent),
    );
    if (!coordinator || coordinator.humanControlled || coordinator.status === 'stopped') return;

    this.lastStallWakeSeqBySession.set(chatSessionId, session.headSeq);
    this.scheduleWake(
      chatSessionId,
      coordinator.rosterName,
      'stall',
      false,
      Math.min(this.coalesceWindowMs, 50),
    );
  }

  private hasPendingWakeForSession(chatSessionId: string): boolean {
    for (const entry of this.pendingWakes.values()) {
      if (entry.chatSessionId === chatSessionId) return true;
    }
    return false;
  }

  private cancelPendingWake(key: string): void {
    const entry = this.pendingWakes.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      this.pendingWakes.delete(key);
    }
  }

  private cancelAllPendingWakesForSession(chatSessionId: string): void {
    for (const [key, entry] of [...this.pendingWakes.entries()]) {
      if (entry.chatSessionId === chatSessionId) {
        clearTimeout(entry.timer);
        this.pendingWakes.delete(key);
      }
    }
  }

  private emitSwarmUpdated(chatSessionId: string): void {
    const snapshot = this.getSnapshot(chatSessionId);
    if (snapshot) {
      this.callbacks.onEmitEvent?.({
        type: 'swarm_updated',
        chatSessionId,
        swarm: snapshot,
      });
    }
  }
}
