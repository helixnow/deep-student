/**
 * Crepe 编辑器插件扩展
 * 集成额外的 Milkdown 插件以增强功能
 *
 * 接线清单见 docs/revamp/W1-editor-wiring.md
 */

import type { Crepe } from '@milkdown/crepe';
import type { SlotEntry } from '@/ui-kernel/slots';
import {
  editorContributions,
  editorEntriesForPurpose,
  resolveEditorExtensionGroups,
  type EditorContributionError,
  type EditorExtensionContribution,
  type EditorPurpose,
} from '@/ui-plugins/official/editor/editorSlots';

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
import { mediaRefPlugin } from './mediaRef';
import { internalLinkSchema } from './internalLinkSchemes';
import { defaultWikilinkGetNotes } from './wikilink/defaultGetNotes';
import { blockIdentityPlugin } from './blockIdentity';
import { blockSelectionPlugin } from './blockSelection';
import { typedPlaceholderPlugin } from './typedPlaceholder';
import { listItemHasCheckedPlugin } from './listItemHasChecked';
import { columnsPlugin } from './columns';
import { inlineCardsPlugin } from './inlineCards';
import { canonicalDocumentPlugin } from '../canonicalDocument';
import { crepeExecuteCommand, crepeCommandBindingsPlugin } from '../commandRegistry';
import type { CrepePluginsOptions } from './options';

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

export type { CrepePluginsOptions } from './options';

type ExtensionFactory = EditorExtensionContribution['create'];

function officialEntry(id: string, order: number, create: ExtensionFactory): SlotEntry<EditorExtensionContribution> {
  return { id, order, owner: 'dstu.ui.editor', origin: 'builtin', value: { create } };
}

const enabled = (flag: boolean | undefined) => flag ?? true;

/**
 * 官方编辑器插件栈（`editor.extensions`，契约见 ui-kernel/contracts/editor.ts）。
 * 每个编辑器实例按 order 调用一次工厂；顺序即 Milkdown 的注册顺序。
 */
export const officialEditorExtensionEntries: readonly SlotEntry<EditorExtensionContribution>[] = [
  // 自动 Markdown 格式化：输入 **text** 自动应用粗体，输入 `code` 自动应用代码等
  officialEntry('editor:automd', 10, ({ options }) => (enabled(options.automd) ? automd : null)),
  // 查找高亮（FindReplacePanel 通过 transaction meta 驱动）
  officialEntry('editor:search-highlight', 20, () => searchHighlightPlugin),
  // ACR AI 光标 / 插入高亮（noteDriver 经 agentInsert / agentSignal 驱动）— R1-12
  officialEntry('editor:agent-highlight', 30, () => agentHighlightPlugin),
  // A5：粘贴 URL 智能链接（内部 prepend prosePluginsCtx，须在 create 前注册）
  officialEntry('editor:paste-link', 40, ({ options }) => (enabled(options.pasteLink) ? pasteLinkPlugin() : null)),
  // A3 / A4：Callout + Toggle（remark 各吃白名单 marker，互不吞噬）
  officialEntry('editor:callout', 50, ({ options }) => (enabled(options.callout) ? calloutPlugin() : null)),
  officialEntry('editor:toggle', 60, ({ options }) => (enabled(options.toggle) ? togglePlugin() : null)),
  // A2：[[wikilink]]
  officialEntry('editor:wikilink', 70, ({ options }) => {
    if (options.wikilink === false) return null;
    const config: WikilinkPluginConfig = typeof options.wikilink === 'object' && options.wikilink ? options.wikilink : {};
    return wikilinkPlugin({
      getNotes: config.getNotes ?? defaultWikilinkGetNotes,
      resolve: config.resolve,
      maxSuggestions: config.maxSuggestions,
    });
  }),
  // A8：@mention（默认 DSTU searchNotes）
  officialEntry('editor:mention', 80, ({ options }) => {
    if (options.mention === false) return null;
    const config: MentionPluginConfig = typeof options.mention === 'object' && options.mention ? options.mention : {};
    return mentionPlugin({
      searchNotes: config.searchNotes,
      maxSuggestions: config.maxSuggestions,
      debounceMs: config.debounceMs,
    });
  }),
  // A6：图片 lightbox
  officialEntry('editor:image-lightbox', 90, ({ options }) => (enabled(options.imageLightbox) ? imageLightboxPlugin() : null)),
  // A7：Mod-K 链接快捷键（依赖 LinkTooltip feature）
  officialEntry('editor:link-keymap', 100, ({ options }) => (enabled(options.linkKeymap) ? linkKeymapPlugin() : null)),
  // pdfref:// / note:// 内部链接保留 href（Milkdown 默认把非 http 协议清空，回链与提及点击失效）
  officialEntry('editor:internal-link-schema', 110, () => internalLinkSchema),
  // r5-S4：pdfref:// 来源行回链（点击回到 PDF 对应页，复用 pdf-ref:open 链路）
  officialEntry('editor:pdf-ref', 120, ({ options }) => (enabled(options.pdfRefLink) ? pdfRefPlugin() : null)),
  // 讲义笔记的 [媒体@id:mm:ss] 锚点 / mediaref:// 链接 → 音视频跳到该时间
  officialEntry('editor:media-ref', 130, ({ options }) => (enabled(options.mediaRefLink) ? mediaRefPlugin() : null)),
  officialEntry('editor:columns', 140, ({ options }) => columnsPlugin(options.columns)),
  officialEntry('editor:block-identity', 150, () => blockIdentityPlugin()),
  // Notion 式块选择：Esc 选块、↑↓/Shift 扩选、Backspace 删除、Mod-D 复制
  officialEntry('editor:block-selection', 160, () => blockSelectionPlugin()),
  officialEntry('editor:typed-placeholder', 170, () => typedPlaceholderPlugin()),
  officialEntry('editor:canonical-document', 180, () => canonicalDocumentPlugin),
  officialEntry('editor:command-execute', 190, () => crepeExecuteCommand),
  officialEntry('editor:command-bindings', 200, () => crepeCommandBindingsPlugin),
  // 列表项「本项或后代已勾选」写成 data-has-checked（只有属性，供样式代替 :has()）
  officialEntry('editor:list-item-has-checked', 210, () => listItemHasCheckedPlugin()),
  // RemNote 式内联制卡胶囊指示器（默认关闭，仅在显式开启 inlineCards 时挂载）
  officialEntry('editor:inline-cards', 220, ({ options }) => (
    options.inlineCards ? inlineCardsPlugin(options.inlineCards) : null
  )),
];

for (const entry of officialEditorExtensionEntries) editorContributions.announce({ slot: 'editor.extensions', entry });

const ignoreErrors: EditorContributionError = () => {};

/**
 * 应用编辑器插件到 Crepe 实例（每个实例调用一次，须在 crepe.create() 之前）。
 * `entries` 缺省为官方插件栈；CrepeEditor 有 UI 内核时传入 `editor.extensions` 槽位。
 */
export const applyCrepePlugins = (
  crepe: Crepe,
  options: CrepePluginsOptions = {},
  entries: readonly SlotEntry<EditorExtensionContribution>[] = officialEditorExtensionEntries,
  onError: EditorContributionError = ignoreErrors,
  purpose: EditorPurpose = 'editor',
): void => {
  // RUST-FIX(RF-W18-diff-extension-purpose): omitted purposes means ['editor'].
  for (const group of resolveEditorExtensionGroups(
    editorEntriesForPurpose(entries, purpose), { options, purpose }, onError,
  )) crepe.editor.use(group);
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
  mediaRefLink: true,
  inlineCards: false,
};
