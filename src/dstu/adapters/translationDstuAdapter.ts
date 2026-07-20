/**
 * 翻译模块 DSTU 适配器
 *
 * 提供翻译模块从旧 API 迁移到 DSTU API 的适配层。
 *
 * @see 22-VFS与DSTU访达协议层改造任务分配.md Prompt 10
 */

import { dstu } from '../api';
import { pathUtils } from '../utils/pathUtils';
import type { DstuNode, DstuListOptions } from '../types';
import type { TranslationHistoryItem } from '@/utils/tauriApi';
import { Result, VfsError, ok, err, reportError, toVfsError } from '@/shared/result';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// 翻译会话类型（DSTU 模式）
// ============================================================================

/**
 * 翻译会话数据结构
 *
 * 用于 Learning Hub 中的翻译资源管理
 */
export interface TranslationSession {
  /** 会话 ID */
  id: string;
  /** 源文本 */
  sourceText: string;
  /** 译文 */
  translatedText: string;
  /** 源语言代码 */
  srcLang: string;
  /** 目标语言代码 */
  tgtLang: string;
  /** 正式度：formal（正式）、casual（随意）、auto（自动） */
  formality: 'formal' | 'casual' | 'auto';
  /** 自定义提示词 */
  customPrompt?: string;
  /** 翻译领域 */
  domain?: string;
  /** 术语表 */
  glossary?: Array<[string, string]>;
  /** 翻译质量评分 (1-5) */
  quality?: number;
  /** 是否收藏 */
  isFavorite?: boolean;
  /** 创建时间（Unix 毫秒） */
  createdAt: number;
  /** 更新时间（Unix 毫秒） */
  updatedAt: number;
}

/**
 * 生成唯一翻译会话 ID
 */
