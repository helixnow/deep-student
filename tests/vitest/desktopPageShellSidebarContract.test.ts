import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('desktop page shell sidebar contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const learningHubPageSource = readFileSync(resolve(process.cwd(), 'src/features/learning-hub/LearningHubPage.tsx'), 'utf-8');
  const templatePageSource = readFileSync(resolve(process.cwd(), 'src/features/template-management/TemplateManagementApp.tsx'), 'utf-8');

  it('uses the shared desktop page shell sidebar target for learning hub and template management', () => {
    expect(appSource).toContain('const [desktopPageSidebarTarget, setDesktopPageSidebarTarget] = useState<HTMLDivElement | null>(null);');
    expect(appSource).toContain("currentView === 'learning-hub' || currentView === 'template-management'");
    expect(appSource).toContain('const shouldShowDesktopPageBackButton =');
    expect(appSource).toContain("currentView === 'learning-hub'");
    expect(appSource).toContain("currentView === 'template-management' && templateManagementShellBackVisible");
    expect(appSource).toContain('const desktopPageShellSidebarElement = useMemo(() => (');
    expect(appSource).toContain("{t('common:actions.backToHome')}");
    expect(appSource).toContain('ref={handleDesktopPageSidebarTarget}');
    expect(appSource).toContain('value={desktopShellSidebarPortalValue}');
  });

  it('keeps learning hub and template management wired to the shared portal consumer side', () => {
    expect(learningHubPageSource).toContain("const desktopShellSidebarTarget = useDesktopShellSidebarPortal('learning-hub');");
    expect(learningHubPageSource).toContain('quickAccessPortalTarget={desktopShellSidebarTarget}');
    expect(templatePageSource).toContain("const desktopShellSidebarTarget = useDesktopShellSidebarPortal('template-management');");
    expect(templatePageSource).toContain('onDesktopShellBackVisibilityChange?.(!isSelectingMode && activeTab === \'browse\')');
  });

  it('does not duplicate a second back-to-home button inside template management browse navigation', () => {
    expect(templatePageSource).not.toContain('onBackToHome?: () => void;');
    expect(templatePageSource).not.toContain('id="back-to-home"');
  });
});
