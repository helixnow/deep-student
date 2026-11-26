/**
 * SQLite persistence for `dstu.agent-mesh` (WAL mode on disk, `:memory:` for unit tests).
 *
 * Uses `openStartupDatabase` from `host/platform/storage/node.ts` so `agent-mesh` shares
 * DeepStudent's canonical SQLite driver wrapper (`Connection`) without importing native
 * `better-sqlite3` directly across plugin boundaries.
 */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConnectionProfile, Row } from '../../../platform/storage/api.ts';
import { openStartupDatabase, type StartupDatabase } from '../../../platform/storage/node.ts';
import type {
  BoardMessagePriority,
  BoardSenderKind,
  CustomCliTemplate,
  CustomCliTemplateInput,
  MeshCheckpointRecord,
  MeshThreadRecord,
  MeshThreadStatus,
  PeerExchangeKind,
  PeerExchangeRecord,
  PeerExchangeStatus,
  SwarmBoardMessage,
  SwarmMemberRecord,
  SwarmMemberStatus,
  SwarmSessionRecord,
  SwarmSessionStatus,
  WorkspaceBindingRecord,
} from './contracts.ts';

const AGENT_MESH_PROFILE: ConnectionProfile = Object.freeze({
  foreignKeys: true,
  journalMode: 'WAL',
  synchronous: 'NORMAL',
  busyTimeoutMs: 5_000,
});

