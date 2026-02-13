/**
 * 题目集模块 DSTU 适配器
 *
 * 提供题目集模块从旧 API 迁移到 DSTU API 的适配层。
 * 
 * 注意：题目集的业务操作（OCR、卡片更新、错题关联）仍需使用原有 API，
 * 因为这些涉及复杂业务逻辑和跨模块操作（irec 不在 VFS 范围内）。
 *
 * @see 22-VFS与DSTU访达协议层改造任务分配.md Prompt 10
 */

import { dstu } from '../api';
import { pathUtils } from '../utils/pathUtils';
import type { DstuNode, DstuListOptions } from '../types';
import { Result, VfsError, ok, err, reportError, toVfsError } from '@/shared/result';
import type { ExamSheetSessionDetail } from '@/utils/tauriApi';

// ============================================================================
// 配置
// ============================================================================

const LOG_PREFIX = '[ExamDSTU]';

// ============================================================================
// 类型定义（与旧 API 兼容）
// ============================================================================

/**
 * 题目集会话摘要（用于列表显示）
 * @deprecated 请使用 DstuNode，此类型仅用于兼容
 */
export interface ExamSheetSessionSummary {
  id: string;
  exam_name?: string | null;
  created_at: string;
  updated_at: string;
  temp_id?: string | null;
  status: string;
  metadata?: ExamSheetSessionMetadata | null;
  linked_mistake_ids?: string[] | null;
}

export interface ExamSheetSessionMetadata {
  instructions?: string | null;
  tags?: string[] | null;
  page_count?: number | null;
  question_count?: number | null;
  raw_model_response?: unknown;
}

