import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const modernSidebarSource = readFileSync(
  resolve(process.cwd(), 'src/components/ModernSidebar.tsx'),
  'utf-8'
);
const appSource = readFileSync(
  resolve(process.cwd(), 'src/App.tsx'),
  'utf-8'
);

describe('ModernSidebar session indicators', () => {
  it('prioritizes streaming and unread indicators over hover archive controls', () => {
    const rightSlotBranch = modernSidebarSource.match(
      /rightSlot=\{isSessionStreaming \? \([\s\S]*?\) : \(\s*<span className="ml-1 shrink-0 text-\[11px\]/
    )?.[0] ?? '';

    expect(modernSidebarSource).toContain('useSessionSidebarIndicators');
    expect(rightSlotBranch).toContain('isSessionStreaming ? (');
    expect(rightSlotBranch).toContain('<SidebarStreamingIndicator />');
    expect(rightSlotBranch).toContain('hasUnreadAssistantReply ? (');
    expect(rightSlotBranch).toContain('<SidebarUnreadReplyDot />');
    expect(rightSlotBranch.indexOf('isSessionStreaming ?')).toBeLessThan(
      rightSlotBranch.indexOf('hasUnreadAssistantReply ?')
    );
    expect(rightSlotBranch.indexOf('hasUnreadAssistantReply ?')).toBeLessThan(
      rightSlotBranch.indexOf('isHovered ?')
    );
  });

  it('renders the streaming indicator as a rotating rounded ring and clears unread state on open', () => {
    const indicatorSource = modernSidebarSource.match(
      /function SidebarStreamingIndicator\(\) \{[\s\S]*?function SidebarUnreadReplyDot/
    )?.[0] ?? '';

    expect(indicatorSource).toContain('animate-[spin_1.1s_linear_infinite]');
    expect(indicatorSource).toContain('strokeLinecap="round"');
    expect(indicatorSource).toContain('transform="rotate(-90 8 8)"');
    expect(modernSidebarSource).toContain("const SIDEBAR_STREAMING_RING_TRACK = 'color-mix(in oklab, var(--shell-navigation-foreground) 14%, transparent)'");
    expect(modernSidebarSource).toContain("const SIDEBAR_STREAMING_RING_FOREGROUND = 'var(--shell-navigation-foreground)'");
    expect(indicatorSource).toContain('className="inline-flex h-3.5 w-3.5 items-center justify-center"');
    expect(indicatorSource).toContain('stroke={SIDEBAR_STREAMING_RING_TRACK}');
    expect(indicatorSource).toContain('stroke={SIDEBAR_STREAMING_RING_FOREGROUND}');
    expect(modernSidebarSource).toContain('markSessionSidebarIndicatorSeen(sessionId);');
  });

  it('syncs the current view and visibility into the session indicator context from App', () => {
    expect(appSource).toContain('setSessionSidebarViewContext');
    expect(appSource).toContain('const syncSessionSidebarContext = useCallback(() => {');
    expect(appSource).toContain('currentView');
    expect(appSource).toContain('activeSessionId: sessionManager.getCurrentSessionId()');
    expect(appSource).toContain("document.visibilityState === 'visible' && document.hasFocus()");
    expect(appSource).toContain('useEventRegistry([');
    expect(appSource).toContain("target: 'window'");
    expect(appSource).toContain("type: 'focus'");
    expect(appSource).toContain("type: 'blur'");
    expect(appSource).toContain("target: 'document'");
    expect(appSource).toContain("type: 'visibilitychange'");
  });
});
