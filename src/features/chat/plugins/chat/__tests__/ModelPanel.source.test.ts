import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ModelPanel source contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/plugins/chat/ModelPanel.tsx'),
    'utf-8'
  );

  it('renders the single-select model list grouped by vendor before models', () => {
    expect(source).toContain('const vendorGroups = useMemo(() => {');
    expect(source).toContain('vendorGroups.map((group) => {');
    expect(source).toContain('group.vendorName');
    expect(source).toContain('group.models.map(renderModelOption)');
  });
});
