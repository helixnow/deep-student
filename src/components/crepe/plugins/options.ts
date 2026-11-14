import type { ColumnsOptions } from './columns/config';
import type { InlineCardsPluginConfig } from './inlineCards';
import type { WikilinkPluginConfig } from './wikilink/types';
import type { MentionPluginConfig } from './mention/types';

/**
 * 插件配置选项
 */
export interface CrepePluginsOptions {
  /** Registration always reads layouts; writes require the current host's confirmed grant. */
  columns?: ColumnsOptions;
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
  /**
   * 媒体时间戳回链（`[媒体@id:mm:ss]` 文本标记 / mediaref:// 链接 → 打开音视频并跳转），
   * 默认启用。装饰 + click 拦截 + media-ref:open 派发。
   */
  mediaRefLink?: boolean;
  /**
   * RemNote 式内联制卡指示器（`>>` 问答卡与 `{{...}}` 挖空卡）。
   * 默认在 defaultPluginOptions 中为 false，由 NotesCrepeEditor 显式开启。
   */
  inlineCards?: boolean | InlineCardsPluginConfig;
}
