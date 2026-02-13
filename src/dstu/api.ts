/**
 * DSTU 访达协议层 API 封装
 *
 * 封装 Tauri invoke 调用，提供统一的资源访问接口。
 * 所有方法返回 Result<T, VfsError> 类型，提供类型安全的错误处理。
 *
 * 数据契约来源：21-VFS虚拟文件系统架构设计.md 第四章 4.4
 *
 * 约束：
 * 1. 所有方法使用 invoke 调用后端 dstu_* 命令
 * 2. 错误处理使用 Result 模式，不使用 try-catch
 * 3. 直接使用真实后端 API
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  ok,
  err,
  toVfsError,
  VfsError,
  VfsErrorCode,
  type Result,
} from '@/shared/result';
import type {
  DstuNode,
  DstuListOptions,
  DstuCreateOptions,
  DstuWatchEvent,
} from './types';
import { getDstuLogger } from './logger';
import { fileToBase64 } from './encoding';
// [FIX-D001] Use static top-level import to avoid race conditions in dynamic imports
import { invalidateResourceCache } from '@/chat-v2/context/vfsRefApiEnhancements';

// ============================================================================
// 日志前缀
// ============================================================================

const LOG_PREFIX = '[DSTU:API]';

// ============================================================================
// 缓存失效辅助函数
// ============================================================================

/**
 * 缓存失效包装器
 * [FIX-M001] 增强错误处理
 * [FIX-D001] 使用静态导入避免动态导入竞态条件
 *
 * 功能：
 * - 开发环境：打印详细错误堆栈，便于调试
 * - 生产环境：静默警告，不影响主流程
 * - 预留监控系统集成点
 *
 * @param nodeId 节点ID
 * @param operation 操作名称（用于日志）
 */
async function invalidateCacheWithLogging(
  nodeId: string,
  operation: string
): Promise<void> {
  try {
    // [FIX-D001] Call statically imported function to avoid dynamic import
    invalidateResourceCache(nodeId);
    console.log(LOG_PREFIX, `${operation}() 已触发缓存失效:`, nodeId);
  } catch (cacheError: unknown) {
    // ★ 开发环境下打印详细错误堆栈
    if (import.meta.env.DEV) {
      console.error(
        LOG_PREFIX,
        `${operation}() 缓存失效失败（开发模式）:`,
        cacheError
      );
      // 可选：在开发环境抛出错误以便调试
      // throw cacheError;
    } else {
      console.warn(LOG_PREFIX, `${operation}() 缓存失效失败:`, cacheError);
    }

    // 监控系统集成点（如需启用 Sentry，在应用初始化时配置）
    // captureException(cacheError, { extra: { nodeId, operation } });
  }
}

/**
 * 批量缓存失效包装器
 * [FIX-M001] 增强错误处理
 * [FIX-D001] 使用静态导入避免动态导入竞态条件
 *
 * @param nodeIds 节点ID列表
 * @param operation 操作名称
 */
async function invalidateMultipleCachesWithLogging(
  nodeIds: string[],
  operation: string
): Promise<void> {
  if (nodeIds.length === 0) return;

  try {
    // [FIX-D001] Call statically imported function to avoid dynamic import
    for (const nodeId of nodeIds) {
      invalidateResourceCache(nodeId);
    }
    console.log(LOG_PREFIX, `${operation}() 已触发缓存失效:`, nodeIds.length, '项');
  } catch (cacheError: unknown) {
    // ★ 开发环境下打印详细错误堆栈
    if (import.meta.env.DEV) {
      console.error(
        LOG_PREFIX,
        `${operation}() 缓存失效失败（开发模式）:`,
        cacheError
      );
      // 可选：在开发环境抛出错误以便调试
      // throw cacheError;
    } else {
      console.warn(LOG_PREFIX, `${operation}() 缓存失效失败:`, cacheError);
    }

    // 监控系统集成点（如需启用 Sentry，在应用初始化时配置）
    // captureException(cacheError, { extra: { nodeIds, operation } });
  }
}

