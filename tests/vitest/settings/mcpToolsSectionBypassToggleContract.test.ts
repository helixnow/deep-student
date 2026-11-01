import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

describe('McpToolsSection global bypass toggle contract', () => {
  // McpToolsSection 已拆分到 mcp-tools/ 子模块：入口 + 全部子模块拼接后断言
  const componentsDir = resolve(process.cwd(), 'src/features/settings/components');
  const source = [
    resolve(componentsDir, 'McpToolsSection.tsx'),
    ...readdirSync(resolve(componentsDir, 'mcp-tools')).sort().map((file) => resolve(componentsDir, 'mcp-tools', file)),
  ].map((file) => readFileSync(file, 'utf-8')).join('\n');

  it('uses the shared Switch control instead of an oversized icon button for global bypass', () => {
    expect(source).toContain("import { Switch } from '@/components/ui/shad/Switch';");
    expect(source).toContain('<Switch');
    expect(source).toContain('checked={globalBypass}');
    expect(source).toContain('onCheckedChange={handleToggleGlobalBypass}');
    expect(source).not.toContain('className="!h-auto !w-auto"');
    expect(source).not.toContain('<ToggleRight className="h-8 w-8 text-green-500" />');
    expect(source).not.toContain('<ToggleLeft className="h-8 w-8 text-muted-foreground" />');
  });
});
