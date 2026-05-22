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

  it('keeps thinking content expanded by default and only applies sticky behavior while expanded', () => {
    expect(activityTimelineSource).toContain('const [isExpanded, setIsExpanded] = useState(true);');
    expect(activityTimelineSource).toContain('const [preserveStickyOnCollapse, setPreserveStickyOnCollapse] = useState(false);');
    expect(activityTimelineSource).toContain('const shouldStickSummary = hasContent && (isExpanded || preserveStickyOnCollapse);');
    expect(activityTimelineSource).toContain('thinking-summary-sticky sticky top-0 z-10');
  });

  it('preserves the sticky summary when the user collapses it from the pinned top position', () => {
    expect(activityTimelineSource).toContain('setPreserveStickyOnCollapse(!nextExpanded && pinnedAtTop);');
    expect(activityTimelineSource).toContain('const shouldStickSummary = hasContent && (isExpanded || preserveStickyOnCollapse);');
  });

  it('uses the full summary row as the thinking trigger without shrinking the tap target', () => {
    expect(activityTimelineSource).toMatch(/w-full !justify-start !px-0 rounded-\[var\(--radius-shell-control\)\] .* group/);
    expect(activityTimelineSource).toContain('thinking-summary-trigger w-full !justify-start !px-0');
    expect(activityTimelineCssSource).toContain('.thinking-summary-trigger:hover,');
    expect(activityTimelineCssSource).toContain('background: transparent;');
    expect(activityTimelineSource).not.toContain('group-hover:translate-x-0.5');
  });

  it('scopes the sticky treatment to the full chat-column summary row', () => {
    expect(activityTimelineSource).toMatch(/thinking-summary-sticky sticky top-0 z-10 -ml-\[28px\] -mr-3 pl-\[28px\] pr-3 pt-1/);
    expect(activityTimelineSource).toContain('flex w-full max-w-full items-center');
  });

  it('uses a semantic solid band with a bottom fade aligned to the shared scroll-fade curve', () => {
    expect(activityTimelineCssSource).toContain('.thinking-summary-sticky::before');
    expect(activityTimelineCssSource).toContain('inset: 0;');
    expect(activityTimelineCssSource).toContain('background: var(--surface-panel-strong);');
    expect(activityTimelineCssSource).toContain('.thinking-summary-sticky::after');
    expect(activityTimelineCssSource).toContain('bottom: -16px;');
    expect(activityTimelineCssSource).toContain('color-mix(in srgb, var(--surface-panel-strong) 96%, transparent) 0%');
    expect(activityTimelineCssSource).toContain('color-mix(in srgb, var(--surface-panel-strong) 72%, transparent) 38%');
    expect(activityTimelineCssSource).not.toContain('backdrop-blur-sm');
    expect(activityTimelineSource).not.toContain('border-[color:var(--surface-divider)]');
  });

  it('keeps list markers inside the visible thinking-chain viewport', () => {
    expect(activityTimelineSource).toContain('className="py-1.5 pl-2 pr-1 text-gray-500 dark:text-gray-400 text-xs leading-snug overflow-y-auto"');
    expect(thinkingChainCssSource).toContain('padding-left: 1.5rem !important;');
    expect(thinkingChainCssSource).toContain('list-style-position: outside;');
  });

  it('leaves safety space between the sticky fade and the following thinking content', () => {
    expect(activityTimelineSource).toContain("className={cn('overflow-hidden', shouldStickSummary && 'pt-3')}");
  });
});
