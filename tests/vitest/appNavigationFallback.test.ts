import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('App navigation fallback contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');

  it('does not route back to deprecated analysis view', () => {
    expect(appSource.includes("onBack={() => setCurrentView('analysis')}")).toBe(false);
    expect(appSource.includes("setCurrentView('analysis');")).toBe(false);
  });

  it('removes legacy analysis/notes tab mappings', () => {
    expect(appSource.includes("'analysis': 'chat-v2'")).toBe(false);
    expect(appSource.includes("'notes': 'learning-hub'")).toBe(false);
  });
});
