/**
 * Chat V2 - 工具调用事件处理插件
 *
 * 处理 MCP 工具调用和图片生成的后端事件。
 *
 * 事件类型：
 * - tool_call: 通用工具调用（MCP 工具）
 * - image_gen: 图片生成
 *
 * 特点：
 * - 工具调用可能有流式输出（如代码执行的 stdout）
 * - 图片生成通常无流式输出，直接返回结果
 * - 中断时标记为错误状态
 *
 * 约束：
 * - 文件导入即自动注册（自执行）
 */

import { eventRegistry, type EventHandler, type EventStartPayload } from '../../registry/eventRegistry';
import type { ChatStore } from '../../core/types';
// 🆕 工作区状态（用于自动设置 currentWorkspaceId）
import { useWorkspaceStore } from '../../workspace/workspaceStore';
import type { WorkspaceAgent } from '../../workspace/types';
// 🆕 Skills 渐进披露（处理 load_skills 工具调用）
import {
  LOAD_SKILLS_TOOL_NAME,
  syncLoadedSkillsFromBackend,
} from '../../skills/progressiveDisclosure';
import { reloadSkills } from '../../skills/loader';
// 🆕 skill_remove 成功后清理本地启停覆盖（trust 记录由后端 executor 清理）
import { setSkillDisabled } from '../../skills/skillEnableStorage';
// 🆕 2026-02-16: 工具调用生命周期调试插件
import {
  emitToolCallDebug,
  trackPreparing,
  trackStart,
  trackEnd,
} from '@/shared/debug/channels/toolCallLifecycle';
// ACR R2-05: 与恢复路径共用 workbench_* 判定
import {
  isWorkbenchOpsToolName,
  stripToolNamePrefix,
} from '@/features/chat/utils/workbenchBlockRemap';

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 渲染为 subagent_embed 卡片的工具（去前缀后的名字）。
 * Super 会话的 builtin-super_dispatch_worker / builtin-super_message_worker 返回结构与
 * subagent_call 一致，与后端历史映射（context.rs get_block_type_for_tool_static）保持同步。
 */
const SUBAGENT_EMBED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'subagent_call',
  'super_dispatch_worker',
  'super_message_worker',
]);

export function isSubagentEmbedToolName(toolName: string | undefined | null): boolean {
  return SUBAGENT_EMBED_TOOL_NAMES.has(stripToolNamePrefix(toolName));
}

/**
 * 按 toolCallId 查找仍处于 preparing 的占位块（同一 toolCallId 一条逻辑工具调用）。
 *
 * 返回顺序：同消息的块优先（按 blockIds 顺序），其后为其它消息中的匹配块
 * （向后兼容旧行为：消息 ID 异常时仍能复用占位块）。
 */
function findPreparingBlockIds(
  store: ChatStore,
  messageId: string,
  toolCallId: string
): string[] {
  if (!store.blocks) return [];
  const sameMessage: string[] = [];
  const otherMessages: string[] = [];
  const message = store.messageMap?.get(messageId);
  const orderedIds = message?.blockIds ?? [];
  const seen = new Set<string>();
  for (const id of orderedIds) {
    const block = store.blocks.get(id);
    if (block && block.toolCallId === toolCallId && block.isPreparing) {
      sameMessage.push(id);
      seen.add(id);
    }
  }
  for (const [id, block] of store.blocks) {
    if (seen.has(id)) continue;
    if (block.toolCallId === toolCallId && block.isPreparing) {
      if (block.messageId === messageId) {
        sameMessage.push(id);
      } else {
        otherMessages.push(id);
      }
    }
  }
  return [...sameMessage, ...otherMessages];
}

/**
 * 为自定义工具事件（retrieval / generative_ui / image_gen）解析目标块 ID，
 * 若关联了原始 toolCallId，则同步替换或清理对应的 tool_call_preparing 占位块，
 * 并幂等复用已存在的 backendBlockId（避免瞬时重试重复推入 blockIds）。
 */