/**
 * 从路径中提取真实的 sourceId
 *
 * [FIX-D003] 添加输入验证、长度限制和ReDoS防护
 *
 * 路径格式示例:
 * - "/note_123" -> "note_123"
 * - "/高考复习/函数/note_abc" -> "note_abc"
 * - "/tb_xyz" -> "tb_xyz"
 *
 * 安全限制:
 * - 路径最大长度: 1000字符
 * - sourceId最大长度: 128字符
 * - 使用非回溯正则表达式防护ReDoS攻击
 *
 * @param path 资源路径
 * @returns 提取的 sourceId（已消毒）
 * @throws VfsError 当输入超出安全限制时
 */
function extractSourceIdFromPath(path: string): string {
  // [FIX-D003] Path length limit (1000 chars, aligned with backend)
  const MAX_PATH_LENGTH = 1000;
  const MAX_SOURCE_ID_LENGTH = 128;

  if (path.length > MAX_PATH_LENGTH) {
    console.error(LOG_PREFIX, `路径长度超限 (${path.length} > ${MAX_PATH_LENGTH}):`, path.substring(0, 100) + '...');
    throw new VfsError(
      VfsErrorCode.VALIDATION,
      `路径长度超限: ${path.length} 字符（最大 ${MAX_PATH_LENGTH}）`,
      true,
      { pathLength: path.length, maxLength: MAX_PATH_LENGTH }
    );
  }

  // 分割路径并过滤空字符串
  const parts = path.split('/').filter(Boolean);

  // 取最后一个部分作为潜在的 sourceId
  const lastPart = parts[parts.length - 1] || path;

  // [FIX-D003] SourceId length limit (128 chars)
  if (lastPart.length > MAX_SOURCE_ID_LENGTH) {
    console.error(LOG_PREFIX, `sourceId长度超限 (${lastPart.length} > ${MAX_SOURCE_ID_LENGTH}):`, lastPart.substring(0, 50) + '...');
    throw new VfsError(
      VfsErrorCode.VALIDATION,
      `sourceId长度超限: ${lastPart.length} 字符（最大 ${MAX_SOURCE_ID_LENGTH}）`,
      true,
      { sourceIdLength: lastPart.length, maxLength: MAX_SOURCE_ID_LENGTH }
    );
  }

  // [FIX-D003] Use non-backtracking regex to prevent ReDoS
  // Original: /^(note|tb|fld|exam|tr|essay|img|att|retrieval)_[a-zA-Z0-9_-]+$/
  // Optimized: limit repetition count to avoid catastrophic backtracking
  const validSourceIdPattern = /^(note|tb|fld|exam|tr|essay|img|att|retrieval)_[a-zA-Z0-9_-]{1,120}$/;

  if (validSourceIdPattern.test(lastPart)) {
    return lastPart;
  }

  // 如果不是合法格式，进行基本消毒（移除非法字符）
  // [FIX-D003] Limit sanitized length to prevent abnormal input
  const sanitized = lastPart.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, MAX_SOURCE_ID_LENGTH);

  console.warn(LOG_PREFIX, '路径格式不合法，已消毒:', {
    original: lastPart,
    sanitized,
  });

  return sanitized;
}

/**
 * 批量收集节点ID和路径
 * [FIX-P1-008] 收集失败时使用 path 提取的 sourceId 作为 fallback
 * [FIX-D003] 添加输入验证
 *
 * 即使 get 失败也会使用 path 提取的 sourceId 作为 fallback key，确保缓存失效策略完整
 *
 * @param paths 资源路径列表
 * @returns 节点ID列表（成功获取的ID + 失败时使用提取的sourceId作为fallback）
 */
