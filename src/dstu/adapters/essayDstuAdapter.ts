/**
 * 作文模块 DSTU 适配器
 *
 * 提供作文批改模块从旧 API 迁移到 DSTU API 的适配层。
 *
 * @see 22-VFS与DSTU访达协议层改造任务分配.md Prompt 10
 */

import i18next from 'i18next';
import { dstu } from '../api';
import { pathUtils } from '../utils/pathUtils';
import type { DstuNode, DstuListOptions } from '../types';
import type { GradingSessionListItem, GradingSession, GradingRound as ApiGradingRound } from '@/essay-grading/essayGradingApi';
import { EssayGradingAPI, canonicalizeEssayModeId } from '@/essay-grading/essayGradingApi';
import { Result, VfsError, ok, err, reportError, toVfsError } from '@/shared/result';

// ============================================================================
// 配置
// ============================================================================

const LOG_PREFIX = '[EssayDSTU]';

// ============================================================================
// 类型定义（与旧 API 兼容）
// ============================================================================

export interface EssaySessionItem {
  id: string;
  title: string;
  essay_type: string;
  grade_level: string;
  is_favorite: boolean;
  total_rounds: number;
  latest_input_preview: string | null;
  latest_score: number | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// DSTU 模式类型定义
// ============================================================================

/**
 * 批改轮次数据（DSTU 模式）
 */
export interface DstuGradingRound {
  id: string;
  round_number: number;
  input_text: string;
  grading_result: string;
  overall_score: number | null;
  dimension_scores_json: string | null;
  created_at: number;
}

/**
 * 完整的批改会话数据（DSTU 模式）
 *
 * 用于 Learning Hub 管理和 EssayGradingWorkbench dstuMode
 */
export interface EssayGradingSession {
  id: string;
  title: string;
  inputText: string;
  essayType: string;
  gradeLevel: string;
  modeId: string;
  customPrompt?: string;
  rounds: DstuGradingRound[];
  isFavorite: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * DSTU 模式配置
 */
export interface EssayDstuModeConfig {
  /** 当前会话数据，null 表示新建模式 */
  session: EssayGradingSession | null;
  /** 会话保存回调 */
  onSessionSave?: (session: EssayGradingSession) => Promise<void>;
  /** 新轮次添加回调 */
  onRoundAdd?: (round: DstuGradingRound) => Promise<void>;
  /** ★ 标签页：资源 ID，用于事件定向过滤 */
  resourceId?: string;
}

// ============================================================================
// 类型转换
// ============================================================================

/**
 * 将 DstuNode 转换为 EssaySessionItem
 */
export function dstuNodeToEssaySession(node: DstuNode): EssaySessionItem {
  const meta = node.metadata || {};
  return {
    id: node.id,
    title: node.name,
    essay_type: (meta.essayType as string) || '',
    grade_level: (meta.gradeLevel as string) || '',
    is_favorite: Boolean(meta.isFavorite),
    total_rounds: (meta.totalRounds as number) || 0,
    latest_input_preview: meta.latestInputPreview as string | null,
    latest_score: meta.latestScore as number | null,
    created_at: new Date(node.createdAt).toISOString(),
    updated_at: new Date(node.updatedAt).toISOString(),
  };
}

/**
 * 将 GradingSessionListItem 转换为 DstuNode
 */
export function essaySessionToDstuNode(
  session: GradingSessionListItem
): DstuNode {
  return {
    id: session.id,
    sourceId: session.id,
    path: `/${session.id}`,
    name: session.title || i18next.t('dstu:adapters.essay.untitledEssay'),
    type: 'essay',
    size: session.latest_input_preview?.length || 0,
    createdAt: new Date(session.created_at).getTime(),
    updatedAt: new Date(session.updated_at).getTime(),
    // resourceId 和 resourceHash 从后端获取，前端适配器暂不填
    previewType: 'markdown',
    metadata: {
      essayType: session.essay_type,
      gradeLevel: session.grade_level,
      isFavorite: session.is_favorite,
      totalRounds: session.total_rounds,
      latestInputPreview: session.latest_input_preview,
      latestScore: session.latest_score,
    },
  };
}

/**
 * 将 GradingSession 转换为 DstuNode
 */
export function gradingSessionToDstuNode(
  session: GradingSession
): DstuNode {
  return {
    id: session.id,
    sourceId: session.id,
    path: `/${session.id}`,
    name: session.title || i18next.t('dstu:adapters.essay.untitledEssay'),
    type: 'essay',
    size: 0,
    createdAt: new Date(session.created_at).getTime(),
    updatedAt: new Date(session.updated_at).getTime(),
    // resourceId 和 resourceHash 从后端获取，前端适配器暂不填
    previewType: 'markdown',
    metadata: {
      essayType: session.essay_type,
      gradeLevel: session.grade_level,
      isFavorite: session.is_favorite,
      totalRounds: session.total_rounds,
      customPrompt: session.custom_prompt,
    },
  };
}

// ============================================================================
// 适配器实现
// ============================================================================

/**
 * 作文 DSTU 适配器
 */
export const essayDstuAdapter = {
  /**
   * 列出作文批改会话
   *
   * @param options 列表选项
   */
  async listEssays(
    options?: {
      offset?: number;
      limit?: number;
      search?: string;
    }
  ): Promise<Result<{ items: DstuNode[]; total: number }, VfsError>> {
    const path = '/';
    console.log(LOG_PREFIX, 'listEssays via DSTU:', path, 'typeFilter: essay');
    const result = await dstu.list(path, {
      offset: options?.offset,
      limit: options?.limit,
      search: options?.search,
      typeFilter: 'essay',
    });
    if (!result.ok) {
      reportError(result.error, 'List essay grading sessions');
      return err(result.error);
    }
    return ok({
      items: result.value,
      total: result.value.length,
    });
  },

  /**
   * 获取作文会话详情
   */
  async getEssay(sessionId: string): Promise<Result<DstuNode | null, VfsError>> {
    const path = `/${sessionId}`;
    console.log(LOG_PREFIX, 'getEssay via DSTU:', path);
    const result = await dstu.get(path);
    if (!result.ok) {
      reportError(result.error, 'Get essay session detail');
      return result;
    }
    return ok(result.value);
  },

  /**
   * 删除作文会话
   */
  async deleteEssay(sessionId: string): Promise<Result<void, VfsError>> {
    const path = `/${sessionId}`;
    console.log(LOG_PREFIX, 'deleteEssay via DSTU:', path);
    const result = await dstu.delete(path);
    if (!result.ok) {
      reportError(result.error, 'Delete essay session');
    }
    return result;
  },

  /**
   * 切换收藏状态
   *
   * ★ MEDIUM-006 优化：支持传入当前状态，避免额外的 get 请求
   */
  async toggleFavorite(sessionId: string, currentFavorite?: boolean): Promise<Result<boolean, VfsError>> {
    const path = `/${sessionId}`;
    console.log(LOG_PREFIX, 'toggleFavorite via DSTU:', path);
    console.log(LOG_PREFIX, 'toggleFavorite currentFavorite:', currentFavorite);

    let newFavorite: boolean;

    // 如果提供了当前状态，直接翻转；否则需要先获取
    if (currentFavorite !== undefined) {
      newFavorite = !currentFavorite;
    } else {
      // 先获取当前状态
      const getResult = await dstu.get(path);
      if (!getResult.ok) {
        reportError(getResult.error, 'Get essay session');
        return err(getResult.error);
      }

      newFavorite = !getResult.value?.metadata?.isFavorite;
    }

    // 使用统一的 setFavorite API
    const setResult = await dstu.setFavorite(path, newFavorite);
    if (!setResult.ok) {
      reportError(setResult.error, 'Toggle favorite');
      return err(setResult.error);
    }

    return ok(newFavorite);
  },

  /**
   * 设置收藏状态（直接设置，不需要先获取）
   *
   * ★ MEDIUM-006 新增：提供直接设置收藏状态的方法
   */
  async setFavorite(sessionId: string, isFavorite: boolean): Promise<Result<void, VfsError>> {
    const path = `/${sessionId}`;
    console.log(LOG_PREFIX, 'setFavorite via DSTU:', path, 'isFavorite:', isFavorite);

    const result = await dstu.setFavorite(path, isFavorite);
    if (!result.ok) {
      reportError(result.error, 'Set favorite');
    }
    return result;
  },

  /**
   * 获取完整的会话数据（包含所有轮次）
   *
   * 用于 DSTU 模式下加载会话供 EssayGradingWorkbench 使用
   */
  async getFullSession(sessionId: string): Promise<Result<EssayGradingSession | null, VfsError>> {
    console.log(LOG_PREFIX, 'getFullSession:', sessionId);

    try {
      // EssayGradingAPI.getSession 返回 Promise<GradingSession | null>，不是 Result
      const session = await EssayGradingAPI.getSession(sessionId);

      if (!session) {
        return ok(null);
      }

      // EssayGradingAPI.getRounds 返回 Promise<GradingRound[]>，不是 Result
      const apiRounds = await EssayGradingAPI.getRounds(sessionId);

      const rounds: DstuGradingRound[] = apiRounds.map((r) => ({
        id: r.id,
        round_number: r.round_number,
        input_text: r.input_text,
        grading_result: r.grading_result,
        overall_score: r.overall_score,
        dimension_scores_json: r.dimension_scores_json,
        created_at: new Date(r.created_at).getTime(),
      }));

      const latestRound = rounds[rounds.length - 1];

      // ★ M-047 修复：从 DSTU metadata 中读取 modeId，避免硬编码
      let modeId = 'practice'; // 默认值
      try {
        const nodeResult = await dstu.get(`/${sessionId}`);
        if (nodeResult.ok && nodeResult.value?.metadata?.modeId) {
          modeId = canonicalizeEssayModeId(nodeResult.value.metadata.modeId as string);
        }
      } catch {
        // DSTU 节点获取失败时使用默认值，不阻塞主流程
        console.warn(LOG_PREFIX, 'Failed to read modeId from DSTU metadata, using default');
      }

      return ok({
        id: session.id,
        title: session.title,
        inputText: latestRound?.input_text || '',
        essayType: session.essay_type || '',
        gradeLevel: session.grade_level || '',
        modeId,
        customPrompt: session.custom_prompt || undefined,
        rounds,
        isFavorite: session.is_favorite ?? false,
        createdAt: session.created_at ? new Date(session.created_at).getTime() : Date.now(),
        updatedAt: session.updated_at ? new Date(session.updated_at).getTime() : Date.now(),
      });
    } catch (error: unknown) {
      console.error(LOG_PREFIX, 'getFullSession failed:', error);
      return err(toVfsError(error, 'Get full essay session'));
    }
  },

  /**
   * 创建新会话
   */
  async createSession(
    data: {
      title: string;
      essayType: string;
      gradeLevel: string;
      modeId?: string;
      customPrompt?: string;
    }
  ): Promise<Result<EssayGradingSession, VfsError>> {
    console.log(LOG_PREFIX, 'createSession:', data);
    try {
      // EssayGradingAPI.createSession 返回 Promise<GradingSession>，不是 Result
      const session = await EssayGradingAPI.createSession({
        title: data.title,
        essay_type: data.essayType,
        grade_level: data.gradeLevel,
        custom_prompt: data.customPrompt,
      });

      const modeId = data.modeId ? canonicalizeEssayModeId(data.modeId) : 'practice';

      // ★ M-047 修复：将 modeId 持久化到 DSTU metadata
      try {
        await dstu.setMetadata(`/${session.id}`, {
          essayType: data.essayType,
          gradeLevel: data.gradeLevel,
          customPrompt: data.customPrompt,
          modeId,
        });
      } catch {
        console.warn(LOG_PREFIX, 'Failed to save modeId to DSTU metadata during createSession');
      }

      return ok({
        id: session.id,
        title: session.title,
        inputText: '',
        essayType: session.essay_type,
        gradeLevel: session.grade_level,
        modeId,
        customPrompt: session.custom_prompt || undefined,
        rounds: [],
        isFavorite: session.is_favorite,
        createdAt: new Date(session.created_at).getTime(),
        updatedAt: new Date(session.updated_at).getTime(),
      });
    } catch (error: unknown) {
      console.error(LOG_PREFIX, 'createSession failed:', error);
      return err(toVfsError(error, 'Create essay session'));
    }
  },

  /**
   * 更新会话元数据
   */
  async updateSessionMeta(
    sessionId: string,
    data: Partial<{
      title: string;
      essayType: string;
      gradeLevel: string;
      modeId: string;
      customPrompt: string;
      isFavorite: boolean;
    }>
  ): Promise<Result<void, VfsError>> {
    const path = `/${sessionId}`;
    console.log(LOG_PREFIX, 'updateSessionMeta:', path, data);
    const result = await dstu.setMetadata(path, {
      essayType: data.essayType,
      gradeLevel: data.gradeLevel,
      modeId: data.modeId,        // ★ M-047 修复：持久化 modeId
      customPrompt: data.customPrompt,
      isFavorite: data.isFavorite,
    });
    if (!result.ok) {
      reportError(result.error, 'Update session metadata');
    }
    return result;
  },

  /**
   * 构建 DSTU 路径
   */
  buildPath: (id?: string) => id ? `/${id}` : '/',

  /**
   * 解析 DSTU 路径
   */
  parsePath: pathUtils.parse,
};

// ============================================================================
// React Hook
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';

export interface UseEssaysDstuOptions {
  autoLoad?: boolean;
  limit?: number;
  search?: string;
}

export interface UseEssaysDstuReturn {
  essays: DstuNode[];
  total: number;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
}

/**
 * 作文 DSTU Hook
 */
export function useEssaysDstu(
  options: UseEssaysDstuOptions = {}
): UseEssaysDstuReturn {
  const { autoLoad = true, limit = 20, search } = options;

  const [essays, setEssays] = useState<DstuNode[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  // ★ HIGH-A004 修复：使用 ref 进行原子的并发防护检查
  const loadingRef = useRef(false);
  // ★ HIGH-A003 修复：使用 ref 存储 offset 避免 stale closure
  const offsetRef = useRef(0);

  const load = useCallback(async (reset = false) => {
    // ★ HIGH-A004 修复：使用 ref 进行原子检查，避免竞态条件
    if (loadingRef.current) {
      console.warn(LOG_PREFIX, 'Load already in progress, skipping');
      return;
    }

    loadingRef.current = true;
    setLoading(true);
    setError(null);

    const currentOffset = reset ? 0 : offsetRef.current;
    const result = await essayDstuAdapter.listEssays({
      offset: currentOffset,
      limit,
      search,
    });

    loadingRef.current = false;
    setLoading(false);

    if (result.ok) {
      const data = result.value.items;

      if (reset) {
        setEssays(data);
        // ★ MEDIUM-007 修复：添加边界保护
        const dataLength = Math.max(0, Math.floor(data?.length || 0));
        offsetRef.current = dataLength;
        setOffset(dataLength);
      } else {
        setEssays((prev) => {
          // ★ MEDIUM-007 修复：检测重复数据
          const existingIds = new Set(prev.map(e => e.id));
          const newItems = data.filter(e => !existingIds.has(e.id));
          return [...prev, ...newItems];
        });
        // ★ MEDIUM-007 修复：添加边界检查
        const dataLength = Math.max(0, Math.floor(data?.length || 0));
        const newOffset = offsetRef.current + dataLength;
        // 边界检查
        if (newOffset < 0 || !Number.isFinite(newOffset)) {
          console.error(LOG_PREFIX, `Invalid offset: ${newOffset}, resetting to 0`);
          offsetRef.current = 0;
          setOffset(0);
        } else {
          offsetRef.current = newOffset;
          setOffset(newOffset);
        }
      }

      setTotal(result.value.total);
      setHasMore(data.length >= limit);
    } else {
      setError(result.error.toUserMessage());
    }
  }, [limit, search]);

  const refresh = useCallback(async () => {
    offsetRef.current = 0;
    setOffset(0);
    await load(true);
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loading) return;
    await load(false);
  }, [hasMore, loading, load]);

  const remove = useCallback(async (id: string): Promise<void> => {
    const result = await essayDstuAdapter.deleteEssay(id);
    if (result.ok) {
      setEssays((prev) => prev.filter((e) => e.id !== id));
      setTotal((prev) => prev - 1);
    }
  }, []);

  const toggleFav = useCallback(async (id: string): Promise<void> => {
    // ★ MEDIUM-006 优化：使用本地状态获取当前值，避免额外请求
    const currentEssay = essays.find(e => e.id === id);
    const currentFavorite = currentEssay?.metadata?.isFavorite as boolean | undefined;

    // 乐观更新 UI
    const newFavorite = !currentFavorite;
    setEssays((prev) =>
      prev.map((e) =>
        e.id === id
          ? { ...e, metadata: { ...e.metadata, isFavorite: newFavorite } }
          : e
      )
    );

    // 后台执行实际请求
    const result = await essayDstuAdapter.toggleFavorite(id, currentFavorite);
    if (!result.ok) {
      // 请求失败，回滚更新
      setEssays((prev) =>
        prev.map((e) =>
          e.id === id
            ? { ...e, metadata: { ...e.metadata, isFavorite: currentFavorite } }
            : e
        )
      );
    }
  }, [essays]);

  // ★ HIGH-A003 修复：正确添加所有必要的依赖，避免 stale closure
  useEffect(() => {
    if (autoLoad) {
      setEssays([]);
      offsetRef.current = 0;
      setOffset(0);
      setHasMore(true);
      load(true);
    }
  }, [autoLoad, search, load]);

  return {
    essays,
    total,
    loading,
    error,
    hasMore,
    refresh,
    loadMore,
    remove,
    toggleFavorite: toggleFav,
  };
}
