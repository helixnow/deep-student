/**
 * Markdown pipeline extension points (FE-B6); the value types and SlotMap entries are the kernel contract
 * `@/ui-kernel/contracts/markdown`, exported by the SDK.
 *
 * The official steps load with MarkdownRenderer (not at startup) and announce themselves to
 * `markdownPipelineContributions`; `dstu.ui.content` declares the slots and contributes what is announced. Without a
 * UI kernel (lightweight windows) MarkdownRenderer applies the same official table directly.
 */
import type { MarkdownRehypeContribution, MarkdownRemarkContribution, SlotDefinition, SlotEntry } from '@/ui-sdk';
import { createLazyContributionPoint } from '@/ui-sdk/lazy';

export type {
  MarkdownPlugin,
  MarkdownPluginContribution,
  MarkdownRehypeContext,
  MarkdownRehypeContribution,
  MarkdownRemarkContext,
  MarkdownRemarkContribution,
} from '@/ui-sdk';

export const MARKDOWN_PIPELINE_SLOTS: readonly SlotDefinition[] = [
  { name: 'markdown.remark', cardinality: 'list', description: 'Markdown remark 插件：按 order 依次执行' },
  { name: 'markdown.rehype', cardinality: 'list', description: 'Markdown rehype 插件：按 order 依次执行；order < 20 的输出经过 sanitize' },
];

export interface MarkdownPipelineAnnouncement {
  slot: 'markdown.remark' | 'markdown.rehype';
  entry: SlotEntry<MarkdownRemarkContribution> | SlotEntry<MarkdownRehypeContribution>;
}

export const markdownPipelineContributions = createLazyContributionPoint<MarkdownPipelineAnnouncement>('markdown pipeline');
