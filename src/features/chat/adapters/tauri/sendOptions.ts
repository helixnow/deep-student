/**
 * Chat V2 - TauriAdapter 拆分模块 —— 发送选项构建：上下文预算、系统提示（含 Skills 目录）、MCP 工具 Schema、瞬态技能注入
 *
 * 自 TauriAdapter.ts 拆出（行为不变）；函数首参 host 为适配器实例，
 * 由 ChatV2TauriAdapter 同名方法委托调用。
 */

import i18n from 'i18next';
import { getErrorMessage } from '@/utils/errorUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { logMultiVariant } from '@/debug-panel/plugins/MultiVariantDebugPlugin';
import { modeRegistry } from '../../registry';
import { getTestModeConfig } from '@/utils/testMode';
import type { SendOptions } from '../types';
import { getModelInfoByConfigId } from '../../hooks/useAvailableModels';
import { collectSchemaToolIds } from '../../tools/collector';
import { McpService } from '@/mcp/mcpService';
import { skillRegistry } from '../../skills/registry';
import { renderSkillContentWithArtifact } from '../../skills/artifactSkeleton';
import { groupCache } from '../../core/store/groupCache';
import { BUILTIN_SERVER_ID } from '@/mcp/builtinMcpServer';
import { getAvailableSearchEngines } from '@/mcp/searchEngineAvailability';
import {
  LOAD_SKILLS_TOOL_SCHEMA,
  getLoadedSkills,
  preloadAutoLoadSkillsForSession,
} from '../../skills/progressiveDisclosure';
import { PROACTIVE_KB_SYSTEM_PROMPT } from '../../skills/builtin-tools/knowledge-retrieval';
// 🆕 工作区状态（用于传递 workspaceId 到后端）
import { useWorkspaceStore } from '../../workspace/workspaceStore';
import { inferInputContextBudget } from '@/utils/modelCapabilities';
import { LOG_PREFIX, adapterConsole as console } from './diagnostics';
import { getCanvasNoteIdFromModeState } from './requestHelpers';
import type { TauriAdapterHost, BuildSendOptionsSnapshot } from './adapterHost';
import { getRegisteredSkillRuntimeAdmission } from './skillRuntime';

export function resolveInputContextLimit(
  host: TauriAdapterHost,
  modelId: string | undefined,
  model2OverrideId: string | undefined,
  maxTokens: number,
  userContextLimit: number | undefined
): number {
  const effectiveModelId = model2OverrideId || modelId;
  const modelInfo = getModelInfoByConfigId(effectiveModelId);
  const modelLike =
    (typeof modelInfo?.model === 'string' ? modelInfo.model : undefined) ||
    (typeof modelInfo?.name === 'string' ? modelInfo.name : undefined) ||
    effectiveModelId ||
    '';
  const inferredModelMaxOutput =
    typeof modelInfo?.maxOutputTokens === 'number' && Number.isFinite(modelInfo.maxOutputTokens)
      ? modelInfo.maxOutputTokens
      : undefined;

  // 优先使用 ApiConfig 中用户配置/推断引擎写入的 contextWindow
  const configContextWindow =
    typeof modelInfo?.contextWindow === 'number' && modelInfo.contextWindow > 0
      ? modelInfo.contextWindow
      : undefined;

  return inferInputContextBudget({
    modelLike,
    userContextLimit,
    maxOutputTokens: Math.max(maxTokens || 0, inferredModelMaxOutput || 0),
    configContextWindow,
  });
}

export function getContextTruncateLimit(host: TauriAdapterHost, contextLimit: number | undefined): number {
  if (typeof contextLimit === 'number' && Number.isFinite(contextLimit) && contextLimit > 0) {
    return Math.max(2048, Math.floor(contextLimit));
  }
  // 回退：基于当前模型动态计算（而非硬编码值）
  const currentState = host.getCurrentState();
  const { chatParams } = currentState;
  return host.resolveInputContextLimit(
    chatParams.modelId,
    chatParams.model2OverrideId || undefined,
    chatParams.maxTokens,
    undefined
  );
}

