import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('activity timeline thinking summary source', () => {
  const activityTimelineSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/ActivityTimeline/ActivityTimeline.tsx'),
    'utf-8'
  );
  const activityTimelineCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/ActivityTimeline/ActivityTimeline.css'),
    'utf-8'
  );
  const thinkingChainCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/renderers/ThinkingChain.css'),
    'utf-8'
  );
  const chatCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/styles/chat.css'),
    'utf-8'
  );

  it('keeps completed thinking auto-collapsed by default and never pins the summary', () => {
    expect(activityTimelineSource).toContain('function readAutoCollapseSetting(): boolean');
    expect(activityTimelineSource).toContain('return !autoCollapseEnabled;');
    expect(activityTimelineSource).toContain('setIsExpanded(false);');
    expect(activityTimelineSource).not.toContain('preserveStickyOnCollapse');
    expect(activityTimelineSource).not.toContain('shouldStickSummary');
    expect(activityTimelineSource).not.toContain('thinking-summary-sticky');
    expect(activityTimelineSource).not.toContain('sticky top-0');
  });

  it('uses a body-aligned summary row as the thinking trigger', () => {
    expect(activityTimelineSource).toContain('thinking-summary-trigger activity-timeline-thinking-trigger activity-timeline-summary w-full !h-7 !min-h-0 !justify-start !gap-1.5 !px-0 !py-0 !leading-7');
    expect(activityTimelineSource).toContain('text-muted-foreground hover:text-foreground');
    expect(activityTimelineCssSource).toContain('.thinking-summary-trigger:hover,');
    expect(activityTimelineCssSource).toContain('background: transparent;');
    expect(activityTimelineSource).not.toContain('group-hover:translate-x-0.5');
  });

  it('keeps the summary row in normal document flow without negative timeline offsets', () => {
    expect(activityTimelineSource).toContain('thinking-summary-row flex w-full max-w-full items-center');
    expect(activityTimelineSource).not.toContain('thinking-summary-sticky');
    expect(activityTimelineSource).not.toContain('-ml-[28px]');
    expect(activityTimelineSource).not.toContain('pl-[28px]');
    expect(activityTimelineSource).not.toContain('-ml-[22px]');
  });

  it('keeps the thinking summary transparent so it matches adjacent timeline entries', () => {
    expect(activityTimelineCssSource).not.toContain('.thinking-summary-sticky');
    expect(activityTimelineCssSource).not.toContain('.thinking-summary-row {');
    expect(activityTimelineCssSource).not.toContain('--surface-panel-strong');
    expect(activityTimelineSource).not.toContain('border-[color:var(--surface-divider)]');
  });

  it('keeps list markers inside the visible thinking-chain viewport', () => {
    expect(activityTimelineSource).toContain('className="activity-timeline-thinking-content py-2 pl-2 pr-1 text-gray-500 dark:text-gray-400"');
    expect(thinkingChainCssSource).toContain('padding-left: 1.5rem !important;');
    expect(thinkingChainCssSource).toContain('font-size: var(--chat-activity-detail-font-size, var(--chat-body-font-size));');
    expect(thinkingChainCssSource).toContain('font-weight: var(--chat-activity-detail-font-weight, var(--chat-body-font-weight));');
    expect(thinkingChainCssSource).toContain('list-style-position: outside;');
  });

  it('keeps thinking-chain details in normal flow under the summary row', () => {
    expect(activityTimelineSource).toContain('className="activity-timeline-thinking-details overflow-hidden"');
  });

  it('keeps timeline-to-answer spacing from stacking with markdown first-block margins', () => {
    expect(activityTimelineSource).toContain('activity-timeline__node flex gap-1.5');
    expect(activityTimelineSource).toContain("cn('activity-timeline'");
    expect(chatCssSource).toContain('--chat-activity-summary-font-size: var(--chat-body-font-size);');
    expect(chatCssSource).toContain('--chat-activity-detail-font-size: var(--chat-body-font-size);');
    expect(chatCssSource).toContain('--chat-activity-tool-detail-font-size: var(--chat-md-compact-font-size);');
    expect(chatCssSource).toContain('--chat-activity-status-font-size: var(--font-size-sm);');
    expect(activityTimelineCssSource).toContain('font-size: var(--chat-activity-summary-font-size, var(--chat-body-font-size, 1rem));');
    expect(activityTimelineCssSource).toContain('font-size: var(--chat-activity-detail-font-size, var(--chat-body-font-size, 1rem));');
    expect(activityTimelineCssSource).toContain('font-size: var(--chat-activity-tool-detail-font-size, var(--chat-md-compact-font-size, 0.9375rem));');
    expect(activityTimelineCssSource).toContain('margin-block: 0 var(--chat-activity-content-gap, 0.75rem);');
    expect(activityTimelineCssSource).toContain('padding-bottom: var(--chat-activity-node-gap, 0.75rem);');
    expect(activityTimelineCssSource).toContain('.activity-timeline__node:last-child');
    expect(activityTimelineCssSource).toContain('.activity-timeline + .block-renderer .markdown-content > p:first-child');
  });
});
