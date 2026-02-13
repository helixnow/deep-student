/**
 * Chat V2 - 上下文类型定义 - 翻译 (Translation)
 *
 * 翻译类型，用于学习资源管理器中的翻译引用节点
 *
 * 优先级: 24 (介于 essay(23) 和 textbook(25) 之间)
 * XML 标签: <translation>
 * 关联工具: 无（翻译为只读引用，不支持工具调用）
 */

import type { ContextTypeDefinition, Resource, ContentBlock } from '../types';
import { createXmlTextBlock } from '../types';
import { t } from '@/utils/i18n';

/**
 * 翻译元数据类型
 *
 * 对应 VFS translations 表的元数据
 */
export interface TranslationMetadata {
  /** 翻译标题 */
  title?: string;
  /** 源语言 */
  srcLang?: string;
  /** 目标语言 */
  tgtLang?: string;
  /** 源文本 */
  sourceText?: string;
  /** 翻译文本 */
  translatedText?: string;
  /** 正式程度 */
  formality?: string;
  /** 文件夹路径（真实路径） */
  folderPath?: string;
}

/**
 * 翻译类型定义
 */
export const translationDefinition: ContextTypeDefinition = {
  typeId: 'translation',
  xmlTag: 'translation',
  get label() { return t('contextDef.translation.label', {}, 'chatV2'); },
  labelEn: 'Translation',
  priority: 24,
  tools: [], // 翻译为只读引用，不关联工具

  // System Prompt 中的标签格式说明
  systemPromptHint:
    '<translation src-lang="..." tgt-lang="...">翻译内容</translation> - ' +
    '用户引用的翻译内容，包含源语言和目标语言信息',

  formatToBlocks(resource: Resource): ContentBlock[] {
    // ★★★ VFS 引用模式（强制，禁止回退）★★★
    const resolved = resource._resolvedResources?.[0];

    if (resolved) {
      // 资源已被删除
      if (!resolved.found) {
        return [createXmlTextBlock('translation', t('contextDef.translation.deleted', {}, 'chatV2'), {
          'translation-id': resolved.sourceId,
          status: 'not-found',
        })];
      }

      // 使用实时解析的内容和路径
      const resolvedMetadata = resolved.metadata as TranslationMetadata | undefined;
      return [createXmlTextBlock('translation', resolved.content, {
        title: resolvedMetadata?.title || resolved.name || '',
        'src-lang': resolvedMetadata?.srcLang,
        'tgt-lang': resolvedMetadata?.tgtLang,
        'translation-id': resolved.sourceId,
        path: resolved.path,
      })];
    }

    // ★★★ 禁止回退：VFS 类型必须有 _resolvedResources ★★★
    const metadata = resource.metadata as TranslationMetadata | undefined;
    const name = metadata?.title || resource.sourceId || 'translation';
    return [createXmlTextBlock('translation', t('contextDef.translation.vfsError', { name }, 'chatV2'), {
      'translation-id': resource.sourceId,
      status: 'error',
    })];
  },
};

/**
 * 翻译类型 ID 常量
 */
export const TRANSLATION_TYPE_ID = 'translation' as const;

/**
 * 翻译关联的工具 ID 列表（空，翻译为只读）
 */
export const TRANSLATION_TOOLS: readonly string[] = [] as const;
