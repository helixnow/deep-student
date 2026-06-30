/**
 * 资源同步服务
 *
 * 统一资源写入入口：将原模块数据创建 / 复用为 VFS 资源。
 *
 * ★ 2026-06-13（第二轮收尾 X7）：移除从未实现的后端同步包装
 * （resource_sync_note / resource_sync_exam / resource_sync_textbook_pages /
 * resource_check_sync_needed，以及配套的 Mock 实现、单例与便捷方法）——
 * Rust 侧从未实现这些命令，前端也无人调用。仅保留仍在使用的 createResource
 * （由 NotesContext 等统一写入 VFS）。
 *
 * @module services/resourceSyncService
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

// ── 日志前缀 ──

const LOG_PREFIX = '[ResourceSyncService]';

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
