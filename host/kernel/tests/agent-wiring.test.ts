/** `src/agent_wiring/{services,roster}.rs` 中不依赖领域执行器的组装逻辑。 */
import { describe, expect, it } from 'vitest';
import { AgentServices, ServiceKey, ToolDescriptor } from '../agent-api.ts';
import {
  buildPipelineServices,
  missingDescriptorTools,
  verifyRosterCoverage,
  type RosterCoverageLogger,
  type SpecificExecutorRegistry,
} from '../agent-wiring.ts';

function registry(names: readonly string[]): SpecificExecutorRegistry & { len(): number } {
  const specific = new Set(names);
  return { hasSpecificExecutor: name => specific.has(name), len: () => specific.size };
}

const DESCRIPTORS = [new ToolDescriptor('note_read'), new ToolDescriptor('qbank_generate'), new ToolDescriptor('workspace_file_read')];

describe('buildPipelineServices', () => {
  it('inserts the same instances in notes → qbank order', () => {
    const notes = { getNote: () => null };
    const qbank = { list: () => [] };
    const notesKey = new ServiceKey<typeof notes>('NotesManager');
    const qbankKey = new ServiceKey<typeof qbank>('QuestionBankService');
    const services = buildPipelineServices({ key: notesKey, value: notes }, { key: qbankKey, value: qbank });
    expect(services.len()).toBe(2);
    expect(services.get(notesKey)).toBe(notes);
    expect(services.get(qbankKey)).toBe(qbank);
  });

  it('omits absent services exactly like None', () => {
    expect(buildPipelineServices().isEmpty()).toBe(true);
    const notes = { getNote: () => null };
    const notesKey = new ServiceKey<typeof notes>('NotesManager');
    const onlyNotes = buildPipelineServices({ key: notesKey, value: notes });
    expect(onlyNotes.len()).toBe(1);
    expect(onlyNotes.get(notesKey)).toBe(notes);
    expect(onlyNotes.contains(new ServiceKey('QuestionBankService'))).toBe(false);
  });
});

describe('roster coverage', () => {
  it('missing_descriptor_tools keeps descriptor order and skips covered tools', () => {
    expect(missingDescriptorTools(registry(['note_read', 'workspace_file_read']), DESCRIPTORS)).toEqual(['qbank_generate']);
    expect(missingDescriptorTools(registry(['note_read', 'qbank_generate', 'workspace_file_read']), DESCRIPTORS)).toEqual([]);
  });

  it('verify_roster_coverage logs the Rust message and returns the missing list', () => {
    const messages: string[] = [];
    const logger: RosterCoverageLogger = { error: message => messages.push(message) };
    const missing = verifyRosterCoverage(registry(['note_read']), DESCRIPTORS, logger);
    expect(missing).toEqual(['qbank_generate', 'workspace_file_read']);
    expect(messages).toEqual([
      '[agent_wiring] ToolExecutorRegistry has 1 executors but 2 descriptor-backed tools have no specific executor (executor roster not injected?): ["qbank_generate", "workspace_file_read"]',
    ]);
  });

  it('verify_roster_coverage stays silent when every descriptor has a specific executor', () => {
    const messages: string[] = [];
    const logger: RosterCoverageLogger = { error: message => messages.push(message) };
    expect(verifyRosterCoverage(registry(DESCRIPTORS.map(d => d.name)), DESCRIPTORS, logger)).toEqual([]);
    expect(messages).toEqual([]);
  });

  it('shares the Services container contract', () => {
    expect(buildPipelineServices()).toBeInstanceOf(AgentServices);
  });
});
