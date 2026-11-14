// workspace/coordinator.rs —— 多 Agent 协作工作区协调者。
import type {
  AgentRole, AgentStatus, JsonValue, MessageType, Workspace, WorkspaceAgent, WorkspaceContext,
  WorkspaceCoordinator as WorkspaceCoordinatorContract, WorkspaceDocument, WorkspaceMessage,
  WorkspaceWarningEvent,
} from '../../api.ts';
import path from 'node:path';
import type { SqlExecutor } from '../../../../platform/storage/api.ts';
import {
  deleteWorkspaceIndex, updateWorkspaceIndexStatus, upsertWorkspaceIndex,
} from '../../repository/chat-v2-repository.ts';
import { MAX_AGENTS_PER_WORKSPACE } from '../config.ts';
import { writeBytes as writeChangeSetBytes, type MutationReceipt } from '../workspace-change-set.ts';
import { InboxManager } from '../inbox.ts';
import { WorkspaceDatabase, WorkspaceDatabaseManager } from './database.ts';
import type { WorkspaceStoreIo } from './database.ts';
import { WorkspaceEmitter } from './emitter.ts';
import type { WorkspaceEventSink } from './emitter.ts';
import { WorkspaceRepo } from './repo.ts';
import { MessageRouter } from './router.ts';
import type { InboxOverflow } from './router.ts';
import { SleepManager } from './sleep-manager.ts';
import type { WakeResultInfo } from './sleep-manager.ts';
import { SubagentTaskManager } from './subagent-task.ts';
import {
  generateWorkspaceId, newWorkspace, newWorkspaceAgent, newWorkspaceContext,
} from './types.ts';
import { toRfc3339 as nowRfc3339 } from '../../../../platform/time/index.ts';
import {
  silentWorkspaceLogger, type WorkspaceLogger,
} from './logger.ts';

/** 数据治理操作守卫（`backup_common::DataGovernanceOperationGuard` 的可注入接缝）。 */
export interface DataGovernanceOperationGuard {
  release(): void;
}

export interface WorkspaceCoordinatorOptions {
  workspacesDir: string;
  io: WorkspaceStoreIo;
  /** 主 chat_v2 库执行器，用于同步 workspace_index 与清理关联会话。 */
  chatV2Db?: SqlExecutor | null;
  /** 事件出口（组合根注入 kernel emit；测试注入记录器）。 */
  emitter?: WorkspaceEventSink | null;
  /** 取得删除传播操作权；未接入治理服务时拒绝删除，不能伪造成功的 guard。 */
  operationGuard?: () => DataGovernanceOperationGuard;
  /** 永久删除 worker 会话前清理 runtime root（生产 = cleanup_session_runtime_roots）。 */
  runtimeRootCleanup?: (sessionId: string) => void;
  /** 永久删除 worker ChatSession（生产 = ChatV2Repo::delete_session_v2）。 */
  deleteChatSession?: (sessionId: string) => void;
  /** Rust `log::warn!` / `log::info!` 的出口；生产注入 kernel `ctx.logger`。 */
  logger?: WorkspaceLogger;
}

