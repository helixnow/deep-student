import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('McpToolsSection global bypass toggle contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/features/settings/components/McpToolsSection.tsx'),
    'utf-8'
  );

  it('uses the shared Switch control instead of an oversized icon button for global bypass', () => {
    expect(source).toContain("import { Switch } from '../ui/shad/Switch';");
    expect(source).toContain('<Switch');
    expect(source).toContain('checked={globalBypass}');
    expect(source).toContain('onCheckedChange={handleToggleGlobalBypass}');
    expect(source).not.toContain('className="!h-auto !w-auto"');
    expect(source).not.toContain('<ToggleRight className="h-8 w-8 text-green-500" />');
    expect(source).not.toContain('<ToggleLeft className="h-8 w-8 text-muted-foreground" />');
  });
});
