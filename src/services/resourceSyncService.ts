/**
 * 资源同步服务
 *
 * 封装后端同步 API，将原模块数据（笔记、题目集、教材页面）同步到 resources.db。
 *
 * 核心原则：
 * - 懒同步：引用到对话时才触发同步
 * - 基于 hash 去重：相同内容不重复创建资源
 * - 回写原表：同步后回写 resource_id + content_hash 到原表
 *
 * 后端命令（由 Prompt 3 实现）：
 * - resource_sync_note - 笔记同步
 * - resource_sync_exam - 题目集同步
 * - resource_sync_textbook_pages - 教材页面同步
 * - resource_check_sync_needed - 检查是否需要同步
 *
 * @module services/resourceSyncService
 * @see 文档 20-统一资源库与访达层改造任务分配.md - Prompt 8
 */

import { invoke } from '@tauri-apps/api/core';
import i18next from 'i18next';
import { getErrorMessage } from '../utils/errorUtils';
import { debugLog } from '../debug-panel/debugMasterSwitch';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

// ── 类型定义 ──

/**
 * 同步结果
 *
 * 遵循文档 20 数据契约 2.4
 */
export interface SyncResult {
  /** 资源 ID（格式：res_{nanoid(10)}） */
  resourceId: string;

  /** 内容哈希（SHA-256） */
  hash: string;

  /** 是否为新创建（false 表示复用已有资源） */
  isNew: boolean;
}

/**
 * 页面范围
 *
 * 用于 syncTextbookPages 方法
 */
export interface PageRange {
  /** 起始页码 */
  start: number;

  /** 结束页码 */
  end: number;
}

/**
 * 检查同步状态响应
 *
 * 与后端 CheckSyncNeededResponse 对齐
 */
export interface CheckSyncNeededResponse {
  /** 是否需要同步 */
  needsSync: boolean;

  /** 已有资源 ID（如果存在） */
  existingResourceId?: string;

  /** 已有内容哈希（如果存在） */
  existingHash?: string;
}

/**
 * 资源来源类型
 */
export type SourceType = 'note' | 'exam' | 'textbook';

/**
 * 资源同步服务接口
 */
export interface ResourceSyncService {
  /**
   * 同步笔记到 resources.db
   *
   * 从 notes.db 读取笔记内容，创建资源并回写 resource_id。
   *
   * @param noteId 笔记 ID
   * @returns 同步结果
   */
  syncNote(noteId: string): Promise<SyncResult>;

  /**
   * 同步题目集识别结果到 resources.db
   *
   * 从 exam_sheet_sessions.preview_json 读取内容，创建资源并回写。
   *
   * @param sessionId 题目集识别会话 ID
   * @returns 同步结果
   */
  syncExam(sessionId: string): Promise<SyncResult>;

  /**
   * 同步教材页面到 resources.db
   *
   * 将教材渲染后的页面内容创建为资源。
   *
   * @param textbookId 教材 ID
   * @param pageRange 页面范围（可选，默认全部）
   * @returns 同步结果数组（每页一个）
   */
  syncTextbookPages(textbookId: string, pageRange?: PageRange): Promise<SyncResult[]>;

  /**
   * 检查是否需要同步
   *
   * 比较原表中的 content_hash 与当前内容 hash，判断是否需要重新同步。
   *
   * @param sourceType 资源来源类型
   * @param sourceId 原始记录 ID
   * @param currentHash 当前内容哈希（可选，用于比较）
   * @returns 同步状态响应
   */
  checkSyncNeeded(
    sourceType: SourceType,
    sourceId: string,
    currentHash?: string
  ): Promise<CheckSyncNeededResponse>;
}

// ── 日志前缀 ──

const LOG_PREFIX = '[ResourceSyncService]';

// ── Mock 实现 ──

/**
 * 生成随机 ID（模拟 nanoid）
 */
function generateMockId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 10; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * 生成 Mock 哈希值
 */
function generateMockHash(content: string): string {
  // 简单的字符串哈希（仅用于 Mock）
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(64, '0');
}

/**
 * Mock 同步缓存（模拟去重）
 */
const mockSyncCache = new Map<string, SyncResult>();

/**
 * Mock 资源同步服务实现
 *
 * 用于后端 Prompt 3 完成前的并行开发。
 */
class MockResourceSyncService implements ResourceSyncService {
  async syncNote(noteId: string): Promise<SyncResult> {
    console.log(LOG_PREFIX, '[Mock] syncNote:', noteId);

    // 检查缓存
    const cacheKey = `note:${noteId}`;
    const cached = mockSyncCache.get(cacheKey);
    if (cached) {
      console.log(LOG_PREFIX, '[Mock] syncNote: reusing cached resource');
      return { ...cached, isNew: false };
    }

    // 模拟同步延迟
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 生成 Mock 结果
    const result: SyncResult = {
      resourceId: `res_${generateMockId()}`,
      hash: generateMockHash(`note:${noteId}:${Date.now()}`),
      isNew: true,
    };

    mockSyncCache.set(cacheKey, result);
    console.log(LOG_PREFIX, '[Mock] syncNote: created new resource', result);
    return result;
  }

