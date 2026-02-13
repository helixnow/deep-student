/**
 * Learning Hub API - 统一学习资源管理器 API 封装
 *
 * 提供引用节点内容获取功能，支持从不同来源数据库获取内容。
 *
 * 改造说明（Prompt D）：
 * - 原使用 `learning_hub_fetch_content` 命令已废弃
 * - 现改用 DSTU 访达协议层 API（dstu.getContent, dstu.get）
 *
 * @see 21-VFS虚拟文件系统架构设计.md
 * @see 22-VFS与DSTU访达协议层改造任务分配.md Prompt D
 */

import { dstu } from '@/dstu';
import type { DstuNode } from '@/dstu/types';
import { type Result, type VfsError, err } from '@/shared/result';
import { uint8ArrayToBase64 } from '@/utils/base64FileUtils';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 引用节点来源数据库
 *
 * 覆盖当前 reference.ts 中使用的 chat_v2 / exam_sessions。
 */
export type SourceDatabase = 'notes' | 'textbooks' | 'chat_v2' | 'exam_sessions' | 'translations' | 'essays' | 'attachments' | 'mindmaps';

/**
 * 引用节点类型
 * 参考文档 18 的数据契约
 */
export interface ReferenceNode {
  /** 引用 ID，格式: ref_{nanoid(8)} */
  id: string;
  /** 来源数据库 */
  sourceDb: SourceDatabase;
  /** 原生数据 ID */
  nativeId: string;
  /** 显示标题（缓存） */
  title: string;
  /** 预览类型（兼容旧 card，并支持新版文档/音视频） */
  previewType:
    | 'markdown'
    | 'image'
    | 'pdf'
    | 'card'
    | 'exam'
    | 'docx'
    | 'xlsx'
    | 'pptx'
    | 'text'
    | 'audio'
    | 'video'
    | 'mindmap'
    | 'none';
  /** 创建时间 */
  createdAt: number;
  /** 最后访问时间 */
  lastAccessedAt: number;
}

/**
 * 获取引用内容的元数据
 */
export interface ContentMetadata {
  title?: string;
  contentType?: string;
  [key: string]: unknown;
}

/**
 * 获取引用内容的参数
 */
export interface FetchContentParams {
  /** 来源数据库 */
  sourceDb: SourceDatabase;
  /** 原生数据 ID（对应后端 source_id） */
  sourceId: string;
}

// ============================================================================
// 配置与日志
// ============================================================================

const LOG_PREFIX = '[LearningHubAPI]';

/**
 * 构建 DSTU 路径
 *
 * @param sourceDb 来源数据库
 * @param sourceId 资源 ID
 * @returns DSTU 路径
 */
function buildPathForSource(
  _sourceDb: SourceDatabase,
  sourceId: string
): string {
  return `/${sourceId}`;
}

// ============================================================================
// API 实现
// ============================================================================

/**
 * 获取引用节点的内容
 *
 * 使用 DSTU API 获取内容：
 * - 调用 dstu.getContent() 获取实际内容
 * - 调用 dstu.get() 获取元数据（标题等）
 *
 * @param params 获取参数
 * @returns Result包装的内容和元数据
 */
export async function fetchReferenceContent(
  params: FetchContentParams
): Promise<Result<{ content: string; metadata: ContentMetadata }, VfsError>> {
  const { sourceDb, sourceId } = params;

  console.log(LOG_PREFIX, 'Fetching content via DSTU API:', sourceDb, sourceId);

  // 构建 DSTU 路径
  const dstuPath = buildPathForSource(sourceDb, sourceId);
  console.log(LOG_PREFIX, 'DSTU path:', dstuPath);

  // 并行获取内容和元数据
  const [contentResult, nodeResult] = await Promise.all([
    dstu.getContent(dstuPath),
    dstu.get(dstuPath),
  ]);

  if (!contentResult.ok) {
    console.error(LOG_PREFIX, 'Failed to fetch content via DSTU:', contentResult.error.message);
    return err(contentResult.error);
  }

  if (!nodeResult.ok) {
    console.error(LOG_PREFIX, 'Failed to fetch node via DSTU:', nodeResult.error.message);
    return err(nodeResult.error);
  }

  // 处理内容
  let contentStr: string;
  if (contentResult.value instanceof Blob) {
    // 二进制内容（如 PDF），转为 base64
    const arrayBuffer = await contentResult.value.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    contentStr = uint8ArrayToBase64(bytes);
  } else {
    contentStr = contentResult.value;
  }

  return {
    ok: true,
    value: {
      content: contentStr,
      metadata: {
        title: nodeResult.value?.name,
        contentType: getContentType(sourceDb, nodeResult.value),
        ...((nodeResult.value?.metadata as Record<string, unknown>) ?? {}),
      },
    },
  };
}

