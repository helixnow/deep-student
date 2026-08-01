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

  it('keeps completed thinking auto-collapsed by default and only applies sticky behavior while expanded', () => {
    expect(activityTimelineSource).toContain('function readAutoCollapseSetting(): boolean');
    expect(activityTimelineSource).toContain('return !autoCollapseEnabled;');
    expect(activityTimelineSource).toContain('setIsExpanded(false);');
    expect(activityTimelineSource).toContain('const [preserveStickyOnCollapse, setPreserveStickyOnCollapse] = useState(false);');
    expect(activityTimelineSource).toContain('const shouldStickSummary = hasContent && (isExpanded || preserveStickyOnCollapse);');
    expect(activityTimelineSource).toContain('thinking-summary-sticky sticky top-0 z-10');
  });

  it('preserves the sticky summary when the user collapses it from the pinned top position', () => {
    expect(activityTimelineSource).toContain('setPreserveStickyOnCollapse(!nextExpanded && pinnedAtTop);');
    expect(activityTimelineSource).toContain('const shouldStickSummary = hasContent && (isExpanded || preserveStickyOnCollapse);');
  });

  it('uses the compact aligned summary row as the thinking trigger', () => {
    expect(activityTimelineSource).toContain('thinking-summary-trigger w-full !h-5 !min-h-0 !justify-start !gap-1.5 !px-0 !py-0 !leading-5');
    expect(activityTimelineSource).toContain('text-sm text-muted-foreground hover:text-foreground');
    expect(activityTimelineCssSource).toContain('.thinking-summary-trigger:hover,');
    expect(activityTimelineCssSource).toContain('background: transparent;');
    expect(activityTimelineSource).not.toContain('group-hover:translate-x-0.5');
  });

  it('scopes the sticky treatment without negative timeline offsets', () => {
    expect(activityTimelineSource).toContain('thinking-summary-sticky sticky top-0 z-10 -mr-3 pr-3');
    expect(activityTimelineSource).not.toContain('-ml-[28px]');
    expect(activityTimelineSource).not.toContain('pl-[28px]');
    expect(activityTimelineSource).not.toContain('-ml-[22px]');
    expect(activityTimelineSource).toContain('flex w-full max-w-full items-center');
  });

  it('keeps the sticky summary transparent so it matches adjacent timeline entries', () => {
    expect(activityTimelineCssSource).not.toContain('.thinking-summary-sticky::before');
    expect(activityTimelineCssSource).not.toContain('.thinking-summary-sticky::after');
    expect(activityTimelineCssSource).not.toContain('.thinking-summary-row {');
    expect(activityTimelineCssSource).not.toContain('--surface-panel-strong');
    expect(activityTimelineSource).not.toContain('border-[color:var(--surface-divider)]');
  });

  it('keeps list markers inside the visible thinking-chain viewport', () => {
    expect(activityTimelineSource).toContain('className="py-1.5 pl-2 pr-1 text-gray-500 dark:text-gray-400 text-xs leading-snug"');
    expect(thinkingChainCssSource).toContain('padding-left: 1.5rem !important;');
    expect(thinkingChainCssSource).toContain('list-style-position: outside;');
  });

  it('leaves compact safety space between the sticky row and the following thinking content', () => {
    expect(activityTimelineSource).toContain("className={cn('overflow-hidden', shouldStickSummary && 'pt-2')}");
  });

  it('keeps timeline-to-answer spacing from stacking with markdown first-block margins', () => {
    expect(activityTimelineSource).toContain('activity-timeline__node flex gap-1.5');
    expect(activityTimelineSource).toContain("cn('activity-timeline text-sm'");
    expect(activityTimelineCssSource).toContain('margin-block: 0 calc(var(--chat-md-paragraph-gap, 0.9rem) * 0.42);');
    expect(activityTimelineCssSource).toContain('.activity-timeline__node:last-child');
    expect(activityTimelineCssSource).toContain('.activity-timeline + .block-renderer .markdown-content > p:first-child');
  });
});