export function resolveBlockWithPreparingCleanup(
  store: ChatStore,
  messageId: string,
  blockType: string,
  toolCallId: string | undefined,
  backendBlockId: string | undefined,
): string {
  let preparingBlockId: string | undefined;
  if (toolCallId) {
    const preparingIds = findPreparingBlockIds(store, messageId, toolCallId);
    preparingBlockId = preparingIds[0];
    const primaryMessageId = preparingBlockId
      ? store.blocks?.get(preparingBlockId)?.messageId
      : undefined;
    for (const extraId of preparingIds.slice(1)) {
      if (store.blocks?.get(extraId)?.messageId !== primaryMessageId) continue;
      if (extraId === backendBlockId) continue;
      store.deleteBlock?.(extraId);
    }
    if (preparingIds.length > 0) {
      store.clearPreparingToolCall?.(messageId);
    }
  }

  const hasBackendBlock = Boolean(backendBlockId && store.blocks?.has(backendBlockId));
  let blockId: string;

  if (preparingBlockId && backendBlockId && !hasBackendBlock) {
    if (store.replaceBlockId) {
      store.replaceBlockId(preparingBlockId, backendBlockId);
      blockId = backendBlockId;
    } else {
      store.deleteBlock?.(preparingBlockId);
      blockId = store.createBlockWithId(messageId, blockType as any, backendBlockId);
    }
  } else if (preparingBlockId && !backendBlockId) {
    blockId = preparingBlockId;
  } else if (backendBlockId) {
    if (preparingBlockId && preparingBlockId !== backendBlockId) {
      store.deleteBlock?.(preparingBlockId);
    }
    blockId = hasBackendBlock
      ? backendBlockId
      : store.createBlockWithId(messageId, blockType as any, backendBlockId);
  } else {
    blockId = store.createBlock(messageId, blockType as any);
  }

  store.updateBlock?.(blockId, {
    type: blockType as any,
    isPreparing: false,
    content: '',
    error: undefined,
    endedAt: undefined,
  });

  return blockId;
}

/**
 * 从后端刷新指定工作区的 agents 列表并同步到 workspaceStore。
 * subagent_call(auto_created_workspace) 完成后调用。
 */
function refreshWorkspaceAgents(store: ChatStore, workspaceId: string): void {
  void (async () => {
    try {
      const { listAgents, agentMetadataFromInfo } = await import('../../workspace/api');
      const sessionId = store.sessionId;
      if (!sessionId) {
        return;
      }
      const agentsData = await listAgents(sessionId, workspaceId);
      const convertedAgents: WorkspaceAgent[] = agentsData.map((a) => ({
        sessionId: a.session_id,
        workspaceId,
        role: a.role as WorkspaceAgent['role'],
        skillId: a.skill_id,
        status: a.status as WorkspaceAgent['status'],
        joinedAt: a.joined_at,
        lastActiveAt: a.last_active_at,
        metadata: agentMetadataFromInfo(a),
        // 🆕 C12: inbox 未消费消息数（后端查询失败为 0）
        pendingInboxCount: a.pending_inbox_count,
      }));
      useWorkspaceStore.getState().setAgents(convertedAgents);
    } catch (e: unknown) {
      console.warn('[ToolCall] refreshWorkspaceAgents failed for', workspaceId, e);
    }
  })();
}

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 工具调用开始时的 payload
 */
interface ToolCallStartPayload extends EventStartPayload {
  /** 工具名称 */
  toolName: string;
  /** 工具输入参数 */
  toolInput: Record<string, unknown>;
}

/**
 * 图片生成开始时的 payload
 */
interface ImageGenStartPayload extends EventStartPayload {
  /** 生成提示词 */
  prompt: string;
  /** 可选参数 */
  width?: number;
  height?: number;
  model?: string;
}

// ============================================================================
// 工具调用事件处理器 (tool_call)
// ============================================================================

/**
 * 通用工具调用事件处理器
 *
 * 处理 MCP 工具的执行流程：
 * 1. onStart: 创建或复用 mcp_tool 块，设置工具名和输入
 * 2. onChunk: 追加流式输出（如 stdout）
 * 3. onEnd: 设置工具输出结果
 * 4. onError: 标记错误状态
 */
