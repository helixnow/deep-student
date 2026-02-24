import type { Block, BlockType, BlockStatus } from '../types/block';
import type { Message } from '../types/message';
import type { ChatStore, LoadSessionResponseType } from '../types';
import type { ChatStoreState, SetState, GetState } from './types';
import { createDefaultChatParams, createDefaultPanelStates } from './types';
import { getErrorMessage } from '../../../utils/errorUtils';
import { showGlobalNotification } from '../../../components/UnifiedNotification';
import { sessionSwitchPerf } from '../../debug/sessionSwitchPerf';
import { modeRegistry } from '../../registry';
import { SKILL_INSTRUCTION_TYPE_ID } from '../../skills/types';
import { skillDefaults } from '../../skills/skillDefaults';
import { debugLog } from '../../../debug-panel/debugMasterSwitch';
import i18n from 'i18next';
import { showOperationLockNotification } from './createChatStore';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

export function createRestoreActions(
  set: SetState,
  getState: GetState,
) {
  return {
        restoreFromBackend: (response: LoadSessionResponseType): void => {
          const { session, messages, blocks, state } = response;
          const t0 = performance.now();

          // 1. 按 timestamp 排序消息（确保消息顺序正确）
          const tSortStart = performance.now();
          const sortedMessages = [...messages].sort(
            (a, b) => a.timestamp - b.timestamp
          );
          const tSortEnd = performance.now();
          sessionSwitchPerf.mark('set_data_start', {
            phase: 'sort_messages',
            ms: tSortEnd - tSortStart,
          });

          // 2. 转换块数据（先处理，后面可能需要添加从 sources 恢复的块）
          const tBlockMapStart = performance.now();
          const blocksMap = new Map<string, Block>();
          for (const blk of blocks) {
            const block: Block = {
              id: blk.id,
              messageId: blk.messageId,
              type: blk.type as BlockType,
              status: blk.status as BlockStatus,
              content: blk.content,
              toolName: blk.toolName,
              toolInput: blk.toolInput as Record<string, unknown> | undefined,
              toolOutput: blk.toolOutput,
              citations: blk.citations,
              error: blk.error,
              startedAt: blk.startedAt,
              endedAt: blk.endedAt,
              // 🔧 P3修复：恢复 firstChunkAt 用于排序（保持思维链交替顺序）
              firstChunkAt: blk.firstChunkAt,
            };
            blocksMap.set(blk.id, block);
          }
          const tBlockMapEnd = performance.now();
          sessionSwitchPerf.mark('set_data_end', {
            phase: 'build_blocks_map',
            ms: tBlockMapEnd - tBlockMapStart,
            blockCount: blocksMap.size,
          });

          // 3. 转换消息数据
          // 注意：所有块（包括检索块、工具调用块等）现在都统一存储在 blocks 表中，
          // 直接通过 msg.blockIds 引用，无需从 meta 中恢复
          const tMsgMapStart = performance.now();
          const messageMap = new Map<string, Message>();
          const messageOrder: string[] = [];

          for (const msg of sortedMessages) {
            const message: Message = {
              id: msg.id,
              role: msg.role,
              blockIds: msg.blockIds, // 直接使用后端返回的 blockIds
              timestamp: msg.timestamp,
              persistentStableId: msg.persistentStableId,
              attachments: msg.attachments,
              // 🔧 修复：后端 serde(rename = "_meta") 序列化，字段名是 _meta
              // 🆕 统一用户消息处理：确保 contextSnapshot 被正确恢复
              _meta: msg._meta
                ? {
                    modelId: msg._meta.modelId,
                    // 🔒 审计修复: 添加 modelDisplayName 恢复（原代码遗漏此字段，
                    // 导致恢复后消息显示模型 ID 而非用户友好名称）
                    modelDisplayName: msg._meta.modelDisplayName,
                    chatParams: msg._meta.chatParams,
                    usage: msg._meta.usage,
                    contextSnapshot: msg._meta.contextSnapshot,
                  }
                : undefined,
              // 🔧 变体字段恢复
              activeVariantId: msg.activeVariantId,
              variants: msg.variants,
              sharedContext: msg.sharedContext,
            };
            messageMap.set(msg.id, message);
            messageOrder.push(msg.id);
          }
          const tMsgMapEnd = performance.now();
          sessionSwitchPerf.mark('set_data_end', {
            phase: 'build_messages_map',
            ms: tMsgMapEnd - tMsgMapStart,
            messageCount: messageOrder.length,
          });

          // 4. 转换状态数据
          // P1 修复：使用字段级合并而非整体替换，防止后端返回的部分字段为 null 时丢失默认值
          const chatParams = {
            ...createDefaultChatParams(),
            ...(state?.chatParams ?? {}),
          };
          const features = new Map(Object.entries(state?.features ?? {}));
          const panelStates = state?.panelStates ?? createDefaultPanelStates();
          const modeState = state?.modeState ?? null;
          const inputValue = state?.inputValue ?? '';

          // 🆕 Prompt 7: 恢复待发送的上下文引用
          //
          // 🛡️ 鲁棒性改造：多级降级解析，防止 JSON 异常导致引用丢失
          //
          // 策略：
          // 1. 标准 JSON.parse
          // 2. 逐个元素解析（处理数组部分损坏）
          // 3. 字符串扫描提取 ContextRef 对象（安全的非正则方法，防止 ReDoS）
          // 4. 详细日志记录 + 用户通知
          let pendingContextRefs: import('../../context/types').ContextRef[] = [];
          let parseResult: 'success' | 'partial' | 'failed' = 'success';

          if (state?.pendingContextRefsJson) {
            // 📊 解析统计
            const stats = {
              originalLength: state.pendingContextRefsJson.length,
              parsedCount: 0,
              failedCount: 0,
              method: '' as 'standard' | 'incremental' | 'string-scan' | 'none',
            };

            try {
              // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
              // 第一级：标准 JSON.parse
              // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
              const parsed = JSON.parse(state.pendingContextRefsJson);

              // 验证是否为数组
              if (!Array.isArray(parsed)) {
                throw new Error('Parsed result is not an array');
              }

              // 验证并过滤有效的 ContextRef
              const validated = parsed.filter((item: unknown): item is import('../../context/types').ContextRef => {
                return isValidContextRef(item);
              });

              // ★ P0-03 补齐旧数据迁移：历史数据可能没有 isSticky 字段
              // - skill_instruction 必须视为持久引用（持续生效直到取消）
              pendingContextRefs = validated.map((ref) => {
                if (ref.typeId === SKILL_INSTRUCTION_TYPE_ID) {
                  return { ...ref, isSticky: true };
                }
                return ref;
              });
              stats.parsedCount = validated.length;
              stats.failedCount = parsed.length - validated.length;
              stats.method = 'standard';

              console.log('[ChatStore] ✅ Restored pendingContextRefs (standard):', {
                total: validated.length,
                failed: stats.failedCount,
              });

            } catch (standardError) {
              console.warn('[ChatStore] ⚠️ Standard JSON.parse failed, trying incremental parse...', standardError);

              try {
                // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                // 第二级：逐个元素解析（处理数组部分损坏）
                // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                const jsonStr = state.pendingContextRefsJson.trim();

                // 检查是否是数组格式
                if (!jsonStr.startsWith('[') || !jsonStr.endsWith(']')) {
                  throw new Error('Not an array format');
                }

                // 提取数组内容（去除首尾方括号）
                const arrayContent = jsonStr.slice(1, -1).trim();

                if (arrayContent) {
                  // 尝试提取每个对象
                  // 使用更健壮的方法：查找所有顶层的 {...} 对象
                  const objectMatches: string[] = [];
                  let depth = 0;
                  let startIdx = -1;

                  for (let i = 0; i < arrayContent.length; i++) {
                    const char = arrayContent[i];

                    if (char === '{') {
                      if (depth === 0) {
                        startIdx = i;
                      }
                      depth++;
                    } else if (char === '}') {
                      depth--;
                      if (depth === 0 && startIdx !== -1) {
                        objectMatches.push(arrayContent.substring(startIdx, i + 1));
                        startIdx = -1;
                      }
                    }
                  }

                  if (objectMatches && objectMatches.length > 0) {
                    const incrementalRefs: import('../../context/types').ContextRef[] = [];

                    for (const objStr of objectMatches) {
                      try {
                        const obj = JSON.parse(objStr);
                        if (isValidContextRef(obj)) {
                          incrementalRefs.push(obj);
                          stats.parsedCount++;
                        } else {
                          stats.failedCount++;
                          console.warn('[ChatStore] Invalid ContextRef object:', obj);
                        }
                      } catch (itemError) {
                        stats.failedCount++;
                        console.warn('[ChatStore] Failed to parse individual item:', objStr, itemError);
                      }
                    }

                    if (incrementalRefs.length > 0) {
                      // ★ P0-03 补齐旧数据迁移：历史数据可能没有 isSticky 字段
                      pendingContextRefs = incrementalRefs.map((ref) => {
                        if (ref.typeId === SKILL_INSTRUCTION_TYPE_ID) {
                          return { ...ref, isSticky: true };
                        }
                        return ref;
                      });
                      stats.method = 'incremental';
                      parseResult = stats.failedCount > 0 ? 'partial' : 'success';

                      console.log('[ChatStore] ✅ Restored pendingContextRefs (incremental):', {
                        total: incrementalRefs.length,
                        failed: stats.failedCount,
                      });
                    } else {
                      throw new Error('No valid objects found in incremental parse');
                    }
                  } else {
                    throw new Error('No object patterns found');
                  }
                } else {
                  // 空数组
                  pendingContextRefs = [];
                  stats.method = 'incremental';
                  console.log('[ChatStore] Empty array detected');
                }

              } catch (incrementalError) {
                console.warn('[ChatStore] ⚠️ Incremental parse failed, trying string scanning extraction...', incrementalError);

                try {
                  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                  // 第三级：字符串扫描提取 ContextRef（安全的非正则方法）
                  //
                  // 安全设计说明：
                  // 1. 完全避免复杂正则表达式，防止 ReDoS 攻击
                  // 2. 使用简单的字符扫描，时间复杂度 O(n)
                  // 3. 添加超时保护机制，防止长时间运行
                  // 4. 对每个候选对象进行安全的 JSON 解析
                  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

                  // 性能监控：记录开始时间
                  const scanStartTime = performance.now();
                  const SCAN_TIMEOUT_MS = 5000; // 5秒超时保护

                  /**
                   * 从字符串中提取可能的 ContextRef 对象
                   * 使用简单的字符扫描，避免正则表达式回溯问题
                   */
                  const extractPossibleContextRefs = (jsonString: string): import('../../context/types').ContextRef[] => {
                    const refs: import('../../context/types').ContextRef[] = [];
                    let i = 0;
                    let objectsScanned = 0;
                    const maxObjectsToScan = 10000; // 最多扫描10000个对象，防止无限循环

                    while (i < jsonString.length) {
                      // 超时检查
                      if (performance.now() - scanStartTime > SCAN_TIMEOUT_MS) {
                        console.warn('[ChatStore] ⚠️ String scanning timeout, returning partial results');
                        break;
                      }

                      // 对象数量限制检查
                      if (objectsScanned >= maxObjectsToScan) {
                        console.warn('[ChatStore] ⚠️ Max objects scanned limit reached, returning partial results');
                        break;
                      }

                      // 查找对象开始位置
                      const start = jsonString.indexOf('{', i);
                      if (start === -1) break;

                      // 查找匹配的结束大括号（使用深度计数）
                      let depth = 0;
                      let end = start;
                      let foundEnd = false;

                      // 扫描最多1000个字符，防止单个对象过大
                      const maxScanLength = 1000;
                      const scanLimit = Math.min(start + maxScanLength, jsonString.length);

                      for (let j = start; j < scanLimit; j++) {
                        const char = jsonString[j];

                        if (char === '{') {
                          depth++;
                        } else if (char === '}') {
                          depth--;
                          if (depth === 0) {
                            end = j + 1;
                            foundEnd = true;
                            break;
                          }
                        }
                      }

                      if (foundEnd) {
                        const candidate = jsonString.substring(start, end);
                        objectsScanned++;

                        // 快速预检：必须包含所有必需字段
                        if (
                          candidate.includes('"resourceId"') &&
                          candidate.includes('"hash"') &&
                          candidate.includes('"typeId"')
                        ) {
                          // 尝试安全解析
                          try {
                            const obj = JSON.parse(candidate);

                            // 验证是否为有效的 ContextRef
                            if (isValidContextRef(obj)) {
                              refs.push(obj);
                              stats.parsedCount++;
                            } else {
                              stats.failedCount++;
                            }
                          } catch (parseError) {
                            // JSON 解析失败，继续扫描
                            stats.failedCount++;
                          }
                        }

                        // 移动到下一个位置
                        i = end;
                      } else {
                        // 没有找到匹配的结束大括号，跳过这个开始位置
                        i = start + 1;
                      }
                    }

                    return refs;
                  };

                  // 执行字符串扫描提取
                  const scanRefs = extractPossibleContextRefs(state.pendingContextRefsJson);
                  const scanDuration = performance.now() - scanStartTime;

                  if (scanRefs.length > 0) {
                    // ★ P0-03 补齐旧数据迁移：历史数据可能没有 isSticky 字段
                    pendingContextRefs = scanRefs.map((ref) => {
                      if (ref.typeId === SKILL_INSTRUCTION_TYPE_ID) {
                        return { ...ref, isSticky: true };
                      }
                      return ref;
                    });
                    stats.method = 'string-scan';
                    parseResult = 'partial'; // 字符串扫描一定是部分恢复

                    console.log('[ChatStore] ✅ Restored pendingContextRefs (string-scan):', {
                      total: scanRefs.length,
                      failed: stats.failedCount,
                      durationMs: scanDuration.toFixed(2),
                      performance: scanDuration < 100 ? '🚀 excellent' : scanDuration < 500 ? '✅ good' : '⚠️ slow',
                    });
                  } else {
                    throw new Error('No valid refs extracted by string scanning');
                  }

                } catch (scanError) {
                  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                  // 所有方法都失败
                  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                  stats.method = 'none';
                  parseResult = 'failed';

                  console.error('[ChatStore] ❌ All parse methods failed:', {
                    standardError,
                    incrementalError,
                    scanError,
                    originalJson: state.pendingContextRefsJson.substring(0, 500) + '...', // 只记录前500字符
                  });
                }
              }
            }

            // 📊 最终统计日志
            console.log('[ChatStore] Pending context refs parse summary:', {
              parseResult,
              stats,
              finalCount: pendingContextRefs.length,
            });

            // 🔔 用户通知（部分恢复或失败时）
            if (parseResult === 'partial') {
              // 延迟通知，避免阻塞初始化
              setTimeout(() => {
                const message = stats.parsedCount > 0
                  ? i18n.t('chatV2:chat.context_restored', { parsedCount: stats.parsedCount, failedCount: stats.failedCount })
                  : i18n.t('chatV2:chat.context_partially_corrupted');

                console.warn('[ChatStore] 🔔 User notification:', message);
                showGlobalNotification('warning', message);
              }, 1000);
            } else if (parseResult === 'failed') {
              setTimeout(() => {
                const message = i18n.t('chatV2:chat.context_corrupted');
                console.error('[ChatStore] 🔔 User notification:', message);
                showGlobalNotification('error', message);
              }, 1000);
            }
          }

          // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          // 辅助函数：验证 ContextRef 有效性
          // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          function isValidContextRef(obj: unknown): obj is import('../../context/types').ContextRef {
            if (!obj || typeof obj !== 'object') {
              return false;
            }

            const ref = obj as Record<string, unknown>;

            // 检查必需字段
            if (typeof ref.resourceId !== 'string' || !ref.resourceId.trim()) {
              return false;
            }
            if (typeof ref.hash !== 'string' || !ref.hash.trim()) {
              return false;
            }
            if (typeof ref.typeId !== 'string' || !ref.typeId.trim()) {
              return false;
            }

            // 额外验证：resourceId 格式（res_{nanoid(10)}）
            if (!/^res_[a-zA-Z0-9_-]{10}$/.test(ref.resourceId)) {
              console.warn('[ChatStore] Invalid resourceId format:', ref.resourceId);
              return false;
            }

            // 额外验证：hash 格式（SHA-256 hex）
            if (!/^[a-f0-9]{64}$/.test(ref.hash)) {
              console.warn('[ChatStore] Invalid hash format:', ref.hash);
              return false;
            }

            return true;
          }

          // 5. 设置状态（重置运行时状态）
          // 🚀 性能优化 V2：使用 queueMicrotask 延迟 Promise 回调
          //
          // 问题分析：set() 触发 React 在微任务中同步渲染，阻塞后续微任务 ~300ms
          //
          // 解决方案：
          // 1. 一次性 set() 所有状态（避免 UI 闪烁）
          // 2. 在 set() 前用 queueMicrotask 预先安排一个"让步"点
          //    让 loadSession Promise 可以更快 resolve

          // 🔧 安全解析 activeSkillIdsJson（统一为一次解析，防止 JSON 异常中断恢复）
          let restoredActiveSkillIds: string[] = [];
          if (state?.activeSkillIdsJson) {
            try {
              const parsed = JSON.parse(state.activeSkillIdsJson);
              if (Array.isArray(parsed)) {
                restoredActiveSkillIds = parsed.filter((id): id is string => typeof id === 'string');
              }
            } catch (e) {
              console.warn('[ChatStore] Failed to parse activeSkillIdsJson, falling back to empty:', e);
            }
          }
          // 🔧 新会话（无持久化 activeSkillIdsJson）回退到默认技能
          // 避免 loadSession 竞态覆写 activateSkill 已设置的 activeSkillIds
          if (restoredActiveSkillIds.length === 0 && !state?.activeSkillIdsJson) {
            restoredActiveSkillIds = skillDefaults.getAll();
          }

          // 📊 细粒度打点：set 开始
          sessionSwitchPerf.mark('set_start', {
            messageCount: messageOrder.length,
            blockCount: blocksMap.size,
          });

          // 一次性更新所有状态
          set({
            sessionId: session.id,
            mode: session.mode,
            title: session.title ?? '',
            description: '', // 文档 28 改造：description 由后端事件更新，恢复时初始化为空
            groupId: session.groupId ?? null,
            sessionMetadata: session.metadata ?? null,
            sessionStatus: 'idle',
            isDataLoaded: true,
            messageMap,
            messageOrder,
            blocks: blocksMap,
            currentStreamingMessageId: null,
            activeBlockIds: new Set(),
            streamingVariantIds: new Set(),
            chatParams,
            features,
            modeState,
            inputValue,
            attachments: [],
            panelStates,
            pendingContextRefs,
            // 从安全解析的结果恢复（支持多选）
            activeSkillIds: restoredActiveSkillIds,
          });

          // 📊 细粒度打点：set 结束
          sessionSwitchPerf.mark('set_end');
          
          // 📊 细粒度打点：微任务检查点
          Promise.resolve().then(() => {
            sessionSwitchPerf.mark('microtask_check');
          });
          sessionSwitchPerf.mark('set_data_end', {
            phase: 'restore_total',
            ms: performance.now() - t0,
          });
          
          console.log('[ChatStore] Session restored from backend:', session.id, 'isDataLoaded: true');

          // 🔧 统一的异步恢复路径：资源验证 + 技能 ContextRef 重建
          // 合并原有的三条竞态路径为单一 queueMicrotask
          queueMicrotask(async () => {
            try {
              // === Step 0: 注入分组关联来源（pinned resources） ===
              const currentGroupId = getState().groupId;
              if (currentGroupId) {
                try {
                  const { invoke } = await import('@tauri-apps/api/core');
                  const group = await invoke<{ pinnedResourceIds?: string[] } | null>('chat_v2_get_group', { groupId: currentGroupId });
                  const pinnedIds = group?.pinnedResourceIds ?? [];
                  if (pinnedIds.length > 0) {
                    const { getResourceRefsV2 } = await import('../../context/vfsRefApi');
                    const { resourceStoreApi } = await import('../../resources');
                    const refsResult = await getResourceRefsV2(pinnedIds);
                    if (refsResult.ok && refsResult.value.refs.length > 0) {
                      const currentRefs = getState().pendingContextRefs;
                      const newRefs = [...currentRefs];
                      // Build a set of existing resourceIds for fast dedup
                      const existingResourceIds = new Set(currentRefs.map((r) => r.resourceId));
                      for (const vfsRef of refsResult.value.refs) {
                        try {
                          const resourceResult = await resourceStoreApi.createOrReuse({
                            type: vfsRef.type as import('../../context/types').ResourceType,
                            data: JSON.stringify({ refs: [vfsRef], totalCount: 1, truncated: false }),
                            sourceId: vfsRef.sourceId,
                            metadata: { name: vfsRef.name, title: vfsRef.name },
                          });
                          // Skip if same resourceId already in refs (exact content match via hash)
                          if (existingResourceIds.has(resourceResult.resourceId)) continue;
                          existingResourceIds.add(resourceResult.resourceId);

                          const contextRef: import('../../context/types').ContextRef = {
                            resourceId: resourceResult.resourceId,
                            hash: resourceResult.hash,
                            typeId: vfsRef.type,
                            isSticky: true,
                            displayName: vfsRef.name,
                          };
                          newRefs.push(contextRef);
                        } catch (refErr) {
                          console.warn('[ChatStore] Failed to create pinned resource ref:', vfsRef.sourceId, refErr);
                        }
                      }
                      if (newRefs.length > currentRefs.length) {
                        set({ pendingContextRefs: newRefs });
                        console.log('[ChatStore] Injected group pinned resources:', newRefs.length - currentRefs.length);
                      }
                    }
                  }
                } catch (groupErr) {
                  console.warn('[ChatStore] Failed to inject group pinned resources:', groupErr);
                }
              }

              // === Step 1: 恢复手动激活 Skills 的 ContextRefs ===
              if (restoredActiveSkillIds.length > 0) {
                try {
                  const { skillRegistry } = await import('../../skills/registry');
                  const { createResourceFromSkill } = await import('../../skills/resourceHelper');

                  for (const skillId of restoredActiveSkillIds) {
                    const skill = skillRegistry.get(skillId);
                    if (!skill) {
                      console.warn('[ChatStore] Active skill not found during restore:', skillId);
                      continue;
                    }

                    const contextRef = await createResourceFromSkill(skill);
                    if (!contextRef) {
                      console.warn('[ChatStore] Failed to create contextRef for active skill:', skillId);
                      continue;
                    }

                    // 避免重复添加同一 skill_instruction ref
                    const currentRefs = getState().pendingContextRefs;
                    const hasSkillRef = currentRefs.some(
                      (ref) => ref.typeId === SKILL_INSTRUCTION_TYPE_ID && ref.resourceId === contextRef.resourceId
                    );

                    if (!hasSkillRef) {
                      set({ pendingContextRefs: [...currentRefs, { ...contextRef, autoLoaded: true }] });
                    }
                  }
                  console.log('[ChatStore] Restored active skill contextRefs:', restoredActiveSkillIds);
                } catch (error) {
                  console.warn('[ChatStore] Failed to restore active skill contextRefs:', error);
                }
              }

              // === Step 2: 兼容恢复 — 如果 activeSkillIdsJson 为空但存在 skill refs，从 refs 推断 ===
              if (restoredActiveSkillIds.length === 0 && pendingContextRefs.length > 0) {
                const orphanSkillRefs = pendingContextRefs.filter(
                  (ref) => ref.typeId === SKILL_INSTRUCTION_TYPE_ID && ref.isSticky
                );
                if (orphanSkillRefs.length > 0) {
                  const { resourceStoreApi } = await import('../../resources');
                  const inferredIds: string[] = [];
                  for (const skillRef of orphanSkillRefs) {
                    // 优先使用 ref.skillId（如果存在）
                    if (skillRef.skillId) {
                      if (!inferredIds.includes(skillRef.skillId)) {
                        inferredIds.push(skillRef.skillId);
                      }
                      continue;
                    }
                    // 否则从资源元数据推断
                    try {
                      const resource = await resourceStoreApi.get(skillRef.resourceId);
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const skillId = (resource?.metadata as any)?.skillId as string | undefined;
                      if (skillId && !inferredIds.includes(skillId)) {
                        inferredIds.push(skillId);
                      }
                    } catch (e) {
                      console.warn('[ChatStore] Failed to infer skill from ref:', e);
                    }
                  }
                  if (inferredIds.length > 0) {
                    set({ activeSkillIds: inferredIds } as Partial<ChatStoreState>);
                    console.log('[ChatStore] Inferred activeSkillIds from orphan refs:', inferredIds);
                  }
                }
              }

              // === Step 3: 验证资源有效性 ===
              // 🔧 使用 getState() 获取最新的 refs（包含 Step 1 新增的 skill refs）
              const currentRefsForValidation = getState().pendingContextRefs;
              if (currentRefsForValidation.length > 0) {
                const { resourceStoreApi } = await import('../../resources');
                const validRefs: import('../../context/types').ContextRef[] = [];
                const invalidRefs: string[] = [];

                for (const ref of currentRefsForValidation) {
                  try {
                    const exists = await resourceStoreApi.exists(ref.resourceId);
                    if (exists) {
                      validRefs.push(ref);
                    } else {
                      invalidRefs.push(ref.resourceId);
                    }
                  } catch {
                    // 验证失败时保留引用（宁可多保留，避免丢失用户数据）
                    validRefs.push(ref);
                  }
                }

                if (invalidRefs.length > 0) {
                  console.warn('[ChatStore] Removing invalid refs:', invalidRefs.length);
                  set({ pendingContextRefs: validRefs });
                  showGlobalNotification('warning', i18n.t('chatV2:chat.context_invalid_removed', { count: invalidRefs.length }));
                }
              }

              // 🔧 修复：会话恢复完成后修复 skill 状态一致性
              // repairSkillState 从 hasActiveSkill getter 中提取，避免 getter 副作用
              getState().repairSkillState();
            } catch (e) {
              console.error('[ChatStore] Failed during unified session restore:', e);
            }
          });

          // 🔧 Canvas 笔记引用恢复：始终发射事件以确保会话切换时状态正确同步
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const canvasNoteId = (modeState as any)?.canvasNoteId as string | undefined;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const canvasNoteHistory = (modeState as any)?.canvasNoteHistory as string[] | undefined;
          
          // 始终发射事件，即使没有 Canvas 状态（用于清理上一个会话的状态）
          console.log('[ChatStore] Syncing canvas note reference:', { canvasNoteId, canvasNoteHistory });
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('canvas:restore-note', { 
              detail: { 
                noteId: canvasNoteId || null,
                noteHistory: canvasNoteHistory || [],
              } 
            }));
          }, 0);

          // 🆕 渐进披露：恢复已加载的 Skills
          // 🔧 增加 registry 就绪等待，避免 skills 尚未加载完成导致 notFound
          if (state?.loadedSkillIdsJson) {
            queueMicrotask(async () => {
              try {
                const skillIds: string[] = JSON.parse(state.loadedSkillIdsJson);
                if (skillIds.length > 0) {
                  // 等待 skillRegistry 初始化完成（带超时保护）
                  const { skillRegistry } = await import('../../skills/registry');
                  if (!skillRegistry.isInitialized()) {
                    const ready = await skillRegistry.waitForInitialized(5000);
                    if (!ready) {
                      console.warn('[ChatStore] Skill registry not ready after 5s, restoring loaded skills anyway');
                    }
                  }

                  const { loadSkillsToSession } = await import('../../skills/progressiveDisclosure');
                  const attemptRestoreLoadedSkills = () => loadSkillsToSession(session.id, skillIds);
                  const loadResult = attemptRestoreLoadedSkills();
                  console.log('[ChatStore] Restored loaded skills:', {
                    sessionId: session.id,
                    requestedSkills: skillIds,
                    loadedCount: loadResult.loaded.length,
                    notFoundCount: loadResult.notFound.length,
                  });

                  // 🔧 如果部分技能未找到，可能是 skills 仍在加载中：订阅 registry 更新并重试（有限次数）
                  if (loadResult.notFound.length > 0) {
                    const { subscribeToSkillRegistry } = await import('../../skills/registry');
                    let retries = 0;
                    const maxRetries = 3;
                    const unsubscribe = subscribeToSkillRegistry(() => {
                      retries++;
                      const retryResult = attemptRestoreLoadedSkills();
                      console.log('[ChatStore] Retry restoring loaded skills:', {
                        sessionId: session.id,
                        retry: retries,
                        loadedCount: retryResult.loaded.length,
                        notFoundCount: retryResult.notFound.length,
                      });

                      if (retryResult.notFound.length === 0 || retries >= maxRetries) {
                        unsubscribe();
                      }
                    });

                    // 超时兜底：避免极端情况下不触发更新导致订阅常驻
                    setTimeout(() => {
                      try {
                        unsubscribe();
                      } catch {
                        // ignore
                      }
                    }, 5000);
                  }
                }
              } catch (e) {
                console.warn('[ChatStore] Failed to restore loaded skills:', e);
              }
            });
          }
        },

  };
}
