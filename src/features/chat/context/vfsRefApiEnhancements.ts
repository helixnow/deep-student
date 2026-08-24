/**
 * VFS 引用 API 增强功能
 *
 * 提供以下增强：
 * - MEDIUM-002: 容量限制
 * - MEDIUM-003: 超时控制
 * - MEDIUM-007: pathCache 更新完整性
 * - MEDIUM-011: 批量查询优化（N+1 问题）
 * - MEDIUM-012: 解析结果缓存
 * - P2: 缓存键注入攻击防护（消毒输入、安全分隔符）
 */

import { invoke } from '@tauri-apps/api/core';
import i18n from '@/i18n';
import type { VfsResourceRef, ResolvedResource } from './vfsRefTypes';
import { ok, err, toVfsError, type Result, VfsErrorCode, VfsError } from '@/shared/result';
import { withTimeout } from '@/utils/concurrency';

const LOG_PREFIX = '[VfsRefApiEnhancements]';
const IS_VITEST = typeof process !== 'undefined' && Boolean(process.env?.VITEST);

function debugLog(...args: unknown[]): void {
  if (!IS_VITEST) console.log(...args);
}

function debugWarn(...args: unknown[]): void {
  if (!IS_VITEST) console.warn(...args);
}

function debugError(...args: unknown[]): void {
  if (!IS_VITEST) console.error(...args);
}

// ============================================================================
// 常量配置
// ============================================================================

/** 上下文资源最大数量（MEDIUM-002） */
export const MAX_CONTEXT_RESOURCES = 50;

/** 默认超时时间（毫秒）（MEDIUM-003） */
export const DEFAULT_TIMEOUT_MS = 30000;

/** 资源解析超时时间（毫秒） */
export const RESOLVE_TIMEOUT_MS = 30000;

/** 批量查询超时时间（毫秒） */
export const BATCH_QUERY_TIMEOUT_MS = 60000;

// ============================================================================
// LRU 缓存实现（MEDIUM-012修复）
// ============================================================================

/**
 * 缓存项
 */
interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

/**
 * LRU 缓存（Least Recently Used）
 *
 * 用于缓存资源解析结果，减少重复解析
 *
 * 特性：
 * - LRU 淘汰策略：优先删除最久未使用的项
 * - TTL 过期机制：超过存活时间自动失效
 * - 主动清理：定时清理过期项，防止内存泄漏
 * - 容量限制：超过上限时淘汰旧项
 */
export class LRUCache<K, V> {
  private cache: Map<K, CacheEntry<V>>;
  private maxSize: number;
  private ttl: number; // Time To Live（毫秒）
  private cleanupInterval: number | null = null; // 清理定时器ID
  private readonly CLEANUP_INTERVAL = 60 * 1000; // 每分钟清理一次

  constructor(maxSize: number, ttl: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttl = ttl;

    // 启动主动清理定时器
    this.startCleanup();
  }

  /**
   * 启动定时清理过期项
   *
   * 在浏览器环境中启动后台定时器，定期清理过期缓存
   */
  private startCleanup(): void {
    // 单测环境禁用后台定时器，避免大量用例创建多个 LRUCache 实例导致定时器泄漏/内存膨胀
    if (IS_VITEST) {
      return;
    }

    // 仅在浏览器环境中启动定时器
    if (typeof window !== 'undefined') {
      this.cleanupInterval = window.setInterval(() => {
        this.cleanupExpired();
      }, this.CLEANUP_INTERVAL);

      debugLog(LOG_PREFIX, 'LRU缓存清理定时器已启动，间隔:', this.CLEANUP_INTERVAL, 'ms');
    }
  }

