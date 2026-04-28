import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('style debug component inventory contract', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/style-lab/StyleDebugPage.tsx'), 'utf-8');

  it('shows the current scan scope and refreshed inventory metrics on the style lab page', () => {
    expect(source).toContain('1188 个产品源码文件');
    expect(source).toContain('520 个 TSX 文件');
    expect(source).toContain('184 refs / 66 files');
    expect(source).toContain('198 refs / 83 files');
    expect(source).toContain('1,621');
    expect(source).toContain('301 import files');
    expect(source).toContain('1560 JSX refs / 301 files');
  });

  it('surfaces the three active UI entry systems for human page-state review', () => {
    expect(source).toContain('主应用现行入口');
    expect(source).toContain('迁移实验入口');
    expect(source).toContain('旧/业务直写入口');
    expect(source).toContain('study-ui/src/components/ui/*');
    expect(source).toContain('src/components/ui/shad/*');
  });

  it('lists the current component families and available component groups', () => {
    expect(source).toContain('Dialog / Overlay / Menu');
    expect(source).toContain('Specialist widgets');
    expect(source).toContain('当前可用主应用组件');
    expect(source).toContain('当前可用 study-ui 组件');
    expect(source).toContain('src/components/ui/app-menu');
    expect(source).toContain('study-ui/src/components/shell');
  });
});
