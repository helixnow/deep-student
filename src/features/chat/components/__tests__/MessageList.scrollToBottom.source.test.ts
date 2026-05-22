import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('MessageList scroll-to-bottom source contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/MessageList.tsx'),
    'utf-8'
  );

  it('keeps the floating control as an icon-only jump-to-bottom affordance', () => {
    expect(source).toContain("t('messageList.scrollToBottom'");
    expect(source).toContain("data-slot=\"message-list-scroll-to-bottom\"");
    expect(source).toContain("import Z_INDEX from '@/config/zIndex';");
    expect(source).toContain('aria-label={scrollToBottomLabel}');
    expect(source).toContain("title={scrollToBottomLabel}");
    expect(source).toContain('className="pointer-events-none absolute inset-x-0 bottom-2 px-4 md:bottom-3 md:px-8"');
    expect(source).toContain('style={{ zIndex: Z_INDEX.inputBar - 10 }}');
    expect(source).toContain('<ThreadContentShell className="pointer-events-none overflow-visible">');
    expect(source).toContain('className="t-panel-slide ml-auto w-fit"');
    expect(source).toContain("data-open={showScrollToBottom ? 'true' : 'false'}");
    expect(source).toContain('aria-hidden={!showScrollToBottom}');
    expect(source).toContain("['--panel-translate-y' as string]: '12px'");
    expect(source).toContain("['--panel-open-dur' as string]: '180ms'");
    expect(source).toContain("['--panel-close-dur' as string]: '140ms'");
    expect(source).toContain('tabIndex={showScrollToBottom ? 0 : -1}');
    expect(source).toContain("'pointer-events-auto ml-auto flex h-10 w-10 items-center justify-center rounded-full'");
    expect(source).toContain("'border border-[color:var(--button-utility-border)] bg-[color:var(--button-utility-surface)]'");
    expect(source).toContain("'text-[color:var(--button-utility-foreground)] transition-colors duration-150'");
    expect(source).toContain("'hover:border-[color:var(--button-utility-border)] hover:bg-[color:var(--button-utility-hover)] hover:text-[color:var(--button-utility-foreground)]'");
    expect(source).toContain("'active:bg-[color:var(--button-utility-active)]'");
    expect(source).toContain('<ArrowDown size={16} weight="bold" />');
    expect(source).not.toContain('<span>新内容</span>');
    expect(source).not.toContain('shadow-md');
    expect(source).not.toContain('hover:shadow-lg');
    expect(source).not.toContain('<ThreadContentShell className="pointer-events-none px-4 md:px-8">');
    expect(source).not.toContain("'hover:bg-[var(--interactive-hover)] hover:text-foreground'");
    expect(source).not.toContain("'hover:border-[color:var(--button-utility-border)] hover:bg-[color:var(--button-utility-hover)] hover:text-[color:var(--text-primary)]'");
  });

  it('shows the control based on scroll position rather than streaming state alone', () => {
    expect(source).toContain("viewportElement.addEventListener('scroll', syncScrollState");
    expect(source).toContain('setShowScrollToBottom(!nearBottom);');
    expect(source).toContain("data-open={showScrollToBottom ? 'true' : 'false'}");
    expect(source).not.toContain('{showScrollToBottom && isStreaming && (');
  });

  it('uses transitions-dev panel reveal semantics for fade-out', () => {
    expect(source).toContain('className="t-panel-slide ml-auto w-fit"');
    expect(source).toContain('aria-hidden={!showScrollToBottom}');
  });
});