  /**
   * 清理过期的缓存项
   *
   * P2-008修复：限制单次清理数量以避免O(n)开销过大
   * - 最多清理100个过期项
   * - 如果还有更多过期项，下次清理继续处理
   *
   * ★ MEDIUM-001修复：添加累积检测和额外清理
   * - 如果过期项累积超过200个，触发额外清理
   *
   * @returns 清理的项数
   */
  private cleanupExpired(): number {
    const now = Date.now();
    const keysToDelete: K[] = [];
    const MAX_CLEANUP_PER_CYCLE = 100; // P2-008: 限制单次清理数量
    let totalExpired = 0; // ★ MEDIUM-001: 统计总过期项数量

    // 收集过期的键（最多100个）
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        totalExpired++; // ★ MEDIUM-001: 计数所有过期项
        if (keysToDelete.length < MAX_CLEANUP_PER_CYCLE) {
          keysToDelete.push(key);
        }
      }
    }

    // 批量删除
    for (const key of keysToDelete) {
      this.cache.delete(key);
    }

    if (keysToDelete.length > 0) {
      const hasMore = keysToDelete.length >= MAX_CLEANUP_PER_CYCLE;
      debugLog(
        LOG_PREFIX,
        'LRU缓存自动清理完成:',
        keysToDelete.length,
        '个过期项',
        '剩余:',
        this.cache.size,
        '项',
        hasMore ? '(可能还有更多过期项，下次继续)' : ''
      );
    }

    // ★ MEDIUM-001修复: 如果过期项累积过多，触发额外清理
    const remaining = totalExpired - keysToDelete.length;
    if (remaining > 200) {
      debugWarn(
        LOG_PREFIX,
        `过期项累积过多（${remaining}），触发额外清理`
      );
      // 延迟1秒后再次清理，避免阻塞主线程
      setTimeout(() => this.cleanupExpired(), 1000);
    }

    return keysToDelete.length;
  }

  /**
   * 获取缓存值
   */
  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    // 检查是否过期
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return undefined;
    }

    // LRU：更新访问时间（删除并重新插入以移到末尾）
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  /**
   * 设置缓存值
   */
  set(key: K, value: V): void {
    // 如果已存在，先删除（为了更新位置）
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // 如果缓存已满，删除最旧的项（Map的第一个项）
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    // 添加新项
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
    });
  }

  /**
   * 删除缓存项
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 获取缓存大小
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * 使指定前缀的缓存失效
   *
   * @param prefix 前缀字符串
   * @returns 失效的缓存项数量
   */
  invalidatePrefix(prefix: string): number {
    let count = 0;
    const keysToDelete: K[] = [];

    for (const key of this.cache.keys()) {
      if (String(key).startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
      count++;
    }

    return count;
  }

  /**
   * 销毁缓存并清理资源
   *
   * 停止定时器并清空所有缓存项
   * 注意：在组件卸载或不再需要缓存时应调用此方法
   */
  destroy(): void {
    // 停止清理定时器
    if (this.cleanupInterval !== null) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      debugLog(LOG_PREFIX, 'LRU缓存清理定时器已停止');
    }

    // 清空缓存
    this.cache.clear();
    debugLog(LOG_PREFIX, 'LRU缓存已销毁');
  }
}

// ============================================================================
// 缓存键生成工具（P2修复：防止缓存键注入攻击）
// ============================================================================

/**
 * 消毒 sourceId，防止注入攻击
 *
 * sourceId 格式: note_xxx, tb_xxx, fld_xxx, exam_xxx, tr_xxx, essay_xxx, img_xxx, att_xxx
 * 安全策略：只允许字母、数字、下划线、连字符
 *
 * @param sourceId 原始资源ID
 * @returns 消毒后的资源ID
 *
 * @security 防止缓存键注入攻击
 * - 检测到非法字符时，替换为下划线
 * - 记录警告日志但不暴露原始输入内容
 *
 * @internal 仅供内部使用
 */
