import type { PluggableList } from 'unified';

/**
 * Markdown pipeline extension points (FE-B6): ordered remark / rehype plugin lists that MarkdownRenderer applies.
 *
 * Each contribution turns the inputs of one render into a plugin (or `[plugin, options]`), or null to sit out.
 * Remark contributions run in `order`, followed by the renderer's per-instance `extraRemarkPlugins`. The official
 * rehype steps are raw HTML (10), sanitize (20) and search highlights (30): a rehype contribution ordered below 20 has
 * its output sanitized.
 */
export type MarkdownPlugin = PluggableList[number];

export interface MarkdownRemarkContext {
  /** Citation markers (`[知识库-1]` …) are enabled for this render. */
  citations: boolean;
}

export interface MarkdownRehypeContext {
  /** In-message search query (untrimmed; empty when not searching). */
  searchQuery: string;
}

export interface MarkdownPluginContribution<C> {
  create(context: C): MarkdownPlugin | null;
}

export type MarkdownRemarkContribution = MarkdownPluginContribution<MarkdownRemarkContext>;
export type MarkdownRehypeContribution = MarkdownPluginContribution<MarkdownRehypeContext>;

declare module '../slot-map' {
  interface SlotMap {
    'markdown.remark': MarkdownRemarkContribution;
    'markdown.rehype': MarkdownRehypeContribution;
  }
}
