import { describe, expect, it } from 'vitest';
import {
  LEGACY_PROVIDER_ID, LegacyExecutorAdapter, LegacyToolProvider, buildLegacyToolRegistry,
  projectLegacyDescriptor, validateLegacyRegistry,
} from '../src/tools/legacy-tool-provider.ts';
import type {
  LegacyExecutorRegistry, LegacyToolDescriptor, LegacyToolExecutor,
} from '../src/tools/legacy-tool-provider.ts';

class FakeExecutor implements LegacyToolExecutor {
  readonly handled: string[];
  constructor(name: string, handled: string[]) {
    this.executorName = name;
    this.handled = handled;
  }
  private readonly executorName: string;
  canHandle(toolName: string): boolean { return this.handled.includes(toolName); }
  name(): string { return this.executorName; }
}

class DynamicExecutor extends FakeExecutor {
  override canHandle(_toolName: string): boolean { return true; }
}

function registry(executors: LegacyToolExecutor[]): LegacyExecutorRegistry {
  return {
    executors: () => executors,
    getExecutor: toolName => {
      const short = toolName.startsWith('builtin-') ? toolName.slice(8) : toolName;
      return executors.find(executor => executor.canHandle(short));
    },
  };
}

const DESCRIPTORS: LegacyToolDescriptor[] = [
  { name: 'general', sensitivity: 'Low', timeoutSecs: null, headlessAllowed: true, ptcAllowed: false },
  { name: 'note_read', sensitivity: 'High', timeoutSecs: 0, headlessAllowed: false, ptcAllowed: true },
  { name: 'chatanki_wait', sensitivity: 'Medium', timeoutSecs: 600, headlessAllowed: false, ptcAllowed: false },
];

describe('legacy_tool_provider.rs', () => {
  it('project_descriptor_maps_names_aliases_sensitivity_timeout_headless_ptc', () => {
    const general = projectLegacyDescriptor(DESCRIPTORS[0]!);
    expect(general.names()).toEqual(['general', 'builtin-general']);
    expect(general.sensitivity).toBe('low');
    expect(general.timeout).toBe(120);
    expect(general.headless).toBe('read_only');
    expect(general.ptc).toBe('denied');
    expect(general.blockType).toBe('mcp_tool');
    expect(general.approval).toEqual({ kind: 'scoped', scopeKind: 'tool', precise: false, neverRemember: false });

    const note = projectLegacyDescriptor(DESCRIPTORS[1]!);
    expect(note.sensitivity).toBe('high');
    expect(note.timeout).toBeNull();
    expect(note.headless).toBe('blocked');
    expect(note.ptc).toBe('read_only');

    expect(projectLegacyDescriptor(DESCRIPTORS[2]!).timeout).toBe(600);
  });

  it('provider_registers_one_catch_all_with_descriptors_and_adapters_in_roster_order', () => {
    const general = new FakeExecutor('GeneralToolExecutor', ['general']);
    const note = new FakeExecutor('NoteToolExecutor', ['note_read']);
    const dynamic = new DynamicExecutor('DynamicExecutor', []);
    const provider = new LegacyToolProvider(registry([note, general, dynamic]), DESCRIPTORS);
    expect(provider.id).toBe(LEGACY_PROVIDER_ID);
    expect(provider.isCatchAll()).toBe(true);
    expect(provider.descriptors().map(descriptor => descriptor.name))
      .toEqual(['general', 'note_read', 'chatanki_wait']);
    expect(provider.executors().map(adapter => adapter.name()))
      .toEqual(['NoteToolExecutor', 'GeneralToolExecutor', 'DynamicExecutor']);

    const noteAdapter = provider.executor('note_read');
    expect(noteAdapter).toBe(provider.executors()[0]);
    expect(provider.executor('general')).toBe(provider.executors()[1]);
    expect(provider.executor('workspace_anything')).toBe(provider.executors()[2]);
    const withoutCatchAll = new LegacyToolProvider(
      registry([note, general]), DESCRIPTORS,
    );
    expect(withoutCatchAll.executor('missing_everywhere')).toBeUndefined();
  });

  it('adapter_metadata_methods_delegate_and_default_like_rust_trait', async () => {
    const general = new FakeExecutor('GeneralToolExecutor', ['general']);
    const adapter = LegacyExecutorAdapter.wrap(general);
    expect(adapter.canHandle('general')).toBe(true);
    expect(adapter.sensitivityLevel('general')).toBe('low');
    expect(adapter.sensitivityLevelForCall('general', {})).toBe('low');
    expect(adapter.hasDynamicSensitivity('general')).toBe(false);
    expect(adapter.concurrencyClass('general')).toBe('serial');
    expect(adapter.managesCancellation('general')).toBe(false);
    expect(adapter.resultCharBudget('general')).toBe(30_000);
    expect(adapter.name()).toBe('GeneralToolExecutor');
    await expect(adapter.execute({ id: 'call-1', name: 'general', arguments: {} }, {}))
      .rejects.toThrow('legacy executor `GeneralToolExecutor` must be dispatched through ToolExecutorRegistry (tool `general`)');
  });

  it('build_tool_registry_resolves_bare_names_and_builtin_aliases', () => {
    const general = new FakeExecutor('GeneralToolExecutor', ['general']);
    const note = new FakeExecutor('NoteToolExecutor', ['note_read']);
    const dynamic = new DynamicExecutor('DynamicExecutor', []);
    const built = buildLegacyToolRegistry(registry([note, general, dynamic]), DESCRIPTORS);
    expect(built.len()).toBe(6);
    expect(built.executorFor('note_read')).toBe(built.executorFor('builtin-note_read'));
    expect(built.descriptor('builtin-note_read')?.sensitivity).toBe('high');
    expect(built.ownerOf('general')).toBe(LEGACY_PROVIDER_ID);
    expect(built.catchAllProvider()?.id).toBe(LEGACY_PROVIDER_ID);
  });

  it('validate_legacy_registry_logs_missing_executor_and_does_not_throw', () => {
    const errors: string[] = [];
    const missing = validateLegacyRegistry(
      registry([new FakeExecutor('GeneralToolExecutor', ['general'])]),
      DESCRIPTORS,
      { error: message => errors.push(message) },
    );
    expect(missing).toContain('declares `note_read` but returns no executor');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('[ChatV2::legacy_tool_provider] agent-api registry validation failed:');

    const debug: string[] = [];
    const ok = validateLegacyRegistry(
      registry([new DynamicExecutor('DynamicExecutor', [])]),
      DESCRIPTORS,
      { debug: message => debug.push(message) },
    );
    expect(ok).toBeUndefined();
    expect(debug).toHaveLength(1);
    expect(debug[0]).toContain('agent-api registry validated: 6 entries');
  });
});
