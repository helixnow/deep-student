/**
 * Chat V2 - TauriAdapter 拆分模块 —— 技能运行时准入与 original 回放模式下的技能状态还原
 *
 * 自 TauriAdapter.ts 拆出（行为不变）；函数首参 host 为适配器实例，
 * 由 ChatV2TauriAdapter 同名方法委托调用。
 */

import type { SendOptions } from '../types';
import { McpService } from '@/mcp/mcpService';
import { skillRegistry } from '../../skills/registry';
import { renderSkillContentWithArtifact } from '../../skills/artifactSkeleton';
import { getSkillRuntimeAdmissionWithDependencies } from '../../skills/runtimeAdmission';
import type { SkillDefinition } from '../../skills/types';
import { BUILTIN_SERVER_ID } from '@/mcp/builtinMcpServer';
import { LOAD_SKILLS_TOOL_SCHEMA } from '../../skills/progressiveDisclosure';
import { LOG_PREFIX, adapterConsole as console } from './diagnostics';
import type { TauriAdapterHost } from './adapterHost';

export function getRegisteredSkillRuntimeAdmission(skill: SkillDefinition) {
  return getSkillRuntimeAdmissionWithDependencies(
    skill,
    (skillId) => skillRegistry.get(skillId),
  );
}

export function resolveReplaySkillSnapshot(
  host: TauriAdapterHost,
  messageId: string,
  variantId?: string
): {
  snapshot: {
    manualPinnedSkillIds?: string[];
    modeRequiredBundleIds?: string[];
    agenticSessionSkillIds?: string[];
    branchLocalSkillIds?: string[];
    effectiveAllowedExternalServers?: string[];
  };
  runtimeSnapshot?: {
    activeSkillIds?: string[];
    skillContents?: Record<string, string>;
    skillDependencies?: Record<string, string[]>;
    skillEmbeddedTools?: Record<string, Array<{ name: string; serverId?: string; description?: string; inputSchema?: unknown }>>;
    mcpToolSchemas?: Array<{ name: string; serverId?: string; description?: string; inputSchema?: unknown }>;
    selectedMcpServers?: string[];
  };
  selectedServerIds?: string[];
} | null {
  const currentState = host.getCurrentState();
  const message = currentState.messageMap.get(messageId);
  if (!message) {
    return null;
  }

  const selectedVariant = variantId
    ? message.variants?.find((candidate) => candidate.id === variantId)
    : undefined;

  const snapshot = selectedVariant?.meta?.skillSnapshotAfter
    || selectedVariant?.meta?.skillSnapshotBefore
    || message._meta?.skillSnapshotAfter
    || message._meta?.skillSnapshotBefore;

  const runtimeSnapshot = selectedVariant?.meta?.skillRuntimeAfter
    || selectedVariant?.meta?.skillRuntimeBefore
    || message._meta?.skillRuntimeAfter
    || message._meta?.skillRuntimeBefore;

  if (!snapshot && !runtimeSnapshot) {
    return null;
  }

  const selectedServerIds = runtimeSnapshot?.selectedMcpServers || message._meta?.chatParams?.selectedMcpServers;

  return {
    snapshot: snapshot ?? {},
    runtimeSnapshot,
    selectedServerIds,
  };
}

