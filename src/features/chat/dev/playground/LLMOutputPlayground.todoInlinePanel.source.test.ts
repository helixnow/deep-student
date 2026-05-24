import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('LLMOutputPlayground task panel source contract', () => {
  const playgroundSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/dev/playground/LLMOutputPlayground.tsx'),
    'utf-8',
  );
  const inputBarUiSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/InputBarUI.tsx'),
    'utf-8',
  );
  const inputBarTypesSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/types.ts'),
    'utf-8',
  );

  it('mounts the shared task panel instead of a standalone todo inline card', () => {
    expect(playgroundSource).toContain('AgentTaskPanel');
    expect(playgroundSource).not.toContain('playgroundTodoSample');
    expect(playgroundSource).not.toContain('composerInlinePanel');
    expect(playgroundSource).not.toContain('TodoListPanel');
  });

  it('exposes a composer inline panel slot on the input bar', () => {
    expect(inputBarTypesSource).toContain('composerInlinePanel?: React.ReactNode');
    expect(inputBarUiSource).toContain('composerInlinePanel');
    expect(inputBarUiSource).toContain('{composerInlinePanel}');
    expect(inputBarUiSource).toContain('pendingApprovalRequest');
  });
});