const toolCallEventHandler: EventHandler = {
  /**
   * 处理 tool_call_start 事件
   * 复用已存在的 preparing 块或创建新的 mcp_tool 块
   */
  onStart: (
    store: ChatStore,
    messageId: string,
    payload: EventStartPayload,
    backendBlockId?: string
  ): string => {
    const { toolName, toolInput, toolCallId } = payload as ToolCallStartPayload & { toolCallId?: string };

    // 🆕 调试：工具调用开始执行
    emitToolCallDebug('info', 'backend:start', `${toolName} 开始执行`, () => ({
      toolName, toolCallId, blockId: backendBlockId,
      detail: { toolInput, preparingBlockFound: false /* updated below */ },
    }));
    if (toolCallId) trackStart(toolCallId, backendBlockId, toolName);

    // 🆕 2026-01-21: 判断是否是 coordinator_sleep 工具，需要创建 sleep 类型块
    // 这样 SleepBlockComponent 才能渲染，展示嵌入的子代理 ChatContainer
    // 🆕 subagent_call 创建 subagent_embed 块，与后端历史加载映射（context.rs
    // get_block_type_for_tool_static）保持一致，使嵌入卡片在实时流式时也能出现
    const strippedToolName = stripToolNamePrefix(toolName);
    const isSleepTool = strippedToolName === 'coordinator_sleep';
    const isAskUserTool = strippedToolName === 'ask_user';
    const isSubagentCallTool = SUBAGENT_EMBED_TOOL_NAMES.has(strippedToolName);
    // 与后端持久化的 QBANK_QUESTIONS 映射一致，实时展示可勾选的题目草稿。
    const isQbankGenerationTool = strippedToolName === 'qbank_generate_questions';
    // ACR R1-09 / R2-05 / R3-01: workbench_* 与域委托写 → workbench_ops（撤销入口）
    const blockType = isSleepTool
      ? 'sleep'
      : isAskUserTool
        ? 'ask_user'
        : isSubagentCallTool
          ? 'subagent_embed'
          : isWorkbenchOpsToolName(toolName)
            ? 'workbench_ops'
            : isQbankGenerationTool
              ? 'qbank_questions'
              : 'mcp_tool';

    // 🆕 2026-01-16: 尝试复用已存在的 preparing 块
    // 幂等：同一 toolCallId 只保留一个块。若因重复 preparing 事件 / 流重试残留
    // 了多个占位块，复用第一个（保持其在时间线中的位置），其余同消息的占位块
    // 直接移除——否则它们会以「准备中/执行中」孤儿行停留到 stream_complete。
    let preparingBlockId: string | undefined;
    if (toolCallId) {
      const preparingIds = findPreparingBlockIds(store, messageId, toolCallId);
      preparingBlockId = preparingIds[0];
      const primaryMessageId = preparingBlockId
        ? store.blocks.get(preparingBlockId)?.messageId
        : undefined;
      for (const extraId of preparingIds.slice(1)) {
        if (store.blocks.get(extraId)?.messageId !== primaryMessageId) continue;
        if (extraId === backendBlockId) continue;
        console.warn(
          `[ToolCall] Removing duplicate preparing block ${extraId} for toolCallId=${toolCallId}`
        );
        store.deleteBlock?.(extraId);
      }
    }

    // 🔧 2026-02-16 修复：preparing 块 → 执行块转换时保持 blockIds 顺序
    // 旧方案 deleteBlock+createBlockWithId 会把新块 push 到 blockIds 末尾，
    // 导致多工具并发时 UI 顺序错乱（preparing 块在前，完成块在后）。
    // 新方案使用 replaceBlockId 原地替换，保持原始顺序。
    let blockId: string;
    
    if (preparingBlockId && backendBlockId) {
      // 情况 1: 有 preparing 块 + 有后端 block_id
      // 原地替换块 ID，保持在 blockIds 中的位置不变
      if (store.replaceBlockId) {
        store.replaceBlockId(preparingBlockId, backendBlockId);
        blockId = backendBlockId;
      } else {
        // 降级：replaceBlockId 不可用时回退到旧方案
        store.deleteBlock?.(preparingBlockId);
        blockId = store.createBlockWithId(messageId, blockType, backendBlockId);
      }
    } else if (preparingBlockId) {
      // 情况 2: 有 preparing 块 + 无后端 block_id，直接复用
      // 🆕 2026-01-21: 如果 preparing 块类型与目标块类型不一致（sleep/subagent_embed 等），更新块类型
      const preparingBlock = store.blocks.get(preparingBlockId);
      if (preparingBlock && preparingBlock.type !== blockType) {
        store.updateBlock(preparingBlockId, { type: blockType } as any);
      }
      blockId = preparingBlockId;
    } else if (backendBlockId) {
      // 情况 3: 无 preparing 块 + 有后端 block_id
      // 工具的瞬时失败重试会对同一逻辑块再次发 start。已存在时直接复用，
      // 否则 createBlockWithId 会把同一 ID 再次追加到 message.blockIds。
      blockId = store.blocks.has(backendBlockId)
        ? backendBlockId
        : store.createBlockWithId(messageId, blockType, backendBlockId);
    } else {
      // 情况 4: 无 preparing 块 + 无后端 block_id
      // 前端生成 block_id
      blockId = store.createBlock(messageId, blockType);
    }

    // ACR R2-05：桥 runId 现为 block_id；workbench 卡把 toolCallId 与 block.id 都保留，
    // 撤销经 resolveWorkbenchRunId(hasRun) 选账本实际键。流式仍写 LLM toolCallId。
    // 设置完整的工具信息，清空 preparing 阶段积累的 args 预览 content
    store.updateBlock(blockId, {
      type: blockType,
      toolName,
      toolInput,
      toolCallId,
      isPreparing: false,
      content: '',
      error: undefined,
      toolOutput: undefined,
      endedAt: undefined,
    });

    // 🔧 修复：立即将状态更新为 running
    store.updateBlockStatus(blockId, 'running');

    // 🆕 ask_user 阻塞交互：设置输入栏接管状态
    if (isAskUserTool && toolInput) {
      const askInput = toolInput as {
        question?: string;
        // LLM 实际可能返回 string[] 或 { label, value }[]，需做归一化
        options?: unknown;
        multiple?: boolean;
        allowCustom?: boolean;
        timeoutSeconds?: number;
        context?: string;
        html?: string;
        ui?: string;
        title?: string;
      };
      // 归一化 options：兼容 LLM 误把 options 输出为 { label, value } 对象数组的情况
      // 否则 React 渲染 <span>{option}</span> 时会抛 "Objects are not valid as a React child"
      const normalizedOptions: Array<string | { label: string; reason?: string }> = Array.isArray(askInput.options)
        ? askInput.options
            .map((opt) => {
              if (typeof opt === 'string') return opt;
              if (opt && typeof opt === 'object') {
                const o = opt as { label?: unknown; value?: unknown; text?: unknown; reason?: unknown };
                const label =
                  typeof o.label === 'string'
                    ? o.label
                    : typeof o.value === 'string'
                      ? o.value
                      : typeof o.text === 'string'
                        ? o.text
                        : null;
                if (label) {
                  return {
                    label,
                    reason: typeof o.reason === 'string' ? o.reason : undefined,
                  };
                }
                try {
                  return JSON.stringify(opt);
                } catch {
                  return String(opt);
                }
              }
              return String(opt ?? '');
            })
            .filter((option) => {
              if (typeof option === 'string') {
                return option.length > 0;
              }
              return option.label.length > 0;
            })
        : [];
      store.setBlockingInteraction({
        kind: 'ask_user',
        blockId,
        toolCallId: toolCallId || '',
        question: typeof askInput.question === 'string' ? askInput.question : '',
        options: normalizedOptions,
        multiple: askInput.multiple ?? false,
        allowCustom: askInput.allowCustom ?? true,
        timeoutSeconds: askInput.timeoutSeconds ?? null,
        context: typeof askInput.context === 'string' ? askInput.context : undefined,
        ...(typeof askInput.html === 'string' ? { html: askInput.html } : {}),
        ...(typeof askInput.ui === 'string' ? { ui: askInput.ui } : {}),
        ...(typeof askInput.title === 'string' ? { title: askInput.title } : {}),
      });
    }

    // 清除消息级别的 preparingToolCall 状态
    store.clearPreparingToolCall?.(messageId);

    // 🆕 调试：记录 blockId 映射
    emitToolCallDebug('debug', 'frontend:blockUpdate', `${toolName} 块 → running`, () => ({
      toolName, toolCallId, blockId,
      detail: { hadPreparingBlock: !!preparingBlockId, usedReplaceBlockId: !!(preparingBlockId && backendBlockId && store.replaceBlockId) },
    }));

    return blockId;
  },

  /**
   * 处理 tool_call_chunk 事件
   * MCP 工具可能有流式输出（如代码执行的 stdout）
   */
  onChunk: (store: ChatStore, blockId: string, chunk: string): void => {
    // 追加流式内容
    store.updateBlockContent(blockId, chunk);
  },

  /**
   * 处理 tool_call_end 事件
   * 设置工具执行结果
   */
  onEnd: (store: ChatStore, blockId: string, result?: unknown): void => {
    // 🔧 2026-02-17: trackEnd 已输出带完整计时的汇总日志，此处不再重复 emitToolCallDebug
    const endBlock = store.blocks.get(blockId);
    if (endBlock?.toolCallId) trackEnd(endBlock.toolCallId, true);

    // 设置结果（会自动更新状态为 success）
    store.setBlockResult(blockId, result);

    // 🆕 ask_user 阻塞交互：清除输入栏接管状态
    if (endBlock?.type === 'ask_user') {
      store.clearBlockingInteraction();
    }

    // 🔧 解包 result：后端发送 { result: actualOutput, durationMs }
    // 注意：store.blocks.get(blockId) 返回的是旧快照，toolOutput 可能还是 undefined
    // 所以我们直接从 result 参数解包
    let unwrappedResult: unknown = result;
    if (result && typeof result === 'object' && 'result' in result) {
      unwrappedResult = (result as { result: unknown }).result;
    }

    // 🆕 工作区工具特殊处理：自动设置 currentWorkspaceId 并创建状态块
    const block = store.blocks.get(blockId);
    if (block?.toolName) {
      // 兼容多种前缀格式：builtin-xxx, mcp.tools.xxx, xxx
      const toolName = block.toolName
        .replace('builtin-', '')
        .replace('mcp.tools.', '')
        .replace(/^.*\./, ''); // 移除任何剩余的命名空间前缀
      
      console.log('[ToolCall] onEnd - toolName:', block.toolName, '-> stripped:', toolName, 'unwrappedResult:', unwrappedResult);

      // 单 Task 委托：subagent_call 缺省 workspace_id 时后端自动创建内部跟踪工作区
      // （auto_created_workspace=true）。仅同步 workspaceStore（不创建 workspace_status 卡片），
      // 供 subagent_embed / sleepBlock 订阅子代理状态。
      if (toolName === 'subagent_call' && unwrappedResult && typeof unwrappedResult === 'object') {
        const subagentResult = unwrappedResult as {
          workspace_id?: string;
          agent_session_id?: string;
          run_id?: string;
          status?: string;
          auto_created_workspace?: boolean;
        };
        if (subagentResult.auto_created_workspace === true && subagentResult.workspace_id) {
          console.log(
            '[ToolCall] subagent_call auto-created workspace, syncing store:',
            subagentResult.workspace_id
          );

          const workspaceStore = useWorkspaceStore.getState();
          const now = new Date().toISOString();
          const sessionId = store.sessionId;

          workspaceStore.setCurrentWorkspace(subagentResult.workspace_id);
          workspaceStore.setWorkspace({
            id: subagentResult.workspace_id,
            status: 'active',
            creatorSessionId: sessionId,
            createdAt: now,
            updatedAt: now,
          });

          refreshWorkspaceAgents(store, subagentResult.workspace_id);

          const logDebug = (window as any).__multiAgentDebug?.log;
          if (logDebug) {
            logDebug('block', 'FRONTEND_SUBAGENT_AUTO_CREATED_WORKSPACE', {
              blockId,
              workspaceId: subagentResult.workspace_id,
              agentSessionId: subagentResult.agent_session_id,
              runId: subagentResult.run_id,
              status: subagentResult.status,
            }, 'info');
          }
        }
      }

      // 🆕 模板工具：创建独立 template_preview 块直接显示在聊天流中
      const TEMPLATE_VISUAL_TOOLS = new Set([
        'template_get', 'template_create', 'template_update',
        'template_fork', 'template_preview',
      ]);

      if (TEMPLATE_VISUAL_TOOLS.has(toolName) && unwrappedResult) {
        const templateResult = unwrappedResult as Record<string, unknown>;
        if (templateResult._templateVisual === true) {
          const messageId = block.messageId;
          const previewBlockId = store.createBlock(messageId, 'template_preview');

          store.updateBlock(previewBlockId, {
            toolName: 'template_preview',
            toolInput: {
              sourceToolName: block.toolName,
              templateId: templateResult.templateId || templateResult.id,
            },
            toolOutput: templateResult,
          });
          store.updateBlockStatus(previewBlockId, 'success');

          // 持久化到数据库（同 workspace_status 模式）
          void (async () => {
            try {
              const { invoke } = await import('@tauri-apps/api/core');
              await invoke('chat_v2_upsert_streaming_block', {
                blockId: previewBlockId,
                messageId,
                sessionId: store.sessionId || undefined,
                blockType: 'template_preview',
                content: '',
                status: 'success',
                toolName: 'template_preview',
                toolInputJson: JSON.stringify({
                  sourceToolName: block.toolName,
                  templateId: templateResult.templateId || templateResult.id,
                }),
                toolOutputJson: JSON.stringify(templateResult),
              });
            } catch (e) {
              console.warn('[ToolCall] Failed to persist template_preview block:', e);
            }
          })();
        }
      }

      // 技能安装/工坊落地/删除成功后，立即重扫文件系统注册表，
      // 避免技能管理页仍显示变更前的旧列表。
      const isSkillFilesystemMutatingTool =
        toolName === 'skill_install' ||
        toolName === 'skill_market_download_and_scan' ||
        toolName === 'skill_workshop_apply' ||
        toolName === 'skill_remove';
      if (isSkillFilesystemMutatingTool && unwrappedResult && typeof unwrappedResult === 'object') {
        const mutateResult = unwrappedResult as {
          skill_id?: unknown;
          applied?: unknown;
          removed?: unknown;
          installed?: unknown;
          scan?: { skill_id?: unknown };
          path?: unknown;
        };
        const mutatedSkillId =
          typeof mutateResult.skill_id === 'string'
            ? mutateResult.skill_id
            : typeof mutateResult.scan?.skill_id === 'string'
              ? mutateResult.scan.skill_id
              : null;
        const mutated =
          typeof mutatedSkillId === 'string' &&
          mutatedSkillId.length > 0 &&
          (toolName !== 'skill_workshop_apply' || mutateResult.applied === true) &&
          (toolName !== 'skill_remove' || mutateResult.removed === true) &&
          (toolName !== 'skill_market_download_and_scan' || mutateResult.installed === true);
        if (mutated) {
          // skill_remove：后端已删目录 + provenance + 信任记录；
          // 这里同步清掉 localStorage 里的启停覆盖，避免残留条目
          if (toolName === 'skill_remove') {
            try {
              setSkillDisabled(mutatedSkillId, false);
            } catch (error) {
              console.warn('[ToolCall] Failed to clear enable override after skill_remove:', error);
            }
          }
          void reloadSkills()
            .then(() => {
              console.log('[ToolCall] Reloaded skills after', toolName, mutatedSkillId);
            })
            .catch((error: unknown) => {
              console.warn('[ToolCall] Failed to reload skills after', toolName, error);
            });
        }
      }

      // 🆕 load_skills 工具特殊处理：前端执行实际加载逻辑
      // 兼容带前缀的工具名（builtin-load_skills, builtin:load_skills, mcp_load_skills）
      const isLoadSkillsTool = toolName === LOAD_SKILLS_TOOL_NAME ||
        toolName === `builtin-${LOAD_SKILLS_TOOL_NAME}` ||
        toolName === `builtin:${LOAD_SKILLS_TOOL_NAME}` ||
        toolName === `mcp_${LOAD_SKILLS_TOOL_NAME}`;
      if (isLoadSkillsTool) {
        const skillResult = unwrappedResult as {
          status?: string;
          skill_ids?: string[];
          loaded_skill_ids?: string[];
          active_skill_ids?: string[];
          skill_state_version?: number;
          skill_state?: unknown;
        };
        console.log('[ToolCall] load_skills result:', skillResult);

        if (skillResult.status === 'success') {
          const sessionId = store.sessionId || 'unknown';
          const loadedSkillIds = Array.isArray(skillResult.loaded_skill_ids)
            ? skillResult.loaded_skill_ids
            : Array.isArray(skillResult.skill_ids)
              ? skillResult.skill_ids
              : [];
          const parentMessage = store.messageMap.get(block.messageId);
          const isVariantToolCall = !!parentMessage?.variants?.some((variant) =>
            variant.blockIds.includes(blockId)
          );

          if (!isVariantToolCall) {
            syncLoadedSkillsFromBackend(sessionId, loadedSkillIds, { replace: true });
          }

          if (skillResult.skill_state && typeof store.setSkillStateJson === 'function') {
            try {
              store.setSkillStateJson(JSON.stringify(skillResult.skill_state));
            } catch (error) {
              console.warn('[ToolCall] Failed to serialize backend skill_state:', error);
              store.setSkillStateJson(null);
            }
          }

          console.log('[ToolCall] load_skills: synced from backend', {
            sessionId,
            loaded: loadedSkillIds.length,
            active: Array.isArray(skillResult.active_skill_ids) ? skillResult.active_skill_ids.length : 0,
            skillStateVersion: skillResult.skill_state_version,
          });
        }
      }
    }
  },

  /**
   * 处理 tool_call_error 事件
   * 标记工具执行失败
   */
  onError: (store: ChatStore, blockId: string, error: string): void => {
    // 🔧 2026-02-17: trackEnd 已输出带完整计时的汇总日志，此处不再重复 emitToolCallDebug
    const errBlock = store.blocks.get(blockId);
    if (errBlock?.toolCallId) trackEnd(errBlock.toolCallId, false);

    store.setBlockError(blockId, error);

    // 🆕 ask_user 阻塞交互：清除输入栏接管状态
    if (errBlock?.type === 'ask_user') {
      store.clearBlockingInteraction();
    }
  },
};