export function sanitizeSourceId(sourceId: string): string {
  // ★ CRITICAL-005修复: 快速路径 - 检查是否符合常见合法ID格式
  // 格式: <前缀>_<数字或字母数字组合>
  // 例如: note_123, tb_abc456, exam_test1, retrieval_xyz
  const len = sourceId.length;
  if (len >= 5 && len <= 255) { // 扩大长度范围从 64 到 255
    // 检查是否以合法前缀开头
    const hasValidPrefix =
      sourceId.startsWith('note_') ||
      sourceId.startsWith('tb_') ||
      sourceId.startsWith('fld_') ||
      sourceId.startsWith('exam_') ||
      sourceId.startsWith('tr_') ||
      sourceId.startsWith('essay_') ||
      sourceId.startsWith('img_') ||
      sourceId.startsWith('att_') ||
      sourceId.startsWith('retrieval_'); // 新增 retrieval 前缀

    if (hasValidPrefix) {
      // 快速检查:只包含字母数字下划线
      let isValid = true;
      for (let i = 0; i < len; i++) {
        const code = sourceId.charCodeAt(i);
        // 允许: a-z (97-122), A-Z (65-90), 0-9 (48-57), _ (95), - (45)
        if (
          !(
            (code >= 97 && code <= 122) || // a-z
            (code >= 65 && code <= 90) || // A-Z
            (code >= 48 && code <= 57) || // 0-9
            code === 95 || // _
            code === 45 // -
          )
        ) {
          isValid = false;
          break;
        }
      }
      if (isValid) {
        return sourceId; // 快速返回,无需正则验证
      }
    }
  }

  // 慢速路径:完整正则验证(仅在可疑情况下执行)
  if (!/^[a-zA-Z0-9_-]+$/.test(sourceId)) {
    debugWarn(LOG_PREFIX, '检测到可疑的 sourceId，已进行消毒处理');
    // 移除非法字符，替换为下划线
    return sourceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  }
  return sourceId;
}

/**
 * 消毒 hash，防止注入攻击
 *
 * hash 格式: 64位十六进制 SHA-256
 * 安全策略：只允许小写十六进制字符（a-f, 0-9）
 *
 * @param hash 原始哈希值
 * @returns 消毒后的哈希值
 *
 * @security 防止缓存键注入攻击
 * - 检测到非法字符时，移除并转小写
 * - 限制长度为64字符
 * - 记录警告日志但不暴露原始输入内容
 *
 * @internal 仅供内部使用
 */
export function sanitizeHash(hash: string): string {
  // ★ HIGH-008修复: 快速路径 - 检查标准SHA-256哈希格式，允许大写十六进制
  // 标准格式: 64位十六进制字符（支持大小写）
  if (hash.length === 64) {
    // 快速检查:只包含十六进制字符（大小写均可）
    let isValidHex = true;
    for (let i = 0; i < 64; i++) {
      const code = hash.charCodeAt(i);
      // 允许: a-f (97-102), A-F (65-70), 0-9 (48-57)
      if (!(
        (code >= 97 && code <= 102) || // a-f
        (code >= 65 && code <= 70) ||  // A-F
        (code >= 48 && code <= 57)     // 0-9
      )) {
        isValidHex = false;
        break;
      }
    }
    if (isValidHex) {
      return hash.toLowerCase(); // 统一转为小写
    }
  }

  // 慢速路径:完整正则验证(仅在可疑情况下执行)
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    debugWarn(LOG_PREFIX, '检测到可疑的 hash，已进行消毒处理');
    // 移除非法字符并转小写，限制长度
    return hash.replace(/[^a-fA-F0-9]/g, '').toLowerCase().slice(0, 64);
  }
  return hash.toLowerCase();
}

/**
 * 生成安全的缓存键
 *
 * 格式：sourceId||resourceHash||injectModesKey
 * 使用双管道符 (||) 作为分隔符，降低冲突风险
 *
 * 原因：
 * 1. 同一个 sourceId 可能有多个版本，需要使用 hash 区分
 * 2. 同一个资源可能有不同的注入模式，需要使用 injectModes 区分
 * 3. 防止缓存键注入攻击（例如：sourceId 中包含 : 字符导致键冲突）
 *
 * @param sourceId 资源ID
 * @param hash 资源哈希值
 * @param injectModes 可选的注入模式（用于图片/PDF 的不同注入方式）
 * @returns 缓存键（格式：sourceId||hash||injectModesKey）
 *
 * @security 防止缓存键注入攻击
 * - 对 sourceId 和 hash 进行消毒处理
 * - 使用不太可能出现在 ID 中的分隔符 (||)
 * - 确保缓存键的唯一性和安全性
 *
 * @example
 * ```typescript
 * // 正常情况（无注入模式）
 * makeCacheKey('note_123', 'abc...def') // => 'note_123||abc...def||_'
 *
 * // 带注入模式
 * makeCacheKey('att_123', 'abc', { pdf: ['image', 'text'] }) // => 'att_123||abc||pdf:image,text'
 *
 * // 攻击向量被阻止
 * makeCacheKey('note||malicious', 'abc') // => 'note__malicious||abc||_' (|| 被替换为 __)
 * ```
 */