export function notifyContextTruncated(host: TauriAdapterHost, removedCount: number): void {
  showGlobalNotification('warning', i18n.t('chatV2:chat.context_truncated', { count: removedCount }));
}

/**
 * 从 Store 状态构建发送选项
 *
 * 集成 modeRegistry：
 * 1. 使用 buildSystemPrompt 生成系统提示
 * 2. 使用 getEnabledTools 获取启用的工具
 */
export async function buildSendOptions(host: TauriAdapterHost, snapshot?: BuildSendOptionsSnapshot): Promise<SendOptions> {
  // 🔧 使用 getCurrentState() 获取最新状态，而非构造时的快照
  // 这确保了 enableThinking 等用户实时修改的参数能正确传递
  const currentState = snapshot?.state ?? host.getCurrentState();
  const pendingContextRefs = snapshot?.pendingContextRefs ?? currentState.pendingContextRefs;
  const { chatParams, features, mode, modeState, sessionId, groupId, sessionMetadata } = currentState;

  // 获取模式插件（使用 getResolved 获取合并了继承链的完整插件）
  const modePlugin = modeRegistry.getResolved(mode);

  // 构建系统提示
  let systemPromptOverride: string | undefined;

  // 1) 分组 System Prompt（同步缓存）
  if (groupId) {
    const group = groupCache.get(groupId);
    if (group?.systemPrompt) {
      systemPromptOverride = group.systemPrompt;
    } else if (sessionMetadata?.groupSystemPromptSnapshot) {
      systemPromptOverride = sessionMetadata.groupSystemPromptSnapshot as string;
    }
  }

  // 2) 模式插件 System Prompt（追加）
  if (modePlugin?.buildSystemPrompt) {
    try {
      const modePrompt = modePlugin.buildSystemPrompt({
        sessionId,
        mode,
        modeState,
      });
      if (modePrompt) {
        systemPromptOverride = systemPromptOverride
          ? `${systemPromptOverride}\n\n${modePrompt}`
          : modePrompt;
      }
    } catch (error) {
      console.error(LOG_PREFIX, 'Error building system prompt:', getErrorMessage(error));
    }
  }

  // 获取模式启用的工具
  let modeEnabledTools: string[] = [];
  if (modePlugin?.getEnabledTools) {
    try {
      modeEnabledTools = modePlugin.getEnabledTools(currentState);
    } catch (error) {
      console.error(LOG_PREFIX, 'Error getting enabled tools:', getErrorMessage(error));
    }
  } else if (modePlugin?.config.enabledTools) {
    // 如果没有 getEnabledTools 方法，使用配置中的静态工具列表
    modeEnabledTools = modePlugin.config.enabledTools;
  }

  // 根据模式工具配置覆盖功能开关
  const ragEnabled = features.get('rag') ?? modeEnabledTools.includes('rag');
  const memoryEnabled = features.get('userMemory') ?? modeEnabledTools.includes('memory');
  const webSearchEnabled = features.get('webSearch') ?? modeEnabledTools.includes('web_search');
  const ankiEnabled = features.get('anki') ?? modeEnabledTools.includes('anki');

  // 3) 知识库主动检索提示词（加号菜单 → 知识库 → 主动检索）
  // 仅在 RAG 未被关闭时注入，否则模型会被引导去调用注定被拦截的工具
  if (ragEnabled && features.get('kbProactive')) {
    systemPromptOverride = systemPromptOverride
      ? `${systemPromptOverride}\n\n${PROACTIVE_KB_SYSTEM_PROMPT}`
      : PROACTIVE_KB_SYSTEM_PROMPT;
  }

  // pendingParallelModelIds 也从 currentState 获取（保持一致性）
  const parallelIds = currentState.pendingParallelModelIds;
  const contextLimit = host.resolveInputContextLimit(
    chatParams.modelId,
    chatParams.model2OverrideId || undefined,
    chatParams.maxTokens,
    chatParams.contextLimit
  );
  const testModeConfig = getTestModeConfig();

  // A2 会话首轮定型：本会话还没有任何技能进入工具面时，先把「设为默认」的技能
  // 加载进来，使工具面从第 1 个请求就完整——任务中途 load_skills 追加工具会让
  // provider 的前缀缓存整段失效（首次出现新工具面实测 cached=0）。
  // 已有技能面的会话（新建会话已激活默认技能、或中途加载过技能）跳过，不改动
  // 既有前缀。
  if (
    getLoadedSkills(host.sessionId).length === 0 &&
    (!Array.isArray(currentState.activeSkillIds) || currentState.activeSkillIds.length === 0)
  ) {
    const preloadedDefaultSkills = preloadAutoLoadSkillsForSession(host.sessionId);
    if (preloadedDefaultSkills.length > 0) {
      console.log(
        LOG_PREFIX,
        '[ProgressiveDisclosure] Preloaded default skills for first-turn tool face:',
        preloadedDefaultSkills
      );
    }
  }

  const structuredSkillState = host.getStructuredSkillStateFromStore();
  // Runtime-active skills must pass the same trust/enable/requires admission
  // used by load_skills and model-facing metadata.
  const authoritativeActiveSkillIds = (structuredSkillState
    ? structuredSkillState.manualPinnedSkillIds
    : currentState.activeSkillIds
  ).filter((id) => {
    const skill = skillRegistry.get(id);
    return Boolean(skill && getRegisteredSkillRuntimeAdmission(skill).allowed);
  });
  const modeRequiredSkillIds = (() => {
    const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
    return currentWorkspaceId ? ['workspace-tools'] : [];
  })();
  const runtimeLoadedSkillIds = getLoadedSkills(host.sessionId).map(s => s.id);

  const authoritativeLoadedSkillIds = structuredSkillState
    ? Array.from(new Set([
        ...structuredSkillState.agenticSessionSkillIds,
        ...structuredSkillState.branchLocalSkillIds,
        ...structuredSkillState.modeRequiredBundleIds,
        ...modeRequiredSkillIds,
        ...runtimeLoadedSkillIds,
      ]))
    : Array.from(new Set([
        ...runtimeLoadedSkillIds,
        ...modeRequiredSkillIds,
      ]));

  const enabledSkillIdSeed = Array.from(
    new Set([
      ...authoritativeLoadedSkillIds,
      ...authoritativeActiveSkillIds,
    ])
  );
  const enabledSkillIdSet = new Set<string>();
  const pendingSkillIds = [...enabledSkillIdSeed];
  while (pendingSkillIds.length > 0) {
    const skillId = pendingSkillIds.pop();
    if (!skillId || enabledSkillIdSet.has(skillId)) continue;
    const skill = skillRegistry.get(skillId);
    if (!skill || !getRegisteredSkillRuntimeAdmission(skill).allowed) continue;
    enabledSkillIdSet.add(skillId);
    for (const depId of skill?.dependencies ?? []) {
      if (depId && !enabledSkillIdSet.has(depId)) {
        pendingSkillIds.push(depId);
      }
    }
  }
  const authoritativeToolSkillIds = Array.from(enabledSkillIdSet);

  const options = {
    // ChatParams
    modelId: chatParams.modelId || undefined,
    temperature: chatParams.temperature,
    topP: chatParams.topP,
    frequencyPenalty: chatParams.frequencyPenalty,
    presencePenalty: chatParams.presencePenalty,
    maxTokens: chatParams.maxTokens,
    contextLimit,
    enableThinking: chatParams.enableThinking,
    reasoningEffort: chatParams.reasoningEffort,
    thinkingBudget: chatParams.thinkingBudget,
    replayMode: testModeConfig.replayMode ? 'original' as const : undefined,
    skillStateVersion: (() => {
      const raw = currentState.skillStateJson;
      if (!raw) return undefined;
      try {
        const parsed = JSON.parse(raw) as { version?: unknown };
        return typeof parsed?.version === 'number' ? parsed.version : undefined;
      } catch {
        return undefined;
      }
    })(),
    disableTools: chatParams.disableTools,
    model2OverrideId: chatParams.model2OverrideId || undefined,
    groupId: groupId || undefined,
    groupName: groupId
      ? (groupCache.get(groupId)?.name ?? undefined)
      : undefined,
    groupPinnedResourceIds: groupId
      ? (groupCache.get(groupId)?.pinnedResourceIds ?? [])
      : undefined,
    // 课题首选 runtime root：优先读当前 group 缓存，否则回退 session metadata snapshot。
    // 后端以 DB 课题字段为准；前端透传仅作可观测/兜底辅助，不可信任覆盖未校验 id。
    groupDefaultRuntimeRootId: (() => {
      if (!groupId) return undefined;
      const group = groupCache.get(groupId);
      if (group?.defaultRuntimeRootId) {
        return group.defaultRuntimeRootId;
      }
      const snapshot = sessionMetadata?.groupDefaultRuntimeRootIdSnapshot;
      return typeof snapshot === 'string' && snapshot.length > 0 ? snapshot : undefined;
    })(),
    maxToolRecursion: chatParams.maxToolRecursion,

    // 功能开关（结合用户设置和模式配置）
    ragEnabled,
    memoryEnabled,
    webSearchEnabled,
    ankiEnabled,

    // RAG 配置（从 chatParams 获取）
    ragTopK: chatParams.ragTopK,
    ragLibraryIds: chatParams.ragLibraryIds,
    // 🔧 P1-35: 传递 Rerank 开关配置
    ragEnableReranking: chatParams.ragEnableReranking,

    // 多模态知识库检索配置（由用户开关逐轮快照到请求中）
    multimodalRagEnabled: chatParams.multimodalRagEnabled ?? false,
    multimodalTopK: chatParams.multimodalTopK,
    // 多模态精排未显式设置时跟随全局 Rerank 开关（与 RagPanel 的 UI 默认一致）
    multimodalEnableReranking: chatParams.multimodalEnableReranking ?? chatParams.ragEnableReranking,
    multimodalLibraryIds: chatParams.multimodalLibraryIds,

    // 🆕 图片压缩策略（不设置时后端使用智能默认策略）
    visionQuality: chatParams.visionQuality,

    // ★ 2026-01 简化：VFS RAG 作为唯一知识检索方案
    // ragTopK 和 ragEnableReranking 直接用于 VFS RAG 检索

    // ★ graphIds/graphTopK 已废弃（图谱模块已移除）

    // MCP 工具（从 chatParams 获取选中的服务器）
    mcpTools: chatParams.selectedMcpServers,
    // ========== MCP 工具 Schema 注入 ==========
    // 从 mcpService 获取选中服务器的工具 Schema，传递给后端
    // 后端直接使用这些 Schema 注入到 LLM，而不需要自己连接 MCP 服务器
    mcpToolSchemas: await host.collectMcpToolSchemas(
      chatParams.selectedMcpServers,
      authoritativeToolSkillIds,
    ),

    // 搜索引擎（从 chatParams 获取选中的引擎）
    searchEngines: chatParams.selectedSearchEngines,

    // 系统提示（注入 Skills 元数据）。R4 发送等待点：首次快照会在此
    // await 持久化冻结成功后才放行，失败 fail-closed 中止发送。
    systemPromptOverride: await host.buildSystemPromptWithSkills(systemPromptOverride),

    // ========== 多变体选项 ==========
    // 从 Store 读取待发送的并行模型 ID，2+ 个模型时触发多变体模式
    parallelModelIds: parallelIds ?? undefined,

    // ========== Schema 工具注入选项（文档 26）==========
    schemaToolIds: undefined as string[] | undefined,

    // 激活技能列表（用于技能内容与工具渐进加载）
    activeSkillIds: authoritativeActiveSkillIds.length > 0 ? authoritativeActiveSkillIds : undefined,

    // ========== Canvas 智能笔记选项 ==========
    // 从 modeState 获取当前打开的笔记 ID，作为 Canvas 工具的默认目标
    canvasNoteId: getCanvasNoteIdFromModeState(modeState),
  };

  // ========== Schema 工具收集（文档 26）==========
  // 从权威技能状态收集需要注入的 Schema 工具 ID
  // skill_instruction ContextRef 仅作为 UI / 历史兼容缓存，不再参与运行时权限决策
  const schemaToolResult = collectSchemaToolIds({
    pendingContextRefs,
  });
  if (schemaToolResult.schemaToolIds.length > 0) {
    options.schemaToolIds = schemaToolResult.schemaToolIds;
    console.log(LOG_PREFIX, 'Schema tools collected:', schemaToolResult);
  }

  // Transient skill injection includes every runtime-admitted skill so the
  // backend can service load_skills. Rejected skills are represented only by
  // a non-sensitive admission error; their content, metadata, and schemas
  // never cross the frontend/backend boundary.
  const allSkills = skillRegistry.getAll();
  if (allSkills.length > 0) {
    const skillContents: Record<string, string> = {};
    const replaySkillContents: Record<string, string> = {};
    const skillDependencies: Record<string, string[]> = {};
    const skillEmbeddedTools: Record<string, Array<{ name: string; description?: string; inputSchema?: unknown }>> = {};
    const skillPackageRoots: Record<string, string> = {};
    const skillAdmissionErrors: Record<string, string> = {};
    for (const skill of allSkills) {
      const admission = getRegisteredSkillRuntimeAdmission(skill);
      if (!admission.allowed) {
        skillAdmissionErrors[skill.id] = `${admission.code}: ${admission.message}`;
        console.log(LOG_PREFIX, '[TransientSkills] Skip rejected skill injection:', skill.id, admission.code);
        continue;
      }
      skillContents[skill.id] = renderSkillContentWithArtifact(skill);
      replaySkillContents[skill.id] = renderSkillContentWithArtifact(skill);
      if (Array.isArray(skill.dependencies) && skill.dependencies.length > 0) {
        skillDependencies[skill.id] = skill.dependencies.filter(Boolean);
      }
      if (skill.embeddedTools && skill.embeddedTools.length > 0) {
        skillEmbeddedTools[skill.id] = skill.embeddedTools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }));
      }
      if (
        authoritativeToolSkillIds.includes(skill.id) &&
        skill.packageRoot &&
        !skill.packageRoot.startsWith('builtin://')
      ) {
        skillPackageRoots[skill.id] = skill.packageRoot;
      }
    }
    if (Object.keys(skillContents).length > 0) {
      (options as Record<string, unknown>).skillContents = skillContents;
      (options as Record<string, unknown>).replaySkillContents = replaySkillContents;
      console.log(LOG_PREFIX, '[TransientSkills] Injected skill contents:', Object.keys(skillContents).length);
    }
    if (Object.keys(skillDependencies).length > 0) {
      (options as Record<string, unknown>).skillDependencies = skillDependencies;
    }
    if (Object.keys(skillEmbeddedTools).length > 0) {
      (options as Record<string, unknown>).skillEmbeddedTools = skillEmbeddedTools;
      console.log(LOG_PREFIX, '[TransientSkills] Injected skill embeddedTools:', Object.keys(skillEmbeddedTools).length);
    }
    if (Object.keys(skillPackageRoots).length > 0) {
      (options as Record<string, unknown>).skillPackageRoots = skillPackageRoots;
      console.log(LOG_PREFIX, '[TransientSkills] Injected skill package roots:', Object.keys(skillPackageRoots).length);
    }
    (options as Record<string, unknown>).skillAdmissionErrors = skillAdmissionErrors;
  }

  // 🔧 调试日志：记录发送选项（包含 modelId）
  logMultiVariant('adapter', 'buildSendOptions', {
    modelId: options.modelId,
    hasModelId: !!options.modelId,
    hasParallelModelIds: !!parallelIds,
    parallelModelIds: parallelIds ?? [],
    count: parallelIds?.length ?? 0,
    willTriggerMultiVariant: (parallelIds?.length ?? 0) >= 2,
    enableThinking: chatParams.enableThinking,
    reasoningEffort: chatParams.reasoningEffort,
    thinkingBudget: chatParams.thinkingBudget,
    isSingleVariant: !parallelIds || parallelIds.length < 2,
  }, options.modelId ? 'success' : 'warning');

  // 单独记录思维链状态
  if (chatParams.enableThinking) {
    logMultiVariant('adapter', 'thinking_enabled', {
      modelId: chatParams.modelId,
      enableThinking: true,
      reasoningEffort: chatParams.reasoningEffort,
      thinkingBudget: chatParams.thinkingBudget,
    }, 'info');
  }

  return options;
}

