/**
 * Chat V2 - 上下文发送辅助函数
 *
 * 遵循文档 16 第八章 8.2 发送消息流程：
 * 1. 从资源库获取内容
 * 2. 调用 formatToBlocks 格式化
 * 3. 按 priority 排序
 * 4. 构建 SendContextRef[]
 *
 * 约束：
 * 1. 按优先级排序 pendingContextRefs
 * 2. 资源不存在时跳过（不阻塞发送）
 * 3. 格式化失败时使用默认文本块
 */

import { invoke } from '@tauri-apps/api/core';
import i18n from 'i18next';
import { getErrorMessage } from '../../utils/errorUtils';
import { debugLog } from '../../debug-panel/debugMasterSwitch';
import { pMap } from '../../utils/concurrency';
import { contextTypeRegistry } from '../context/registry';
import { showGlobalNotification } from '../../components/UnifiedNotification';
import { isErr } from '../../shared/result';
import type { ContextRef, SendContextRef, ContentBlock, Resource } from '../resources/types';
import {
  VFS_REF_TYPES,
  isVfsRefType,
  type VfsContextRefData,
  type VfsResourceRef,
  type ResolvedResource,
  type VfsResourceType as FullVfsResourceType,
  // ★ 2025-12-10: MultimodalContentBlock 现在由后端统一填充，前端不再需要此类型
} from '../context/vfsRefTypes';
import type { FormatOptions } from '../context/types';
import { resourceStoreApi } from '../resources';
import { logAttachment } from '../debug/chatV2Logger';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

// ============================================================================
// 日志前缀
// ============================================================================

const LOG_PREFIX = '[ChatV2:ContextHelper]';

// ============================================================================
// 性能优化常量
// ============================================================================

/**
 * 资源加载并发数限制
 *
 * 控制同时加载的资源数量，平衡性能和资源占用：
 * - 太小：无法充分利用并发优势
 * - 太大：可能导致内存压力和后端负载过高
 *
 * 推荐值：5（经过权衡的默认值）
 */
const RESOURCE_LOAD_CONCURRENCY = 5;

/**
 * 最大退避延迟时间（毫秒）
 *
 * 限制指数退避的最大延迟时间，防止整数溢出和过长等待：
 * - 防止 Math.pow(2, attempt) * 100 在 attempt 较大时溢出
 * - 避免单次重试等待时间过长影响用户体验
 *
 * ✅ HIGH-A008 修复：添加退避延迟上限
 */
const MAX_BACKOFF_DELAY = 5000; // 5秒

/**
 * 默认回退上下文 Token 限制
 *
 * 仅当模型能力完全未知且用户未设置 contextLimit 时使用。
 * 正常流程中，contextLimit 由 resolveInputContextLimit 根据模型实际上下文窗口动态计算。
 */
export const DEFAULT_FALLBACK_CONTEXT_TOKENS = 131072;

/**
 * 安全上下文 Token 限制（90% 边界）
 *
 * 仅作为 truncateContextByTokens 的默认参数兜底。
 * 正常流程中，调用方总是显式传入基于模型动态计算的限制值。
 */
export const SAFE_MAX_CONTEXT_TOKENS = Math.floor(DEFAULT_FALLBACK_CONTEXT_TOKENS * 0.9);

/**
 * Token 估算比率（字符数/Token数）- 已废弃
 *
 * ⚠️ 此常量已废弃，请使用 estimateTokensForText() 动态估算
 * @deprecated 使用 estimateTokensForText() 代替
 */
const CHARS_PER_TOKEN = 3;

// ============================================================================
// VFS 引用模式常量（从 vfsRefTypes.ts 统一导入）
// ============================================================================

// VFS_REF_TYPES 和 isVfsRefType 从 vfsRefTypes.ts 统一导入
// 保证整个项目使用单一数据源（SSOT）

// ============================================================================
// SendContextRef 构建
// ============================================================================

/**
 * 构建 SendContextRef 结果
 *
 * ★ 文档28改造：新增 pathMap 字段用于存储资源的真实路径
 */
export interface BuildSendContextRefsResult {
  /** 格式化后的 SendContextRef 数组 */
  sendRefs: SendContextRef[];
  /** ★ 文档28改造：资源 ID -> 真实路径 的映射 */
  pathMap: Record<string, string>;
}

/**
 * 构建 SendContextRef 数组
 *
 * 遵循文档 16 发送流程：
 * 1. 按 priority 排序 pendingContextRefs
 * 2. 从资源库获取内容
 * 3. 调用 formatToBlocks 格式化
 *
 * ★ 文档25扩展：支持 options 参数传递模型能力（isMultimodal）
 * ★ 文档28改造：返回 pathMap 用于存储真实路径
 * ★ 性能优化：并行加载资源，限制并发数为 5
 *
 * @param contextRefs 待处理的上下文引用数组
 * @param options 格式化选项（可选，包含 isMultimodal 等）
 * @returns 格式化后的 SendContextRef 数组（已排序）
 */
