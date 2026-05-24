import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('OverlayCoordinator provider contract', () => {
  const mainSource = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf-8');

  it('wraps the application with OverlayCoordinatorProvider at the top level', () => {
    expect(mainSource).toContain("import { OverlayCoordinatorProvider } from './components/shared/OverlayCoordinator';");
    expect(mainSource).toMatch(/<OverlayCoordinatorProvider>[\s\S]*<DialogControlProvider>[\s\S]*<App \/>[\s\S]*<\/DialogControlProvider>[\s\S]*<\/OverlayCoordinatorProvider>/);
  });
});