interface WorkspaceInstance {
  workspace: Workspace;
  db: WorkspaceDatabase;
  repo: WorkspaceRepo;
  inboxManager: InboxManager;
  router: MessageRouter;
  sleepManager: SleepManager;
  taskManager: SubagentTaskManager;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 每次访问都通过 `WorkspaceDatabase.getConnection()` 借连接，
 * 以保持维护模式下 fail-close、退出维护后自动重开的语义。
 */
function liveExecutor(db: WorkspaceDatabase): SqlExecutor {
  const borrow = (): SqlExecutor => db.getConnection();
  const call = (method: 'get' | 'one' | 'pluck' | 'all' | 'iterate' | 'run' | 'exec') =>
    (...args: unknown[]): unknown => {
      const target = borrow() as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>;
      const method_ = target[method];
      if (method_ === undefined) throw new Error(`SqlExecutor is missing method: ${method}`);
      return method_.apply(target, args);
    };
  return {
    get: call('get'),
    one: call('one'),
    pluck: call('pluck'),
    all: call('all'),
    iterate: call('iterate'),
    run: call('run'),
    exec: call('exec'),
  } as unknown as SqlExecutor;
}

export class WorkspaceCoordinator implements WorkspaceCoordinatorContract {
  private readonly workspacesDir: string;
  private readonly dbManager: WorkspaceDatabaseManager;
  private readonly instances = new Map<string, WorkspaceInstance>();
  private readonly chatV2Db: SqlExecutor | null;
  private readonly emitter: WorkspaceEmitter;
  private readonly acquireOperationGuard: () => DataGovernanceOperationGuard;
  private readonly runtimeRootCleanup: ((sessionId: string) => void) | null;
  private readonly deleteChatSession: ((sessionId: string) => void) | null;
  private readonly logger: WorkspaceLogger;

  constructor(options: WorkspaceCoordinatorOptions) {
    this.workspacesDir = options.workspacesDir;
    this.dbManager = new WorkspaceDatabaseManager(options.io, options.workspacesDir, options.logger);
    this.chatV2Db = options.chatV2Db ?? null;
    this.emitter = new WorkspaceEmitter(options.emitter ?? null, options.logger ?? silentWorkspaceLogger);
    this.logger = options.logger ?? silentWorkspaceLogger;
    this.acquireOperationGuard = options.operationGuard ?? (() => {
      throw new Error('Workspace deletion requires governance.acquireOperationGuard(DeletePropagation)');
    });
    this.runtimeRootCleanup = options.runtimeRootCleanup ?? null;
    this.deleteChatSession = options.deleteChatSession ?? null;
  }

  /** 自定义子代理定义目录：`{workspaces_dir}/agents/*.md`（契约 C6）。 */
  customAgentsDir(): string {
    return path.join(this.workspacesDir, 'agents');
  }

  /** 自定义子代理 persona 提案区：`{workspaces_dir}/agents-pending/`。 */
  customAgentsPendingDir(): string {
    return path.join(this.workspacesDir, 'agents-pending');
  }

  createWorkspace(creatorSessionId: string, name: string | null): Workspace {
    const workspaceId = generateWorkspaceId();
    const workspace = newWorkspace(workspaceId, creatorSessionId);
    workspace.name = name;

    const db = this.dbManager.getOrCreate(workspaceId);
    const repo = new WorkspaceRepo(liveExecutor(db), this.logger);
    repo.saveWorkspace(workspace);

    this.syncToIndex(workspace);

    const instance = this.buildInstance(workspace, db, repo);
    this.instances.set(workspaceId, instance);
    return { ...workspace };
  }

  getWorkspace(workspaceId: string): Workspace | null {
    const instance = this.instances.get(workspaceId);
    if (instance) return { ...instance.workspace };

    let db: WorkspaceDatabase;
    try {
      db = this.dbManager.getOrCreate(workspaceId);
    } catch {
      return null;
    }
    return new WorkspaceRepo(liveExecutor(db), this.logger).getWorkspace();
  }

  closeWorkspace(workspaceId: string): void {
    const removed = this.removeInstance(workspaceId);
    if (removed) {
      removed.sleepManager.cancelAllActive('workspace_closed');
      removed.repo.updateWorkspaceStatus('completed');
    } else {
      let instance: WorkspaceInstance | null = null;
      try {
        instance = this.getInstance(workspaceId);
      } catch {
        instance = null;
      }
      if (instance) {
        instance.sleepManager.cancelAllActive('workspace_closed');
        try {
          instance.repo.updateWorkspaceStatus('completed');
          // boundary-allow empty-catch: Rust `let _ = update_workspace_status`，关闭路径忽略失败
        } catch (error) {
          // Rust `let _ = ...`：关闭路径不因状态更新失败中断。
          void error;
        }
        this.removeInstance(workspaceId);
      }
    }
    this.dbManager.remove(workspaceId);

    this.updateIndexStatus(workspaceId, 'completed');
    this.emitter.emitWorkspaceClosed(workspaceId);
  }

