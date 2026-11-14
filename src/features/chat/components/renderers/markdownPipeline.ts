/**
 * The official Markdown pipeline (FE-B6): the remark and rehype steps MarkdownRenderer applies, as entries of the
 * `markdown.remark` / `markdown.rehype` slots (contract: ui-plugins/official/content/pipeline.ts). Loading this module
 * announces them; `dstu.ui.content` contributes them to the UI kernel, and windows without a kernel use these tables.
 */
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { SlotEntry } from '@/ui-kernel/slots';
import {
  markdownPipelineContributions,
  type MarkdownPlugin,
  type MarkdownPluginContribution,
  type MarkdownRehypeContribution,
  type MarkdownRemarkContribution,
} from '@/ui-plugins/official/content/pipeline';
import { makeCitationRemarkPlugin } from '../../utils/citationRemarkPlugin';
import { rehypeSearchHighlights } from './rehypeSearchHighlights';
import { inlineSmilesRemarkPlugin } from './inlineSmilesRemarkPlugin';

const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [
      ...(defaultSchema.attributes?.span || []),
      'className',
      'class',
      // Generative UI research citations carry pre-computed i18n aria labels;
      // keep them so the React fallback below doesn't have to reconstruct text.
      // role is restricted to the non-interactive "note" landmark only.
      ['role', 'note'],
      'ariaLabel',
      // rehype-sanitize 使用 HAST property 名称（camelCase）
      'dataCitation',
      'dataCitationType',
      'dataCitationIndex',
      'dataCitationShowImage',
      'dataMindmapCitation',
      'dataMindmapId',
      'dataMindmapVersionId',
      'dataMindmapTitle',
      'dataMindmapNode',
      'dataQbankCitation',
      'dataQbankSessionId',
      'dataQbankTitle',
      'dataPdfRef',
      'dataPdfSource',
      'dataPdfPage',
      'dataMediaRef',
      'dataMediaSource',
      'dataMediaSeconds',
      // Per-word fade-in animation
      'dataSdAnimate',
      'dataSmiles',
    ],
    code: [
      ...(defaultSchema.attributes?.code || []),
      'className',
      'class',
    ],
    pre: [
      ...(defaultSchema.attributes?.pre || []),
      'className',
      'class',
    ],
    // 不确定性高亮（rendererUtils.makeUncertaintyHighlightPlugin）产出的 <mark>：
    // 只放行受控 class 与 title（tooltip），不放行任意 style
    mark: [
      ['className', 'uncertainty-mark'],
      ['className', 'chat-search-match'],
      'dataChatSearchMatch',
    ],
  },
  // defaultSchema 不含 mark，缺了它整个高亮节点会被消毒器拆掉
  tagNames: [...(defaultSchema.tagNames || []), 'mark'],
};

const disableIndentedCodePlugin = function disableIndentedCodePlugin(this: any) {
  const Parser = this?.Parser;
  if (!Parser || !Parser.prototype) return;

  const blockTokenizers = Parser.prototype.blockTokenizers;
  const blockMethods: string[] = Parser.prototype.blockMethods || [];

  if (!blockTokenizers || typeof blockTokenizers.indentedCode === 'undefined') {
    return;
  }

  delete blockTokenizers.indentedCode;

  const index = blockMethods.indexOf('indentedCode');
  if (index !== -1) {
    blockMethods.splice(index, 1);
  }
};

// 规范化全角标点（仅限文本节点，不进入 code/inlineCode/math），
// 修复中文输入法下使用全角符号导致的 Markdown 加粗/删除线等语法不生效问题。
// 例如：＂＊＊加粗＊＊＂/＂＿＿加粗＿＿＂/＂～～删除线～～＂
const normalizeFullWidthPunctPlugin = function normalizeFullWidthPunctPlugin() {
  return function transformer(tree: any) {
    const SKIP_IN = new Set(['code', 'inlineCode', 'math', 'inlineMath']);
    function walk(node: any, parent: any | null) {
      if (!node) return;
      const t = node.type;
      if (t === 'text') {
        if (parent && SKIP_IN.has(parent.type)) return;
        const map: Record<string, string> = {
          '＊': '*',
          '＿': '_',
          '～': '~',
          '＃': '#',
        };
        const re = /[＊＿～＃]/g;
        if (typeof node.value === 'string' && re.test(node.value)) {
          node.value = node.value.replace(re, (ch: string) => map[ch] || ch);
        }
        return;
      }
      const children = Array.isArray(node.children) ? node.children : [];
      for (const c of children) walk(c, node);
    }
    walk(tree, null);
  };
};

