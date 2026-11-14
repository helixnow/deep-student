/**
 * 文档分段服务：把长文档切成可供 LLM 制卡的分段任务
 * （`dstu-anki/src/document_processing_service.rs` 1-1127 全量移植）。
 *
 * # Token 估算权威规则（务必阅读）
 *
 * 本代码库中存在多套 token 估算实现，口径**不一致**，这是已知且被接受的现状：
 *
 * | 位置 | 规则 | 用途 |
 * |------|------|------|
 * | 本文件 {@link estimateTokens} | 汉字(0x4E00-0x9FFF)=1/字 + 词数×1.3 + 其它字符×0.2，下限=字符数/4 | **分段预算的唯一权威** |
 * | `dstu-util/src/utils/token_budget.rs` | 逐字符加权（ASCII 字母 0.25、CJK/假名/谚文 1.0、Emoji 0.8…） | 聊天上下文预算 |
 * | 前端 `tokenUtils.ts`、`CardAgent.ts` | CJK=1/字，ASCII≈4字符/token | UI 展示提示，仅供参考 |
 *
 * 约定：
 * 1. 分段逻辑内部必须自洽——所有预算判断都用本文件的 {@link estimateTokens}；
 * 2. 前端估算只用于展示，后端分段结果以本文件为准（±30% 偏差属预期）；
 * 3. 默认每段预算 10_000 tokens；
 * 4. `estimateTokensPinnedValues` / `estimateTokensDivergesFromTokenBudget` 钉住本规则。
 *
 * # `enable_llm_boundary_detection` 的诚实说明
 *
 * 该选项开启时只在**硬切点**（超长单句被迫按字符切断处）附近向
 * 段落(\n\n) > 换行 > 句末标点 > 空白 边界回退吸附。这是纯规则的
 * "semantic-ish" 边界吸附，**不是 LLM 定界**——没有任何模型调用参与切点选择。
 */
import { AppError } from '../../../platform/errors/api.ts';
import {
  charCount,
  isRustWhitespace,
  rustTrim,
  rustTrimEnd,
  rustTrimStart,
} from '../../../platform/util/index.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { AnkiLogger } from './logger.ts';
import type { AnkiGenerationOptions } from '../../../../contracts/ipc/generated/L16-anki.ts';
import type { DocumentTask, TaskStatus } from '../../../../contracts/ipc/generated/_shared.ts';
import type { FsrsTransactionOwner } from './fsrs-owner.ts';
import { decodeDocumentTaskRow } from './anki-cards.ts';
import {
  deleteDocumentSessionRows,
  getDocumentTaskRow,
  insertDocumentTask,
  listDocumentTasks,
  updateDocumentTaskStatus,
} from '../repository/document-processing.ts';
import { serializeAnkiGenerationOptions } from './generation-options.ts';
import { nowRfc3339 } from './time.ts';
import {
  DEFAULT_SEGMENT_OVERLAP_SIZE,
  debugLog,
  debugOption,
  errorText,
  utf8Length,
} from './document-processing-text.ts';
import {
  calculateMaxTokensPerSegment,
  estimateTokens,
  segmentWithoutOverlap,
} from './document-processing-segment.ts';
import { segmentWithOverlap } from './document-processing-overlap.ts';
import {
  countTableDataRows,
  distributeGlobalMaxCardsWeighted,
  ensureRowCoverage,
} from './document-processing-distribution.ts';

// =====================================================================
// 服务（数据库部分）
// =====================================================================

/**
 * 文档任务服务（`DocumentProcessingService`）。
 *
 * 错误按 Rust `Result<_, AppError>` 的语义抛出：值为 `AppError` 的 serde 形状
 * `{ error_type, message, details }`。
 */
export class DocumentProcessingService {
  private readonly db: DatabaseHandle;

  constructor(db: DatabaseHandle) {
    this.db = db;
  }

