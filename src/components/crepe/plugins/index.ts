/**
 * Crepe 编辑器插件扩展
 * 集成额外的 Milkdown 插件以增强功能
 *
 * 接线清单见 docs/revamp/W1-editor-wiring.md
 */

import type { Crepe } from '@milkdown/crepe';

// 插件导入
import { automd } from '@milkdown/plugin-automd';
import { searchHighlightPlugin } from './searchHighlight';
import { agentHighlightPlugin } from './agentHighlight';
import { calloutPlugin } from './callout';
import { togglePlugin } from './toggle';
import { pasteLinkPlugin } from './pasteLink';
import { imageLightboxPlugin } from './imageLightbox';
import { linkKeymapPlugin } from './linkKeymap';
import { wikilinkPlugin } from './wikilink';
import type { WikilinkPluginConfig } from './wikilink';
import { mentionPlugin } from './mention';
import type { MentionPluginConfig } from './mention';
import { pdfRefPlugin } from './pdfRef';
import { defaultWikilinkGetNotes } from './wikilink/defaultGetNotes';

// Prism 核心必须先导入，组件依赖全局 Prism 对象
import 'prismjs';

// Prism 语言支持（按需导入）
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-markdown';

/**
 * 插件配置选项
 */
export interface CrepePluginsOptions {
  /** 启用自动 Markdown 格式化（输入 **text** 自动粗体等） */
  automd?: boolean;
  /**
   * [[wikilink]] 插件。`false` 关闭；对象可覆盖 getNotes / resolve。
   * 默认：启用；getNotes 走 DSTU listNotes；resolve 默认全部 resolved（宿主可注入索引判定）。
   */
  wikilink?: boolean | WikilinkPluginConfig;
  /**
   * @mention 插件。`false` 关闭；对象可覆盖 searchNotes。
   * 默认：启用；searchNotes 走 DSTU notesDstuAdapter.searchNotes。
   */
  mention?: boolean | MentionPluginConfig;
  /** Callout 块，默认启用 */
  callout?: boolean;
  /** Toggle 折叠块，默认启用 */
  toggle?: boolean;
  /** 粘贴 URL 智能链接（prepend 优先于 clipboard），默认启用 */
  pasteLink?: boolean;
  /** 图片点击放大，默认启用 */
  imageLightbox?: boolean;
  /** Mod-K 链接快捷键，默认启用 */
  linkKeymap?: boolean;
  /**
   * pdfref:// 来源行回链（点击回到 PDF 对应页），默认启用。
   * 纯 click 拦截 + pdf-ref:open 派发，无 UI、无数据依赖。
   */
  pdfRefLink?: boolean;
}

/**
 * 应用额外插件到 Crepe 实例
 * 注意：需要在 crepe.create() 之前调用
 */
export const applyCrepePlugins = (
  crepe: Crepe,
  options: CrepePluginsOptions = {}
): void => {
  const {
    automd: enableAutomd = true,
    wikilink: wikilinkOpts = true,
    mention: mentionOpts = true,
    callout: enableCallout = true,
    toggle: enableToggle = true,
    pasteLink: enablePasteLink = true,
    imageLightbox: enableImageLightbox = true,
    linkKeymap: enableLinkKeymap = true,
    pdfRefLink: enablePdfRefLink = true,
  } = options;

  // 自动 Markdown 格式化
  // 输入 **text** 自动应用粗体，输入 `code` 自动应用代码等
  if (enableAutomd) {
    crepe.editor.use(automd);
  }

  // 查找高亮（FindReplacePanel 通过 transaction meta 驱动）
  crepe.editor.use(searchHighlightPlugin);

  // ACR AI 光标 / 插入高亮（noteDriver 经 agentInsert / agentSignal 驱动）— R1-12
  crepe.editor.use(agentHighlightPlugin);

  // A5：粘贴 URL 智能链接（内部 prepend prosePluginsCtx，须在 create 前注册）
  if (enablePasteLink) {
    crepe.editor.use(pasteLinkPlugin());
  }

  // A3 / A4：Callout + Toggle（remark 各吃白名单 marker，互不吞噬）
  if (enableCallout) {
    crepe.editor.use(calloutPlugin());
  }
  if (enableToggle) {
    crepe.editor.use(togglePlugin());
  }

  // A2：[[wikilink]]
  if (wikilinkOpts !== false) {
    const config: WikilinkPluginConfig =
      typeof wikilinkOpts === 'object' && wikilinkOpts ? wikilinkOpts : {};
    crepe.editor.use(
      wikilinkPlugin({
        getNotes: config.getNotes ?? defaultWikilinkGetNotes,
        resolve: config.resolve,
        maxSuggestions: config.maxSuggestions,
      }),
    );
  }

  // A8：@mention（默认 DSTU searchNotes）
  if (mentionOpts !== false) {
    const config: MentionPluginConfig =
      typeof mentionOpts === 'object' && mentionOpts ? mentionOpts : {};
    crepe.editor.use(
      mentionPlugin({
        searchNotes: config.searchNotes,
        maxSuggestions: config.maxSuggestions,
        debounceMs: config.debounceMs,
      }),
    );
  }

  // A6：图片 lightbox
  if (enableImageLightbox) {
    crepe.editor.use(imageLightboxPlugin());
  }

  // A7：Mod-K 链接快捷键（依赖 LinkTooltip feature）
  if (enableLinkKeymap) {
    crepe.editor.use(linkKeymapPlugin());
  }

  // r5-S4：pdfref:// 来源行回链（点击回到 PDF 对应页，复用 pdf-ref:open 链路）
  if (enablePdfRefLink) {
    crepe.editor.use(pdfRefPlugin());
  }
};

/**
 * 默认插件配置
 */
export const defaultPluginOptions: CrepePluginsOptions = {
  automd: true,
  wikilink: true,
  mention: true,
  callout: true,
  toggle: true,
  pasteLink: true,
  imageLightbox: true,
  linkKeymap: true,
  pdfRefLink: true,
};