  deleteWorkspace(workspaceId: string): void {
    const guard = this.acquireOperationGuard();
    try {
      let workerSessionIds: string[] = [];
      try {
        workerSessionIds = this.listAgents(workspaceId)
          .filter(agent => agent.role === 'worker')
          .map(agent => agent.sessionId);
      } catch {
        workerSessionIds = [];
      }

      this.closeWorkspace(workspaceId);
      this.dbManager.delete(workspaceId);
      this.removeFromIndex(workspaceId);
      this.cleanupAgentSessions(workerSessionIds);
    } finally {
      guard.release();
    }
  }

  registerAgent(
    workspaceId: string,
    sessionId: string,
    role: AgentRole,
    skillId: string | null,
    metadata: JsonValue | null,
  ): WorkspaceAgent {
    const instance = this.getInstance(workspaceId);

    // 配额只统计非终态 agent：已完成/失败/取消/quarantined 不占名额。
    const activeAgents = instance.repo.listAgents()
      .filter(agent => agent.status === 'idle' || agent.status === 'queued'
        || agent.status === 'running' || agent.status === 'interrupted')
      .length;
    if (activeAgents >= MAX_AGENTS_PER_WORKSPACE) {
      throw new Error(
        `Workspace has reached maximum active agent limit: ${MAX_AGENTS_PER_WORKSPACE}`,
      );
    }

    const agent = newWorkspaceAgent(sessionId, workspaceId, role);
    agent.skillId = skillId;
    if (metadata !== null) agent.metadata = metadata;
    instance.repo.saveAgent(agent);

    this.emitter.emitAgentJoined(workspaceId, agent);
    return agent;
  }

  unregisterAgent(workspaceId: string, sessionId: string): void {
    const instance = this.getInstance(workspaceId);
    instance.inboxManager.clear(sessionId);
    instance.repo.deleteAgent(sessionId);
    this.emitter.emitAgentLeft(workspaceId, sessionId);
  }

  updateAgentStatus(workspaceId: string, sessionId: string, status: AgentStatus): void {
    const instance = this.getInstance(workspaceId);
    instance.repo.updateAgentStatus(sessionId, status);
    this.emitter.emitAgentStatusChanged(workspaceId, sessionId, status);

    // worker 进入终态时尝试通过状态信号唤醒 coordinator。
    if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'closed') {
      try {
        const awakened = instance.sleepManager.checkAndWakeByAgentStatus(workspaceId, sessionId, status);
        for (const wakeInfo of awakened) this.emitWakeInfo(wakeInfo);
      } catch (error) {
        this.logger.warn(`[WorkspaceCoordinator] Failed to check wake-by-status condition: ${messageOf(error)}`);
      }
    }
  }

  listAgents(workspaceId: string): WorkspaceAgent[] {
    return this.getInstance(workspaceId).repo.listAgents();
  }

  getAgent(workspaceId: string, sessionId: string): WorkspaceAgent | null {
    return this.getInstance(workspaceId).repo.getAgent(sessionId);
  }

  updateAgentMetadata(workspaceId: string, sessionId: string, metadata: JsonValue | null): void {
    this.getInstance(workspaceId).repo.updateAgentMetadata(sessionId, metadata ?? undefined);
  }

  hasAgentSentMessageSince(workspaceId: string, agentSessionId: string, since: string): boolean {
    return this.getInstance(workspaceId).repo.hasAgentSentMessageSince(agentSessionId, since);
  }

