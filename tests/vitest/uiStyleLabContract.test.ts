import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf-8');

describe('UI style lab navigation contract', () => {
  const navigationTypesSource = readSource('src/types/navigation.ts');
  const canonicalViewSource = readSource('src/app/navigation/canonicalView.ts');
  const navigationConfigSource = readSource('src/config/navigation.ts');
  const modernSidebarSource = readSource('src/components/ModernSidebar.tsx');
  const appSource = readSource('src/App.tsx');

  it('registers ui-lab as a supported app view and sidebar destination', () => {
    expect(navigationTypesSource).toContain("| 'ui-lab'");
    expect(canonicalViewSource).toContain("'ui-lab'");
    expect(navigationConfigSource).toContain("view: 'ui-lab'");
    expect(navigationConfigSource).toContain("'sidebar:navigation.ui_lab'");
    expect(modernSidebarSource).toContain("'ui-lab'");
    expect(appSource).toContain("renderViewLayer('ui-lab'");
  });

  const styleDebugSource = [
    'src/components/style-lab/StyleDebugPage.tsx',
    'src/components/style-lab/MigrationOverviewTab.tsx',
    'src/components/style-lab/ComponentCompareTab.tsx',
    'src/components/style-lab/TokenInspectorTab.tsx',
    'src/components/style-lab/MixedUsageTab.tsx',
  ].map(readSource).join('\n');

  it('loads a real style debugging page with the current primitive contract stated in-source', () => {
    expect(appSource).toContain('LazyStyleDebugPage');

    expect(styleDebugSource).toContain('UI 迁移工作台');
    expect(styleDebugSource).toContain('真实扫描数据驱动');
    expect(styleDebugSource).toContain('DsButton (目标)');
    expect(styleDebugSource).toContain('shad Button (遗留)');
    expect(styleDebugSource).toContain('原生 button');
  });

  it('shows repeated component previews so humans can choose what to unify first', () => {
    expect(styleDebugSource).toContain('组件族迁移进度');
    expect(styleDebugSource).toContain('Button');
    expect(styleDebugSource).toContain('Form Controls');
    expect(styleDebugSource).toContain('Dialog / Overlay');
    expect(styleDebugSource).toContain('Sidebar');
    expect(styleDebugSource).toContain('Notification');
    expect(styleDebugSource).toContain('推荐入口');
    expect(styleDebugSource).toContain('待收敛入口');
  });

  it('keeps inventory and component list sections focused on DeepStudent instead of study-ui migration fixtures', () => {
    expect(styleDebugSource).toContain('DeepStudent');
    expect(styleDebugSource).toContain('业务代码保留 shad 主路径');
    expect(styleDebugSource).not.toContain('当前可用 study-ui 组件');
    expect(styleDebugSource).not.toContain('study-ui demo shell');
  });
});
