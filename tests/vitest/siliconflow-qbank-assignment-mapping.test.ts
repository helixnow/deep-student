import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('SiliconFlow one-click assignment mapping', () => {
  it('includes qbank grading mapping key in preset assignments', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/SiliconFlowSection.tsx'),
      'utf-8'
    );

    expect(source).toContain("assignmentKey: t('settings:mapping_keys.qbank_ai_grading_configured')");
  });
});