export async function buildSendContextRefs(
  contextRefs: ContextRef[],
  options?: FormatOptions
): Promise<SendContextRef[]> {
  if (!contextRefs || contextRefs.length === 0) {
    return [];
  }

  const startTime = performance.now();

  logAttachment('adapter', 'build_send_context_refs_start', {
    count: contextRefs.length,
    typeIds: contextRefs.map(r => r.typeId),
  });

  // 1. 按 priority 排序
  const sortedRefs = [...contextRefs].sort((a, b) => {
    const priorityA = contextTypeRegistry.getPriority(a.typeId);
    const priorityB = contextTypeRegistry.getPriority(b.typeId);
    return priorityA - priorityB;
  });

  // 2. 并行加载资源（带并发限制和重试机制）
  const results = await pMap(
    sortedRefs,
    async (ref) => {
      // ★ P1-004 修复：添加重试逻辑（最多2次重试）
      // ★ MEDIUM-002 修复：添加总时间限制
      // ✅ HIGH-A007 修复：使用 AbortController 取消超时的异步操作
      const maxRetries = 2;
      const MAX_TOTAL_RETRY_TIME = 5000; // 5秒总时间限制
      let lastError: Error | null = null;
      const startTime = Date.now();
      const abortController = new AbortController();

      try {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          // 检查总时间限制
          if (Date.now() - startTime > MAX_TOTAL_RETRY_TIME) {
            console.warn(LOG_PREFIX, `Retry timeout, exceeded ${MAX_TOTAL_RETRY_TIME}ms, resource:`, ref.resourceId);
            // ✅ HIGH-A007 修复：取消正在进行的异步操作
            abortController.abort();
            break;
          }

          // 检查是否已被取消
          if (abortController.signal.aborted) {
            break;
          }

          try {
            // 2.1 从资源库获取内容
            const resource = await resourceStoreApi.get(ref.resourceId);

            if (!resource) {
              console.warn(
                LOG_PREFIX,
                `Resource not found (attempt ${attempt + 1}/${maxRetries + 1}):`,
                ref.resourceId
              );
              return null;
            }

            // 2.2 VFS 引用预解析（文档 24 Prompt 8）
            // ★ 文档25扩展：传递 isMultimodal 到 resolveVfsRefs 以获取多模态内容
            // ★ 注入模式扩展：传递 injectModes 到 resolveVfsRefs
            const resolvedResource = await resolveVfsRefs(resource, ref.typeId, options, ref.injectModes);

            // 2.3 调用 formatToBlocks 格式化（使用解析后的资源）
            // ★ 文档25扩展：传递 options 到 formatResource
            // ★ 注入模式扩展：将 injectModes 合并到 options
            const formatOptions = ref.injectModes 
              ? { ...options, injectModes: ref.injectModes }
              : options;
            const formattedBlocks = contextTypeRegistry.formatResource(ref.typeId, resolvedResource, formatOptions);

            // ★ 调试日志：详细记录实际注入的内容
            const textBlocks = formattedBlocks.filter(b => b.type === 'text');
            const imageBlocks = formattedBlocks.filter(b => b.type === 'image');
            const totalTextLength = textBlocks.reduce((sum, b) => sum + ((b as { type: 'text'; text: string }).text?.length || 0), 0);
            
            logAttachment('adapter', 'format_resource_done', {
              resourceId: ref.resourceId,
              typeId: ref.typeId,
              blocksCount: formattedBlocks.length,
              hasResolvedResources: !!resolvedResource._resolvedResources?.length,
              resolvedFound: resolvedResource._resolvedResources?.[0]?.found,
              resolvedContentLen: resolvedResource._resolvedResources?.[0]?.content?.length,
              retryAttempt: attempt,
              // ★ 新增：注入模式和内容详情
              injectModes: ref.injectModes,
              injectedContent: {
                textBlocks: textBlocks.length,
                imageBlocks: imageBlocks.length,
                totalTextLength,
                hasMultimodal: imageBlocks.length > 0,
              },
            }, 'success');
            
            console.log('[InjectContent] Actual injected content:', {
              resourceId: ref.resourceId,
              injectModes: ref.injectModes,
              textBlocks: textBlocks.length,
              imageBlocks: imageBlocks.length,
              totalTextLength,
              textPreview: textBlocks.length > 0 ? (textBlocks[0] as { type: 'text'; text: string }).text?.slice(0, 200) : undefined,
            });

          // 2.4 返回 SendContextRef
            // ★ 2026-02 修复：包含 injectModes，确保重试时能恢复用户选择
            const sendRef: SendContextRef = {
              resourceId: ref.resourceId,
              hash: ref.hash,
              typeId: ref.typeId,
              formattedBlocks,
              displayName: ref.displayName,
              injectModes: ref.injectModes,
            };
            return sendRef;
          } catch (error: unknown) {
            lastError = error as Error;

            if (attempt < maxRetries) {
              console.warn(
                LOG_PREFIX,
                `Error processing context ref (attempt ${attempt + 1}/${maxRetries + 1}), retrying:`,
                ref.resourceId,
                getErrorMessage(error)
              );
              // ✅ HIGH-A008 修复：使用 Math.min 限制最大退避时间，防止溢出
              const backoffDelay = Math.min(Math.pow(2, attempt) * 100, MAX_BACKOFF_DELAY);
              const remainingTime = MAX_TOTAL_RETRY_TIME - (Date.now() - startTime);
              const actualDelay = Math.min(backoffDelay, Math.max(0, remainingTime));

              if (actualDelay > 0 && !abortController.signal.aborted) {
                await new Promise(resolve => setTimeout(resolve, actualDelay));
              }
            } else {
              // 最后一次尝试失败，记录详细错误
              console.error(
                LOG_PREFIX,
                `Error processing context ref after ${maxRetries + 1} attempts:`,
                ref.resourceId,
                'typeId:',
                ref.typeId,
                'error:',
                getErrorMessage(error)
              );
              logAttachment('adapter', 'format_resource_failed', {
                resourceId: ref.resourceId,
                typeId: ref.typeId,
                error: getErrorMessage(error),
                attempts: maxRetries + 1,
              }, 'error');
            }
          }
        }

        // 所有重试都失败，返回 null
        return null;
      } finally {
        // ✅ HIGH-A007 修复：在 finally 块中清理 AbortController，确保资源释放
        abortController.abort();
      }
    },
    RESOURCE_LOAD_CONCURRENCY
  );

  // 3. 过滤掉失败的资源
  const sendRefs = results.filter((ref): ref is SendContextRef => ref !== null);
  const failedCount = contextRefs.length - sendRefs.length;

  const duration = performance.now() - startTime;

  logAttachment('adapter', 'build_send_context_refs_done', {
    count: sendRefs.length,
    total: contextRefs.length,
    failed: failedCount,
    duration: Math.round(duration),
    avgPerResource: Math.round(duration / contextRefs.length),
  }, 'success');

  // 🔧 修复：如果有资源解析失败，通知用户
  if (failedCount > 0) {
    showGlobalNotification('warning', i18n.t('chatV2:context.resolve_failed_skipped', { count: failedCount }));
  }

  // 开发模式下输出性能日志
  if (process.env.NODE_ENV === 'development' && contextRefs.length > 0) {
    console.log(
      `${LOG_PREFIX} [性能] 资源加载完成:`,
      `总数=${contextRefs.length}`,
      `成功=${sendRefs.length}`,
      `耗时=${duration.toFixed(0)}ms`,
      `平均=${(duration / contextRefs.length).toFixed(0)}ms/个`
    );
  }

  return sendRefs;
}