async function collectNodeIdsForInvalidation(paths: string[]): Promise<string[]> {
  const getResults = await Promise.allSettled(paths.map(path => get(path)));
  const nodeIds: string[] = [];

  getResults.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value.ok) {
      // 成功获取节点，使用真实的节点ID
      nodeIds.push(result.value.value.id);
    } else {
      // [FIX-D003] Extract real sourceId from path when get() fails
      const originalPath = paths[index];
      try {
        const extractedSourceId = extractSourceIdFromPath(originalPath);
        nodeIds.push(extractedSourceId);
        console.warn(LOG_PREFIX, '⚠️ get()失败，使用从路径提取的sourceId作为缓存失效fallback:', {
          originalPath,
          extractedSourceId,
          reason: result.status === 'fulfilled' ? 'not_found' : 'error'
        });
      } catch (extractError: unknown) {
        // [FIX-D003] Skip cache invalidation if path extraction fails (e.g., too long)
        console.error(LOG_PREFIX, '无法从路径提取sourceId，跳过缓存失效:', {
          originalPath,
          error: extractError instanceof Error ? extractError.message : String(extractError)
        });
      }
    }
  });

  return nodeIds;
}

// ============================================================================
// Result版本 API 实现
// ============================================================================

/**
 * 列出目录内容
 */
