/**
 * Chat V2 - 引用标记 Remark 插件
 *
 * 将 Markdown AST 中的引用标记（如 [知识库-1]、[思维导图:mm_xxx]、[题目集:session_id]）
 * 转换为特殊的 HTML 节点，以便 React 渲染时替换为对应的交互组件
 */

import { CITATION_TYPE_MAP } from './citationParser';

// ============================================================================
// 引用正则表达式
// ============================================================================

/**
 * RAG/Memory/WebSearch 引用正则表达式（全局匹配）
 * 匹配格式：[类型-数字] 或 [类型-数字:图片]
 * 可选的 :图片/:image 后缀用于显式请求渲染图片
 * 
 * ★ 2026-01 清理：移除"错题/graph/Knowledge Graph"匹配（错题系统废弃）
 */
const CITATION_PATTERN = /\[(知识库|记忆|搜索|图片|knowledge|Knowledge Base|knowledge base|memory|Memory|search|Search|web|Web|image|Image)-(\d+)(?::(图片|image))?\]/gi;

/**
 * PDF 页面引用正则表达式（全局匹配）
 * 匹配格式：
 * - [PDF@sourceId:pageNumber]     单页，如 [PDF@id:3]
 * - [PDF@sourceId:start-end]      页码范围，如 [PDF@id:2-3]
 * - [PDF@sourceId:p1,p2,p3]       逗号分隔，如 [PDF@id:1,3,5]
 * LLM 可能自行合并为范围格式，前端必须兼容渲染。
 */
const PDF_REF_PATTERN = /\[PDF@([a-zA-Z0-9_-]+):\s*(\d+(?:[-,]\d+)*)\]/gi;

/**
 * PDF 页面引用简写正则表达式（全局匹配）
 * 匹配格式：[pdf第1页]
 */
const PDF_SHORT_REF_PATTERN = /\[(pdf)\s*第(\d+)页\]/gi;

/**
 * 思维导图引用正则表达式（全局匹配）
 * 匹配格式：
 * - [思维导图:mm_xxx] 当前导图
 * - [思维导图:mv_xxx] 历史版本
 * - [思维导图:mm_xxx:标题] / [思维导图:mv_xxx:标题]
 */
const MINDMAP_CITATION_PATTERN = /\[(思维导图|导图|脑图|MindMap|mindmap):((?:mm_|mv_)[a-zA-Z0-9_-]+)(?::([^\]]+))?\]/gi;

/**
 * 题目集引用正则表达式（全局匹配）
 * 匹配格式：[题目集:session_id] 或 [题目集:session_id:名称]
 * 支持 UUID 和 exam_ 前缀的 ID 格式
 */
const QBANK_CITATION_PATTERN = /\[(题目集|题库|练习册|QuestionBank|question[_ ]?bank|qbank):([\w-]+)(?::([^\]]+))?\]/gi;

// ============================================================================
// PDF 页码显示辅助函数
// ============================================================================

/**
 * 将页码字符串转换为中文显示标签
 * - "3"     → "第3页"
 * - "2-3"   → "第2-3页"
 * - "1,3,5" → "第1,3,5页"
 */
function formatPdfPageLabel(pageStr: string): string {
  return `第${pageStr}页`;
}

// ============================================================================
// Remark 插件
// ============================================================================

/**
 * 创建引用标记处理 Remark 插件
 *
 * 该插件遍历 Markdown AST，将文本节点中的引用标记
 * 转换为带有特殊 data 属性的 inline 节点
 */