export interface ExamSheetSession {
  id: string;
  name: string;
  status: string;
  total_questions: number;
  analyzed_questions: number;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// 类型转换
// ============================================================================

/**
 * 将 DstuNode 转换为 ExamSheetSession
 */
export function dstuNodeToExamSession(node: DstuNode): ExamSheetSession {
  const meta = node.metadata || {};
  return {
    id: node.id,
    name: node.name,
    status: (meta.status as string) || 'pending',
    total_questions: (meta.totalQuestions as number) || 0,
    analyzed_questions: (meta.analyzedQuestions as number) || 0,
    created_at: new Date(node.createdAt).toISOString(),
    updated_at: new Date(node.updatedAt).toISOString(),
  };
}

/**
 * 将 DstuNode 转换为 ExamSheetSessionSummary（兼容旧 API）
 */
export function dstuNodeToExamSummary(node: DstuNode): ExamSheetSessionSummary {
  const meta = node.metadata || {};
  return {
    id: node.id,
    exam_name: node.name || null,
    created_at: new Date(node.createdAt).toISOString(),
    updated_at: new Date(node.updatedAt).toISOString(),
    temp_id: (meta.tempId as string) || null,
    status: (meta.status as string) || 'pending',
    metadata: {
      page_count: (meta.pageCount as number) || null,
      question_count: (meta.questionCount as number) || null,
      tags: (meta.tags as string[]) || null,
    },
    linked_mistake_ids: (meta.linkedMistakeIds as string[]) || null,
  };
}

/**
 * 将 ExamSheetSession 转换为 DstuNode
 */
export function examSessionToDstuNode(session: ExamSheetSession): DstuNode {
  return {
    id: session.id,
    sourceId: session.id,
    path: `/${session.id}`,
    name: session.name,
    type: 'exam',
    size: 0,
    createdAt: new Date(session.created_at).getTime(),
    updatedAt: new Date(session.updated_at).getTime(),
    // resourceId 和 resourceHash 从后端获取，前端适配器暂不填
    previewType: 'exam',
    metadata: {
      status: session.status,
      totalQuestions: session.total_questions,
      analyzedQuestions: session.analyzed_questions,
    },
  };
}

// ============================================================================
// 适配器实现
// ============================================================================

/**
 * 题目集 DSTU 适配器
 */
export const examDstuAdapter = {
  /**
   * 列出题目集（返回 DstuNode）
   */
  async listExams(options?: DstuListOptions): Promise<Result<DstuNode[], VfsError>> {
    const path = '/';
    console.log(LOG_PREFIX, 'listExams via DSTU:', path, 'typeFilter: exam');
    const result = await dstu.list(path, { ...options, typeFilter: 'exam' });
    if (!result.ok) {
      reportError(result.error, 'List question sets');
    }
    return result;
  },

  /**
   * 列出题目集会话（返回兼容旧 API 的 ExamSheetSessionSummary）
   * 用于题目集工作台的历史列表
   */
  async listExamSessions(options?: DstuListOptions): Promise<Result<ExamSheetSessionSummary[], VfsError>> {
    const result = await this.listExams(options);
    if (!result.ok) {
      return result;
    }
    return ok(result.value.map(dstuNodeToExamSummary));
  },

  /**
   * 获取题目集详情
   */
  async getExam(examId: string): Promise<Result<DstuNode | null, VfsError>> {
    const path = `/${examId}`;
    console.log(LOG_PREFIX, 'getExam via DSTU:', path);
    const result = await dstu.get(path);
    if (!result.ok) {
      reportError(result.error, 'Get question set detail');
    }
    return result;
  },

  /**
   * 删除题目集
   */
  async deleteExam(examId: string): Promise<Result<void, VfsError>> {
    const path = `/${examId}`;
    console.log(LOG_PREFIX, 'deleteExam via DSTU:', path);
    const result = await dstu.delete(path);
    if (!result.ok) {
      reportError(result.error, 'Delete question set');
    }
    return result;
  },

  /**
   * 构建 DSTU 路径
   */
  buildPath: (folderPath: string | null, resourceId: string) => pathUtils.build(folderPath, resourceId),

  /**
   * 解析 DSTU 路径
   */
  parsePath: pathUtils.parse,

  /**
   * 获取完整会话详情（包含 preview 和 cards）
   * 用于 DSTU 模式下的 ExamContentView
   */
  async getSessionDetail(sessionId: string): Promise<Result<ExamSheetSessionDetail | null, VfsError>> {
    try {
      const { TauriAPI } = await import('@/utils/tauriApi');
      const result = await TauriAPI.getExamSheetSessionDetail(sessionId);
      return ok(result);
    } catch (error: unknown) {
      const vfsError = toVfsError(error);
      reportError(vfsError, 'Get question set session detail');
      return err(vfsError);
    }
  },
};

// 重新导出类型以便其他模块使用
export type { ExamSheetSessionDetail } from '@/utils/tauriApi';

// ============================================================================
// React Hook
// ============================================================================

import { useState, useEffect, useCallback } from 'react';

export interface UseExamsDstuOptions {
  autoLoad?: boolean;
  sortBy?: 'name' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

export interface UseExamsDstuReturn {
  exams: DstuNode[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  remove: (examId: string) => Promise<void>;
}

/**
 * 题目集 DSTU Hook
 */
export function useExamsDstu(
  options: UseExamsDstuOptions = {}
): UseExamsDstuReturn {
  const { autoLoad = true, sortBy, sortOrder } = options;

  const [exams, setExams] = useState<DstuNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const result = await examDstuAdapter.listExams({
      sortBy,
      sortOrder,
    });

    setLoading(false);

    if (result.ok) {
      setExams(result.value);
    } else {
      setError(result.error.toUserMessage());
    }
  }, [sortBy, sortOrder]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  const remove = useCallback(
    async (examId: string): Promise<void> => {
      const result = await examDstuAdapter.deleteExam(examId);
      if (result.ok) {
        setExams((prev) => prev.filter((e) => e.id !== examId));
      }
    },
    []
  );

  useEffect(() => {
    if (autoLoad) {
      load();
    }
  }, [autoLoad, load]);

  return {
    exams,
    loading,
    error,
    refresh,
    remove,
  };
}