/**
 * 构建 SendContextRef 数组（含路径映射）
 *
 * ★ 文档28改造：新增的函数，返回 pathMap 用于存储真实路径
 * ★ 性能优化：并行加载资源，限制并发数为 5
 *
 * @param contextRefs 待处理的上下文引用数组
 * @param options 格式化选项
 * @returns SendContextRef 数组和 pathMap
 */
export async function buildSendContextRefsWithPaths(
  contextRefs: ContextRef[],
  options?: FormatOptions
): Promise<BuildSendContextRefsResult> {
  if (!contextRefs || contextRefs.length === 0) {
    return { sendRefs: [], pathMap: {} };
  }

  const startTime = performance.now();

  logAttachment('adapter', 'build_send_context_refs_with_paths_start', {
    count: contextRefs.length,
    typeIds: contextRefs.map(r => r.typeId),
    isMultimodal: options?.isMultimodal,
  });

  // 1. 按 priority 排序
  const sortedRefs = [...contextRefs].sort((a, b) => {
    const priorityA = contextTypeRegistry.getPriority(a.typeId);
    const priorityB = contextTypeRegistry.getPriority(b.typeId);
    return priorityA - priorityB;
  });

  // 2. 并行加载资源（带并发限制和重试机制）
  const results = await pMap(
    sortedRefs,
    async (ref) => {
      // ★ P1-004 修复：添加重试逻辑（最多2次重试）
      // ★ MEDIUM-002 修复：添加总时间限制
      // ✅ HIGH-A007 修复：使用 AbortController 取消超时的异步操作
      const maxRetries = 2;
      const MAX_TOTAL_RETRY_TIME = 5000; // 5秒总时间限制
      let lastError: Error | null = null;
      const startTime = Date.now();
      const abortController = new AbortController();

      try {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          // 检查总时间限制
          if (Date.now() - startTime > MAX_TOTAL_RETRY_TIME) {
            console.warn(LOG_PREFIX, `Retry timeout, exceeded ${MAX_TOTAL_RETRY_TIME}ms, resource:`, ref.resourceId);
            // ✅ HIGH-A007 修复：取消正在进行的异步操作
            abortController.abort();
            break;
          }

          // 检查是否已被取消
          if (abortController.signal.aborted) {
            break;
          }

          try {
            // 2.1 从资源库获取内容
            const resource = await resourceStoreApi.get(ref.resourceId);

            if (!resource) {
              console.warn(
                LOG_PREFIX,
                `Resource not found (attempt ${attempt + 1}/${maxRetries + 1}):`,
                ref.resourceId
              );
              return null;
            }

            // 2.2 VFS 引用预解析
            // ★ 注入模式扩展：传递 injectModes 到 resolveVfsRefs
            const resolvedResource = await resolveVfsRefs(resource, ref.typeId, options, ref.injectModes);

            // 2.3 ★ 文档28改造：提取路径信息
            const resolved = resolvedResource._resolvedResources?.[0];
            const path = resolved?.found && resolved.path ? resolved.path : undefined;

          // 2.4 调用 formatToBlocks 格式化
          // ★ 注入模式扩展：将 injectModes 合并到 options
          const formatOptions = ref.injectModes 
            ? { ...options, injectModes: ref.injectModes }
            : options;
          
          const formattedBlocks = contextTypeRegistry.formatResource(ref.typeId, resolvedResource, formatOptions);

          logAttachment('adapter', 'format_resource_with_path_done', {
            resourceId: ref.resourceId,
            typeId: ref.typeId,
            blocksCount: formattedBlocks.length,
            hasPath: !!path,
            path,
            retryAttempt: attempt,
          }, 'success');

            // 2.5 返回结果
            // ★ 2026-02 修复：包含 injectModes，确保重试时能恢复用户选择
            return {
              sendRef: {
                resourceId: ref.resourceId,
                hash: ref.hash,
                typeId: ref.typeId,
                formattedBlocks,
                displayName: ref.displayName,
                injectModes: ref.injectModes,
              },
              path,
            };
          } catch (error: unknown) {
            lastError = error as Error;

            if (attempt < maxRetries) {
              console.warn(
                LOG_PREFIX,
                `Error processing context ref with path (attempt ${attempt + 1}/${maxRetries + 1}), retrying:`,
                ref.resourceId,
                getErrorMessage(error)
              );
              // ✅ HIGH-A008 修复：使用 Math.min 限制最大退避时间，防止溢出
              const backoffDelay = Math.min(Math.pow(2, attempt) * 100, MAX_BACKOFF_DELAY);
              const remainingTime = MAX_TOTAL_RETRY_TIME - (Date.now() - startTime);
              const actualDelay = Math.min(backoffDelay, Math.max(0, remainingTime));

              if (actualDelay > 0 && !abortController.signal.aborted) {
                await new Promise(resolve => setTimeout(resolve, actualDelay));
              }
            } else {
              // 最后一次尝试失败，记录详细错误
              console.error(
                LOG_PREFIX,
                `Error processing context ref with path after ${maxRetries + 1} attempts:`,
                ref.resourceId,
                'typeId:',
                ref.typeId,
                'error:',
                getErrorMessage(error)
              );
              logAttachment('adapter', 'format_resource_with_path_failed', {
                resourceId: ref.resourceId,
                typeId: ref.typeId,
                error: getErrorMessage(error),
                attempts: maxRetries + 1,
              }, 'error');
            }
          }
        }

        // 所有重试都失败，返回 null
        return null;
      } finally {
        // ✅ HIGH-A007 修复：在 finally 块中清理 AbortController，确保资源释放
        abortController.abort();
      }
    },
    RESOURCE_LOAD_CONCURRENCY
  );

  // 3. 构建 sendRefs 和 pathMap
  const sendRefs: SendContextRef[] = [];
  const pathMap: Record<string, string> = {};

  for (const result of results) {
    if (result) {
      sendRefs.push(result.sendRef);
      if (result.path) {
        pathMap[result.sendRef.resourceId] = result.path;
      }
    }
  }

  const failedCount = contextRefs.length - sendRefs.length;
  const duration = performance.now() - startTime;

  logAttachment('adapter', 'build_send_context_refs_with_paths_done', {
    sendRefsCount: sendRefs.length,
    pathMapCount: Object.keys(pathMap).length,
    total: contextRefs.length,
    failed: failedCount,
    duration: Math.round(duration),
    avgPerResource: Math.round(duration / contextRefs.length),
  }, 'success');

  // 🔧 修复：如果有资源解析失败，通知用户
  if (failedCount > 0) {
    showGlobalNotification('warning', i18n.t('chatV2:context.resolve_failed_skipped', { count: failedCount }));
  }

  // 开发模式下输出性能日志
  if (process.env.NODE_ENV === 'development' && contextRefs.length > 0) {
    console.log(
      `${LOG_PREFIX} [性能] 资源加载完成（含路径）:`,
      `总数=${contextRefs.length}`,
      `成功=${sendRefs.length}`,
      `路径=${Object.keys(pathMap).length}`,
      `耗时=${duration.toFixed(0)}ms`,
      `平均=${(duration / contextRefs.length).toFixed(0)}ms/个`
    );
  }

  return { sendRefs, pathMap };
}

