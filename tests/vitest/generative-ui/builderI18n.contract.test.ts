import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Contract: 所有 build*Intent builder 必须支持 labels 注入（i18n 模式）
 */
describe('generativeUI builder i18n contract', () => {
  const utilsDir = path.join(process.cwd(), 'src/features/generative-ui/utils');
  const builderFiles = fs
    .readdirSync(utilsDir)
    .filter((f) => f.startsWith('build') && f.endsWith('Intent.ts'));

  it('every build*Intent file exports labels interface or labels param', () => {
    for (const file of builderFiles) {
      const src = fs.readFileSync(path.join(utilsDir, file), 'utf8');
      expect(src, `${file} should accept labels`).toMatch(/labels/);
      expect(src, `${file} should export builder function`).toMatch(/export function build/);
    }
  });

  it('research builders use dedicated labels types', () => {
    const paperSrc = fs.readFileSync(path.join(utilsDir, 'buildPaperDigestIntent.ts'), 'utf8');
    const planSrc = fs.readFileSync(path.join(utilsDir, 'buildResearchPlanIntent.ts'), 'utf8');
    expect(paperSrc).toContain('PaperDigestLabels');
    expect(planSrc).toContain('ResearchPlanLabels');
  });
});