export function makeCacheKey(
  sourceId: string, 
  hash: string,
  injectModes?: { image?: string[]; pdf?: string[] }
): string {
  // 1. 消毒输入，防止注入攻击
  const sanitizedSourceId = sanitizeSourceId(sourceId);
  const sanitizedHash = sanitizeHash(hash);

  // 2. 生成注入模式键
  let injectModesKey = '_'; // 默认无模式
  if (injectModes) {
    const parts: string[] = [];
    if (injectModes.image && injectModes.image.length > 0) {
      parts.push(`image:${injectModes.image.sort().join(',')}`);
    }
    if (injectModes.pdf && injectModes.pdf.length > 0) {
      parts.push(`pdf:${injectModes.pdf.sort().join(',')}`);
    }
    if (parts.length > 0) {
      injectModesKey = parts.join(';');
    }
  }

  // 3. 使用安全分隔符（双管道符不太可能出现在合法ID中）
  return `${sanitizedSourceId}||${sanitizedHash}||${injectModesKey}`;
}

// ============================================================================
// 全局缓存实例（MEDIUM-012修复）
// ============================================================================

/**
 * 资源解析结果缓存（TTL 5分钟，最多缓存100条）
 *
 * 缓存键格式：sourceId||resourceHash（支持多版本资源）
 *
 * P2-006修复：直接缓存 ResolvedResource 而非数组，减少内存开销
 * - 之前: LRUCache<string, ResolvedResource[]>
 * - 现在: LRUCache<string, ResolvedResource>
 *
 * 生命周期：
 * - 应用启动时自动创建
 * - 每分钟自动清理过期项
 * - 应用关闭时无需手动销毁（浏览器会自动清理）
 */
export const resolveCache = new LRUCache<string, ResolvedResource>(100, 5 * 60 * 1000);

/**
 * 路径缓存（TTL 10分钟，最多缓存200条）
 *
 * 生命周期：
 * - 应用启动时自动创建
 * - 每分钟自动清理过期项
 * - 应用关闭时无需手动销毁（浏览器会自动清理）
 */
export const pathCache = new LRUCache<string, string>(200, 10 * 60 * 1000);

// ============================================================================
// 容量检查（MEDIUM-002修复）
// ============================================================================

/**
 * 检查资源数量是否超限
 *
 * @param count 当前资源数量
 * @param maxCount 最大允许数量
 * @returns Result - 超限时返回错误
 */
export function checkResourceCapacity(
  count: number,
  maxCount: number = MAX_CONTEXT_RESOURCES
): Result<void, VfsError> {
  if (count > maxCount) {
    return err(
      new VfsError(
        VfsErrorCode.CAPACITY_EXCEEDED,
        i18n.t('chat_module:vfs_inject.capacity_exceeded', {
          defaultValue: '资源数量超限：当前 {{count}}，最大 {{maxCount}}',
          count,
          maxCount,
        }),
        false,
        { count, maxCount }
      )
    );
  }
  return ok(undefined);
}

/**
 * 获取资源引用数量
 *
 * @param sourceIds 资源ID列表
 * @returns 资源数量
 */
export function getResourceCount(sourceIds: string[]): number {
  return sourceIds.length;
}

// ============================================================================
// 批量查询优化（MEDIUM-011修复）
// ============================================================================

/**
 * 批量获取资源（带超时和缓存）
 *
 * 优化：
 * - 使用缓存减少重复查询（基于 sourceId:hash 键）
 * - 批量调用后端减少 N+1 查询
 * - 添加超时保护
 *
 * @param refs 资源引用列表（包含 sourceId 和 resourceHash）
 * @returns sourceId -> ResolvedResource 映射
 */
