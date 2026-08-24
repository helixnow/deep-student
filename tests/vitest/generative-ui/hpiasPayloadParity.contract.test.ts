/**
 * HPIAS payload 跨语言契约 — Rust payloads.rs ↔ TS Style Lab demo
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildStyleLabHpiasDemoTimeline } from '@/features/generative-ui/demo/styleLabHpiasDemo';
import {
  HPIAS_REQUIRED_LIFECYCLE_TYPES,
  assertHpiasLifecycleCoverage,
  extractHpiasEventTypes,
} from '@/features/generative-ui/contracts/hpiasLifecycleContract';

const REPO = process.cwd();

describe('hpiasPayloadParity contract', () => {
  it('Style Lab demo timeline covers required lifecycle types', () => {
    const types = extractHpiasEventTypes(buildStyleLabHpiasDemoTimeline());
    expect(() => assertHpiasLifecycleCoverage(types)).not.toThrow();
  });

  it('Rust payloads.rs declares all required lifecycle event builders', () => {
    const payloadsSrc = fs.readFileSync(
      path.join(REPO, 'src-tauri/src/hpias/payloads.rs'),
      'utf8',
    );
    for (const eventType of HPIAS_REQUIRED_LIFECYCLE_TYPES) {
      expect(payloadsSrc).toContain(eventType);
    }
    expect(payloadsSrc).toContain('build_pipeline_timeline');
  });

  it('Rust service.rs exposes replaceable backend trait', () => {
    const serviceSrc = fs.readFileSync(
      path.join(REPO, 'src-tauri/src/hpias/service.rs'),
      'utf8',
    );
    expect(serviceSrc).toContain('trait HpiasResearchBackend');
    expect(serviceSrc).toContain('StubHpiasResearchService');
    expect(serviceSrc).toContain('create_research_backend');
    expect(serviceSrc).toContain('HpiasBackendKind');
    expect(serviceSrc).toContain('DEEP_STUDENT_HPIAS_BACKEND');
  });

  it('generative_ui executor uses HpiasResearchService not direct orchestrator', () => {
    const executorSrc = fs.readFileSync(
      path.join(REPO, 'src-tauri/src/chat_v2/tools/generative_ui_executor.rs'),
      'utf8',
    );
    expect(executorSrc).toContain('create_research_backend');
    expect(executorSrc).toContain('HpiasResearchSessionRequest');
    expect(executorSrc).toContain('HpiasResearchDeps');
    expect(executorSrc).not.toContain('HpiasPipelineOrchestrator::spawn_from_intent');
  });

  it('retrieval backend module exists with VFS wiring', () => {
    const retrievalSrc = fs.readFileSync(
      path.join(REPO, 'src-tauri/src/hpias/retrieval_backend.rs'),
      'utf8',
    );
    expect(retrievalSrc).toContain('RetrievalHpiasResearchService');
    expect(retrievalSrc).toContain('generate_synthesis_with_llm');
  });

  it('synthesis module wires LLM markdown generation', () => {
    const synthesisSrc = fs.readFileSync(
      path.join(REPO, 'src-tauri/src/hpias/synthesis.rs'),
      'utf8',
    );
    expect(synthesisSrc).toContain('build_synthesis_llm_prompt');
    expect(synthesisSrc).toContain('generate_synthesis_with_llm');
  });
});
