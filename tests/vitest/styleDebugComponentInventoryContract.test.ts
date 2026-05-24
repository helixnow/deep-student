import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('style debug component inventory contract', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/style-lab/StyleDebugPage.tsx'), 'utf-8');

  it('shows the current scan scope and refreshed inventory metrics on the style lab page', () => {
    expect(source).toContain('1307 个产品源码文件');
    expect(source).toContain('496 个 TSX 文件');
    expect(source).toContain('184 refs / 66 files');
    expect(source).toContain('198 refs / 83 files');
    expect(source).toContain('1,621');
    expect(source).toContain('301 import files');
    expect(source).toContain('1560 JSX refs / 301 files');
  });

  it('surfaces the current DeepStudent UI entry systems for human page-state review', () => {
    expect(source).toContain('主应用现行入口');
    expect(source).toContain('主应用包装入口');
    expect(source).toContain('旧/业务直写入口');
    expect(source).toContain('src/components/ui/unified-sidebar');
    expect(source).toContain('src/components/ui/shad/*');
  });

  it('lists the current component families and available DeepStudent component groups', () => {
    expect(source).toContain('Dialog / Overlay / Menu');
    expect(source).toContain('Specialist widgets');
    expect(source).toContain('当前可用主应用组件');
    expect(source).toContain('当前可用主应用业务组件');
    expect(source).toContain('src/components/ui/app-menu');
    expect(source).toContain('src/components/notes');
    expect(source).toContain('src/components/learning-hub');
  });

  it('has structured repeated component data with file paths and usage counts', () => {
    expect(source).toContain('repeatedComponentData');
    expect(source).toContain('filePath:');
    expect(source).toContain('imports:');
    expect(source).toContain('refs:');
    expect(source).toContain('files:');
  });

  it('keeps repeated component previews scoped to DeepStudent instead of study-ui migration fixtures', () => {
    const repeatedComponentSection = source.slice(
      source.indexOf('const repeatedComponentData'),
      source.indexOf('const scanScopeRows')
    );

    expect(repeatedComponentSection).not.toContain('study-ui/');
    expect(repeatedComponentSection).not.toContain('study-ui ');
  });

  it('keeps inventory and component list sections scoped to DeepStudent instead of study-ui migration fixtures', () => {
    const inventorySection = source.slice(
      source.indexOf('const scanScopeRows'),
      source.indexOf('const reviewTargets')
    );

    expect(inventorySection).not.toContain('study-ui/');
    expect(inventorySection).not.toContain('study-ui ');
    expect(inventorySection).not.toContain('迁移实验入口');
  });

  it('supports priority filtering and search in repeated component previews', () => {
    expect(source).toContain('priorityFilter');
    expect(source).toContain('searchQuery');
    expect(source).toContain('高优先');
    expect(source).toContain('中优先');
    expect(source).toContain('低优先');
  });

  it('provides action buttons for marking entries as cleaned', () => {
    expect(source).toContain('标记已清理');
    expect(source).toContain('cleanedEntries');
    expect(source).toContain('style-lab-cleaned-entries');
  });

  it('includes Scroll and Icons duplicate groups', () => {
    expect(source).toContain('Scroll 重复实现');
    expect(source).toContain('Icons 重复实现');
    expect(source).toContain('CustomScrollArea');
    expect(source).toContain('lucide-react');
    expect(source).toContain('Phosphor');
  });
});