  sendMessage(
    workspaceId: string,
    senderId: string,
    targetId: string | null,
    messageType: MessageType,
    content: string,
  ): WorkspaceMessage {
    const instance = this.getInstance(workspaceId);
    if (!this.isMemberOrCreator(instance, senderId)) {
      throw new Error('Permission denied: sender is not a workspace member');
    }
    if (targetId !== null && instance.repo.getAgent(targetId) === null) {
      throw new Error(`Target agent not found: ${targetId}`);
    }
    let normalizedType = messageType;
    if (targetId === null && normalizedType !== 'broadcast') {
      normalizedType = 'broadcast';
    }
    if (targetId !== null && normalizedType === 'broadcast') {
      throw new Error('Broadcast message must not specify target_session_id');
    }

    let message: WorkspaceMessage;
    let overflow: InboxOverflow[];
    if (targetId !== null) {
      const routed = instance.router.sendUnicast(workspaceId, senderId, targetId, normalizedType, content);
      message = routed.message;
      overflow = routed.overflow;
    } else {
      const routed = instance.router.sendBroadcast(workspaceId, senderId, normalizedType, content);
      message = routed.message;
      overflow = routed.overflow;
    }

    this.emitter.emitMessageReceived(workspaceId, message);
    if (overflow.length > 0) this.emitInboxOverflowWarning(workspaceId, overflow);

    try {
      const awakened = instance.sleepManager.checkAndWakeByMessage(message);
      for (const wakeInfo of awakened) this.emitWakeInfo(wakeInfo);
    } catch (error) {
      this.logger.warn(`[WorkspaceCoordinator] Failed to check wake condition: ${messageOf(error)}`);
    }

    return message;
  }

  /** 为已路由的消息附加协议元数据（运行时完成投递写关联标识）。 */
  updateMessageMetadata(workspaceId: string, messageId: string, metadata: JsonValue): void {
    this.getInstance(workspaceId).repo.updateMessageMetadata(messageId, metadata);
  }

  drainInbox(workspaceId: string, sessionId: string, limit: number): WorkspaceMessage[] {
    const instance = this.getInstance(workspaceId);
    const messageIds = instance.inboxManager.drain(sessionId, limit);
    if (messageIds.length === 0) return [];

    const messages: WorkspaceMessage[] = [];
    for (const messageId of messageIds) {
      const message = instance.repo.getMessage(messageId);
      if (message !== null) messages.push(message);
      // 即使消息体已不存在也要标记 processed，避免重启后重放悬空引用。
      instance.repo.markInboxProcessedByMessage(sessionId, messageId);
    }
    return messages;
  }

  /** 只读查看待消费消息（顺序与 drain 一致，不出队、不标记）。 */
  peekInbox(workspaceId: string, agentSessionId: string): WorkspaceMessage[] {
    const instance = this.getInstance(workspaceId);
    const messageIds = instance.inboxManager.peek(agentSessionId, Number.MAX_SAFE_INTEGER);
    const messages: WorkspaceMessage[] = [];
    for (const messageId of messageIds) {
      const message = instance.repo.getMessage(messageId);
      if (message !== null) messages.push(message);
    }
    return messages;
  }

  /** 契约 C12：inbox 中待消费（unread）的消息数（DB 为准）。 */
  pendingInboxCount(workspaceId: string, sessionId: string): number {
    return this.getInstance(workspaceId).repo.countUnreadInbox(sessionId);
  }

  hasPendingMessages(workspaceId: string, sessionId: string): boolean {
    const instance = this.instances.get(workspaceId);
    if (instance === undefined) return false;
    return !instance.inboxManager.isEmpty(sessionId);
  }

  /** 重新将消息加入 inbox 以便重试（队列满时拒绝并警告）。 */
  reEnqueueMessage(workspaceId: string, sessionId: string, messageId: string): void {
    const instance = this.getInstance(workspaceId);

    const pushResult = instance.inboxManager.push(sessionId, messageId);
    if (pushResult.rejectedMessageId !== null) {
      this.emitInboxOverflowWarning(workspaceId, [{
        targetSessionId: sessionId,
        rejectedMessageId: pushResult.rejectedMessageId,
      }]);
      throw new Error(
        `Agent inbox is full for ${sessionId}. Retry after the agent drains pending tasks.`,
      );
    }

    instance.repo.addToInbox(sessionId, messageId, 0);
  }