export function generateTranslationId(): string {
  return `tr_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
}

// ============================================================================
// 正文 schema（VFS resources.data）
//
// v1（历史 canonical）：{ "source": "...", "translated": "..." }
// v2（当前）：        { "source": "...", "translated": "...", "meta": {...} }
//
// meta 字段承载会话级翻译设置（语向/正式度/领域/术语表/自定义提示词），
// 解决 set_metadata 后端只落 source/translated 导致这些设置丢失的问题。
// 读取路径向后兼容：无 meta 的 v1 文档、更早的 camelCase/snake_case 变体、
// 以及非 JSON 纯文本正文均可解析。
// ============================================================================

/** 当前正文 schema 版本 */
export const TRANSLATION_CONTENT_SCHEMA_VERSION = 2;

/** 正文 meta 字段（v2）：会话级翻译设置 */
export interface TranslationContentMeta {
  schemaVersion?: number;
  srcLang?: string;
  tgtLang?: string;
  formality?: 'formal' | 'casual' | 'auto';
  domain?: string;
  glossary?: Array<[string, string]>;
  customPrompt?: string;
}

/** 解析后的翻译正文 */
export interface ParsedTranslationContent {
  source: string;
  translated: string;
  /** v2 文档的会话设置；v1/纯文本文档为 null */
  meta: TranslationContentMeta | null;
}

/** 术语表消毒：只接受 [string, string] 二元组数组 */
function sanitizeGlossary(value: unknown): Array<[string, string]> | undefined {
  if (!Array.isArray(value)) return undefined;
  const pairs: Array<[string, string]> = [];
  for (const entry of value) {
    if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
      pairs.push([entry[0], entry[1]]);
    }
  }
  return pairs.length > 0 ? pairs : undefined;
}

/**
 * 解析翻译正文（兼容 v2 / v1 / 历史变体 / 纯文本）
 *
 * - v2：{ source, translated, meta }
 * - v1：{ source, translated }
 * - 历史变体：{ sourceText / source_text, translatedText / translated_text, sourceLang... }
 * - 非 JSON：整体视为译文（与旧 Viewer 行为一致）
 */
export function parseTranslationContent(raw: string): ParsedTranslationContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { source: '', translated: raw, meta: null };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { source: '', translated: raw, meta: null };
  }

  const obj = parsed as Record<string, unknown>;
  const pickString = (...keys: string[]): string => {
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === 'string') return value;
    }
    return '';
  };

  // canonical 键优先，历史 camelCase / snake_case 变体兜底
  const source = pickString('source', 'sourceText', 'source_text');
  const translated = pickString('translated', 'translatedText', 'translated_text');

  let meta: TranslationContentMeta | null = null;
  const rawMeta = obj.meta;
  if (rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta)) {
    const m = rawMeta as Record<string, unknown>;
    meta = {};
    if (typeof m.schemaVersion === 'number') meta.schemaVersion = m.schemaVersion;
    if (typeof m.srcLang === 'string' && m.srcLang) meta.srcLang = normalizeLangCode(m.srcLang);
    if (typeof m.tgtLang === 'string' && m.tgtLang) meta.tgtLang = normalizeLangCode(m.tgtLang);
    if (m.formality === 'formal' || m.formality === 'casual' || m.formality === 'auto') {
      meta.formality = m.formality;
    }
    if (typeof m.domain === 'string' && m.domain) meta.domain = m.domain;
    const glossary = sanitizeGlossary(m.glossary);
    if (glossary) meta.glossary = glossary;
    if (typeof m.customPrompt === 'string' && m.customPrompt) meta.customPrompt = m.customPrompt;
  } else {
    // 无 meta 的旧文档：尝试读取历史顶层语言键（早期 Viewer 假定的格式）
    const legacySrc = pickString('sourceLang', 'source_lang');
    const legacyTgt = pickString('targetLang', 'target_lang');
    if (legacySrc || legacyTgt) {
      meta = {};
      if (legacySrc) meta.srcLang = normalizeLangCode(legacySrc);
      if (legacyTgt) meta.tgtLang = normalizeLangCode(legacyTgt);
    }
  }

  return { source, translated, meta };
}

/**
 * 由会话构建 v2 正文 JSON 字符串
 */
export function buildTranslationContent(session: TranslationSession): string {
  const meta: TranslationContentMeta = {
    schemaVersion: TRANSLATION_CONTENT_SCHEMA_VERSION,
    srcLang: session.srcLang,
    tgtLang: session.tgtLang,
    formality: session.formality,
  };
  if (session.domain) meta.domain = session.domain;
  if (session.glossary && session.glossary.length > 0) meta.glossary = session.glossary;
  if (session.customPrompt) meta.customPrompt = session.customPrompt;
  return JSON.stringify({
    source: session.sourceText,
    translated: session.translatedText,
    meta,
  });
}

/**
 * 将解析后的正文合并进 DstuNode.metadata
 *
 * 正文是 SSOT：source/translated 总是覆盖；meta 设置存在时补齐
 * formality/domain/glossary/customPrompt 与语向。
 */
function mergeContentIntoNode(node: DstuNode, parsed: ParsedTranslationContent): DstuNode {
  const metadata: Record<string, unknown> = {
    ...node.metadata,
    sourceText: parsed.source,
    translatedText: parsed.translated,
  };
  if (parsed.meta) {
    if (parsed.meta.srcLang) metadata.srcLang = parsed.meta.srcLang;
    if (parsed.meta.tgtLang) metadata.tgtLang = parsed.meta.tgtLang;
    if (parsed.meta.formality) metadata.formality = parsed.meta.formality;
    if (parsed.meta.domain) metadata.domain = parsed.meta.domain;
    if (parsed.meta.glossary) metadata.glossary = parsed.meta.glossary;
    if (parsed.meta.customPrompt) metadata.customPrompt = parsed.meta.customPrompt;
  }
  return { ...node, metadata };
}

// ============================================================================
// 配置
// ============================================================================

const LOG_PREFIX = '[TranslationDSTU]';

// ============================================================================
// 类型转换
// ============================================================================

/**
 * 向后兼容：旧版 'zh' 代码映射为 'zh-CN'
 */
function normalizeLangCode(code: string): string {
  if (code === 'zh') return 'zh-CN';
  return code;
}

/**
 * 将 DstuNode 转换为 TranslationSession
 */
export function dstuNodeToTranslationSession(node: DstuNode): TranslationSession {
  const meta = node.metadata || {};
  return {
    id: node.id,
    sourceText: (meta.sourceText as string) || '',
    translatedText: (meta.translatedText as string) || '',
    srcLang: normalizeLangCode((meta.srcLang as string) || 'auto'),
    tgtLang: normalizeLangCode((meta.tgtLang as string) || 'zh-CN'),
    formality: (meta.formality as 'formal' | 'casual' | 'auto') || 'auto',
    customPrompt: meta.customPrompt as string | undefined,
    domain: meta.domain as string | undefined,
    glossary: meta.glossary as Array<[string, string]> | undefined,
    quality: meta.qualityRating as number | undefined,
    isFavorite: Boolean(meta.isFavorite),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

/**
 * 将 DstuNode 转换为 TranslationHistoryItem
 */
export function dstuNodeToTranslationItem(node: DstuNode): TranslationHistoryItem {
  const meta = node.metadata || {};
  return {
    id: node.id,
    source_text: (meta.sourceText as string) || '',
    translated_text: (meta.translatedText as string) || '',
    // ★ 与 session 路径统一 normalize（zh → zh-CN），默认值也对齐
    src_lang: normalizeLangCode((meta.srcLang as string) || 'auto'),
    tgt_lang: normalizeLangCode((meta.tgtLang as string) || 'zh-CN'),
    prompt_used: meta.promptUsed as string | null,
    created_at: new Date(node.createdAt).toISOString(),
    is_favorite: Boolean(meta.isFavorite),
    quality_rating: meta.qualityRating as number | null,
  };
}

/**
 * 将 TranslationHistoryItem 转换为 DstuNode
 */
export function translationItemToDstuNode(item: TranslationHistoryItem): DstuNode {
  return {
    id: item.id,
    sourceId: item.id,
    path: `/${item.id}`,
    name: item.source_text.substring(0, 50) + (item.source_text.length > 50 ? '...' : ''),
    type: 'translation',
    size: item.source_text.length + item.translated_text.length,
    createdAt: new Date(item.created_at).getTime(),
    updatedAt: new Date(item.created_at).getTime(),
    // resourceId 和 resourceHash 从后端获取，前端适配器暂不填
    previewType: 'markdown',
    metadata: {
      sourceText: item.source_text,
      translatedText: item.translated_text,
      srcLang: item.src_lang,
      tgtLang: item.tgt_lang,
      promptUsed: item.prompt_used,
      isFavorite: item.is_favorite,
      qualityRating: item.quality_rating,
    },
  };
}

// ============================================================================
// 适配器实现
// ============================================================================

/**
 * 翻译 DSTU 适配器
 */
export const translationDstuAdapter = {
  /**
   * 列出翻译历史
   */
  async listTranslations(options?: {
    offset?: number;
    limit?: number;
    search?: string;
  }): Promise<Result<{ items: DstuNode[]; total: number }, VfsError>> {
    const path = '/';
    console.log(LOG_PREFIX, 'listTranslations via DSTU:', path, 'typeFilter: translation');
    const result = await dstu.list(path, {
      offset: options?.offset,
      limit: options?.limit,
      search: options?.search,
      typeFilter: 'translation',
    });
    if (!result.ok) {
      reportError(result.error, 'List translation history');
      return err(result.error);
    }
    // ★ 后端 list 不返回真实 total，此处返回「已见下界」（offset + 本页条数）：
    // 至少保证跨页单调递增，不再把「本页长度」冒充总数
    return ok({
      items: result.value,
      total: (options?.offset ?? 0) + result.value.length,
    });
  },

  /**
   * 获取翻译详情
   *
   * ★ 正文是 SSOT：在 dstu.get 之后读取正文 JSON，把 source/translated 与
   * v2 meta 中的会话设置（formality/domain/glossary/customPrompt/语向）合并进
   * node.metadata，保证读取路径能看到已持久化的设置。
   * getContent 失败时降级返回原节点，不阻塞主读取路径。
   */
  async getTranslation(translationId: string): Promise<Result<DstuNode | null, VfsError>> {
    const path = `/${translationId}`;
    console.log(LOG_PREFIX, 'getTranslation via DSTU:', path);
    const result = await dstu.get(path);
    if (!result.ok) {
      reportError(result.error, 'Get translation detail');
      return result;
    }
    const contentResult = await dstu.getContent(path);
    if (contentResult.ok && typeof contentResult.value === 'string' && contentResult.value) {
      return ok(mergeContentIntoNode(result.value, parseTranslationContent(contentResult.value)));
    }
    if (!contentResult.ok) {
      console.warn(LOG_PREFIX, 'getTranslation: getContent 失败，降级返回节点 metadata:', contentResult.error.message);
    }
    return result;
  },

  /**
   * 获取完整翻译会话（含正文 meta 设置）
   *
   * ★ 新增可选 API：等价于 getTranslation + dstuNodeToTranslationSession，
   * 供需要一步拿到 TranslationSession 的调用方使用。
   */
  async getTranslationSession(
    translationId: string
  ): Promise<Result<TranslationSession | null, VfsError>> {
    const result = await translationDstuAdapter.getTranslation(translationId);
    if (!result.ok) {
      return err(result.error);
    }
    return ok(result.value ? dstuNodeToTranslationSession(result.value) : null);
  },

  /**
   * 删除翻译
   */
  async deleteTranslation(translationId: string): Promise<Result<void, VfsError>> {
    const path = `/${translationId}`;
    console.log(LOG_PREFIX, 'deleteTranslation via DSTU:', path);
    const result = await dstu.delete(path);
    if (!result.ok) {
      reportError(result.error, 'Delete translation');
    }
    return result;
  },

  /**
   * 切换收藏状态
   *
   * ★ MEDIUM-006 优化：支持传入当前状态，避免额外的 get 请求
   */
  async toggleFavorite(translationId: string, currentFavorite?: boolean): Promise<Result<boolean, VfsError>> {
    const path = `/${translationId}`;
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
        reportError(getResult.error, 'Get translation');
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
  async setFavorite(translationId: string, isFavorite: boolean): Promise<Result<void, VfsError>> {
    const path = `/${translationId}`;
    console.log(LOG_PREFIX, 'setFavorite via DSTU:', path, 'isFavorite:', isFavorite);

    const result = await dstu.setFavorite(path, isFavorite);
    if (!result.ok) {
      reportError(result.error, 'Set favorite');
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

  /**
   * 创建翻译记录（DSTU 模式）
   *
   * ★ 后端 create 只落 {source, translated} 与语向列，会话级设置
   * （formality/domain/glossary/customPrompt）通过第二步 v2 正文补写持久化。
   * 补写失败不回滚创建（记录已存在），仅上报错误。
   */
  async createTranslation(session: TranslationSession): Promise<Result<DstuNode, VfsError>> {
    const path = '/';
    console.log(LOG_PREFIX, 'createTranslation via DSTU:', path);
    const result = await dstu.create(path, {
      type: 'translation',
      name: session.sourceText.substring(0, 50) + (session.sourceText.length > 50 ? '...' : ''),
      metadata: {
        sourceText: session.sourceText,
        translatedText: session.translatedText,
        srcLang: session.srcLang,
        tgtLang: session.tgtLang,
        formality: session.formality,
        customPrompt: session.customPrompt,
        // ★ B1 修复：create 路径不再丢弃 domain/glossary
        domain: session.domain,
        glossary: session.glossary,
        qualityRating: session.quality,
        isFavorite: session.isFavorite || false,
      },
    });
    if (!result.ok) {
      reportError(result.error, 'Create translation record');
      return result;
    }

    const node = result.value;
    const bodyResult = await dstu.update(
      `/${node.id}`,
      buildTranslationContent({ ...session, id: node.id }),
      'translation'
    );
    if (!bodyResult.ok) {
      reportError(bodyResult.error, 'Persist translation settings');
      return ok(node);
    }
    return ok(mergeContentIntoNode(bodyResult.value, {
      source: session.sourceText,
      translated: session.translatedText,
      meta: null,
    }));
  },

  /**
   * 更新翻译记录（DSTU 模式）
   *
   * 两步写入（签名与旧版兼容）：
   * 1. dstu.setMetadata：兼容路径 —— 后端写回 {source, translated} 正文、
   *    收藏/评分，并刷新 translations.updated_at；
   * 2. dstu.update：整体重写 v2 正文（含 meta 设置），持久化
   *    srcLang/tgtLang/formality/domain/glossary/customPrompt。
   *    第 1 步的正文写入不含 meta，因此第 2 步必须在其之后执行。
   * 任一步失败返回 err（调用方重试会重放两步，幂等）。
   */
  async updateTranslation(session: TranslationSession): Promise<Result<void, VfsError>> {
    const path = `/${session.id}`;
    console.log(LOG_PREFIX, 'updateTranslation via DSTU:', path);
    const metaResult = await dstu.setMetadata(path, {
      sourceText: session.sourceText,
      translatedText: session.translatedText,
      srcLang: session.srcLang,
      tgtLang: session.tgtLang,
      formality: session.formality,
      customPrompt: session.customPrompt,
      domain: session.domain,
      glossary: session.glossary,
      qualityRating: session.quality,
      isFavorite: session.isFavorite,
    });
    if (!metaResult.ok) {
      reportError(metaResult.error, 'Update translation record');
      return metaResult;
    }

    const bodyResult = await dstu.update(path, buildTranslationContent(session), 'translation');
    if (!bodyResult.ok) {
      reportError(bodyResult.error, 'Persist translation settings');
      return err(bodyResult.error);
    }
    return ok(undefined);
  },
};

// ============================================================================
// React Hook
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';

export interface UseTranslationsDstuOptions {
  autoLoad?: boolean;
  limit?: number;
  search?: string;
}

export interface UseTranslationsDstuReturn {
  translations: DstuNode[];
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
 * 翻译 DSTU Hook
 */
export function useTranslationsDstu(
  options: UseTranslationsDstuOptions = {}
): UseTranslationsDstuReturn {
  const { autoLoad = true, limit = 20, search } = options;

  const [translations, setTranslations] = useState<DstuNode[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  // ★ HIGH-A006 修复：使用 ref 进行原子的并发防护检查
  const loadingRef = useRef(false);
  // ★ HIGH-A005 修复：使用 ref 存储 offset 避免 stale closure
  const offsetRef = useRef(0);

  const load = useCallback(async (reset = false) => {
    // ★ HIGH-A006 修复：使用 ref 进行原子检查，避免竞态条件
    if (loadingRef.current) {
      console.warn(LOG_PREFIX, 'Load already in progress, skipping');
      return;
    }

    loadingRef.current = true;
    setLoading(true);
    setError(null);

    const currentOffset = reset ? 0 : offsetRef.current;
    const result = await translationDstuAdapter.listTranslations({
      offset: currentOffset,
      limit,
      search,
    });

    loadingRef.current = false;
    setLoading(false);

    if (result.ok) {
      const data = result.value.items;

      if (reset) {
        setTranslations(data);
        // ★ MEDIUM-007 修复：添加边界保护
        const dataLength = Math.max(0, Math.floor(data?.length || 0));
        offsetRef.current = dataLength;
        setOffset(dataLength);
      } else {
        setTranslations((prev) => {
          // ★ MEDIUM-007 修复：检测重复数据
          const existingIds = new Set(prev.map(t => t.id));
          const newItems = data.filter(t => !existingIds.has(t.id));
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
    const result = await translationDstuAdapter.deleteTranslation(id);
    if (result.ok) {
      setTranslations((prev) => prev.filter((t) => t.id !== id));
      setTotal((prev) => prev - 1);
    }
  }, []);

  const toggleFav = useCallback(async (id: string): Promise<void> => {
    // ★ MEDIUM-006 优化：使用本地状态获取当前值，避免额外请求
    const currentTranslation = translations.find(t => t.id === id);
    const currentFavorite = currentTranslation?.metadata?.isFavorite as boolean | undefined;

    // 乐观更新 UI
    const newFavorite = !currentFavorite;
    setTranslations((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, metadata: { ...t.metadata, isFavorite: newFavorite } }
          : t
      )
    );

    // 后台执行实际请求
    const result = await translationDstuAdapter.toggleFavorite(id, currentFavorite);
    if (!result.ok) {
      // 请求失败，回滚更新
      setTranslations((prev) =>
        prev.map((t) =>
          t.id === id
            ? { ...t, metadata: { ...t.metadata, isFavorite: currentFavorite } }
            : t
        )
      );
    }
  }, [translations]);

  // ★ HIGH-A005 修复：正确添加所有必要的依赖，避免 stale closure
  useEffect(() => {
    if (autoLoad) {
      setTranslations([]);
      offsetRef.current = 0;
      setOffset(0);
      setHasMore(true);
      load(true);
    }
  }, [autoLoad, search, load]);

  return {
    translations,
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
