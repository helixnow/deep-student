import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CodeBlock sticky header contract', () => {
  const codeBlockShellSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/ui/CodeBlockShell.tsx'),
    'utf-8'
  );

  it('defines a sticky header shell with stuck-state markup for the code block toolbar', () => {
    expect(codeBlockShellSource).toContain('code-block-sticky-sentinel');
    expect(codeBlockShellSource).toContain('code-block-sticky-header--stuck');
    expect(codeBlockShellSource).toContain('data-stuck={isStuck ? \'true\' : \'false\'}');
  });
});