  /** 处理文档并创建分段任务（生成新的 document_id）。 */
  async processDocumentAndCreateTasks(
    documentContent: string,
    originalDocumentName: string,
    options: AnkiGenerationOptions,
  ): Promise<[string, DocumentTask[]]> {
    const documentId = globalThis.crypto.randomUUID();
    return this.processDocumentAndCreateTasksWithId(
      documentId,
      documentContent,
      originalDocumentName,
      options,
    );
  }

  /** 处理文档并创建分段任务（使用预分配的 document_id）。 */
  async processDocumentAndCreateTasksWithId(
    documentId: string,
    documentContent: string,
    originalDocumentName: string,
    options: AnkiGenerationOptions,
  ): Promise<[string, DocumentTask[]]> {
    // 分段文档（纯函数，便于单测）
    const segments = segmentDocument(documentContent, options);

    const tasks: DocumentTask[] = [];
    // 按各段文本量加权分配总卡数：平均分时 15 词的段和 2 词的段同拿 11 张，
    // 词多的段被截掉尾部（60 词漏 9 个，全在词最多的两段末尾）
    const maxCardsTotal = options.max_cards_total;
    let segmentLimits: number[] | null = null;
    if (typeof maxCardsTotal === 'number' && maxCardsTotal > 0) {
      const weights = segments.map((seg) => estimateTokens(seg));
      const limits = distributeGlobalMaxCardsWeighted(maxCardsTotal, weights);
      const rows = segments.map((seg) => countTableDataRows(seg));
      segmentLimits = ensureRowCoverage(limits, rows);
    }

    const now = nowRfc3339();

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const taskOptions: AnkiGenerationOptions = { ...options };
      if (segmentLimits !== null) {
        taskOptions.max_cards_per_mistake = segmentLimits[index] ?? 0;
      }
      let ankiOptionsJson: string;
      try {
        ankiOptionsJson = serializeAnkiGenerationOptions(
          taskOptions as unknown as Record<string, unknown>,
        );
      } catch (error) {
        throw AppError.validation(`序列化AnkiGenerationOptions失败: ${errorText(error)}`);
      }

      const task: DocumentTask = {
        id: globalThis.crypto.randomUUID(),
        document_id: documentId,
        original_document_name: originalDocumentName,
        segment_index: index,
        content_segment: segment,
        status: 'Pending',
        created_at: now,
        updated_at: now,
        error_message: null,
        anki_generation_options_json: ankiOptionsJson,
      };

      // 保存到数据库
      try {
        insertDocumentTask(this.db, task);
      } catch (error) {
        throw AppError.database(`保存文档任务失败: ${errorText(error)}`);
      }

      tasks.push(task);
    }

    return [documentId, tasks];
  }

  /** 获取文档的所有任务。 */
  getDocumentTasks(documentId: string): DocumentTask[] {
    try {
      return listDocumentTasks(this.db, documentId).map(decodeDocumentTaskRow);
    } catch (error) {
      throw AppError.database(`获取文档任务失败: ${errorText(error)}`);
    }
  }

  /** 更新任务状态。 */
  updateTaskStatus(taskId: string, status: TaskStatus, errorMessage: string | null): void {
    try {
      updateDocumentTaskStatus(this.db, taskId, status, errorMessage);
    } catch (error) {
      throw AppError.database(`更新任务状态失败: ${errorText(error)}`);
    }
  }

  /** 获取单个任务。 */
  getTask(taskId: string): DocumentTask {
    try {
      return decodeDocumentTaskRow(getDocumentTaskRow(this.db, taskId));
    } catch (error) {
      throw AppError.database(`获取任务失败: ${errorText(error)}`);
    }
  }

  /** 删除文档及其所有任务；FSRS 清理由调用方传入的 L15 所有者完成。 */
  deleteDocument(documentId: string, fsrs: FsrsTransactionOwner): void {
    try {
      deleteDocumentSessionRows(this.db, documentId, fsrs);
    } catch (error) {
      throw AppError.database(`删除文档失败: ${errorText(error)}`);
    }
  }
}

