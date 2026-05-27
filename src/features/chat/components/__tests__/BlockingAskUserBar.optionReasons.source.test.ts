import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'src/features/chat/components/input-bar/BlockingAskUserBar.tsx'),
  'utf-8'
);

describe('BlockingAskUserBar option reason source contract', () => {
  it('keeps backward-compatible option normalization while supporting optional reasons', () => {
    expect(source).toContain('reason?: unknown');
    expect(source).toContain('const options = useMemo<AskUserOptionViewModel[]>');
    expect(source).toContain('option.reason');
  });
});