/**
 * 从 mcpService 收集选中 MCP 服务器的工具 Schema
 *
 * 🔧 2026-01-11 重构：总是注入内置工具，确保工具化检索模式可用
 * 🔧 2026-01-20 重构：支持渐进披露模式，按需加载工具
 *
 * 返回工具 Schema 数组，格式与 OpenAI function calling 兼容：
 * - name: 工具名称（可能带命名空间前缀）
 * - description: 工具描述
 * - inputSchema: JSON Schema 定义参数
 */
export async function collectMcpToolSchemas(
  host: TauriAdapterHost,
  selectedServerIds?: string[],
  loadedSkillIds?: string[],
): Promise<Array<{ name: string; serverId?: string; description?: string; inputSchema?: unknown }>> {
  const schemas: Array<{ name: string; serverId?: string; description?: string; inputSchema?: unknown }> = [];

  // 渐进披露模式：只注入 load_skills 元工具 + 已加载的 Skills 工具
  // 完全替代 builtinMcpServer.ts，不再支持旧的全量注入模式
  schemas.push(LOAD_SKILLS_TOOL_SCHEMA);
  console.log(LOG_PREFIX, '[ProgressiveDisclosure] Injected load_skills meta-tool');

  // 注入已加载的 Skills 工具（动态过滤 web_search 引擎）
  // 关键：已加载技能的真实工具定义应来自会话 loadedSkills 缓存；
  // 当只有结构化 loadedSkillIds 可用时，需回退读取 skill.embeddedTools。
  const loadedToolsByKey = new Map<string, { name: string; description?: string; inputSchema?: unknown }>();
  const appendLoadedTool = (tool: { name: string; description?: string; inputSchema?: unknown }) => {
    if (!tool?.name) return;
    const key = tool.name;
    if (!loadedToolsByKey.has(key)) {
      loadedToolsByKey.set(key, tool);
    }
  };

  // Re-check current admission so stale session caches cannot retain schemas
  // after a skill is disabled, becomes untrusted, or loses a requirement.
  for (const loadedSkill of getLoadedSkills(host.sessionId)) {
    const skill = skillRegistry.get(loadedSkill.id);
    if (!skill || !getRegisteredSkillRuntimeAdmission(skill).allowed) continue;
    for (const tool of loadedSkill.tools) {
      appendLoadedTool(tool);
    }
  }

  const effectiveLoadedSkillIds = Array.isArray(loadedSkillIds)
    ? loadedSkillIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  for (const skillId of effectiveLoadedSkillIds) {
    const skill = skillRegistry.get(skillId);
    if (!skill || !getRegisteredSkillRuntimeAdmission(skill).allowed) continue;
    const embeddedTools = skill?.embeddedTools ?? [];
    for (const tool of embeddedTools) {
      appendLoadedTool(tool);
    }
  }

  const loadedTools = Array.from(loadedToolsByKey.values());
  const availableEngines = getAvailableSearchEngines();
  for (const tool of loadedTools) {
    let inputSchema = tool.inputSchema;
    // 🔧 动态注入可用搜索引擎到 web_search 工具，避免 LLM 尝试未配置的引擎
    if (tool.name === 'builtin-web_search' && availableEngines.length > 0) {
      const schemaObj = inputSchema as unknown as Record<string, unknown>;
      const existingProps = (schemaObj?.properties as Record<string, unknown>) ?? {};
      const newProps = {
        ...existingProps,
        engine: {
          type: 'string',
          enum: availableEngines,
          description: `可用的搜索引擎：${availableEngines.join(', ')}。如果不指定，使用默认配置的引擎。`,
        },
      };
      inputSchema = { ...schemaObj, properties: newProps } as unknown as typeof inputSchema;
    }
    schemas.push({
      name: tool.name,
      description: tool.description,
      inputSchema,
    });
  }
  console.log(LOG_PREFIX, '[ProgressiveDisclosure] Injected loaded skill tools:', loadedTools.length);

  // 收集用户选择的其他 MCP 服务器工具（两种模式都支持）
  if (selectedServerIds && selectedServerIds.length > 0) {
    for (const serverId of selectedServerIds) {
      // 跳过内置服务器（已经注入）
      if (serverId === BUILTIN_SERVER_ID) {
        continue;
      }

      // 从 McpService 缓存获取该服务器的工具列表
      let tools = McpService.getCachedToolsFor(serverId);
      if (tools.length === 0) {
        // 页面重载/首启后缓存为空（WebView 重载清空内存态且尚未重连）：
        // 发送路径兜底，连接并完成工具发现后再注入，避免模型只看到 load_skills。
        tools = await McpService.ensureServerTools(serverId);
      }
      for (const tool of tools) {
        schemas.push({
          name: tool.name,
          serverId,
          description: tool.description,
          inputSchema: tool.input_schema,
        });
      }
    }
  }

  console.log(LOG_PREFIX, 'Total MCP tool schemas:', {
    progressiveDisclosure: true, // 始终启用渐进披露
    totalCount: schemas.length,
  });

  return schemas;
}

