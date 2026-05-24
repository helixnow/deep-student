import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf-8');

describe('sandbox workbench navigation contract', () => {
  const navigationTypesSource = readSource('src/types/navigation.ts');
  const lazyComponentsSource = readSource('src/lazyComponents.tsx');
  const appSource = readSource('src/App.tsx');
  const chatPageSource = readSource('src/features/chat/pages/ChatV2Page.tsx');
  const launchSource = readSource('src/features/sandbox/launchSandboxWorkbench.ts');
  const sandboxWorkbenchPagePath = resolve(
    process.cwd(),
    'src/features/sandbox/pages/SandboxWorkbenchPage.tsx'
  );

  it('registers sandbox-workbench as a supported app view', () => {
    expect(navigationTypesSource).toContain("| 'sandbox-workbench'");
  });

  it('exposes a lazy workbench entry point and renders it from App', () => {
    expect(lazyComponentsSource).toContain('LazySandboxWorkbenchPage');
    expect(lazyComponentsSource).toContain("./features/sandbox/pages/SandboxWorkbenchPage");

    expect(appSource).toContain('LazySandboxWorkbenchPage');
    expect(appSource).toContain("renderViewLayer('sandbox-workbench'");
  });

  it('ships a temporary sandbox workbench page shell', () => {
    expect(existsSync(sandboxWorkbenchPagePath)).toBe(true);

    const sandboxWorkbenchPageSource = readSource('src/features/sandbox/pages/SandboxWorkbenchPage.tsx');
    expect(sandboxWorkbenchPageSource).toContain('SandboxWorkbenchPage');
    expect(sandboxWorkbenchPageSource).toContain('SandboxWorkbenchSurface');
  });

  it('launches sandbox workbench without routing away from chat', () => {
    expect(launchSource).not.toContain('NAVIGATE_TO_VIEW');
  });

  it('mounts the sandbox surface directly inside ChatV2Page', () => {
    expect(chatPageSource).toContain('SandboxWorkbenchSurface');
    expect(chatPageSource).toContain('useSandboxWorkbenchStore');
  });
});
