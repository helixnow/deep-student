import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('generativeUI Rust dual-mapping contract', () => {
  const contextSrc = fs.readFileSync(
    path.join(process.cwd(), 'src-tauri/src/chat_v2/context.rs'),
    'utf8',
  );
  const pipelineSrc = fs.readFileSync(
    path.join(process.cwd(), 'src-tauri/src/chat_v2/pipeline.rs'),
    'utf8',
  );
  const executorSrc = fs.readFileSync(
    path.join(process.cwd(), 'src-tauri/src/chat_v2/tools/generative_ui_executor.rs'),
    'utf8',
  );

  it('context and pipeline map render_generative_ui to generative_ui block type', () => {
    expect(contextSrc).toContain('"render_generative_ui" => block_types::GENERATIVE_UI');
    expect(pipelineSrc).toContain('"render_generative_ui" => block_types::GENERATIVE_UI');
  });

  it('Rust executor tool name matches frontend skill builtin tool', () => {
    expect(executorSrc).toContain('const TOOL_NAME: &str = "render_generative_ui"');
  });

  it('event type constant matches frontend GENERATIVE_UI_BLOCK_TYPE', () => {
    const typesSrc = fs.readFileSync(
      path.join(process.cwd(), 'src-tauri/src/chat_v2/types.rs'),
      'utf8',
    );
    expect(typesSrc).toContain('pub const GENERATIVE_UI: &str = "generative_ui"');
  });

  it('Rust executor validates and preserves noteEdit alongside intent', () => {
    expect(executorSrc).toContain('fn parse_note_edit');
    expect(executorSrc).toContain('fn intent_has_apply_note_edit');
    expect(executorSrc).toContain('noteEdit.operation');
  });

  it('Rust executor parses and emits researchSessionId for HPIAS Chat bridge', () => {
    expect(executorSrc).toContain('fn parse_research_session_id');
    expect(executorSrc).toContain('researchSessionId');
    expect(executorSrc).toContain('execute_preserves_research_session_id_in_output');
    expect(executorSrc).toContain('emit_hpias_session_started_if_needed');
  });

  it('hpias Rust module emits on hpias_event channel', () => {
    const hpiasSrc = fs.readFileSync(
      path.join(process.cwd(), 'src-tauri/src/hpias/events.rs'),
      'utf8',
    );
    expect(hpiasSrc).toContain('HPIAS_EVENT_CHANNEL');
    expect(hpiasSrc).toContain('"hpias_event"');
    expect(hpiasSrc).toContain('emit_session_started');
  });
});