export function makeCitationRemarkPlugin() {
  return function attacher() {
    return function transformer(tree: any) {
      // 跳过的节点类型（不处理代码块和数学公式中的内容）
      const SKIP_TYPES = new Set(['code', 'inlineCode', 'math', 'inlineMath']);

      /**
       * 遍历并处理节点
       */
      function walk(node: any, parent: any | null) {
        if (!node) return;

        const nodeType = node.type;

        // 跳过代码和数学公式
        if (SKIP_TYPES.has(nodeType)) {
          return;
        }

        // 处理文本节点
        if (nodeType === 'text') {
          const value: string = node.value || '';

          // 重置正则表达式状态
          CITATION_PATTERN.lastIndex = 0;
          MINDMAP_CITATION_PATTERN.lastIndex = 0;
          QBANK_CITATION_PATTERN.lastIndex = 0;

          // 检查是否有任何引用标记
          const hasCitation = CITATION_PATTERN.test(value);
          CITATION_PATTERN.lastIndex = 0;
          const hasMindmapCitation = MINDMAP_CITATION_PATTERN.test(value);
          MINDMAP_CITATION_PATTERN.lastIndex = 0;
          const hasQbankCitation = QBANK_CITATION_PATTERN.test(value);
          QBANK_CITATION_PATTERN.lastIndex = 0;
          const hasPdfRef = PDF_REF_PATTERN.test(value);
          PDF_REF_PATTERN.lastIndex = 0;
          const hasPdfShortRef = PDF_SHORT_REF_PATTERN.test(value);
          PDF_SHORT_REF_PATTERN.lastIndex = 0;

          if (!hasCitation && !hasMindmapCitation && !hasQbankCitation && !hasPdfRef && !hasPdfShortRef) {
            return;
          }

          // 收集所有引用匹配
          interface CitationMatch {
            type: 'citation' | 'mindmap' | 'qbank' | 'pdf_ref';
            index: number;
            length: number;
            data: any;
          }

          const matches: CitationMatch[] = [];

          // 收集普通引用
          let match: RegExpExecArray | null;
          while ((match = CITATION_PATTERN.exec(value)) !== null) {
            const typeText = match[1];
            const indexNum = parseInt(match[2], 10);
            const imageSuffix = match[3];
            const sourceType = CITATION_TYPE_MAP[typeText];
            if (sourceType) {
              matches.push({
                type: 'citation',
                index: match.index,
                length: match[0].length,
                data: { sourceType, indexNum, showImage: !!imageSuffix },
              });
            }
          }

          // 收集思维导图引用
          MINDMAP_CITATION_PATTERN.lastIndex = 0;
          while ((match = MINDMAP_CITATION_PATTERN.exec(value)) !== null) {
            const mindmapId = match[2];
            const title = match[3]?.trim();
            matches.push({
              type: 'mindmap',
              index: match.index,
              length: match[0].length,
              data: { mindmapId, title, isVersion: mindmapId.startsWith('mv_') },
            });
          }

          // 收集题目集引用
          QBANK_CITATION_PATTERN.lastIndex = 0;
          while ((match = QBANK_CITATION_PATTERN.exec(value)) !== null) {
            const sessionId = match[2];
            const title = match[3]?.trim();
            matches.push({
              type: 'qbank',
              index: match.index,
              length: match[0].length,
              data: { sessionId, title },
            });
          }

          // 收集 PDF 页面引用（支持单页、范围、逗号分隔）
          PDF_REF_PATTERN.lastIndex = 0;
          while ((match = PDF_REF_PATTERN.exec(value)) !== null) {
            const sourceId = match[1];
            const pageStr = match[2]; // 可能是 "2"、"2-3"、"1,3,5"
            const firstPage = parseInt(pageStr, 10); // 取第一个页码用于点击跳转
            if (sourceId && Number.isFinite(firstPage) && firstPage > 0) {
              matches.push({
                type: 'pdf_ref',
                index: match.index,
                length: match[0].length,
                data: { sourceId, pageNumber: firstPage, pageLabel: pageStr },
              });
            }
          }

          PDF_SHORT_REF_PATTERN.lastIndex = 0;
          while ((match = PDF_SHORT_REF_PATTERN.exec(value)) !== null) {
            const pageNumber = parseInt(match[2], 10);
            if (Number.isFinite(pageNumber) && pageNumber > 0) {
              matches.push({
                type: 'pdf_ref',
                index: match.index,
                length: match[0].length,
                data: { sourceId: undefined, pageNumber },
              });
            }
          }

          // 按位置排序
          matches.sort((a, b) => a.index - b.index);

          if (matches.length === 0) {
            return;
          }

          // 构建新节点
          const parts: any[] = [];
          let lastIndex = 0;

          for (const m of matches) {
            // 添加引用前的文本
            if (m.index > lastIndex) {
              parts.push({
                type: 'text',
                value: value.slice(lastIndex, m.index),
              });
            }

            if (m.type === 'citation') {
              // 普通引用节点
              const { sourceType, indexNum, showImage } = m.data;
              const showImageAttr = showImage ? ' data-citation-show-image="true"' : '';
              parts.push({
                type: 'html',
                value: `<span data-citation="true" data-citation-type="${sourceType}" data-citation-index="${indexNum}"${showImageAttr} class="citation-badge-placeholder">[${indexNum}]</span>`,
              });
            } else if (m.type === 'mindmap') {
              // 思维导图引用节点
              const { mindmapId, title, isVersion } = m.data;
              const titleAttr = title ? ` data-mindmap-title="${encodeURIComponent(title)}"` : '';
              const idAttrName = isVersion ? 'data-mindmap-version-id' : 'data-mindmap-id';
              parts.push({
                type: 'html',
                value: `<span data-mindmap-citation="true" ${idAttrName}="${mindmapId}"${titleAttr} class="mindmap-citation-placeholder">[思维导图]</span>`,
              });
            } else if (m.type === 'qbank') {
              // 题目集引用节点
              const { sessionId, title } = m.data;
              const titleAttr = title ? ` data-qbank-title="${encodeURIComponent(title)}"` : '';
              parts.push({
                type: 'html',
                value: `<span data-qbank-citation="true" data-qbank-session-id="${sessionId}"${titleAttr} class="qbank-citation-placeholder">[题目集]</span>`,
              });
            } else if (m.type === 'pdf_ref') {
              // PDF 页面引用节点（支持单页 "3"、范围 "2-3"、逗号 "1,3,5"）
              const { sourceId, pageNumber, pageLabel } = m.data;
              const displayLabel = formatPdfPageLabel(pageLabel || String(pageNumber));
              parts.push({
                type: 'html',
                value: `<span data-pdf-ref="true"${sourceId ? ` data-pdf-source="${sourceId}"` : ''} data-pdf-page="${pageNumber}" class="pdf-ref-badge-placeholder"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;vertical-align:-1px"><path d="M4 1h5.5L13 4.5V13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.3" fill="currentColor" fill-opacity="0.1"/><path d="M9.5 1v3.5H13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 9h4M6 11.5h2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>${displayLabel}</span>`,
              });
            }

            lastIndex = m.index + m.length;
          }

          // 添加剩余文本
          if (lastIndex < value.length) {
            parts.push({
              type: 'text',
              value: value.slice(lastIndex),
            });
          }

          // 如果有变化，替换原节点
          if (parts.length > 0 && parent && Array.isArray(parent.children)) {
            const idx = parent.children.indexOf(node);
            if (idx >= 0) {
              parent.children.splice(idx, 1, ...parts);
            }
          }

          return;
        }

        // 递归处理子节点
        const children = node.children || [];
        for (const child of children) {
          walk(child, node);
        }
      }

      walk(tree, null);
    };
  };
}