// ============================================================================
// 图片生成事件处理器 (image_gen)
// ============================================================================

/**
 * 图片生成事件处理器
 *
 * 处理图片生成流程：
 * 1. onStart: 创建 image_gen 块，设置提示词
 * 2. onChunk: 图片生成通常无流式输出（留空）
 * 3. onEnd: 设置生成的图片结果
 * 4. onError: 标记生成失败
 */
const imageGenEventHandler: EventHandler = {
  /**
   * 处理 image_gen_start 事件
   * 创建 image_gen 块并设置提示词
   */
  onStart: (
    store: ChatStore,
    messageId: string,
    payload: EventStartPayload,
    backendBlockId?: string
  ): string => {
    const payloadObj = (payload ?? {}) as ImageGenStartPayload & { toolCallId?: string };
    const { prompt, width, height, model } = payloadObj;
    const rawToolCallId =
      typeof payloadObj.toolCallId === 'string' && payloadObj.toolCallId
        ? payloadObj.toolCallId
        : undefined;

    // 🆕 2026-02-17: 生命周期追踪 — 若携带原始 toolCallId，先清理对应 preparing 占位块
    const syntheticToolCallId = rawToolCallId || backendBlockId || `img_${Date.now()}`;
    emitToolCallDebug('info', 'backend:start', `image_gen 开始执行`, () => ({
      toolName: 'image_gen', toolCallId: syntheticToolCallId, blockId: backendBlockId,
      detail: { prompt: prompt?.slice(0, 80), width, height, model },
    }));
    trackStart(syntheticToolCallId, backendBlockId, 'image_gen');

    const blockId = resolveBlockWithPreparingCleanup(
      store,
      messageId,
      'image_gen',
      rawToolCallId,
      backendBlockId,
    );

    // 设置输入信息（使用 toolInput 字段）
    store.updateBlock(blockId, {
      toolInput: { prompt, width, height, model },
      toolCallId: syntheticToolCallId, // 🆕 关联 toolCallId 以便 onEnd/onError 追踪
      toolOutput: undefined,
    });

    // 🔧 修复：立即将状态更新为 running，让前端显示生成中状态
    store.updateBlockStatus(blockId, 'running');

    return blockId;
  },

  /**
   * 处理 image_gen_chunk 事件
   * 图片生成通常不需要流式更新
   */
  onChunk: (_store: ChatStore, _blockId: string, _chunk: string): void => {
    // 图片生成通常无流式输出，此处留空
    // 如果未来有进度信息，可以在这里处理
  },

  /**
   * 处理 image_gen_end 事件
   * 设置生成的图片
   */
  onEnd: (store: ChatStore, blockId: string, result?: unknown): void => {
    // 🆕 2026-02-17: 生命周期追踪
    const block = store.blocks.get(blockId);
    if (block?.toolCallId) trackEnd(block.toolCallId, true);

    // 设置结果（会自动更新状态为 success）
    store.setBlockResult(blockId, result);
  },

  /**
   * 处理 image_gen_error 事件
   * 标记图片生成失败
   */
  onError: (store: ChatStore, blockId: string, error: string): void => {
    // 🆕 2026-02-17: 生命周期追踪
    const block = store.blocks.get(blockId);
    if (block?.toolCallId) trackEnd(block.toolCallId, false);

    store.setBlockError(blockId, error);
  },
};

