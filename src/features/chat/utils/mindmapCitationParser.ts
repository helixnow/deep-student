/**
 * Chat V2 - 思维导图引用解析工具
 *
 * 解析 LLM 回复中的思维导图引用标记（如 [思维导图:mm_xxx] / [思维导图:mv_xxx]）
 * 支持在消息正文中内联渲染思维导图预览卡片
 */

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 解析后的思维导图引用信息
 */
export interface ParsedMindmapCitation {
  /** 完整匹配文本，如 "[思维导图:mm_abc123]" */
  fullMatch: string;
  /** 思维导图引用 ID（支持 mm_ 当前版 / mv_ 历史版） */
  mindmapId: string;
  /** 可选的标题（如果 LLM 提供了） */
  title?: string;
  /**
   * 可选的节点定位提示（`#` 紧跟 ID 之后）：节点 ID 或节点文字。
   * 打开导图时据此展开祖先、居中并高亮该节点。
   */
  nodeHint?: string;
  /** 在原文中的起始位置 */
  start: number;
  /** 在原文中的结束位置 */
  end: number;
}

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 思维导图引用正则表达式
 * 匹配格式：
 * - [思维导图:mm_xxx] - 当前版本
 * - [思维导图:mv_xxx] - 指定历史版本
 * - [导图:mm_xxx] - 简写格式
 * - [思维导图:mm_xxx:标题] - 带标题格式
 * - [MindMap:mm_xxx] - 英文格式
 * - [思维导图:mm_xxx#节点文字:标题] / [思维导图:mm_xxx#node_id] - 定位到具体节点
 *
 * ★ 2026-10 扩展：节点定位提示。`#` 紧贴 ID（ID 字符集不含 `#`，旧引用不可能命中），
 *   提示段不含 `:` / `]`；标题段仍是第一个 `:` 之后的全部内容（标题里的 `#` 不受影响，
 *   如 `[思维导图:mm_x:C# 基础]` 解析结果与旧版完全一致）。
 * 
 * ★ 2026-02-12 扩展：支持 `mv_` 历史版本引用
 * ★ 2026-01-31 修复：ID 支持 `-` 字符（nanoid 生成的 ID 可能包含 `-`）
 */
const MINDMAP_CITATION_PATTERN = /\[(思维导图|导图|脑图|MindMap|mindmap):((?:mm_|mv_)[a-zA-Z0-9_-]+)(?:#([^:\]\n]+))?(?::([^\]]+))?\]/gi;

/**
 * 思维导图 ID 验证正则
 * 支持：
 * - `mm_*` 当前导图引用
 * - `mv_*` 导图版本引用
 */
const MINDMAP_ID_PATTERN = /^(?:mm_|mv_)[a-zA-Z0-9_-]+$/;

// ============================================================================
// 核心解析函数
// ============================================================================

/**
 * 解析文本中的所有思维导图引用标记
 *
 * @param text - 待解析的文本
 * @returns 解析出的引用列表（按位置排序）
 */
export function parseMindmapCitations(text: string): ParsedMindmapCitation[] {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const citations: ParsedMindmapCitation[] = [];
  let match: RegExpExecArray | null;

  // 重置正则表达式状态
  MINDMAP_CITATION_PATTERN.lastIndex = 0;

  while ((match = MINDMAP_CITATION_PATTERN.exec(text)) !== null) {
    const mindmapId = match[2];
    const nodeHint = match[3]?.trim() || undefined; // 可选的节点定位提示
    const title = match[4]; // 可选的标题

    // 验证 ID 格式
    if (MINDMAP_ID_PATTERN.test(mindmapId)) {
      citations.push({
        fullMatch: match[0],
        mindmapId,
        title: title?.trim(),
        ...(nodeHint ? { nodeHint } : {}),
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  // 按位置排序
  return citations.sort((a, b) => a.start - b.start);
}

/**
 * 检查文本是否包含思维导图引用标记
 *
 * @param text - 待检查的文本
 * @returns 是否包含引用
 */
export function hasMindmapCitations(text: string): boolean {
  if (!text || typeof text !== 'string') {
    return false;
  }
  // 重置正则表达式状态
  MINDMAP_CITATION_PATTERN.lastIndex = 0;
  return MINDMAP_CITATION_PATTERN.test(text);
}

/**
 * 验证是否为有效的思维导图 ID
 *
 * @param id - 待验证的 ID
 * @returns 是否有效
 */
export function isValidMindmapId(id: string): boolean {
  return MINDMAP_ID_PATTERN.test(id);
}

/**
 * 生成思维导图引用文本
 *
 * @param mindmapId - 思维导图 ID
 * @param title - 可选的标题
 * @returns 引用文本
 */
export function generateMindmapCitation(mindmapId: string, title?: string, nodeHint?: string): string {
  // 提示段不允许 `:` / `]` / 换行（会截断语法），替换为全角/空格
  const hint = nodeHint
    ?.replace(/:/g, '：')
    .replace(/[\]\n]/g, ' ')
    .trim();
  const idPart = hint ? `${mindmapId}#${hint}` : mindmapId;
  if (title) {
    return `[思维导图:${idPart}:${title}]`;
  }
  return `[思维导图:${idPart}]`;
}

/**
 * 生成思维导图历史版本引用文本
 */
export function generateMindmapVersionCitation(versionId: string, title?: string): string {
  if (!versionId.startsWith('mv_')) {
    throw new Error('Mindmap version citation requires an mv_* id');
  }
  return generateMindmapCitation(versionId, title);
}

// ============================================================================
// 导出正则表达式（供 remark 插件使用）
// ============================================================================

export { MINDMAP_CITATION_PATTERN };
