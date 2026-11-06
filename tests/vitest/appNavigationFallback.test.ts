import { describe, expect, it } from 'vitest';
import { readAppShellSource } from '@/app/__tests__/appShellSources';

describe('App navigation fallback contract', () => {
  const appSource = readAppShellSource();

  it('does not route back to deprecated analysis view', () => {
    expect(appSource.includes("onBack={() => setCurrentView('analysis')}")).toBe(false);
    expect(appSource.includes("setCurrentView('analysis');")).toBe(false);
  });

  it('keeps the canonical notes tab while removing legacy analysis and notes-to-library mappings', () => {
    expect(appSource.includes("'analysis': 'chat-v2'")).toBe(false);
    expect(appSource.includes("'notes': 'learning-hub'")).toBe(false);
    expect(appSource.includes("'notes': 'notes'")).toBe(true);
  });
});