  setContext(workspaceId: string, key: string, value: JsonValue, updatedBy: string): void {
    const instance = this.getInstance(workspaceId);
    if (!this.canUpdateContext(instance, updatedBy)) {
      throw new Error('Permission denied: only coordinator can update workspace context');
    }
    const context = newWorkspaceContext(workspaceId, key, value, updatedBy);
    instance.repo.setContext(context);
  }

  getContext(workspaceId: string, key: string): WorkspaceContext | null {
    return this.getInstance(workspaceId).repo.getContext(key);
  }

  listContext(workspaceId: string): WorkspaceContext[] {
    return this.getInstance(workspaceId).repo.listContext();
  }

  saveDocument(workspaceId: string, doc: WorkspaceDocument): void {
    const instance = this.getInstance(workspaceId);
    instance.repo.saveDocument(doc);
    this.emitter.emitDocumentUpdated(workspaceId, doc);
  }

  getDocument(workspaceId: string, docId: string): WorkspaceDocument | null {
    return this.getInstance(workspaceId).repo.getDocument(docId);
  }

  listDocuments(workspaceId: string): WorkspaceDocument[] {
    return this.getInstance(workspaceId).repo.listDocuments();
  }

  listMessages(workspaceId: string, limit: number): WorkspaceMessage[] {
    return this.getInstance(workspaceId).repo.listMessages(limit);
  }

  /** 获取睡眠管理器（供 handler / 管线使用）。 */
  getSleepManager(workspaceId: string): SleepManager {
    return this.getInstance(workspaceId).sleepManager;
  }

  /** 获取子代理任务管理器。 */
  getTaskManager(workspaceId: string): SubagentTaskManager {
    return this.getInstance(workspaceId).taskManager;
  }

  /** 取消所有已加载工作区的未决睡眠（幂等）。 */
  /** Plugin unload: stop the sleep timeout timers, drop the cached instances and close the workspace databases this coordinator opened. */
  dispose(): void {
    for (const instance of this.instances.values()) instance.sleepManager.stopTimeoutTasks();
    this.instances.clear();
    this.dbManager.closeAll();
  }

  shutdownAllSleeps(): void {
    for (const instance of [...this.instances.values()]) {
      instance.sleepManager.cancelAllActive('app_shutdown');
    }
  }

  emitCoordinatorAwakened(info: WakeResultInfo): void {
    this.emitWakeInfo(info);
  }

  /** 对外校验：会话是否属于该工作区。 */
  ensureMemberOrCreator(workspaceId: string, sessionId: string): void {
    const instance = this.getInstance(workspaceId);
    if (!this.isMemberOrCreator(instance, sessionId)) {
      throw new Error('Permission denied: session is not a workspace member');
    }
  }

  /** 对外查询：会话是否属于该工作区。 */
  isMemberOrCreatorSession(workspaceId: string, sessionId: string): boolean {
    return this.isMemberOrCreator(this.getInstance(workspaceId), sessionId);
  }

  writeBytes(root: string, checkpointRoot: string, rootId: string, relativePath: string, content: Uint8Array,
    expectedCurrentHash: string | null): MutationReceipt {
    return writeChangeSetBytes(root, checkpointRoot, rootId, relativePath, content, expectedCurrentHash);
  }

  /** 递增消息重试次数（写入 metadata）。 */
  incrementMessageRetryCount(workspaceId: string, messageId: string): number {
    const instance = this.getInstance(workspaceId);
    const message = instance.repo.getMessage(messageId);
    if (message === null) throw new Error(`Message not found: ${messageId}`);

    const metadata: { [key: string]: JsonValue } =
      typeof message.metadata === 'object' && message.metadata !== null && !Array.isArray(message.metadata)
        ? { ...message.metadata }
        : {};
    const raw = metadata.retry_count;
    const current = typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : 0;
    const next = Math.min(current + 1, Number.MAX_SAFE_INTEGER);
    metadata.retry_count = next;
    instance.repo.updateMessageMetadata(messageId, metadata);
    return next;
  }

