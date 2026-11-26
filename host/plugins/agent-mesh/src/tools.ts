/**
 * Built-in `AgentToolExecutor` for `dstu.agent-mesh` (`mesh_delegate_agent`, `mesh_ask_peer`,
 * `mesh_handoff`, `mesh_swarm_control`, `mesh_inspect_changes`).
 *
 * Registered via `ctx.agentTools.registerToolExecutors` using the frozen owner-fiber dispatcher
 * pattern from `host/plugins/plugin-workshop/index.ts`.
 */
import type { AgentSchemaTool, AgentToolConcurrency, AgentToolSensitivity } from '../../agent-skills/api.ts';
import type { ExecutionContext, ToolCall, ToolResultInfo } from '../../chat/api.ts';
import type { SwarmControlAction, SwarmMemberInitInput } from '../api.ts';
import type { BoardMessagePriority } from './contracts.ts';
import type { MeshOrchestrator } from './orchestrator.ts';

interface ToolSpec {
  readonly description: string;
  readonly properties: Record<string, unknown>;
  readonly required: readonly string[];
}

const TOOL_SPECS: Readonly<Record<string, ToolSpec>> = {
  mesh_delegate_agent: {
    description:
      'Delegate a coding, debugging, review, or verification task in the bound project workspace to an external coding CLI (@claude, @codex, @opencode, @pi, @agy, @dsh, or custom CLI). Safe to call in parallel for architecture comparisons or disjoint file modules.',
    properties: {
      agent: {
        type: 'string',
        description: 'Target external CLI agent id or handle (e.g. "claude", "codex", "opencode", "pi", "agy", "dsh").',
      },
      prompt: {
        type: 'string',
        description: 'Clear, self-contained task brief and acceptance criteria for the external coding agent.',
      },
      rosterName: {
        type: 'string',
        description: 'Optional logical member handle (e.g. "arch-claude", "impl-codex") when running distinct roles.',
      },
      rootPath: {
        type: 'string',
        description: 'Optional workspace directory path override; defaults to the session workspace binding.',
      },
      ownedGlobs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional file or glob patterns owned by this agent for same-directory FileLease safety.',
      },
      readOnly: {
        type: 'boolean',
        description: 'Set true when asking the external CLI for read-only code review or architectural comparison.',
      },
      wait: {
        type: 'boolean',
        description: 'Wait for quiescent completion (including nested subagents) before returning. Defaults to true.',
      },
    },
    required: ['agent', 'prompt'],
  },
  mesh_ask_peer: {
    description:
      'Consult another coding CLI agent (@claude, @codex, @opencode, @pi, etc.) with a bounded 1-turn read-only question and record a collapsible Peer Exchange Strip in the conversation.',
    properties: {
      targetAgent: {
        type: 'string',
        description: 'Peer agent id or handle to consult (e.g. "codex", "claude").',
      },
      question: {
        type: 'string',
        description: 'Specific technical question or contract check for the peer agent.',
      },
      contextPaths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional relevant relative file paths for the peer to inspect.',
      },
      fromAgent: {
        type: 'string',
        description: 'Caller agent handle; defaults to "deepstudent".',
      },
      rootPath: {
        type: 'string',
        description: 'Optional workspace directory override.',
      },
    },
    required: ['targetAgent', 'question'],
  },
  mesh_handoff: {
    description:
      'Explicitly pass the baton to another coding CLI agent: releases caller file leases, captures a hidden in-place checkpoint, records a Peer Exchange Strip, and wakes the target agent with summary + changed files + next task.',
    properties: {
      targetAgent: {
        type: 'string',
        description: 'Downstream agent id or handle to receive the baton (e.g. "codex", "claude").',
      },
      summary: {
        type: 'string',
        description: 'Concise summary of completed upstream work and architectural invariants.',
      },
      nextTask: {
        type: 'string',
        description: 'Concrete next task for the receiving agent.',
      },
      changedFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Relative paths modified prior to this handoff.',
      },
      fromAgent: {
        type: 'string',
        description: 'Upstream caller agent handle; defaults to "deepstudent".',
      },
      rootPath: {
        type: 'string',
        description: 'Optional workspace directory override.',
      },
      wait: {
        type: 'boolean',
        description: 'Whether to wait for the downstream turn to finish before returning. Defaults to true.',
      },
    },
    required: ['targetAgent', 'summary', 'nextTask'],
  },
  mesh_swarm_control: {
    description:
      'Manage the session heterogeneous Swarm board and roster (start, add_member, remove_member, swap_member_cli, post, read_board, pause, resume, complete, status, set_max_hops).',
    properties: {
      action: {
        type: 'string',
        enum: [
          'start',
          'add_member',
          'remove_member',
          'swap_member_cli',
          'post',
          'read_board',
          'pause',
          'resume',
          'complete',
          'status',
          'set_max_hops',
        ],
      },
      title: { type: 'string' },
      goal: { type: 'string' },
      members: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            rosterName: { type: 'string' },
            agentId: { type: 'string' },
            roleTitle: { type: 'string' },
            ownedGlobs: { type: 'array', items: { type: 'string' } },
          },
          required: ['rosterName', 'agentId'],
          additionalProperties: false,
        },
      },
      initialBrief: { type: 'string' },
      rosterName: { type: 'string' },
      agentId: { type: 'string' },
      roleTitle: { type: 'string' },
      ownedGlobs: { type: 'array', items: { type: 'string' } },
      text: { type: 'string' },
      mentions: { type: 'array', items: { type: 'string' } },
      priority: {
        type: 'string',
        enum: ['correction', 'task', 'query', 'result', 'progress'],
      },
      sinceSeq: { type: 'integer' },
      limit: { type: 'integer' },
      maxAutonomousHops: { type: 'integer' },
    },
    required: ['action'],
  },
  mesh_inspect_changes: {
    description:
      'Inspect in-place hidden Git/SHA-256 checkpoints, per-agent file diffs, active file leases, or safely revert a checkpoint in-place.',
    properties: {
      action: {
        type: 'string',
        enum: ['diff', 'list_checkpoints', 'list_leases', 'revert'],
      },
      checkpointId: { type: 'string' },
      fromCheckpointId: { type: 'string' },
      toCheckpointId: { type: 'string' },
      agentId: { type: 'string' },
      paths: { type: 'array', items: { type: 'string' } },
      forceOverwriteUserEdits: { type: 'boolean' },
    },
    required: [],
  },
};

