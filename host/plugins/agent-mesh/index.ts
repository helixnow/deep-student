/**
 * Official Desktop Cordis Host Plugin: `dstu.agent-mesh` (Multi-Agent Coding Mesh & Swarm).
 *
 * Exposes `agentMesh` over `meta.remote` for `src/ui-plugins/official/agent-mesh`, registers
 * the 5 `mesh_*` agent tools on `ctx.agentTools`, wires `chatPipelineHooks` prompt augmentation,
 * and binds `AgentKillSwitch` emergency cancellation.
 */
import { definePlugin } from '../../kernel/api.ts';
import { pluginExecution } from '../../kernel/plugin-execution.ts';
import { pluginEventName } from '../../kernel/plugin-id.ts';
import type {} from '../../platform/paths/api.ts';
import type { AgentToolExecutor } from '../agent-skills/api.ts';
import type { ExecutionContext, ToolCall } from '../chat/api.ts';
import type {} from '../chat-pipeline/api.ts';
import {
  type AgentMeshService,
  type AskPeerInput,
  type CliBinaryOverrideInput,
  type CustomCliTemplateInput,
  type GetCheckpointDiffInput,
  type HandoffInput,
  type InterruptMeshTurnInput,
  type RespondMeshApprovalInput,
  type RevertCheckpointInput,
  type SetHumanControlledInput,
  type StartMeshTurnInput,
  type SteerMeshTurnInput,
  type SwarmControlInput,
} from './api.ts';
import {
  type ChatTimelinePort,
  NativeTurnTimelineSession,
  prepareNativeTurnTimeline,
} from './src/chat-timeline-bridge.ts';
import { createMeshOrchestrator, type MeshOrchestratorOptions } from './src/orchestrator.ts';
import {
  ConcreteAdapterRegistryPort,
  ConcreteCheckpointPort,
  ConcreteFileLeasePort,
  ConcreteMeshBridgeServerPort,
  createConcreteMeshPorts,
} from './src/port-adapters.ts';
import { registerMeshPromptHook } from './src/prompt-hook.ts';
import { AgentMeshToolExecutor } from './src/tools.ts';

export const AGENT_MESH_PLUGIN_ID = 'dstu.agent-mesh';
export const AGENT_MESH_BACKEND_EVENT = pluginEventName(AGENT_MESH_PLUGIN_ID, 'event');

export interface AgentMeshPluginConfig {
  inMemoryDb?: boolean;
  swarmCoalesceMs?: number;
  eagerStartBridge?: boolean;
  ports?: Pick<
    MeshOrchestratorOptions,
    'adapters' | 'checkpoints' | 'fileLeases' | 'bridgeServer' | 'studyContextReader'
  >;
}

/**
 * `HostRuntime.remoteCall` (`host/kernel/runtime.ts:521`) appends `{ signal: AbortSignal }` as the
 * trailing argument on every UI -> Host `plugin:host|call` invocation for non-workshop services.
 * Strip that transport envelope cleanly so both `ctx.ui.host` and direct in-process callers work identically.
 */
function stripRemoteCallTail(rawArgs: unknown[]): {
  args: unknown[];
  signal: AbortSignal | undefined;
} {
  if (rawArgs.length === 0) return { args: [], signal: undefined };
  const last = rawArgs[rawArgs.length - 1];
  if (
    typeof last === 'object' &&
    last !== null &&
    !Array.isArray(last) &&
    'signal' in last &&
    Object.keys(last).every((key) => key === 'signal')
  ) {
    const signal = (last as { signal?: unknown }).signal;
    return {
      args: rawArgs.slice(0, -1),
      signal: signal instanceof AbortSignal ? signal : undefined,
    };
  }
  return { args: rawArgs, signal: undefined };
}