export function applyOriginalReplaySkillState(
  host: TauriAdapterHost,
  messageId: string,
  options: SendOptions,
  selectedServerIds?: string[],
  variantId?: string
): SendOptions {
  if (options.replayMode !== 'original') {
    return options;
  }

  // Mark every modern original-replay request as admission-checked, even if
  // the renderer no longer has the historical snapshot locally. This keeps
  // the backend from restoring revoked historical schemas as a fallback.
  (options as Record<string, unknown>).skillAdmissionErrors = {};

  const resolvedReplay = host.resolveReplaySkillSnapshot(messageId, variantId);
  if (!resolvedReplay) {
    return options;
  }
  const { snapshot, runtimeSnapshot } = resolvedReplay;
  const effectiveSelectedServerIds =
    (runtimeSnapshot?.selectedMcpServers && runtimeSnapshot.selectedMcpServers.length > 0
      ? runtimeSnapshot.selectedMcpServers
      : undefined)
    ?? (snapshot.effectiveAllowedExternalServers && snapshot.effectiveAllowedExternalServers.length > 0
      ? snapshot.effectiveAllowedExternalServers
      : undefined) ?? resolvedReplay.selectedServerIds ?? selectedServerIds;

  const enabledReplaySkillIds = Array.from(new Set([
    ...(runtimeSnapshot?.activeSkillIds || []),
    ...(snapshot.manualPinnedSkillIds || []),
    ...(snapshot.agenticSessionSkillIds || []),
    ...(snapshot.branchLocalSkillIds || []),
    ...(snapshot.modeRequiredBundleIds || []),
  ])).filter(Boolean);
  const replayPinnedSkillIds = Array.from(new Set([
    ...(snapshot.manualPinnedSkillIds || []),
    ...(runtimeSnapshot?.activeSkillIds || []),
  ])).filter((skillId) => {
    if (!skillId) return false;
    const skill = skillRegistry.get(skillId);
    return Boolean(skill && getRegisteredSkillRuntimeAdmission(skill).allowed);
  });

  options.activeSkillIds = replayPinnedSkillIds;

  const skillContents: Record<string, string> = {};
  const skillDependencies: Record<string, string[]> = {};
  const skillEmbeddedTools: Record<string, Array<{ name: string; serverId?: string; description?: string; inputSchema?: unknown }>> = {};
  const skillAdmissionErrors: Record<string, string> = {};
  const snapshotSkillToolNames = new Set(
    Object.values(runtimeSnapshot?.skillEmbeddedTools ?? {})
      .flat()
      .map((tool) => tool.name)
      .filter(Boolean),
  );
  const replayToolSchemas: Array<{ name: string; serverId?: string; description?: string; inputSchema?: unknown }> = [
    LOAD_SKILLS_TOOL_SCHEMA,
    ...((runtimeSnapshot?.mcpToolSchemas ?? []).filter(
      (schema) => Boolean(schema?.serverId) && !snapshotSkillToolNames.has(schema.name),
    )),
  ];

  for (const skillId of enabledReplaySkillIds) {
    const skill = skillRegistry.get(skillId);
    if (!skill) continue;
    const admission = getRegisteredSkillRuntimeAdmission(skill);
    if (!admission.allowed) {
      skillAdmissionErrors[skill.id] = `${admission.code}: ${admission.message}`;
      console.log(LOG_PREFIX, '[Replay] Skip rejected skill injection:', skill.id, admission.code);
      continue;
    }
    // Trust is bound to the currently installed package, not to historical
    // replay bytes. Reusing an old body here could inject content whose hash
    // was never approved by the current trust decision.
    // Keep an explicit entry even for tool-only skills. The backend uses
    // membership in this map as the admitted-set check; omitting an empty
    // body would incorrectly classify an admitted tool-only skill as missing.
    // P3：产物模板骨架随正文注入（renderSkillContentWithArtifact 对无
    // artifact 声明的 skill 原样返回）。
    skillContents[skill.id] = renderSkillContentWithArtifact(skill);
    if (Array.isArray(skill.dependencies) && skill.dependencies.length > 0) {
      skillDependencies[skill.id] = skill.dependencies.filter(Boolean);
    }
    if (skill.embeddedTools && skill.embeddedTools.length > 0) {
      const embedded = skill.embeddedTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      skillEmbeddedTools[skill.id] = embedded;
      replayToolSchemas.push(...embedded);
    }
  }

  (options as Record<string, unknown>).skillContents = skillContents;
  (options as Record<string, unknown>).replaySkillContents = skillContents;
  (options as Record<string, unknown>).skillDependencies = skillDependencies;
  (options as Record<string, unknown>).skillEmbeddedTools = skillEmbeddedTools;
  // Presence of this field is also the backend contract that the current
  // renderer has re-evaluated replay admission. An empty map is meaningful:
  // the backend must preserve these already-filtered fields instead of
  // restoring older schema/allowlist snapshots over them.
  (options as Record<string, unknown>).skillAdmissionErrors = skillAdmissionErrors;

  const hasExternalReplaySchemas = replayToolSchemas.some((schema) => Boolean(schema.serverId));
  if (
    !hasExternalReplaySchemas
    && effectiveSelectedServerIds
    && effectiveSelectedServerIds.length > 0
  ) {
    for (const serverId of effectiveSelectedServerIds) {
      if (serverId === BUILTIN_SERVER_ID) continue;
      const tools = McpService.getCachedToolsFor(serverId);
      for (const tool of tools) {
        replayToolSchemas.push({
          name: tool.name,
          serverId,
          description: tool.description,
          inputSchema: tool.input_schema,
        });
      }
    }
  }

  options.mcpToolSchemas = replayToolSchemas;
  options.mcpTools = effectiveSelectedServerIds;
  return options;
}

export function getStructuredSkillStateFromStore(host: TauriAdapterHost): {
  manualPinnedSkillIds: string[];
  modeRequiredBundleIds: string[];
  agenticSessionSkillIds: string[];
  branchLocalSkillIds: string[];
} | null {
  const raw = host.getCurrentState().skillStateJson;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      manualPinnedSkillIds?: string[];
      modeRequiredBundleIds?: string[];
      agenticSessionSkillIds?: string[];
      branchLocalSkillIds?: string[];
    };
    return {
      manualPinnedSkillIds: Array.isArray(parsed?.manualPinnedSkillIds) ? parsed.manualPinnedSkillIds.filter(Boolean) : [],
      modeRequiredBundleIds: Array.isArray(parsed?.modeRequiredBundleIds) ? parsed.modeRequiredBundleIds.filter(Boolean) : [],
      agenticSessionSkillIds: Array.isArray(parsed?.agenticSessionSkillIds) ? parsed.agenticSessionSkillIds.filter(Boolean) : [],
      branchLocalSkillIds: Array.isArray(parsed?.branchLocalSkillIds) ? parsed.branchLocalSkillIds.filter(Boolean) : [],
    };
  } catch {
    return null;
  }
}
