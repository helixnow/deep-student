import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CodeBlock sticky header contract', () => {
  const codeBlockShellSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/ui/CodeBlockShell.tsx'),
    'utf-8'
  );

  it('defines pinned and exiting sticky phases for the code block toolbar', () => {
    expect(codeBlockShellSource).toContain('const wrapperRect = wrapper.getBoundingClientRect();');
    expect(codeBlockShellSource).toContain('const remainingBodyHeight = wrapperRect.bottom - (rootTop + headerHeight);');
    expect(codeBlockShellSource).toContain('const stickyExitThreshold = headerHeight > 0 ? headerHeight : 16;');
    expect(codeBlockShellSource).toContain('code-block-sticky-header--stuck');
    expect(codeBlockShellSource).toContain('code-block-sticky-header--exiting');
    expect(codeBlockShellSource).toContain('data-stuck={isStuck ? \'true\' : \'false\'}');
    expect(codeBlockShellSource).toContain("data-sticky-phase={isExitingSticky ? 'exiting' : isStuck ? 'pinned' : 'resting'}");
  });
});
