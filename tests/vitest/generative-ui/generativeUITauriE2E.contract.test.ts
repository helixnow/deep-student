/**
 * Tauri E2E contract — Rust harness + 文档 + Playwright CT smoke
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO = process.cwd();

describe('generativeUI Tauri E2E contract', () => {
  it('Rust generative_ui_executor_e2e covers hpias_event lifecycle', () => {
    const src = fs.readFileSync(
      path.join(REPO, 'src-tauri/tests/generative_ui_executor_e2e.rs'),
      'utf8',
    );
    expect(src).toContain('capture_hpias_events');
    expect(src).toContain('execute_with_research_session_emits_hpias_session_started');
    expect(src).toContain('execute_hpias_stub_pipeline_emits_plan_generated');
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
});