  async syncExam(sessionId: string): Promise<SyncResult> {
    console.log(LOG_PREFIX, '[Mock] syncExam:', sessionId);

    // 检查缓存
    const cacheKey = `exam:${sessionId}`;
    const cached = mockSyncCache.get(cacheKey);
    if (cached) {
      console.log(LOG_PREFIX, '[Mock] syncExam: reusing cached resource');
      return { ...cached, isNew: false };
    }

    // 模拟同步延迟
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 生成 Mock 结果
    const result: SyncResult = {
      resourceId: `res_${generateMockId()}`,
      hash: generateMockHash(`exam:${sessionId}:${Date.now()}`),
      isNew: true,
    };

    mockSyncCache.set(cacheKey, result);
    console.log(LOG_PREFIX, '[Mock] syncExam: created new resource', result);
    return result;
  }

  async syncTextbookPages(textbookId: string, pageRange?: PageRange): Promise<SyncResult[]> {
    const rangeStr = pageRange ? `${pageRange.start}-${pageRange.end}` : 'all';
    console.log(LOG_PREFIX, '[Mock] syncTextbookPages:', textbookId, 'range:', rangeStr);

    // 生成缓存键
    const cacheKey = `textbook:${textbookId}:${rangeStr}`;

    // 检查缓存
    const cached = mockSyncCache.get(cacheKey);
    if (cached) {
      console.log(LOG_PREFIX, '[Mock] syncTextbookPages: reusing cached resource');
      return [{ ...cached, isNew: false }];
    }

    // 模拟同步延迟
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 生成 Mock 结果
    const result: SyncResult = {
      resourceId: `res_${generateMockId()}`,
      hash: generateMockHash(`textbook:${textbookId}:${rangeStr}:${Date.now()}`),
      isNew: true,
    };

    mockSyncCache.set(cacheKey, result);
    console.log(LOG_PREFIX, '[Mock] syncTextbookPages: created new resource', result);
    return [result];
  }

  async checkSyncNeeded(
    sourceType: SourceType,
    sourceId: string,
    currentHash?: string
  ): Promise<CheckSyncNeededResponse> {
    console.log(LOG_PREFIX, '[Mock] checkSyncNeeded:', sourceType, sourceId, 'hash:', currentHash);

    // Mock 逻辑：如果缓存中存在，则不需要同步
    const cacheKey = `${sourceType}:${sourceId}`;
    const cached = mockSyncCache.get(cacheKey);

    if (cached) {
      console.log(LOG_PREFIX, '[Mock] checkSyncNeeded: found cached, no sync needed');
      return {
        needsSync: false,
        existingResourceId: cached.resourceId,
        existingHash: cached.hash,
      };
    }

    console.log(LOG_PREFIX, '[Mock] checkSyncNeeded: no cache, sync needed');
    return { needsSync: true };
  }
}

// ── 真实 Tauri API 实现 ──

/**
 * 后端返回的同步结果（与后端 SyncResult 对齐，使用 camelCase）
 */
interface BackendSyncResult {
  resourceId: string;
  hash: string;
  isNew: boolean;
}

/**
 * 真实的 Tauri 资源同步服务实现
 *
 * 调用后端 Prompt 3 实现的命令。
 */
class TauriResourceSyncService implements ResourceSyncService {
  async syncNote(noteId: string): Promise<SyncResult> {
    try {
      console.log(LOG_PREFIX, 'syncNote:', noteId);

      const result = await invoke<BackendSyncResult>('resource_sync_note', {
        noteId,
      });

      console.log(LOG_PREFIX, 'syncNote result:', result);
      return {
        resourceId: result.resourceId,
        hash: result.hash,
        isNew: result.isNew,
      };
    } catch (error: unknown) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'syncNote failed:', errorMsg);
      throw new Error(i18next.t('sync:resource.sync_note_failed', { error: errorMsg }));
    }
  }

  async syncExam(sessionId: string): Promise<SyncResult> {
    try {
      console.log(LOG_PREFIX, 'syncExam:', sessionId);

      const result = await invoke<BackendSyncResult>('resource_sync_exam', {
        sessionId,
      });

      console.log(LOG_PREFIX, 'syncExam result:', result);
      return {
        resourceId: result.resourceId,
        hash: result.hash,
        isNew: result.isNew,
      };
    } catch (error: unknown) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'syncExam failed:', errorMsg);
      throw new Error(i18next.t('sync:resource.sync_exam_failed', { error: errorMsg }));
    }
  }

  async syncTextbookPages(textbookId: string, pageRange?: PageRange): Promise<SyncResult[]> {
    try {
      console.log(LOG_PREFIX, 'syncTextbookPages:', textbookId, 'pageRange:', pageRange);

      // 后端期望 page_range 为 tuple (u32, u32)
      const pageRangeTuple = pageRange ? [pageRange.start, pageRange.end] : null;

      const results = await invoke<BackendSyncResult[]>('resource_sync_textbook_pages', {
        textbookId,
        pageRange: pageRangeTuple,
      });

      console.log(LOG_PREFIX, 'syncTextbookPages result:', results);
      return results.map((r) => ({
        resourceId: r.resourceId,
        hash: r.hash,
        isNew: r.isNew,
      }));
    } catch (error: unknown) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'syncTextbookPages failed:', errorMsg);
      throw new Error(i18next.t('sync:resource.sync_textbook_pages_failed', { error: errorMsg }));
    }
  }

  async checkSyncNeeded(
    sourceType: SourceType,
    sourceId: string,
    currentHash?: string
  ): Promise<CheckSyncNeededResponse> {
    try {
      console.log(LOG_PREFIX, 'checkSyncNeeded:', sourceType, sourceId, 'currentHash:', currentHash);

      // 后端使用 resourceType 而不是 sourceType
      const result = await invoke<CheckSyncNeededResponse>('resource_check_sync_needed', {
        resourceType: sourceType,
        sourceId,
        currentHash,
      });

      console.log(LOG_PREFIX, 'checkSyncNeeded result:', result);
      return result;
    } catch (error: unknown) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'checkSyncNeeded failed:', errorMsg);
      throw new Error(i18next.t('sync:resource.check_sync_needed_failed', { error: errorMsg }));
    }
  }
}

