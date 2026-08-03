import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 契约意图：ChatV2 必须整体包裹在 StreamPreferencesProvider 中，
 * 且流式平滑预设默认为 balanced。
 * 2026-07 改造后 preset 由 prop 传入（streamPreset），默认值仍为 'balanced'。
 */
describe('chat streaming preference contract', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/features/chat/pages/ChatV2Page.tsx'), 'utf-8');

  it('wraps chat v2 with stream preferences defaulting to balanced', () => {
    expect(source).toContain("streamPreset = 'balanced',");
    expect(source).toContain('<StreamPreferencesProvider preset={streamPreset} mode="blocked"');
    expect(source).toContain('</StreamPreferencesProvider>');
  });
});
