/**
 * Chat V2 - 上下文类型定义 - 文件夹 (Folder)
 *
 * 文件夹类型，支持批量注入文件夹内所有资源到上下文
 *
 * 优先级: 100（较低，放在单资源后面）
 * XML 标签: <folder_content>
 * 关联工具: 动态收集（根据文件夹内资源类型确定）
 *
 * 参考文档: 23-VFS文件夹架构与上下文注入改造任务分配.md - Prompt 8
 */

import type { ContextTypeDefinition, Resource, ContentBlock } from '../types';
import { createTextBlock } from '../types';
import { t } from '@/utils/i18n';

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 文件夹类型 ID 常量
 */
export const FOLDER_TYPE_ID = 'folder' as const;

/**
 * 文件夹 XML 标签常量
 */
export const FOLDER_XML_TAG = 'folder_content' as const;

// ============================================================================
// 类型定义 (契约 C6)
// ============================================================================

/**
 * 文件夹内资源信息
 */
export interface FolderResourceItem {
  /** 资源类型: note, textbook, exam, translation, essay */
  itemType: string;
  /** 资源 ID */
  itemId: string;
  /** 资源标题 */
  title: string;
  /** 资源在文件夹树中的路径 */
  path: string;
  /** 资源内容 */
  content: string;
}

/**
 * 文件夹上下文数据（存储在 resource.data 中，JSON 格式）
 * 对应契约 C6
 */
export interface FolderContextData {
  /** 文件夹 ID */
  folderId: string;
  /** 文件夹标题 */
  folderTitle: string;
  /** 文件夹完整路径，如 "高考复习/函数" */
  path: string;
  /** 文件夹内资源列表 */
  resources: FolderResourceItem[];
}

/**
 * 文件夹元数据
 */
export interface FolderMetadata {
  /** 文件夹标题 */
  title?: string;
  /** 文件夹路径 */
  path?: string;
  /** 资源数量 */
  resourceCount?: number;
}

// ============================================================================
// 工具映射
// ============================================================================

/**
 * itemType 到工具 ID 的映射
 * 
 * ★ 2026-01 改造：所有工具通过内置 MCP 服务器注入，不再绑定上下文
 */
const ITEM_TYPE_TOOLS: Record<string, readonly string[]> = {
  note: [],
  textbook: [],
  exam: [],
  translation: [],
  essay: [],
  retrieval: [],
};

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 转义 XML 属性值
 */
function escapeXmlAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 转义 XML 内容
 */
