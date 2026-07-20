import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('main entry HMR contract', () => {
  const mainSource = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf-8');
  const appCssSource = readFileSync(resolve(process.cwd(), 'src/shared/styles/app.css'), 'utf-8');
  const scrollGuardSource = readFileSync(
    resolve(process.cwd(), 'src/hooks/useShellScrollGuard.ts'),
    'utf-8',
  );

  it('uses the WebView-level React root singleton', () => {
    expect(mainSource).toContain("import { getOrCreateReactRoot } from './reactRoot';");
    expect(mainSource).toContain('const root = getOrCreateReactRoot(rootContainer);');
    expect(mainSource).not.toContain('ReactDOM.createRoot(');
  });

  it('keeps React component declarations out of the side-effectful entry module', () => {
    expect(mainSource).toContain(
      "import { TopLevelFallback } from './components/TopLevelFallback';",
    );
    expect(mainSource).not.toMatch(/const\s+TopLevelFallback\s*:/);
  });

  it('makes the root unscrollable and guards structural shell scroll', () => {
    expect(appCssSource).toMatch(/#root\s*\{[\s\S]*?overflow:\s*clip;/);
    expect(scrollGuardSource).toContain("'#root'");
    expect(scrollGuardSource).toContain("'[data-shell-layer=\"workspace\"]'");
  });
});