// =====================================================================
// 纯分段逻辑（不依赖数据库，可直接单元测试）
// =====================================================================

/**
 * 文档分段入口。
 *
 * 流程：
 * 1. 估算全文 token（本文件权威口径），不超预算则整篇作为单段返回；
 * 2. 按 `\n\n` 段落边界优先聚合（{@link segmentWithoutOverlap}）；
 * 3. 超预算段落按句子切分，超预算单句按字符硬切
 *    （开启 `enable_llm_boundary_detection` 时硬切点做规则边界吸附）；
 * 4. `segment_overlap_size > 0` 时在相邻分段间注入重叠上下文；
 * 5. 兜底：过滤空白分段，保证至少返回一个分段。
 */

export function segmentDocument(content: string, options: AnkiGenerationOptions): string[] {
  const maxTokensPerSegment = calculateMaxTokensPerSegment(options);
  const estimatedContentTokens = estimateTokens(content);

  // 如果内容较短（含空文档），不需要分段
  if (estimatedContentTokens <= maxTokensPerSegment) {
    return [content];
  }

  const overlapSize =
    typeof options.segment_overlap_size === 'number'
      ? options.segment_overlap_size
      : DEFAULT_SEGMENT_OVERLAP_SIZE;
  // 诚实开关：这里读取的是规则边界吸附，不是 LLM 定界（见模块注释）。
  const snapBoundaries = options.enable_llm_boundary_detection ?? false;
  debugLog(
    `[DOCUMENT_DEBUG] 文档分段: 估计${estimatedContentTokens}tokens，每段最大${maxTokensPerSegment}tokens，重叠区域${overlapSize}字符，边界吸附=${snapBoundaries}`,
  );
  if (snapBoundaries) {
    debugLog(
      '[DOCUMENT_DEBUG] enable_llm_boundary_detection=true → 应用规则边界吸附（非 LLM 定界）',
    );
  }
  debugLog(
    `[DOCUMENT_DEBUG] 用户设置: 每个主题最大卡片数=${options.max_cards_per_mistake}, 总体令牌限制=${debugOption(options.max_tokens)}`,
  );

  // 使用重叠分段策略
  let segments =
    overlapSize > 0
      ? segmentWithOverlap(content, maxTokensPerSegment, overlapSize, snapBoundaries)
      : segmentWithoutOverlap(content, maxTokensPerSegment, snapBoundaries);

  // 兜底修复：绝不返回空/纯空白分段（旧实现在 trim 后可能残留空段）
  segments = segments.filter((segment) => rustTrim(segment) !== '');
  if (segments.length === 0) {
    segments.push(content);
  }

  debugLog(`[DOCUMENT_DEBUG] 文档分段完成: ${segments.length}个分段`);
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    debugLog(
      `[DOCUMENT_DEBUG] 分段${i + 1}: ${utf8Length(segment)}字符, 估计${estimateTokens(segment)}tokens`,
    );
  }
  return segments;
}

/**
 * 估算文本的 token 数量。
 *
 * **分段预算的权威规则**（改动必须同步更新模块注释与钉住测试）：
 *
 * ```text
 * tokens = 汉字数(U+4E00..=U+9FFF)
 *        + floor(空白分词词数 × 1.3)
 *        + floor(非汉字字符数 × 0.2)
 * 下限：max(tokens, 总字符数 / 4)
 * 空串 → 0
 * ```
 *
 * 注意与 `token_budget.rs`（逐字符加权）以及前端 `tokenUtils.ts`
 * （CJK=1、ASCII=4字符/token）**口径不同**，差异已被接受。
 */

export * from './document-processing-text.ts';
export * from './document-processing-segment.ts';
export * from './document-processing-overlap.ts';
export * from './document-processing-distribution.ts';