/**
 * 从 Store 获取 pendingContextRefs
 *
 * 使用类型断言安全获取，兼容不同版本的 Store。
 *
 * @param store ChatStore 或类似对象
 * @returns ContextRef 数组，不存在时返回空数组
 */
export function getPendingContextRefs(store: unknown): ContextRef[] {
  const storeObj = store as Record<string, unknown>;
  // 优先使用 getState() 获取最新状态（Zustand store）
  const state = typeof storeObj?.getState === 'function'
    ? (storeObj.getState as () => Record<string, unknown>)()
    : storeObj;
  const refs = state?.pendingContextRefs;
  if (Array.isArray(refs)) {
    return refs as ContextRef[];
  }
  return [];
}

// ============================================================================
// 资源引用验证和清理（P1 修复：资源删除后引用清理）
// ============================================================================

/**
 * 资源引用验证结果
 */
export interface ValidateContextRefsResult {
  /** 有效的引用（资源存在） */
  validRefs: ContextRef[];
  /** 无效的引用（资源已删除） */
  invalidRefs: ContextRef[];
  /** 是否有引用被移除 */
  hasInvalidRefs: boolean;
}

/**
 * 验证并清理上下文引用
 *
 * 🆕 P1 修复：在发送前验证所有 pendingContextRefs 中引用的资源是否存在。
 * 如果资源已被删除，将其从 pendingContextRefs 中移除并通知用户。
 *
 * 使用场景：
 * 1. 发送消息前验证（防止发送时引用已删除资源）
 * 2. 会话恢复后验证（补充现有的异步验证）
 * 3. 用户主动触发检查（如刷新按钮）
 *
 * @param contextRefs 待验证的上下文引用数组
 * @param options 验证选项
 * @returns 验证结果
 */
export async function validateContextRefs(
  contextRefs: ContextRef[],
  options?: {
    /** 是否在有无效引用时通知用户（默认 true） */
    notifyUser?: boolean;
    /** 是否记录详细日志（默认 true） */
    logDetails?: boolean;
  }
): Promise<ValidateContextRefsResult> {
  const { notifyUser = true, logDetails = true } = options ?? {};

  if (!contextRefs || contextRefs.length === 0) {
    return {
      validRefs: [],
      invalidRefs: [],
      hasInvalidRefs: false,
    };
  }

  const startTime = performance.now();
  const validRefs: ContextRef[] = [];
  const invalidRefs: ContextRef[] = [];

  // 并行验证所有资源是否存在
  const existsResults = await pMap(
    contextRefs,
    async (ref) => {
      try {
        const exists = await resourceStoreApi.exists(ref.resourceId);
        return { ref, exists };
      } catch (error: unknown) {
        // 检查失败时视为无效
        console.warn(
          LOG_PREFIX,
          'Failed to check resource existence:',
          ref.resourceId,
          getErrorMessage(error)
        );
        return { ref, exists: false };
      }
    },
    RESOURCE_LOAD_CONCURRENCY
  );

  // 分类结果
  for (const { ref, exists } of existsResults) {
    if (exists) {
      validRefs.push(ref);
    } else {
      invalidRefs.push(ref);
    }
  }

  const duration = performance.now() - startTime;
  const hasInvalidRefs = invalidRefs.length > 0;

  // 记录日志
  if (logDetails) {
    logAttachment('adapter', 'validate_context_refs', {
      total: contextRefs.length,
      valid: validRefs.length,
      invalid: invalidRefs.length,
      invalidResourceIds: invalidRefs.map(r => r.resourceId),
      duration: Math.round(duration),
    }, hasInvalidRefs ? 'warning' : 'success');

    if (hasInvalidRefs) {
      console.warn(
        LOG_PREFIX,
        `Validation found ${invalidRefs.length} invalid refs (resources deleted):`,
        invalidRefs.map(r => `${r.typeId}:${r.resourceId}`)
      );
    }
  }

  // 通知用户
  if (hasInvalidRefs && notifyUser) {
    showGlobalNotification('warning', i18n.t('chatV2:chat.context_invalid_removed', { count: invalidRefs.length }));
  }

  return {
    validRefs,
    invalidRefs,
    hasInvalidRefs,
  };
}

/**
 * 验证并更新 Store 中的 pendingContextRefs
 *
 * 🆕 P1 修复：验证后自动更新 Store 状态，移除无效引用。
 *
 * @param store ChatStore 实例（需要有 removeContextRef 方法）
 * @param contextRefs 待验证的上下文引用数组
 * @param options 验证选项
 * @returns 有效的引用数组
 */
export async function validateAndCleanupContextRefs(
  store: unknown,
  contextRefs: ContextRef[],
  options?: {
    notifyUser?: boolean;
    logDetails?: boolean;
  }
): Promise<ContextRef[]> {
  const result = await validateContextRefs(contextRefs, options);

  // 如果有无效引用，从 Store 中移除
  if (result.hasInvalidRefs) {
    const storeObj = store as Record<string, unknown>;
    const storeState = typeof storeObj?.getState === 'function'
      ? (storeObj.getState as () => Record<string, unknown>)()
      : storeObj;

    if (typeof storeState?.removeContextRef === 'function') {
      for (const invalidRef of result.invalidRefs) {
        (storeState.removeContextRef as (id: string) => void)(invalidRef.resourceId);
        console.log(
          LOG_PREFIX,
          'Removed invalid context ref from store:',
          invalidRef.resourceId,
          `(type: ${invalidRef.typeId})`
        );
      }
    } else {
      console.warn(
        LOG_PREFIX,
        'Store does not have removeContextRef method, cannot cleanup invalid refs'
      );
    }
  }

  return result.validRefs;
}