/**
 * 根据 sourceDb 和节点信息推断内容类型
 */
function getContentType(
  sourceDb: SourceDatabase,
  node: DstuNode | null
): string {
  if (!node) return 'unknown';

  switch (sourceDb) {
    case 'textbooks':
      return 'pdf_path';
    case 'exam_sessions':
      return 'exam_json';
    case 'notes':
      return 'markdown';
    case 'chat_v2':
      return node.previewType ?? 'binary';
    default:
      return node.previewType ?? 'unknown';
  }
}

/**
 * 获取引用节点的详情（仅元数据）
 *
 * @param params 获取参数
 * @returns Result包装的节点详情
 */
export async function fetchReferenceNode(
  params: FetchContentParams
): Promise<Result<DstuNode | null, VfsError>> {
  const { sourceDb, sourceId } = params;

  const dstuPath = buildPathForSource(sourceDb, sourceId);
  return await dstu.get(dstuPath);
}

/**
 * 检查引用是否有效（原数据是否存在）
 *
 * @param sourceDb 来源数据库
 * @param sourceId 资源 ID
 * @returns 是否有效
 */
export async function validateReference(
  sourceDb: SourceDatabase,
  sourceId: string
): Promise<boolean> {
  const dstuPath = buildPathForSource(sourceDb, sourceId);
  const result = await dstu.get(dstuPath);
  return result.ok && result.value !== null;
}

/**
 * 批量校验引用有效性
 *
 * @param refs 引用列表
 * @returns 每个引用的有效性状态
 */
export async function batchValidateReferences(
  refs: Array<{ sourceDb: SourceDatabase; sourceId: string }>
): Promise<Array<{ sourceDb: string; sourceId: string; valid: boolean }>> {
  const results = await Promise.all(
    refs.map(async (ref) => {
      const valid = await validateReference(ref.sourceDb, ref.sourceId);
      return {
        sourceDb: ref.sourceDb,
        sourceId: ref.sourceId,
        valid,
      };
    })
  );
  return results;
}

/**
 * 类型映射：sourceDb -> ResourceType 和 typeId
 *
 * | sourceDb       | ResourceType | typeId     |
 * |----------------|-------------|------------|
 * | notes          | 'note'      | 'note'     |
 * | textbooks      | 'file'      | 'textbook' |
 * | exam_sessions  | 'exam'      | 'exam'     |
 * | chat_v2        | 'file'      | 'file'     |
 */
export function mapSourceToResourceType(sourceDb: SourceDatabase): {
  resourceType: 'note' | 'file' | 'exam';
  typeId: string;
} {
  switch (sourceDb) {
    case 'notes':
      return { resourceType: 'note', typeId: 'note' };
    case 'textbooks':
      return { resourceType: 'file', typeId: 'textbook' };
    case 'exam_sessions':
      return { resourceType: 'exam', typeId: 'exam' };
    case 'chat_v2':
    default:
      // 默认作为 file 引用到对话
      return { resourceType: 'file', typeId: 'file' };
  }
}

/**
 * 检查引用节点是否可以引用到对话
 *
 * @param node 引用节点或笔记 ID
 * @returns 是否可以引用
 */
export function canReferenceToChat(node: ReferenceNode | { sourceDb?: SourceDatabase }): boolean {
  const sourceDb = node.sourceDb;
  return (
    sourceDb === 'notes' ||
    sourceDb === 'textbooks' ||
    sourceDb === 'chat_v2' ||
    sourceDb === 'exam_sessions'
  );
}
