import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (relPath: string) => readFileSync(resolve(process.cwd(), relPath), 'utf-8');

// Wave2-C R4：移动端内联面板 aria-label 国际化契约。
// 内联面板的 ariaLabel 是屏幕阅读器读出的 region 名称，
// 不允许再出现英文字面量 'MCP' / 'Skills' 硬编码。
describe('InputBarUI inline panel aria-label i18n contract', () => {
  const inputBarSource = readSource('src/features/chat/components/input-bar/InputBarUI.tsx');

  it('no longer hardcodes MCP / Skills literals as inline panel aria labels', () => {
    expect(inputBarSource).not.toMatch(/inlineAriaLabel\s*=\s*['"]MCP['"]/);
    expect(inputBarSource).not.toMatch(/inlineAriaLabel\s*=\s*['"]Skills['"]/);
    // 全文件兜底：任何字符串字面量形式的 'MCP' / 'Skills' 都不应存在
    expect(inputBarSource).not.toMatch(/['"](?:MCP|Skills)['"]/);
  });

  it('resolves inline panel aria labels through existing locale keys', () => {
    expect(inputBarSource).toContain("inlineAriaLabel = t('analysis:input_bar.mcp.title')");
    expect(inputBarSource).toContain("inlineAriaLabel = t('skills:title')");
  });

  it('keeps the referenced locale keys available in both languages', () => {
    const zhAnalysis = JSON.parse(readSource('src/locales/zh-CN/analysis.json'));
    const enAnalysis = JSON.parse(readSource('src/locales/en-US/analysis.json'));
    const zhSkills = JSON.parse(readSource('src/locales/zh-CN/skills.json'));
    const enSkills = JSON.parse(readSource('src/locales/en-US/skills.json'));

    expect(zhAnalysis.input_bar.mcp.title).toBeTruthy();
    expect(enAnalysis.input_bar.mcp.title).toBeTruthy();
    expect(zhSkills.title).toBeTruthy();
    expect(enSkills.title).toBeTruthy();
  });
});
