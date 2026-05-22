import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat v2 thread width alignment contract', () => {
  const threadContentShellSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/ui/ThreadContentShell.tsx'),
    'utf-8'
  );
  const messageItemSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/MessageItem.tsx'),
    'utf-8'
  );
  const messageListSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/MessageList.tsx'),
    'utf-8'
  );
  const threadEmptyStateShellSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/ui/ThreadEmptyStateShell.tsx'),
    'utf-8'
  );
  const chatContainerSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/ChatContainer.tsx'),
    'utf-8'
  );
  const beautifySource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/styles/chat-beautify.css'),
    'utf-8'
  );
  const inputBarUiSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/InputBarUI.tsx'),
    'utf-8'
  );
  const inputBarV2Source = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/InputBarV2.tsx'),
    'utf-8'
  );

  it('defines a shared shell for thread-aligned surfaces', () => {
    expect(threadContentShellSource).toContain('data-slot="thread-content-shell"');
    expect(threadContentShellSource).toContain("'mx-auto w-full'");
    expect(threadContentShellSource).toContain("width === 'full' ? 'max-w-full' : 'max-w-thread'");
  });

  it('routes key thread-aligned surfaces through the shared shell', () => {
    expect(messageItemSource).toContain('<ThreadContentShell');
    expect(messageItemSource).toContain("width={isMultiVariant ? 'full' : 'thread'}");
    expect(messageListSource).toContain('<ThreadEmptyStateShell');
    expect(threadEmptyStateShellSource).toContain('data-slot="thread-empty-state"');
    expect(threadEmptyStateShellSource).toContain('data-slot="thread-empty-primary-action"');
    expect(chatContainerSource).toContain('<ThreadContentShell');
    expect(chatContainerSource).toContain('data-slot="chat-loading-shell"');
    expect(chatContainerSource).toContain('data-slot="chat-loading-messages"');
    expect(chatContainerSource).toContain('data-slot="chat-loading-composer"');
    expect(chatContainerSource).toContain('chat-loading-shell__composer-panel');
    expect(chatContainerSource).toContain('<ChatSkeleton />');
    expect(beautifySource).toContain('.chat-v2 [data-slot="chat-loading-shell"]');
    expect(beautifySource).toContain('.chat-v2 .chat-loading-shell__composer-panel');
    expect(beautifySource).toContain('--unified-input-shell-surface: var(--surface-root);');
    expect(inputBarUiSource).toContain('<ThreadContentShell>');
    expect(inputBarV2Source).toContain('<ThreadContentShell>');
  });
});