export async function list(path: string, options?: DstuListOptions): Promise<Result<DstuNode[]>> {
  try {
    const result = await invoke<DstuNode[]>('dstu_list', { path, options });
    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '列出目录内容失败', { path, options });
    console.error(LOG_PREFIX, 'list() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 获取资源详情
 * @returns Result<DstuNode, VfsError> - 成功返回节点，未找到返回 NOT_FOUND 错误
 */
export async function get(path: string): Promise<Result<DstuNode>> {
  try {
    const result = await invoke<DstuNode | null>('dstu_get', { path });
    if (result === null) {
      return err(
        new VfsError(
          VfsErrorCode.NOT_FOUND,
          `资源未找到: ${path}`,
          true,
          { path }
        )
      );
    }
    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '获取资源详情失败', { path });
    console.error(LOG_PREFIX, 'get() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 创建资源
 */
export async function create(path: string, options: DstuCreateOptions): Promise<Result<DstuNode>> {
  const startTime = Date.now();
  const logger = getDstuLogger();
  logger.call('create', { path, options });

  try {
    let fileBase64: string | undefined;
    if (options.file) {
      try {
        fileBase64 = await fileToBase64(options.file);
      } catch (fileError: unknown) {
        // 如果是 File 对象则获取文件名，否则使用 unknown
        const fileName = options.file instanceof File ? options.file.name : 'unknown';
        const vfsError = toVfsError(
          fileError,
          '文件读取失败',
          { path, fileName }
        );
        logger.error('create.FILE_READ_ERROR', vfsError.message, [path, options]);
        return err(vfsError);
      }
    }

    const result = await invoke<DstuNode>('dstu_create', {
      path,
      options: {
        type: options.type,
        name: options.name,
        content: options.content,
        fileBase64,
        metadata: options.metadata,
      },
    });

    if (result.name !== options.name) {
      const isIdAsName = result.name.startsWith('note_') || result.name.startsWith('exam_') ||
                         result.name.startsWith('essay_') || result.name.startsWith('trans_');
      logger.error('create.NAME_MISMATCH',
        `输入名称="${options.name}" 但返回名称="${result.name}"${isIdAsName ? ' [疑似ID作为标题]' : ''}`,
        [{ inputName: options.name, outputName: result.name, nodeId: result.id }]
      );
      console.error(LOG_PREFIX, '⚠️ 名称不匹配！', {
        inputName: options.name,
        outputName: result.name,
        nodeId: result.id,
        isIdAsName,
      });
    }

    // [FIX-C004] Validate resourceHash presence, log warning but don't block operation
    // resourceHash is mainly for reference validity check, new resources may not have it
    if (!result.resourceHash) {
      console.warn(LOG_PREFIX, 'create() resourceHash 缺失，可能影响引用模式的有效性校验', {
        nodeId: result.id,
        name: result.name,
        type: options.type,
      });
      // 不再抛出错误，只记录警告，允许操作继续
    }

    logger.success('create', result, Date.now() - startTime);

    // [FIX-CACHE-001] Invalidate cache after successful create
    if (result.id) {
      await invalidateCacheWithLogging(result.id, 'create');
    }

    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '创建资源失败', { path, options });
    logger.error('create', vfsError.message, [path, options]);
    console.error(LOG_PREFIX, 'create() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 更新资源内容
 */
export async function update(path: string, content: string, resourceType: string): Promise<Result<DstuNode>> {
  try {
    const result = await invoke<DstuNode>('dstu_update', { path, content, resourceType });
    console.log(LOG_PREFIX, 'update() 返回新的 resourceHash:', {
      path,
      sourceId: result.id,
      newHash: result.resourceHash,
    });

    // [FIX-M002] [FIX-M001] Invalidate cache after resourceHash update (using unified wrapper)
    if (result.id && result.resourceHash) {
      await invalidateCacheWithLogging(result.id, 'update');
    }

    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '更新资源失败', { path, resourceType });
    console.error(LOG_PREFIX, 'update() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 删除资源
 */
export async function deleteResource(path: string): Promise<Result<void>> {
  try {
    // 先获取节点信息（用于缓存失效）
    const getResult = await get(path);
    const nodeId = getResult.ok ? getResult.value.id : null;

    await invoke<void>('dstu_delete', { path });

    // [FIX-M013] [FIX-M001] Invalidate cache (using unified wrapper)
    if (nodeId) {
      await invalidateCacheWithLogging(nodeId, 'delete');
    }

    return ok(undefined);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '删除资源失败', { path });
    console.error(LOG_PREFIX, 'delete() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 移动资源（跨科目移动）
 */
export async function move(srcPath: string, dstPath: string): Promise<Result<DstuNode>> {
  try {
    // 获取源节点信息（用于缓存失效）
    const getSrcResult = await get(srcPath);
    const srcNodeId = getSrcResult.ok ? getSrcResult.value.id : null;

    const result = await invoke<DstuNode>('dstu_move', {
      src: srcPath,
      dst: dstPath,
    });
    console.log(LOG_PREFIX, 'move() 成功:', { srcPath, dstPath, newPath: result.path });

    // [FIX-M013] [FIX-M001] Invalidate cache for source and destination (using unified wrapper)
    const invalidatePromises: Promise<void>[] = [];
    if (srcNodeId) {
      invalidatePromises.push(invalidateCacheWithLogging(srcNodeId, 'move[src]'));
    }
    if (result.id) {
      invalidatePromises.push(invalidateCacheWithLogging(result.id, 'move[dst]'));
    }

    if (invalidatePromises.length > 0) {
      await Promise.all(invalidatePromises);
    }

    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '移动资源失败', { srcPath, dstPath });
    console.error(LOG_PREFIX, 'move() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 重命名资源（更新显示名称/标题）
 */
export async function rename(path: string, newName: string): Promise<Result<DstuNode>> {
  try {
    const result = await invoke<DstuNode>('dstu_rename', {
      path,
      newName,
    });

    // [FIX-C004] Validate resourceHash presence, strict check in dev mode
    if (!result.resourceHash) {
      console.warn(LOG_PREFIX, 'rename() resourceHash 缺失', {
        nodeId: result.id,
        name: result.name,
        path: result.path,
      });

      // 开发模式下严格检查，返回错误
      if (import.meta.env.DEV) {
        return err(
          new VfsError(
            VfsErrorCode.VALIDATION,
            'resourceHash 缺失，无法完成资源重命名',
            false,
            { nodeId: result.id, name: result.name, path: result.path }
          )
        );
      }
    }

    // [FIX-P1-010] Invalidate cache after rename operation (using unified wrapper)
    if (result.id) {
      await invalidateCacheWithLogging(result.id, 'rename');
    }

    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '重命名资源失败', { path, newName });
    console.error(LOG_PREFIX, 'rename() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 复制资源
 */
export async function copy(srcPath: string, dstPath: string): Promise<Result<DstuNode>> {
  try {
    const result = await invoke<DstuNode>('dstu_copy', {
      src: srcPath,
      dst: dstPath,
    });

    // [FIX-C004] Validate resourceHash presence, strict check in dev mode
    if (!result.resourceHash) {
      console.warn(LOG_PREFIX, 'copy() resourceHash 缺失', {
        nodeId: result.id,
        name: result.name,
        srcPath,
        dstPath,
      });

      // 开发模式下严格检查，返回错误
      if (import.meta.env.DEV) {
        return err(
          new VfsError(
            VfsErrorCode.VALIDATION,
            'resourceHash 缺失，无法完成资源复制',
            false,
            { nodeId: result.id, name: result.name, srcPath, dstPath }
          )
        );
      }
    }

    // [FIX-CACHE-002] Invalidate cache after successful copy
    if (result.id) {
      await invalidateCacheWithLogging(result.id, 'copy');
    }

    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '复制资源失败', { srcPath, dstPath });
    console.error(LOG_PREFIX, 'copy() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 搜索资源
 */
export async function search(query: string, options?: DstuListOptions): Promise<Result<DstuNode[]>> {
  try {
    const result = await invoke<DstuNode[]>('dstu_search', { query, options });
    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '搜索资源失败', { query, options });
    console.error(LOG_PREFIX, 'search() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 获取资源内容
 */
export async function getContent(path: string): Promise<Result<string | Blob>> {
  try {
    const result = await invoke<string>('dstu_get_content', { path });
    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '获取资源内容失败', { path });
    console.error(LOG_PREFIX, 'getContent() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 设置资源元数据
 */
export async function setMetadata(path: string, metadata: Record<string, unknown>): Promise<Result<void>> {
  try {
    // 获取节点信息（用于缓存失效）
    const getResult = await get(path);
    const nodeId = getResult.ok ? getResult.value.id : null;

    await invoke<void>('dstu_set_metadata', { path, metadata });
    console.log(LOG_PREFIX, 'setMetadata() 成功:', { path, metadata });

    // [FIX-M013] [FIX-M001] Invalidate cache (using unified wrapper)
    if (nodeId) {
      await invalidateCacheWithLogging(nodeId, 'setMetadata');
    }

    return ok(undefined);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '设置元数据失败', { path, metadata });
    console.error(LOG_PREFIX, 'setMetadata() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 设置收藏状态
 *
 * [FIX-CACHE-003] 添加缓存失效
 */
export async function setFavorite(path: string, isFavorite: boolean): Promise<Result<void>> {
  try {
    // 从 path 提取 nodeId 用于缓存失效
    const nodeId = extractSourceIdFromPath(path);

    // 后端期望参数名为 favorite
    await invoke<void>('dstu_set_favorite', { path, favorite: isFavorite });

    // [FIX-CACHE-003] Invalidate cache after successful setFavorite
    if (nodeId) {
      await invalidateCacheWithLogging(nodeId, 'setFavorite');
    }

    return ok(undefined);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '设置收藏状态失败', { path, isFavorite });
    console.error(LOG_PREFIX, 'setFavorite() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 监听资源变化
 *
 * [FIX-H009] 处理 restored 和 purged 事件，触发缓存失效
 */
export function watch(path: string, callback: (event: DstuWatchEvent) => void): () => void {
  const normalizedPath = path.trim();
  const eventChannel =
    normalizedPath === '*' || normalizedPath === '/'
      ? 'dstu:change'
      : `dstu:change:${normalizedPath}`;
  let unlistenFn: UnlistenFn | null = null;
  let isCleanedUp = false;

  (async () => {
    if (isCleanedUp) return;

    try {
      await invoke('dstu_watch', { path });

      if (isCleanedUp) {
        await invoke('dstu_unwatch', { path }).catch((err) => { console.warn('[DSTU] unwatch failed:', err); });
        return;
      }

      unlistenFn = await listen<DstuWatchEvent>(eventChannel, (event) => {
        if (!isCleanedUp) {
          const eventType = event.payload.type;
          let nodeId: string | undefined;

          // [FIX-D003] 优先使用 node.id，如果不存在则从 path 提取
          if (event.payload.node?.id) {
            nodeId = event.payload.node.id;
          } else if (event.payload.path) {
            try {
              nodeId = extractSourceIdFromPath(event.payload.path);
            } catch {
              // 提取失败时忽略，继续执行回调
            }
          }

          // 对所有影响缓存的事件触发失效
          if (nodeId) {
            if (
              eventType === 'created' ||
              eventType === 'updated' ||
              eventType === 'moved' ||
              eventType === 'deleted' ||
              eventType === 'restored' ||
              eventType === 'purged'
            ) {
              invalidateCacheWithLogging(nodeId, `watch[${eventType}]`);
            }
          }

          // moved 事件补充旧路径失效
          if (eventType === 'moved' && event.payload.oldPath) {
            try {
              const oldNodeId = extractSourceIdFromPath(event.payload.oldPath);
              if (oldNodeId && oldNodeId !== nodeId) {
                invalidateCacheWithLogging(oldNodeId, 'watch[moved:oldPath]');
              }
            } catch {
              // 提取失败时忽略
            }
          }

          // 继续执行原有回调
          callback(event.payload);
        }
      });
    } catch (error: unknown) {
      const vfsError = toVfsError(error, '监听资源变化失败', { path });
      console.error(LOG_PREFIX, 'watch() failed:', vfsError.toDetailedMessage());
    }
  })();

  return () => {
    isCleanedUp = true;
    if (unlistenFn) {
      unlistenFn();
      unlistenFn = null;
    }
    invoke('dstu_unwatch', { path }).catch((error) => {
      const vfsError = toVfsError(error, '取消监听失败', { path });
      console.warn(LOG_PREFIX, 'unwatch() failed:', vfsError.toDetailedMessage());
    });
  };
}

/**
 * 批量删除资源（移到回收站）
 *
 * [FIX-D002] 改为"后失效"策略（先操作后端，成功后再失效缓存）
 *
 * 修复原因：
 * - 原策略"先失效缓存后操作"存在问题：如果后端操作失败，缓存已被清空无法恢复
 * - 新策略确保只有操作成功后才失效缓存，失败时缓存保持一致性
 */
export async function deleteMany(paths: string[]): Promise<Result<number>> {
  try {
    // 1. 执行批量删除（先操作后端）
    const result = await invoke<number>('dstu_delete_many', { paths });

    // 2. [FIX-D002] Invalidate cache after operation succeeds
    // Collect node IDs, use path as fallback if get fails
    const nodeIds = await collectNodeIdsForInvalidation(paths);
    if (nodeIds.length > 0) {
      await invalidateMultipleCachesWithLogging(nodeIds, 'deleteMany[post]');
    }

    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '批量删除资源失败', { paths });
    console.error(LOG_PREFIX, 'deleteMany() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 批量恢复已删除的资源
 *
 * [FIX-D002] 改为"后失效"策略（先操作后端，成功后再失效缓存）
 *
 * 修复原因：
 * - 原策略"先失效缓存后操作"存在问题：如果后端操作失败，缓存已被清空无法恢复
 * - 新策略确保只有操作成功后才失效缓存，失败时缓存保持一致性
 */
export async function restoreMany(paths: string[]): Promise<Result<number>> {
  try {
    // 1. 执行批量恢复（先操作后端）
    const result = await invoke<number>('dstu_restore_many', { paths });

    // 2. [FIX-D002] Invalidate cache after operation succeeds
    // Collect node IDs, use path as fallback if get fails
    const nodeIds = await collectNodeIdsForInvalidation(paths);
    if (nodeIds.length > 0) {
      await invalidateMultipleCachesWithLogging(nodeIds, 'restoreMany[post]');
    }

    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '批量恢复资源失败', { paths });
    console.error(LOG_PREFIX, 'restoreMany() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 批量移动资源
 *
 * [FIX-D002] 改为"后失效"策略（先操作后端，成功后再失效缓存）
 *
 * 修复原因：
 * - 原策略"先失效缓存后操作"存在问题：如果后端操作失败，缓存已被清空无法恢复
 * - 新策略确保只有操作成功后才失效缓存，失败时缓存保持一致性
 */
export async function moveMany(paths: string[], destFolder: string): Promise<Result<number>> {
  try {
    // 1. 执行批量移动（先操作后端）
    // 使用 dest_folder 参数名以匹配后端 snake_case 命名
    const result = await invoke<number>('dstu_move_many', { paths, dest_folder: destFolder });

    // 2. [FIX-D002] Invalidate cache after operation succeeds
    // Collect node IDs, use path as fallback if get fails
    const nodeIds = await collectNodeIdsForInvalidation(paths);
    if (nodeIds.length > 0) {
      await invalidateMultipleCachesWithLogging(nodeIds, 'moveMany[post]');
    }

    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '批量移动资源失败', { paths, destFolder });
    console.error(LOG_PREFIX, 'moveMany() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 在文件夹内搜索
 */
export async function searchInFolder(
  folderId: string | null,
  query: string,
  options?: DstuListOptions
): Promise<Result<DstuNode[]>> {
  try {
    // 使用 folder_id 参数名以匹配后端 snake_case 命名
    const result = await invoke<DstuNode[]>('dstu_search_in_folder', {
      folder_id: folderId,
      query,
      options,
    });
    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '文件夹内搜索失败', { folderId, query, options });
    console.error(LOG_PREFIX, 'searchInFolder() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 恢复已删除的资源
 *
 * [FIX-D003] 添加缓存失效
 */
export async function restore(path: string): Promise<Result<DstuNode>> {
  try {
    const result = await invoke<DstuNode>('dstu_restore', { path });
    
    // [FIX-D003] Invalidate cache after restore succeeds
    if (result?.id) {
      invalidateCacheWithLogging(result.id, 'restore[post]');
    }
    
    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '恢复资源失败', { path });
    console.error(LOG_PREFIX, 'restore() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 永久删除资源
 *
 * [FIX-D003] 添加缓存失效
 */
export async function purge(path: string): Promise<Result<void>> {
  try {
    // 在删除前提取 ID 用于缓存失效
    const nodeId = extractSourceIdFromPath(path);
    
    await invoke<void>('dstu_purge', { path });
    
    // [FIX-D003] Invalidate cache after purge succeeds
    if (nodeId) {
      invalidateCacheWithLogging(nodeId, 'purge[post]');
    }
    
    return ok(undefined);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '永久删除资源失败', { path });
    console.error(LOG_PREFIX, 'purge() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 列出已删除的资源（回收站）
 */
export async function listDeleted(
  resourceType: string,
  limit?: number,
  offset?: number
): Promise<Result<DstuNode[]>> {
  try {
    const result = await invoke<DstuNode[]>('dstu_list_deleted', {
      resourceType,
      limit,
      offset,
    });
    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '列出已删除资源失败', { resourceType, limit, offset });
    console.error(LOG_PREFIX, 'listDeleted() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 清空回收站（永久删除指定类型的所有已删除资源）
 */
export async function purgeAll(resourceType: string): Promise<Result<number>> {
  try {
    const result = await invoke<number>('dstu_purge_all', {
      resourceType,
    });
    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, '清空回收站失败', { resourceType });
    console.error(LOG_PREFIX, 'purgeAll() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

// ============================================================================
// 导出统一 API 对象（兼容旧接口）
// ============================================================================

export const dstu = {
  list,
  get,
  create,
  update,
  delete: deleteResource,
  move,
  rename,
  copy,
  search,
  getContent,
  setMetadata,
  setFavorite,
  watch,
  deleteMany,
  restoreMany,
  moveMany,
  searchInFolder,
  restore,
  purge,
  listDeleted,
  purgeAll,
};

export type DstuApiResult = typeof dstu;
