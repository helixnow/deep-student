import type { Root, Element, Text, RootContent, ElementContent } from 'hast';

/**
 * rehype 插件：将文本节点按词拆分为 <span class="sd-word"> 元素。
 *
 * 工作原理：
 * - 在 ReactMarkdown 的 rehype 管线中运行，确保每次渲染都一致
 * - React 的 reconciliation 机制保证：已有位置的 span 不会重新挂载（不触发动画），
 *   新追加的 span 是新挂载的（触发 CSS animation）
 * - 跳过 code/pre/svg/math/annotation 内的文本
 *
 * 使用方式：
 *   rehypePlugins={[rehypeAnimateWords]}
 *   // 或带配置：
 *   rehypePlugins={[[rehypeAnimateWords, { className: 'sd-word' }]]}
 */

export interface RehypeAnimateWordsOptions {
  /** CSS class name for animated spans (default: 'sd-word') */
  className?: string;
}

/** 不做词拆分的元素标签 */
const SKIP_TAGS = new Set([
  'code', 'pre', 'svg', 'math', 'annotation',
  'script', 'style', 'textarea', 'input',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
]);

/**
 * 按词拆分文本。
 * - CJK 字符：每个字符独立（中文没有空格分词）
 * - 西文：按空格/标点分割，保留分隔符
 */
function splitIntoWords(text: string): string[] {
  const regex =
    /([\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff])|([\w\u00C0-\u024F]+(?:['\u2019][\w\u00C0-\u024F]+)?)|(\s+)|([^\s\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\w\u00C0-\u024F]+)/g;
  const result: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    result.push(match[0]);
  }
  return result;
}

/**
 * 递归遍历 HAST 树，对文本节点按词拆分。
 * 正确追踪祖先链，跳过 code/pre/svg/math 等元素内的文本。
 *
 * 旧实现按全局递增的 wordIndex 写入 --sd-i，配合 CSS animation-delay
 * 实现波浪 stagger。但这会带来两个问题：
 * 1. 长文 wordIndex 会累积到极大值，新增词的入场延迟变成数十秒
 * 2. 每次重渲染都会重新分配 wordIndex（即便词的内容/位置未变），
 *    React 通过文本相同复用节点时不会重跑动画 —— OK；
 *    但只要词序变动一次就会把后续所有词的 stagger 重置 —— 视觉上很乱。
 *
 * 现行做法：去掉 stagger 与 --sd-i，让每个词在挂载瞬间独立播一次 fade，
 * 由 React 节点复用机制天然保证"已显示词不再播放"。
 */
function walkAndSplit(
  node: Root | Element | null | undefined,
  className: string,
  insideSkipped: boolean,
): void {
  if (!node || !('children' in node) || !node.children) return;

  const children = node.children as (ElementContent | RootContent)[];
  let i = 0;

  while (i < children.length) {
    const child = children[i];

    if (child.type === 'element') {
      const el = child as Element;
      const shouldSkip = insideSkipped || SKIP_TAGS.has(el.tagName) || hasKatexClass(el);
      walkAndSplit(el, className, shouldSkip);
      i++;
      continue;
    }

    if (child.type !== 'text') {
      i++;
      continue;
    }

    if (insideSkipped) {
      i++;
      continue;
    }

    const text = (child as Text).value;
    if (!text || !text.trim()) {
      i++;
      continue;
    }

    const words = splitIntoWords(text);
    if (words.length === 0) {
      i++;
      continue;
    }

    if (words.length === 1 && words[0] === text) {
      const span: Element = {
        type: 'element',
        tagName: 'span',
        properties: {
          className: [className],
          dataSdAnimate: true,
        },
        children: [{ type: 'text', value: text }],
      };
      children.splice(i, 1, span as any);
      i++;
      continue;
    }

    const newNodes: (Element | Text)[] = [];
    for (const word of words) {
      if (/^\s+$/.test(word)) {
        newNodes.push({ type: 'text', value: word });
      } else {
        newNodes.push({
          type: 'element',
          tagName: 'span',
          properties: {
            className: [className],
            dataSdAnimate: true,
          },
          children: [{ type: 'text', value: word }],
        } as Element);
      }
    }

    children.splice(i, 1, ...(newNodes as any[]));
    i += newNodes.length;
  }
}

/**
 * 检查元素是否有 katex 相关的 class
 */
function hasKatexClass(el: Element): boolean {
  const cls = el.properties?.className;
  if (!Array.isArray(cls)) return false;
  return cls.some((c: string) => typeof c === 'string' && c.startsWith('katex'));
}

export function rehypeAnimateWords(options: RehypeAnimateWordsOptions = {}) {
  const { className = 'sd-word' } = options;

  return function transformer(tree: Root) {
    walkAndSplit(tree, className, false);
  };
}

export default rehypeAnimateWords;