// boundary-allow sql-outside-repository: self-contained agent-mesh SQLite schema DDL owned by storage.ts
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS mesh_workspace_bindings (
  chat_session_id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mesh_threads (
  thread_id TEXT PRIMARY KEY,
  chat_session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  roster_name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  external_session_id TEXT,
  status TEXT NOT NULL,
  human_controlled INTEGER NOT NULL DEFAULT 0,
  last_checkpoint_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_mesh_threads_session ON mesh_threads(chat_session_id, created_at);

CREATE TABLE IF NOT EXISTS mesh_peer_exchanges (
  id TEXT PRIMARY KEY,
  chat_session_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  question_or_summary TEXT NOT NULL,
  response_text TEXT,
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mesh_peer_exchanges_session ON mesh_peer_exchanges(chat_session_id, created_at);

CREATE TABLE IF NOT EXISTS mesh_swarm_sessions (
  chat_session_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  coordinator_agent TEXT NOT NULL,
  autonomous_hops INTEGER NOT NULL DEFAULT 0,
  max_autonomous_hops INTEGER NOT NULL DEFAULT 12,
  head_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mesh_swarm_members (
  chat_session_id TEXT NOT NULL,
  roster_name TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role_title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  thread_id TEXT,
  external_session_id TEXT,
  last_seen_seq INTEGER NOT NULL DEFAULT 0,
  owned_globs_json TEXT NOT NULL DEFAULT '[]',
  human_controlled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_session_id, roster_name)
);

CREATE TABLE IF NOT EXISTS mesh_swarm_board (
  chat_session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  sender TEXT NOT NULL,
  sender_kind TEXT NOT NULL,
  priority TEXT NOT NULL,
  text TEXT NOT NULL,
  mentions_json TEXT NOT NULL DEFAULT '[]',
  channel TEXT NOT NULL DEFAULT 'general',
  reply_to_seq INTEGER,
  diff_ref TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (chat_session_id, seq)
);

CREATE TABLE IF NOT EXISTS mesh_custom_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '[]',
  resume_args_json TEXT NOT NULL DEFAULT '[]',
  env_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mesh_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  chat_session_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  roster_name TEXT,
  root_path TEXT NOT NULL,
  turn_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  is_git INTEGER NOT NULL DEFAULT 0,
  post_turn_hashes_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mesh_checkpoints_session ON mesh_checkpoints(chat_session_id, turn_seq);
`;

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJsonStringRecord(raw: unknown): Record<string, string> {
  const obj = parseJsonObject(raw);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function parseJsonStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function rowToWorkspaceBinding(row: Row): WorkspaceBindingRecord {
  return {
    chatSessionId: String(row.chat_session_id),
    rootPath: String(row.root_path),
    updatedAt: String(row.updated_at),
  };
}

function rowToThread(row: Row): MeshThreadRecord {
  return {
    threadId: String(row.thread_id),
    chatSessionId: String(row.chat_session_id),
    agentId: String(row.agent_id),
    rosterName: String(row.roster_name),
    rootPath: String(row.root_path),
    externalSessionId: row.external_session_id === null ? null : String(row.external_session_id),
    status: String(row.status) as MeshThreadStatus,
    humanControlled: Number(row.human_controlled) !== 0,
    lastCheckpointId: row.last_checkpoint_id === null ? null : String(row.last_checkpoint_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    meta: parseJsonObject(row.meta_json),
  };
}

function rowToPeerExchange(row: Row): PeerExchangeRecord {
  return {
    id: String(row.id),
    chatSessionId: String(row.chat_session_id),
    fromAgent: String(row.from_agent),
    toAgent: String(row.to_agent),
    kind: String(row.kind) as PeerExchangeKind,
    questionOrSummary: String(row.question_or_summary),
    responseText: row.response_text === null ? null : String(row.response_text),
    changedFiles: parseJsonStringArray(row.changed_files_json),
    status: String(row.status) as PeerExchangeStatus,
    createdAt: String(row.created_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
  };
}

function rowToSwarmSession(row: Row): SwarmSessionRecord {
  return {
    chatSessionId: String(row.chat_session_id),
    title: String(row.title),
    goal: String(row.goal),
    status: String(row.status) as SwarmSessionStatus,
    coordinatorAgent: String(row.coordinator_agent),
    autonomousHops: Number(row.autonomous_hops),
    maxAutonomousHops: Number(row.max_autonomous_hops),
    headSeq: Number(row.head_seq),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToSwarmMember(row: Row): SwarmMemberRecord {
  return {
    chatSessionId: String(row.chat_session_id),
    rosterName: String(row.roster_name),
    agentId: String(row.agent_id),
    roleTitle: String(row.role_title ?? ''),
    status: String(row.status) as SwarmMemberStatus,
    threadId: row.thread_id === null ? null : String(row.thread_id),
    externalSessionId: row.external_session_id === null ? null : String(row.external_session_id),
    lastSeenSeq: Number(row.last_seen_seq),
    ownedGlobs: parseJsonStringArray(row.owned_globs_json),
    humanControlled: Number(row.human_controlled) !== 0,
  };
}

function rowToBoardMessage(row: Row): SwarmBoardMessage {
  return {
    chatSessionId: String(row.chat_session_id),
    seq: Number(row.seq),
    sender: String(row.sender),
    senderKind: String(row.sender_kind) as BoardSenderKind,
    priority: String(row.priority) as BoardMessagePriority,
    text: String(row.text),
    mentions: parseJsonStringArray(row.mentions_json),
    channel: String(row.channel ?? 'general'),
    replyToSeq: row.reply_to_seq === null ? null : Number(row.reply_to_seq),
    diffRef: row.diff_ref === null ? null : String(row.diff_ref),
    createdAt: String(row.created_at),
  };
}

function rowToCustomTemplate(row: Row): CustomCliTemplate {
  return {
    id: String(row.id),
    name: String(row.name),
    command: String(row.command),
    args: parseJsonStringArray(row.args_json),
    resumeArgs: parseJsonStringArray(row.resume_args_json),
    env: parseJsonStringRecord(row.env_json),
    updatedAt: String(row.updated_at),
  };
}

function rowToCheckpoint(row: Row): MeshCheckpointRecord {
  return {
    checkpointId: String(row.checkpoint_id),
    chatSessionId: String(row.chat_session_id),
    threadId: String(row.thread_id),
    agentId: String(row.agent_id),
    rosterName: row.roster_name === null ? null : String(row.roster_name),
    rootPath: String(row.root_path),
    turnSeq: Number(row.turn_seq),
    kind: String(row.kind) as 'before' | 'after',
    ref: String(row.ref),
    isGit: Number(row.is_git) !== 0,
    postTurnHashes: parseJsonStringRecord(row.post_turn_hashes_json),
    createdAt: String(row.created_at),
  };
}

export interface AgentMeshStorageOptions {
  /** Directory containing `agent-mesh.db`, or omit when `inMemory: true` / `dbPath` is supplied. */
  appDataDir?: string;
  /** Explicit SQLite file path or `:memory:`. */
  dbPath?: string;
  /** Opens an isolated `:memory:` database for deterministic tests. */
  inMemory?: boolean;
}

export class AgentMeshStorage {
  readonly dbPath: string;
  private readonly db: StartupDatabase;
  private closed = false;

  constructor(options: AgentMeshStorageOptions = {}) {
    if (options.inMemory === true || options.dbPath === ':memory:') {
      this.dbPath = ':memory:';
    } else if (options.dbPath) {
      this.dbPath = options.dbPath;
    } else if (options.appDataDir) {
      this.dbPath = join(options.appDataDir, 'agent-mesh.db');
    } else {
      this.dbPath = ':memory:';
    }
    this.db = openStartupDatabase(this.dbPath, {
      label: 'agent-mesh',
      profile: AGENT_MESH_PROFILE,
    });
    this.db.exec(SCHEMA_DDL);
  }

  runImmediateTransaction<T>(work: () => T): T {
    if (this.db.inTransaction) {
      return work();
    }
    this.db.begin('immediate');
    try {
      const value = work();
      this.db.commit();
      return value;
    } catch (error) {
      this.db.rollback();
      throw error;
    }
  }

  // ---- Workspace Bindings ---------------------------------------------------

  getWorkspaceBinding(chatSessionId: string): WorkspaceBindingRecord | null {
    // boundary-allow sql-outside-repository: agent-mesh SQLite query
    const row = this.db.get('SELECT * FROM mesh_workspace_bindings WHERE chat_session_id = ?', [chatSessionId]);
    return row ? rowToWorkspaceBinding(row) : null;
  }

  setWorkspaceBinding(chatSessionId: string, rootPath: string | null): WorkspaceBindingRecord | null {
    if (rootPath === null || rootPath.trim() === '') {
      // boundary-allow sql-outside-repository: agent-mesh SQLite delete
      this.db.run('DELETE FROM mesh_workspace_bindings WHERE chat_session_id = ?', [chatSessionId]);
      return null;
    }
    const cleanRoot = rootPath.trim();
    const updatedAt = new Date().toISOString();
    this.db.run(
      // boundary-allow sql-outside-repository: agent-mesh SQLite upsert
      `INSERT INTO mesh_workspace_bindings (chat_session_id, root_path, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(chat_session_id) DO UPDATE SET root_path = excluded.root_path, updated_at = excluded.updated_at`,
      [chatSessionId, cleanRoot, updatedAt],
    );
    return { chatSessionId, rootPath: cleanRoot, updatedAt };
  }

  // ---- Threads --------------------------------------------------------------

  upsertThread(input: {
    threadId: string;
    chatSessionId: string;
    agentId: string;
    rosterName: string;
    rootPath: string;
    externalSessionId?: string | null;
    status: MeshThreadStatus;
    humanControlled?: boolean;
    lastCheckpointId?: string | null;
    createdAt?: string;
    updatedAt?: string;
    meta?: Record<string, unknown>;
  }): MeshThreadRecord {
    const existing = this.getThread(input.threadId);
    const now = new Date().toISOString();
    const createdAt = existing?.createdAt ?? input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? now;
    const externalSessionId =
      input.externalSessionId !== undefined ? input.externalSessionId : (existing?.externalSessionId ?? null);
    const humanControlled =
      input.humanControlled !== undefined ? input.humanControlled : (existing?.humanControlled ?? false);
    const lastCheckpointId =
      input.lastCheckpointId !== undefined ? input.lastCheckpointId : (existing?.lastCheckpointId ?? null);
    const meta = input.meta !== undefined ? input.meta : (existing?.meta ?? {});

    this.db.run(
      // boundary-allow sql-outside-repository: agent-mesh SQLite upsert
      `INSERT INTO mesh_threads (
        thread_id, chat_session_id, agent_id, roster_name, root_path,
        external_session_id, status, human_controlled, last_checkpoint_id,
        created_at, updated_at, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        agent_id = excluded.agent_id,
        roster_name = excluded.roster_name,
        root_path = excluded.root_path,
        external_session_id = excluded.external_session_id,
        status = excluded.status,
        human_controlled = excluded.human_controlled,
        last_checkpoint_id = excluded.last_checkpoint_id,
        updated_at = excluded.updated_at,
        meta_json = excluded.meta_json`,
      [
        input.threadId,
        input.chatSessionId,
        input.agentId,
        input.rosterName,
        input.rootPath,
        externalSessionId,
        input.status,
        humanControlled ? 1 : 0,
        lastCheckpointId,
        createdAt,
        updatedAt,
        JSON.stringify(meta),
      ],
    );
    return this.getThread(input.threadId)!;
  }

  getThread(threadId: string): MeshThreadRecord | null {
    // boundary-allow sql-outside-repository: agent-mesh SQLite query
    const row = this.db.get('SELECT * FROM mesh_threads WHERE thread_id = ?', [threadId]);
    return row ? rowToThread(row) : null;
  }

  listThreadsBySession(chatSessionId: string): MeshThreadRecord[] {
    const rows = this.db.all(
      // boundary-allow sql-outside-repository: agent-mesh SQLite query
      'SELECT * FROM mesh_threads WHERE chat_session_id = ? ORDER BY created_at ASC, thread_id ASC',
      [chatSessionId],
    );
    return rows.map(rowToThread);
  }

  findLatestThreadForAgent(
    chatSessionId: string,
    agentOrRoster: string,
  ): MeshThreadRecord | null {
    const row = this.db.get(
      // boundary-allow sql-outside-repository: agent-mesh SQLite query
      `SELECT * FROM mesh_threads
       WHERE chat_session_id = ? AND (roster_name = ? OR agent_id = ?)
       ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
      [chatSessionId, agentOrRoster, agentOrRoster],
    );
    return row ? rowToThread(row) : null;
  }

  updateThreadPatch(
    threadId: string,
    patch: {
      status?: MeshThreadStatus;
      externalSessionId?: string | null;
      humanControlled?: boolean;
      lastCheckpointId?: string | null;
      meta?: Record<string, unknown>;
    },
  ): MeshThreadRecord | null {
    const existing = this.getThread(threadId);
    if (!existing) return null;
    return this.upsertThread({
      threadId: existing.threadId,
      chatSessionId: existing.chatSessionId,
      agentId: existing.agentId,
      rosterName: existing.rosterName,
      rootPath: existing.rootPath,
      externalSessionId: patch.externalSessionId !== undefined ? patch.externalSessionId : existing.externalSessionId,
      status: patch.status ?? existing.status,
      humanControlled: patch.humanControlled !== undefined ? patch.humanControlled : existing.humanControlled,
      lastCheckpointId: patch.lastCheckpointId !== undefined ? patch.lastCheckpointId : existing.lastCheckpointId,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
      meta: patch.meta ?? existing.meta,
    });
  }

  /**
   * Startup crash reconciliation (Spec §IV.7): transitions any orphaned active threads and
   * swarm members back to `'stopped'` while preserving `external_session_id` for `--resume`.
   */
  reconcileOrphanedActiveRecords(): { threadsReconciled: number; membersReconciled: number } {
    return this.runImmediateTransaction(() => {
      const now = new Date().toISOString();
      const threadRes = this.db.run(
        // boundary-allow sql-outside-repository: agent-mesh startup reconciliation update
        `UPDATE mesh_threads
         SET status = 'stopped', updated_at = ?
         WHERE status IN ('running', 'working', 'waiting_children', 'waiting_approval')`,
        [now],
      );
      const memberRes = this.db.run(
        // boundary-allow sql-outside-repository: agent-mesh startup reconciliation update
        `UPDATE mesh_swarm_members
         SET status = 'stopped'
         WHERE status IN ('working', 'waiting_children', 'waiting_approval')`,
      );
      return {
        threadsReconciled: threadRes.changes,
        membersReconciled: memberRes.changes,
      };
    });
  }

  // ---- Peer Exchanges -------------------------------------------------------

  createPeerExchange(input: {
    id?: string;
    chatSessionId: string;
    fromAgent: string;
    toAgent: string;
    kind: PeerExchangeKind;
    questionOrSummary: string;
    changedFiles?: string[];
    status?: PeerExchangeStatus;
  }): PeerExchangeRecord {
    const id = input.id ?? `peer_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const status = input.status ?? 'running';
    this.db.run(
      // boundary-allow sql-outside-repository: agent-mesh SQLite insert
      `INSERT INTO mesh_peer_exchanges (
        id, chat_session_id, from_agent, to_agent, kind,
        question_or_summary, response_text, changed_files_json, status, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.chatSessionId,
        input.fromAgent,
        input.toAgent,
        input.kind,
        input.questionOrSummary,
        null,
        JSON.stringify(input.changedFiles ?? []),
        status,
        createdAt,
        status === 'completed' || status === 'failed' ? createdAt : null,
      ],
    );
    return this.getPeerExchange(id)!;
  }

  completePeerExchange(
    id: string,
    patch: {
      responseText?: string | null;
      changedFiles?: string[];
      status: 'completed' | 'failed';
    },
  ): PeerExchangeRecord | null {
    const existing = this.getPeerExchange(id);
    if (!existing) return null;
    const completedAt = new Date().toISOString();
    this.db.run(
      // boundary-allow sql-outside-repository: agent-mesh SQLite update
      `UPDATE mesh_peer_exchanges
       SET response_text = ?, changed_files_json = ?, status = ?, completed_at = ?
       WHERE id = ?`,
      [
        patch.responseText !== undefined ? patch.responseText : existing.responseText,
        JSON.stringify(patch.changedFiles ?? existing.changedFiles),
        patch.status,
        completedAt,
        id,
      ],
    );
    return this.getPeerExchange(id);
  }

  getPeerExchange(id: string): PeerExchangeRecord | null {
    // boundary-allow sql-outside-repository: agent-mesh SQLite query
    const row = this.db.get('SELECT * FROM mesh_peer_exchanges WHERE id = ?', [id]);
    return row ? rowToPeerExchange(row) : null;
  }

  listPeerExchangesBySession(chatSessionId: string): PeerExchangeRecord[] {
    const rows = this.db.all(
      // boundary-allow sql-outside-repository: agent-mesh SQLite query
      'SELECT * FROM mesh_peer_exchanges WHERE chat_session_id = ? ORDER BY created_at ASC, id ASC',
      [chatSessionId],
    );
    return rows.map(rowToPeerExchange);
  }

  // ---- Swarm Sessions, Members & Board --------------------------------------

  getSwarmSession(chatSessionId: string): SwarmSessionRecord | null {
    // boundary-allow sql-outside-repository: agent-mesh SQLite query
    const row = this.db.get('SELECT * FROM mesh_swarm_sessions WHERE chat_session_id = ?', [chatSessionId]);
    return row ? rowToSwarmSession(row) : null;
  }

  upsertSwarmSession(input: {
    chatSessionId: string;
    title: string;
    goal: string;
    status?: SwarmSessionStatus;
    coordinatorAgent?: string;
    autonomousHops?: number;
    maxAutonomousHops?: number;
  }): SwarmSessionRecord {
    const existing = this.getSwarmSession(input.chatSessionId);
    const now = new Date().toISOString();
    const createdAt = existing?.createdAt ?? now;
    const status = input.status ?? existing?.status ?? 'active';
    const coordinatorAgent = input.coordinatorAgent ?? existing?.coordinatorAgent ?? 'deepstudent';
    const autonomousHops = input.autonomousHops ?? existing?.autonomousHops ?? 0;
    const maxAutonomousHops = input.maxAutonomousHops ?? existing?.maxAutonomousHops ?? 12;
    const headSeq = existing?.headSeq ?? 0;

    this.db.run(
      // boundary-allow sql-outside-repository: agent-mesh SQLite upsert
      `INSERT INTO mesh_swarm_sessions (
        chat_session_id, title, goal, status, coordinator_agent,
        autonomous_hops, max_autonomous_hops, head_seq, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_session_id) DO UPDATE SET
        title = excluded.title,
        goal = excluded.goal,
        status = excluded.status,
        coordinator_agent = excluded.coordinator_agent,
        autonomous_hops = excluded.autonomous_hops,
        max_autonomous_hops = excluded.max_autonomous_hops,
        updated_at = excluded.updated_at`,
      [
        input.chatSessionId,
        input.title,
        input.goal,
        status,
        coordinatorAgent,
        autonomousHops,
        maxAutonomousHops,
        headSeq,
        createdAt,
        now,
      ],
    );
    return this.getSwarmSession(input.chatSessionId)!;
  }

  updateSwarmSessionPatch(
    chatSessionId: string,
    patch: {
      title?: string;
      goal?: string;
      status?: SwarmSessionStatus;
      coordinatorAgent?: string;
      autonomousHops?: number;
      maxAutonomousHops?: number;
    },
  ): SwarmSessionRecord | null {
    const existing = this.getSwarmSession(chatSessionId);
    if (!existing) return null;
    return this.upsertSwarmSession({
      chatSessionId,
      title: patch.title ?? existing.title,
      goal: patch.goal ?? existing.goal,
      status: patch.status ?? existing.status,
      coordinatorAgent: patch.coordinatorAgent ?? existing.coordinatorAgent,
      autonomousHops: patch.autonomousHops !== undefined ? patch.autonomousHops : existing.autonomousHops,
      maxAutonomousHops: patch.maxAutonomousHops !== undefined ? patch.maxAutonomousHops : existing.maxAutonomousHops,
    });
  }

  upsertSwarmMember(input: {
    chatSessionId: string;
    rosterName: string;
    agentId: string;
    roleTitle?: string;
    status?: SwarmMemberStatus;
    threadId?: string | null;
    externalSessionId?: string | null;
    lastSeenSeq?: number;
    ownedGlobs?: string[];
    humanControlled?: boolean;
  }): SwarmMemberRecord {
    const existing = this.getSwarmMember(input.chatSessionId, input.rosterName);
    const roleTitle = input.roleTitle !== undefined ? input.roleTitle : (existing?.roleTitle ?? '');
    const status = input.status ?? existing?.status ?? 'parked';
    const threadId = input.threadId !== undefined ? input.threadId : (existing?.threadId ?? null);
    const externalSessionId =
      input.externalSessionId !== undefined ? input.externalSessionId : (existing?.externalSessionId ?? null);
    const lastSeenSeq = input.lastSeenSeq !== undefined ? input.lastSeenSeq : (existing?.lastSeenSeq ?? 0);
    const ownedGlobs = input.ownedGlobs !== undefined ? input.ownedGlobs : (existing?.ownedGlobs ?? []);
    const humanControlled =
      input.humanControlled !== undefined ? input.humanControlled : (existing?.humanControlled ?? false);

    this.db.run(
      // boundary-allow sql-outside-repository: agent-mesh SQLite upsert
      `INSERT INTO mesh_swarm_members (
        chat_session_id, roster_name, agent_id, role_title, status,
        thread_id, external_session_id, last_seen_seq, owned_globs_json, human_controlled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_session_id, roster_name) DO UPDATE SET
        agent_id = excluded.agent_id,
        role_title = excluded.role_title,
        status = excluded.status,
        thread_id = excluded.thread_id,
        external_session_id = excluded.external_session_id,
        last_seen_seq = excluded.last_seen_seq,
        owned_globs_json = excluded.owned_globs_json,
        human_controlled = excluded.human_controlled`,
      [
        input.chatSessionId,
        input.rosterName,
        input.agentId,
        roleTitle,
        status,
        threadId,
        externalSessionId,
        lastSeenSeq,
        JSON.stringify(ownedGlobs),
        humanControlled ? 1 : 0,
      ],
    );
    return this.getSwarmMember(input.chatSessionId, input.rosterName)!;
  }

  getSwarmMember(chatSessionId: string, rosterName: string): SwarmMemberRecord | null {
    const row = this.db.get(
      // boundary-allow sql-outside-repository: agent-mesh SQLite query
      'SELECT * FROM mesh_swarm_members WHERE chat_session_id = ? AND roster_name = ?',
      [chatSessionId, rosterName],
    );
    return row ? rowToSwarmMember(row) : null;
  }

  listSwarmMembers(chatSessionId: string): SwarmMemberRecord[] {
    const rows = this.db.all(
      // boundary-allow sql-outside-repository: agent-mesh SQLite query
      'SELECT * FROM mesh_swarm_members WHERE chat_session_id = ? ORDER BY rowid ASC',
      [chatSessionId],
    );
    return rows.map(rowToSwarmMember);
  }

  appendBoardMessage(input: {
    chatSessionId: string;
    sender: string;
    senderKind: BoardSenderKind;
    priority: BoardMessagePriority;
    text: string;
    mentions: string[];
    channel?: string;
    replyToSeq?: number | null;
    diffRef?: string | null;
  }): SwarmBoardMessage {
    return this.runImmediateTransaction(() => {
      let session = this.getSwarmSession(input.chatSessionId);
      if (!session) {
        session = this.upsertSwarmSession({
          chatSessionId: input.chatSessionId,
          title: 'Swarm Collaboration',
          goal: '',
          status: 'active',
        });
      }
      const nextSeq = session.headSeq + 1;
      const now = new Date().toISOString();
      const nextAutonomousHops = input.senderKind === 'human' ? 0 : session.autonomousHops;

      this.db.run(
        // boundary-allow sql-outside-repository: agent-mesh SQLite atomic head_seq advance
        `UPDATE mesh_swarm_sessions
         SET head_seq = ?, autonomous_hops = ?, updated_at = ?
         WHERE chat_session_id = ?`,
        [nextSeq, nextAutonomousHops, now, input.chatSessionId],
      );

      this.db.run(
        // boundary-allow sql-outside-repository: agent-mesh SQLite board insert
        `INSERT INTO mesh_swarm_board (
          chat_session_id, seq, sender, sender_kind, priority, text,
          mentions_json, channel, reply_to_seq, diff_ref, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.chatSessionId,
          nextSeq,
          input.sender,
          input.senderKind,
          input.priority,
          input.text,
          JSON.stringify(input.mentions),
          input.channel ?? 'general',
          input.replyToSeq ?? null,
          input.diffRef ?? null,
          now,
        ],
      );

      const row = this.db.one(
        // boundary-allow sql-outside-repository: agent-mesh SQLite query
        'SELECT * FROM mesh_swarm_board WHERE chat_session_id = ? AND seq = ?',
        [input.chatSessionId, nextSeq],
      );
      return rowToBoardMessage(row);
    });
  }

  readBoardMessages(
    chatSessionId: string,
    options: { sinceSeq?: number; limit?: number } = {},
  ): SwarmBoardMessage[] {
    const sinceSeq = options.sinceSeq ?? 0;
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    if (options.sinceSeq !== undefined) {
      const rows = this.db.all(
        // boundary-allow sql-outside-repository: agent-mesh SQLite delta board read
        `SELECT * FROM mesh_swarm_board
         WHERE chat_session_id = ? AND seq > ?
         ORDER BY seq ASC LIMIT ?`,
        [chatSessionId, sinceSeq, limit],
      );
      return rows.map(rowToBoardMessage);
    }
    const rows = this.db.all(
      // boundary-allow sql-outside-repository: agent-mesh SQLite recent board read
      `SELECT * FROM (
         SELECT * FROM mesh_swarm_board
         WHERE chat_session_id = ?
         ORDER BY seq DESC LIMIT ?
       ) ORDER BY seq ASC`,
      [chatSessionId, limit],
    );
    return rows.map(rowToBoardMessage);
  }

  // ---- Checkpoints ----------------------------------------------------------

  saveCheckpoint(record: MeshCheckpointRecord): MeshCheckpointRecord {
    this.db.run(
      // boundary-allow sql-outside-repository: agent-mesh SQLite checkpoint insert
      `INSERT INTO mesh_checkpoints (
        checkpoint_id, chat_session_id, thread_id, agent_id, roster_name,
        root_path, turn_seq, kind, ref, is_git, post_turn_hashes_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(checkpoint_id) DO UPDATE SET
        ref = excluded.ref,
        post_turn_hashes_json = excluded.post_turn_hashes_json`,
      [
        record.checkpointId,
        record.chatSessionId,
        record.threadId,
        record.agentId,
        record.rosterName ?? null,
        record.rootPath,
        record.turnSeq,
        record.kind,
        record.ref,
        record.isGit ? 1 : 0,
        JSON.stringify(record.postTurnHashes ?? {}),
        record.createdAt,
      ],
    );
    return this.getCheckpoint(record.checkpointId)!;
  }

  getCheckpoint(checkpointId: string): MeshCheckpointRecord | null {
    // boundary-allow sql-outside-repository: agent-mesh SQLite query
    const row = this.db.get('SELECT * FROM mesh_checkpoints WHERE checkpoint_id = ?', [checkpointId]);
    return row ? rowToCheckpoint(row) : null;
  }

  listCheckpointsBySession(chatSessionId: string): MeshCheckpointRecord[] {
    const rows = this.db.all(
      // boundary-allow sql-outside-repository: agent-mesh SQLite query
      'SELECT * FROM mesh_checkpoints WHERE chat_session_id = ? ORDER BY turn_seq ASC, created_at ASC',
      [chatSessionId],
    );
    return rows.map(rowToCheckpoint);
  }

  // ---- Custom CLI Templates -------------------------------------------------

  listCustomTemplates(): CustomCliTemplate[] {
    // boundary-allow sql-outside-repository: agent-mesh SQLite query
    const rows = this.db.all('SELECT * FROM mesh_custom_templates ORDER BY updated_at DESC, name ASC');
    return rows.map(rowToCustomTemplate);
  }

  getCustomTemplate(id: string): CustomCliTemplate | null {
    // boundary-allow sql-outside-repository: agent-mesh SQLite query
    const row = this.db.get('SELECT * FROM mesh_custom_templates WHERE id = ?', [id]);
    return row ? rowToCustomTemplate(row) : null;
  }

  saveCustomTemplate(input: CustomCliTemplateInput): CustomCliTemplate {
    const cleanName = input.name.trim();
    const cleanCommand = input.command.trim();
    if (!cleanName || !cleanCommand) {
      throw new Error('AGENT_MESH_INVALID_TEMPLATE: name and command are required');
    }
    const id = input.id?.trim() || `tpl_${randomUUID()}`;
    const updatedAt = new Date().toISOString();
    this.db.run(
      // boundary-allow sql-outside-repository: agent-mesh SQLite upsert
      `INSERT INTO mesh_custom_templates (
        id, name, command, args_json, resume_args_json, env_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        command = excluded.command,
        args_json = excluded.args_json,
        resume_args_json = excluded.resume_args_json,
        env_json = excluded.env_json,
        updated_at = excluded.updated_at`,
      [
        id,
        cleanName,
        cleanCommand,
        JSON.stringify(input.args ?? []),
        JSON.stringify(input.resumeArgs ?? []),
        JSON.stringify(input.env ?? {}),
        updatedAt,
      ],
    );
    return this.getCustomTemplate(id)!;
  }

  deleteCustomTemplate(id: string): boolean {
    // boundary-allow sql-outside-repository: agent-mesh SQLite delete
    const res = this.db.run('DELETE FROM mesh_custom_templates WHERE id = ?', [id]);
    return res.changes > 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