// ============================================================================
// ContentBlock 合并工具
// ============================================================================

/**
 * 合并多个 ContentBlock 数组
 *
 * @param blockArrays ContentBlock 数组的数组
 * @returns 合并后的 ContentBlock 数组
 */
export function mergeContentBlocks(...blockArrays: (ContentBlock[] | undefined)[]): ContentBlock[] {
  const result: ContentBlock[] = [];

  for (const blocks of blockArrays) {
    if (blocks) {
      result.push(...blocks);
    }
  }

  return result;
}

/**
 * 从 SendContextRef 数组提取所有 ContentBlock
 *
 * @param sendRefs SendContextRef 数组
 * @returns 合并后的 ContentBlock 数组
 */
export function extractContentBlocks(sendRefs: SendContextRef[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const ref of sendRefs) {
    blocks.push(...ref.formattedBlocks);
  }

  return blocks;
}

// ============================================================================
// System Prompt Hints 收集
// ============================================================================

/**
 * 收集上下文类型的 System Prompt Hints
 *
 * 根据 pendingContextRefs 中使用的类型，收集对应的 systemPromptHint，
 * 用于告知 LLM 用户消息中 XML 标签的含义和用途。
 *
 * @param contextRefs 上下文引用数组
 * @returns 去重后的 hint 数组（已按优先级排序）
 */
export function collectContextTypeHints(contextRefs: ContextRef[]): string[] {
  if (!contextRefs || contextRefs.length === 0) {
    return [];
  }

  // 提取所有使用到的 typeId
  const typeIds = contextRefs.map((ref) => ref.typeId);

  // 使用 registry 收集 hints
  const hints = contextTypeRegistry.collectSystemPromptHints(typeIds);

  console.log(
    LOG_PREFIX,
    'Collected context type hints:',
    hints.length,
    'hints for',
    typeIds.length,
    'refs'
  );

  return hints;
}

// ============================================================================
// Token 估算和截断工具
// ============================================================================

/**
 * 根据内容类型动态估算文本的 Token 数量
 *
 * ✅ P1修复：改进 Token 估算准确性
 * - 使用展开运算符 [...text] 正确处理 emoji 等代理对
 * - 检测中文占比，动态调整估算比率
 * - 中文约 1.5-2 字符/token（实际测试中文 token 化效率较低）
 * - 英文约 4 字符/token
 * - 根据中文占比线性插值计算平均比率
 *
 * @param text 待估算的文本内容
 * @returns 估算的 token 数量
 */
function estimateTokensForText(text: string): number {
  if (!text || text.length === 0) {
    return 0;
  }

  // 使用展开运算符获取真实字符数（正确处理 emoji 等代理对）
  const chars = [...text];
  const realLength = chars.length;

  // 检测中文字符数量（包括中文标点符号）
  const chineseChars = (text.match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const chineseRatio = realLength > 0 ? chineseChars / realLength : 0;

  // 根据中文占比动态调整估算比率（与后端 token_budget.rs 对齐）
  // - 纯中文：~1.0 字符/token（cl100k_base/o200k_base 中常用汉字多为单 token）
  // - 纯英文：~4 字符/token
  // - 混合文本：线性插值
  const avgCharsPerToken = chineseRatio * 1.0 + (1 - chineseRatio) * 4;

  return Math.ceil(realLength / avgCharsPerToken);
}

/**
 * 估算 ContentBlock 数组的 Token 数量
 *
 * ✅ P1修复：使用改进的 Token 估算算法
 * - 文本块：使用 estimateTokensForText() 动态估算
 * - 图片块：固定 500 tokens（图片通常占用大量 tokens）
 * - 其他类型：按文本处理
 *
 * @param blocks ContentBlock 数组
 * @returns 估算的 token 数量
 */
export function estimateContentBlockTokens(blocks: ContentBlock[]): number {
  let totalTokens = 0;

  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      // 文本块：使用动态估算
      totalTokens += estimateTokensForText(block.text);
    } else if (block.type === 'image') {
      // 图片块：按 Claude 公式估算 (width * height) / 750，最低 258
      const imageBlock = block as typeof block & { source?: { width?: number; height?: number } };
      const w = typeof imageBlock.source?.width === 'number' ? imageBlock.source.width : 0;
      const h = typeof imageBlock.source?.height === 'number' ? imageBlock.source.height : 0;
      totalTokens += (w > 0 && h > 0) ? Math.max(258, Math.ceil((w * h) / 750)) : 800;
    } else {
      // 其他类型：尝试获取文本内容并动态估算
      const text = String(block.text || '');
      totalTokens += estimateTokensForText(text);
    }
  }

  return totalTokens;
}

/**
 * 估算 SendContextRef 数组的总 Token 数量
 *
 * @param sendRefs SendContextRef 数组
 * @returns 估算的总 token 数量
 */
export function estimateSendContextRefTokens(sendRefs: SendContextRef[]): number {
  let totalTokens = 0;

  for (const ref of sendRefs) {
    totalTokens += estimateContentBlockTokens(ref.formattedBlocks);
  }

  return totalTokens;
}

/**
 * Token 截断结果
 */
export interface TruncateResult {
  /** 截断后的 SendContextRef 数组 */
  truncatedRefs: SendContextRef[];
  /** 截断前的总 token 数 */
  originalTokens: number;
  /** 截断后的总 token 数 */
  finalTokens: number;
  /** 是否发生了截断 */
  wasTruncated: boolean;
  /** 被移除的 ref 数量 */
  removedCount: number;
}

