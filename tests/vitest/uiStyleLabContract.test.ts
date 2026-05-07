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
    expect(navigationConfigSource).toContain("'样式调试'");
    expect(modernSidebarSource).toContain("'ui-lab'");
    expect(appSource).toContain("renderViewLayer('ui-lab'");
  });

  it('loads a real style debugging page with the future primitive contract stated in-source', () => {
    expect(appSource).toContain('LazyStyleDebugPage');

    const styleDebugPageSource = readSource('src/components/style-lab/StyleDebugPage.tsx');
    expect(styleDebugPageSource).toContain('一个 token 系统');
    expect(styleDebugPageSource).toContain('少数稳定 primitive');
    expect(styleDebugPageSource).toContain('业务组件只组合');
    expect(styleDebugPageSource).toContain('NotionButton');
    expect(styleDebugPageSource).toContain('shad Button');
    expect(styleDebugPageSource).toContain('原生控件');
  });

  it('shows repeated component previews so humans can choose what to unify first', () => {
    const styleDebugPageSource = readSource('src/components/style-lab/StyleDebugPage.tsx');

    expect(styleDebugPageSource).toContain('重复组件预览');
    expect(styleDebugPageSource).toContain('Button 重复实现');
    expect(styleDebugPageSource).toContain('Form controls 重复实现');
    expect(styleDebugPageSource).toContain('Dialog / Sheet 重复实现');
    expect(styleDebugPageSource).toContain('Surface / Card 重复实现');
    expect(styleDebugPageSource).toContain('Sidebar row 重复实现');
    expect(styleDebugPageSource).toContain('Status badge 重复实现');
    expect(styleDebugPageSource).toContain('推荐统一入口');
    expect(styleDebugPageSource).toContain('当前混用入口');
    expect(styleDebugPageSource).toContain('旧写法样本');
  });

  it('keeps inventory and component list sections focused on DeepStudent instead of study-ui migration fixtures', () => {
    const styleDebugPageSource = readSource('src/components/style-lab/StyleDebugPage.tsx');

    expect(styleDebugPageSource).toContain('主应用包装入口');
    expect(styleDebugPageSource).toContain('当前可用主应用业务组件');
    expect(styleDebugPageSource).not.toContain('当前可用 study-ui 组件');
    expect(styleDebugPageSource).not.toContain('study-ui demo shell');
  });
});
