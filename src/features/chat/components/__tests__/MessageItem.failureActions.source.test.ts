import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const messageItemSource = readFileSync(
  resolve(process.cwd(), 'src/features/chat/components/MessageItem.tsx'),
  'utf-8'
);

describe('MessageItem failure actions source', () => {
  it('detects zero-output assistant failures separately from partial-output failures', () => {
    expect(messageItemSource).toContain('hasZeroOutputFailure');
    expect(messageItemSource).toContain('hasConsumableAssistantContent');
  });

  it('shows a dedicated zero-output failure bar with retry and error details affordances', () => {
    expect(messageItemSource).toContain('showActions && !isInlineEditing && !isWaitingForContent && hasZeroOutputFailure');
    expect(messageItemSource).toContain("text-muted-foreground hover:bg-muted/50 hover:text-foreground");
    expect(messageItemSource).toContain('messageItem.failure.retry');
    expect(messageItemSource).not.toContain('messageItem.failure.viewErrorDetails');
    expect(messageItemSource).not.toContain('messageItem.failure.hideErrorDetails');
    expect(messageItemSource).not.toContain('setShowFailureDetails(');
    expect(messageItemSource).toContain('!hasZeroOutputFailure');
  });

  it('renders reconnect progress inline with the assistant message body', () => {
    expect(messageItemSource).toContain('message?._meta?.streamReconnect');
    expect(messageItemSource).toContain('const shouldShowReconnectInline = !isUser && Boolean(streamReconnectState);');
    expect(messageItemSource).toContain("t('messageItem.reconnect.inline'");
    expect(messageItemSource).toContain('if (shouldShowReconnectInline && streamReconnectState)');
    expect(messageItemSource).toContain('TextShimmer className="text-md leading-relaxed tracking-wide text-foreground"');
    expect(messageItemSource).toContain('{reconnectInlineText}');
    expect(messageItemSource).not.toContain('reconnect...(');
    expect(messageItemSource).not.toContain('PulseDot className="w-1.5 h-1.5 text-foreground/60"');
  });
});
