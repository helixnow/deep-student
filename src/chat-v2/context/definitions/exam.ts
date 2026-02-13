/**
 * Chat V2 - 上下文类型定义 - 题目集 (Exam)
 *
 * 题目集类型，用于学习资源管理器中的题目集引用节点
 *
 * ★ 文档25扩展：支持多模态上下文注入（图文交替）
 *
 * 优先级: 22 (介于 card(20) 和 textbook(25) 之间)
 * XML 标签: <exam_sheet>
 * 关联工具: 无（题目集为只读引用，不支持工具调用）
 *
 * @see 20-统一资源库与访达层改造任务分配.md Prompt 9
 * @see 25-题目集识别VFS存储与多模态上下文注入改造.md
 */

import type { ContextTypeDefinition, Resource, ContentBlock, FormatOptions } from '../types';
import { createXmlTextBlock } from '../types';
import type { MultimodalContentBlock } from '../vfsRefTypes';
import { t } from '@/utils/i18n';

/**
 * 题目集元数据类型
 *
 * 对应 exam_sheet_sessions.preview_json 中的元数据
 */
export interface ExamMetadata {
  /** 试卷标题/名称 */
  title?: string;
  /** 题目集识别会话 ID */
  sessionId?: string;
  /** 试卷状态 */
  status?: 'pending' | 'processing' | 'completed' | 'failed';
  /** 页数 */
  pageCount?: number;
  /** 题目数量 */
  questionCount?: number;
  /** 创建时间戳 */
  createdAt?: number;
  /** 文件夹路径（真实路径） */
  folderPath?: string;
}

/**
 * 将 MultimodalContentBlock 转换为 ContentBlock
 */
function convertMultimodalBlock(block: MultimodalContentBlock): ContentBlock {
  if (block.type === 'image' && block.mediaType && block.base64) {
    return {
      type: 'image',
      mediaType: block.mediaType,
      base64: block.base64,
    };
  }
  return {
    type: 'text',
    text: block.text || '',
  };
}

/**
 * 题目集类型定义
 *
 * ★ 文档25扩展：支持多模态上下文注入
 */
export const examDefinition: ContextTypeDefinition = {
  typeId: 'exam',
  xmlTag: 'exam_sheet',
  get label() { return t('contextDef.exam.label', {}, 'chatV2'); },
  labelEn: 'Exam Sheet',
  priority: 22,
  tools: [], // 题目集为只读引用，不关联工具

  // System Prompt 中的标签格式说明
  systemPromptHint:
    '<exam_sheet title="..." question-count="..." path="...">试卷内容</exam_sheet> - ' +
    '用户引用的题目集识别结果，包含试卷标题和识别的题目内容',

  formatToBlocks(resource: Resource, options?: FormatOptions): ContentBlock[] {
    const { isMultimodal = false } = options ?? {};

    // ★ VFS 引用模式：优先使用实时解析的数据
    const resolved = resource._resolvedResources?.[0];

    if (resolved) {
      // ★ 引用模式：资源已被删除
      if (!resolved.found) {
        return [createXmlTextBlock('exam_sheet', t('contextDef.exam.deleted', {}, 'chatV2'), {
          'session-id': resolved.sourceId,
          status: 'not-found',
        })];
      }

      // ★★★ 多模态模式：使用预先获取的 multimodalBlocks（文档25）
      if (isMultimodal && resolved.multimodalBlocks && resolved.multimodalBlocks.length > 0) {
        console.debug('[ExamDefinition] Using multimodal blocks, count:', resolved.multimodalBlocks.length);
        return resolved.multimodalBlocks.map(convertMultimodalBlock);
      }

      // ★ 文本模式：使用实时解析的内容和路径（文档28改造：使用真实路径，移除 subject）
      const resolvedMetadata = resolved.metadata as ExamMetadata | undefined;
      return [createXmlTextBlock('exam_sheet', resolved.content, {
        title: resolvedMetadata?.title || resolved.name || '',
        'page-count': resolvedMetadata?.pageCount !== undefined ? String(resolvedMetadata.pageCount) : undefined,
        'question-count': resolvedMetadata?.questionCount !== undefined ? String(resolvedMetadata.questionCount) : undefined,
        'session-id': resolved.sourceId,
        path: resolved.path, // ★ 真实文件夹路径
      })];
    }

    // ★★★ 禁止回退：VFS 类型必须有 _resolvedResources ★★★
    const metadata = resource.metadata as ExamMetadata | undefined;
    const name = metadata?.title || resource.sourceId || 'exam';
    return [createXmlTextBlock('exam_sheet', t('contextDef.exam.vfsError', { name }, 'chatV2'), {
      'session-id': resource.sourceId,
      status: 'error',
    })];
  },
};

/**
 * 题目集类型 ID 常量
 */
export const EXAM_TYPE_ID = 'exam' as const;

/**
 * 题目集关联的工具 ID 列表（空，题目集为只读）
 */
export const EXAM_TOOLS: readonly string[] = [] as const;
