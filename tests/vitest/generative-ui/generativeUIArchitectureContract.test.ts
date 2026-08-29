import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Contract: generative-ui 模块必须导出核心 API，且内置块与设计系统对齐
 *
 * Round 40/41 真实态：18 块 + Intent v1.1 layout helpers + telemetry/undo + fallback。
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
    expect(indexSrc).not.toContain('createFlashcardSaveActionHandlers');
    expect(indexSrc).toContain('ChartBlock');
    expect(indexSrc).toContain('MarkdownBlock');
    expect(indexSrc).toContain('StepsBlock');
    expect(indexSrc).toContain('TableBlock');
    expect(indexSrc).toContain('coercePartialIntent');
    expect(indexSrc).toContain('GenerativeActionUndoStack');
    expect(indexSrc).toContain('wrapActionWithTelemetry');
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

  it('uses zod in schema.ts and exports v1.1 layout helpers', () => {
    const schemaSrc = fs.readFileSync(path.join(root, 'schema.ts'), 'utf8');
    expect(schemaSrc).toContain("from 'zod'");
    expect(schemaSrc).toContain('generativeUIIntentSchema');
    expect(schemaSrc).toContain("GENERATIVE_UI_INTENT_VERSIONS = ['1', '1.1']");
    expect(schemaSrc).toContain('generativeLayoutSchema');
    expect(schemaSrc).toContain('resolveGenerativeLayout');
    expect(schemaSrc).toContain('layoutGridClassName');
    expect(schemaSrc).toContain('layoutSpanClassName');
    expect(schemaSrc).toContain('clampGenerativeLayoutUnit');
  });

  it('Round 40/41 files exist: new blocks, fallback, telemetry, few-shot', () => {
    const required = [
      'components/ChartBlock.tsx',
      'components/MarkdownBlock.tsx',
      'components/StepsBlock.tsx',
      'components/TableBlock.tsx',
      'utils/coercePartialIntent.ts',
      'handlers/actionUndoStack.ts',
      'handlers/actionTelemetry.ts',
      'prompts/fewShotExamples.ts',
    ];
    for (const rel of required) {
      expect(fs.existsSync(path.join(root, rel)), rel).toBe(true);
    }
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
