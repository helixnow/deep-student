/**
 * 引用选择器 - API 层
 *
 * 提供真实 API 的统一接口
 *
 * 改造说明（Prompt D）：
 * - 原使用 `learning_hub_list_*` 命令已废弃
 * - 现改用 DSTU 访达协议层 API
 */

import { dstu } from '@/dstu';
import type { DstuNode, DstuListOptions } from '@/dstu/types';
import type { TextbookListItem, ExamSessionListItem } from './types';
import { Result, ok, err, VfsError } from '@/shared/result';

// ============================================================================
// 环境检测
// ============================================================================

/**
 * 检测是否在 Tauri 环境中
 */
function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// ============================================================================
// DSTU API 实现
// ============================================================================

/**
 * 将 DstuNode 转换为 TextbookListItem
 */
function dstuNodeToTextbook(node: DstuNode): TextbookListItem {
  return {
    id: node.id,
    title: node.name,
    updatedAt: node.updatedAt,
  };
}

/**
 * 将 DstuNode 转换为 ExamSessionListItem
 */
function dstuNodeToExamSession(node: DstuNode): ExamSessionListItem {
  const metadata = node.metadata as Record<string, unknown> | undefined;
  return {
    id: node.id,
    examName: metadata?.examName as string | undefined,
    status: (metadata?.status as 'pending' | 'completed') || 'pending',
    createdAt: node.createdAt,
  };
}

async function realListTextbooks(search?: string): Promise<Result<TextbookListItem[], VfsError>> {
  // 使用 DSTU API 列出所有科目下的教材
  const options: DstuListOptions = {
    typeFilter: 'textbook',
    search: search || undefined,
  };

  const result = await dstu.list('/', options);
  if (!result.ok) {
    return err(result.error);
  }
  return ok(result.value.map(dstuNodeToTextbook));
}

async function realListExamSessions(
  limit?: number
): Promise<Result<ExamSessionListItem[], VfsError>> {
  // 使用 DSTU API 列出题目集识别会话
  const options: DstuListOptions = {
    typeFilter: 'exam',
    limit: limit ?? 100,
  };

  const result = await dstu.list('/', options);
  if (!result.ok) {
    return err(result.error);
  }
  return ok(result.value.map(dstuNodeToExamSession));
}

// ============================================================================
// 统一导出接口
// ============================================================================

/**
 * 获取教材列表
 *
 * @param search 搜索关键词（可选）
 * @returns Result 包装的教材列表
 */
export async function listTextbooks(search?: string): Promise<Result<TextbookListItem[], VfsError>> {
  if (!isTauriEnvironment()) {
    // 非 Tauri 环境返回空数组
    return ok([]);
  }
  return realListTextbooks(search);
}

/**
 * 获取题目集识别会话列表
 *
 * @param limit 返回数量限制（可选）
 * @returns Result 包装的题目集会话列表
 */
export async function listExamSessions(
  limit?: number
): Promise<Result<ExamSessionListItem[], VfsError>> {
  if (!isTauriEnvironment()) {
    return ok([]);
  }
  return realListExamSessions(limit);
}