// ── API 导出 ──

/**
 * 检测是否在 Tauri 环境中
 */
function isTauriEnvironment(): boolean {
  try {
    return typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  } catch {
    return false;
  }
}

/**
 * 真实 Tauri 资源同步服务单例
 */
export const tauriResourceSyncService: ResourceSyncService = new TauriResourceSyncService();

/**
 * 资源同步服务单例
 *
 * 直接使用真实 API（无 Mock）
 */
export const resourceSyncService: ResourceSyncService = tauriResourceSyncService;

// ── 便捷方法 ──

/**
 * 同步笔记到 resources.db（便捷方法）
 *
 * @param noteId 笔记 ID
 * @returns 同步结果
 */
export async function syncNote(noteId: string): Promise<SyncResult> {
  return resourceSyncService.syncNote(noteId);
}

/**
 * 同步题目集到 resources.db（便捷方法）
 *
 * @param sessionId 题目集识别会话 ID
 * @returns 同步结果
 */
export async function syncExam(sessionId: string): Promise<SyncResult> {
  return resourceSyncService.syncExam(sessionId);
}

/**
 * 同步教材页面到 resources.db（便捷方法）
 *
 * @param textbookId 教材 ID
 * @param pageRange 页面范围（可选，默认全部）
 * @returns 同步结果数组
 */
export async function syncTextbookPages(
  textbookId: string,
  pageRange?: PageRange
): Promise<SyncResult[]> {
  return resourceSyncService.syncTextbookPages(textbookId, pageRange);
}

/**
 * 检查是否需要同步（便捷方法）
 *
 * @param sourceType 资源来源类型
 * @param sourceId 原始记录 ID
 * @param currentHash 当前内容哈希
 * @returns 同步状态响应
 */
export async function checkSyncNeeded(
  sourceType: SourceType,
  sourceId: string,
  currentHash: string
): Promise<CheckSyncNeededResponse> {
  return resourceSyncService.checkSyncNeeded(sourceType, sourceId, currentHash);
}

// ── 资源创建（统一写入 VFS，不再写入 resources.db） ──

/**
 * 创建资源参数
 */
export interface CreateResourceParams {
  /** 资源类型 */
  resourceType: string;
  /** 资源内容 */
  data: string;
  /** 原始数据 ID（可选） */
  sourceId?: string;
  /** 元数据（可选） */
  metadata?: Record<string, unknown>;
}

/**
 * 在 VFS 中创建或复用资源
 *
 * 兼容旧调用的轻量包装，内部已切换到 VFS API。
 *
 * @param params 创建参数
 * @returns 同步结果
 */
export async function createResource(params: CreateResourceParams): Promise<SyncResult> {
  try {
    console.log(LOG_PREFIX, 'createResource(vfs):', params.resourceType, 'sourceId:', params.sourceId);

    // 统一写入 vfs.db
    const result = await invoke<{ resourceId: string; hash: string; isNew: boolean }>('vfs_create_or_reuse', {
      params: {
        type: params.resourceType,
        data: params.data,
        sourceId: params.sourceId,
        metadata: params.metadata,
        subject: null,
      },
    });

    console.log(LOG_PREFIX, 'createResource result:', result);
    return {
      resourceId: result.resourceId,
      hash: result.hash,
      isNew: result.isNew,
    };
  } catch (error: unknown) {
    const errorMsg = getErrorMessage(error);
    console.error(LOG_PREFIX, 'createResource failed:', errorMsg);
    throw new Error(i18next.t('sync:resource.create_resource_failed', { error: errorMsg }));
  }
}

// ── Mock 缓存管理（仅用于测试） ──

/**
 * 清除 Mock 同步缓存（仅用于测试）
 */
export function clearMockSyncCache(): void {
  mockSyncCache.clear();
  console.log(LOG_PREFIX, '[Mock] cache cleared');
}

/**
 * 获取 Mock 同步缓存大小（仅用于测试）
 */
export function getMockSyncCacheSize(): number {
  return mockSyncCache.size;
}