function escapeXmlContent(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 根据 itemType 获取对应的 XML 标签名
 */
function getItemXmlTag(itemType: string): string {
  switch (itemType) {
    case 'note':
      return 'note_item';
    case 'textbook':
      return 'textbook_item';
    case 'exam':
      return 'exam_item';
    case 'translation':
      return 'translation_item';
    case 'essay':
      return 'essay_item';
    default:
      return 'resource_item';
  }
}

/**
 * 解析文件夹上下文数据
 */
function parseFolderContextData(dataStr: string): FolderContextData | null {
  try {
    return JSON.parse(dataStr) as FolderContextData;
  } catch {
    console.warn('[FolderDefinition] Failed to parse folder context data:', dataStr);
    return null;
  }
}

/**
 * 格式化单个资源项为 XML
 */
function formatResourceItem(item: FolderResourceItem): string {
  const tag = getItemXmlTag(item.itemType);
  const attrs = [
    `type="${escapeXmlAttr(item.itemType)}"`,
    `id="${escapeXmlAttr(item.itemId)}"`,
    `title="${escapeXmlAttr(item.title)}"`,
  ].join(' ');

  // 对于空内容，使用自闭合标签
  if (!item.content || item.content.trim() === '') {
    return `  <${tag} ${attrs} />`;
  }

  return `  <${tag} ${attrs}>\n${escapeXmlContent(item.content)}\n  </${tag}>`;
}

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 文件夹类型定义
 */
export const folderDefinition: ContextTypeDefinition = {
  typeId: FOLDER_TYPE_ID,
  xmlTag: FOLDER_XML_TAG,
  get label() { return t('contextDef.folder.label', {}, 'chatV2'); },
  labelEn: 'Folder',
  priority: 100, // 较低优先级，放在单资源后面
  tools: [], // 静态工具为空，动态通过 getToolsForResource 获取

  // System Prompt 中的标签格式说明
  systemPromptHint:
    '<folder_content name="..." count="..." not-found="...">...</folder_content> - ' +
    '用户选择的文件夹，包含文件夹内所有资源内容。每个资源用对应类型的标签包装（如 <note_item>、<textbook_item> 等）',

  formatToBlocks(resource: Resource): ContentBlock[] {
    // ★ VFS 引用模式：优先使用实时解析的数据
    const resolvedResources = resource._resolvedResources;

    // ✅ 空文件夹也可能是有效结果：_resolvedResources === []
    if (resolvedResources) {
      const foundItems = resolvedResources.filter((r) => r.found);
      const notFoundCount = resolvedResources.length - foundItems.length;
      const metadata = resource.metadata as FolderMetadata | undefined;
      const folderName = metadata?.title || 'Folder';
      // 构建 XML 属性（路径信息不注入 LLM）
      const attrs = [
        `name="${escapeXmlAttr(folderName)}"`,
        `count="${foundItems.length}"`,
        `not-found="${notFoundCount}"`,
      ].join(' ');

      // 无有效资源时返回空文件夹标签
      if (foundItems.length === 0) {
        const notFoundMsg = notFoundCount > 0
          ? `<!-- ${notFoundCount} 个资源已被删除 -->`
          : t('contextDef.folder.empty', {}, 'chatV2');
        return [createTextBlock(`<${FOLDER_XML_TAG} ${attrs}>\n  ${notFoundMsg}\n</${FOLDER_XML_TAG}>`)];
      }

      // ★ 格式化所有已解析的资源（使用实时路径和内容）
      const itemsXml = foundItems.map((item) => {
        const tag = getItemXmlTag(item.type);
        const itemAttrs = [
          `type="${escapeXmlAttr(item.type)}"`,
          `source-id="${escapeXmlAttr(item.sourceId)}"`,
          `title="${escapeXmlAttr(item.name)}"`,
        ].join(' ');

        // 对于空内容，使用自闭合标签
        if (!item.content || item.content.trim() === '') {
          return `  <${tag} ${itemAttrs} />`;
        }

        return `  <${tag} ${itemAttrs}>\n${escapeXmlContent(item.content)}\n  </${tag}>`;
      }).join('\n');

      const xml = `<${FOLDER_XML_TAG} ${attrs}>\n${itemsXml}\n</${FOLDER_XML_TAG}>`;
      return [createTextBlock(xml)];
    }

    // ★★★ 禁止回退：VFS 类型必须有 _resolvedResources ★★★
    const metadata = resource.metadata as FolderMetadata | undefined;
    const name = metadata?.title || resource.sourceId || 'folder';
    return [createTextBlock(`<${FOLDER_XML_TAG} status="error">${t('contextDef.folder.vfsError', { name }, 'chatV2')}</${FOLDER_XML_TAG}>`)];
  },
};

// ============================================================================
// 动态工具收集
// ============================================================================

/**
 * 获取文件夹资源关联的工具 ID 列表
 *
 * 遍历文件夹内所有资源，根据 itemType 收集对应工具。
 * - note → note_read, note_append, note_replace
 * - 其他类型暂无工具
 *
 * @param resource 资源实体
 * @returns 去重后的工具 ID 数组
 */
export function getToolsForFolderResource(resource: Resource): string[] {
  const toolSet = new Set<string>();

  // ✅ VFS 引用模式：优先使用实时解析的资源类型
  if (resource._resolvedResources) {
    for (const item of resource._resolvedResources) {
      const tools = ITEM_TYPE_TOOLS[item.type];
      if (tools) {
        tools.forEach((tool) => toolSet.add(tool));
      }
    }
    return Array.from(toolSet);
  }

  // 兼容：旧版 folder context data（包含完整 resources[]）
  const legacyData = parseFolderContextData(resource.data);
  if (legacyData?.resources && legacyData.resources.length > 0) {
    for (const item of legacyData.resources) {
      const tools = ITEM_TYPE_TOOLS[item.itemType];
      if (tools) {
        tools.forEach((tool) => toolSet.add(tool));
      }
    }
    return Array.from(toolSet);
  }

  // 兼容：VFS 引用数据（仅 refs[]，无内容）
  try {
    const parsed = JSON.parse(resource.data) as unknown as { refs?: Array<{ type?: string }> };
    if (parsed.refs && Array.isArray(parsed.refs)) {
      for (const ref of parsed.refs) {
        const tools = ITEM_TYPE_TOOLS[ref.type ?? ''];
        if (tools) {
          tools.forEach((tool) => toolSet.add(tool));
        }
      }
    }
  } catch {
    // ignore
  }

  return Array.from(toolSet);
}

/**
 * 文件夹关联的静态工具 ID 列表（空）
 */
export const FOLDER_TOOLS: readonly string[] = [] as const;