/**
 * 按优先级截断上下文引用（改进版背包算法）
 *
 * ✅ P1修复：改进截断算法，使用背包策略而非简单贪心
 *
 * 当上下文总 token 数超过限制时，采用以下策略：
 * 1. 优先级高的引用（priority 值小）优先保留
 * 2. 单个资源过大时跳过，但继续处理后续资源（而非立即停止）
 * 3. 累积超限时跳过当前资源，继续尝试后续更小的资源
 * 4. 调用方应显式传入基于模型动态计算的限制值
 *
 * 改进点：
 * - 旧算法：遇到超限资源就停止，浪费剩余空间
 * - 新算法：跳过过大资源，继续尝试后续资源，最大化利用可用空间
 *
 * @param sendRefs SendContextRef 数组（已按优先级排序）
 * @param maxTokens 最大 token 限制（调用方应显式传入，兜底使用 SAFE_MAX_CONTEXT_TOKENS）
 * @returns 截断结果
 */
export function truncateContextByTokens(
  sendRefs: SendContextRef[],
  maxTokens: number = SAFE_MAX_CONTEXT_TOKENS
): TruncateResult {
  const originalTokens = estimateSendContextRefTokens(sendRefs);

  // 如果未超过限制，直接返回
  if (originalTokens <= maxTokens) {
    console.log(
      LOG_PREFIX,
      `上下文未超限: ${originalTokens} tokens ≤ ${maxTokens} tokens`
    );
    return {
      truncatedRefs: sendRefs,
      originalTokens,
      finalTokens: originalTokens,
      wasTruncated: false,
      removedCount: 0,
    };
  }

  // ✅ 改进算法：背包策略截断
  const result: SendContextRef[] = [];
  const removed: SendContextRef[] = [];
  let currentTokens = 0;

  console.log(
    LOG_PREFIX,
    `上下文超限，开始截断: ${originalTokens} tokens > ${maxTokens} tokens`
  );

  // 从前往后（优先级从高到低）处理引用
  for (const ref of sendRefs) {
    const refTokens = estimateContentBlockTokens(ref.formattedBlocks);

    // ✅ 改进1: 单个资源过大时跳过但继续处理后续资源
    if (refTokens > maxTokens) {
      console.warn(
        LOG_PREFIX,
        `单个资源过大，跳过: type=${ref.typeId}, resourceId=${ref.resourceId}, tokens=${refTokens} > ${maxTokens}`
      );
      removed.push(ref);
      continue; // 继续处理下一个，而不是停止
    }

    // ✅ 改进2: 累积超限时跳过当前资源，但继续尝试后续更小的资源
    if (currentTokens + refTokens > maxTokens) {
      console.warn(
        LOG_PREFIX,
        `添加后超限，跳过: type=${ref.typeId}, resourceId=${ref.resourceId}, tokens=${refTokens}, ` +
          `当前=${currentTokens}, 限制=${maxTokens}, 缺口=${maxTokens - currentTokens}`
      );
      removed.push(ref);
      continue; // 继续尝试后续资源
    }

    // 可以添加，更新累积
    result.push(ref);
    currentTokens += refTokens;
    console.log(
      LOG_PREFIX,
      `添加资源: type=${ref.typeId}, tokens=${refTokens}, 累积=${currentTokens}/${maxTokens}`
    );
  }

  console.log(
    LOG_PREFIX,
    `截断完成: 保留=${result.length}, 移除=${removed.length}, ` +
      `最终tokens=${currentTokens}, 利用率=${((currentTokens / maxTokens) * 100).toFixed(1)}%`
  );

  return {
    truncatedRefs: result,
    originalTokens,
    finalTokens: currentTokens,
    wasTruncated: removed.length > 0,
    removedCount: removed.length,
  };
}

// ============================================================================
// 调试工具
// ============================================================================

/**
 * 打印 SendContextRef 数组的摘要信息
 *
 * @param sendRefs SendContextRef 数组
 */
export function logSendContextRefsSummary(sendRefs: SendContextRef[]): void {
  if (sendRefs.length === 0) {
    console.log(LOG_PREFIX, 'No context refs to send');
    return;
  }

  console.log(LOG_PREFIX, '=== SendContextRefs Summary ===');
  for (let i = 0; i < sendRefs.length; i++) {
    const ref = sendRefs[i];
    const textBlocks = ref.formattedBlocks.filter((b) => b.type === 'text').length;
    const imageBlocks = ref.formattedBlocks.filter((b) => b.type === 'image').length;

    console.log(
      LOG_PREFIX,
      `[${i + 1}] type=${ref.typeId}, resourceId=${ref.resourceId}, ` +
        `blocks: ${textBlocks} text, ${imageBlocks} image`
    );
  }
  console.log(LOG_PREFIX, '=== End Summary ===');
}

// ============================================================================
// 文件夹上下文辅助函数
// ============================================================================

/**
 * 检查 ContextRef 是否为文件夹类型
 *
 * @param ref 上下文引用
 * @returns 是否为文件夹类型
 */
export function isFolderContextRef(ref: ContextRef): boolean {
  return ref.typeId === 'folder';
}

/**
 * 从 ContextRef 数组中提取文件夹引用
 *
 * @param contextRefs 上下文引用数组
 * @returns 文件夹类型的引用数组
 */
export function extractFolderContextRefs(contextRefs: ContextRef[]): ContextRef[] {
  return contextRefs.filter(isFolderContextRef);
}

/**
 * 统计 ContextRef 数组中各类型的数量
 *
 * @param contextRefs 上下文引用数组
 * @returns 类型到数量的映射
 */
export function countContextRefsByType(contextRefs: ContextRef[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const ref of contextRefs) {
    counts[ref.typeId] = (counts[ref.typeId] || 0) + 1;
  }

  return counts;
}

// ============================================================================
// VFS 资源获取辅助函数（已废弃并删除 - 文档 24 Prompt 7）
// ============================================================================
//
// ★ 快照模式函数（已废弃并删除）
// 已删除以下废弃函数：
// - getResourceContentFromVfs
// - createResourceFromNote
// - createResourceFromTextbook
// - createResourceFromExam
// - createResourceFromEssay
// - createResourceFromVfs
//
// 已删除以下重复的类型定义（统一使用 vfsRefTypes.ts）：
// - VfsResourceContent（未使用）
// - VfsResourceType（重复定义，应使用 vfsRefTypes.ts 的 VfsResourceType）
// - isVfsResourceType（重复定义，应使用 vfsRefTypes.ts 的 isVfsResourceType）
//
// ★ 请使用 vfsRefApi.getResourceRefsV2() + vfsRefApi.resolveResourceRefsV2() 代替
//