export async function batchGetResources(
  refs: VfsResourceRef[]
): Promise<Result<Map<string, ResolvedResource>, VfsError>> {
  debugLog(LOG_PREFIX, 'batchGetResources:', refs.length, 'resources');

  if (refs.length === 0) {
    return ok(new Map());
  }

  // 检查容量
  const capacityCheck = checkResourceCapacity(refs.length);
  if (!capacityCheck.ok) {
    // 🔧 P3修复：使用非空断言确保 TypeScript 正确推断错误类型
    return err(capacityCheck.error!);
  }

  // 1. 检查缓存（使用 sourceId:hash:injectModes 作为键）
  // ★ 2026-02 修复：缓存键需要包含 injectModes，否则不同注入模式会返回相同的缓存结果
  const result = new Map<string, ResolvedResource>();
  const uncachedRefs: VfsResourceRef[] = [];
  const cacheHits: string[] = [];
  const cacheMisses: string[] = [];

  for (const ref of refs) {
    const cacheKey = makeCacheKey(ref.sourceId, ref.resourceHash, ref.injectModes);
    const cached = resolveCache.get(cacheKey);
    // P2-006修复：直接获取 ResolvedResource，无需访问数组
    if (cached) {
      result.set(ref.sourceId, cached);
      cacheHits.push(cacheKey);
      debugLog(LOG_PREFIX, '✅ 缓存命中:', cacheKey);
    } else {
      uncachedRefs.push(ref);
      cacheMisses.push(cacheKey);
      debugLog(LOG_PREFIX, '❌ 缓存未命中:', cacheKey);
    }
  }

  // 2. 输出缓存统计
  const hitRate = refs.length > 0 ? ((cacheHits.length / refs.length) * 100).toFixed(1) : '0.0';
  debugLog(
    LOG_PREFIX,
    `缓存统计: 总数=${refs.length}, 命中=${cacheHits.length}, 未命中=${cacheMisses.length}, 命中率=${hitRate}%`
  );

  // 3. 如果全部命中缓存，直接返回
  if (uncachedRefs.length === 0) {
    debugLog(LOG_PREFIX, '🎉 全部从缓存加载:', result.size, '个资源');
    return ok(result);
  }

  // 4. 批量查询未缓存的资源
  debugLog(LOG_PREFIX, '🔄 开始从后端获取:', uncachedRefs.length, '个资源');

  try {
    const startTime = performance.now();

    // 带超时的批量查询
    const timeoutResult = await withTimeout(
      invoke<ResolvedResource[]>('vfs_resolve_resource_refs', { refs: uncachedRefs }),
      BATCH_QUERY_TIMEOUT_MS,
      '批量查询资源'
    );

    if (!timeoutResult.ok) {
      // 🔧 P3修复：使用非空断言确保 TypeScript 正确推断错误类型
      return err(timeoutResult.error!);
    }

    const resolved = timeoutResult.value;
    const duration = performance.now() - startTime;

    // 5. 更新缓存和结果（使用 sourceId||hash||injectModes 作为键）
    // ★ 2026-02 修复：缓存键需要包含 injectModes
    // 创建 sourceId -> ref 的映射，用于获取原始 ref 的 injectModes
    const refsBySourceId = new Map(uncachedRefs.map(r => [r.sourceId, r]));
    
    let cachedCount = 0;
    for (const resource of resolved) {
      if (resource.found) {
        // P2-006修复：直接缓存 resource，不包装成数组
        // 从原始 ref 获取 injectModes（后端返回的 resource 不包含 injectModes）
        const originalRef = refsBySourceId.get(resource.sourceId);
        const cacheKey = makeCacheKey(resource.sourceId, resource.resourceHash, originalRef?.injectModes);
        resolveCache.set(cacheKey, resource);
        result.set(resource.sourceId, resource);
        debugLog(LOG_PREFIX, '💾 已缓存:', cacheKey, 'injectModes:', originalRef?.injectModes);
        cachedCount++;
      }
    }

    debugLog(
      LOG_PREFIX,
      `✅ 后端查询完成: 返回=${resolved.length}, 找到=${result.size}, 新缓存=${cachedCount}, 耗时=${duration.toFixed(0)}ms`
    );
    return ok(result);
  } catch (caughtError: unknown) {
    debugError(LOG_PREFIX, '❌ 批量查询失败:', caughtError);
    return err(toVfsError(
      caughtError,
      i18n.t('chat_module:vfs_inject.batch_query_failed', { defaultValue: '批量查询资源失败' }),
      { refs: uncachedRefs }
    ));
  }
}

/**
 * 根据 sourceId 推断资源类型
 */
