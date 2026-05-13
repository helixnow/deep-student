/**
 * Chat V2 - 上下文类型定义 - 作文 (Essay)
 *
 * 作文批改类型，用于学习资源管理器中的作文引用节点
 *
 * 优先级: 23 (介于 exam(22) 和 textbook(25) 之间)
 * XML 标签: <essay>
 * 关联工具: 无（作文为只读引用，不支持工具调用）
 */

import type { ContextTypeDefinition, Resource, ContentBlock } from '../types';
import { createXmlTextBlock } from '../types';
import { t } from '@/utils/i18n';

/**
 * 作文元数据类型
 *
 * 对应 VFS essays 表的元数据
 */
export interface EssayMetadata {
  /** 作文标题 */
  title?: string;
  /** 作文类型（议论文、记叙文等） */
  essayType?: string;
  /** 分数 */
  score?: number;
  /** 年级水平 */
  gradeLevel?: string;
  /** 轮次编号 */
  roundNumber?: number;
  /** 文件夹路径（真实路径） */
  folderPath?: string;
}

/**
 * 作文类型定义
 */
export const essayDefinition: ContextTypeDefinition = {
  typeId: 'essay',
  xmlTag: 'essay',
  get label() { return t('contextDef.essay.label', {}, 'chatV2'); },
  labelEn: 'Essay',
  priority: 23,
  tools: [], // 作文为只读引用，不关联工具

  // System Prompt 中的标签格式说明
  systemPromptHint:
    '<essay title="..." essay-type="..." score="..." path="...">作文内容</essay> - ' +
    '用户引用的作文内容，包含作文标题、类型和评分信息',

  formatToBlocks(resource: Resource): ContentBlock[] {
    // ★ VFS 引用模式：优先使用实时解析的数据
    const resolved = resource._resolvedResources?.[0];

    if (resolved) {
      // ★ 引用模式：资源已被删除
      if (!resolved.found) {
        return [createXmlTextBlock('essay', t('contextDef.essay.deleted', {}, 'chatV2'), {
          'essay-id': resolved.sourceId,
          status: 'not-found',
        })];
      }

      // ★ 引用模式：使用实时解析的内容和路径（文档28改造：使用真实路径，移除 subject）
      const resolvedMetadata = resolved.metadata as EssayMetadata | undefined;
      return [createXmlTextBlock('essay', resolved.content, {
        title: resolvedMetadata?.title || resolved.name || '',
        'essay-type': resolvedMetadata?.essayType,
        score: resolvedMetadata?.score !== undefined ? String(resolvedMetadata.score) : undefined,
        'grade-level': resolvedMetadata?.gradeLevel,
        'essay-id': resolved.sourceId,
        path: resolved.path, // ★ 真实文件夹路径
      })];
    }

    // ★★★ 禁止回退：VFS 类型必须有 _resolvedResources ★★★
    const metadata = resource.metadata as EssayMetadata | undefined;
    const name = metadata?.title || resource.sourceId || 'essay';
    return [createXmlTextBlock('essay', t('contextDef.essay.vfsError', { name }, 'chatV2'), {
      'essay-id': resource.sourceId,
      status: 'error',
    })];
  },
};

/**
 * 作文类型 ID 常量
 */
export const ESSAY_TYPE_ID = 'essay' as const;

/**
 * 作文关联的工具 ID 列表（空，作文为只读）
 */
export const ESSAY_TOOLS: readonly string[] = [] as const;