/**
 * 构建系统提示（注入 Skills 元数据）
 *
 * 🔧 2026-01-20: 渐进披露模式下，注入 available_skills 列表
 *
 * 将 Skills 元数据追加到系统提示后面，用于 LLM 自动发现和激活技能。
 *
 * 缓存前缀约束（ROUND-01-cache-prefix R1 / ROUND-02-synthesis P1-8）：
 * 目录不按已加载状态收缩，会话内保持恒定，避免 system 前缀在
 * load_skills 之后从第 0 字节变化、打碎整段 prompt cache。
 * 已加载状态由 load_skills 的 tool result 与瞬态技能消息表达。
 *
 * P0 会话快照：目录按 sessionId 冻结首次生成结果，会话中途
 * skill_install 改写 live registry 不会改已发出的 system 目录
 * （与 excludeLoaded 修复同一哲学，新技能由 tool result 表达）。
 *
 * R4 目录原子化：首次快照不再 fire-and-forget —— await 持久化冻结成功
 * （或拿到 first-write-wins 回灌值）后才返回 system，保证第一条 LLM
 * 请求使用的目录字节与 session.metadata 持久化权威一致。
 */
export async function buildSystemPromptWithSkills(
  host: TauriAdapterHost,
  basePrompt: string | undefined
): Promise<string | undefined> {
  // The shared generator applies trust/enable visibility before reading any
  // model-facing description or embedded-tool metadata. The per-session
  // snapshot freezes the first generated catalog so mid-session installs
  // never rewrite the already-sent system prefix.
  const skillMetadataPrompt = await host.ensureAvailableSkillsSnapshotFrozen();
  console.log(LOG_PREFIX, '[ProgressiveDisclosure] Generated available_skills prompt (session-frozen catalog snapshot)');

  // 如果没有 skills 元数据，返回原始提示
  if (!skillMetadataPrompt) {
    return basePrompt;
  }

  if (basePrompt) {
    return `${basePrompt}\n\n${skillMetadataPrompt}`;
  }

  return skillMetadataPrompt;
}