export const AGENT_MESH_TOOL_NAMES: readonly string[] = Object.freeze(Object.keys(TOOL_SPECS));

function normalizeToolName(raw: string): string {
  return raw.replace(/^builtin[-:]/, '');
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

export class AgentMeshToolExecutor {
  private readonly orchestrator: MeshOrchestrator;

  constructor(orchestrator: MeshOrchestrator) {
    this.orchestrator = orchestrator;
  }

  name(): string {
    return 'DstuAgentMeshExecutor';
  }

  canHandle(toolName: string): boolean {
    return Object.hasOwn(TOOL_SPECS, normalizeToolName(toolName));
  }

  hasDynamicSensitivity(toolName: string): boolean {
    const clean = normalizeToolName(toolName);
    return (
      clean === 'mesh_delegate_agent' ||
      clean === 'mesh_swarm_control' ||
      clean === 'mesh_inspect_changes'
    );
  }

  sensitivityLevel(toolName: string): AgentToolSensitivity {
    const clean = normalizeToolName(toolName);
    if (clean === 'mesh_ask_peer' || clean === 'mesh_inspect_changes') return 'low';
    return 'medium';
  }

  sensitivityLevelForCall(toolName: string, args: unknown): AgentToolSensitivity {
    const clean = normalizeToolName(toolName);
    const obj =
      typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
    if (clean === 'mesh_ask_peer') return 'low';
    if (clean === 'mesh_delegate_agent') {
      return obj.readOnly === true ? 'low' : 'medium';
    }
    if (clean === 'mesh_swarm_control') {
      const action = typeof obj.action === 'string' ? obj.action : '';
      return action === 'status' || action === 'read_board' ? 'low' : 'medium';
    }
    if (clean === 'mesh_inspect_changes') {
      if (obj.action === 'revert') {
        return obj.forceOverwriteUserEdits === true ? 'high' : 'medium';
      }
      return 'low';
    }
    return 'medium';
  }

  concurrencyClass(): AgentToolConcurrency {
    return 'safe_parallel';
  }

  managesCancellation(): boolean {
    return true;
  }

  schemaTools(): readonly AgentSchemaTool[] {
    return Object.entries(TOOL_SPECS).map(([toolId, spec]) => ({
      id: toolId,
      schema: {
        type: 'function',
        function: {
          name: toolId,
          description: spec.description,
          parameters: {
            type: 'object',
            properties: spec.properties,
            required: spec.required,
            additionalProperties: false,
          },
        },
      },
    }));
  }

  ambientSchemaToolIds(): readonly string[] {
    return AGENT_MESH_TOOL_NAMES;
  }

  async invoke(
    rawToolName: string,
    args: Record<string, unknown>,
    sessionId: string,
    signal?: AbortSignal | null,
  ): Promise<unknown> {
    const tool = normalizeToolName(rawToolName);

    switch (tool) {
      case 'mesh_delegate_agent': {
        const agentId = String(args.agent ?? '').trim();
        const prompt = String(args.prompt ?? '').trim();
        const wait = args.wait !== false;
        const result = await this.orchestrator.startTurn({
          chatSessionId: sessionId,
          agentId,
          rosterName: typeof args.rosterName === 'string' ? args.rosterName : undefined,
          prompt,
          rootPath: typeof args.rootPath === 'string' ? args.rootPath : undefined,
          ownedGlobs: asStringArray(args.ownedGlobs),
          readOnly: args.readOnly === true,
          awaitCompletion: wait,
          signal: signal ?? undefined,
        });
        return {
          threadId: result.threadId,
          agentId: result.thread.agentId,
          rosterName: result.thread.rosterName,
          status: result.status,
          queued: result.queued,
          assistantText: result.assistantText ?? result.thread.assistantText,
          checkpointId: result.checkpointAfter?.checkpointId ?? result.thread.lastCheckpointId,
          diffSummary: result.diff
            ? {
                filesChanged: result.diff.files.length,
                totalAdditions: result.diff.totalAdditions,
                totalDeletions: result.diff.totalDeletions,
                files: result.diff.files.map((f) => ({
                  path: f.path,
                  status: f.status,
                  additions: f.additions,
                  deletions: f.deletions,
                })),
              }
            : result.thread.diffSummary,
        };
      }

      case 'mesh_ask_peer': {
        const exchange = await this.orchestrator.askPeer({
          chatSessionId: sessionId,
          fromAgent: typeof args.fromAgent === 'string' ? args.fromAgent : 'deepstudent',
          targetAgent: String(args.targetAgent ?? '').trim(),
          question: String(args.question ?? '').trim(),
          contextPaths: asStringArray(args.contextPaths),
          rootPath: typeof args.rootPath === 'string' ? args.rootPath : undefined,
          signal: signal ?? undefined,
        });
        return exchange;
      }

      case 'mesh_handoff': {
        const wait = args.wait !== false;
        const result = await this.orchestrator.handoff({
          chatSessionId: sessionId,
          fromAgent: typeof args.fromAgent === 'string' ? args.fromAgent : 'deepstudent',
          targetAgent: String(args.targetAgent ?? '').trim(),
          summary: String(args.summary ?? '').trim(),
          nextTask: String(args.nextTask ?? '').trim(),
          changedFiles: asStringArray(args.changedFiles),
          rootPath: typeof args.rootPath === 'string' ? args.rootPath : undefined,
          awaitCompletion: wait,
          signal: signal ?? undefined,
        });
        return {
          exchange: result.exchange,
          threadId: result.targetTurn.threadId,
          status: result.targetTurn.status,
          assistantText: result.targetTurn.assistantText ?? result.targetTurn.thread.assistantText,
        };
      }

      case 'mesh_swarm_control': {
        const action = String(args.action ?? '') as SwarmControlAction;
        return this.orchestrator.swarmControl({
          action,
          chatSessionId: sessionId,
          title: typeof args.title === 'string' ? args.title : undefined,
          goal: typeof args.goal === 'string' ? args.goal : undefined,
          members: Array.isArray(args.members)
            ? (args.members as SwarmMemberInitInput[])
            : undefined,
          initialBrief: typeof args.initialBrief === 'string' ? args.initialBrief : undefined,
          rosterName: typeof args.rosterName === 'string' ? args.rosterName : undefined,
          agentId: typeof args.agentId === 'string' ? args.agentId : undefined,
          roleTitle: typeof args.roleTitle === 'string' ? args.roleTitle : undefined,
          ownedGlobs: asStringArray(args.ownedGlobs),
          sender: 'deepstudent',
          senderKind: 'coordinator',
          priority:
            typeof args.priority === 'string'
              ? (args.priority as BoardMessagePriority)
              : 'task',
          text: typeof args.text === 'string' ? args.text : undefined,
          mentions: asStringArray(args.mentions),
          sinceSeq: typeof args.sinceSeq === 'number' ? args.sinceSeq : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          maxAutonomousHops:
            typeof args.maxAutonomousHops === 'number' ? args.maxAutonomousHops : undefined,
        });
      }

      case 'mesh_inspect_changes': {
        const action = typeof args.action === 'string' ? args.action : 'diff';
        if (action === 'list_checkpoints') {
          const snap = await this.orchestrator.getSessionSnapshot(sessionId);
          return { checkpoints: snap.checkpoints };
        }
        if (action === 'list_leases') {
          const snap = await this.orchestrator.getSessionSnapshot(sessionId);
          return { fileLeases: snap.fileLeases };
        }
        if (action === 'revert') {
          const checkpointId = String(args.checkpointId ?? '').trim();
          if (!checkpointId) {
            throw new Error('AGENT_MESH_INVALID_REVERT: checkpointId is required for revert');
          }
          return this.orchestrator.revertCheckpoint({
            checkpointId,
            chatSessionId: sessionId,
            paths: asStringArray(args.paths),
            forceOverwriteUserEdits: args.forceOverwriteUserEdits === true,
          });
        }
        return this.orchestrator.getCheckpointDiff({
          chatSessionId: sessionId,
          checkpointId: typeof args.checkpointId === 'string' ? args.checkpointId : undefined,
          fromCheckpointId:
            typeof args.fromCheckpointId === 'string' ? args.fromCheckpointId : undefined,
          toCheckpointId:
            typeof args.toCheckpointId === 'string' ? args.toCheckpointId : undefined,
          agentId: typeof args.agentId === 'string' ? args.agentId : undefined,
        });
      }

      default:
        throw new Error(`AGENT_MESH_UNSUPPORTED_TOOL: ${rawToolName}`);
    }
  }

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    try {
      const argsObj =
        typeof call.arguments === 'object' && call.arguments !== null
          ? (call.arguments as Record<string, unknown>)
          : {};
      const output = await this.invoke(
        call.name,
        argsObj,
        ctx.session_id,
        ctx.cancellation_token,
      );
      const plainJson = JSON.parse(JSON.stringify(output ?? null));
      ctx.emitToolCallEnd(plainJson);
      return {
        toolCallId: call.id,
        blockId: ctx.block_id,
        toolName: call.name,
        input: call.arguments,
        output: plainJson,
        success: true,
        durationMs: Math.trunc(performance.now() - started),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.emitToolCallError(message);
      return {
        toolCallId: call.id,
        blockId: ctx.block_id,
        toolName: call.name,
        input: call.arguments,
        output: null,
        success: false,
        error: message,
        durationMs: Math.trunc(performance.now() - started),
      };
    }
  }
}
