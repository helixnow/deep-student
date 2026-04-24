import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function readSource(relativePath: string) {
  const absolutePath = path.join(repoRoot, relativePath);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : '';
}

const migratedFiles = [
  'src/components/ui/buttonPrimitiveContract.ts',
  'src/components/ui/NotionButton.tsx',
  'src/components/ui/shad/Button.tsx',
  'src/components/ui/shad/Button.css',
  'src/components/ui/shad/Input.tsx',
  'src/components/ui/shad/Switch.tsx',
  'src/components/layout/MobileHeader.tsx',
  'src/components/layout/UnifiedMobileHeader.tsx',
  'src/components/layout/MobileSidebarNavigation.tsx',
  'src/components/ui/unified-sidebar/MobileSidebarLayout.tsx',
  'src/components/ui/unified-sidebar/SidebarDrawer.tsx',
  'src/components/ui/unified-sidebar/UnifiedSidebar.tsx',
] as const;

const iconGovernedFiles = [
  'src/components/layout/MobileHeader.tsx',
  'src/components/layout/UnifiedMobileHeader.tsx',
  'src/components/layout/MobileSidebarNavigation.tsx',
  'src/components/ui/unified-sidebar/MobileSidebarLayout.tsx',
  'src/components/ui/unified-sidebar/SidebarDrawer.tsx',
  'src/components/ui/unified-sidebar/UnifiedSidebar.tsx',
] as const;

describe('Phase 7 DeepStudent migration foundation source guards', () => {
  it('bridges study-ui button and density tokens into parent token files', () => {
    const bridgeSource = [
      readSource('src/styles/shadcn-variables.css'),
      readSource('src/styles/theme-colors.css'),
    ].join('\n');

    [
      '--control-height-touch: 44px;',
      '--touch-target-size: var(--control-height-touch);',
      '--button-height:',
      '--button-height-sm:',
      '--button-height-lg:',
      '--button-padding-x:',
      '--button-padding-x-sm:',
      '--button-padding-x-lg:',
      '--button-tonal-bg:',
      '--button-tonal-hover-bg:',
      '--button-tonal-active-bg:',
      '--button-tonal-border:',
      '--button-outline-bg:',
      '--button-outline-hover-bg:',
      '--button-outline-active-bg:',
      '--button-outline-border:',
      '--button-destructive-bg:',
      '--button-destructive-hover-bg:',
      '--button-destructive-active-bg:',
      '--button-destructive-border:',
    ].forEach((token) => {
      expect(bridgeSource).toContain(token);
    });
  });

  it('makes NotionButton and shad Button consume one shared primitive contract', () => {
    const contract = readSource('src/components/ui/buttonPrimitiveContract.ts');
    const notionButton = readSource('src/components/ui/NotionButton.tsx');
    const shadButton = readSource('src/components/ui/shad/Button.tsx');

    expect(contract).toContain('export const buttonBaseClassName');
    expect(contract).toContain('export const buttonToneClassNames');
    expect(contract).toContain('export const buttonSizeClassNames');
    expect(contract).toContain('export const shellIconButtonClassName');
    expect(contract).toContain('h-[var(--touch-target-size)]');
    expect(contract).toContain('lg:h-[var(--button-icon-size)]');

    expect(notionButton).toContain('@/components/ui/buttonPrimitiveContract');
    expect(shadButton).toContain('@/components/ui/buttonPrimitiveContract');
  });

  it('keeps migrated primitives touch-sized through tablet and compacts only at lg', () => {
    const contract = readSource('src/components/ui/buttonPrimitiveContract.ts');
    const notionButton = readSource('src/components/ui/NotionButton.tsx');
    const shadButton = readSource('src/components/ui/shad/Button.tsx');
    const input = readSource('src/components/ui/shad/Input.tsx');
    const switchSource = readSource('src/components/ui/shad/Switch.tsx');
    const buttonCss = readSource('src/components/ui/shad/Button.css');

    expect(contract).toMatch(/default:\s*['"][^'"]*h-\[var\(--touch-target-size\)\][^'"]*lg:h-\[var\(--button-height\)\]/);
    expect(contract).toMatch(/sm:\s*['"][^'"]*h-\[var\(--touch-target-size\)\][^'"]*lg:h-\[var\(--button-height-sm\)\]/);
    expect(contract).toMatch(/icon:\s*['"][^'"]*h-\[var\(--touch-target-size\)\][^'"]*w-\[var\(--touch-target-size\)\]/);
    expect(input).toContain('min-h-[var(--touch-target-size)]');
    expect(input).toContain('lg:min-h-[var(--button-height)]');
    expect(switchSource).toContain('min-h-[var(--touch-target-size)]');
    expect(switchSource).toContain('min-w-[var(--touch-target-size)]');
    expect(buttonCss).toContain('min-height: var(--touch-target-size)');

    [notionButton, shadButton].forEach((source) => {
      expect(source).not.toMatch(/\bmd:(?:min-)?h-/);
      expect(source).not.toMatch(/\bmd:(?:min-)?w-/);
      expect(source).not.toContain('minHeight: 36');
      expect(source).not.toContain('h-8 w-8');
      expect(source).not.toContain('h-9 w-9');
    });
  });

  it('tokenizes targeted mobile shell controls and blocks local palette/motion regressions', () => {
    const forbiddenPatterns = [
      /\bmd:(?:min-)?h-/,
      /\bmd:(?:min-)?w-/,
      /minHeight:\s*36/,
      /minWidth:\s*36/,
      /h-9 w-9/,
      /!w-8 !h-8/,
      /!w-9 !h-9/,
      /bg-card\/85/,
      /shadow-black\//,
      /shadow-\[/,
      /bg-gradient-/,
      /rgba?\(/,
      /#[0-9a-fA-F]{3,8}\b/,
      /active:scale/,
      /ease-spring/,
      /\bspring\b/i,
    ];

    migratedFiles.forEach((file) => {
      const source = readSource(file);
      forbiddenPatterns.forEach((pattern) => {
        expect(source, `${file} should not match ${pattern}`).not.toMatch(pattern);
      });
    });

    [
      'src/components/layout/MobileHeader.tsx',
      'src/components/layout/UnifiedMobileHeader.tsx',
      'src/components/ui/unified-sidebar/MobileSidebarLayout.tsx',
      'src/components/ui/unified-sidebar/SidebarDrawer.tsx',
      'src/components/ui/unified-sidebar/UnifiedSidebar.tsx',
    ].forEach((file) => {
      const source = readSource(file);
      expect(source, `${file} should use shared shell icon button sizing`).toContain('shellIconButtonClassName');
    });
  });

  it('keeps migrated shell files on Phosphor icons instead of new Lucide imports', () => {
    iconGovernedFiles.forEach((file) => {
      const source = readSource(file);
      expect(source, `${file} should not import lucide-react`).not.toContain("from 'lucide-react'");
      expect(source, `${file} should not import lucide-react`).not.toContain('from "lucide-react"');
      expect(source, `${file} should import Phosphor icons`).toContain('@phosphor-icons/react');
    });
  });
});
