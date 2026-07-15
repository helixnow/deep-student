import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('workbench Windows chrome layout contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const appCssSource = readFileSync(resolve(process.cwd(), 'src/shared/styles/app.css'), 'utf-8');
  const statusBarCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/workbench/components/StatusBar.css'),
    'utf-8',
  );
  const tokensSource = readFileSync(
    resolve(process.cwd(), 'src/features/workbench/styles/workbench.tokens.css'),
    'utf-8',
  );

  it('shares one Windows chrome width between the window controls and shortcut bar', () => {
    expect(tokensSource).toContain('--wb-windows-chrome-width: 165px;');
    expect(tokensSource).toContain('--wb-menubar-chrome-inset: var(--wb-windows-chrome-width);');
    expect(appSource).toContain('className="desktop-shell-workbench-chrome-host');
    expect(appCssSource).toMatch(
      /\.desktop-shell-workbench-chrome-host\s*\{[\s\S]*?flex:\s*0 0 var\(--wb-windows-chrome-width, 165px\);/,
    );
    expect(statusBarCssSource).toMatch(
      /\.wb-menubar\[data-chrome-inset='windows'\]\s*\{[\s\S]*?right:\s*var\(--wb-menubar-chrome-inset, 165px\);/,
    );
  });

  it('keeps the trailing shortcuts from shrinking back underneath Windows controls', () => {
    expect(statusBarCssSource).toMatch(
      /\.wb-menubar\[data-chrome-inset='windows'\] \.wb-menubar-trailing\s*\{[\s\S]*?flex-shrink:\s*0;/,
    );
  });

  it('keeps the macOS integrated chrome rule independent from the Windows inset', () => {
    const macRule = statusBarCssSource.slice(
      statusBarCssSource.indexOf(".wb-menubar[data-macos-chrome='integrated']"),
      statusBarCssSource.indexOf('.wb-menubar-drag-region'),
    );

    expect(macRule).toContain('padding-left: var(--wb-macos-traffic-lights-inset, 76px);');
    expect(macRule).not.toContain('--wb-menubar-chrome-inset');
  });
});
