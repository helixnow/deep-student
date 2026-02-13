/**
 * Chat V2 - 上下文类型定义 - 笔记 (Note)
 *
 * Canvas 笔记类型，用于将笔记内容作为上下文引用注入到对话中。
 *
 * 优先级: 10（最高）
 * XML 标签: <canvas_note>
 * 
 * ★ 2026-01 改造：笔记工具不再通过上下文注入，完全依赖内置 MCP 服务器（builtinMcpServer.ts）
 * 这样 AI 可以在没有笔记上下文引用的情况下也能创建、搜索和管理笔记。
 */

import type { ContextTypeDefinition, Resource, ContentBlock } from '../types';
import { createXmlTextBlock } from '../types';
import { t } from '@/utils/i18n';

/**
 * 笔记元数据类型
 */
export interface NoteMetadata {
  /** 笔记标题 */
  title?: string;
  /** 最后修改时间 */
  lastModified?: number;
  /** 文件夹路径（真实路径） */
  folderPath?: string;
}

/**
 * 笔记类型定义
 * 
 * ★ 注意：tools 数组为空，笔记工具通过内置 MCP 服务器注入
 */
export const noteDefinition: ContextTypeDefinition = {
  typeId: 'note',
  xmlTag: 'canvas_note',
  get label() { return t('contextDef.note.label', {}, 'chatV2'); },
  labelEn: 'Note',
  priority: 10,
  tools: [], // ★ 笔记工具通过 builtinMcpServer.ts 注入，不再绑定上下文

  // System Prompt 中的标签格式说明
  get systemPromptHint() { return t('contextDef.note.description', {}, 'chatV2'); },

  formatToBlocks(resource: Resource): ContentBlock[] {
    // ★★★ VFS 引用模式（强制，禁止回退）★★★
    const resolved = resource._resolvedResources?.[0];

    if (resolved) {
      // 资源已被删除
      if (!resolved.found) {
        return [createXmlTextBlock('canvas_note', t('contextDef.note.deleted', {}, 'chatV2'), {
          'note-id': resolved.sourceId,
          status: 'not-found',
        })];
      }

      // 使用实时解析的内容和路径（文档28改造：使用真实路径，移除 subject）
      const resolvedMetadata = resolved.metadata as NoteMetadata | undefined;
      return [createXmlTextBlock('canvas_note', resolved.content, {
        title: resolvedMetadata?.title || resolved.name || '',
        'note-id': resolved.sourceId,
        path: resolved.path, // ★ 真实文件夹路径
      })];
    }

    // ★★★ 禁止回退：VFS 类型必须有 _resolvedResources ★★★
    const metadata = resource.metadata as NoteMetadata | undefined;
    const name = metadata?.title || resource.sourceId || 'note';
    return [createXmlTextBlock('canvas_note', t('contextDef.note.vfsError', { name }, 'chatV2'), {
      'note-id': resource.sourceId,
      status: 'error',
    })];
  },
};

/**
 * 笔记类型 ID 常量
 */
export const NOTE_TYPE_ID = 'note' as const;