  /** 发射通用工作区警告事件。 */
  emitWarning(warning: WorkspaceWarningEvent): void {
    this.emitter.emitWarning(warning);
  }

  /** 已加载（内存中）工作区 ID 列表。 */
  loadedWorkspaceIds(): string[] {
    return [...this.instances.keys()];
  }

  /** 进入维护模式：暂停所有活跃工作区的数据库连接（全部成功或回滚）。 */
  async enterMaintenanceMode(): Promise<void> {
    this.dbManager.enterMaintenanceMode();
  }

  /** 退出维护模式：恢复所有活跃工作区的磁盘数据库连接。 */
  exitMaintenanceMode(): void {
    this.dbManager.exitMaintenanceMode();
  }

  /** 是否仍有已加载工作区处于排空/维护状态。 */
  isInMaintenanceMode(): boolean {
    return this.dbManager.isInMaintenanceMode();
  }

  private buildInstance(
    workspace: Workspace,
    db: WorkspaceDatabase,
    repo: WorkspaceRepo,
    inboxManager = new InboxManager(),
  ): WorkspaceInstance {
    const connection = liveExecutor(db);
    const router = new MessageRouter(repo, inboxManager);
    const sleepManager = new SleepManager(connection, message => this.logger.warn(message), message => this.logger.info(message));
    const taskManager = new SubagentTaskManager(connection);
    return { workspace, db, repo, inboxManager, router, sleepManager, taskManager };
  }

  private removeInstance(workspaceId: string): WorkspaceInstance | undefined {
    const instance = this.instances.get(workspaceId);
    if (instance) this.instances.delete(workspaceId);
    return instance;
  }

  private getInstance(workspaceId: string): WorkspaceInstance {
    const cached = this.instances.get(workspaceId);
    if (cached) return cached;

    const instance = this.loadInstance(workspaceId);
    this.instances.set(workspaceId, instance);
    return instance;
  }

  /** 从磁盘加载并初始化实例（含 inbox / sleep 恢复副作用）。 */
  private loadInstance(workspaceId: string): WorkspaceInstance {
    const db = this.dbManager.getOrCreate(workspaceId);
    const repo = new WorkspaceRepo(liveExecutor(db), this.logger);

    const workspace = repo.getWorkspace();
    if (workspace === null) throw new Error(`Workspace not found: ${workspaceId}`);

    const inboxManager = new InboxManager();
    try {
      const unreadItems = repo.getAllUnreadInbox();
      if (unreadItems.length > 0) {
        this.logger.info(`[WorkspaceCoordinator] Restoring ${unreadItems.length} unread inbox items for workspace ${workspaceId}`);
        inboxManager.restoreFromDb(unreadItems);
      }
    } catch (error) {
      this.logger.warn(`[WorkspaceCoordinator] Failed to restore inbox: ${messageOf(error)}`);
    }

    const instance = this.buildInstance(workspace, db, repo, inboxManager);

    try {
      instance.sleepManager.restoreAndActivateSleeps();
    } catch (error) {
      this.logger.warn(`[WorkspaceCoordinator] Failed to restore sleeps for workspace ${workspaceId}: ${messageOf(error)}`);
    }

    try {
      const tasks = instance.taskManager.getTasksToRestore();
      if (tasks.length > 0) {
        this.logger.info(`[WorkspaceCoordinator] Found ${tasks.length} subagent tasks to restore for workspace ${workspaceId}`);
      }
    } catch (error) {
      this.logger.warn(`[WorkspaceCoordinator] Failed to check tasks to restore: ${messageOf(error)}`);
    }

    return instance;
  }

  private syncToIndex(workspace: Workspace): void {
    const db = this.chatV2Db;
    if (db === null) return;
    try {
      upsertWorkspaceIndex(db, {
        id: workspace.id,
        name: workspace.name,
        status: workspace.status,
        creatorSessionId: workspace.creatorSessionId,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      });
    } catch (error) {
      throw new Error(`Failed to sync workspace to index: ${messageOf(error)}`);
    }
  }