function inferTypeFromSourceId(sourceId: string): 'note' | 'textbook' | 'exam' | 'essay' | 'translation' | 'image' | 'file' {
  if (sourceId.startsWith('note_')) return 'note';
  if (sourceId.startsWith('tb_')) return 'textbook';
  if (sourceId.startsWith('exam_')) return 'exam';
  if (sourceId.startsWith('tr_')) return 'translation';
  if (sourceId.startsWith('essay_')) return 'essay';
  if (sourceId.startsWith('img_')) return 'image';
  if (sourceId.startsWith('att_')) return 'file';
  return 'file';
}

// ============================================================================
// 缓存失效（MEDIUM-007修复）
// ============================================================================

/**
 * 使指定资源的缓存失效
 *
 * 在资源更新/删除后调用，确保缓存一致性
 *
 * 注意：由于缓存键格式为 sourceId||hash，需要删除该 sourceId 的所有版本
 *
 * @param sourceId 资源ID
 * @returns 失效的缓存项数量
 *
 * @security 使用消毒后的 sourceId 构建前缀，防止缓存污染
 */
export function invalidateResourceCache(sourceId: string): number {
  // 消毒输入，防止注入攻击
  const sanitizedSourceId = sanitizeSourceId(sourceId);

  // 使用前缀匹配删除所有版本的缓存（格式：sourceId||）
  const count = resolveCache.invalidatePrefix(`${sanitizedSourceId}||`);
  pathCache.delete(sanitizedSourceId);
  debugLog(LOG_PREFIX, 'Cache invalidated:', sanitizedSourceId, 'count:', count);
  return count;
}

/**
 * 使路径缓存失效（文件夹移动后调用）
 *
 * @param folderId 文件夹ID
 * @returns 失效的缓存项数量
 */
export function invalidatePathCache(folderId: string): number {
  const count = pathCache.invalidatePrefix(folderId);
  debugLog(LOG_PREFIX, 'Path cache invalidated:', folderId, 'count:', count);
  return count;
}

/**
 * 清空所有缓存（保留定时器）
 */
export function clearAllCaches(): void {
  resolveCache.clear();
  pathCache.clear();
  debugLog(LOG_PREFIX, 'All caches cleared');
}

/**
 * 销毁所有缓存（停止定时器，释放资源）
 *
 * 应在应用退出前调用，防止内存泄漏
 * 注意：销毁后缓存不可再用，除非重新创建
 */
export function destroyAllCaches(): void {
  resolveCache.destroy();
  pathCache.destroy();
  debugLog(LOG_PREFIX, 'All caches destroyed');
}

// ============================================================================
// 自动清理：在浏览器页面卸载时销毁缓存
// ============================================================================
if (typeof window !== 'undefined' && !IS_VITEST) {
  // 使用 beforeunload 事件确保页面关闭时清理定时器
  window.addEventListener('beforeunload', () => {
    destroyAllCaches();
  });

  // 监听 Tauri 窗口关闭事件（如果在 Tauri 环境中）
  // 这会在窗口关闭前触发，确保资源被正确释放
  if ('__TAURI_INTERNALS__' in window) {
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('tauri://close-requested', () => {
        destroyAllCaches();
      }).catch((e) => {
        debugWarn(LOG_PREFIX, 'Failed to listen for close event:', e);
      });
    }).catch(() => {
      // 忽略导入错误（可能不在 Tauri 环境中）
    });
  }
}

// ============================================================================
// 缓存统计
// ============================================================================

/**
 * 获取缓存统计信息
 */
export function getCacheStats() {
  return {
    resolveCache: {
      size: resolveCache.size,
      maxSize: 100,
    },
    pathCache: {
      size: pathCache.size,
      maxSize: 200,
    },
  };
}

/**
 * 检查指定资源是否在缓存中
 *
 * @param sourceId 资源ID
 * @param hash 资源哈希值
 * @param injectModes 可选的注入模式
 * @returns 是否存在于缓存中
 */
export function isCached(
  sourceId: string, 
  hash: string,
  injectModes?: { image?: string[]; pdf?: string[] }
): boolean {
  const cacheKey = makeCacheKey(sourceId, hash, injectModes);
  const cached = resolveCache.get(cacheKey);
  // P2-006修复：直接检查 cached 是否存在，无需检查数组长度
  return cached !== undefined;
}
