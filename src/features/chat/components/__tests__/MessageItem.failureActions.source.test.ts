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
    expect(messageItemSource).toContain('messageItem.failure.viewErrorDetails');
    expect(messageItemSource).toContain('messageItem.failure.retry');
    expect(messageItemSource).toContain('!hasZeroOutputFailure');
  });
});