// ============================================================================
// VFS 引用解析（文档 24 Prompt 8）
// ============================================================================


/**
 * 解析 VFS 引用
 *
 * 对于 VFS 类型的资源（folder, note, textbook, exam, essay），
 * 从 resource.data 解析 VfsContextRefData，调用后端获取实时内容，
 * 将结果存储在 resource._resolvedResources 字段中。
 *
 * 约束（文档 24 契约 G）：
 * 1. 解析失败时 _resolvedResources 为空数组
 * 2. 资源已删除时 resolved.found = false
 * 3. 不修改原始 resource.data
 *
 * @param resource 原始资源
 * @param typeId 资源类型 ID
 * @param options 格式化选项（可选，包含 isMultimodal 等）
 * @param injectModes 注入模式配置（可选，用于图片和 PDF 的注入模式选择）
 * @returns 带有 _resolvedResources 的资源（新对象）
 */
export async function resolveVfsRefs(
  resource: Resource, 
  typeId: string, 
  options?: FormatOptions,
  injectModes?: import('../context/vfsRefTypes').ResourceInjectModes
): Promise<Resource> {
  console.debug('[resolveVfsRefs]', resource.id, typeId, { dataLen: resource.data?.length ?? 0 });

  // 非 VFS 类型，直接返回
  if (!isVfsRefType(typeId)) {
    logAttachment('adapter', 'resolve_vfs_refs_skip', {
      resourceId: resource.id,
      typeId,
      reason: 'not_vfs_ref_type',
    }, 'debug');
    return resource;
  }

  // 尝试解析 data 为 VfsContextRefData
  let refData: VfsContextRefData | null = null;
  try {
    const parsed = JSON.parse(resource.data);
    // 验证是否为有效的 VfsContextRefData
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray(parsed.refs) &&
      typeof parsed.totalCount === 'number'
    ) {
      refData = parsed as VfsContextRefData;
    }
  } catch (parseError: unknown) {
    // 🔧 P0-16 修复：支持旧格式（直接存储内容而不是 VfsContextRefData）
    // 原问题：resource_sync_note 等同步服务创建的资源存储的是直接内容，
    //         而不是 VfsContextRefData JSON，导致解析失败
    // 解决方案：为旧格式创建合成的 _resolvedResources，使用资源内容作为 content
    logAttachment('adapter', 'resolve_vfs_refs_legacy_format', {
      resourceId: resource.id,
      typeId,
      dataLen: resource.data?.length ?? 0,
      reason: 'legacy_direct_content_format',
    }, 'warning');
    console.warn(LOG_PREFIX, `Resource ${resource.id} using legacy direct storage format, synthesizing _resolvedResources`);

    // 从资源元数据中提取信息
    const metadata = resource.metadata || {};
    const sourceId = String(metadata.sourceId || resource.sourceId || resource.id);
    const name = String(metadata.name || metadata.title || i18n.t('chatV2:context.unnamed_resource'));

    // 创建合成的 ResolvedResource
    const syntheticResolved: ResolvedResource[] = [{
      sourceId,
      resourceHash: resource.hash || '',
      type: typeId as FullVfsResourceType,
      name,
      path: '', // 旧格式没有路径信息
      content: resource.data || '', // 使用资源数据作为内容
      byteSize: resource.data?.length ?? 0,
      found: true,
      multimodalBlocks: null,
    }];

    return {
      ...resource,
      _resolvedResources: syntheticResolved,
    };
  }

  if (!refData || refData.refs.length === 0) {
    logAttachment('adapter', 'resolve_vfs_refs_empty', {
      resourceId: resource.id,
      typeId,
    }, 'warning');
    return {
      ...resource,
      _resolvedResources: [],
    };
  }

  // ★ 2026-02-13 修复：纯文本模型 → 确保 injectModes 始终包含 OCR，并移除 image
  // 后端根据 injectModes 决定返回内容；若缺少 OCR，后端不会返回 OCR 文本，
  // 导致 formatToBlocks 找不到 OCR 数据、只能输出无用占位符。
  //
  // ★ P0/P1 修复（二轮审阅）：
  //   1. 同时移除 'image' 模式，避免后端为文本模型准备无用的 base64 数据
  //   2. 仅对 Image/File/Textbook 类型 ref 注入 effectiveInjectModes，
  //      避免给 Note/Essay 等不相关类型污染缓存键
  let effectiveInjectModes: import('../context/vfsRefTypes').ResourceInjectModes | undefined = injectModes;
  if (options?.isMultimodal === false) {
    type ImgMode = import('../context/vfsRefTypes').ImageInjectMode;
    type PdfMode = import('../context/vfsRefTypes').PdfInjectMode;
    const imgModes = injectModes?.image;
    const pdfModes = injectModes?.pdf;
    // 确保包含 OCR，同时移除 image（文本模型无法使用图片）
    const normalizedImg: ImgMode[] = [
      ...(imgModes ?? []).filter((m): m is ImgMode => m !== 'image'),
      ...(!imgModes?.includes('ocr') ? ['ocr' as ImgMode] : []),
    ];
    const normalizedPdf: PdfMode[] = [
      ...(pdfModes ?? []).filter((m): m is PdfMode => m !== 'image'),
      ...(!pdfModes?.includes('ocr') ? ['ocr' as PdfMode] : []),
      ...(!pdfModes?.includes('text') ? ['text' as PdfMode] : []),
    ];
    effectiveInjectModes = { image: normalizedImg, pdf: normalizedPdf };
    console.debug('[resolveVfsRefs] Text-only model: normalized injectModes', effectiveInjectModes);
  }

  // ★ 将 injectModes 添加到每个引用中
  // ★ NEW-P0 修复：仅对 Image/File/Textbook 类型注入 effectiveInjectModes，
  //   避免给 Note/Essay/Exam 等不相关类型附加无意义的 image/pdf 模式（会污染缓存键）
  const MEDIA_REF_TYPES = new Set<FullVfsResourceType>(['image', 'file', 'textbook']);
  const refsWithInjectModes = refData.refs.map(ref => ({
    ...ref,
    injectModes: MEDIA_REF_TYPES.has(ref.type)
      ? (effectiveInjectModes ?? undefined)
      : ref.injectModes,
  }));

  logAttachment('adapter', 'resolve_vfs_refs_start', {
    resourceId: resource.id,
    typeId,
    refsCount: refsWithInjectModes.length,
    isMultimodal: options?.isMultimodal,
    effectiveInjectModes: effectiveInjectModes,
  });

  // 调用后端解析（已移除 Mock 实现）
  const resolvedResources = await invokeVfsResolve(refsWithInjectModes);

  // ★ 补强：收集后端返回的 warning，通知用户内容质量降级
  // ★ P1-2 修复（二轮审阅）：去重并限制数量，避免多资源场景下通知洪水
  const warnings = resolvedResources
    .filter(r => r.found && r.warning)
    .map(r => r.warning as string);
  if (warnings.length > 0) {
    console.warn(LOG_PREFIX, `Backend warnings for ${resource.id}:`, warnings);
    const uniqueWarnings = [...new Set(warnings)];
    const MAX_DISPLAY_WARNINGS = 3;
    const displayWarnings = uniqueWarnings.slice(0, MAX_DISPLAY_WARNINGS);
    const remaining = uniqueWarnings.length - displayWarnings.length;
    const message = remaining > 0
      ? displayWarnings.join('；') + i18n.t('chatV2:context.more_warnings', { count: remaining, defaultValue: `；等 ${remaining} 条警告` })
      : displayWarnings.join('；');
    showGlobalNotification('warning', message);
  }

  logAttachment('adapter', 'resolve_vfs_refs_done', {
    resourceId: resource.id,
    resolvedCount: resolvedResources.length,
    foundCount: resolvedResources.filter((r) => r.found).length,
    warningCount: warnings.length,
    results: resolvedResources.map(r => ({
      sourceId: r.sourceId,
      found: r.found,
      contentLen: r.content?.length ?? 0,
      multimodalBlocksCount: r.multimodalBlocks?.length ?? 0,
      warning: r.warning,
    })),
  }, resolvedResources.some(r => r.found) ? 'success' : 'warning');

  // ★★★ 2025-12-10 统一改造：exam 类型的多模态内容已由后端 vfs_resolve_resource_refs 统一填充
  // 移除了前端额外调用 dstu_get_exam_content 的逻辑

  // 返回新对象，不修改原始 resource
  return {
    ...resource,
    _resolvedResources: resolvedResources,
  };
}

