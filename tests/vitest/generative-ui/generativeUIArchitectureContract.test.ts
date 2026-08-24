import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Contract: generative-ui 模块必须导出核心 API，且内置块与设计系统对齐
 */
describe('generativeUIArchitectureContract', () => {
  const root = path.join(process.cwd(), 'src/features/generative-ui');

  it('exports index with registry and renderer', () => {
    const indexSrc = fs.readFileSync(path.join(root, 'index.ts'), 'utf8');
    expect(indexSrc).toContain('generativeUIRegistry');
    expect(indexSrc).toContain('GenerativeUIRenderer');
    expect(indexSrc).toContain('parseGenerativeUIIntent');
    expect(indexSrc).toContain('resolveGenerativeUIChatActionHandlers');
    expect(indexSrc).toContain('dispatchCanvasAIEditRequest');
    expect(indexSrc).toContain('createFlashcardSaveActionHandlers');
  });

  it('bridge layer connects chat stream and action handlers', () => {
    expect(fs.existsSync(path.join(root, 'bridge/chatBlockBridge.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'bridge/generativeUIStreamRegistry.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'bridge/resolveGenerativeUIChatActionHandlers.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'bridge/hpiasEventBridge.ts'))).toBe(true);
  });

  it('module integration contract test file guards full wiring', () => {
    expect(
      fs.existsSync(
        path.join(process.cwd(), 'tests/vitest/generative-ui/generativeUIModuleIntegration.contract.test.ts'),
      ),
    ).toBe(true);
  });

  it('uses zod in schema.ts', () => {
    const schemaSrc = fs.readFileSync(path.join(root, 'schema.ts'), 'utf8');
    expect(schemaSrc).toContain("from 'zod'");
    expect(schemaSrc).toContain('generativeUIIntentSchema');
  });

  it('blocks only import from shad design system', () => {
    const componentsDir = path.join(root, 'components');
    const files = fs.readdirSync(componentsDir).filter((f) => f.endsWith('.tsx'));
    for (const file of files) {
      const src = fs.readFileSync(path.join(componentsDir, file), 'utf8');
      expect(src).not.toMatch(/dangerouslySetInnerHTML/);
      expect(src).not.toMatch(/eval\s*\(/);
    }
  });

  it('documents architecture in docs/generative-ui', () => {
    expect(fs.existsSync(path.join(process.cwd(), 'docs/generative-ui/ARCHITECTURE.md'))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), 'docs/generative-ui/PROGRESS.md'))).toBe(true);
  });
});
