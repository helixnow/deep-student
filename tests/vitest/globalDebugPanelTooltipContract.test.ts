import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('GlobalDebugPanel tooltip contract', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/dev/GlobalDebugPanel.tsx'), 'utf-8');

  it('routes debug toggle tooltip through CommonTooltip', () => {
    expect(source).toContain("import { CommonTooltip } from '@/components/shared/CommonTooltip';");
    expect(source).not.toContain("from '../ui/shad/Tooltip'");
    expect(source).toContain('<CommonTooltip');
  });
});
