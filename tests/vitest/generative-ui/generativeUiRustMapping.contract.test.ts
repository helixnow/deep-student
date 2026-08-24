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

  it('Rust executor accepts intent version 1 and 1.1, rejects unknown', () => {
    expect(executorSrc).toContain('fn validate_intent_version');
    expect(executorSrc).toContain('"1.1"');
    expect(executorSrc).toContain('layout');
    expect(executorSrc).toContain('fn known_layout_mode');
    expect(executorSrc).toContain('parse_intent_accepts_version_1_1');
    expect(executorSrc).toContain('parse_intent_defaults_missing_version_as_v1');
    expect(executorSrc).toContain('parse_intent_ignores_unknown_layout');
    expect(executorSrc).toContain('parse_intent_rejects_unknown_version');
    expect(executorSrc).toContain('validate_intent_version_rejects_version_2');
    expect(executorSrc).toContain('execute_v1_1_grid_layout_returns_rendered');
    expect(executorSrc).toContain('"version": "1"');
    expect(executorSrc).toContain('"mode": "grid"');
    expect(executorSrc).toContain('"span": 2');
  });

  it('Rust e2e covers v1.1 grid emit and version 2 reject', () => {
    const e2eSrc = fs.readFileSync(
      path.join(process.cwd(), 'src-tauri/tests/generative_ui_executor_e2e.rs'),
      'utf8',
    );
    expect(e2eSrc).toContain('execute_v1_1_grid_layout_emits_generative_ui');
    expect(e2eSrc).toContain('"version": "1.1"');
    expect(e2eSrc).toContain('"mode": "grid"');
    expect(e2eSrc).toContain('execute_rejects_version_2');
    expect(e2eSrc).toContain('event_types::GENERATIVE_UI');
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
    expect(executorSrc).toContain('noteEdit.isRegex 不被支持');
    expect(executorSrc).toContain('parse_note_edit_rejects_regex_flag');
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

  it('hpias orchestrator spawns pipeline from generative_ui executor', () => {
    expect(executorSrc).toContain('create_research_backend');
    expect(executorSrc).toContain('HpiasResearchSessionRequest');
    const orchestratorSrc = fs.readFileSync(
      path.join(process.cwd(), 'src-tauri/src/hpias/orchestrator.rs'),
      'utf8',
    );
    expect(orchestratorSrc).toContain('build_pipeline_timeline');
    expect(orchestratorSrc).toContain('intent_has_research_blocks');
  });

  it('hpias research service exposes replaceable backend', () => {
    const serviceSrc = fs.readFileSync(
      path.join(process.cwd(), 'src-tauri/src/hpias/service.rs'),
      'utf8',
    );
    expect(serviceSrc).toContain('trait HpiasResearchBackend');
    expect(serviceSrc).toContain('StubHpiasResearchService');
    expect(serviceSrc).toContain('HpiasBackendKind::Retrieval');
    expect(serviceSrc).toContain('Box<dyn HpiasResearchBackend>');
  });

  it('hpias retrieval backend uses VfsUnifiedRetriever', () => {
    const retrievalSrc = fs.readFileSync(
      path.join(process.cwd(), 'src-tauri/src/hpias/retrieval_backend.rs'),
      'utf8',
    );
    expect(retrievalSrc).toContain('VfsUnifiedRetriever');
    expect(retrievalSrc).toContain('generate_synthesis_with_llm');
  });

  it('hpias synthesis module uses LLM with markdown fallback', () => {
    const synthesisSrc = fs.readFileSync(
      path.join(process.cwd(), 'src-tauri/src/hpias/synthesis.rs'),
      'utf8',
    );
    expect(synthesisSrc).toContain('generate_synthesis_with_llm');
    expect(synthesisSrc).toContain('call_with_config_id_raw_prompt');
    expect(synthesisSrc).toContain('build_synthesis_markdown');
  });

  it('hpias payloads align with frontend lifecycle events', () => {
    const payloadsSrc = fs.readFileSync(
      path.join(process.cwd(), 'src-tauri/src/hpias/payloads.rs'),
      'utf8',
    );
    for (const eventType of [
      'session_started',
      'plan_generated',
      'retrieval_completed',
      'selection_completed',
      'subagent_started',
      'subagent_completed',
      'synthesis_updated',
      'subagents_done',
      'session_completed',
    ]) {
      expect(payloadsSrc).toContain(eventType);
    }
  });

  it('Rust executor requires MAX_GENERATIVE_UI_BLOCKS of 32', () => {
    expect(executorSrc).toContain('MAX_GENERATIVE_UI_BLOCKS');
    expect(executorSrc).toContain('32');
  });

  it('documents that TS allows empty blocks while Rust ingress rejects them', () => {
    const schemaSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/features/generative-ui/schema.ts'),
      'utf8',
    );
    expect(schemaSrc).toContain('.min(0).max(MAX_GENERATIVE_UI_BLOCKS)');
    expect(executorSrc).toContain('if blocks.is_empty()');
    expect(executorSrc).toContain('parse_intent_rejects_empty_blocks');
  });
});