export default definePlugin({
  meta: {
    id: 'dstu.agent-mesh',
    version: '1.0.0',
    platforms: ['desktop'],
    provides: ['agentMesh'],
    remote: {
      agentMesh: [
        'probeAgents',
        'getWorkspaceBinding',
        'setWorkspaceBinding',
        'startTurn',
        'steerTurn',
        'interruptTurn',
        'respondApproval',
        'setHumanControlled',
        'getSessionSnapshot',
        'getCheckpointDiff',
        'revertCheckpoint',
        'swarmControl',
        'saveCustomCliTemplate',
        'deleteCustomCliTemplate',
        'saveCliOverride',
        'deleteCliOverride',
        'askPeer',
        'handoff',
      ],
    },
  },
  inject: ['paths', 'agentTools'],
  async apply(ctx, config?: AgentMeshPluginConfig) {
    const logger = ctx.logger('agent-mesh');
    const defaultPorts = createConcreteMeshPorts({
      appDataDir: ctx.paths.appDataDir,
      inMemoryDb: config?.inMemoryDb,
    });
    const resolvedPorts = {
      adapters: config?.ports?.adapters ?? defaultPorts.adapters,
      checkpoints: config?.ports?.checkpoints ?? defaultPorts.checkpoints,
      fileLeases: config?.ports?.fileLeases ?? defaultPorts.fileLeases,
      bridgeServer: config?.ports?.bridgeServer ?? defaultPorts.bridgeServer,
      studyContextReader: config?.ports?.studyContextReader,
    };

    // Dispose unused default port instances if test/caller supplied overrides.
    if (config?.ports?.fileLeases) {
      defaultPorts.fileLeases.dispose();
    }
    if (config?.ports?.adapters) {
      void defaultPorts.adapters.dispose();
    }
    if (config?.ports?.bridgeServer) {
      void defaultPorts.bridgeServer.dispose();
    }
    if (config?.eagerStartBridge === true) {
      await resolvedPorts.bridgeServer.start?.();
    }

    const orchestrator = createMeshOrchestrator({
      appDataDir: ctx.paths.appDataDir,
      inMemoryDb: config?.inMemoryDb,
      swarmCoalesceMs: config?.swarmCoalesceMs,
      ...resolvedPorts,
      killSwitch: () => ctx.get('chatState')?.killSwitch,
      emitEvent: (event) => {
        ctx.backendEvents.emit(AGENT_MESH_BACKEND_EVENT, event);
      },
      logger,
    });

    const executor = new AgentMeshToolExecutor(orchestrator);
    const dispatcher: AgentToolExecutor = Object.freeze({
      name: Object.freeze(() => executor.name()),
      canHandle: Object.freeze((name: string) => executor.canHandle(name)),
      hasDynamicSensitivity: Object.freeze((name: string) => executor.hasDynamicSensitivity(name)),
      sensitivityLevel: Object.freeze((name: string) => executor.sensitivityLevel(name)),
      sensitivityLevelForCall: Object.freeze((name: string, args: unknown) =>
        executor.sensitivityLevelForCall(name, args),
      ),
      concurrencyClass: Object.freeze(() => executor.concurrencyClass()),
      managesCancellation: Object.freeze(() => executor.managesCancellation()),
      schemaTools: Object.freeze(() => executor.schemaTools()),
      ambientSchemaToolIds: Object.freeze(() => executor.ambientSchemaToolIds()),
      execute: Object.freeze((call: unknown, execCtx: unknown) =>
        pluginExecution.run(ctx.fiber, () =>
          executor.execute(call as ToolCall, execCtx as ExecutionContext),
        ),
      ),
    });
    const toolsReg = ctx.agentTools.registerToolExecutors([dispatcher]);

    // Wire optional chat services reactively whenever present in the profile.
    ctx.inject(['chatPipelineHooks'], (inner) => {
      const disposeHook = registerMeshPromptHook(inner.chatPipelineHooks, orchestrator);
      inner.effect(() => disposeHook);
    });

    ctx.inject(['chatSession'], (inner) => {
      const cancelHook = inner.chatSession.registerEmergencyCancelHook(orchestrator);
      orchestrator.setChatTimelinePort({
        database: inner.chatSession.database,
        backendEvents: ctx.backendEvents,
        logger,
      });
      inner.effect(() => () => {
        orchestrator.setChatTimelinePort(null);
        cancelHook.dispose();
      });
    });

    ctx.effect(() => () => {
      toolsReg.dispose();
      void orchestrator.dispose();
    });

    const facade: AgentMeshService = Object.freeze({
      probeAgents: Object.freeze(async (...raw: unknown[]) => {
        const { args } = stripRemoteCallTail(raw);
        return orchestrator.probeAgents(args[0] as { forceRefresh?: boolean } | undefined);
      }),
      getWorkspaceBinding: Object.freeze(async (...raw: unknown[]) => {
        const { args } = stripRemoteCallTail(raw);
        return orchestrator.getWorkspaceBinding(
          (args[0] as string | { chatSessionId?: string; sessionId?: string }) ?? '',
        );
      }),
      setWorkspaceBinding: Object.freeze(async (...raw: unknown[]) => {
        const { args } = stripRemoteCallTail(raw);
        return orchestrator.setWorkspaceBinding(
          args[0] as { chatSessionId?: string; sessionId?: string; rootPath: string | null } | string,
          args[1] as string | null | undefined,
        );
      }),
      startTurn: Object.freeze(async (...raw: unknown[]) => {
        const { args, signal } = stripRemoteCallTail(raw);
        const input = (args[0] ?? {}) as StartMeshTurnInput & { sessionId?: string; cwd?: string };
        return orchestrator.startTurn({
          ...input,
          chatSessionId: input.chatSessionId ?? input.sessionId ?? '',
          rootPath: input.rootPath ?? input.cwd,
          signal: input.signal ?? signal,
        });
      }),
      steerTurn: Object.freeze(async (...raw: unknown[]) => {
        const { args } = stripRemoteCallTail(raw);
        if (typeof args[0] === 'string') {
          return orchestrator.steerTurn(args[0], args[1] as string | undefined);
        }
        const input = (args[0] ?? {}) as SteerMeshTurnInput & {
          sessionId?: string;
          prompt?: string;
          message?: string;
        };
        return orchestrator.steerTurn({
          ...input,
          chatSessionId: input.chatSessionId ?? input.sessionId,
          text: input.text ?? input.prompt ?? input.message ?? '',
        });
      }),
      interruptTurn: Object.freeze(async (...raw: unknown[]) => {
        const { args } = stripRemoteCallTail(raw);
        if (typeof args[0] === 'string') {
          return orchestrator.interruptTurn(args[0], args[1] as string | undefined);
        }
        const input = (args[0] ?? {}) as InterruptMeshTurnInput & { sessionId?: string };
        return orchestrator.interruptTurn({
          ...input,
          chatSessionId: input.chatSessionId ?? input.sessionId,
        });
      }),
      respondApproval: Object.freeze(async (...raw: unknown[]) => {
        const { args } = stripRemoteCallTail(raw);
        if (typeof args[0] === 'string' && typeof args[1] === 'string') {
          return orchestrator.respondApproval({
            threadId: args[0],
            requestId: args[1],
            approved: Boolean(args[2]),
            scope: args[3] as 'once' | 'session' | undefined,
          });
        }
        const input = (args[0] ?? {}) as RespondMeshApprovalInput & {
          decision?: 'allow_once' | 'allow_session' | 'allow_for_session' | 'allow' | 'deny';
          note?: string;
        };
        const approved =
          typeof input.approved === 'boolean'
            ? input.approved
            : input.decision !== undefined
              ? input.decision !== 'deny'
              : false;
        const scope: 'once' | 'session' | undefined =
          input.scope ??
          (input.decision === 'allow_session' || input.decision === 'allow_for_session'
            ? 'session'
            : input.decision !== undefined
              ? 'once'
              : undefined);
        return orchestrator.respondApproval({
          ...input,
          approved,
          scope,
          reason: input.reason ?? input.note,
        });
      }),
      setHumanControlled: Object.freeze(async (...raw: unknown[]) => {
        const { args } = stripRemoteCallTail(raw);
        if (typeof args[0] === 'string' && typeof args[1] === 'boolean') {
          return orchestrator.setHumanControlled({
            chatSessionId: args[0],
            threadId: args[0],
            humanControlled: args[1],
          });
        }
        const input = (args[0] ?? {}) as SetHumanControlledInput & {
          sessionId?: string;
          enabled?: boolean;
        };
        return orchestrator.setHumanControlled({
          ...input,
          chatSessionId: input.chatSessionId ?? input.sessionId ?? '',
          humanControlled: input.humanControlled ?? Boolean(input.enabled),
        });
      }),
      getSessionSnapshot: Object.freeze(async (...raw: unknown[]) => {
        const { args } = stripRemoteCallTail(raw);
        return orchestrator.getSessionSnapshot(
          (args[0] as string | { chatSessionId?: string; sessionId?: string }) ?? '',
        );
      }),
      getCheckpointDiff: Object.freeze(async (...raw: unknown[]) => {
        const { args } = stripRemoteCallTail(raw);
        if (typeof args[0] === 'string') {
          return orchestrator.getCheckpointDiff(args[0]);
        }
        const input = (args[0] ?? {}) as GetCheckpointDiffInput & { sessionId?: string };
        return orchestrator.getCheckpointDiff({
          ...input,
          chatSessionId: input.chatSessionId ?? input.sessionId,
        });
      }),
      revertCheckpoint: Object.freeze(async (...raw: unknown[]) => {
        const { args } = stripRemoteCallTail(raw);
        if (typeof args[0] === 'string') {
          return orchestrator.revertCheckpoint(args[0], args[1] as string[] | undefined);
        }
        const input = (args[0] ?? {}) as RevertCheckpointInput & { sessionId?: string };
        return orchestrator.revertCheckpoint({
          ...input,
          chatSessionId: input.chatSessionId ?? input.sessionId,
        });
      }),
      swarmControl: Object.freeze(async (...raw: unknown[]) => {
        const { args } = stripRemoteCallTail(raw);
        const input = (args[0] ?? {}) as SwarmControlInput & { sessionId?: string };
        return orchestrator.swarmControl({
          ...input,
          chatSessionId: input.chatSessionId ?? input.sessionId ?? '',
        });
      }),
      saveCustomCliTemplate: Object.freeze(async (...raw: unknown[]) => {
        const { args } = stripRemoteCallTail(raw);
        return orchestrator.saveCustomCliTemplate((args[0] ?? {}) as CustomCliTemplateInput);
      }),
      deleteCustomCliTemplate: Object.freeze(async (...raw: unknown[]) => {
        const { args } = stripRemoteCallTail(raw);
        return orchestrator.deleteCustomCliTemplate((args[0] ?? '') as { id: string } | string);
      }),
      saveCliOverride: Object.freeze(async (...raw: unknown[]) => {
        const { args } = stripRemoteCallTail(raw);
        return orchestrator.saveCliOverride((args[0] ?? {}) as CliBinaryOverrideInput);
      }),
      deleteCliOverride: Object.freeze(async (...raw: unknown[]) => {
        const { args } = stripRemoteCallTail(raw);
        return orchestrator.deleteCliOverride((args[0] ?? '') as { agentId: string } | string);
      }),
      askPeer: Object.freeze(async (...raw: unknown[]) => {
        const { args, signal } = stripRemoteCallTail(raw);
        const input = (args[0] ?? {}) as AskPeerInput & { sessionId?: string };
        return orchestrator.askPeer({
          ...input,
          chatSessionId: input.chatSessionId ?? input.sessionId ?? '',
          signal: input.signal ?? signal,
        });
      }),
      handoff: Object.freeze(async (...raw: unknown[]) => {
        const { args, signal } = stripRemoteCallTail(raw);
        const input = (args[0] ?? {}) as HandoffInput & { sessionId?: string };
        return orchestrator.handoff({
          ...input,
          chatSessionId: input.chatSessionId ?? input.sessionId ?? '',
          signal: input.signal ?? signal,
        });
      }),
    });

    ctx.provide('agentMesh', facade);
  },
});

export {
  createMeshOrchestrator,
  createConcreteMeshPorts,
  ConcreteAdapterRegistryPort,
  ConcreteCheckpointPort,
  ConcreteFileLeasePort,
  ConcreteMeshBridgeServerPort,
  AgentMeshToolExecutor,
  registerMeshPromptHook,
  NativeTurnTimelineSession,
  prepareNativeTurnTimeline,
};
export type { MeshOrchestratorOptions, ChatTimelinePort };