  private removeFromIndex(workspaceId: string): void {
    const db = this.chatV2Db;
    if (db === null) return;
    try {
      deleteWorkspaceIndex(db, workspaceId);
    } catch (error) {
      throw new Error(`Failed to remove workspace from index: ${messageOf(error)}`);
    }
  }

  private updateIndexStatus(workspaceId: string, status: Workspace['status']): void {
    const db = this.chatV2Db;
    if (db === null) return;
    try {
      updateWorkspaceIndexStatus(db, workspaceId, status, nowRfc3339());
    } catch (error) {
      throw new Error(`Failed to update workspace status in index: ${messageOf(error)}`);
    }
  }

  private canUpdateContext(instance: WorkspaceInstance, sessionId: string): boolean {
    const agent = instance.repo.getAgent(sessionId);
    if (agent !== null && agent.role === 'coordinator') return true;
    const workspace = instance.repo.getWorkspace();
    return workspace !== null && workspace.creatorSessionId === sessionId;
  }

  private isMemberOrCreator(instance: WorkspaceInstance, sessionId: string): boolean {
    if (instance.repo.getAgent(sessionId) !== null) return true;
    const workspace = instance.repo.getWorkspace();
    return workspace !== null && workspace.creatorSessionId === sessionId;
  }

  /** inbox 溢出警告（按目标聚合并发射事件）。 */
  private emitInboxOverflowWarning(workspaceId: string, overflow: readonly InboxOverflow[]): void {
    if (overflow.length === 0) return;
    const byTarget = new Map<string, string[]>();
    for (const entry of overflow) {
      const dropped = byTarget.get(entry.targetSessionId) ?? [];
      dropped.push(entry.rejectedMessageId);
      byTarget.set(entry.targetSessionId, dropped);
    }

    for (const [targetSessionId, droppedIds] of byTarget) {
      this.emitter.emitWarning({
        workspace_id: workspaceId,
        code: 'inbox_full_rejected',
        message: `Agent ${targetSessionId} inbox is full: rejected ${droppedIds.length} new message(s). `
          + 'Wait for the worker to finish and retry.',
        agent_session_id: targetSessionId,
        message_id: droppedIds[droppedIds.length - 1] ?? null,
        retry_count: null,
        max_retries: null,
      });
    }
  }

  /** 清理关联的 worker ChatSession（runtime root + 会话记录）。 */
  private cleanupAgentSessions(workerSessionIds: readonly string[]): void {
    if (workerSessionIds.length === 0) return;
    if (this.chatV2Db === null) {
      throw new Error('工作区已删除，但 Chat V2 数据库不可用，关联 worker 会话未清理');
    }
    const errors: string[] = [];
    for (const sessionId of workerSessionIds) {
      if (this.runtimeRootCleanup === null) {
        errors.push(`${sessionId}: AppHandle 不可用，无法清理 runtime root`);
        continue;
      }
      try {
        this.runtimeRootCleanup(sessionId);
      } catch (error) {
        errors.push(`${sessionId}: runtime root 清理失败: ${messageOf(error)}`);
        continue;
      }
      if (this.deleteChatSession === null) {
        errors.push(`${sessionId}: worker 会话删除失败: deleteChatSession 未配置`);
        continue;
      }
      try {
        this.deleteChatSession(sessionId);
      } catch (error) {
        errors.push(`${sessionId}: worker 会话删除失败: ${messageOf(error)}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(`工作区已删除，但部分关联会话清理失败: ${errors.join('; ')}`);
    }
  }

  private emitWakeInfo(info: WakeResultInfo): void {
    this.emitter.emitCoordinatorAwakened(
      info.workspaceId,
      info.coordinatorSessionId,
      info.sleepId,
      info.awakenedBy,
      info.awakenMessage,
      info.wakeReason,
    );
  }
}