/**
 * 调用后端 vfs_resolve_resource_refs 命令
 *
 * ★ P0修复：使用 batchGetResources 启用缓存层，避免重复解析相同资源
 * ★ HIGH-004: 使用 vfsRefApi.resolveResourceRefsV2 进行统一的错误处理和用户通知
 *
 * @param refs VFS 资源引用数组
 * @param notifyOnError 是否在错误时通知用户（默认 true）
 * @returns 解析后的资源数组
 */
async function invokeVfsResolve(
  refs: VfsResourceRef[],
  notifyOnError = true
): Promise<ResolvedResource[]> {
  logAttachment('backend', 'invoke_vfs_resolve_start', {
    refsCount: refs.length,
    refs: refs.map(r => ({ sourceId: r.sourceId, type: r.type, hash: r.resourceHash })),
  });

  // ★ P0修复：优先使用带缓存的 batchGetResources
  const { batchGetResources } = await import('../context/vfsRefApiEnhancements');
  const batchResult = await batchGetResources(refs);

  // 🔧 P0修复：检查批量查询结果
  if (isErr(batchResult)) {
    // 缓存查询失败，记录日志并通知用户
    const error = batchResult.error!;
    logAttachment('backend', 'invoke_vfs_resolve_cache_error', {
      error: error.message,
      code: error.code,
      refs: refs.map(r => `${r.sourceId}:${r.resourceHash}`),
    }, 'error');

    if (notifyOnError) {
      showGlobalNotification('error', error.toUserMessage());
    }

    // 返回空数组，上层会显示错误提示
    return [];
  }

  // ★ P0修复：将 Map 转换为数组
  const resourceMap = batchResult.value;
  const resolved: ResolvedResource[] = [];

  for (const ref of refs) {
    const resource = resourceMap.get(ref.sourceId);
    if (resource) {
      resolved.push(resource);
    } else {
      // 资源未找到，构造一个 found=false 的结果
      resolved.push({
        sourceId: ref.sourceId,
        resourceHash: ref.resourceHash,
        type: ref.type,
        name: ref.name,
        found: false,
        content: null,
        path: null,
        multimodalBlocks: null,
      });
    }
  }

  // 统计缓存命中/未命中情况
  const foundCount = resolved.filter(r => r.found).length;
  const cacheHitCount = resourceMap.size;
  const cacheMissCount = refs.length - cacheHitCount;

  logAttachment('backend', 'invoke_vfs_resolve_done', {
    resultCount: resolved.length,
    foundCount,
    cacheHitCount,
    cacheMissCount,
    cacheHitRate: ((cacheHitCount / refs.length) * 100).toFixed(1) + '%',
    results: resolved.map(r => ({
      sourceId: r.sourceId,
      hash: r.resourceHash,
      found: r.found,
      contentLen: r.content?.length ?? 0,
      type: r.type,
    })),
  }, resolved.some(r => r.found) ? 'success' : 'warning');

  // 开发模式下输出缓存统计
  if (process.env.NODE_ENV === 'development' && refs.length > 0) {
    console.log(
      `${LOG_PREFIX} [缓存统计] 资源解析完成:`,
      `总数=${refs.length}`,
      `命中=${cacheHitCount}`,
      `未命中=${cacheMissCount}`,
      `命中率=${((cacheHitCount / refs.length) * 100).toFixed(1)}%`
    );
  }

  return resolved;
}


/**
 * 检查资源是否包含已解析的 VFS 引用
 *
 * @param resource 资源
 * @returns 是否包含 _resolvedResources
 */
export function hasResolvedVfsRefs(resource: Resource): boolean {
  return Array.isArray(resource._resolvedResources) && resource._resolvedResources.length > 0;
}

/**
 * 从资源中获取解析后的 VFS 引用
 *
 * @param resource 资源
 * @returns 解析后的资源数组（如果没有则返回空数组）
 */
export function getResolvedVfsRefs(resource: Resource): ResolvedResource[] {
  return resource._resolvedResources ?? [];
}
