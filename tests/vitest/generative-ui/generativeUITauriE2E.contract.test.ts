/**
 * Tauri E2E contract — Rust harness + 文档 + Playwright CT smoke + 18 块
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
import { ALL_BLOCK_TYPES } from '@/features/generative-ui/demo/allBlocksFixture';

import '@/features/generative-ui/blocks';

const REPO = process.cwd();

const EXPECTED_EIGHTEEN_BLOCK_TYPES = [
  'stat-card',
  'alert',
  'list',
  'progress',
  'action-bar',
  'text',
  'key-value-grid',
  'flashcard-preview',
  'review-calendar',
  'mistake-analysis',
  'mindmap-embed',
  'paper-digest',
  'research-plan',
  'research-report',
  'markdown',
  'chart',
  'steps',
  'table',
] as const;

describe('generativeUI Tauri E2E contract', () => {
  it('Rust generative_ui_executor_e2e covers hpias_event lifecycle', () => {
    const src = fs.readFileSync(
      path.join(REPO, 'src-tauri/tests/generative_ui_executor_e2e.rs'),
      'utf8',
    );
    expect(src).toContain('capture_hpias_events');
    expect(src).toContain('execute_with_research_session_emits_hpias_session_started');
    expect(src).toContain('execute_hpias_stub_pipeline_emits_plan_generated');
    expect(src).toContain('execute_rejects_unknown_block_type');
    expect(src).toContain('HPIAS_EVENT_CHANNEL');
  });

  it('TAURI_E2E documentation exists', () => {
    expect(fs.existsSync(path.join(REPO, 'docs/generative-ui/TAURI_E2E.md'))).toBe(true);
  });

  it('Playwright CT generative-ui smoke spec exists', () => {
    expect(
      fs.existsSync(path.join(REPO, 'tests/ct/generative-ui/hpiasResearchPanel.spec.tsx')),
    ).toBe(true);
  });

  it('asserts 18 block types including markdown/chart/steps/table', () => {
    expect(EXPECTED_EIGHTEEN_BLOCK_TYPES).toHaveLength(18);
    expect(ALL_BLOCK_TYPES).toHaveLength(18);
    const registered = new Set(generativeUIRegistry.keys());
    for (const type of EXPECTED_EIGHTEEN_BLOCK_TYPES) {
      expect(ALL_BLOCK_TYPES, `fixture missing ${type}`).toContain(type);
      expect(registered.has(type), `registry missing ${type}`).toBe(true);
    }
    for (const type of ['markdown', 'chart', 'steps', 'table'] as const) {
      expect(ALL_BLOCK_TYPES).toContain(type);
      expect(registered.has(type)).toBe(true);
    }
  });

  it('TAURI_E2E documents 18 blocks and v1.1 layout optional check', () => {
    const doc = fs.readFileSync(path.join(REPO, 'docs/generative-ui/TAURI_E2E.md'), 'utf8');
    expect(doc).toContain('18 块');
    expect(doc).toContain('markdown');
    expect(doc).toContain('chart');
    expect(doc).toContain('steps');
    expect(doc).toContain('table');
    expect(doc).toContain('v1.1');
    expect(doc).toContain('data-layout-mode');
    expect(doc).toContain('data-layout-columns');
  });

  it('Playwright CT smoke covers 18 types and v1.1 layout', () => {
    const spec = fs.readFileSync(
      path.join(REPO, 'tests/ct/generative-ui/hpiasResearchPanel.spec.tsx'),
      'utf8',
    );
    expect(spec).toContain('18');
    expect(spec).toContain('markdown');
    expect(spec).toContain('chart');
    expect(spec).toContain('steps');
    expect(spec).toContain('table');
    expect(spec).toContain('data-generative-markdown');
    expect(spec).toContain('data-generative-chart');
    expect(spec).toContain('data-generative-steps');
    expect(spec).toContain('data-generative-table');
    expect(spec).toContain('data-layout-mode');
    expect(spec).toContain("version: '1.1'");
  });
});
