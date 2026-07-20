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
import { type Result, VfsError, VfsErrorCode, err } from '@/shared/result';
import { uint8ArrayToBase64 } from '@/utils/base64FileUtils';
import type { ExtendedSourceDatabase } from './types/reference';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 引用节点来源数据库（DSTU 全量支持面）
 *
 * ★ B8 修复（2026-07）：此前本文件与 types/reference.ts 各自维护一套
 * `SourceDatabase` 且已漂移。现统一以 types/reference.ts 为单一来源：
 * - 本别名 = reference.ts 的 `ExtendedSourceDatabase`（宽集合，DSTU 可寻址全集）
 * - reference.ts 的 `SourceDatabase`（窄集合）仍是引用节点 UI 的支持面
 *
 * 联合成员不变（'notes' | 'textbooks' | 'chat_v2' | 'exam_sessions' |
 * 'translations' | 'essays' | 'attachments' | 'mindmaps'），
 * 既有 `import type { SourceDatabase } from './learningHubApi'` 全部兼容。
 */
export type SourceDatabase = ExtendedSourceDatabase;

/**
 * 引用节点类型（文档 18 数据契约形状，含独立 id / nativeId 字段）
 *
 * 注意：这与 types/reference.ts 的 `ReferenceNode`（存储在
 * FolderStructure.references 中的形状，无 id 字段、字段名为 sourceId）
 * 是两个不同的契约，历史上并存。本类型目前仅作为 canReferenceToChat
 * 的参数类型之一保留，无外部 import；新代码请优先使用 types/reference.ts 版本。
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
 * 后端可通过 ID 前缀全局寻址的资源前缀集合
 *
 * 与 src-tauri/src/dstu/handler_utils/path_utils.rs 的 `extract_simple_id`
 * known_prefixes 保持一致（前端仅用于诊断日志，不做拦截）。
 */
const DSTU_ADDRESSABLE_ID_PREFIXES = [
  'note_',
  'tb_',
  'file_',
  'tr_',
  'exam_',
  'essay_session_',
  'essay_',
  'att_',
  'fld_',
  'mm_',
  'res_',
  'img_',
] as const;

/**
 * 构建 DSTU 路径
 *
 * ★ B7 审计结论（2026-07，经后端源码核实）：`sourceDb` 被有意忽略是**正确行为**。
 *
 * 证据（src-tauri/src/dstu/）：
 * - `handlers.rs::dstu_get` / `dstu_get_content` 均先调用
 *   `handler_utils/path_utils.rs::extract_resource_info(path)`；
 * - `extract_resource_info` 从路径末段取资源 ID，再由
 *   `infer_resource_type_from_id` **按 ID 前缀**决定查哪个库
 *   （note_→notes、tb_/file_/att_/img_→files、exam_→exams、tr_→translations、
 *   essay_→essays、mm_→mindmaps、res_→resources、fld_/UUID→folders）；
 * - 路径中不存在任何「库名段」语法——即使拼上 `/textbooks/tb_x`，
 *   后端也只看末段 ID。因此 `/${sourceId}`（简化路径格式）就是全局寻址的
 *   规范形式，「跨库同 ID 冲突」不可能发生（前缀即类型）。
 *
 * 唯一取不到的情形是 sourceId 没有可识别前缀（后端会返回
 * "Cannot infer resource type from ID" 错误），此处提前打诊断日志帮助定位，
 * 但不拦截——由后端作为唯一事实来源裁决。
 *
 * @param sourceDb 来源数据库（仅用于诊断日志）
 * @param sourceId 资源 ID（须携带 DSTU 可识别前缀，如 note_/tb_/exam_）
 * @returns DSTU 简化路径 `/${sourceId}`
 */
function buildPathForSource(
  sourceDb: SourceDatabase,
  sourceId: string
): string {
  const trimmedId = sourceId.trim();
  const isAddressable = DSTU_ADDRESSABLE_ID_PREFIXES.some((prefix) =>
    trimmedId.startsWith(prefix)
  );
  if (!isAddressable) {
    // 不拦截：UUID 格式的旧数据等仍可能被后端 fallback 命中
    console.warn(
      LOG_PREFIX,
      'sourceId 无 DSTU 可识别前缀，后端可能无法按 ID 推断资源类型:',
      { sourceDb, sourceId: trimmedId }
    );
  }
  return `/${trimmedId}`;
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

  // 输入校验：空 sourceId 直接短路，避免无意义的后端往返（Result 形状不变）
  if (typeof sourceId !== 'string' || sourceId.trim().length === 0) {
    return err(
      new VfsError(
        VfsErrorCode.VALIDATION,
        'fetchReferenceContent: sourceId 不能为空',
        true,
        { sourceDb, sourceId }
      )
    );
  }

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
        // 注意展开顺序：后端节点 metadata 中的同名键（如 title）会覆盖
        // 这里的默认值——这是既有语义（后端元数据优先），勿调换顺序。
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
 * @returns Result包装的节点详情（资源不存在时为 NOT_FOUND 错误）
 */
export async function fetchReferenceNode(
  params: FetchContentParams
): Promise<Result<DstuNode | null, VfsError>> {
  const { sourceDb, sourceId } = params;

  // 输入校验：空 sourceId 直接短路，避免无意义的后端往返
  if (typeof sourceId !== 'string' || sourceId.trim().length === 0) {
    return err(
      new VfsError(
        VfsErrorCode.VALIDATION,
        'fetchReferenceNode: sourceId 不能为空',
        true,
        { sourceDb, sourceId }
      )
    );
  }

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
  // 空 ID 必然无效，短路避免后端往返
  if (typeof sourceId !== 'string' || sourceId.trim().length === 0) {
    return false;
  }
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
 * | 其它 / 遗留值   | 'file'      | 'file'     |
 *
 * 参数接受 `string`（宽于 SourceDatabase）：合同测试传入遗留值 `'mistakes'`，
 * 走 default 分支映射为 file/file。放宽参数类型对既有调用方向后兼容。
 */
export function mapSourceToResourceType(sourceDb: SourceDatabase | (string & {})): {
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
 * 可引用到对话的来源数据库集合
 *
 * 合同锁定（tests/vitest/notes/learningHubApi-contracts.test.ts）：
 * notes/textbooks/chat_v2/exam_sessions 为 true；attachments 与缺省为 false。
 */
const CHAT_REFERENCEABLE_SOURCE_DBS: ReadonlySet<SourceDatabase> = new Set([
  'notes',
  'textbooks',
  'chat_v2',
  'exam_sessions',
]);

/**
 * 检查引用节点是否可以引用到对话
 *
 * 对 `sourceDb` 缺失（undefined）或不在支持集合内的节点返回 false，
 * 不抛异常——调用方（NotesContext / useReferenceToChat）依赖这一宽容语义。
 *
 * @param node 引用节点，或任何携带可选 sourceDb 字段的对象
 * @returns 是否可以引用到对话
 */
export function canReferenceToChat(node: ReferenceNode | { sourceDb?: SourceDatabase }): boolean {
  const sourceDb = node?.sourceDb;
  return sourceDb != null && CHAT_REFERENCEABLE_SOURCE_DBS.has(sourceDb);
}
