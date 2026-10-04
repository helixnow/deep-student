import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('desktop page shell sidebar contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const learningHubPageSource = readFileSync(resolve(process.cwd(), 'src/features/learning-hub/LearningHubPage.tsx'), 'utf-8');
  const templatePageSource = readFileSync(resolve(process.cwd(), 'src/features/template-management/TemplateManagementApp.tsx'), 'utf-8');

  it('uses the shared desktop page shell sidebar target for learning hub', () => {
    expect(appSource).toContain('const [desktopPageSidebarTarget, setDesktopPageSidebarTarget] = useState<HTMLDivElement | null>(null);');
    expect(appSource).toContain("const shouldShowDesktopPageBackButton = currentView === 'learning-hub';");
    expect(appSource).toContain('const desktopPageShellSidebarElement = useMemo(() => (');
    expect(appSource).toContain("{t('common:actions.backToHome')}");
    expect(appSource).toContain('ref={handleDesktopPageSidebarTarget}');
    expect(appSource).toContain('value={desktopShellSidebarPortalValue}');
    expect(learningHubPageSource).toContain("const desktopShellSidebarTarget = useDesktopShellSidebarPortal('learning-hub');");
    expect(learningHubPageSource).toContain('quickAccessPortalTarget={desktopShellSidebarTarget}');
  });

  it('keeps template management on the main sidebar as the flashcards hub templates tab', () => {
    // 模板并入闪卡中心（2026-10）：分区切换期间主侧栏保持不变，模板页用页内顶部导航
    expect(appSource).not.toContain("currentView === 'learning-hub' || currentView === 'template-management'");
    expect(appSource).not.toContain('templateManagementShellBackVisible');
    expect(templatePageSource).not.toContain('useDesktopShellSidebarPortal');
    expect(templatePageSource).not.toContain('onDesktopShellBackVisibilityChange');
    expect(templatePageSource).toContain('wb-tm-nav');
  });

  it('does not duplicate a second back-to-home button inside template management browse navigation', () => {
    expect(templatePageSource).not.toContain('onBackToHome?: () => void;');
    expect(templatePageSource).not.toContain('id="back-to-home"');
  });
});
