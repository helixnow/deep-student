import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('style debug component inventory contract', () => {
  const scanData = JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'src/components/style-lab/scan-data.json'),
      'utf-8',
    ),
  ) as {
    components: {
      DsButton: { refs: number };
      ShadButton: { refs: number };
      NativeButton: {
        refs: number;
        files: number;
        topFiles: string[];
        totalFileCount: number;
      };
    };
    migrationProgress: Array<{
      id: string;
      targetRefs: number;
      legacyRefs: number;
      total: number;
    }>;
  };
  const source = [
    'src/components/style-lab/StyleDebugPage.tsx',
    'src/components/style-lab/MigrationOverviewTab.tsx',
    'src/components/style-lab/ComponentCompareTab.tsx',
    'src/components/style-lab/TokenInspectorTab.tsx',
    'src/components/style-lab/MixedUsageTab.tsx',
    'src/components/style-lab/scan-data.json',
  ].map((file) => readFileSync(resolve(process.cwd(), file), 'utf-8')).join('\n');

  it('shows the current scan scope and refreshed inventory metrics on the style lab page', () => {
    expect(source).toContain('"totalFiles": 1293');
    expect(source).toContain('"tsxFiles": 521');
    expect(source).toContain('"cssFiles": 75');
    expect(source).toContain('"refs": 3772');
    expect(source).toContain('"files": 310');
    expect(source).toContain('"label": "CSS !important"');
    expect(source).toContain('"count": 1061');
  });

  it('removes deleted CardForge files from the native button inventory', () => {
    const nativeButton = scanData.components.NativeButton;
    const buttonProgress = scanData.migrationProgress.find(({ id }) => id === 'button');

    expect(nativeButton.refs).toBe(191);
    expect(nativeButton.files).toBe(70);
    expect(nativeButton.totalFileCount).toBe(70);
    expect(nativeButton.topFiles).toHaveLength(20);
    expect(nativeButton.topFiles).not.toContain(
      'src/components/anki/cardforge/engines/TaskController.examples.ts',
    );
    expect(nativeButton.topFiles).not.toContain(
      'src/components/anki/cardforge/hooks/useCardForge.ts',
    );
    expect(buttonProgress?.targetRefs).toBe(scanData.components.DsButton.refs);
    expect(buttonProgress?.legacyRefs).toBe(
      scanData.components.ShadButton.refs + nativeButton.refs,
    );
    expect(buttonProgress?.total).toBe(
      (buttonProgress?.targetRefs ?? 0) + (buttonProgress?.legacyRefs ?? 0),
    );
  });

  it('surfaces the current DeepStudent UI entry systems for human page-state review', () => {
    expect(source).toContain('DsButton (目标)');
    expect(source).toContain('shad Button (遗留)');
    expect(source).toContain('原生 button');
    expect(source).toContain('@/components/ui/shad/');
    expect(source).toContain('业务代码保留 shad 主路径');
  });

  it('lists the current component families and available DeepStudent component groups', () => {
    expect(source).toContain('Dialog / Overlay');
    expect(source).toContain('Form Controls');
    expect(source).toContain('Notification');
    expect(source).toContain('组件族迁移进度');
    expect(source).toContain('src/components/ui/app-menu');
    expect(source).toContain('src/features/chat/components/input-bar/InputBarUI.tsx');
  });

  it('has structured repeated component data with file paths and usage counts', () => {
    expect(source).toContain('"components":');
    expect(source).toContain('"topFiles":');
    expect(source).toContain('"refs":');
    expect(source).toContain('"files":');
    expect(source).toContain('"totalFileCount":');
  });

  it('keeps repeated component previews scoped to DeepStudent instead of study-ui migration fixtures', () => {
    const repeatedComponentSection = source.slice(source.indexOf('"components":'));

    expect(repeatedComponentSection).not.toContain('study-ui/');
    expect(repeatedComponentSection).not.toContain('study-ui ');
  });

  it('keeps inventory and component list sections scoped to DeepStudent instead of study-ui migration fixtures', () => {
    const inventorySection = source;

    expect(inventorySection).not.toContain('study-ui/');
    expect(inventorySection).not.toContain('study-ui ');
    expect(inventorySection).not.toContain('迁移实验入口');
  });

  it('supports priority filtering and search in repeated component previews', () => {
    expect(source).toContain('const [filter, setFilter]');
    expect(source).toContain('placeholder="搜索 token 名称…"');
    expect(source).toContain('filteredGroups');
  });

  it('provides action buttons for marking entries as cleaned', () => {
    expect(source).toContain('点击展开可查看涉及的文件列表');
    expect(source).toContain('const [expandedId, setExpandedId]');
    expect(source).toContain('const [showFiles, setShowFiles]');
  });

  it('includes Scroll and Icons duplicate groups', () => {
    expect(source).toContain("id: 'scroll'");
    expect(source).toContain("id: 'icons'");
    expect(source).toContain('CustomScrollArea');
    expect(source).toContain('LucideIcons');
    expect(source).toContain('PhosphorIcons');
  });
});
