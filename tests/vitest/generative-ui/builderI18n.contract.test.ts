import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zh from '@/locales/zh-CN/generativeUi.json';
import en from '@/locales/en-US/generativeUi.json';

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

  it('ships markdown/chart/steps/table builders with matching locale block keys', () => {
    expect(builderFiles).toEqual(
      expect.arrayContaining([
        'buildMarkdownIntent.ts',
        'buildChartIntent.ts',
        'buildStepsIntent.ts',
        'buildTableIntent.ts',
      ]),
    );

    for (const locale of [zh, en] as const) {
      expect(locale.blocks.markdown.empty).toBeTruthy();
      expect(locale.blocks.markdown.error).toBeTruthy();
      expect(locale.blocks.chart.empty).toBeTruthy();
      expect(locale.blocks.chart.a11y_label).toBeTruthy();
      expect(locale.blocks.steps.status_pending).toBeTruthy();
      expect(locale.blocks.steps.status_active).toBeTruthy();
      expect(locale.blocks.steps.status_done).toBeTruthy();
      expect(locale.blocks.steps.status_error).toBeTruthy();
      expect(locale.blocks.steps.status_skipped).toBeTruthy();
      expect(locale.blocks.table.empty).toBeTruthy();
      expect(locale.a11y.markdown_label).toBeTruthy();
      expect(locale.a11y.chart_label).toBeTruthy();
      expect(locale.a11y.steps_label).toBeTruthy();
      expect(locale.a11y.table_label).toBeTruthy();
    }
  });
});
