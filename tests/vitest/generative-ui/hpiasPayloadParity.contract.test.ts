/**
 * HPIAS payload 契约 — Host hpias-payloads.ts ↔ TS Style Lab demo
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
const readHost = (file: string) => fs.readFileSync(path.join(REPO, 'host/plugins', file), 'utf8');

describe('hpiasPayloadParity contract', () => {
  it('Style Lab demo timeline covers required lifecycle types', () => {
    const types = extractHpiasEventTypes(buildStyleLabHpiasDemoTimeline());
    expect(() => assertHpiasLifecycleCoverage(types)).not.toThrow();
  });

  it('Host hpias-payloads.ts declares all required lifecycle event builders', () => {
    const payloadsSrc = readHost('memory/src/hpias-payloads.ts');
    for (const eventType of HPIAS_REQUIRED_LIFECYCLE_TYPES) {
      expect(payloadsSrc).toContain(`type: '${eventType}'`);
    }
    expect(payloadsSrc).toContain('export function buildPipelineTimeline');
  });

  it('Host research module exposes the replaceable backend kinds', () => {
    const researchSrc = readHost('memory/src/hpias-research.ts');
    expect(researchSrc).toContain("export type HpiasBackendKind = 'disabled' | 'stub' | 'retrieval';");
    expect(researchSrc).toContain('export function backendKindFromConfig');
    expect(researchSrc).toContain('export interface HpiasResearchDeps');
    expect(researchSrc).toContain('export interface HpiasResearchSessionRequest');
  });

  it('generative-ui executor starts research through the research service', () => {
    const executorSrc = readHost('vfs/src/tools/generative-ui.ts');
    expect(executorSrc).toContain('this.research().startFromIntent(');
    expect(readHost('memory/src/hpias-service.ts')).toContain('export function createHpiasResearchService');
  });

  it('retrieval and LLM synthesis modules are wired', () => {
    expect(readHost('memory/src/hpias-retrieval.ts')).toContain('export interface HpiasRetrievalDeps');
    expect(readHost('memory/src/hpias-research.ts')).toContain('export function buildSynthesisLlmPrompt');
  });
});