// ============================================================================
// 🆕 2026-01-15: 工具调用准备中事件处理器 (tool_call_preparing)
// ============================================================================

/**
 * 工具调用准备中事件的 payload
 */
interface ToolCallPreparingPayload extends EventStartPayload {
  /** 工具调用 ID */
  toolCallId: string;
  /** 工具名称 */
  toolName: string;
  /** 状态（preparing） */
  status: 'preparing';
}

/**
 * 工具调用准备中事件处理器
 *
 * 在 LLM 开始生成工具调用参数时触发，创建预渲染的工具块。
 * 这样用户可以在参数累积过程中看到"正在准备工具调用"的 UI 反馈。
 *
 * 🆕 2026-01-16: 改为创建实际的工具块，而不仅仅是设置状态
 */
const toolCallPreparingEventHandler: EventHandler = {
  /**
   * 处理 tool_call_preparing 事件
   * 创建 preparing 状态的工具块，让用户看到工具调用正在准备
   */
  onStart: (
    store: ChatStore,
    messageId: string,
    payload: EventStartPayload,
    backendBlockId?: string
  ): string => {
    const { toolCallId, toolName } = payload as ToolCallPreparingPayload;

    console.log(
      `[ToolCallPreparing] Creating preparing block: ${toolName} (toolCallId=${toolCallId})`
    );

    // 🆕 调试：工具准备中
    emitToolCallDebug('info', 'frontend:preparing', `${toolName} 准备中`, () => ({
      toolName, toolCallId,
    }));
    if (toolCallId) trackPreparing(toolCallId, toolName);

    // 🆕 2026-01-21: 判断是否是 coordinator_sleep 工具，需要创建 sleep 类型块
    // 🆕 subagent_call 创建 subagent_embed 块（与实时/历史两条路径的块类型保持一致）
    const strippedToolName = stripToolNamePrefix(toolName);
    const isSleepTool = strippedToolName === 'coordinator_sleep';
    const isAskUserTool = strippedToolName === 'ask_user';
    const isSubagentCallTool = SUBAGENT_EMBED_TOOL_NAMES.has(strippedToolName);
    // ACR R1-09 / R2-05 / R3-01: workbench_* 与域委托写 → workbench_ops
    const blockType = isSleepTool
      ? 'sleep'
      : isAskUserTool
        ? 'ask_user'
        : isSubagentCallTool
          ? 'subagent_embed'
          : isWorkbenchOpsToolName(toolName)
            ? 'workbench_ops'
            : 'mcp_tool';

    // 幂等：同一 toolCallId 已有 preparing 占位块时不再新建（否则 tool_call start
    // 只会提升其中一个，其余成为孤儿行）。后端换了 block_id 时原地改名，
    // 让后续以新 block_id 寻址的参数预览 chunk 仍能落到这个占位块上。
    const existingPreparingId = toolCallId
      ? findPreparingBlockIds(store, messageId, toolCallId).find(
          (id) => store.blocks.get(id)?.messageId === messageId
        )
      : undefined;
    if (existingPreparingId) {
      console.warn(
        `[ToolCallPreparing] Duplicate preparing for toolCallId=${toolCallId}, reusing block ${existingPreparingId}`
      );
      if (backendBlockId && backendBlockId !== existingPreparingId && store.replaceBlockId) {
        store.replaceBlockId(existingPreparingId, backendBlockId);
        return backendBlockId;
      }
      return existingPreparingId;
    }

    // 创建预渲染的工具块（使用后端 block_id 或前端生成）
    const blockId = backendBlockId
      ? store.createBlockWithId(messageId, blockType, backendBlockId)
      : store.createBlock(messageId, blockType);

    // 设置 preparing 状态和工具信息
    store.updateBlock(blockId, {
      toolName,
      toolCallId,
      isPreparing: true,
    });

    // 状态设为 pending（区别于 running）
    store.updateBlockStatus(blockId, 'pending');

    // 同时保留消息级别的状态（向后兼容）
    store.setPreparingToolCall?.(messageId, { toolCallId, toolName });

    return blockId;
  },

  /**
   * 处理 tool_call_preparing_chunk 事件
   * LLM 正在流式生成工具参数，追加到 block.content 供前端实时预览
   */
  onChunk: (store: ChatStore, blockId: string, chunk: string): void => {
    store.updateBlockContent(blockId, chunk);
  },

  /**
   * 准备阶段被正常放弃（如上下文压缩重跑、轮次重置）时清除未晋升的 preparing 占位块
   */
  onEnd: (store: ChatStore, blockId: string): void => {
    const block = store.blocks?.get(blockId);
    if (!block) return;
    if (block.toolCallId) {
      trackEnd(block.toolCallId, true);
    }
    if (block.isPreparing) {
      store.deleteBlock?.(blockId);
    }
    if (block.messageId) {
      store.clearPreparingToolCall?.(block.messageId);
    }
  },

  /**
   * 准备阶段因流中断、取消或上游错误未进入执行阶段时，将占位块推进为终态错误
   */
  onError: (store: ChatStore, blockId: string, error: string): void => {
    const block = store.blocks?.get(blockId);
    if (block?.toolCallId) {
      trackEnd(block.toolCallId, false);
    }
    store.updateBlock(blockId, { isPreparing: false });
    store.setBlockError(blockId, error || 'Tool preparation failed');
    if (block?.messageId) {
      store.clearPreparingToolCall?.(block.messageId);
    }
  },
};

// ============================================================================
// 自动注册
// ============================================================================

// 注册工具调用事件处理器
eventRegistry.register('tool_call', toolCallEventHandler);

// 注册图片生成事件处理器
eventRegistry.register('image_gen', imageGenEventHandler);

// 🆕 2026-01-15: 注册工具调用准备中事件处理器
eventRegistry.register('tool_call_preparing', toolCallPreparingEventHandler);

// 导出 handlers 供测试使用
export { toolCallEventHandler, imageGenEventHandler, toolCallPreparingEventHandler };