// 拦截 ```math / ```latex 代码块并转成 math 节点的插件（必须在 remark-math 之前执行）
const convertMathCodeBlocksPlugin = function convertMathCodeBlocksPlugin() {
  return function transformer(tree: any) {
    function walk(node: any, parent: any | null, index: number) {
      if (!node) return;
      
      // 找到 type='code' 且 lang='math' 或 'latex' 的节点
      if (node.type === 'code' && typeof node.lang === 'string' && /^(math|latex)$/i.test(node.lang)) {
        console.warn('[MarkdownRenderer] Detected ```math/```latex code block (model violated prompt), force-converted to math node:', node.value?.substring(0, 50));
        // 转换为 math 节点（块级数学公式）
        node.type = 'math';
        node.meta = node.meta || null;
        delete node.lang; // math节点不需要lang属性
      }
      
      // 递归处理子节点
      const children = Array.isArray(node.children) ? node.children : [];
      for (let i = 0; i < children.length; i++) {
        walk(children[i], node, i);
      }
    }
    walk(tree, null, 0);
  };
};

function officialEntry<C>(id: string, order: number, create: MarkdownPluginContribution<C>['create']): SlotEntry<MarkdownPluginContribution<C>> {
  return { id, order, owner: 'dstu.ui.content', origin: 'builtin', value: { create } };
}

export const officialRemarkEntries: readonly SlotEntry<MarkdownRemarkContribution>[] = [
  officialEntry('remark:disable-indented-code', 10, () => disableIndentedCodePlugin as MarkdownPlugin),
  officialEntry('remark:full-width-punctuation', 20, () => normalizeFullWidthPunctPlugin as MarkdownPlugin),
  officialEntry('remark:math-code-blocks', 30, () => convertMathCodeBlocksPlugin as MarkdownPlugin),
  officialEntry('remark:math', 40, () => remarkMath),
  officialEntry('remark:inline-smiles', 50, () => inlineSmilesRemarkPlugin as MarkdownPlugin),
  officialEntry('remark:gfm', 60, () => remarkGfm),
  officialEntry<{ citations: boolean }>('remark:citations', 70, ({ citations }) => (citations ? makeCitationRemarkPlugin() as MarkdownPlugin : null)),
];

export const officialRehypeEntries: readonly SlotEntry<MarkdownRehypeContribution>[] = [
  officialEntry('rehype:raw', 10, () => rehypeRaw),
  officialEntry('rehype:sanitize', 20, () => [rehypeSanitize, markdownSanitizeSchema] as MarkdownPlugin),
  officialEntry<{ searchQuery: string }>('rehype:search-highlights', 30, ({ searchQuery }) => (searchQuery.trim() ? [rehypeSearchHighlights, { query: searchQuery }] as MarkdownPlugin : null)),
];

for (const entry of officialRemarkEntries) markdownPipelineContributions.announce({ slot: 'markdown.remark', entry });
for (const entry of officialRehypeEntries) markdownPipelineContributions.announce({ slot: 'markdown.rehype', entry });

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

/** Wraps a community plugin so that a throwing attacher or transformer only drops that step. */
function isolate(plugin: MarkdownPlugin, onError: (error: unknown) => void): MarkdownPlugin {
  const [attacher, ...options] = Array.isArray(plugin) ? plugin : [plugin];
  if (typeof attacher !== 'function') return plugin;
  const guarded = function (this: unknown, ...args: unknown[]) {
    try {
      const transformer = (attacher as AnyFunction).apply(this, args);
      if (typeof transformer !== 'function') return transformer;
      return function (this: unknown, ...inputs: unknown[]) {
        try {
          return (transformer as AnyFunction).apply(this, inputs);
        } catch (error) {
          onError(error);
          return undefined;
        }
      };
    } catch (error) {
      onError(error);
      return undefined;
    }
  };
  return (Array.isArray(plugin) ? [guarded, ...options] : guarded) as MarkdownPlugin;
}

/** The plugins of one render, in slot order. Community contributions that fail are reported and skipped. */
export function resolveMarkdownPlugins<C>(
  entries: readonly SlotEntry<MarkdownPluginContribution<C>>[],
  context: C,
  onError: (entry: SlotEntry<MarkdownPluginContribution<C>>, error: unknown) => void,
): MarkdownPlugin[] {
  const plugins: MarkdownPlugin[] = [];
  for (const entry of entries) {
    if (entry.origin === 'builtin') {
      const plugin = entry.value.create(context);
      if (plugin) plugins.push(plugin);
      continue;
    }
    try {
      const plugin = entry.value.create(context);
      if (plugin) plugins.push(isolate(plugin, (error) => onError(entry, error)));
    } catch (error) {
      onError(entry, error);
    }
  }
  return plugins;
}
