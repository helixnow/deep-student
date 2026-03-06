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
import type { WorkspaceAgent, WorkspaceMessage } from '../../workspace/types';
// 🆕 Skills 渐进披露（处理 load_skills 工具调用）
import {
  LOAD_SKILLS_TOOL_NAME,
  syncLoadedSkillsFromBackend,
} from '../../skills/progressiveDisclosure';
// 🆕 2026-02-16: 工具调用生命周期调试插件
import {
  emitToolCallDebug,
  trackPreparing,
  trackStart,
  trackEnd,
} from '../../../debug-panel/plugins/ToolCallLifecycleDebugPlugin';

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 更新 workspace_status 块的快照数据
 * 用于在 agents 变化后同步更新块的持久化数据
 */
function updateWorkspaceStatusBlockSnapshot(
  store: ChatStore,
  workspaceId: string,
  agents: WorkspaceAgent[]
) {
  // 找到所有 workspace_status 块
  for (const [blockId, block] of store.blocks) {
    if (block.type === 'workspace_status') {
      const input = block.toolInput as { workspaceId?: string } | undefined;
      const output = block.toolOutput as { workspace_id?: string; snapshotName?: string; snapshotCreatedAt?: string } | undefined;
      if (input?.workspaceId === workspaceId || output?.workspace_id === workspaceId) {
        // 更新快照
        store.updateBlock(blockId, {
          toolOutput: {
            ...output,
            workspace_id: workspaceId,
            snapshotAgents: agents.map(a => ({
              session_id: a.sessionId,
              role: a.role,
              status: a.status,
              skill_id: a.skillId || null,
            })),
          },
        });
        console.log('[ToolCall] Updated workspace_status block snapshot:', blockId);
      }
    }
  }
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
    emitToolCallDebug('info', 'backend:start', `${toolName} 开始执行`, {
      toolName, toolCallId, blockId: backendBlockId,
      detail: { toolInput, preparingBlockFound: false /* updated below */ },
    });
    if (toolCallId) trackStart(toolCallId, backendBlockId, toolName);

    // 🆕 2026-01-21: 判断是否是 coordinator_sleep 工具，需要创建 sleep 类型块
    // 这样 SleepBlockComponent 才能渲染，展示嵌入的子代理 ChatContainer
    const strippedToolName = (toolName || '')
      .replace('builtin-', '')
      .replace('mcp.tools.', '')
      .replace(/^.*\./, '');
    const isSleepTool = strippedToolName === 'coordinator_sleep';
    const isAskUserTool = strippedToolName === 'ask_user';
    const blockType = isSleepTool ? 'sleep' : isAskUserTool ? 'ask_user' : 'mcp_tool';

    // 🆕 2026-01-16: 尝试复用已存在的 preparing 块
    let preparingBlockId: string | undefined;
    if (toolCallId) {
      // 查找具有相同 toolCallId 的 preparing 块
      for (const [id, block] of store.blocks) {
        if (block.toolCallId === toolCallId && block.isPreparing) {
          preparingBlockId = id;
          break;
        }
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
      // 🆕 2026-01-21: 如果是 sleep 工具，需要更新块类型
      if (isSleepTool) {
        store.updateBlock(preparingBlockId, { type: 'sleep' } as any);
      }
      blockId = preparingBlockId;
    } else if (backendBlockId) {
      // 情况 3: 无 preparing 块 + 有后端 block_id
      // 使用后端 block_id 创建新块
      blockId = store.createBlockWithId(messageId, blockType, backendBlockId);
    } else {
      // 情况 4: 无 preparing 块 + 无后端 block_id
      // 前端生成 block_id
      blockId = store.createBlock(messageId, blockType);
    }

    // 设置完整的工具信息，清空 preparing 阶段积累的 args 预览 content
    store.updateBlock(blockId, {
      toolName,
      toolInput,
      toolCallId,
      isPreparing: false,
      content: '',
    });

    // 🔧 修复：立即将状态更新为 running
    store.updateBlockStatus(blockId, 'running');

    // 清除消息级别的 preparingToolCall 状态
    store.clearPreparingToolCall?.(messageId);

    // 🆕 调试：记录 blockId 映射
    emitToolCallDebug('debug', 'frontend:blockUpdate', `${toolName} 块 → running`, {
      toolName, toolCallId, blockId,
      detail: { hadPreparingBlock: !!preparingBlockId, usedReplaceBlockId: !!(preparingBlockId && backendBlockId && store.replaceBlockId) },
    });

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
      
      // workspace_create 成功后，自动设置当前工作区 ID 并创建状态块
      if (toolName === 'workspace_create' && unwrappedResult) {
        const workspaceResult = unwrappedResult as { workspace_id?: string; status?: string; message?: string };
        console.log('[ToolCall] workspace_create result:', workspaceResult);
        if (workspaceResult.workspace_id && workspaceResult.status === 'created') {
          console.log('[ToolCall] workspace_create success, setting currentWorkspaceId:', workspaceResult.workspace_id);

          const workspaceStore = useWorkspaceStore.getState();
          const now = new Date().toISOString();
          const sessionId = store.sessionId;
          if (!sessionId) {
            console.warn('[ToolCall] workspace_create: missing sessionId, skip persistence');
          }

          workspaceStore.setCurrentWorkspace(workspaceResult.workspace_id);

          workspaceStore.setWorkspace({
            id: workspaceResult.workspace_id,
            name: (block.toolInput as { name?: string })?.name,
            status: 'active',
            creatorSessionId: sessionId,
            createdAt: now,
            updatedAt: now,
          });

          workspaceStore.addAgent({
            sessionId: sessionId || 'unknown',
            workspaceId: workspaceResult.workspace_id,
            role: 'coordinator',
            status: 'idle',
            joinedAt: now,
            lastActiveAt: now,
          });

          void (async () => {
            try {
              const { listAgents } = await import('../../workspace/api');
              if (!sessionId) {
                return;
              }
              const agentsData = await listAgents(sessionId, workspaceResult.workspace_id!);

              const convertedAgents: WorkspaceAgent[] = agentsData.map((a) => ({
                sessionId: a.session_id,
                workspaceId: workspaceResult.workspace_id!,
                role: a.role as WorkspaceAgent['role'],
                skillId: a.skill_id,
                status: a.status as WorkspaceAgent['status'],
                joinedAt: a.joined_at,
                lastActiveAt: a.last_active_at,
              }));

              workspaceStore.setAgents(convertedAgents);
            } catch (e: unknown) {
              console.warn('[ToolCall] workspace_create: failed to refresh agents', e);
            }
          })();

          console.log('[ToolCall] workspace_create: set workspace and coordinator agent');

          // 🆕 创建 workspace_status 块显示工作区状态面板
          const messageId = block.messageId;
          const statusBlockId = store.createBlock(messageId, 'workspace_status');
          const workspaceName = (block.toolInput as { name?: string })?.name;
          const toolInput = { workspaceId: workspaceResult.workspace_id, workspaceName };
          const toolOutput = {
            ...workspaceResult,
            // 🆕 保存快照数据用于历史加载渲染
            snapshotName: workspaceName,
            snapshotCreatedAt: now,
            snapshotAgents: [{
              session_id: sessionId,
              role: 'coordinator',
              status: 'idle',
              skill_id: null,
            }],
          };
          store.updateBlock(statusBlockId, {
            toolName: 'workspace_status',
            toolInput,
            toolOutput,
          });
          store.updateBlockStatus(statusBlockId, 'success');
          console.log('[ToolCall] Created workspace_status block:', statusBlockId);

          // 🆕 P37 调试：直接调用调试日志
          const logDebug = (window as any).__multiAgentDebug?.log;
          if (logDebug) {
            logDebug('block', 'FRONTEND_CREATE_WORKSPACE_STATUS_BLOCK', {
              blockId: statusBlockId,
              messageId,
              snapshotAgents: 1,
            }, 'info');
          }

          // 🔧 P35: 立即保存 workspace_status 块到后端数据库
          void (async () => {
            try {
              const { invoke } = await import('@tauri-apps/api/core');
              
              // 🆕 P37 调试：记录 upsert 调用
              if (logDebug) {
                logDebug('block', 'UPSERT_WORKSPACE_STATUS_BLOCK', {
                  blockId: statusBlockId,
                  messageId,
                  hasToolOutput: true,
                  snapshotAgentsCount: toolOutput.snapshotAgents?.length || 0,
                }, 'info');
              }
              
              await invoke('chat_v2_upsert_streaming_block', {
                blockId: statusBlockId,
                messageId,
                sessionId: sessionId || undefined,
                blockType: 'workspace_status',
                content: '',
                status: 'success',
                toolName: 'workspace_status',
                toolInputJson: JSON.stringify(toolInput),
                toolOutputJson: JSON.stringify(toolOutput),
              });
              console.log('[ToolCall] workspace_status block persisted:', statusBlockId);
              
              // 🆕 P37 调试：记录成功
              if (logDebug) {
                logDebug('block', 'UPSERT_WORKSPACE_STATUS_BLOCK_SUCCESS', {
                  blockId: statusBlockId,
                  messageId,
                }, 'success');
              }
            } catch (e: unknown) {
              console.warn('[ToolCall] Failed to persist workspace_status block:', e);
              // 🆕 P37 调试：记录失败
              if (logDebug) {
                logDebug('block', 'UPSERT_WORKSPACE_STATUS_BLOCK_ERROR', {
                  blockId: statusBlockId,
                  messageId,
                  error: String(e),
                }, 'error');
              }
            }
          })();

          // 🆕 当 agents 数据更新后，同步更新块的快照并保存
          setTimeout(async () => {
            const latestAgents = useWorkspaceStore.getState().agents;
            if (latestAgents.length > 0) {
              const updatedToolOutput = {
                ...workspaceResult,
                snapshotName: workspaceName,
                snapshotCreatedAt: now,
                snapshotAgents: latestAgents.map(a => ({
                  session_id: a.sessionId,
                  role: a.role,
                  status: a.status,
                  skill_id: a.skillId || null,
                })),
              };
              store.updateBlock(statusBlockId, {
                toolOutput: updatedToolOutput,
              });
              
              // 🔧 P35: 同步更新后端数据库
              try {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke('chat_v2_upsert_streaming_block', {
                  blockId: statusBlockId,
                  messageId,
                  sessionId: sessionId || undefined,
                  blockType: 'workspace_status',
                  content: '',
                  status: 'success',
                  toolName: 'workspace_status',
                  toolInputJson: JSON.stringify(toolInput),
                  toolOutputJson: JSON.stringify(updatedToolOutput),
                });
              } catch (e: unknown) {
                console.warn('[ToolCall] Failed to update workspace_status block:', e);
              }
            }
          }, 500);
        }
      }

      if (toolName === 'workspace_create_agent' && unwrappedResult) {
        const agentResult = unwrappedResult as {
          agent_session_id?: string;
          workspace_id?: string;
          role?: string;
          skill_id?: string;
          status?: string;
        };

        if (agentResult.agent_session_id && agentResult.workspace_id) {
          const workspaceStore = useWorkspaceStore.getState();
          const now = new Date().toISOString();

          if (!workspaceStore.currentWorkspaceId) {
            workspaceStore.setCurrentWorkspace(agentResult.workspace_id);
          }

          const mappedStatus: WorkspaceAgent['status'] =
            agentResult.status === 'auto_starting'
              ? 'running'
              : agentResult.status === 'completed'
                ? 'completed'
                : agentResult.status === 'failed'
                  ? 'failed'
                  : 'idle';

          workspaceStore.addAgent({
            sessionId: agentResult.agent_session_id,
            workspaceId: agentResult.workspace_id,
            role: (agentResult.role as WorkspaceAgent['role']) || 'worker',
            skillId: agentResult.skill_id,
            status: mappedStatus,
            joinedAt: now,
            lastActiveAt: now,
          });

          void (async () => {
            try {
              const { listAgents } = await import('../../workspace/api');
              const agentsData = await listAgents(store.sessionId || 'unknown', agentResult.workspace_id!);
              const convertedAgents: WorkspaceAgent[] = agentsData.map((a) => ({
                sessionId: a.session_id,
                workspaceId: agentResult.workspace_id!,
                role: a.role as WorkspaceAgent['role'],
                skillId: a.skill_id,
                status: a.status as WorkspaceAgent['status'],
                joinedAt: a.joined_at,
                lastActiveAt: a.last_active_at,
              }));
              workspaceStore.setAgents(convertedAgents);

              // 🆕 更新 workspace_status 块的快照
              updateWorkspaceStatusBlockSnapshot(store, agentResult.workspace_id!, convertedAgents);
            } catch (e: unknown) {
              console.warn('[ToolCall] workspace_create_agent: failed to refresh agents', e);
            }
          })();
        }
      }

      if (toolName === 'workspace_send' && block.toolInput) {
        const toolInput = block.toolInput as { workspace_id?: string };
        if (toolInput.workspace_id) {
          const workspaceStore = useWorkspaceStore.getState();
          if (!workspaceStore.currentWorkspaceId) {
            workspaceStore.setCurrentWorkspace(toolInput.workspace_id);
          }
        }
      }

      if (toolName === 'workspace_query' && block.toolInput && unwrappedResult) {
        const toolInput = block.toolInput as { workspace_id?: string; query_type?: string };
        const toolOutput = unwrappedResult as { agents?: unknown; messages?: unknown };
        const workspaceId = toolInput.workspace_id;
        if (workspaceId) {
          const workspaceStore = useWorkspaceStore.getState();
          if (!workspaceStore.currentWorkspaceId) {
            workspaceStore.setCurrentWorkspace(workspaceId);
          }

          if (toolInput.query_type === 'agents' && Array.isArray(toolOutput.agents)) {
            const now = new Date().toISOString();
            const convertedAgents: WorkspaceAgent[] = (toolOutput.agents as Array<any>).map((a) => ({
              sessionId: a.session_id,
              workspaceId,
              role: a.role as WorkspaceAgent['role'],
              skillId: a.skill_id,
              status: a.status as WorkspaceAgent['status'],
              joinedAt: now,
              lastActiveAt: now,
            }));
            workspaceStore.setAgents(convertedAgents);
          }

          if (toolInput.query_type === 'messages' && Array.isArray(toolOutput.messages)) {
            const now = new Date().toISOString();
            const convertedMessages: WorkspaceMessage[] = (toolOutput.messages as Array<any>).map((m) => ({
              id: m.id,
              workspaceId,
              senderSessionId: m.sender,
              targetSessionId: m.target,
              messageType: m.type as WorkspaceMessage['messageType'],
              content: m.content,
              status: 'delivered',
              createdAt: m.created_at || now,
            }));
            workspaceStore.setMessages(convertedMessages);
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

          if (!event.variantId) {
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
    const { prompt, width, height, model } = payload as ImageGenStartPayload;

    // 🆕 2026-02-17: 生命周期追踪 — image_gen 无 preparing 阶段，trackStart 会自动回填
    const syntheticToolCallId = backendBlockId || `img_${Date.now()}`;
    emitToolCallDebug('info', 'backend:start', `image_gen 开始执行`, {
      toolName: 'image_gen', toolCallId: syntheticToolCallId, blockId: backendBlockId,
      detail: { prompt: prompt?.slice(0, 80), width, height, model },
    });
    trackStart(syntheticToolCallId, backendBlockId, 'image_gen');

    // 如果后端传了 blockId，使用它；否则由前端生成
    const blockId = backendBlockId
      ? store.createBlockWithId(messageId, 'image_gen', backendBlockId)
      : store.createBlock(messageId, 'image_gen');

    // 设置输入信息（使用 toolInput 字段）
    store.updateBlock(blockId, {
      toolInput: { prompt, width, height, model },
      toolCallId: syntheticToolCallId, // 🆕 关联 toolCallId 以便 onEnd/onError 追踪
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
    emitToolCallDebug('info', 'frontend:preparing', `${toolName} 准备中`, {
      toolName, toolCallId,
    });
    if (toolCallId) trackPreparing(toolCallId, toolName);

    // 🆕 2026-01-21: 判断是否是 coordinator_sleep 工具，需要创建 sleep 类型块
    const strippedToolName = (toolName || '')
      .replace('builtin-', '')
      .replace('mcp.tools.', '')
      .replace(/^.*\./, '');
    const isSleepTool = strippedToolName === 'coordinator_sleep';
    const isAskUserTool = strippedToolName === 'ask_user';
    const blockType = isSleepTool ? 'sleep' : isAskUserTool ? 'ask_user' : 'mcp_tool';

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