// ============================================================================
// CSS 样式（用于占位符）
// ============================================================================

/**
 * 引用徽章占位符的 CSS 样式
 * 在 React 替换之前显示的基本样式
 */
export const CITATION_PLACEHOLDER_STYLES = `
.citation-badge-placeholder {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.25rem;
  height: 1.25rem;
  padding: 0 0.25rem;
  margin: 0 0.125rem;
  font-size: 0.75rem;
  font-weight: 500;
  border-radius: 0.25rem;
  background-color: hsl(var(--primary) / 0.1);
  color: hsl(var(--primary));
  cursor: pointer;
  transition: background-color 0.2s;
}

.citation-badge-placeholder:hover {
  background-color: hsl(var(--primary) / 0.2);
}

.dark .citation-badge-placeholder {
  background-color: hsl(var(--primary) / 0.15);
}

.dark .citation-badge-placeholder:hover {
  background-color: hsl(var(--primary) / 0.25);
}

/* 思维导图引用占位符样式 */
.mindmap-citation-placeholder {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.125rem 0.5rem;
  margin: 0 0.125rem;
  font-size: 0.75rem;
  font-weight: 500;
  border-radius: 0.375rem;
  background: linear-gradient(135deg, hsl(270 70% 50% / 0.1), hsl(280 70% 50% / 0.1));
  color: hsl(270 70% 50%);
  border: 1px solid hsl(270 70% 50% / 0.2);
  cursor: pointer;
  transition: all 0.2s;
}

.mindmap-citation-placeholder:hover {
  background: linear-gradient(135deg, hsl(270 70% 50% / 0.2), hsl(280 70% 50% / 0.2));
  border-color: hsl(270 70% 50% / 0.4);
}

.dark .mindmap-citation-placeholder {
  background: linear-gradient(135deg, hsl(270 70% 60% / 0.15), hsl(280 70% 60% / 0.15));
  color: hsl(270 70% 70%);
  border-color: hsl(270 70% 60% / 0.3);
}

.dark .mindmap-citation-placeholder:hover {
  background: linear-gradient(135deg, hsl(270 70% 60% / 0.25), hsl(280 70% 60% / 0.25));
  border-color: hsl(270 70% 60% / 0.5);
}

/* 题目集引用占位符样式 */
.qbank-citation-placeholder {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.125rem 0.5rem;
  margin: 0 0.125rem;
  font-size: 0.75rem;
  font-weight: 500;
  border-radius: 0.375rem;
  background: linear-gradient(135deg, hsl(160 70% 40% / 0.1), hsl(180 70% 40% / 0.1));
  color: hsl(160 70% 40%);
  border: 1px solid hsl(160 70% 40% / 0.2);
  cursor: pointer;
  transition: all 0.2s;
}

.qbank-citation-placeholder:hover {
  background: linear-gradient(135deg, hsl(160 70% 40% / 0.2), hsl(180 70% 40% / 0.2));
  border-color: hsl(160 70% 40% / 0.4);
}

.dark .qbank-citation-placeholder {
  background: linear-gradient(135deg, hsl(160 70% 50% / 0.15), hsl(180 70% 50% / 0.15));
  color: hsl(160 70% 70%);
  border-color: hsl(160 70% 50% / 0.3);
}

.dark .qbank-citation-placeholder:hover {
  background: linear-gradient(135deg, hsl(160 70% 50% / 0.25), hsl(180 70% 50% / 0.25));
  border-color: hsl(160 70% 50% / 0.5);
}

/* PDF 页面引用占位符样式 */
.pdf-ref-badge-placeholder {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  padding: 0.1rem 0.45rem;
  margin: 0 0.15rem;
  font-size: 0.7rem;
  font-weight: 500;
  letter-spacing: 0.01em;
  border-radius: 0.375rem;
  background: linear-gradient(135deg, hsl(210 85% 55% / 0.1), hsl(225 80% 60% / 0.1));
  color: hsl(215 80% 50%);
  border: 1px solid hsl(215 80% 55% / 0.2);
  cursor: pointer;
  transition: all 0.2s ease;
  vertical-align: middle;
  text-decoration: none;
  line-height: 1.4;
  white-space: nowrap;
}

.pdf-ref-badge-placeholder:hover {
  background: linear-gradient(135deg, hsl(210 85% 55% / 0.2), hsl(225 80% 60% / 0.2));
  border-color: hsl(215 80% 55% / 0.4);
  box-shadow: 0 1px 4px hsl(215 80% 55% / 0.12);
}

.pdf-ref-badge-placeholder:active {
  transform: scale(0.97);
}

.dark .pdf-ref-badge-placeholder {
  background: linear-gradient(135deg, hsl(210 85% 60% / 0.15), hsl(225 80% 65% / 0.15));
  color: hsl(215 85% 72%);
  border-color: hsl(215 80% 60% / 0.3);
}

.dark .pdf-ref-badge-placeholder:hover {
  background: linear-gradient(135deg, hsl(210 85% 60% / 0.25), hsl(225 80% 65% / 0.25));
  border-color: hsl(215 80% 60% / 0.5);
  box-shadow: 0 1px 6px hsl(215 80% 60% / 0.15);
}

.pdf-ref-badge-placeholder svg {
  opacity: 0.85;
}
`;
